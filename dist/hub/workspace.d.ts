/**
 * The convenience excludes every carry path starts from. Each of these is a
 * DEFAULT, not a floor: `.sesh-mover-hubinclude` names any of them back
 * (the floor that nothing names back is `NEVER_INCLUDABLE`, below).
 *
 * `.claude` is the one entry here that is not about size or noise. It is the
 * project-local Claude Code directory, and a workspace snapshot is a plain file
 * copy of the project, so without this line every git-less project's push
 * uploaded `settings.local.json` (permission allowlists, which routinely name
 * paths and hostnames) and any project-local hooks — and, whenever
 * `CLAUDE_CONFIG_DIR` points inside the project, every transcript a SECOND
 * time, inside the workspace payload rather than the `sessions/` payload the
 * "sessions are secrets" handling applies to. Measured in a real bundle:
 * `bundle/workspace/.claude/settings.json` and
 * `bundle/workspace/.claude/projects/<encoded>/<session>.jsonl`. The
 * default-on SessionEnd auto-push is what made that the ordinary case rather
 * than something a user chose per push.
 */
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
 * - Everything in `PLUGIN_STATE_NAMES` holds this plugin's own project state —
 *   `.sesh-mover-project.json` (planted by pull independently), the
 *   project-scope `config.json` under `.sesh-mover/` (which can redirect
 *   `hub.path`), and `.sesh-mover-hubinclude` ITSELF. A payload able to write
 *   any of those could rewrite the list deciding what the next push ships,
 *   turning a workspace payload into an exfiltration primitive. So they are
 *   refused on the apply side too, not only on the carry side.
 *
 * TWO THINGS ABOUT THIS LIST ARE PERMANENT, not incidental to the 0.7.0 rename:
 *
 * 1. **`.claude-sesh-mover` stays here forever.** Bundles carrying that path are
 *    already sitting on hubs, written by every version before 0.7.0. Dropping
 *    the old name would un-protect every one of them and reopen the exact
 *    exfiltration primitive above in a new shape — a payload writing a legacy
 *    `hubinclude` that an older peer still reads.
 * 2. **The three root dotfiles need the floor MORE than the directory did.**
 *    They are ordinary files at the project root, so there is no directory name
 *    between a payload and them: `.sesh-mover-hubinclude` can be named directly.
 *    The check is per SEGMENT and fold-tolerant (`isNeverSegment`), so it holds
 *    at any depth and in every spelling the directory names already survive.
 *
 * Everything else in `DEFAULT_WORKSPACE_EXCLUDES` (`.claude`, `node_modules`,
 * `.venv`, `__pycache__`, `.DS_Store`) is a convenience default and stays
 * re-includable on purpose — a user who names it has said what they mean.
 *
 * `.claude` is the entry in that list that has to argue for itself, because it
 * is excluded for a disclosure reason rather than a size one (see
 * `DEFAULT_WORKSPACE_EXCLUDES`) and the two lists are one line apart. It is
 * deliberately NOT here, and the dividing line is what a name can do rather
 * than what it contains: this floor holds the names that decide where the hub
 * is, what the next push ships, and whether a VCS store survives being written
 * over — a payload that reaches any of those subverts sesh-mover itself.
 * `.claude` does none of that. Its risk is that its contents leave the
 * machine, which is the user's own call to make: a project-level
 * `.claude/settings.json` or a set of shared agents is ordinary project content
 * someone may well want carried between their own machines, and writing
 * `.claude` in `hubinclude` is exactly how they say so.
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
 * fails safe (it only ever removes files), an include pattern fails OPEN. Over
 * `MAX_HUBINCLUDE_BYTES` the file is ignored entirely; past
 * `MAX_HUBINCLUDE_PATTERNS` the tail is dropped.
 *
 * Both bounds fail CLOSED — fewer re-includes — which from the outside is
 * indistinguishable from "my files silently stopped syncing". So a caller that
 * has somewhere to put it may pass `diagnostics`, and every bound that bit
 * appends a sentence naming the file, the limit and the consequence.
 * `snapshotWorkspace` threads them into the push's `warnings`.
 */
