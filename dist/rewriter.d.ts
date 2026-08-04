import type { ExportManifest, PathMapping, RewriteReport, Platform, VersionAdapter } from "./types.js";
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
/** The manifest fields a bundle's source→target path mapping is derived from. */
export type RewriteSource = Pick<ExportManifest, "sourcePlatform" | "sourceProjectPath" | "sourceConfigDir">;
/**
 * THE construction site for "rewrite this bundle's content for this machine".
 *
 * Every consumer of a bundle — importer.ts's session/subagent rewrite and
 * hub/pull.ts's continuation splice — must derive its context here rather
 * than re-deriving the mapping list locally. Two copies of this would drift,
 * and the ordering constraint they'd drift on is silent: buildPathMappings
 * sorts longest-`from`-first so a project path nested under the config dir
 * (or under the home dir) wins over its own prefix. A second construction
 * site that merely *looked* equivalent would rewrite the same entry
 * differently, and the difference only shows up on someone's real paths.
 *
 * `sourceUser` is recovered from the source PROJECT path (not the config
 * dir): a project under `/home/<user>/...` or `C:\Users\<user>\...` names the
 * user directly, and "unknown" is the honest fallback for a project that
 * lives outside any home directory — it only feeds the home-dir mapping,
 * which is skipped when source and target homes come out equal anyway.
 */
export declare function buildImportRewriteContext(source: RewriteSource, targetProjectPath: string, targetConfigDir: string): RewriteContext;
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
export interface RewriteStreamOptions {
    adapters?: VersionAdapter[];
    newSessionId?: string;
    onProgress?: (bytesProcessed: number, bytesTotal: number) => void;
    computeHash?: boolean;
}
export interface RewriteStreamReport extends RewriteReport {
    outputHash?: string;
    adaptationsApplied: string[];
    parseFailures: number;
}
export declare function rewriteJsonlStream(inputPath: string, outputPath: string | null, ctx: RewriteContext, opts?: RewriteStreamOptions): Promise<RewriteStreamReport>;
//# sourceMappingURL=rewriter.d.ts.map