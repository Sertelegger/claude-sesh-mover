import { mkdtempSync, rmSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend, type HubBackend } from "./backend.js";
import { type HubBundleRecord } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import { runApplyCarryStage } from "./pull-apply-carry.js";
import { runApplySessionsStage } from "./pull-apply-sessions.js";
import { runApplyWorkspaceStage } from "./pull-apply-workspace.js";
import { initApplyState, isCarrySuppressed, sharedLayerFindings } from "./pull-apply-state.js";
import { runFetchStage } from "./pull-fetch.js";
import { runRecordStage } from "./pull-record.js";
import { runResolveStage } from "./pull-resolve.js";
import { runSelectStage, type SelectReport } from "./pull-select.js";
import { loadOrCreateMachineId } from "../machine.js";
import { countJsonlLines } from "../jsonl.js";
import { encodeProjectPath } from "../platform.js";
import {
  readSyncState, writeSyncState, recordSentToPeer,
} from "../sync-state.js";
import type {
  ErrorResult,
  ExportManifest,
  HubLockBusyResult,
  HubPullListResult,
  HubPullResult,
  HubUnlinkedResult,
  NotYetSyncedResult,
  OnDivergenceMode,
  ProgressEvent,
  SessionManifest,
} from "../types.js";

export interface HubPullOptions {
  configDir: string;
  projectPath: string;
  hubPath: string;
  threadId?: string;
  latest?: boolean;
  targetPath?: string; // workspace unpack destination when project dir absent
  forceWorkspace?: boolean;
  /**
   * Apply carried uncommitted changes to the working tree (design §6.2).
   * Without it a carried payload is still SAVED — see `applyCarry`'s
   * `saveOnly` for why reporting it and dropping it would be a dead end.
   */
  applyCarry?: boolean;
  projectIdOverride?: string;
  claudeVersion: string;
  /** Splice onto a base that looks like a live session (skips the mtime guard). */
  forceAppend?: boolean;
  /** Never splice: import every continuation as its own session (Slice-1 behavior). */
  noAppend?: boolean;
  /** How to resolve a two-sided fork. Defaults to "fragment". */
  onDivergence?: OnDivergenceMode;
  onProgress?: (ev: ProgressEvent) => void;
}

/**
 * Re-exported rather than re-declared. `apply.sessions` owns the thread-base
 * choice — it re-reads sync-state per bundle to make it — but `selectThreadBase`
 * and its candidate type are part of this package's PUBLIC surface:
 * `src/index.ts` does `export * from "./hub/pull.js"`, and `tests/hub-pull.test.ts`
 * imports it from here. Dropping this line silently deletes a named export from
 * the package entrypoint, and `dist/` is committed, so it would ship.
 * Importing it back the other way would make the two modules circular.
 */
export { selectThreadBase, type ThreadBaseCandidate } from "./pull-apply-sessions.js";

/**
 * Same rule, same reason, for the two helpers the `select` stage took with it:
 * both are imported from HERE by `tests/hub-pull.test.ts` (each with its own
 * `(pure)` describe block), and `src/index.ts`'s `export * from "./hub/pull.js"`
 * puts them on the package entrypoint. Dropping this line deletes two named
 * exports from a shipped, committed `dist/`.
 *
 * `describeUnfetchable` in particular could not stay behind: `discloseUnfetchable`
 * moved with the stage and calls it, so leaving it here would make the two
 * modules circular.
 */
export { describeUnfetchable } from "./pull-select.js";
export { selectNeededBundles } from "./threads.js";

/**
 * How many entries the local base holds beyond the common anchor — the "your
 * side" number the divergence report shows the user.
 *
 * Reading from `start: offset` rather than counting bytes back up to it keeps
 * this immune to the byte-arithmetic caveats on `findEntryOffsetByUuid`: an
 * offset past EOF yields nothing (0), and a CRLF offset that lands on the
 * terminator just produces one leading empty line, which is skipped.
 */
async function countEntriesAfterOffset(path: string, offset: number): Promise<number> {
  const input = createReadStream(path, { encoding: "utf-8", start: offset });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of rl) if (line.trim()) count++;
  } finally {
    rl.close();
    input.destroy();
  }
  return count;
}

