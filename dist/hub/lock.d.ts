export declare const LOCK_STALE_MS: number;
export declare class LockBusyError extends Error {
    readonly holderPid: number | null;
    readonly ageMs: number | null;
    constructor(holderPid: number | null, ageMs: number | null);
}
export interface LockHandle {
    release(): void;
    readonly stoleStale: boolean;
}
export declare function acquireProjectLock(projectPath: string): LockHandle;
//# sourceMappingURL=lock.d.ts.map