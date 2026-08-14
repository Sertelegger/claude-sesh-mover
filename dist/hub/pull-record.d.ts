import type { HubBackend } from "./backend.js";
import type { HubBundleRecord } from "./layout.js";
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
    sourceMachineId: string;
    needed: HubBundleRecord[];
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
export declare function runRecordStage(input: RecordStageInput): Promise<StageOutcome<RecordStageResult>>;
//# sourceMappingURL=pull-record.d.ts.map