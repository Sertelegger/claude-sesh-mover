import type { SyncState } from "../types.js";
import type { HubBundleRecord, HubIndexJson } from "./layout.js";
export interface ThreadCopy {
    machineId: string;
    localSessionId: string;
    slug: string;
    summary: string;
    headEntryUuid: string;
    messageCount: number;
    lastActiveAt: string;
    bundles: HubBundleRecord[];
}
export interface ResolvedThread {
    threadId: string;
    slug: string;
    summary: string;
    copies: ThreadCopy[];
    latest: ThreadCopy;
}
export declare function newerThreadCopy(a: ThreadCopy, b: ThreadCopy): ThreadCopy;
export declare function resolveThreads(indexes: HubIndexJson[]): ResolvedThread[];
/** One machine's bundles for a thread that a given pull cannot fetch. */
export interface UnfetchableBundleSet {
    machineId: string;
    /** Bundle ids, in the order that machine's index lists them. */
    bundleIds: string[];
}
/**
 * Bundles that OTHER machines list for this thread and that a pull resolving
 * to `sourceMachineId` cannot fetch.
 *
 * WHAT THIS DISCLOSES. A pull fetches exactly ONE machine's bundle list
 * (`sourceCopy.bundles` in hub/pull.ts), and every machine's index lists only
 * the bundles IT pushed — a pull writes its own index with `newBundles: []`.
 * So a thread whose history was written on two other machines arrives on a
 * third in halves: no error, no fork, and — when it resolves to the machine
 * holding the newest half — a local copy that `whereis` then calls `current`.
 * This function is the only signal that says otherwise. Assembling such a
 * chain (a link walk over `fromEntryUuid`/`headEntryUuid`) is a later slice;
 * there is no flag for it today, so callers must not name one.
 *
 * IT IS A DIAGNOSTIC, NOT AN ORDERING, and deliberately stays away from the
 * two things this milestone has already been burned by:
 * - it reads NO timestamp. `pushedAt` is the PUSHING machine's wall clock and
 *   the hub stamps nothing; ordering two machines' records by it reinstated a
 *   silent data revert verbatim under a 1h skew (Task 8).
 * - it never merges another machine's bundle records into the source's list.
 *   That list being one machine's own pushes, in push order, is what Task 8's
 *   `basedOn` chain walk relies on.
 * Nothing it returns changes what is fetched, applied, recorded or ordered.
 *
 * SILENCE ON THE ORDINARY FLOW IS THE LOAD-BEARING PROPERTY — a warning that
 * fires on every pull trains users to ignore it. Two structural exclusions buy
 * most of it: the source's copy and this machine's copy are both skipped, so
 * with only two machines in play the candidate set is EMPTY before any content
 * test runs, and a third machine that has pulled the thread but never pushed
 * contributes an empty bundle list. What remains is filtered against this
 * machine's peer bookkeeping (`state.peers[...]`, the same records
 * `selectNeededBundles` dedups on):
 * - the position of the newest record whose `headEntryUuid` is the head we
 *   recorded holding from that machine says how far along its own list we
 *   already got; everything at or before it is accounted for.
 * - when no recorded head matches any of its records (a "" head, a session
 *   that arrived some other way), it falls back to "we received something from
 *   that machine for that session" — coarse, and coarse in the SILENT
 *   direction on purpose.
 */
export declare function findUnfetchableBundles(args: {
    copies: ThreadCopy[];
    sourceMachineId: string;
    localMachineId: string;
    state: SyncState;
}): UnfetchableBundleSet[];
//# sourceMappingURL=threads.d.ts.map