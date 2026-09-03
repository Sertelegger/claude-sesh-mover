/**
 * # `hub compact` — consolidate a thread, retire the chain behind it (#92)
 *
 * A thread that has been pushed from two machines for a month is a root bundle
 * plus a long tail of continuations, every one of which has to be fetched and
 * applied in order for a fresh machine to read the conversation. This verb
 * replaces that tail with a single full bundle and then removes the tail.
 *
 * ---------------------------------------------------------------------------
 * ## Consolidation is not a fourth implementation, and that is the point
 *
 * "Produce a fresh full bundle for these sessions and push it" already exists,
 * in exactly one place, with four callers waiting for it: `push --full`,
 * key-loss recovery, and the four fallbacks in `diff.ts` that degrade an
 * incremental push to a whole one. This verb becomes the next CALLER of that,
 * not a second copy — it invokes `hubPush({ sessionIds, full: true })` and adds
 * nothing to the push path. Encryption, the upload seam, the workspace
 * artifact, `.age` naming and the un-keyed refusal all come along for free
 * because none of them ever knew about `full` in the first place.
 *
 * ## Two phases, deliberately across invocations
 *
 * The wait between them is measured in days, so it cannot be a wait *inside*
 * one run: the same-machine lock is stolen from a live holder at 60 minutes,
 * and the victim is not told. So each run takes the lock, does the phase it
 * can, and releases.
 *
 * 1. **Consolidate.** Push a full bundle. Nothing is deleted, nothing is even
 *    promised. If the run dies here the hub holds an unreferenced orphan, which
 *    is the shape `push` already discloses and the larger state.
 * 2. **Retire**, on a later run, once every machine has acknowledged AND the
 *    consolidated bundle has sat for `COMPACTION_GRACE_MS`. Write the marker,
 *    remove our own index records, then delete the files.
 *
 * A run that finds phase 1 already done goes straight to phase 2, so the verb
 * is idempotent and re-runnable — the same property `rekey` has, for the same
 * reason: the interesting failures are partial ones.
 *
 * ## The ordering is the failure contract
 *
 * New bytes before any reference to them; references removed before the bytes
 * they point at. Every interruption therefore leaves the LARGER state, which is
 * #92's criterion verbatim:
 *
 *   upload consolidated bundle → add its record (old records still live)
 *   → [days] → write marker → remove old records → delete old files
 *
 * The marker goes first among the removals because it is the bookkeeping that
 * makes an interrupted run finishable, exactly as `orderForDeletion` puts
 * tombstones last for the mirror-image reason. It is not deleted at the end:
 * unlike a tombstone it has a second job that outlives the operation, telling
 * other machines' readers why a file they still reference is gone.
 *
 * ## What this verb cannot do, stated rather than discovered
 *
 * - **It retires only THIS machine's bundles** (owner ruling). A chain can span
 *   machines and bundle files live in per-machine directories, so retiring all
 *   of it would mean deleting another machine's files — which per-machine
 *   ownership forbids for everything except `hub delete`'s owner-only,
 *   two-phase, whole-project path. Each machine reclaims its own share. The
 *   result says so rather than reporting a partial job as a complete one.
 * - **It cannot stop a pull that is already in flight.** Nothing can; the
 *   alternative is aborting a half-applied transcript splice. A reader that
 *   loses a file mid-chain fails loudly, typed, with earlier bundles already
 *   applied and recorded, and its retry lands on the consolidated bundle. That
 *   is the failure budget `COMPACTION_GRACE_MS` is sized against.
 * - **It trusts what other machines published**, exactly as everything else on
 *   this hub does. Acknowledgement is a self-report. #86 is the answer to that,
 *   for all of it at once.
 */
