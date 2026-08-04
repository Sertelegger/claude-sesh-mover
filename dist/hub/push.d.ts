import type { ErrorResult, HubLockBusyResult, HubPushResult, HubUnlinkedResult, ProgressEvent } from "../types.js";
export interface HubPushOptions {
    configDir: string;
    projectPath: string;
    hubPath: string;
    sessionIds?: string[];
    noWorkspace?: boolean;
    projectIdOverride?: string;
    createProject?: boolean;
    claudeVersion: string;
    /**
     * Suppress everything whose only purpose is to be read by a human. Set by the
     * SessionEnd auto-push hook, whose contract is that session exit is never
     * interrupted or narrated (design §4.2) — today that means skipping the
     * `ignoredNotCarried` discovery scan, which also spares an unattended push a
     * `git ls-files` walk of the whole working tree.
     */
    quiet?: boolean;
    onProgress?: (ev: ProgressEvent) => void;
}
export declare function hubPush(opts: HubPushOptions): Promise<HubPushResult | HubUnlinkedResult | HubLockBusyResult | ErrorResult>;
//# sourceMappingURL=push.d.ts.map