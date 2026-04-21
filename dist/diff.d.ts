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
export declare function computeIncrementalPlan(localSessions: DiscoveredSession[], peerSent: Record<string, SyncStateSessionSent>, readEntries: (session: DiscoveredSession) => Array<{
    uuid: string;
}>): DiffPlan;
//# sourceMappingURL=diff.d.ts.map