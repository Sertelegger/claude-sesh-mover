import type { SyncState } from "../types.js";
import type { HubBundleRecord, HubIndexJson } from "./layout.js";
import type { SourcedBundle } from "./pull-select.js";
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
/** Why the walk stopped where it did. Four different facts, never merged. */
export type ChainStop = 
/** Nothing anchors on the last record's head: whole, as far as the hub shows. */
"end"
/** That head is `""`, so no successor can ever be matched to it (§4.3). */
 | "empty-head"
/** The next record was already in this chain — a damaged or hostile index. */
 | "cycle"
/** No record could start a chain at all, so there is nothing to walk. */
 | "no-root";
/** How a branch or a root was picked when more than one was available. */
export type ChainChoice = 
/** Only one candidate existed. */
"sole"
/** Exactly one candidate reaches the head this machine's own copy sits at. */
 | "local-base"
/** No local base to go on, so the candidate reaching the most bundles won. */
 | "longest"
/** Even that tied; broken on bundle id ascending — arbitrary, but stable. */
 | "bundle-id"
/** Nothing to choose between: there were no candidates. */
 | "none";
/** A record whose anchor names a head no record in this thread ships. */
export interface ChainGap {
    /**
     * The anchor that matched nothing. `""` is one of them: it can never match,
     * by the empty-head rule, so a record carrying it is stranded exactly as if
     * its predecessor were missing (no writer of ours emits it — see
     * `HubBundleRecord.anchorEntryUuid`).
     */
    anchorEntryUuid: string;
    /** The machine listing the stranded record, and the record itself. */
    machineId: string;
    bundleId: string;
    /**
     * That record plus everything that chains onto it — what this one gap
     * strands. Its length is the "N later bundles unreachable" count.
     */
    strandedBundleIds: string[];
}
/** A branch not taken at a fork, with everything behind it. */
export interface ChainBranch {
    machineId: string;
    bundleId: string;
    /** The branch's first record and every record reachable from it. */
    bundleIds: string[];
}
/** Two or more records claiming to continue one head. */
export interface ChainFork {
    /** The head they share. Never `""` — that is a gap, not a fork. */
    anchorEntryUuid: string;
    /** The branch this plan follows, by its first bundle id. */
    followedBundleId: string;
    /** Why that one. Never `"sole"`/`"none"`: a fork has at least two branches. */
    reason: ChainChoice;
    /** Every branch this plan parked, stated order (bundle id ascending). */
    parked: ChainBranch[];
}
/** A record that starts a chain. Several per thread is ORDINARY — see below. */
export interface ChainRoot {
    machineId: string;
    bundleId: string;
    /**
     * Everything reachable from this root, this record included, bundle id
     * ascending. For a root whose chain forks this covers BOTH branches, so it is
     * "what this starting point could reach", not "what the plan applies".
     */
    bundleIds: string[];
    /** True for the one root `chain` starts at. */
    followed: boolean;
    /**
     * A record carrying no `anchorEntryUuid` key at all: pushed before chain
     * assembly existed. Still a root — `type` is what says so — but nothing can
     * ever be proven to chain onto it, so its chain ends where its head does.
     */
    preAssembly: boolean;
}
/**
 * A CONTINUATION naming no anchor at all, and so unlinkable by construction.
 *
 * Deliberately not a `ChainGap`. "This bundle was pushed before chain assembly
 * existed" and "a bundle is missing" are different sentences, and only one of
 * them describes something that could be repaired by finding it (spec §0b).
 *
 * Deliberately not a root either. A `continuation` is a delta; starting a chain
 * at one hands the plan a transcript that begins mid-conversation, which
 * `tryAppendContinuation`'s chain guard would refuse anyway.
 */
