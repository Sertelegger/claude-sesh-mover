import type { HubBackend } from "./backend.js";
import { buildIndexFile, readMachineIndex, writeMachineIndex } from "./index-file.js";
import type { SourcedBundle } from "./pull-select.js";
import { stageOk, type StageOutcome } from "./pull-stages.js";
import { discoverSessions } from "../discovery.js";
import { readLastEntryUuid } from "../jsonl.js";
import { readSyncState, setThreadId, writeSyncState } from "../sync-state.js";
import type { ExportManifest, HubPullResult } from "../types.js";

/**
 * Exactly the nine apply-loop accumulators this stage READS — a structural
 * subset of `ApplyState`, so the call site is `apply: st` and this module
 * imports nothing from `pull-apply-state.ts`.
 *
 * Note what is deliberately ABSENT: no workspaceUnpacked/workspaceMerge/
 * workspaceRefused. A workspace application must not count toward
 * `appliedNothing`; not accepting those fields makes that unbreakable here.
 */
export interface RecordApplyView {
  readonly lastAppliedIndex: number;
  readonly divergenceAborted: boolean;
  readonly abortIndex: number;
  readonly lastBundleManifest: ExportManifest | null;
  readonly threadLandedSessionId: string | null;
  readonly skippedByDivergence: boolean;
  readonly importedSessions: readonly HubPullResult["importedSessions"][number][];
  readonly skippedSessions: readonly HubPullResult["skippedSessions"][number][];
  readonly appended: readonly NonNullable<HubPullResult["appended"]>[number][];
}

export interface RecordStageInput {
  backend: HubBackend;
  /** The Claude config dir whose sessions the index projects. */
  configDir: string;
  effectiveProjectPath: string;
  projectId: string;
  machineId: string;
  hubId: string;
  threadId: string;
  /**
   * The fetch plan, each record paired with the machine whose index listed it.
   *
   * NO `sourceMachineId` SCALAR ALONGSIDE IT, deliberately. The one thing this
   * stage did with the pull's resolved machine was look the last bundle up in
   * its receipt ledger, and that is a question about the peer who supplied THAT
   * record — the two are the same string only while a plan cannot span
   * machines. Deleting the field is what stops the wrong one being reached for
   * again; the resolved machine is still on the result, assembled by `pull.ts`.
   */
  needed: SourcedBundle[];
  apply: RecordApplyView;
}

export interface RecordStageResult {
  /** The local session this thread now maps to, or null when none was found. */
  localSessionId: string | null;
  /** Whether the divergence-skip suppression let the index rewrite run. */
  indexWritten: boolean;
}

/**
 * The pull's last stage: map the thread onto a local session, then republish
 * this machine's index over what the project now holds.
 *
 * **The outcome is always `applied`.** A skip or a refusal would carry no
 * value, and `hubPull` needs `localSessionId` unconditionally; both would also
 * demand a reason, while the pure-divergence-skip case deliberately emits none.
 * The gaps this stage can hit are reported as `reasons` on an applied outcome,
 * which is what that status means here (see `pull-stages.ts`).
 *
 * `SyncState` is read, mutated, persisted and projected inside this one body on
 * purpose: `importSession` and `recordSplice` rewrite the file between apply
 * iterations, so a snapshot taken by the caller would be stale, and the object
 * handed to `buildIndexFile` must be the same one `setThreadId` just mutated.
 */
