import type { ErrorResult, HubLockBusyResult, HubPullListResult, HubPullResult, HubUnlinkedResult, NotYetSyncedResult, OnDivergenceMode, ProgressEvent } from "../types.js";
export interface HubPullOptions {
    configDir: string;
    projectPath: string;
    hubPath: string;
    threadId?: string;
    latest?: boolean;
    targetPath?: string;
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
export { selectNeededBundles, describeUnfetchable } from "./pull-select.js";
export declare function hubPull(opts: HubPullOptions): Promise<HubPullResult | HubPullListResult | NotYetSyncedResult | HubUnlinkedResult | HubLockBusyResult | ErrorResult>;
//# sourceMappingURL=pull.d.ts.map