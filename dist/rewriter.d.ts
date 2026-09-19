import type { ExportManifest, PathMapping, RewriteReport, Platform, VersionAdapter } from "./types.js";
export interface RewriteContext {
    mappings: PathMapping[];
    sourcePlatform: Platform;
    targetPlatform: Platform;
    sourceUser: string;
    targetUser: string;
    /**
     * source session id -> the id this import minted for it (#127).
     *
     * Present only when the caller can name the WHOLE set — i.e. an import or
     * pull of a bundle. It carries two jobs that are the same lookup: the
     * `session_id` / `continuedInSessionId` references, and the session-id
     * SEGMENT inside a path like
     * `<configDir>/projects/<encoded>/<sessionId>/tool-results/…`.
     *
     * Absent means "leave every reference byte-identical", which is correct
     * rather than degraded: measured over 205,946 real lines, roughly one
     * `session_id` line in six names a run that has no transcript even on the
     * machine that wrote it. There is nothing to map it to.
     */
    sessionIdMap?: ReadonlyMap<string, string>;
    /** `[encode(sourceProjectPath), encode(targetProjectPath)]`, or absent when equal. */
    encodedProject?: readonly [from: string, to: string];
}
/**
 * The primitive for a field that is a path IN ITS ENTIRETY but whose interior
 * may carry ids this import is renaming (#127).
 *
 * `rewriteWholePath` alone is not enough for the largest such family.
 * `realParentDir` (6,358 occurrences measured) looks like
 * `/tmp/claude-1000/-home-dev-repos-x/<sourceSessionId>/scratchpad`: the
 * leading `/tmp/claude-1000` matches no mapping, so the prefix pass hands it
 * back untouched — and the two things that ARE stale sit mid-path.
 *
 * The interior pass matches whole `/`- or `\`-delimited SEGMENTS and nothing
 * else. An encoded project name and a session id are each exactly one segment,
 * and segment matching is what makes a prefix collision between two encoded
 * names structurally impossible here — unlike `rewriteString`, which needs a
 * lookahead guard for the same job.
 */
export declare function rewritePathValue(input: string, ctx: RewriteContext): string;
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
export declare function buildImportRewriteContext(source: RewriteSource, targetProjectPath: string, targetConfigDir: string, 
/**
 * source session id -> newly minted id, when the caller can name the whole
 * set (#127). Omit it and every session reference is left byte-identical,
 * which is the correct answer for a caller that cannot.
 */
sessionIdMap?: ReadonlyMap<string, string>): RewriteContext;
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