export async function runRecordStage(
  input: RecordStageInput
): Promise<StageOutcome<RecordStageResult>> {
  const {
    backend, configDir, effectiveProjectPath, projectId, machineId,
    hubId, threadId, needed, apply: st,
  } = input;
  const reasons: string[] = [];

  // Thread mapping: prefer the session this pull actually landed content
  // in (an imported fragment or an appended base); if every bundle in the
  // chain was skipped, fall back to (1) the local session id an earlier
  // receipt from this peer was recorded against, then (2) the imported-hash
  // registry — the cross-route duplicate case, where identical content
  // arrived earlier via a plain import (no peer bookkeeping) and the
  // importer skipped it via state.imported[integrityHash] rather than
  // peers[...].received.
  //
  // `lastRecord` is the last bundle this pull actually FETCHED, which stopped
  // being `needed[needed.length - 1]` the moment a divergence could break the
  // loop: after an abort that index names a bundle nobody opened, and looking
  // its `sessionIdInBundle` up in `received` is a question about content this
  // machine never saw. It misses harmlessly today (that key is only ever
  // written by an import that did happen), but it is a landmine if the keying
  // changes — so ask about a bundle that was really handled, and fall back to
  // the diverged one when the abort landed at the head of the chain.
  //
  // ASKED OF `last.machineId`, NEVER OF THE PULL'S RESOLVED MACHINE. The
  // receipt was written by whoever supplied that bundle, so on a chain that
  // spans machines the resolved machine's ledger simply does not hold it: the
  // lookup misses, falls through to the hash registry or to null, and a pull
  // that DID land content reports "its session could not be identified" and
  // writes no thread mapping — which is the interrupted-pull state
  // `backfillThreadMappings` exists to repair, manufactured on a healthy pull.
  const last =
    needed[st.lastAppliedIndex >= 0 ? st.lastAppliedIndex : st.divergenceAborted ? st.abortIndex : needed.length - 1];
  const stateAfter = readSyncState(effectiveProjectPath);
  const lastSessionManifest =
    st.lastBundleManifest?.sessions.find((s) => s.sessionId === last.record.sessionIdInBundle) ?? null;
  const hashRegistryFallback = lastSessionManifest
    ? stateAfter.imported[lastSessionManifest.integrityHash]?.localSessionId
    : undefined;
  const localSessionId: string | null =
    st.threadLandedSessionId ??
    stateAfter.peers[last.machineId]?.received?.[last.record.sessionIdInBundle]?.localSessionId ??
    hashRegistryFallback ??
    null;

  if (localSessionId !== null) {
    setThreadId(stateAfter, hubId, localSessionId, threadId);
    writeSyncState(stateAfter);
  } else if (!st.skippedByDivergence) {
    // Never map a thread to a fabricated id (an empty string would poison
    // the index projection below and every future pull's dedup).
    //
    // Gated on the divergence skip, which lands here by design: nothing was
    // applied, so there is nothing to map, and the skip warning has already
    // said exactly that. "Its session could not be identified" would be a
    // second, contradictory story about a deliberate no-op.
    reasons.push(
      "pulled content already exists locally but its session could not be identified — a future push from this machine will re-map the thread"
    );
  }

  // Rewrite our machine index over current local sessions — pulls never
  // create bundles, so newBundles is always empty here.
  //
  // Unless the run was a pure divergence skip, where "nothing changed" has
  // to include the index. The projection reads the LOCAL session head, so
  // rewriting it here would publish the local branch's head — which no
  // bundle on the hub backs — and make this machine the thread's most
  // recent copy. The re-run the skip warning promises would then be refused
  // outright ("the latest copy of this thread is already local"), turning
  // "decide later" into "decide never".
  //
  // A workspace application deliberately does NOT count here. The index is a
  // projection of SESSIONS — unpacking or merging files into the project
  // directory changes nothing it publishes — so letting it defeat the
  // suppression would republish the local branch's head and foreclose the
  // re-run for a reason unrelated to sessions. Before Slice 2 that pairing
  // needed --force-workspace to reach; now that a routine pull merges a
  // workspace automatically, it would be the common case. The index stays as
  // it was for one pull and the next push/pull (or `hub reindex`) rewrites
  // it — it is a derived file by design.
  //
  // That "does not count" is enforced by the TYPE, not by care: RecordApplyView
  // has no workspace fields to read.
  const appliedNothing =
    st.importedSessions.length === 0 &&
    st.skippedSessions.length === 0 &&
    st.appended.length === 0;
  let indexWritten = false;
  if (!(st.skippedByDivergence && appliedNothing)) {
    // Listed HERE, after the apply loop, so the index publishes the sessions
    // this pull just imported or spliced. A list computed by the caller before
    // the loop publishes a stale head.
    const sessionsNow = discoverSessions(configDir, effectiveProjectPath).map((s) => ({
      sessionId: s.sessionId,
      slug: s.slug,
      summary: s.slug,
      headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
      messageCount: s.messageCount,
      lastActiveAt: s.lastActiveAt,
    }));
    const prior = await readMachineIndex(backend, projectId, machineId);
    await writeMachineIndex(
      backend,
      buildIndexFile({
        projectId,
        machineId,
        projectPath: effectiveProjectPath,
        sessions: sessionsNow,
        state: stateAfter,
        priorIndex: prior,
        newBundles: [],
        now: new Date().toISOString(),
      })
    );
    indexWritten = true;
  }

  return stageOk({ localSessionId, indexWritten }, reasons);
}
