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
import { isLinkUuid } from "./threads.js";
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
export const COMPACTION_GRACE_MS = 6 * 60 * 60 * 1000; // 6 hours
/**
 * Which machines still need what is behind the consolidated bundle.
 *
 * Pure. Reads only what other machines published on the hub, and treats every
 * one of those as the self-report it is.
 */
export function planAck(input) {
    const retiring = new Set(input.retiringBundleIds);
    // Every surviving record for this thread, from every machine — the walk is
    // cross-machine on purpose. A continuation another machine pushed carries its
    // predecessor's head, so it extends the acknowledged set for testing a THIRD
    // machine; restricting the walk to our own records would report a machine as
    // outstanding because a peer, not it, was the one that moved the thread on.
    const surviving = [];
    for (const index of input.indexes) {
        for (const r of index.threads[input.threadId]?.bundles ?? []) {
            if (!retiring.has(r.bundleId))
                surviving.push(r);
        }
    }
    // Fixed point rather than one pass: records arrive in each index's own order
    // and a continuation may be seen before the record it anchors on. Bounded by
    // the record count, since every round either adds a head or stops.
    const ackHeads = new Set([input.consolidatedHead]);
    for (;;) {
        let grew = false;
        for (const r of surviving) {
            if (!isLinkUuid(r.headEntryUuid) || ackHeads.has(r.headEntryUuid))
                continue;
            if (isLinkUuid(r.anchorEntryUuid) && ackHeads.has(r.anchorEntryUuid)) {
                ackHeads.add(r.headEntryUuid);
                grew = true;
            }
        }
        if (!grew)
            break;
    }
    const acknowledged = [];
    const outstanding = [];
    for (const index of input.indexes) {
        if (index.machineId === input.machineId) {
            acknowledged.push(index.machineId);
            continue;
        }
        const entry = index.threads[input.threadId];
        if (!entry) {
            // NEVER PARTICIPATED, and that is genuinely safe rather than merely
            // convenient: a machine with no local copy of this thread pulls it from
            // scratch, and both planner paths start at the newest FULL bundle, which
            // after this run is the consolidated one. It needs nothing behind it and
            // never will.
            //
            // The exception is the one this predicate cannot see — an interrupted
            // pull, whose index write never happened — and it is why the caller also
            // waits out `COMPACTION_GRACE_MS`.
            acknowledged.push(index.machineId);
            continue;
        }
        if (isLinkUuid(entry.headEntryUuid) && ackHeads.has(entry.headEntryUuid)) {
            acknowledged.push(index.machineId);
            continue;
        }
        // A machine can also prove it by what it PUSHED: a record anchored on a
        // head in the set was diffed against content that machine held.
        const anchored = entry.bundles.some((r) => isLinkUuid(r.anchorEntryUuid) && ackHeads.has(r.anchorEntryUuid));
        if (anchored) {
            acknowledged.push(index.machineId);
            continue;
        }
        const reason = !isLinkUuid(entry.headEntryUuid)
            ? "unknown-head"
            : entry.bundles.length > 0 &&
                entry.bundles.every((r) => r.anchorEntryUuid === undefined)
                ? "no-anchor"
                : "behind";
        outstanding.push({
            machineId: index.machineId,
            reason,
            advertisedHead: isLinkUuid(entry.headEntryUuid) ? entry.headEntryUuid : "",
        });
    }
    return { ackHeads: [...ackHeads], acknowledged, outstanding };
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
export function planRetirement(input) {
    const deletable = [];
    const retained = [];
    for (const r of input.ownRecords) {
        if (r.bundleId === input.consolidatedBundleId) {
            retained.push({ bundleId: r.bundleId, why: "consolidated" });
            continue;
        }
        if (!isLinkUuid(r.headEntryUuid)) {
            retained.push({ bundleId: r.bundleId, why: "unknown-head" });
            continue;
        }
        if (input.coversUuid(r.headEntryUuid)) {
            deletable.push(r);
            continue;
        }
        retained.push({ bundleId: r.bundleId, why: "not-covered" });
    }
    return { deletable, retained };
}
//# sourceMappingURL=compact-plan.js.map