/**
 * The bookkeeping `importSession` would normally do, which the splice paths
 * (plain append and divergence adoption alike) deliberately bypass: no new
 * session was created, so there is nothing for the importer to record — but
 * without these entries the very same bundle is "needed" again on the next
 * pull (selectNeededBundles reads peers[...].received) and a push back to the
 * hub would re-upload the whole session as a full bundle.
 *
 * Callers must run this BEFORE copying layer files: the base is already
 * extended by then, so a layer-copy fault must not leave the splice
 * unrecorded — the next pull would re-need the bundle, chain-mismatch against
 * the now-longer base, and land the very same entries again as a fragment.
 *
 * Deliberately NOT written: state.lineage[baseSessionId]. The base already has
 * lineage describing where the SESSION came from; overwriting it with this
 * splice's provenance would destroy that and claim the whole transcript
 * arrived as a continuation.
 */
function recordSplice(b: {
  projectPath: string;
  basePath: string;
  baseSessionId: string;
  peerId: string;
  hubPeerId: string;
  manifest: ExportManifest;
  record: HubBundleRecord;
  bundleSession: SessionManifest;
  newHeadUuid: string;
}): void {
  const now = new Date().toISOString();
  const messageCount = countJsonlLines(b.basePath);
  const st = readSyncState(b.projectPath);
  st.peers[b.peerId] ??= {
    name: b.manifest.sourceMachineName ?? b.peerId,
    lastSentAt: null, lastReceivedAt: null, sent: {}, received: {},
  };
  const peer = st.peers[b.peerId];
  if (b.manifest.sourceMachineName) peer.name = b.manifest.sourceMachineName;
  peer.lastReceivedAt = now;
  peer.received[b.record.sessionIdInBundle] = {
    localSessionId: b.baseSessionId,
    type: "continuation",
    importedAt: now,
  };
  // This machine is now level with that peer on this session.
  peer.sent[b.baseSessionId] = {
    headEntryUuid: b.newHeadUuid,
    messageCount,
    sentAsType: "continuation",
    sentAsSessionId: b.record.sessionIdInBundle,
  };
  st.imported[b.bundleSession.integrityHash] = {
    localSessionId: b.baseSessionId,
    importedAt: now,
    registered: true,
  };
  writeSyncState(st);
  // ...and so is the hub, which is where this content came from. After an
  // adoption the base matches the hub's branch exactly, so this is what stops
  // the next push re-shipping content we just took FROM the hub.
  recordSentToPeer(b.projectPath, { id: b.hubPeerId, name: "hub" }, b.baseSessionId, {
    headEntryUuid: b.newHeadUuid,
    messageCount,
    sentAsType: "continuation",
    sentAsSessionId: b.record.sessionIdInBundle,
  });
}

/**
 * The `HubPullResult` the select stage's `report` exit produces — the one
 * success that applied nothing (see `SelectReport` in pull-select.ts for why
 * that exit exists at all).
 *
 * A NAMED FUNCTION rather than an object literal at the dispatch site, for one
 * reason: nothing produces the arm until chain assembly lands, so this is the
 * only way the rendering can be exercised, and an unwired exit that has never
 * been rendered is not a shape the result type can express — it is a claim that
 * it can.
 *
 * The result is assembled HERE, in the sequencer, and not handed back by the
 * stage — the same reason the pick list is: `warnings` is the caller's list
 * (the stale-lock steal and the resolve stage's reasons are in it already), and
 * passing it into the stage only to get it back is a detour.
 *
 * `findings` is SPREAD rather than copied field by field, which is the whole
 * point of it being the shared `HubPullFindings`: a disclosure added to the
 * result type arrives here with no edit. It may therefore never carry a key set
 * explicitly below, which is why the spread sits between the two groups.
 */
