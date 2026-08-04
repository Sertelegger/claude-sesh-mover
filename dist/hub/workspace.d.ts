export declare const DEFAULT_WORKSPACE_EXCLUDES: string[];
export declare class WorkspaceTargetNotEmptyError extends Error {
    readonly targetPath: string;
    constructor(targetPath: string);
}
export declare function readHubignore(projectPath: string): string[];
export declare function isExcluded(name: string, patterns: string[]): boolean;
/** Why a destination path inside the project must not be written to. */
export type DestinationBlock = 
/** A symlink occupies the path (or one of its parents) locally — never written through. */
"local-symlink"
/** A directory sits where a file should go, or vice versa. */
 | "local-not-a-file";
/**
 * Decide whether `rel` is safe to write inside `targetDir`.
 *
 * `rel` is always built from real directory entries in a bundle's tree, so it
 * can never contain a separator, `..`, or a NUL — but what already sits at that
 * path LOCALLY is another matter, and both hazards below write outside the
 * project or destroy unrelated data if ignored:
 *
 * - A symlink at the path (or at any parent) — `copyFileSync` follows symlinks
 *   on the destination, so writing "docs/note.md" through a `docs -> ~/notes`
 *   link silently overwrites a file nobody asked to touch. `mkdirSync(...,
 *   { recursive: true })` likewise succeeds against an existing symlink-to-dir,
 *   which is how an entire subtree escapes.
 * - A directory where a file belongs (or a file where a directory belongs) —
 *   `copyFileSync` raises EISDIR and `mkdirSync` raises ENOTDIR/EEXIST, which
 *   without this check aborts a half-applied tree.
 *
 * `expect` says what the caller is about to create there: a workspace unpack
 * walks directories too, and a directory already sitting at a directory's path
 * is the normal case, not a collision.
 *
 * Lives here rather than in merge.ts so BOTH ways of applying a payload —
 * 3-way merge and Slice-1 unpack — go through one guard. They did not, and the
 * unpack path wrote through symlinks (verified) until this was shared.
 */
export declare function classifyDestination(targetDir: string, rel: string, expect?: "file" | "dir"): {
    ok: true;
} | {
    ok: false;
    reason: DestinationBlock;
};
export declare function snapshotWorkspace(projectPath: string, destDir: string): Promise<{
    fileCount: number;
    byteSize: number;
    symlinksSkipped: number;
}>;
/**
 * Apply a workspace payload by copying it over `targetPath`, overwriting on
 * collision. Slice-1 behavior, and still the right one when there is no
 * ancestor generation to merge against (design §5.4).
 *
 * `blocked` reports paths that were NOT written because of what already sits at
 * the destination locally — see `classifyDestination`. Nothing is written near
 * a blocked path, so the caller must surface it: an unreported skip and a
 * successful copy look identical from the outside.
 */
export declare function unpackWorkspace(srcDir: string, targetPath: string, opts: {
    force: boolean;
}): Promise<{
    fileCount: number;
    symlinksSkipped: number;
    blocked: Array<{
        path: string;
        reason: DestinationBlock;
    }>;
}>;
//# sourceMappingURL=workspace.d.ts.map