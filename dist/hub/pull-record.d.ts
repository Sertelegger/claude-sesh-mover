import type { HubBackend } from "./backend.js";
import type { SourcedBundle } from "./pull-select.js";
import { type StageOutcome } from "./pull-stages.js";
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
/** Exactly the three accumulators the mid-loop flush reads. */
export type FlushApplyView = Pick<RecordApplyView, "lastAppliedIndex" | "lastBundleManifest" | "threadLandedSessionId">;
export interface FlushThreadMappingInput {
    effectiveProjectPath: string;
    hubId: string;
    threadId: string;
    /** The same fetch plan `runRecordStage` gets — indexed by `lastAppliedIndex`. */
    needed: SourcedBundle[];
    apply: FlushApplyView;
}
/**
 * Persist the thread mapping for what this pull has applied SO FAR, from inside
 * the per-bundle loop.
 *
 * **Why this exists at all, given `runRecordStage` writes the same mapping.**
 * The receipts — `peers[...].received` from `importSession`, and the hub ledger
 * `recordSentToPeer` credits — are written INSIDE the loop, one bundle at a
 * time. `runRecordStage` runs only after it. Three hard returns in that loop (a
 * fetch abort, a workspace abort, an import failure) leave bundles `0..i-1`
 * applied and credited and never reach the record stage at all, so the mapping
 * they earned was never written. That is not a crash window — #28's filed shape,
 * fixed by `backfillThreadMappings` — it is a deterministic route into the same
 * end state on an ordinary trigger (a bundle only partly delivered to a synced
 * hub folder), and `backfillThreadMappings` cannot repair it: that repair runs
 * only on exits where `needed` is EMPTY, and the deferred bundle was never
 * recorded as received, so the re-run's plan is non-empty and aborts again.
 *
 * WHAT IT COSTS WHEN IT IS MISSING. The next push finds a local session with no
 * thread id and MINTS A NEW THREAD for it (`push.ts`), and because the hub
 * ledger was already credited that push ships only a DELTA — a continuation
 * chain on the hub with no base bundle to anchor it, which is the
 * unreconstructable thread `recordSentToPeer`'s own invariant forbids by name.
 * `hub reindex` does not repair it either: it reads `getThreadId`, finds
 * nothing, and drops the session from the index with a warning. The auto-push is
 * default-on and unattended, so it routinely fires before the user retries.
 *
 * **It may never map a bundle that was not applied**, which is what the
 * `lastAppliedIndex < 0` gate is for and why the gate is on THAT and not on
 * `needed.length`. `lastAppliedIndex` is written by the sessions stage only once
 * a bundle has been spliced, adopted or imported, so `needed[lastAppliedIndex]`
 * is by construction a bundle this pull really handled. `runRecordStage`'s own
 * index expression deliberately falls back to `needed.length - 1` when nothing
 * was applied; reusing that here would ask the receipt ledger about a bundle
 * nobody opened.
 *
 * Idempotent, and quiet when there is nothing to do: it writes at most once per
 * pull per session, and returns without touching the state file when the mapping
 * it would write is already there. `runRecordStage` still writes the mapping at
 * the end of a pull that gets that far — this makes the mapping as durable as
 * the receipt written beside it, it does not replace the projection.
 */
export declare function flushThreadMapping(input: FlushThreadMappingInput): boolean;
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
export declare function runRecordStage(input: RecordStageInput): Promise<StageOutcome<RecordStageResult>>;
//# sourceMappingURL=pull-record.d.ts.map