import { type SelectReport } from "./pull-select.js";
import type { ErrorResult, HubLockBusyResult, HubNoSuchProjectResult, HubPullListResult, HubPullResult, HubUnlinkedResult, HubUnreachableResult, NotYetSyncedResult, OnDivergenceMode, ProgressEvent } from "../types.js";
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
export { describeUnfetchable } from "./pull-select.js";
export { selectNeededBundles } from "./threads.js";
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
export declare function reportPullResult(report: SelectReport, warnings: string[]): HubPullResult;
/**
 * Everything `hubPull` can answer with, named rather than spelled out inline on
 * the signature.
 *
 * A library consumer needs a name to write one handler for the verb —
 * `src/index.ts` re-exports this module, and `HubPushOutcome` is its sibling —
 * and #75 added two more arms (`hub-unreachable`, `no-such-project`), which is
 * exactly the kind of growth an inline union spreads across a signature.
 *
 * Stated plainly because the ratchet below measures from `hubPull`'s
 * declaration: moving eight lines of union out of the signature takes eight
 * lines off that measurement without moving any logic. The change is worth
 * making on its own, but it is not a shrinking of the body, and the margin it
 * reports is eight lines more generous than the body's own history.
 */
export type HubPullOutcome = HubPullResult | HubPullListResult | NotYetSyncedResult | HubUnlinkedResult | HubNoSuchProjectResult | HubUnreachableResult | HubLockBusyResult | ErrorResult;
/**
 * Sequencing over the eight pull stages. What is worth knowing before reading
 * the body is in `tests/hub-pull-invariants.test.ts`'s "hubPull is sequencing"
 * block; this note is only about `onProgress`, whose contract is invisible from
 * any single call site (#74).
 *
 * **`{percent: 0}` is emitted as the first statement inside the `try`, and
 * `{percent: 100}` from the `finally`.** That pairing is the whole point:
 * before it, three exits emitted `0` and never `100` — a fetch abort, a
 * workspace abort and an import failure — so a consumer waiting for the
 * terminal event waited forever. The close therefore also fires on a typed
 * refusal, on a mid-chain abort and on a thrown exception, and `percent: 100`
 * accordingly means *"the operation is over"*, never *"it succeeded"*; the
 * returned result says which. It is wrapped in a `try`/`catch` because a
 * `finally` is exactly where a caller's throwing callback would replace the
 * real failure.
 *
 * **The exits BEFORE the lock emit nothing at all, and that is the contract
 * rather than an oversight** (stated on `ProgressEvent` too, where a consumer
 * will look): `lock-busy` — and a non-busy throw out of `acquireProjectLock` —
 * return above the `try`, so there is no `finally` to close a pair they never
 * opened. A consumer gets either no events or a matched pair. The opening event
 * moved here from just after thread selection for the same reason: it used to
 * mean every early exit (already up to date, nothing to pull, pick-required —
 * the *common* outcomes) emitted zero events while the uncommon ones emitted an
 * unclosed `0`, which is precisely backwards.
 *
 * Between the two, granularity comes from the stages: `runFetchStage` emits one
 * `hub-pull` percent per bundle, and `runApplySessionsStage` forwards this
 * callback into `importSession`, whose `import-verify` and byte-level
 * `import-rewrite` events are the per-session detail. The tar step is the one
 * hole — see `runFetchStage`.
 */
export declare function hubPull(opts: HubPullOptions): Promise<HubPullOutcome>;
//# sourceMappingURL=pull.d.ts.map