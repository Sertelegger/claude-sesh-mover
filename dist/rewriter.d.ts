import type { PathMapping, RewriteReport } from "./types.js";
import type { Platform } from "./types.js";
export declare function buildPathMappings(sourcePlatform: Platform, targetPlatform: Platform, sourceProjectPath: string, targetProjectPath: string, sourceConfigDir: string, targetConfigDir: string, sourceUser: string, targetUser: string): PathMapping[];
export declare function rewriteEntry(entry: Record<string, unknown>, mappings: PathMapping[], newSessionId?: string): Record<string, unknown>;
export declare function rewriteJsonl(jsonlContent: string, mappings: PathMapping[], newSessionId?: string): {
    rewritten: string;
    report: RewriteReport;
};
//# sourceMappingURL=rewriter.d.ts.map