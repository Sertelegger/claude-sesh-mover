import type { HubLockBusyResult, HubReindexFailedResult, HubReindexResult } from "../types.js";
export interface HubReindexOptions {
    configDir: string;
    projectPath: string;
    hubPath: string;
}
export declare function hubReindex(opts: HubReindexOptions): Promise<HubReindexResult | HubReindexFailedResult | HubLockBusyResult>;
//# sourceMappingURL=reindex.d.ts.map