export declare function readHubinclude(projectPath: string, diagnostics?: string[]): string[];
/** Does any segment of this path name something that can never be carried? */
export declare function isNeverIncludable(relPath: string): boolean;
/**
 * Does `hubinclude` name this workspace-relative path?
 *
 * Matching is on the RELATIVE PATH, not a bare segment, so a pattern carries a
 * subtree. Two shapes, both segment-wise with `*` globs:
 *
 * - **rooted** (`docs/superpowers/`, `build/keep.txt`, `docs/*.md`, and — the
 *   commonest line of all — `docs/`) — the pattern's segments must match the
 *   path's LEADING segments, so the pattern matches that path and everything
 *   under it, and nothing outside it. Anything with a separator ANYWHERE in it
 *   is rooted, trailing one included: `docs/` is `docs` at the project root,
 *   never `vendor/x/docs`.
 * - **bare** (`*.keepme`, `secrets`) — no separator at all, so it matches that
 *   name at any depth, the same way a `hubignore` line does. `snapshotWorkspace`
 *   walks excluded directories when a bare pattern exists precisely so this
 *   predicate and the payload it builds can never disagree (§6.0: one meaning
 *   in the product).
 *
 * That split matters more than it looks: `push.md` offers `ignoredNotCarried`
 * entries to be pasted verbatim and forbids widening one, and git spells a
 * wholly-ignored top-level directory as exactly `dist/`. Reading that as bare
 * would silently hand the user every nested `dist` directory as well.
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
/** The two pattern lists that together decide what a tree contributes. */
export interface CarryRules {
    /** `DEFAULT_WORKSPACE_EXCLUDES` + `hubignore`: matched per path SEGMENT. */
    excludePatterns: string[];
    /** `hubinclude`: re-admits excluded paths. Empty is the ordinary case. */
    includePatterns: string[];
}
/** Why the walk dropped an entry — see `forEachCarriedFile`'s `onDropped`. */
export type CarryDropReason = 
/** Names `.git` or plugin state at some segment: never carried, never applied. */
"never-includable"
/** Excluded by `excludePatterns` and not named back by `includePatterns`. */
 | "excluded";
/**
 * Walk a tree and visit every file the hub's carry rules admit — ONE definition
 * of "carried", used by the snapshot that builds a payload and by the merge that
 * applies one.
 *
 * It is shared rather than duplicated because the two disagreed in production:
 * `mergeWorkspaceTrees` filtered its three trees through the excludes while
 * knowing nothing about `hubinclude`, so a file the user had explicitly listed
 * was snapshotted, archived, uploaded, downloaded — and then dropped on the
 * ordinary pull path with no report row, while a `--force-workspace` unpack of
 * the same bundle applied it. Given the same rule files on both machines (they
 * live in the project and are meant to be committed), this function is what
 * makes "the payload" and "what an apply path considers" the same set.
 *
 * The invariant the walk maintains, and the reason it tracks a relative path
 * and an "inside an excluded subtree" flag rather than deciding entry by entry:
 *
 *   **every file admitted out of an excluded subtree is individually matched by
 *   `isReIncluded`, and therefore individually passed the `NEVER_INCLUDABLE`
 *   segment check.**
 *
 * Exclusion is sticky downward — once a directory is dropped, its descendants
 * are re-admitted one at a time, never wholesale — so re-including
 * `build/keep.txt` cannot drag `build/other.txt` along, and re-including a
 * subtree (`docs/`) still cannot drag a nested `.git` along.
 *
 * `onDropped` fires at the point the walk gives up on something, so a pruned
 * DIRECTORY is reported once instead of enumerating a subtree that was never
 * opened. Symlinks are never followed and never visited.
 *
 * `admitPaths` admits a known set of relative paths (and opens the directories
 * on the way to them) whatever the exclude rules say — everything except the
 * `NEVER_INCLUDABLE` floor, which nothing overrides. `mergeWorkspaceTrees` uses
 * it to scan the LOCAL tree for exactly the paths an incoming payload names,
 * so a local file under an excluded directory is never invisible to the merge
 * while its incoming counterpart is being applied.
 */
export declare function forEachCarriedFile(root: string, rules: CarryRules, visit: (relPath: string, srcPath: string) => void, hooks?: {
    onSymlinkSkipped?: (relPath: string) => void;
    onDropped?: (relPath: string, reason: CarryDropReason, isDirectory: boolean) => void;
    admitPaths?: ReadonlySet<string>;
}): void;
/**
 * Do the carry rules admit this ONE relative path? The list-side counterpart of
 * the decision `forEachCarriedFile` makes per directory entry, for enumerations
 * that arrive as paths rather than as a walk — `git ls-files` output in
 * `carry.ts` is the only such producer today.
 *
 * It deliberately re-uses the same three primitives in the same order rather
 * than restating the rule, because a second, subtly different rule is exactly
 * how the payload and the apply side drifted apart before `forEachCarriedFile`
 * existed:
 *
 * 1. `NEVER_INCLUDABLE` on every segment — which also answers "no" for a path
 *    that is absolute, drive-rooted, or escapes via `..`, so this doubles as
 *    the traversal guard for paths that came from a subprocess.
 * 2. `excludePatterns` on every segment: exclusion is sticky downward, so a
 *    path under an excluded directory is excluded (`forEachCarriedFile` carries
 *    the same fact in its `insideExcluded` flag).
 * 3. `includePatterns` on the WHOLE relative path, which re-admits it.
 *
 * The two forms therefore agree by construction on any file both can see, which
 * `hub-carry.test.ts` pins against a real tree.
 */
