import { mkdtempSync, rmSync, mkdirSync, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend } from "./backend.js";
import { bundleDir, type HubBundleRecord, type HubIndexJson } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import { readLocalProjectId } from "./identity.js";
import { registerMachine } from "./init.js";
import { buildIndexFile, writeMachineIndex } from "./index-file.js";
import { extractArchive } from "../archiver.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { readManifest } from "../manifest.js";
import { readLastEntryUuid } from "../jsonl.js";
import { readSyncState, getThreadId } from "../sync-state.js";
import type { ErrorResult, HubReindexResult } from "../types.js";

export interface HubReindexOptions {
  configDir: string;
  projectPath: string;
  hubPath: string;
}

// bundleFileName (layout.ts) writes `${sanitizedIso}-${bundleId}.tar.gz`,
// where ':' in the ISO timestamp was replaced with '-' for filesystem/sort
// safety. Both halves can contain '-' (date/time separators on the left,
// UUID dashes on the right), so splitting on '-' generically is ambiguous —
// anchor on the sanitized-ISO's fixed shape (YYYY-MM-DDTHH-MM-SS.mmmZ)
// instead; everything between that and ".tar.gz" is the bundleId.
const BUNDLE_FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-(.+)\.tar\.gz$/;

// Reverse bundleFileName's ':' -> '-' sanitization. An ISO timestamp from
// Date#toISOString() contains exactly two ':', both inside the
// "THH:MM:SS" section, so this regex swap recovers the original exactly.
// Falls back to the sanitized prefix itself if the result doesn't parse as
// a date (defensive — never throws on a foreign/corrupt file name).
function recoverPushedAt(sanitizedIso: string): string {
  const recovered = sanitizedIso.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  return Number.isNaN(Date.parse(recovered)) ? sanitizedIso : recovered;
}

function parseBundleFileName(fileName: string): { pushedAt: string; bundleId: string } | null {
  const m = BUNDLE_FILE_RE.exec(fileName);
  if (!m) return null;
  return { pushedAt: recoverPushedAt(m[1]), bundleId: m[2] };
}

