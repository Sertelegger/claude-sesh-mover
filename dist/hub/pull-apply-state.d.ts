import type { HubBundleRecord } from "./layout.js";
import type { WorkspaceMergeReport } from "./merge.js";
import type { CarryMeta } from "./carry.js";
import type { ExportManifest, HubPullDivergence, HubPullResult } from "../types.js";
/**
 * The newest carry payload seen in a chain, and where it came from.
 *
 * `bundleIndex` is load-bearing rather than bookkeeping — see the carry gate
 * in `pull.ts`, which distinguishes a payload out of a bundle this pull already
 * recorded from one out of a bundle a divergence abort deferred.
 */
export interface PulledCarry {
    dir: string;
    meta: CarryMeta;
    bundleFile: string;
    bundleIndex: number;
}
export interface InitApplyStateInput {
    /**
     * The chain of bundles this pull will walk, in order — only read here to
     * locate the workspace-carrying bundle. Nothing in the state keeps a
     * reference to it.
     */
    needed: readonly HubBundleRecord[];
}
/**
 * Everything `hubPull`'s per-bundle loop accumulates, in one object.
 *
 * **This object is mutable and is passed by reference on purpose.**
 * `threadLandedSessionId` and `ourWritesFrom` are read in iteration *n* from
 * writes made in iterations `< n`, and `describeApplied` closes over the live
 * `appended` / `importedSessions` / `skippedSessions` containers. Anything that
 * snapshots or copies this state at loop entry changes behavior invisibly: the
 * closures would report an empty pull in exactly the warnings that exist to say
 * what was already applied.
 *
 * The container fields are `readonly` for that reason — they may be mutated in
 * place (push/set), never reassigned, or the closures stop observing them.
 */
export interface ApplyState {
    workspaceUnpacked: HubPullResult["workspaceUnpacked"];
    workspaceMerge: WorkspaceMergeReport | undefined;
    workspaceRefused: string[] | undefined;
    /**
     * Set when a manifest declares a workspace payload the bundle does not
     * contain. A FIELD, not just the warning — see the declaration comment in
     * `initApplyState`.
     */
    workspaceDeclaredMissing: boolean | undefined;
    /** Which bundle in this chain carries the workspace generation to apply. */
    readonly workspaceBundleIndex: number;
    readonly chainWorkspaceBases: Array<string | null>;
    readonly importedSessions: HubPullResult["importedSessions"];
    readonly skippedSessions: HubPullResult["skippedSessions"];
    readonly appended: NonNullable<HubPullResult["appended"]>;
    lastImportedNewId: string | null;
    lastBundleManifest: ExportManifest | null;
    threadLandedSessionId: string | null;
    lastDivergence: HubPullDivergence | undefined;
    skippedByDivergence: boolean;
    divergenceAborted: boolean;
    deferredBundles: number;
    abortIndex: number;
    readonly ourWritesFrom: Map<string, number>;
    lastCarry: PulledCarry | null;
    lastAppliedIndex: number;
    /** See the doc comment on the closure in `initApplyState`. */
    describeApplied(upTo: number): string;
    /** Earliest wins: our writes to a transcript start at the first of them. */
    rememberOurWrite(path: string, from: number): void;
}
/**
 * An undecided divergence stopped the chain, so a payload out of a bundle
 * the user is about to pull AGAIN stops with it: applying or saving it now
 * would leave a second copy of the same working tree beside the one the
 * re-run delivers, and "nothing was applied" has to mean the whole bundle.
 *
 * That rationale reaches exactly as far as re-runnability, and no further.
 * `lastCarry` is chosen from the newest carrying bundle anywhere in
 * `0..abortIndex`, while the abort only defers `abortIndex` onward — so a
 * payload from an earlier bundle belongs to one this pull already recorded.
 * Suppressing that one deleted the only reachable copy of another machine's
 * uncommitted work (`selectNeededBundles` drops the bundle on the re-run;
 * the archive is left on the hub, extractable only by hand) while the
 * warning claimed it had been left in its bundle for next time. Gate on
 * WHERE the payload came from, not on whether an abort happened.
 *
 * ONE computation site, deliberately: the carry stage decides whether to apply
 * on this predicate and the sessions disclosure decides whether to SAY the
 * payload was left behind on it. Two copies is how those two answer
 * differently, which is the shape the data loss above took.
 */
export declare function isCarrySuppressed(st: Pick<ApplyState, "divergenceAborted" | "lastCarry" | "abortIndex">): boolean;
/**
 * Build the per-pull apply state. Called once, immediately before the
 * per-bundle loop; every accumulator starts here at its "nothing has happened
 * yet" value.
 */
export declare function initApplyState(input: InitApplyStateInput): ApplyState;
//# sourceMappingURL=pull-apply-state.d.ts.map