// Deterministic latest-copy ordering (spec §2): max lastActiveAt, then higher
// messageCount, then headEntryUuid lexical ascending. This tiebreak is
// load-bearing across the whole product ("which machine has my latest
// work") — it must produce the same answer regardless of machine/index
// iteration order, so every branch is a strict total order over the copy
// set, never insertion order.
export function newerThreadCopy(a, b) {
    if (a.lastActiveAt !== b.lastActiveAt)
        return a.lastActiveAt > b.lastActiveAt ? a : b;
    if (a.messageCount !== b.messageCount)
        return a.messageCount > b.messageCount ? a : b;
    if (a.headEntryUuid !== b.headEntryUuid)
        return a.headEntryUuid < b.headEntryUuid ? a : b;
    // Total tie. Without this last key the answer was the reduce ACCUMULATOR,
    // i.e. whichever index file the hub directory listed first — exactly the
    // insertion-order dependence the comment above forbids, and it is reachable
    // from the ordinary round trip (A pushes, B continues, A pulls the
    // continuation back and splices it: both copies then carry the same
    // lastActiveAt, messageCount and head). The two copies list DIFFERENT
    // bundles, so this decides what a third machine's pull actually fetches.
    // machineId is arbitrary as a preference and that is fine — it is stable,
    // which is the property being bought here.
    return a.machineId <= b.machineId ? a : b;
}
export function resolveThreads(indexes) {
    const byThread = new Map();
    for (const index of indexes) {
        for (const [threadId, entry] of Object.entries(index.threads)) {
            // Spread FIRST, then the file-derived id — never the other way round.
            // A thread entry is peer-authored data; with the id first, an entry
            // carrying its own `machineId` key overrides the one derived from the
            // index file's NAME, which is the only trustworthy source. That id now
            // selects `state.peers[...]` and feeds `alternateSource`, i.e. it decides
            // which machine a pull fetches from.
            const copy = { ...entry, machineId: index.machineId };
            const list = byThread.get(threadId) ?? [];
            list.push(copy);
            byThread.set(threadId, list);
        }
    }
    const resolved = [];
    for (const [threadId, copies] of byThread) {
        const latest = copies.reduce(newerThreadCopy);
        resolved.push({ threadId, slug: latest.slug, summary: latest.summary, copies, latest });
    }
    // Same invariant as `newerThreadCopy` above, one level up: never depend on
    // iteration order. The obvious `a < b ? 1 : -1` is an INCONSISTENT comparator — it
    // returns -1 for equal values, so two equal-timestamped threads swap and
    // fourteen come back fully reversed when the input order reverses. Both
    // consumers pick positionally (`pull --latest` takes the first non-current
    // thread, the SessionStart notice takes the most recent stale one), so an
    // arbitrary winner among ties is a user-visible arbitrary answer.
    resolved.sort((a, b) => {
        if (a.latest.lastActiveAt !== b.latest.lastActiveAt) {
            return a.latest.lastActiveAt < b.latest.lastActiveAt ? 1 : -1;
        }
        return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
    });
    return resolved;
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
export function findUnfetchableBundles(args) {
    const { copies, sourceMachineId, localMachineId, state } = args;
    // Everything the chosen source offers, by id — a bundle listed by two
    // machines is fetchable if the source is one of them.
    const offered = new Set();
    for (const c of copies) {
        if (c.machineId !== sourceMachineId)
            continue;
        for (const b of c.bundles)
            offered.add(b.bundleId);
    }
    // Keyed by machineId rather than per copy: readMachineIndex validates only
    // the id derived from an index file's NAME, so two index files can declare
    // the same internal machineId and both land here as separate copies.
    const byMachine = new Map();
    for (const c of copies) {
        // The source half of this test is UNOBSERVABLE today and kept anyway,
        // annotated rather than deleted (same call as the pattern-side NEVER guard
        // in workspace.ts): `offered` is built from exactly these copies, so the
        // per-record filter below already drops every one of them, and removing
        // this clause reddens nothing. It stays because it is what makes "with two
        // machines the candidate set is empty" true of THIS loop rather than of a
        // downstream filter — the property the whole disclosure rests on should
        // not depend on how `offered` is populated later.
        if (c.machineId === sourceMachineId || c.machineId === localMachineId)
            continue;
        const peer = state.peers[c.machineId];
        let consumedThrough = -1;
        for (let i = 0; i < c.bundles.length; i++) {
            const r = c.bundles[i];
            const rec = peer?.received?.[r.sessionIdInBundle];
            const heldHead = rec ? peer?.sent[rec.localSessionId]?.headEntryUuid : undefined;
            // Both sides can legitimately be "" (a bundle boundary landing on a
            // uuid-less bookkeeping line), and two empty strings are not a match.
            if (heldHead && r.headEntryUuid && heldHead === r.headEntryUuid)
                consumedThrough = i;
        }
        const ids = byMachine.get(c.machineId) ?? [];
        const seen = new Set(ids);
        for (let i = 0; i < c.bundles.length; i++) {
            const r = c.bundles[i];
            if (offered.has(r.bundleId) || seen.has(r.bundleId))
                continue;
            const accounted = consumedThrough >= 0 ? i <= consumedThrough : !!peer?.received?.[r.sessionIdInBundle];
            if (accounted)
                continue;
            seen.add(r.bundleId);
            ids.push(r.bundleId);
        }
        if (ids.length > 0)
            byMachine.set(c.machineId, ids);
    }
    // Stated order, never map insertion order — the same rule the tiebreaks
    // above follow, for the same reason: this text reaches a user.
    return [...byMachine.entries()]
        .map(([machineId, bundleIds]) => ({ machineId, bundleIds }))
        .sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
}
//# sourceMappingURL=threads.js.map