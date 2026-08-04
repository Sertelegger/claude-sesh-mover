import type { SyncState, SyncStateSessionSent } from "./types.js";
export declare function syncStatePath(projectPath: string): string;
export declare function readSyncState(projectPath: string): SyncState;
export declare function writeSyncState(state: SyncState): void;
export declare function recordSentFromBundle(projectPath: string, peer: {
    id: string;
    name?: string;
}, bundleDir: string): void;
export declare function recordSentToPeer(projectPath: string, peer: {
    id: string;
    name?: string;
}, localSessionId: string, sent: SyncStateSessionSent): void;
export declare function getThreadId(state: SyncState, localSessionId: string): string | null;
export declare function setThreadId(state: SyncState, hubId: string, localSessionId: string, threadId: string): void;
/**
 * Record the workspace generation this machine last pushed or applied.
 *
 * It is the ancestor input for the 3-way workspace merge on the next pull
 * (design §5.2) — a POINTER at a bundle on the hub, never a copy of the tree,
 * because every workspace payload is a full snapshot generation and the hub
 * already stores it.
 *
 * Two rules the callers depend on:
 *
 * - **Write it only for a generation this machine's tree actually reflects.**
 *   Recording a generation that was never applied (a skipped payload, say)
 *   would make the NEXT merge read "present in the ancestor, absent locally"
 *   as a deliberate local deletion, so files the user never received would be
 *   silently withheld rather than delivered.
 * - It is per-project and singular: a newer generation replaces the older one
 *   outright. There is no history to keep — the merge only ever needs the last
 *   common point.
 * - `generation.pushedAt` must date the BUNDLE (its `pushedAt` on the hub), not
 *   this moment. Pull compares it against another machine's generation to pick
 *   the older of the two, and a locally-stamped clock would make that
 *   comparison meaningless across machines.
 *
 * Same v1/v2 discipline as `setThreadId`: the hub block (and with it
 * schemaVersion 2) appears only once hub data is first written.
 */
export declare function setLastWorkspace(state: SyncState, hubId: string, generation: {
    bundleId: string;
    file: string;
    pushedAt: string;
}): void;
//# sourceMappingURL=sync-state.d.ts.map