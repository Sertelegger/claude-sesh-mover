/**
 * # `hub compact` — the pure decisions (#92)
 *
 * Two questions, both answered here so they can be tested without a hub, a
 * transcript or a 100 MB upload, and both stated in terms of what they CANNOT
 * prove:
 *
 * 1. **Has every machine acknowledged the consolidated bundle?** (`planAck`)
 * 2. **Which of this machine's old bundles does the consolidated bundle
 *    provably replace?** (`planRetirement`)
 *
 * They are deliberately separate. The first is a fact about OTHER machines and
 * is a census — never a filtered list — for the same reason
 * `collectHubRecipients` is: a machine dropped from the answer is
 * indistinguishable at the call site from a machine that does not exist, and
 * here that mistake deletes data. The second is a fact about OUR OWN files and
 * about the transcript we just exported, and it holds no opinion about any
 * other machine.
 *
 * ## The issue's acceptance criterion could not be implemented as written
 *
 * #92 says the chain is retired "only when every participating machine's index
 * shows the consolidated bundle". That is not computable. **A pull never adds a
 * bundle record to the puller's index** — `pull-record.ts` passes
 * `newBundles: []` and says so — so a machine that only ever pulls this thread
 * will never list any bundle id at all, let alone this one. Waiting for it
 * would wait forever.
 *
 * What a puller DOES publish is its own `headEntryUuid`, written from its local
 * transcript after the pull applied (`pull-record.ts`), and — once it pushes
 * again — a record whose `anchorEntryUuid` is the head it held at last sync.
 * Both are self-reports, at exactly the trust level of everything else on the
 * hub (#86 is the eventual answer to that, for all of it at once). So
 * acknowledgement is evidence of CONTENT, not of a file name:
 *
 *     AckHeads = { H } closed under: a surviving record r whose anchor is in
 *                AckHeads contributes its own head
 *
 * where `H` is the consolidated bundle's head. A machine acknowledges if the
 * head it advertises is in that set, or if it has pushed a record anchored in
 * that set. Both say the same thing in the end: *the content behind H is on
 * that machine already*, so nothing behind H is still owed to it.
 *
 * ## Three things this deliberately does not do
 *
 * - **It never treats `messageCount` as evidence.** It is a line count that
 *   legitimately differs between two machines holding the same conversation,
 *   and two different transcripts can share one. `resolveThreads` uses it as a
 *   tiebreak and that is all it is good for.
 * - **It never infers coverage from the chain's shape.** A record is retired
 *   only if the consolidated transcript demonstrably CONTAINS its head — see
 *   `planRetirement`. Link structure says what chains onto what, not what
 *   contains what, and a parked fork chains perfectly while holding entries no
 *   full export of the surviving branch will ever have.
 * - **It never answers for a machine it cannot see.** A machine with an
 *   interrupted pull holds content and has published nothing, because the index
 *   write is a pull's LAST stage. It reads here as "never participated", which
 *   is the one place this predicate is confidently wrong. Nothing computable
 *   from the hub fixes that, which is why the caller also waits out a window —
 *   see `COMPACTION_GRACE_MS`.
 */
import type { HubBundleRecord, HubIndexJson } from "./layout.js";
/**
 * How long a consolidated bundle must have been on the hub before this machine
 * will delete anything behind it.
 *
 * **This is not `RETIREMENT_GRACE_MS` and must not be set from it.** That one is
 * 48 hours because it waits for an ASSERTION to propagate to a machine that may
 * be switched off until Monday — a tombstone nobody has seen stops nobody.
 * Acknowledgement replaces that entirely: an index entry is proof of receipt,
 * not a hope of it, so there is nothing to wait for on that axis and importing
 * 48 hours would be waiting for a thing already known.
 *
 * What is left is the axis acknowledgement cannot reach, and it is much
 * shorter: a pull that is IN FLIGHT right now. Nothing can interrupt one and
 * nothing should — the alternative is aborting a half-applied transcript splice
 * — and the same fact holds here as in `tombstone.ts`: a machine that is
 * switched off cannot have a pull in flight, so the population this window
 * protects is exactly the population that is awake. Sized against how long a
 * pull takes plus how long an index takes to sync, both hours at worst on the
 * shares this plugin exists to serve.
 *
 * The failure directions are asymmetric in the usual way. Too long costs one
 * user one wait, once, on an explicit maintenance verb that already spans days
 * waiting for acknowledgement. Too short deletes a chain out from under a pull
 * that is mid-walk — and worse, out from under the machine whose interrupted
 * pull left it invisible to `planAck` entirely. When in doubt, longer.
 */
export declare const COMPACTION_GRACE_MS: number;
/** Why a machine is not counted as having acknowledged. */
export type OutstandingReason = 
/** It advertises a head, and that head is not behind the consolidation. */
"behind"
/**
 * It advertises no usable head at all (`""`). `readLastEntryUuid(...) ?? ""`
 * is how both index writers spell "the bounded tail scan found no
 * conversation entry", so this is a real and reachable state rather than a
 * corrupt one. It can never acknowledge by the head test and — until it
 * pushes an anchored record — never by the anchor test either, so it holds
 * compaction open indefinitely. Named separately because the remedy is
 * different: one more push or pull from that machine clears it, where
 * `behind` clears itself by pulling.
 */
 | "unknown-head"
