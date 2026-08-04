import { type HubBundleRecord } from "./layout.js";
import type { ErrorResult, HubLockBusyResult, HubPullListResult, HubPullResult, HubUnlinkedResult, NotYetSyncedResult, ProgressEvent } from "../types.js";
export interface HubPullOptions {
    configDir: string;
    projectPath: string;
    hubPath: string;
    threadId?: string;
    latest?: boolean;
    targetPath?: string;
    forceWorkspace?: boolean;
    projectIdOverride?: string;
    claudeVersion: string;
    /** Splice onto a base that looks like a live session (skips the mtime guard). */
    forceAppend?: boolean;
    /** Never splice: import every continuation as its own session (Slice-1 behavior). */
    noAppend?: boolean;
    onProgress?: (ev: ProgressEvent) => void;
}
export declare function selectNeededBundles(bundles: HubBundleRecord[], received: Record<string, {
    localSessionId: string;
}> | undefined, localSessionFileExists: (localSessionId: string) => boolean): HubBundleRecord[];
export declare function hubPull(opts: HubPullOptions): Promise<HubPullResult | HubPullListResult | NotYetSyncedResult | HubUnlinkedResult | HubLockBusyResult | ErrorResult>;
//# sourceMappingURL=pull.d.ts.map