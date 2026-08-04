import { isConversationEntry } from "./jsonl.js";
export function computeIncrementalPlan(localSessions, peerSent, readEntries) {
    const plan = {
        full: [],
        continuation: [],
        unchanged: [],
        warnings: [],
    };
    for (const session of localSessions) {
        const record = peerSent[session.sessionId];
        if (!record) {
            plan.full.push(session);
            continue;
        }
        if (!record.headEntryUuid) {
            plan.warnings.push(`Session ${session.sessionId}: recorded head UUID is empty; sending whole.`);
            plan.full.push(session);
            continue;
        }
        const entries = readEntries(session);
        if (entries.length < record.messageCount) {
            plan.warnings.push(`Session ${session.sessionId} is shorter than recorded (${entries.length} < ${record.messageCount}); sending whole.`);
            plan.full.push(session);
            continue;
        }
        const headIndex = entries.findIndex((e) => e.uuid === record.headEntryUuid);
        if (headIndex === -1) {
            plan.warnings.push(`Session ${session.sessionId}: recorded head UUID ${record.headEntryUuid} not found; sending whole.`);
            plan.full.push(session);
            continue;
        }
        if (headIndex === entries.length - 1) {
            plan.unchanged.push(session);
            continue;
        }
        // The slice starts at the first line the peer has not seen — uuid-less
        // bookkeeping included, so nothing is dropped in transit. But if the whole
        // remainder is bookkeeping there is no chain entry in it: the recorded head
        // is still the transcript's head, `tryAppendContinuation` would decline the
        // bundle as `no-delta-entries`, and pull would land it as a content-free
        // fragment session. Defer instead — those lines ship with the next real
        // message, whose slice starts at this same index.
        //
        // "Deferred, not dropped" holds only for a session that CONTINUES. A
        // session whose last conversation entry is its last one ever — abandoned,
        // or simply finished — never ships that trailing run at all, so the peer's
        // copy is missing the final turn's `file-history-snapshot` /
        // `file-history-delta` / `mode` lines forever. That is the accepted cost:
        // the alternative sends a bundle with no chain entry, which lands as a
        // content-free fragment session on every pull, and none of those types is
        // read back by anything in this codebase (they are Claude Code's own
        // undo/display bookkeeping). Revisit if a bookkeeping type ever becomes
        // load-bearing for resumption.
        if (!entries.slice(headIndex + 1).some((e) => isConversationEntry(e))) {
            plan.unchanged.push(session);
            continue;
        }
        const fromEntryIndex = headIndex + 1;
        plan.continuation.push({
            session,
            fromEntryIndex,
            fromEntryUuid: entries[fromEntryIndex].uuid,
        });
    }
    return plan;
}
//# sourceMappingURL=diff.js.map