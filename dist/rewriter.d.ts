import type { PathMapping, RewriteReport, Platform, VersionAdapter } from "./types.js";
export interface RewriteContext {
    mappings: PathMapping[];
    sourcePlatform: Platform;
    targetPlatform: Platform;
    sourceUser: string;
    targetUser: string;
}
export declare function rewriteString(input: string, ctx: RewriteContext): string;
export declare function rewriteWholePath(input: string, ctx: RewriteContext): string;
export declare function buildPathMappings(sourcePlatform: Platform, targetPlatform: Platform, sourceProjectPath: string, targetProjectPath: string, sourceConfigDir: string, targetConfigDir: string, sourceUser: string, targetUser: string): PathMapping[];
export declare function rewriteEntry(entry: Record<string, unknown>, ctx: RewriteContext, newSessionId?: string): Record<string, unknown>;
export interface TransformLineOptions {
    adapters?: VersionAdapter[];
    newSessionId?: string;
}
export interface TransformLineResult {
    line: string;
    changed: boolean;
    fieldsChanged: number;
    adaptationsApplied: string[];
    parseFailed: boolean;
    parseError?: string;
}
export declare function transformLine(line: string, ctx: RewriteContext, opts?: TransformLineOptions): TransformLineResult;
export declare function rewriteJsonl(jsonlContent: string, ctx: RewriteContext, newSessionId?: string): {
    rewritten: string;
    report: RewriteReport;
};
//# sourceMappingURL=rewriter.d.ts.map