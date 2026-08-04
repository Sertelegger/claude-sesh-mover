import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFsBackend } from "./backend.js";
import { HUB_JSON, bundleDir, bundleFileName, type HubBundleRecord, type HubJson } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import {
  resolveProjectIdentity, createHubProject, linkToHubProject, localGitRemotes,
  readLocalProjectId, type LocalProjectId,
} from "./identity.js";
import { registerMachine } from "./init.js";
import { buildIndexFile, readMachineIndex, writeMachineIndex } from "./index-file.js";
import { snapshotWorkspace, hubincludePath, isNeverIncludable } from "./workspace.js";
import { exportAllSessions } from "../exporter.js";
import { createArchive } from "../archiver.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { readManifest } from "../manifest.js";
import { readLastEntryUuid } from "../jsonl.js";
import {
  readSyncState, writeSyncState, recordSentFromBundle, getThreadId, setThreadId, setLastWorkspace,
} from "../sync-state.js";
import type { ErrorResult, HubLockBusyResult, HubPushResult, HubUnlinkedResult, ProgressEvent } from "../types.js";

export interface HubPushOptions {
  configDir: string;
  projectPath: string;
  hubPath: string;
  sessionIds?: string[];
  noWorkspace?: boolean;
  projectIdOverride?: string;
  createProject?: boolean;
  claudeVersion: string;
  /**
   * Suppress everything whose only purpose is to be read by a human. Set by the
   * SessionEnd auto-push hook, whose contract is that session exit is never
   * interrupted or narrated (design §4.2) — today that means skipping the
   * `ignoredNotCarried` discovery scan, which also spares an unattended push a
   * `git ls-files` walk of the whole working tree.
   */
  quiet?: boolean;
  onProgress?: (ev: ProgressEvent) => void;
}

/** Cap on `ignoredNotCarried`: a sample the user can recognize, not an inventory. */
const MAX_IGNORED_REPORTED = 10;

/**
 * Top-level gitignored paths, as `git` spells them — `docs/` for a wholly
 * ignored directory, `src/generated.ts` for a single ignored file inside a
 * carried one. Each is a valid `hubinclude` pattern for exactly that thing.
 *
 * `-z` is not a nicety: without it git applies `core.quotePath`, so a name with
 * a space, a quote, a newline or any non-ASCII character comes back C-quoted
 * and octal-escaped, and a newline in a filename would split one entry into
 * two. This list is shown to a user and offered as a pattern to paste, so it
 * has to be the real bytes.
 *
 * Every failure — no git, not a repo, timeout, output past `maxBuffer` — is the
 * same answer: no discovery aid this time. It is a hint, never a gate.
 */
function listTopLevelIgnored(projectPath: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      {
        cwd: projectPath, encoding: "utf-8", timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024,
      }
    );
    const paths = new Set<string>();
    for (const entry of out.split("\0")) {
      // No trimming: with -z the bytes between separators ARE the path, and a
      // name may legitimately begin or end with a space.
      if (!entry) continue;
      if (isNeverIncludable(entry)) continue; // can never be carried, so never suggest it
      paths.add(entry);
      if (paths.size >= MAX_IGNORED_REPORTED) break;
    }
    return [...paths];
  } catch {
    return [];
  }
}

