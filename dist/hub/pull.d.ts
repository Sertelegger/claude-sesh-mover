import { type HubBundleRecord } from "./layout.js";
import type { ErrorResult, HubLockBusyResult, HubPullListResult, HubPullResult, HubUnlinkedResult, NotYetSyncedResult, OnDivergenceMode, ProgressEvent, UnfetchableBundleGroup } from "../types.js";
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
export declare function selectNeededBundles(bundles: HubBundleRecord[], received: Record<string, {
    localSessionId: string;
}> | undefined, localSessionFileExists: (localSessionId: string) => boolean): HubBundleRecord[];
export declare function hubPull(opts: HubPullOptions): Promise<HubPullResult | HubPullListResult | NotYetSyncedResult | HubUnlinkedResult | HubLockBusyResult | ErrorResult>;
//# sourceMappingURL=pull.d.ts.map