import { type HubBackend } from "./backend.js";
import { type HubBundleRecord, type HubCompactionEntry, type HubIndexJson } from "./layout.js";
import { COMPACTION_GRACE_MS } from "./compact-plan.js";
import type { ErrorResult, HubCompactPendingResult, HubCompactResult, HubCompactRefusedResult, HubLockBusyResult, HubUnreachableResult, SyncState } from "../types.js";
/** The local session ids this machine has mapped to a thread. */
export declare function localSessionsForThread(state: SyncState, threadId: string): string[];
/**
 * The consolidated bundle for a thread: the NEWEST full record this machine
 * lists for it.
 *
 * Newest by position rather than by `pushedAt`, deliberately. `pushedAt` is the
 * pushing machine's wall clock and is a diagnostic only — ordering hub state by
 * it reinstates a measured silent-revert bug under clock skew. Index order is
 * append order, written by this machine, and this is this machine's own index.
 */
export declare function findConsolidated(records: readonly HubBundleRecord[]): HubBundleRecord | null;
/**
 * Drop marker entries no index anywhere still references.
 *
 * The marker exists to answer a reader holding a stale record. Once no machine
 * lists any of a retired bundle's ids, that entry has no reader left and is
 * pure growth. Pruned here rather than on a timer, because "is anyone still
 * pointing at this" is exactly the question the indexes answer and a clock is
 * not.
 */
export declare function pruneCompactions(compactions: readonly HubCompactionEntry[], indexes: readonly HubIndexJson[]): HubCompactionEntry[];
export interface HubCompactOptions {
    configDir: string;
    projectPath: string;
    hubPath: string;
    /** Which thread to compact. Required — see `cli.ts` for the listing mode. */
    threadId: string;
    claudeVersion: string;
    /** Test seam. Real runs leave it unset and take the wall clock. */
    nowMs?: number;
}
export { COMPACTION_GRACE_MS };
export type HubCompactOutcome = HubCompactResult | HubCompactPendingResult | HubCompactRefusedResult | HubLockBusyResult | HubUnreachableResult | ErrorResult;
/**
 * The verb.
 *
 * Preflight order is `hub rekey`'s, and for its reasons: the local link first
 * (a read of the user's own project, whose answer cannot be wrong because the
 * hub is unmounted), then reachability BEFORE the lock — so a wedged concurrent
 * operation cannot turn "unmounted share" into "lock busy".
 *
 * The lock is taken only for the RETIRE half. Phase 1 delegates to `hubPush`,
 * which takes it itself; taking it here as well would deadlock against our own
 * push, and holding it across the days-long wait between phases would lose it
 * to the 60-minute live-holder ceiling anyway — silently, since the thief does
 * not tell the victim.
 */
export declare function hubCompact(opts: HubCompactOptions): Promise<HubCompactOutcome>;
/**
 * Every machine's compaction assertions for a project.
 *
 * IMMEDIATE `.json` children only, the same #28 rule `readAllIndexes` applies
 * to `index/` and for the same measured reason: `backend.list` recurses, the
 * hub is a synced directory by design, and sync clients park superseded copies
 * in nested folders (`.stversions/`, "conflicted copy" directories). Recursing
 * would read one machine's stale backup as a second machine's assertion.
 *
 * Never throws and never refuses. A marker that cannot be read simply does not
 * explain anything, which returns the caller to the answer it would have given
 * without this — a worse message, not a wrong action.
 */
export declare function readAllCompactions(backend: HubBackend, projectId: string): Promise<HubCompactionEntry[]>;
/**
 * Which of these bundle ids a compaction retired, and what replaced each.
 *
 * The reason this exists: without it, a bundle deliberately retired by another
 * machine is indistinguishable from one that has not finished syncing, and the
 * reader tells the user to "retry in a moment" — from the one result class that
 * exists to mean a retry will work.
 *
 * A retry DOES work here, which is why this refines the message rather than the
 * class: the file is missing because that machine's index and its files reached
 * this one out of order, and the next attempt reads the updated index and
 * fetches the consolidated bundle instead. What was wrong was the cause, never
 * the remedy.
 */
export declare function explainRetiredBundles(backend: HubBackend, projectId: string, bundleIds: readonly string[]): Promise<Map<string, string>>;
//# sourceMappingURL=compact.d.ts.map