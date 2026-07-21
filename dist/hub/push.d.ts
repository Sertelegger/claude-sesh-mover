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
    onProgress?: (ev: ProgressEvent) => void;
}
export declare function hubPush(opts: HubPushOptions): Promise<HubPushResult | HubUnlinkedResult | HubLockBusyResult | ErrorResult>;
//# sourceMappingURL=push.d.ts.map