/**
 * It lists records for this thread but none of them carries an
 * `anchorEntryUuid` at all — an index written before chain assembly existed.
 * Such a machine cannot acknowledge by the anchor test no matter what it
 * holds, so an upgrade (or one pull, which republishes its head) is the way
 * out. Distinguished from `behind` because "pull to catch up" is not the
 * advice; it may be perfectly up to date.
 */
 | "no-anchor";
export interface OutstandingMachine {
    machineId: string;
    reason: OutstandingReason;
    /** The head it advertises, for the disclosure. `""` when it has none. */
    advertisedHead: string;
}
export interface AckPlan {
    /**
     * Every head the consolidated bundle demonstrably covers, including its own.
     * Exposed because it is the whole of the reasoning and a caller that reports
     * "outstanding" without being able to show its working is asking a user to
     * trust an irreversible deletion on faith.
     */
    ackHeads: string[];
    /** Machines that have acknowledged. Includes this one, tautologically. */
    acknowledged: string[];
    /** Machines that have not. Compaction refuses while this is non-empty. */
    outstanding: OutstandingMachine[];
}
export interface AckPlanInput {
    /** Every machine's index for this project, including this machine's own. */
    indexes: HubIndexJson[];
    threadId: string;
    /** The compacting machine. It acknowledges by construction. */
    machineId: string;
    /**
     * The consolidated bundle's head. Must be a real link uuid — the caller
     * refuses to compact at all otherwise, because nothing can ever chain onto or
     * acknowledge an empty head and the wait would never end.
     */
    consolidatedHead: string;
    /**
     * Bundle ids this run intends to retire. They are excluded from the AckHeads
     * walk: a head reachable only THROUGH a record that is about to be deleted is
     * not evidence that anyone still holds it after the deletion.
     */
    retiringBundleIds: readonly string[];
}
/**
 * Which machines still need what is behind the consolidated bundle.
 *
 * Pure. Reads only what other machines published on the hub, and treats every
 * one of those as the self-report it is.
 */
export declare function planAck(input: AckPlanInput): AckPlan;
/** A record kept back, and the reason a user can act on. */
export interface RetainedBundle {
    bundleId: string;
    why: 
    /**
     * Its head is not in the consolidated transcript. The ordinary cause is a
     * parked fork or an adopted branch: real conversation entries that a full
     * export of the SURVIVING branch does not contain, and for which the hub
     * may hold the only copy left.
     */
    "not-covered"
    /**
     * It has no usable head, so containment cannot be asked about it at all.
     * Retained on the same principle as everything else here: an unanswerable
     * question is not a yes.
     */
     | "unknown-head"
    /** It IS the consolidated bundle. */
     | "consolidated";
}
export interface RetirementPlan {
    /** Records this machine may delete once acknowledgement and grace are met. */
    deletable: HubBundleRecord[];
    /** Records that stay, each with the reason. */
    retained: RetainedBundle[];
}
export interface RetirementPlanInput {
    /** THIS machine's records for the thread. Never another machine's — see below. */
    ownRecords: readonly HubBundleRecord[];
    consolidatedBundleId: string;
    /**
     * Does the consolidated transcript contain this entry uuid?
     *
     * Injected rather than computed here so the rule stays pure and so the
     * caller — which has just written the transcript and can read it — owns the
     * one expensive part. A `false` from a scan that could not run is the safe
     * answer and keeps the record.
     */
    coversUuid: (uuid: string) => boolean;
}
/**
 * Which of THIS machine's bundles the consolidated one provably replaces.
 *
 * **Containment, not link structure**, and the difference is the whole point. A
 * record's head being reachable along anchor links says the two are part of one
 * chain; it does not say the new full export contains the older one's entries.
 * A parked fork — `adoptHubBranch` leaves them, and divergence handling makes
 * them routinely — chains perfectly and holds entries that a full export of the
 * surviving branch will never have. Delete it on link evidence and the hub's
 * only copy of that work is gone, with the local one already replaced.
 *
 * So the test is the direct one: the consolidated transcript must actually
 * contain the record's head entry. That is answerable, it is answerable
 * locally, and it fails toward keeping the file.
 *
 * **This machine's records only** (#92, owner ruling). A thread's chain can span
 * machines and bundle files live in per-machine directories, so retiring "the
 * chain" would mean deleting another machine's files — which per-machine
 * ownership forbids for everything except `hub delete`'s owner-only, two-phase,
 * whole-project path. Each machine retires its own segment. The cost is real
 * and gets disclosed rather than hidden: one run reclaims only this machine's
 * share of a cross-machine thread.
 */
export declare function planRetirement(input: RetirementPlanInput): RetirementPlan;
//# sourceMappingURL=compact-plan.d.ts.map