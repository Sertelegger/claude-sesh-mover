import type { SyncState } from "./types.js";
export declare function syncStatePath(projectPath: string): string;
export declare function readSyncState(projectPath: string): SyncState;
export declare function writeSyncState(state: SyncState): void;
export declare function recordSentFromBundle(projectPath: string, peer: {
    id: string;
    name?: string;
}, bundleDir: string): void;
export declare function getThreadId(state: SyncState, localSessionId: string): string | null;
export declare function setThreadId(state: SyncState, hubId: string, localSessionId: string, threadId: string): void;
//# sourceMappingURL=sync-state.d.ts.map