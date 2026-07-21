import type { ErrorResult, HubReindexResult } from "../types.js";
export interface HubReindexOptions {
    configDir: string;
    projectPath: string;
    hubPath: string;
}
export declare function hubReindex(opts: HubReindexOptions): Promise<HubReindexResult | ErrorResult>;
//# sourceMappingURL=reindex.d.ts.map