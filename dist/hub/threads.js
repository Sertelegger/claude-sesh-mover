// Deterministic latest-copy ordering (spec §2): max lastActiveAt, then higher
// messageCount, then headEntryUuid lexical ascending. This tiebreak is
// load-bearing across the whole product ("which machine has my latest
// work") — it must produce the same answer regardless of machine/index
// iteration order, so every branch is a strict total order over the copy
// set, never insertion order.
function newer(a, b) {
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
            const copy = { machineId: index.machineId, ...entry };
            const list = byThread.get(threadId) ?? [];
            list.push(copy);
            byThread.set(threadId, list);
        }
    }
    const resolved = [];
    for (const [threadId, copies] of byThread) {
        const latest = copies.reduce(newer);
        resolved.push({ threadId, slug: latest.slug, summary: latest.summary, copies, latest });
    }
    resolved.sort((a, b) => (a.latest.lastActiveAt < b.latest.lastActiveAt ? 1 : -1));
    return resolved;
}
//# sourceMappingURL=threads.js.map