export function reportPullResult(report: SelectReport, warnings: string[]): HubPullResult {
  return {
    success: true,
    command: "pull",
    threadId: report.threadId,
    sourceMachineId: report.sourceMachineId,
    // Nothing was fetched, so nothing landed, so nothing was mapped: naming a
    // local session here would claim a thread mapping this run did not write.
    importedSessions: [],
    skippedSessions: [],
    localSessionId: null,
    workspaceUnpacked: null,
    ...report.findings,
    nothingToApply: { reason: report.reason },
    warnings,
  };
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
  // Captured ONCE for the whole operation, never per bundle: append.ts treats
  // a base whose mtime is >= this as "written by us, not by a live Claude
  // Code session". A fresh machine pulling a full bundle plus N continuations
  // writes the base itself in this same run, and every one of those N splices
  // has to stay exempt from the liveness guard — a per-bundle timestamp would
  // re-arm the guard against our own writes and scatter the thread across
  // 1 + N fragments.
  const opNowMs = Date.now();
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
    // .sesh-mover under it first, the "project path doesn't exist
    // locally" gate on the workspace flow (step 8) would never fire.
    const resolveStage = await runResolveStage({
      backend,
      projectPath: opts.projectPath,
      hubPath: opts.hubPath,
      projectIdOverride: opts.projectIdOverride,
    });
    // The unlinked escape is the finished result, candidates and all — it
    // carries no reasons, and the warnings collected so far are discarded with
    // it exactly as they were before this was a stage.
    if (resolveStage.kind === "return") return resolveStage.result;
    const { local, hub, hubPeerId, resolved } = resolveStage.value;
    warnings.push(...resolveStage.reasons);

    // Everything below (dedup/sync-state, workspace unpack, session import,
    // and this machine's own index projection) is keyed off the EFFECTIVE
    // project path: --target-path when given, else opts.projectPath. It is
    // also what the select stage keys ITS sync-state reads off, so the pick
    // list and the two "nothing to pull" exits describe the same project the
    // real pull would have applied to.
    const effectiveProjectPath = opts.targetPath ?? opts.projectPath;
    const targetProjectDir = join(opts.configDir, "projects", encodeProjectPath(effectiveProjectPath));

    // Which thread, whose copy of it, and which of that copy's bundles this
    // machine still needs. NOT a pure selector: two of its `stop` results have
    // repaired an absent thread mapping on the way out, so a `success: false`
    // here does not mean the disk is unchanged (see pull-select.ts).
    const sel = await runSelectStage({
      backend,
      resolved,
      machineId: machine.id,
      hubId: hub.hubId,
      threadId: opts.threadId,
      latest: opts.latest,
      effectiveProjectPath,
      targetProjectDir,
    });
    // ORDER IS THE CONTRACT, not a style choice: every `stop` is dispatched
    // BEFORE the stage's warnings are spread. The stage collects the
    // alternate-source sentence and the unfetchable disclosure as it goes, and
    // the results it stops with carry no `warnings` field at all — the old
    // straight-line code discarded that text on exactly these branches, and
    // spreading first would start shipping it.
    if (sel.kind === "stop") return sel.result;
    if (sel.kind === "pick-list") {
      // `warnings` is the caller's (the stale-lock steal and the resolve
      // stage's reasons are already in it), so the list result is assembled
      // here rather than handed into the stage and back.
      return { success: true, command: "pull", pickRequired: true, threads: sel.threads, warnings };
    }
    warnings.push(...sel.warnings);
    // ...and `report` is dispatched AFTER that spread, which is the other half
    // of the same contract: it is the one exit that is `success: true` and
    // applied nothing, its result has a `warnings` field to carry the stage's
    // sentences, and losing them would leave a pull that changed nothing with
    // no account of why. Nothing produces this arm yet — see `SelectReport`.
    if (sel.kind === "report") return reportPullResult(sel.value, warnings);
    // Narrowed on purpose — ids, not the ResolvedThread/ThreadCopy they came
    // from. Nothing below can re-derive the selection from `copies`, the field
    // carrying the iteration-order ban.
    //
    // `sourceMachineId` is the machine this pull RESOLVED to and is spent only
    // on the result's source label; every ledger credit below comes from the
    // per-record `machineId` on `needed` instead (see `SourcedBundle`).
    //
    // `findings` is the same `HubPullFindings` the `report` arm carries, and it
    // is SPREAD into the result below for the same reason: a disclosure added to
    // that interface reaches the pull that applied something and the pull that
    // applied nothing at the same moment, with no edit here.
    const { threadId, sourceMachineId, needed, findings } = sel.value;

    opts.onProgress?.({ phase: "hub-pull", percent: 0 });

    // Every accumulator this pull's per-bundle loop writes, in one MUTABLE
    // object passed by reference. Nothing here may be snapshotted or copied —
    // see pull-apply-state.ts. It is handed the RECORDS alone: all it asks of
    // them is which bundle carries the workspace generation, and who supplied
    // a bundle is a ledger question no accumulator has any business answering.
    const st = initApplyState({ needed: needed.map((n) => n.record) });

    for (const [i, { machineId: bundleMachineId, record }] of needed.entries()) {
      // Download, unpack and read the manifest — and, on the way through,
      // write this bundle's workspace generation and carry into `st`. Both are
      // MUTATIONS rather than returned values on purpose (see pull-fetch.ts):
      // the generation must be in `st.chainWorkspaceBases` before the workspace
      // gate a few lines below reads it, and a returned optional carry invites
      // `?? null` at this call site, which would clear an earlier bundle's carry
      // whenever a later bundle has none.
      const fetched = await runFetchStage({
        backend, record, machineId: bundleMachineId, bundleIndex: i, tempRoot, state: st,
      });
      // The only correct handling of a fetch abort. `break` would fall through
      // to the carry gate, the thread mapping, `writeSyncState` and
      // `writeMachineIndex` and then return `success: true` — a refusal turned
      // into a successful pull. `continue` would violate the chain invariant
      // (bundle N+1 is anchored on N's head) and fragment-import AND record the
      // next bundle, foreclosing the remedy the message names.
      if (fetched.status === "aborted") return fetched.terminal!;
      const { extractDir, manifest: bundleManifest } = fetched.value!;

      // Merge, unpack, or decline the chain's workspace payload. Self-gating:
      // called on every bundle, does its work only on the newest one carrying a
      // generation. It stays INSIDE the loop for two reasons — the generation
      // the fetch above just pushed into `st.chainWorkspaceBases` is read by
      // the ancestor hunt in this same iteration, and an earlier bundle's
      // integrity abort has to be able to stop the pull before it runs.
      const ws = await runApplyWorkspaceStage({
        backend,
        extractDir,
        effectiveProjectPath,
        // GIVEN-ness, not path equality: naming a destination is an explicit
        // "use this one", and the routine skip is only for the destination the
        // user never named.
        targetPathGiven: !!opts.targetPath,
        forceWorkspace: !!opts.forceWorkspace,
        bundleDeclaresWorkspace: i === st.workspaceBundleIndex && !!bundleManifest.workspace,
        chainWorkspaceBases: st.chainWorkspaceBases,
        // This bundle's own machine, like the sessions stage's ledger below:
        // when this stage acts, this IS the machine whose workspace payload is
        // applied, and only its declared bases are legal ancestors.
        machineId: bundleMachineId,
        hubId: hub.hubId,
        record,
        tempRoot,
      });
      // Terminal, never apply-safe. Carrying on past it would import this
      // bundle's sessions and record it, foreclosing the --force-workspace
      // re-run the abort's own message promises.
      if (ws.status === "aborted") return ws.terminal!;
      if (ws.value) {
        st.workspaceUnpacked = ws.value.unpacked;
        st.workspaceMerge = ws.value.merge;
        st.workspaceRefused = ws.value.refused;
        st.workspaceDeclaredMissing = ws.value.declaredMissing;
      }
      // Spread HERE, inside the loop, at the position the moved code occupied:
      // these interleave with the session warnings of the same and earlier
      // bundles, and a stage-major concatenation reorders them (see
      // tests/hub-pull-invariants.test.ts).
      warnings.push(...ws.reasons);

      // Splice onto an existing transcript, adopt the hub's branch over a
      // diverged one, or import this bundle's session as its own. `st` is
      // handed over BY REFERENCE and mutated in place — never snapshotted.
      const ss = await runApplySessionsStage({
        extractDir,
        bundleManifest,
        record,
        bundleIndex: i,
        chainLength: needed.length,
        projectPath: effectiveProjectPath,
        configDir: opts.configDir,
        targetProjectDir,
        claudeVersion: opts.claudeVersion,
        threadId,
        // This bundle's own machine, not the pull's resolved one — the ledger
        // a splice credits has to be the peer that supplied THIS record.
        bundleMachineId,
        hubPeerId,
        noAppend: !!opts.noAppend,
        forceAppend: !!opts.forceAppend,
        onDivergence: opts.onDivergence,
        opNowMs,
        // Three wall-clock reads used to live inside the moved code and are
        // parameters now: a stage file may not read the clock at all (see
        // tests/hub-pull-invariants.test.ts). `ageNowMs` stays SEPARATE from
        // `opNowMs` even though this call passes the same value — one is a
        // boundary ("at or after this was written by us"), the other a duration
        // rendered as "modified 37s ago", and only the second may ever be
        // refreshed. `new Date(opNowMs)` takes an argument, so it is not a
        // clock read.
        ageNowMs: opNowMs,
        historyNowDate: new Date(opNowMs).toISOString().slice(0, 10),
        historyNowMs: opNowMs,
        state: st,
        recordSplice,
        countEntriesAfterOffset,
      });
      // Spread HERE, at the position the moved code occupied and after the
      // workspace stage's reasons: the three in-loop stages are phases of one
      // loop body and their reasons interleave per bundle.
      warnings.push(...ss.reasons);
      // Forwarded VERBATIM, `command: "import"` and all — it is the importer's
      // own diagnosis carrying the importer's own suggestion, and the
      // importer's warnings are dropped with it exactly as before.
      if (ss.control.kind === "fail") return ss.control.result;
      // A REAL break, never a continue. A divergence stops the whole thread,
      // and since the workspace gate is evaluated at the TOP of each iteration
      // this is also what stops a payload on a LATER bundle being applied by a
      // pull the user is about to re-run.
      if (ss.control.kind === "stop-chain") break;
    }

    // Git-diff carry (design §6.2) — after the whole chain, because the newest
    // payload supersedes every earlier one, and after the sessions, because
    // the working tree is the optional half: nothing here may cost the user
    // the transcripts this pull exists to deliver.
    //
    // It cannot collide with the workspace step above: `hub push` writes a
    // workspace payload only when the project has NO git remotes and a carry
    // only when it has one, so a bundle carrying both did not come from a
    // current sesh-mover. If one ever does, the workspace application dirties
    // the tree and the carry declines — the safe order.
    const carrySuppressed = isCarrySuppressed(st);
    if (st.divergenceAborted) {
      const parts: string[] = [];
      if (st.deferredBundles > 0) {
        parts.push(
          `the ${st.deferredBundles} later bundle${st.deferredBundles === 1 ? "" : "s"} in this thread's chain ${st.deferredBundles === 1 ? "was" : "were"} not fetched`
        );
      }
      if (carrySuppressed) {
        parts.push("the uncommitted work that bundle carried was left in it");
      }
      if (parts.length > 0) {
        warnings.push(
          `Because that decision is still open, ${parts.join(" and ")} — nothing from ${parts.length === 1 ? "it" : "them"} was applied, saved or recorded either.` +
            (st.abortIndex > 0
              ? ` The ${st.abortIndex} bundle${st.abortIndex === 1 ? "" : "s"} before it in the chain had already been applied and recorded, so your answer applies from the diverged bundle onward rather than to the whole thread.`
              : " Whichever answer you give next applies to the whole thread rather than half of it.")
        );
      }
    }
    // `applyRequested: false` is NOT a skip — the stage still SAVES the
    // payload beside the project. See the module doc before changing this.
    const carryStage = await runApplyCarryStage({
      targetPath: effectiveProjectPath,
      applyRequested: opts.applyCarry === true,
      apply: st,
    });
    warnings.push(...carryStage.reasons);
    const carryAvailable = carryStage.value?.carryAvailable;
    const carryApplied = carryStage.value?.carryApplied;

    const recorded = await runRecordStage({
      backend,
      configDir: opts.configDir,
      effectiveProjectPath,
      projectId: local.projectId,
      machineId: machine.id,
      hubId: hub.hubId,
      threadId,
      // No `sourceMachineId`: the stage's one use of it was a receipt lookup,
      // which is a question about the peer that supplied the last bundle —
      // carried on `needed` itself now.
      needed,
      apply: st,
    });
    warnings.push(...recorded.reasons);
    const localSessionId = recorded.value?.localSessionId ?? null;

    opts.onProgress?.({ phase: "hub-pull", percent: 100 });
    return {
      success: true,
      command: "pull",
      threadId,
      sourceMachineId,
      importedSessions: st.importedSessions,
      skippedSessions: st.skippedSessions,
      localSessionId,
      workspaceUnpacked: st.workspaceUnpacked,
      workspaceMerge: st.workspaceMerge,
      workspaceRefused: st.workspaceRefused,
      workspaceDeclaredMissing: st.workspaceDeclaredMissing,
      carryAvailable,
      carryApplied,
      appended: st.appended.length > 0 ? st.appended : undefined,
      divergence: st.lastDivergence,
      ...findings,
      // What the chain's imports did to `memory/` and `plans/`, aggregated over
      // every bundle rather than reported per session — those two layers are not
      // session-scoped. SPREAD, like `findings` above, so a field added to
      // `SharedLayerFindings` arrives here with no edit.
      ...sharedLayerFindings(st.sharedLayers),
      warnings,
    };
  } finally {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    lock.release();
  }
}