export async function hubPush(
  opts: HubPushOptions
): Promise<HubPushResult | HubUnlinkedResult | HubLockBusyResult | ErrorResult> {
  // An empty array is programmatically distinct from "omitted" but must mean
  // the same thing here — otherwise it mints zero threads (the filter below
  // matches nothing) while still exporting every session (exportAllSessions
  // treats [] as "no filter" today), silently over-exporting.
  const sessionIds = opts.sessionIds && opts.sessionIds.length > 0 ? opts.sessionIds : undefined;
  let lock;
  try {
    lock = acquireProjectLock(opts.projectPath);
  } catch (e) {
    if (e instanceof LockBusyError) {
      return {
        success: false, command: "push", reason: "lock-busy",
        holderPid: e.holderPid, ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
        suggestion: "Another sesh-mover hub operation is running for this project — wait for it or retry.",
      };
    }
    throw e;
  }

  // Staging is created inside the protecting try so a mkdtemp failure still
  // releases the lock in the finally (review fix: post-acquire throw window).
  let staging: string | null = null;
  try {
    staging = mkdtempSync(join(tmpdir(), "sesh-hub-push-"));
    const backend = createFsBackend(opts.hubPath);
    const warnings: string[] = [];
    if (lock.stoleStale) {
      warnings.push(
        "Stole a stale project lock left by a previous sesh-mover hub operation (likely crashed or was killed) — proceeding, but verify no other push/pull is genuinely in progress."
      );
    }
    const machine = loadOrCreateMachineId();

    // Identity
    let local: LocalProjectId;
    if (opts.projectIdOverride) {
      local = await linkToHubProject(backend, opts.projectPath, opts.projectIdOverride);
    } else if (opts.createProject && !readLocalProjectId(opts.projectPath)) {
      local = await createHubProject(backend, opts.projectPath, machine.id);
    } else {
      const resolution = await resolveProjectIdentity(backend, opts.projectPath);
      if (resolution.kind === "linked") local = resolution.local;
      else if (resolution.kind === "match") {
        local = await linkToHubProject(backend, opts.projectPath, resolution.hubProject.projectId);
        warnings.push(`Linked to hub project ${resolution.hubProject.name} via git remote ${resolution.matchedRemote}.`);
      } else {
        return {
          success: false, command: "push", reason: "unlinked",
          linkCandidates: resolution.candidates,
          suggestion: "Pass --project-id <id> to link to an existing hub project, or --create-project to mint a new one.",
        };
      }
    }

    await registerMachine(opts.hubPath);
    const hub = JSON.parse((await backend.read(HUB_JSON)).toString()) as HubJson;
    const hubPeerId = `hub:${hub.hubId}`;
    opts.onProgress?.({ phase: "hub-push", percent: 0 });

    // Thread minting for every session in scope
    let sessions = discoverSessions(opts.configDir, opts.projectPath);
    if (sessionIds) sessions = sessions.filter((s) => sessionIds.includes(s.sessionId));
    const state = readSyncState(opts.projectPath);
    for (const s of sessions) {
      if (!getThreadId(state, s.sessionId)) setThreadId(state, hub.hubId, s.sessionId, randomUUID());
    }
    writeSyncState(state);

    // Incremental export against the hub pseudo-peer. One export path:
    // exportAllSessions honors sessionIds (undefined = all) and errors on
    // any requested id that doesn't exist.
    const bundleId = randomUUID();
    const exportResult = await exportAllSessions({
      configDir: opts.configDir,
      projectPath: opts.projectPath,
      sessionIds,
      outputDir: staging,
      name: "bundle",
      excludeLayers: [],
      claudeVersion: opts.claudeVersion,
      incremental: {
        sourceMachineId: machine.id,
        sourceMachineName: machine.name,
        targetMachineId: hubPeerId,
        targetMachineName: "hub",
        peerSent: state.peers[hubPeerId]?.sent ?? {},
      },
      onProgress: opts.onProgress,
    });
    if (!exportResult.success) return exportResult;
    const bundleStaging = exportResult.exportPath;
    const manifest = readManifest(bundleStaging);
    if (manifest.sessions.length === 0) {
      // Every discovered session's head already matches what the hub has
      // recorded as sent — nothing to push. Return before any hub write
      // (no bundle archive, no index rewrite); the outer finally cleans up
      // staging.
      opts.onProgress?.({ phase: "hub-push", percent: 100 });
      return {
        success: true, command: "push", projectId: local.projectId,
        bundleId: null, pushedSessions: [], upToDate: true, hasWorkspace: false, warnings,
      };
    }

    // Memoized: `git remote -v` gates both the workspace payload and the
    // ignored-path discovery aid below, and neither runs on the up-to-date
    // early return above — so a quiet auto-push with no workspace still spawns
    // nothing, and a manual push of a git project spawns it once, not twice.
    let gitRemotesCache: string[] | null = null;
    const gitRemotes = (): string[] => (gitRemotesCache ??= localGitRemotes(opts.projectPath));

    // Workspace payload — projects with no git remotes (including
    // remote-less git repositories), since there's no remote to reconstruct
    // the working tree from otherwise.
    let hasWorkspace = false;
    if (!opts.noWorkspace && gitRemotes().length === 0 && existsSync(opts.projectPath)) {
      const ws = await snapshotWorkspace(opts.projectPath, join(bundleStaging, "workspace"));
      if (ws.symlinksSkipped > 0) warnings.push(`${ws.symlinksSkipped} symlink(s) skipped in workspace snapshot.`);
      const manifestPath = join(bundleStaging, "manifest.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
      // Declare what this snapshot descends from — read BEFORE the new
      // generation is recorded below. A puller intersects this id with its own
      // generation history, and only a hit makes a 3-way merge legal: it is the
      // proof that a generation was held by both trees, which neither side can
      // establish alone (see the field's doc in types.ts). `file` and
      // `pushedAt` ride along as diagnostics only — the puller resolves the
      // generation through its OWN record, so nothing here becomes a path or a
      // comparison on the other machine.
      const basedOnRef = readSyncState(opts.projectPath).hub?.lastWorkspace;
      m.workspace = {
        fileCount: ws.fileCount,
        byteSize: ws.byteSize,
        snapshotAt: new Date().toISOString(),
        basedOn: basedOnRef
          ? { bundleId: basedOnRef.bundleId, file: basedOnRef.file, pushedAt: basedOnRef.pushedAt }
          : null,
      };
      writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
      hasWorkspace = true;
    }

    // Archive + stream into hub
    const pushedAt = new Date().toISOString();
    const archiveTmp = join(staging, "bundle.tar.gz");
    await createArchive(bundleStaging, archiveTmp, "gzip");
    const hubFile = `${bundleDir(local.projectId, machine.id)}/${bundleFileName(pushedAt, bundleId)}`;
    const w = await backend.writeStreamAtomic(hubFile);
    try {
      await pipeline(createReadStream(archiveTmp), w.stream);
      await w.commit();
    } catch (e) {
      await w.abort();
      throw e;
    }

    // Peer bookkeeping from the staged bundle (snapshot, never live files)
    recordSentFromBundle(opts.projectPath, { id: hubPeerId, name: "hub" }, bundleStaging);

    // The workspace generation this machine's tree now shares with the hub —
    // the ancestor input for the next pull's 3-way merge (design §5.2). Only
    // recorded once the bundle is committed to the hub: a generation the hub
    // does not hold cannot be fetched back as an ancestor.
    //
    // It describes the SNAPSHOT, not the live tree: anything the user edited
    // between snapshotWorkspace above and this line is a local change against
    // this generation, which is exactly what the next merge should see.
    //
    // Read AFTER recordSentFromBundle — that helper rewrites the same file, so
    // mutating a copy read before it would be silently discarded.
    if (hasWorkspace) {
      const stateWs = readSyncState(opts.projectPath);
      setLastWorkspace(stateWs, hub.hubId, { bundleId, file: hubFile, pushedAt });
      writeSyncState(stateWs);
    }

    // Index projection
    const stateAfter = readSyncState(opts.projectPath);
    const records: Array<{ threadId: string; record: HubBundleRecord }> = [];
    const pushedSessions: HubPushResult["pushedSessions"] = [];
    for (const s of manifest.sessions) {
      const localSessionId =
        s.type === "continuation" && s.continuation ? s.continuation.continuesLocalSessionId : s.sessionId;
      const threadId = getThreadId(stateAfter, localSessionId);
      if (!threadId) { warnings.push(`no thread mapping for pushed session ${s.sessionId} — index skipped it.`); continue; }
      records.push({
        threadId,
        record: {
          bundleId, file: hubFile,
          type: s.type === "continuation" ? "continuation" : "full",
          sessionIdInBundle: s.sessionId,
          fromEntryUuid: s.continuation?.fromEntryUuid ?? null,
          headEntryUuid: readLastEntryUuid(join(bundleStaging, "sessions", `${s.sessionId}.jsonl`)) ?? "",
          messageCount: s.messageCount, pushedAt, hasWorkspace,
        },
      });
      pushedSessions.push({ threadId, sessionId: s.sessionId, type: s.type === "continuation" ? "continuation" : "full" });
    }
    const sessionsNow = discoverSessions(opts.configDir, opts.projectPath).map((s) => ({
      sessionId: s.sessionId, slug: s.slug, summary: s.slug,
      headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
      messageCount: s.messageCount, lastActiveAt: s.lastActiveAt,
    }));
    const prior = await readMachineIndex(backend, local.projectId, machine.id);
    await writeMachineIndex(backend, buildIndexFile({
      projectId: local.projectId, machineId: machine.id, projectPath: opts.projectPath,
      sessions: sessionsNow, state: stateAfter, priorIndex: prior, newBundles: records,
      now: pushedAt,
    }));

    // Discovery aid (design §6.0): name what .gitignore kept out, so the user
    // can opt paths back in via hubinclude without having to know the file
    // exists. Manual pushes only — the auto-push hook must stay silent — and
    // only until a hubinclude exists, at which point the user has met the
    // mechanism and further nagging is noise. Existence, not pattern count, is
    // the test: a file holding only comments still means "I know about this".
    let ignoredNotCarried: string[] | undefined;
    if (!opts.quiet && gitRemotes().length > 0 && !existsSync(hubincludePath(opts.projectPath))) {
      const ignored = listTopLevelIgnored(opts.projectPath);
      if (ignored.length > 0) ignoredNotCarried = ignored;
    }

    opts.onProgress?.({ phase: "hub-push", percent: 100 });
    return {
      success: true, command: "push", projectId: local.projectId,
      bundleId, pushedSessions, upToDate: false, hasWorkspace, warnings,
      ...(ignoredNotCarried ? { ignoredNotCarried } : {}),
    };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    lock.release();
  }
}