export interface UnanchoredBundle {
    machineId: string;
    bundleId: string;
    /**
     * `true` for the ordinary case — no `anchorEntryUuid` key, i.e. pushed before
     * chain assembly existed. `false` means the index declares an explicit `null`
     * anchor on a `continuation`, which is a contradiction no writer of ours can
     * emit and which is therefore a damaged or hostile index, not old data.
     */
    preAssembly: boolean;
}
/** A machine whose advertised thread head matches no bundle anyone pushed. */
export interface AdvertisedHead {
    machineId: string;
    headEntryUuid: string;
}
export interface AssembleChainInput {
    /** Every machine's copy of ONE thread, exactly as `resolveThreads` built it. */
    copies: ThreadCopy[];
    /**
     * The head of this machine's own copy of the thread, when it holds one — the
     * only input that can decide a fork or pick among roots by something other
     * than size. `""`/`null`/absent all mean "no local base to go on" (the empty
     * head rule applies here too: an empty local head matches nothing).
     */
    localHeadEntryUuid?: string | null;
}
/** An ordered fetch plan for one thread, plus everything it could not reach. */
export interface AssembledChain {
    /**
     * The plan: root first, each record chaining onto the one before it. Ordered
     * by LINKS alone — never by `pushedAt`, which is the pushing machine's wall
     * clock (§4.4.1) — and it may span machines, which is the whole point.
     *
     * Empty only when no record could start a chain (`stoppedBecause: "no-root"`).
     * Everything else about this result describes what is NOT in here.
     */
    chain: SourcedBundle[];
    stoppedBecause: ChainStop;
    /** How the root `chain` starts at was picked out of `roots`. */
    rootChoice: ChainChoice;
    /**
     * Every starting point this thread has, bundle id ascending. More than one is
     * ORDINARY, not an anomaly: `computeIncrementalPlan` re-sends a session whole
     * whenever the recorded head is empty or has gone (compaction, truncation, a
     * rollback), and `push.ts` files that `full` record under the SAME thread id.
     * Each root's chain is its own linked list and the two are never merged.
     */
    roots: ChainRoot[];
    /** Forks met while walking the followed chain, in the order they were met. */
    forks: ChainFork[];
    /** Anchors naming a head nobody ships, bundle id ascending. */
    gaps: ChainGap[];
    /** Pre-assembly continuations, bundle id ascending. */
    unanchored: UnanchoredBundle[];
    /**
     * Machines advertising a thread head no bundle record ships — "M advertises
     * work it has not pushed", which is a machine's local state running ahead of
     * what it uploaded, not a bundle missing from the hub. Tested against EVERY
     * record, not just the followed chain: a head on a parked branch was pushed.
     * A machine advertising `""` advertises nothing and is never listed.
     */
    advertisedUnshipped: AdvertisedHead[];
    /**
     * Every record NOT in `chain`, by bundle id, deduped and ascending — the
     * union of everything the disclosures above name, in one list. Membership is
     * by record, not by id, so a bundle id two machines both list still appears
     * here if either machine's record was not applied.
     */
    unreachableBundleIds: string[];
}
/**
 * Order every bundle every machine lists for one thread into a fetch plan, and
 * name everything that could not be reached (#35, spec §4.3).
 *
 * PURE: no filesystem, no backend, no sync-state, and NO CLOCK. Ordering comes
 * from the link structure alone. `pushedAt` is read nowhere in this function —
 * the hub stamps nothing, so it is the pushing machine's wall clock, and
 * ordering two machines' records by it reinstated a measured silent revert
 * under skew (§4.4.1). The fixtures make `pushedAt` DESCEND in link order so
 * that an implementation which sorts by it fails rather than passing by luck.
 *
 * IT LINKS ON `anchorEntryUuid`, NEVER ON `fromEntryUuid`. Measured: `diff.ts`
 * writes `fromEntryUuid` as `entries[headIndex + 1].uuid`, the first entry the
 * delta SHIPS — the anchor's child, which equals no record's head, ever. A
 * head-keyed map walked over `fromEntryUuid` finds zero links on any real hub;
 * that is the whole of spec §0b and the reason the anchor field exists.
 * `fromEntryUuid` is not read here at all.
 *
 * THE OUTPUT IS A SEPARATE STRUCTURE and stays one (§4.4.2): nothing here
 * writes back into any `ThreadCopy.bundles`, because a machine's stored bundle
 * list being its OWN pushes in push order is what the `basedOn` merge-ancestor
 * walk relies on.
 *
 * WHAT IT DOES NOT DO. It does not know what this machine has already received
 * — `selectNeededBundles` is still the per-record receipt filter and runs over
 * this plan. It does not resolve hub-vs-LOCAL divergence either: that is
 * `hub.onDivergence`, it is per bundle, it is evaluated in the apply stage
 * against a local transcript this function cannot see, and it is not an input
 * here. Branch-vs-branch (below) is a different question with the same shape,
 * which is exactly why the two must not be confused.
 */
export declare function assembleChain(input: AssembleChainInput): AssembledChain;
//# sourceMappingURL=threads.d.ts.map