// Rebuild this machine's own index file for the CURRENT project from its
// bundles on the hub (never another machine's) — the derivability
// invariant made executable: everything an index file records (thread ->
// bundle history) is reconstructible from the bundles themselves plus this
// machine's local sync-state (which thread each local session belongs to).
// A repair tool for a lost/corrupt index.json, not a sync primitive.
export async function hubReindex(opts: HubReindexOptions): Promise<HubReindexResult | ErrorResult> {
  const local = readLocalProjectId(opts.projectPath);
  if (!local) {
    return {
      success: false,
      command: "hub-reindex",
      error: "This project is not linked to a hub project — there is nothing to reindex from.",
      suggestion: "Run push (with --create-project or --project-id) to link and publish this project to the hub first.",
    };
  }

  // Reindex only ever (re)writes THIS machine's own index file, but a
  // concurrent push (or another reindex) could be rebuilding/writing that
  // same file at the same moment — take the project lock for consistency
  // with push/pull, even though reindex never touches bundle data itself.
  let lock;
  try {
    lock = acquireProjectLock(opts.projectPath);
  } catch (e) {
    if (e instanceof LockBusyError) {
      return {
        success: false,
        command: "hub-reindex",
        error: e.message,
        suggestion: "Another sesh-mover hub operation is running for this project — wait for it or retry.",
      };
    }
    throw e;
  }

  let tempRoot: string | null = null;
  try {
    tempRoot = mkdtempSync(join(tmpdir(), "sesh-hub-reindex-"));
    const backend = createFsBackend(opts.hubPath);
    const warnings: string[] = [];
    const machine = loadOrCreateMachineId();
    await registerMachine(opts.hubPath);

    const dir = bundleDir(local.projectId, machine.id);
    // The sortable timestamp prefix (bundleFileName) exists for exactly
    // this: lexical sort of the file names is chronological push order.
    const files = (await backend.list(dir)).sort();

    const state = readSyncState(opts.projectPath);
    const records: Array<{ threadId: string; record: HubBundleRecord }> = [];
    // Per-thread metadata reconstructed from bundle manifests, keyed by
    // threadId and overwritten as we scan chronologically (last bundle
    // wins). Used below to build a synthetic priorIndex so a thread whose
    // local session has since vanished (JSONL deleted) still survives the
    // rebuild — see the comment at its use site.
    const threadMeta = new Map<string, HubIndexJson["threads"][string]>();

    for (const [i, file] of files.entries()) {
      const fileName = file.split("/").pop() ?? file;
      const parsed = parseBundleFileName(fileName);
      if (!parsed) {
        warnings.push(`bundle file ${file} has an unrecognized name — skipped.`);
        continue;
      }

      const tarPath = join(tempRoot, `bundle-${i}.tar.gz`);
      await pipeline(await backend.readStream(file), createWriteStream(tarPath));
      const extractDir = join(tempRoot, `extract-${i}`);
      mkdirSync(extractDir, { recursive: true });
      // All bundles here are this machine's own pushes (bundleDir is keyed
      // by machineId), but we still run the standard extract path — same
      // tar-entry validation (assertSafeEntries) as pull's cross-machine
      // download, no special-casing "trusted" archives.
      await extractArchive(tarPath, extractDir);
      const manifest = readManifest(extractDir);
      const hasWorkspace = !!manifest.workspace;

      for (const s of manifest.sessions) {
        // Same mapping as push's index-projection step: a continuation
        // bundles under the LOCAL session id it continues, not its own
        // (bundle-scoped) session id.
        const localSessionId =
          s.type === "continuation" && s.continuation ? s.continuation.continuesLocalSessionId : s.sessionId;
        const threadId = getThreadId(state, localSessionId);
        if (!threadId) {
          warnings.push(`no local thread mapping for bundled session ${s.sessionId} (bundle ${file}) — dropped.`);
          continue;
        }
        const headEntryUuid = readLastEntryUuid(join(extractDir, "sessions", `${s.sessionId}.jsonl`)) ?? "";
        records.push({
          threadId,
          record: {
            bundleId: parsed.bundleId,
            file,
            type: s.type === "continuation" ? "continuation" : "full",
            sessionIdInBundle: s.sessionId,
            fromEntryUuid: s.continuation?.fromEntryUuid ?? null,
            headEntryUuid,
            messageCount: s.messageCount,
            pushedAt: parsed.pushedAt,
            hasWorkspace,
          },
        });
        threadMeta.set(threadId, {
          localSessionId,
          slug: s.slug,
          summary: s.summary,
          headEntryUuid,
          messageCount: s.messageCount,
          lastActiveAt: s.lastActiveAt,
          bundles: [],
        });
      }
    }

    const sessionsNow = discoverSessions(opts.configDir, opts.projectPath).map((s) => ({
      sessionId: s.sessionId,
      slug: s.slug,
      summary: s.slug,
      headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
      messageCount: s.messageCount,
      lastActiveAt: s.lastActiveAt,
    }));

    // buildIndexFile's `threads` map is seeded from `sessions` (live
    // discovery) first, falling back to `priorIndex.threads` only for
    // thread ids NOT already found live. With priorIndex: null, a thread
    // whose local session was deleted after it was pushed would vanish
    // from the rebuilt index — a real regression vs. the original (which
    // carried it forward from ITS priorIndex). We can't ask the hub for
    // that (index files are exactly what we're rebuilding), but we CAN
    // reconstruct equivalent thread metadata from the bundle manifests
    // scanned above (slug/summary/headEntryUuid/messageCount/lastActiveAt
    // all live in SessionManifest). Feeding that as a synthetic priorIndex
    // (bundles: [] — the real bundle history is supplied separately via
    // `newBundles`, same as a live thread's) carries vanished threads
    // forward without disturbing live ones: for a thread that IS live,
    // buildIndexFile only ever takes `bundles` from priorIndex (which we
    // set to [] here, same as the `?? []` it'd use for a genuine null), so
    // this can never diverge from a true no-prior rebuild for live
    // threads — only adds back what a strict `priorIndex: null` would
    // have dropped.
    const syntheticPrior: HubIndexJson = {
      schemaVersion: 1,
      agent: "claude-code",
      projectId: local.projectId,
      machineId: machine.id,
      updatedAt: "",
      projectPath: opts.projectPath,
      threads: Object.fromEntries(threadMeta),
    };

    const built = buildIndexFile({
      projectId: local.projectId,
      machineId: machine.id,
      projectPath: opts.projectPath,
      sessions: sessionsNow,
      state,
      priorIndex: syntheticPrior,
      newBundles: records,
      now: new Date().toISOString(),
    });
    await writeMachineIndex(backend, built);

    return {
      success: true,
      command: "hub-reindex",
      projects: [
        { projectId: local.projectId, threads: Object.keys(built.threads).length, bundlesScanned: files.length },
      ],
      warnings,
    };
  } finally {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    lock.release();
  }
}
