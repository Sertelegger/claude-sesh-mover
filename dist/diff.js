"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeIncrementalPlan = computeIncrementalPlan;
function computeIncrementalPlan(localSessions, peerSent, readEntries) {
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