export declare function isCarriedPath(relPath: string, rules: CarryRules): boolean;
/** The exclude/include rule pair a project's own files are carried under. */
export declare function readCarryRules(projectPath: string, diagnostics?: string[]): CarryRules;
/**
 * Byte budget for one workspace snapshot — the whole payload, measured before
 * anything is copied. The FALLBACK, like `CARRY_MAX_BYTES`: the real one comes
 * from `hub.workspaceMaxMb` via `snapshotWorkspace`'s `maxBytes`.
 *
 * The guard exists because `hubinclude` made an unbounded payload reachable: a
 * single `*` line re-admits every built-in exclude, and a measured
 * `node_modules` alone is 6,021 files. Before that the built-in excludes made
 * an over-budget payload nearly impossible, so there was nothing to bound.
 *
 * **WHY THIS AND `CARRY_MAX_BYTES` NOW SHARE A DEFAULT, having deliberately
 * disagreed.** The original split was 50 MB here and 5 MB there, reasoning that
 * a snapshot is a whole project while a carry is a diff, so 5 MB in a diff
 * already means generated artifacts. The second half of that did not survive
 * contact: measured on this repository, its own untracked `.superpowers/`
 * working notes are ~12.6 MB of content the owner deliberately wants carried.
 * A diff of uncommitted work is not inherently small — it is exactly as large
 * as the work you have not committed yet. So the numbers agree now because the
 * distinction they encoded turned out not to exist, NOT because the two
 * payloads became the same thing. They still differ in every other way, and
 * they are separately configurable precisely so a user who does find the split
 * real can restore it.
 */
export declare const WORKSPACE_MAX_BYTES: number;
/**
 * Copy a project's working tree into `destDir`, minus the excluded paths and
 * plus whatever `hubinclude` names back in (design §5, §6.0). The rules
 * themselves live in `forEachCarriedFile`, which the apply side shares.
 *
 * `warnings` carries anything the user would otherwise have to infer from an
 * empty or surprising payload: a `hubinclude` big enough to be ignored, a
 * truncated pattern list, or an exclude set that swallowed the whole tree.
 *
 * `skipped` means the payload was over `maxBytes` and NOTHING was copied — see
 * `WORKSPACE_MAX_BYTES`. The size is measured in a first, copy-free pass
 * precisely so the over-budget case costs a stat walk rather than gigabytes of
 * I/O that is then thrown away. All-or-nothing is the deliberate shape: a
 * truncated snapshot is worse than none, because the apply side reads a missing
 * file as an upstream state rather than as a payload that was cut short.
 * Callers must not record a generation or set `hasWorkspace` for a skipped
 * snapshot.
 */
export declare function snapshotWorkspace(projectPath: string, destDir: string, opts?: {
    maxBytes?: number;
}): Promise<{
    fileCount: number;
    byteSize: number;
    symlinksSkipped: number;
    skipped: boolean;
    warnings: string[];
}>;
/** Human-readable size for a warning a user has to act on. */
export declare function formatBytes(bytes: number): string;
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
 * internals (`NEVER_INCLUDABLE`). A CURRENT sesh-mover never produces such a
 * bundle — `snapshotWorkspace` hard-excludes both and `mergeWorkspaceTrees`
 * lists neither — but three things reach this branch, and only one is an
 * attack: a hand-made or damaged bundle; a bundle written by a version older
 * than this guard, on a case-insensitive filesystem where a store spelled
 * `.GIT` slipped past the case-sensitive exclude list; and a deliberately
 * planted payload, whose prize is `.sesh-mover-hubinclude` — the file
 * deciding what the NEXT push ships. Callers must not name a culprit. Refusing
 * here is what keeps the two apply paths (merge and unpack) saying the same
 * thing, the same argument that moved `classifyDestination` into this module.
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