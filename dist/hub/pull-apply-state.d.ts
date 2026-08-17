import type { HubBundleRecord } from "./layout.js";
import type { WorkspaceMergeReport } from "./merge.js";
import type { CarryMeta } from "./carry.js";
import type { AuxiliaryConflict, ExportManifest, HubPullDivergence, HubPullResult, MemoryConflict, SharedLayerFindings } from "../types.js";
/**
 * The `memory/` and `plans/` outcomes of a whole pull, accumulated across the
 * bundle chain.
 *
 * **Why aggregated and not per-session.** A pull applies a CHAIN of bundles,
 * each through its own `importSession` call, and every one of them reconciles
 * into the SAME two directories — the project's `memory/` and the config dir's
 * `plans/`. Those layers are not session-scoped at all, so "one report per
 * imported session" is a category error: there is no session for a memory file
 * to belong to. Reporting only the last bundle's report is the failure this
 * exists to prevent — a five-bundle pull that parks a memory file per bundle
 * must hand the skill layer five parked paths, not one.
 *
 * Dedup is by VALUE, because the same payload arriving twice is one outcome:
 * the importer already reuses a byte-identical parked copy rather than planting
 * `.incoming-2.md`, so five bundles carrying an unchanged memory produce five
 * identical `MemoryConflict` records for one file on disk, and offering the user
 * the same merge five times is the degradation the reuse rule exists to avoid.
 * A genuinely different incoming version has a different `incomingHash` and a
 * different `parkedAs`, so it survives dedup and is reported separately.
 */
export interface SharedLayerAccumulator {
    readonly memoryConflicts: MemoryConflict[];
    readonly planConflicts: AuxiliaryConflict[];
    /** Index targets appended by any bundle in the chain, deduped, in order. */
    readonly addedIndexEntries: string[];
    /** Union of every bundle's `unindexed`; corrected at projection time. */
    readonly unindexed: string[];
    /**
     * Summed across bundles, which is the literal meaning of the field (incoming
     * pointers deduped away) rather than a count of distinct entries — the report
     * carries counts, not targets, so distinct ones cannot be recovered. A chain
     * re-shipping one unchanged index therefore counts its entries once per
     * bundle; it is a parenthetical in the skill layer's sentence, and over-stating
     * it is the harmless direction.
     */
    alreadyPresent: number;
    droppedProse: boolean;
    /** True once any bundle carried a `memory/` layer at all. */
    sawMemoryLayer: boolean;
    /**
     * Identical for every bundle of a pull — it is derived from the target project
     * path and config dir, not from the bundle — so last-wins and any-wins are the
     * same value. Kept as a field rather than recomputed so there is still exactly
     * one place it comes from.
     */
    memoryDir: string | undefined;
}
/** Fold one bundle's import result into the pull-wide accumulator. */
export declare function recordSharedLayers(acc: SharedLayerAccumulator, found: SharedLayerFindings): void;
/**
 * Project the accumulator onto the shape the result carries. SPREAD into
 * `HubPullResult` at the one assembly site, never copied field by field, for the
 * same reason `HubPullFindings` is: a field added to `SharedLayerFindings`
 * reaches the pull with no edit here, which is the defect class (#59 item 3, and
 * #49 before it) this whole path exists to close.
 */
export declare function sharedLayerFindings(acc: SharedLayerAccumulator): SharedLayerFindings;
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
    /**
     * The `memory/`/`plans/` outcomes of every bundle in the chain, folded
     * together — see `SharedLayerAccumulator` for why this is pull-wide rather
     * than per session. `readonly` for the same reason its siblings are: mutated
     * in place, never reassigned.
     */
    readonly sharedLayers: SharedLayerAccumulator;
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