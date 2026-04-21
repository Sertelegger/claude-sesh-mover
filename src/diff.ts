import type { DiscoveredSession, SyncStateSessionSent } from "./types.js";

export interface ContinuationPlanItem {
  session: DiscoveredSession;
  fromEntryIndex: number;
  fromEntryUuid: string;
}

export interface DiffPlan {
  full: DiscoveredSession[];
  continuation: ContinuationPlanItem[];
  unchanged: DiscoveredSession[];
  warnings: string[];
}

export function computeIncrementalPlan(
  localSessions: DiscoveredSession[],
  peerSent: Record<string, SyncStateSessionSent>,
  readEntries: (session: DiscoveredSession) => Array<{ uuid: string }>
): DiffPlan {
  const plan: DiffPlan = {
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
      plan.warnings.push(
        `Session ${session.sessionId} is shorter than recorded (${entries.length} < ${record.messageCount}); sending whole.`
      );
      plan.full.push(session);
      continue;
    }

    const headIndex = entries.findIndex((e) => e.uuid === record.headEntryUuid);
    if (headIndex === -1) {
      plan.warnings.push(
        `Session ${session.sessionId}: recorded head UUID ${record.headEntryUuid} not found; sending whole.`
      );
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
