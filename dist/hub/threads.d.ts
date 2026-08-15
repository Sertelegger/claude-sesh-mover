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
export declare function selectNeededBundles(bundles: HubBundleRecord[], received: Record<string, {
    localSessionId: string;
}> | undefined, localSessionFileExists: (localSessionId: string) => boolean): HubBundleRecord[];
/**
 * A copy OTHER than this machine's that still lists bundles this machine
 * has never received — the answer to "the newest head is mine, so is there
 * anything left on the hub for me?", which is NOT the same question.
 *
 * The two come apart on the ordinary divergence flow, and the default-on
 * auto-push makes it routine. `/sesh-mover:pull` probes with
 * `--on-divergence skip` and re-runs with the user's answer; between the
 * two, one SessionEnd hook publishes this machine's own diverged branch,
 * which is more recently active than the hub's side. `target.latest` is
 * then local, and refusing outright ("the latest copy of this thread is
 * already local", or a bare "nothing to pull") drops the answer the user
 * just gave for a bundle that is still sitting on the hub, unreceived.
 *
 * Deliberately narrow, and #44 did NOT widen it: `pullSourceFor` delegates the
 * whole local-machine case here rather than re-gating it, so this stays the
 * only widening of "one machine's bundle list". It only ever fires when
 * `t.latest` is THIS machine, so it cannot change which copy an ordinary pull
 * resolves to, and it never merges two machines' bundle records into one list
 * (ledger: that linearity is what Task 8's `basedOn` chain walk rests on).
 * Assembling a thread whose history is split across two OTHER machines is still
 * a later slice — `findUnfetchableBundles` remains the disclosure for that.
 *
 * `newerThreadCopy` for the preference so the choice is a strict total order over the
 * candidate set rather than index-file iteration order.
 */
export declare function alternateSource(t: ResolvedThread, st: SyncState, ctx: {
    machineId: string;
    targetProjectDir: string;
}): ThreadCopy | undefined;
/**
 * The copy a pull of this thread would fetch from, or `undefined` when a pull
 * would fetch nothing — the ONE question every selector asks (#44).
 *
 * `--latest` used to ask a different one: head equality against the resolved
 * latest copy. The two answer differently whenever a thread is head-current
 * with the machine it resolves to while that machine still lists a bundle this
 * machine never received, and there `--latest` said "all threads are current"
 * for a thread `--thread <id>` fetched from the same hub state. Receipts are
 * the honest half of that pair: a head can arrive by a route that recorded no
 * bundle, and `selectNeededBundles` already trusts a receipt only while the
 * local file it points at still exists.
 *
 * THE LOCAL-MACHINE BRANCH IS LOAD-BEARING, not tidiness. Re-gating
 * unconditionally would run `selectNeededBundles` over THIS machine's own
 * bundle list, where a missing receipt is ordinary — a `--target-path` pull
 * keys its bookkeeping off the other path, and a corrupt state file is renamed
 * aside and starts empty — so `--latest` would start re-fetching this
 * machine's own pushes. `alternateSource` is the answer for that case and
 * already excludes our own copy by construction.
 *
 * Scope, said plainly: this closes the SAME-MACHINE half only.
 * `selectNeededBundles` still reads exactly one machine's bundle list, so a
 * thread whose remaining bundles are listed by a machine this pull does not
 * resolve to still comes back `undefined` here (#35). `findUnfetchableBundles`
 * remains the disclosure for that.
 */
export declare function pullSourceFor(t: ResolvedThread, st: SyncState, ctx: {
    machineId: string;
    targetProjectDir: string;
}): ThreadCopy | undefined;
//# sourceMappingURL=threads.d.ts.map