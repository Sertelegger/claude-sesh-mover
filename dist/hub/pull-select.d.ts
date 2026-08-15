import type { HubBackend } from "./backend.js";
import type { HubBundleRecord } from "./layout.js";
import { type ResolvedThread } from "./threads.js";
import type { ErrorResult, NotYetSyncedResult, UnfetchableBundleGroup, WhereisThread } from "../types.js";
/**
 * The half of a thread this pull cannot reach, in words.
 *
 * Deliberately names NO remedy: there is no `--from-machine`, `--thread` and
 * `--target-path` resolve to the same single source, and `hub reindex` only
 * rebuilds this machine's index from its own bundles. Saying plainly that a
 * thread split across machines cannot be assembled yet is honest; inventing a
 * flag would put this in the milestone's own foreclosure class — a warning
 * whose stated remedy silently does nothing.
 *
 * Machine names are capped at three so a hub with many machines still
 * produces one readable sentence; the full set is in the typed field.
 *
 * MACHINE NAMES ARE NOT UNIQUE. They come from the hostname, so a VM clone or
 * two default installs on same-named hosts give two machine ids one name — and
 * this sentence names a machine three times in three different roles, which
 * with bare names degenerates to "mbp holds bundles that mbp does not list …
 * the one machine it resolves to (mbp)". Any name shared by two of the roles in
 * THIS sentence therefore carries its machine id.
 */
export declare function describeUnfetchable(threadId: string, groups: UnfetchableBundleGroup[], source: {
    machineId: string;
    machineName: string | null;
}): string;
export interface SelectStageInput {
    backend: HubBackend;
    /** Every machine's view of this project's threads, as `resolve` produced it. */
    resolved: ResolvedThread[];
    /** This machine's id — the "is it already here" side of every comparison. */
    machineId: string;
    /** Keys the thread mapping this stage may repair. */
    hubId: string;
    threadId?: string;
    latest?: boolean;
    /**
     * `--target-path` when given, else the project path. Everything downstream of
     * selection keys its sync-state off this, so the pick list's disclosure
     * describes exactly what pulling that thread would report. The stage reads
     * (and, on the repair path, writes) the state file itself — see the module
     * doc for why a `SyncState` parameter would be wrong.
     */
    effectiveProjectPath: string;
    /** `<configDir>/projects/<encoded effective path>` — where a local session file would be. */
    targetProjectDir: string;
}
export interface SelectStageResult {
    /**
     * NARROWED on purpose: the thread's id and the source machine's id, never the
     * `ResolvedThread`/`ThreadCopy` they came from. Handing back `copies` would
     * let a later stage re-derive the selection from it, and `copies` is the field
     * carrying an iteration-order ban.
     */
    threadId: string;
    sourceMachineId: string;
    needed: HubBundleRecord[];
    /** Read exactly once, at the caller's final `HubPullResult` assembly. */
    unfetchableBundles: UnfetchableBundleGroup[] | undefined;
}
/**
 * `warnings` rides on `proceed` ALONE, and that is the contract, not an
 * oversight: today's code pushes the unfetchable sentence before the
 * "already up to date" gate and the returns there carry no `warnings` field,
 * so the text is discarded. The caller reproduces that by dispatching on
 * `stop` BEFORE spreading `warnings`.
 *
 * `pick-list` carries no warnings for the same reason in reverse — the caller
 * owns the list (it has the lock-steal warning and the resolve stage's reasons
 * in it already), so handing it in only to get it back would be a detour.
 */
export type SelectOutcome = {
    kind: "proceed";
    value: SelectStageResult;
    warnings: string[];
} | {
    kind: "pick-list";
    threads: WhereisThread[];
} | {
    kind: "stop";
    result: ErrorResult | NotYetSyncedResult;
};
export declare function runSelectStage(input: SelectStageInput): Promise<SelectOutcome>;
//# sourceMappingURL=pull-select.d.ts.map