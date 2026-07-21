import { mkdtempSync, rmSync, mkdirSync, createWriteStream, existsSync, readdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend } from "./backend.js";
import { HUB_JSON, type HubBundleRecord, type HubJson } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import { resolveProjectIdentity, linkToHubProject, type LocalProjectId } from "./identity.js";
import { registerMachine } from "./init.js";
import { buildIndexFile, readMachineIndex, writeMachineIndex, readAllIndexes } from "./index-file.js";
import { resolveThreads, type ResolvedThread } from "./threads.js";
import { shapeThreads } from "./whereis.js";
import { unpackWorkspace, WorkspaceTargetNotEmptyError } from "./workspace.js";
import { extractArchive } from "../archiver.js";
import { importSession } from "../importer.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { readManifest } from "../manifest.js";
import { readLastEntryUuid } from "../jsonl.js";
import { encodeProjectPath } from "../platform.js";
import { readSyncState, writeSyncState, setThreadId, recordSentToPeer } from "../sync-state.js";
import type {
  ErrorResult,
  ExportManifest,
  HubLockBusyResult,
  HubPullListResult,
  HubPullResult,
  HubUnlinkedResult,
  NotYetSyncedResult,
  ProgressEvent,
} from "../types.js";

export interface HubPullOptions {
  configDir: string;
  projectPath: string;
  hubPath: string;
  threadId?: string;
  latest?: boolean;
  targetPath?: string; // workspace unpack destination when project dir absent
  forceWorkspace?: boolean;
  projectIdOverride?: string;
  claudeVersion: string;
  onProgress?: (ev: ProgressEvent) => void;
}

// Last full bundle + everything after it, minus records already received AND
// still present locally (mirrors the importer's own dedup verification: a
// registry/peer record can outlive the file it points at, e.g. after a
// migrate deleted it, so "already received" is only trusted when the file is
// still there).
export function selectNeededBundles(
  bundles: HubBundleRecord[],
  received: Record<string, { localSessionId: string }> | undefined,
  localSessionFileExists: (localSessionId: string) => boolean
): HubBundleRecord[] {
  let lastFull = -1;
  for (let i = 0; i < bundles.length; i++) if (bundles[i].type === "full") lastFull = i;
  const chain = lastFull >= 0 ? bundles.slice(lastFull) : bundles.slice();
  return chain.filter((r) => {
    const prior = received?.[r.sessionIdInBundle];
    return !(prior && localSessionFileExists(prior.localSessionId));
  });
}

export async function hubPull(
  opts: HubPullOptions
): Promise<
  | HubPullResult
  | HubPullListResult
  | NotYetSyncedResult
  | HubUnlinkedResult
  | HubLockBusyResult
  | ErrorResult
