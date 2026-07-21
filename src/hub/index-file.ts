import type { HubBackend } from "./backend.js";
import { indexPath, indexDirPath, assertSafeHubId, type HubBundleRecord, type HubIndexJson, type HubThreadEntry } from "./layout.js";
import { getThreadId } from "../sync-state.js";
import { isSafeSessionId } from "../manifest.js";
import type { SyncState } from "../types.js";

export interface IndexBuildInputs {
  projectId: string;
  machineId: string;
  projectPath: string;
  sessions: Array<{
    sessionId: string; slug: string; summary: string;
    headEntryUuid: string; messageCount: number; lastActiveAt: string;
  }>;
  state: SyncState;
  priorIndex: HubIndexJson | null;
  newBundles: Array<{ threadId: string; record: HubBundleRecord }>;
  now: string;
}

// Pure projection: local sessions (with thread mappings) + prior bundle
// history + this push's new bundle records. Sessions never pushed (no thread
// mapping) are omitted — the hub only knows what was shared with it.
export function buildIndexFile(inputs: IndexBuildInputs): HubIndexJson {
  const threads: Record<string, HubThreadEntry> = {};

  for (const s of inputs.sessions) {
    const threadId = getThreadId(inputs.state, s.sessionId);
    if (!threadId) continue;
    // Multiple local session files can map to the same thread — a
    // continuation pull mints a brand-new local file thread-mapped onto a
    // thread an earlier (now older) local file already represented (see
    // hub/pull.ts's setThreadId call). Keep whichever is genuinely more
    // recent; never just "whichever appears last in inputs.sessions" —
    // discoverSessions happens to return most-recent-first, so blindly
    // overwriting would silently keep the OLDEST one and report a stale head
    // for a thread this machine just updated.
    const existing = threads[threadId];
    if (existing && new Date(existing.lastActiveAt).getTime() >= new Date(s.lastActiveAt).getTime()) {
      continue;
    }
    threads[threadId] = {
      localSessionId: s.sessionId,
      slug: s.slug,
      summary: s.summary,
      headEntryUuid: s.headEntryUuid,
      messageCount: s.messageCount,
      lastActiveAt: s.lastActiveAt,
      bundles: inputs.priorIndex?.threads[threadId]?.bundles.slice() ?? [],
    };
  }
  // Threads whose local session vanished (deleted locally) keep their bundle
  // history from the prior index — the hub copy is still pullable elsewhere.
  if (inputs.priorIndex) {
    for (const [threadId, entry] of Object.entries(inputs.priorIndex.threads)) {
      if (!threads[threadId]) threads[threadId] = { ...entry, bundles: entry.bundles.slice() };
    }
  }
  for (const nb of inputs.newBundles) {
    if (!threads[nb.threadId]) continue; // defensive: record must belong to a known thread
    threads[nb.threadId].bundles.push(nb.record);
  }

  return {
    schemaVersion: 1,
    agent: "claude-code",
    projectId: inputs.projectId,
    machineId: inputs.machineId,
    updatedAt: inputs.now,
    projectPath: inputs.projectPath,
    threads,
  };
}

export async function readMachineIndex(
  backend: HubBackend,
  projectId: string,
  machineId: string
): Promise<HubIndexJson | null> {
  const p = indexPath(projectId, machineId);
  if (!(await backend.exists(p))) return null;
  try {
    const parsed = JSON.parse((await backend.read(p)).toString()) as HubIndexJson;
    if (parsed.schemaVersion !== 1) return null;
    for (const [threadId, entry] of Object.entries(parsed.threads)) {
      assertSafeHubId(threadId, "threadId");
      for (const b of entry.bundles) {
        assertSafeHubId(b.bundleId, "bundleId");
        assertSafeHubId(b.sessionIdInBundle, "sessionIdInBundle");
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeMachineIndex(backend: HubBackend, index: HubIndexJson): Promise<void> {
  await backend.writeAtomic(
    indexPath(index.projectId, index.machineId),
    JSON.stringify(index, null, 2) + "\n"
  );
}

export async function readAllIndexes(
  backend: HubBackend,
  projectId: string
): Promise<{ indexes: HubIndexJson[]; warnings: string[] }> {
  const warnings: string[] = [];
  const indexes: HubIndexJson[] = [];
  for (const file of await backend.list(indexDirPath(projectId))) {
    const machineId = file.split("/").pop()!.replace(/\.json$/, "");
    // Containment: a hostile/corrupt filename like ".json" (machineId "")
    // or "..json" (machineId ".") would make indexPath's assertSafeHubId
    // throw and wedge the whole-project read that whereis/pull depend on.
    // Skip + warn instead, naming the FILE (the derived id is the unsafe
    // part, so never echo it into a message as if it were an id).
    if (!isSafeSessionId(machineId)) {
      warnings.push(`index file ${file} has an unsafe name — skipped.`);
      continue;
    }
    const index = await readMachineIndex(backend, projectId, machineId);
    if (index) indexes.push(index);
    else warnings.push(`index file for machine ${machineId} is unreadable (corrupt or not yet synced) — skipped.`);
  }
  return { indexes, warnings };
}
