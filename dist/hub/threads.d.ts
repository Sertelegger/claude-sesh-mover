import type { HubBundleRecord, HubIndexJson } from "./layout.js";
export interface ThreadCopy {
    machineId: string;
    localSessionId: string;
    slug: string;
    summary: string;
    headEntryUuid: string;
    messageCount: number;
    lastActiveAt: string;
    bundles: HubBundleRecord[];
}
export interface ResolvedThread {
    threadId: string;
    slug: string;
    summary: string;
    copies: ThreadCopy[];
    latest: ThreadCopy;
}
export declare function resolveThreads(indexes: HubIndexJson[]): ResolvedThread[];
//# sourceMappingURL=threads.d.ts.map