> {
  let lock;
  try {
    lock = acquireProjectLock(opts.projectPath);
  } catch (e) {
    if (e instanceof LockBusyError) {
      return {
        success: false, command: "pull", reason: "lock-busy",
        holderPid: e.holderPid, ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
        suggestion: "Another sesh-mover hub operation is running for this project — wait for it or retry.",
      };
    }
    throw e;
  }

  let tempRoot: string | null = null;
  try {
    tempRoot = mkdtempSync(join(tmpdir(), "sesh-hub-pull-"));
    const backend = createFsBackend(opts.hubPath);
    const warnings: string[] = [];
    if (lock.stoleStale) {
      warnings.push(
        "Stole a stale project lock left by a previous sesh-mover hub operation (likely crashed or was killed) — proceeding, but verify no other push/pull is genuinely in progress."
      );
    }
    const machine = loadOrCreateMachineId();

    // Identity is resolved/linked against opts.projectPath — deliberately
    // NOT the "effective" project path below. In the bootstrap case (the
    // project doesn't exist locally yet and --target-path names a fresh
    // destination for the workspace) that destination must stay genuinely
    // nonexistent until the workspace-unpack step runs; if linking wrote
    // .claude-sesh-mover under it first, the "project path doesn't exist
    // locally" gate on the workspace flow (step 8) would never fire.
    let local: LocalProjectId;
    if (opts.projectIdOverride) {
      local = await linkToHubProject(backend, opts.projectPath, opts.projectIdOverride);
    } else {
      const resolution = await resolveProjectIdentity(backend, opts.projectPath);
      if (resolution.kind === "linked") {
        local = resolution.local;
      } else if (resolution.kind === "match") {
        local = await linkToHubProject(backend, opts.projectPath, resolution.hubProject.projectId);
        warnings.push(`Linked to hub project ${resolution.hubProject.name} via git remote ${resolution.matchedRemote}.`);
      } else {
        return {
          success: false, command: "pull", reason: "unlinked",
          linkCandidates: resolution.candidates,
          suggestion: "Pass --project-id <id> to link to an existing hub project.",
        };
      }
    }

    await registerMachine(opts.hubPath);

    // Read once, reused both for the hub-peer bookkeeping below (recognizing
    // pulled content as already-known-to-the-hub) and for this thread's
    // mapping write further down.
    const hub = JSON.parse((await backend.read(HUB_JSON)).toString()) as HubJson;
    const hubPeerId = `hub:${hub.hubId}`;

    const { indexes, warnings: indexWarnings } = await readAllIndexes(backend, local.projectId);
    warnings.push(...indexWarnings);
    const resolved = resolveThreads(indexes);

    if (!opts.threadId && !opts.latest) {
      const threads = await shapeThreads(backend, resolved, machine.id);
      return { success: true, command: "pull", pickRequired: true, threads, warnings };
    }

    const isCurrent = (t: ResolvedThread): boolean => {
      const localEntry = t.copies.find((c) => c.machineId === machine.id);
      return !!localEntry && localEntry.headEntryUuid === t.latest.headEntryUuid;
    };

    let target: ResolvedThread | undefined;
    if (opts.threadId) {
      target = resolved.find((t) => t.threadId === opts.threadId);
      if (!target) {
        return {
          success: false, command: "pull",
          error: `No thread "${opts.threadId}" found for this project on the hub.`,
          suggestion: "Run whereis to list available threads.",
        };
      }
    } else {
      // --latest: resolveThreads already sorts desc by latest activity —
      // take the first thread that is NOT already current on this machine.
      target = resolved.find((t) => !isCurrent(t));
      if (!target) {
        return {
          success: false, command: "pull",
          error: "Nothing to pull: all threads are current on this machine.",
          suggestion: "Run whereis to double-check thread status.",
        };
      }
    }

    const sourceCopy = target.latest;
    if (sourceCopy.machineId === machine.id) {
      return {
        success: false, command: "pull",
        error: "The latest copy of this thread is already local.",
        suggestion: "Run whereis to confirm — there is nothing to pull.",
      };
    }

    // Everything below (dedup/sync-state, workspace unpack, session import,
    // and this machine's own index projection) is keyed off the EFFECTIVE
    // project path: --target-path when given, else opts.projectPath.
    const effectiveProjectPath = opts.targetPath ?? opts.projectPath;
    const targetProjectDir = join(opts.configDir, "projects", encodeProjectPath(effectiveProjectPath));
    const state = readSyncState(effectiveProjectPath);
    const received = state.peers[sourceCopy.machineId]?.received;
    const needed = selectNeededBundles(
      sourceCopy.bundles,
      received,
      (localSessionId) => existsSync(join(targetProjectDir, `${localSessionId}.jsonl`))
    );
    if (needed.length === 0) {
      return {
        success: false, command: "pull",
        error: "Already up to date with the source machine.",
        suggestion: "Run whereis to confirm.",
      };
    }

    const missing: string[] = [];
    for (const record of needed) if (!(await backend.exists(record.file))) missing.push(record.file);
    if (missing.length > 0) {
      return {
        success: false, command: "pull", reason: "not-yet-synced", missing,
        suggestion: "The hub folder has not finished syncing these files — retry in a moment.",
      };
    }

    opts.onProgress?.({ phase: "hub-pull", percent: 0 });

    let workspaceUnpacked: HubPullResult["workspaceUnpacked"] = null;
    const importedSessions: HubPullResult["importedSessions"] = [];
    const skippedSessions: HubPullResult["skippedSessions"] = [];
    let lastImportedNewId: string | null = null;
    let lastBundleManifest: ExportManifest | null = null;

    for (const [i, record] of needed.entries()) {
      const tarPath = join(tempRoot, `${record.bundleId}.tar.gz`);
      const out = createWriteStream(tarPath);
      // record.file is hub-sourced (read out of another machine's index
      // file) and used as a path immediately below — the backend's
      // assertHubRelPath (hub/layout.ts, enforced inside every HubBackend
      // method, see hub/backend.ts) is the containment that rejects
      // traversal/absolute paths before anything touches the filesystem.
      await pipeline(await backend.readStream(record.file), out);
      const extractDir = join(tempRoot, record.bundleId);
      mkdirSync(extractDir, { recursive: true });
      await extractArchive(tarPath, extractDir);
      // Archiver-rooting reality check: createArchive tars the staging dir
      // with `cwd: dirname(sourceDir)` and a single top-level entry
      // (basename(sourceDir), i.e. "bundle" for push's staging), and
      // extractArchive always calls tar.extract with strip:1 — which
      // removes exactly that one wrapper segment. So manifest.json/sessions/
      // etc. land directly under extractDir, the same way cli.ts's import
      // action treats its own tempExtractDir as the exportPath (no nested
      // "bundle/" to join).
      const bundleManifest = readManifest(extractDir);
      lastBundleManifest = bundleManifest;

      // Workspace gate (first needed bundle only):
      // - target absent, empty, or
      //   metadata-only                -> unpack (bootstrap; no force needed)
      // - explicit --target-path,
      //   has real content, no force   -> let unpackWorkspace throw, surface
      //                                   an ErrorResult with the
      //                                   --force-workspace suggestion (the
      //                                   user asked for that destination;
      //                                   refuse loudly)
      // - no explicit --target-path,
      //   project dir has real content,
      //   no force                     -> SKIP with a warning (routine repeat
      //                                   pulls of non-git projects must not
      //                                   start erroring)
      // - --force-workspace            -> unpack with force (merge) regardless
      //
      // ".claude-sesh-mover" counts as non-content on BOTH sides: identity
      // linking above may have just planted project.json into an otherwise
      // fresh directory (the in-place bootstrap flow, --project-id with no
      // --target-path), and that metadata alone must neither trigger the
      // routine-skip branch nor trip unpackWorkspace's own emptiness check —
      // hence force is also set when the dir holds nothing but our metadata.
      if (i === 0 && bundleManifest.workspace) {
        const entries = existsSync(effectiveProjectPath) ? readdirSync(effectiveProjectPath) : [];
        const hasRealContent = entries.some((n) => n !== ".claude-sesh-mover");
        if (hasRealContent && !opts.forceWorkspace && !opts.targetPath) {
          warnings.push(
            "Bundle carries a workspace payload but the project directory already has content — pass --force-workspace to merge it here, or re-pull with --target-path <fresh-dir> to unpack it elsewhere."
          );
        } else {
          try {
            const ws = await unpackWorkspace(
              join(extractDir, "workspace"),
              effectiveProjectPath,
              { force: !!opts.forceWorkspace || !hasRealContent }
            );
            workspaceUnpacked = { path: effectiveProjectPath, fileCount: ws.fileCount };
            if (ws.symlinksSkipped > 0) {
              warnings.push(`${ws.symlinksSkipped} symlink(s) skipped while unpacking the workspace.`);
            }
          } catch (e) {
            if (e instanceof WorkspaceTargetNotEmptyError) {
              return {
                success: false, command: "pull",
                error: e.message,
                suggestion: "Pass --force-workspace to merge into the existing (non-empty) target directory.",
              };
            }
            throw e;
          }
        }
      }

      const importResult = await importSession({
        exportPath: extractDir,
        targetConfigDir: opts.configDir,
        targetProjectPath: effectiveProjectPath,
        targetClaudeVersion: opts.claudeVersion,
        dryRun: false,
        sessionIds: [record.sessionIdInBundle],
      });
      if (!importResult.success) return importResult; // importer already rolled back partial writes
      importedSessions.push(...importResult.importedSessions);
      skippedSessions.push(...importResult.skippedSessions);
      warnings.push(...importResult.warnings);
      if (importResult.importedSessions.length > 0) {
        lastImportedNewId = importResult.importedSessions[importResult.importedSessions.length - 1].newId;
        // The hub is the origin of this bundle's content, so as far as this
        // machine's OWN sync-state is concerned the hub already has it up to
        // this head — record that against the hub's own peer id (not the
        // originating machine's, which importSession already recorded above)
        // so a future push of just-appended content is recognized as a
        // continuation instead of re-uploading the whole session as "full".
        recordSentToPeer(effectiveProjectPath, { id: hubPeerId, name: "hub" }, lastImportedNewId, {
          headEntryUuid: record.headEntryUuid,
          messageCount: record.messageCount,
          sentAsType: record.type,
          sentAsSessionId: record.sessionIdInBundle,
        });
      }
    }

    // Thread mapping: prefer this pull's own import; if every bundle in the
    // chain was skipped, fall back to (1) the local session id an earlier
    // receipt from this peer was recorded against, then (2) the imported-hash
    // registry — the cross-route duplicate case, where identical content
    // arrived earlier via a plain import (no peer bookkeeping) and the
    // importer skipped it via state.imported[integrityHash] rather than
    // peers[...].received.
    const lastRecord = needed[needed.length - 1];
    const stateAfter = readSyncState(effectiveProjectPath);
    const lastSessionManifest =
      lastBundleManifest?.sessions.find((s) => s.sessionId === lastRecord.sessionIdInBundle) ?? null;
    const hashRegistryFallback = lastSessionManifest
      ? stateAfter.imported[lastSessionManifest.integrityHash]?.localSessionId
      : undefined;
    const localSessionId: string | null =
      lastImportedNewId ??
      stateAfter.peers[sourceCopy.machineId]?.received[lastRecord.sessionIdInBundle]?.localSessionId ??
      hashRegistryFallback ??
      null;

    if (localSessionId !== null) {
      setThreadId(stateAfter, hub.hubId, localSessionId, target.threadId);
      writeSyncState(stateAfter);
    } else {
      // Never map a thread to a fabricated id (an empty string would poison
      // the index projection below and every future pull's dedup).
      warnings.push(
        "pulled content already exists locally but its session could not be identified — a future push from this machine will re-map the thread"
      );
    }

    // Rewrite our machine index over current local sessions — pulls never
    // create bundles, so newBundles is always empty here.
    const sessionsNow = discoverSessions(opts.configDir, effectiveProjectPath).map((s) => ({
      sessionId: s.sessionId,
      slug: s.slug,
      summary: s.slug,
      headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
      messageCount: s.messageCount,
      lastActiveAt: s.lastActiveAt,
    }));
    const prior = await readMachineIndex(backend, local.projectId, machine.id);
    await writeMachineIndex(
      backend,
      buildIndexFile({
        projectId: local.projectId,
        machineId: machine.id,
        projectPath: effectiveProjectPath,
        sessions: sessionsNow,
        state: stateAfter,
        priorIndex: prior,
        newBundles: [],
        now: new Date().toISOString(),
      })
    );

    opts.onProgress?.({ phase: "hub-pull", percent: 100 });
    return {
      success: true,
      command: "pull",
      threadId: target.threadId,
      sourceMachineId: sourceCopy.machineId,
      importedSessions,
      skippedSessions,
      localSessionId,
      workspaceUnpacked,
      warnings,
    };
  } finally {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    lock.release();
  }
}
