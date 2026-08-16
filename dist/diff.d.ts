import type { DiscoveredSession, SyncStateSessionSent } from "./types.js";
export interface ContinuationPlanItem {
    session: DiscoveredSession;
    fromEntryIndex: number;
    /** Uuid of the first entry this delta SHIPS — one past the anchor. May be `""`. */
    fromEntryUuid: string;
    /**
     * The recorded head this delta was built AGAINST — the peer's own
     * `headEntryUuid` for this session. Always a non-empty uuid: an empty or
     * missing recorded head is a full push (see the two guards below), so this is
     * only ever reached with a head that was found in the transcript.
     *
     * This is the value a cross-machine chain walk links on. `fromEntryUuid` is
     * NOT — it is the anchor's child and equals no bundle's head, which is why a
     * head-keyed walk over it found zero links on any real hub.
     */
    anchorEntryUuid: string;
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