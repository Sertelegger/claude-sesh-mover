export declare const DEFAULT_WORKSPACE_EXCLUDES: string[];
/**
 * Names that can never be carried, re-included, or applied — at ANY depth, on
 * any path, by any pattern (design §6.0).
 *
 * `hubinclude` exists to make the exclusion logic say "yes" where it used to
 * say "no", so this list is the floor it can never dig under:
 *
 * - `.git` is a VCS store, not project content: it holds credentials in some
 *   configurations, it is enormous, and a peer's copy landing on top of a local
 *   one corrupts the repository rather than merging it. A *nested* `.git` (a
 *   vendored submodule, a worktree) is the same store one level down, which is
 *   why the check is per segment and not just on the first one.
 * - `.claude-sesh-mover` holds this plugin's own project state — `project.json`
 *   (planted by pull independently), the project-scope `config.json` (which can
 *   redirect `hub.path`), and `hubinclude` ITSELF. A payload able to write that
 *   directory could rewrite the list deciding what the next push ships, turning
 *   a workspace payload into an exfiltration primitive. So it is refused on the
 *   apply side too, not only on the carry side.
 *
 * Everything else in `DEFAULT_WORKSPACE_EXCLUDES` (`node_modules`, `.venv`,
 * `__pycache__`, `.DS_Store`) is a convenience default and stays re-includable
 * on purpose — a user who names it has said what they mean.
 */
export declare const NEVER_INCLUDABLE: readonly string[];
export declare class WorkspaceTargetNotEmptyError extends Error {
    readonly targetPath: string;
    constructor(targetPath: string);
}
export declare function readHubignore(projectPath: string): string[];
/** Where a project's `hubinclude` lives. */
export declare function hubincludePath(projectPath: string): string;
/**
 * hubinclude: the opt-in re-include list (design §6.0). Sibling to `hubignore`,
 * same syntax, and meant to be COMMITTED so it travels with the repo and means
 * the same thing on every clone.
 *
 * It exists because `.gitignore` is also where `.env` and credential files
 * live: ignored files are never carried by default, and this is the explicit,
 * reviewable exception list. Returned lines are raw (trimmed only) — every
 * normalization happens in `isReIncluded`, so what a user wrote is what a
 * caller can echo back to them.
 *
 * Bounds are asymmetric with `readHubignore` on purpose: an ignore pattern
 * fails safe (it only ever removes files), an include pattern fails OPEN and
 * costs a glob test per candidate path. Over `MAX_HUBINCLUDE_BYTES` the file is
 * ignored entirely; past `MAX_HUBINCLUDE_PATTERNS` the tail is dropped.
 */
export declare function readHubinclude(projectPath: string): string[];
/** Does any segment of this path name something that can never be carried? */
export declare function isNeverIncludable(relPath: string): boolean;
/**
 * Does `hubinclude` name this workspace-relative path?
 *
 * Matching is on the RELATIVE PATH, not a bare segment, so a pattern carries a
 * subtree. Two shapes, both segment-wise with `*` globs:
 *
 * - **rooted** (`docs/superpowers/`, `build/keep.txt`, `docs/*.md`) — the
 *   pattern's segments must match the path's LEADING segments, so the pattern
 *   matches that path and everything under it, and nothing outside it.
 * - **bare** (`*.keepme`, `secrets`) — matches that name at any depth, the same
 *   way a `hubignore` line does. `snapshotWorkspace` walks excluded directories
 *   when a bare pattern exists precisely so this predicate and the payload it
 *   builds can never disagree (§6.0: one meaning in the product).
 *
 * `NEVER_INCLUDABLE` wins over every pattern, on every segment — see that
 * constant. A path that is absolute or escapes the project is never a match.
 */
export declare function isReIncluded(relPath: string, patterns: string[]): boolean;
/**
 * Could anything BELOW this directory be re-included? The walker's companion to
 * `isReIncluded`: it decides whether to descend into a directory that the
 * exclude patterns dropped, so that the two never disagree about a path.
 *
 * A bare pattern matches at any depth, so it forces descent into every excluded
 * directory — the price of that convenience is a read-only walk of, say, an
 * excluded `node_modules` on each push. A rooted pattern only opens the
 * directories on its own prefix, so `docs/*.keepme` keeps the walk pruned.
 * Nothing ever descends into a `NEVER_INCLUDABLE` directory: not one path
 * inside it can be carried, so reading it would be pure cost.
 */
export declare function mayContainReIncluded(dirRelPath: string, patterns: string[]): boolean;
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
/**
 * Copy a project's working tree into `destDir`, minus the excluded paths and
 * plus whatever `hubinclude` names back in (design §5, §6.0).
 *
 * The invariant the walk maintains, and the reason it tracks a relative path
 * and an "inside an excluded subtree" flag rather than deciding entry by entry:
 *
 *   **every file copied out of an excluded subtree is individually matched by
 *   `isReIncluded`, and therefore individually passed the `NEVER_INCLUDABLE`
 *   segment check.**
 *
 * Exclusion is sticky downward — once a directory is dropped, its descendants
 * are re-admitted one at a time, never wholesale — so re-including
 * `build/keep.txt` cannot drag `build/other.txt` along, and re-including a
 * subtree (`docs/`) still cannot drag a nested `.git` along.
 */
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
 *
 * `refused` reports paths dropped because the PAYLOAD named plugin or VCS
 * internals (`NEVER_INCLUDABLE`). A bundle this codebase produced never
 * contains them — `snapshotWorkspace` hard-excludes both and `mergeWorkspaceTrees`
 * lists neither — so a payload that does is malformed or hostile, and the one
 * it would most want is `.claude-sesh-mover/hubinclude`: the file deciding what
 * the NEXT push ships. Refusing here is what keeps the two apply paths (merge
 * and unpack) saying the same thing, the same argument that moved
 * `classifyDestination` into this module.
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
    refused: string[];
}>;
//# sourceMappingURL=workspace.d.ts.map