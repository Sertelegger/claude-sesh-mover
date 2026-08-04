/** A file was left alone and the incoming copy parked beside it. */
export type SidecarReason = 
/** NUL byte in the first 8 KB on either side — `git merge-file` refuses these. */
"binary"
/**
 * No usable `git merge-file` on this machine: missing, too old for our
 * invocation, or unable to run at all (a broken global/system git config
 * makes it exit 128 before it ever looks at the operands). All three are
 * properties of the machine, not of the file, so the rest of the tree
 * degrades with it instead of re-spawning a doomed process per file.
 */
 | "git-unavailable"
/**
 * The 3-way merge did not complete for this one file: `git merge-file` was
 * reachable but failed on it, or the merge succeeded and its result could not
 * be written back. `detail` carries git's stderr, or the write's error.
 */
 | "merge-failed";
/**
 * A file the merge deliberately did not touch — and, unlike a sidecar case,
 * one where **nothing at all was written near that path**.
 *
 * That is deliberate, not an oversight — but the reasons differ in strength,
 * so don't restate this as "a sidecar would always escape too". It holds
 * outright when the obstruction is at a PARENT segment: parking
 * `docs/note.md.theirs-…` beside a `docs -> ~/notes` symlink writes outside the
 * project exactly as the original write would have, and parking beside a file
 * that occupies a directory's path just raises `ENOTDIR` in a different place.
 * When the obstruction is the destination itself — a symlinked file inside a
 * real directory, or `name-collision`, where `classifyDestination` already
 * approved the whole path and the `EEXIST` is itself proof of what's there —
 * a sidecar would in fact be safe, and parking one is a defensible future
 * change (`name-collision` is the likely one in practice: a case-folding
 * filesystem where a peer's `README.md` meets a local `readme.md`).
 *
 * Uniform "park nothing" is the conservative choice while the two cases are
 * indistinguishable in `SkipReason`: it is safe in every case, and the incoming
 * copy stays recoverable from the bundle on the hub either way.
 */
export type SkipReason = 
/** A symlink occupies the path (or one of its parents) locally — never written through. */
"local-symlink"
/** A directory sits where a file should go, or vice versa. */
 | "local-not-a-file"
/** The destination already existed although the tree scan said it did not
 *  (case-insensitive filesystem fold, or a concurrent create). */
 | "name-collision"
/** Reading or writing this one file failed; the rest of the merge continued. */
 | "io-error";
export interface WorkspaceMergeReport {
    /** incoming changed, local didn't -> incoming written */
    taken: string[];
    /** local changed, incoming didn't -> local left alone */
    kept: string[];
    /** absent locally AND absent from the ancestor -> created */
    created: string[];
    /**
     * In the ancestor, gone locally, and untouched upstream — so it is **not**
     * recreated.
     *
     * This is the one row that deviates from design §5.3's table (which says
     * "absent locally | present | create" unconditionally). That rule resurrects
     * a file on every pull for as long as any peer still has it, which the
     * ancestor makes unnecessary: "absent locally" and "deleted locally" are only
     * indistinguishable without one.
     *
     * **Not the same claim as "the user deleted it", and callers must not phrase
     * it that way.** A deliberate deletion is by far the likeliest cause, but a
     * file an earlier merge could not write reaches this row too — it was never
     * created here, and the ancestor has since advanced past it — and from here
     * the two are identical. The cases this function CAN tell apart it does:
     * a path hidden behind a local symlink, or one occupied by a directory, is
     * classified before this row is reached and lands in `skipped` instead, where
     * "nothing was written near it" is the accurate story.
     *
     * Either way the withholding is permanent as far as ordinary pulls go (the
     * ancestor advances every time), so this row must always be surfaced, with a
     * remedy: an unpack with `--force-workspace` is what puts the hub's copy back.
     *
     * A caller merging into a tree that is EMPTY or unrelated must not use this
     * function at all: every file would read as a local deletion. That is the
     * caller's gate (hub/pull.ts unpacks rather than merges into an empty tree),
     * not a check this function can make.
     */
    localDeleted: string[];
    /**
     * Deleted locally, but CHANGED upstream since the ancestor — the delete/modify
     * case. Recreated with the incoming content, because this merge never
     * discards a change; separate from `created` so the caller can say "this one
     * came back, delete it again if you meant it".
     */
    restored: string[];
    /** both changed, 3-way merged cleanly */
    merged: string[];
    /** both changed, conflict markers written — the user must resolve these */
    conflicted: string[];
    /** local kept, incoming parked beside it (binary or unmergeable) */
    sidecars: Array<{
        path: string;
        sidecar: string;
        reason: SidecarReason;
        detail?: string;
    }>;
    /** gone upstream, deliberately kept locally (this merge never deletes) */
    upstreamDeleted: string[];
    /** paths the merge refused to touch, with why */
    skipped: Array<{
        path: string;
        reason: SkipReason;
        detail?: string;
    }>;
    /**
     * True when at least one file needed a 3-way merge and no usable
     * `git merge-file` was found. Those files are in `sidecars` with reason
     * "git-unavailable"; nothing was lost, but nothing was merged either.
     * False also means "no file ever needed the merge engine".
     */
    gitUnavailable: boolean;
}
/**
 * Thrown when `mergeWorkspaceTrees` is called without an ancestor tree.
 *
 * A 3-way merge with no ancestor degenerates into "every shared file whose
 * content differs is a both-added conflict", which would write conflict
 * markers across a user's whole working tree. That is not a merge, it is
 * damage. Callers with no known ancestor must use no-ancestor mode instead
 * (design §5.4: unpack an empty target, otherwise skip unless
 * `--force-workspace`).
 */
export declare class MergeAncestorRequiredError extends Error {
    constructor();
}
/**
 * Probe whether this machine has a `git merge-file` we can actually use.
 *
 * Runs a real 3-way merge with the exact argument vector `mergeWorkspaceTrees`
 * uses, in a private temp dir, and checks both the exit status and the markers.
 * That is deliberately stronger than a version check:
 *
 * - `git <cmd> --help` is NOT a safe probe. It delegates to `git help <cmd>`,
 *   which spawns `man` on Unix and opens the HTML docs in the user's default
 *   BROWSER on Git for Windows. A capability probe must never open a window.
 * - `git merge-file -h` exits 129, so "no error" is not a usable signal either.
 * - Running the real thing also catches a git too old for `--diff3`, and a
 *   `git` on PATH that is a broken wrapper rather than git.
 *
 * The marker assertions below cannot be broken by a project's own git settings.
 * `cwd` is the probe's private temp dir, so no repository-local config is in
 * scope (same reason the merge spawn in `mergeWorkspaceTrees` sets it — see the
 * comment there), and `.gitattributes`' `conflict-marker-size` does
 * not reach `git merge-file` at all — verified: `* conflict-marker-size=15` in a
 * repo still produces 7-character markers, because merge-file takes three plain
 * paths and never consults the attribute stack. Same for
 * `merge.conflictMarkerSize`.
 *
 * Not memoized: the caller decides how often to ask (design §5.3 probes once
 * per pull, like `isZstdAvailable`), and a module-level cache would make the
 * degraded path untestable.
 */
export declare function isGitMergeFileAvailable(): Promise<boolean>;
/**
 * A NUL byte in the first 8 KB means "binary" — the same blunt heuristic git
 * itself uses. We pre-detect rather than parsing git's output because
 * `git merge-file` reports binary input as an error (exit 255,
 * "error: Cannot merge binary files"), which is indistinguishable at the exit
 * status from a genuine failure.
 */
export declare function isBinaryFile(path: string): boolean;
/**
 * 3-way merge of two workspace generations against their common ancestor,
 * with no git repository anywhere in sight: `git merge-file` operates on three
 * plain files.
 *
 * Resolution table (design §5.3, with the one deliberate deviation documented
 * on `localDeleted`); comparison is by sha256 content hash, never
 * mtime. This function **never deletes a file** and never resolves a conflict
 * by discarding one side: the worst case for any file it *resolves* is "local
 * kept, incoming parked beside it" or "both sides present between conflict
 * markers". A file it refuses to touch at all lands in `skipped` and nothing is
 * written near it — see `SkipReason` for why parking a copy there would
 * reproduce the very hazard the skip exists to avoid.
 *
 * Excludes default to the standard workspace excludes plus the *target's*
 * `.claude-sesh-mover/hubignore` — so a file this machine deliberately keeps
 * out of the hub can never be overwritten by an incoming copy of the same name.
 *
 * `git merge-file` is spawned once per file that needs a real 3-way merge, and
 * spawned synchronously: the merge writes into the user's working tree in a
 * fixed order, and interleaving those writes buys nothing in a CLI.
 */
export declare function mergeWorkspaceTrees(opts: {
    /** Common ancestor tree. `null` is rejected — see `MergeAncestorRequiredError`. */
    ancestorDir: string | null;
    incomingDir: string;
    targetDir: string;
    /** Override the exclude patterns; defaults to workspace excludes + target hubignore. */
    excludePatterns?: string[];
    /**
     * Test seam: the timestamp baked into sidecar names, defaulting to now.
     * Never set in production code.
     *
     * It exists because sidecar-name collisions are unreachable from a single
     * run — one file is sidecarred at most once, so the `-2` uniquification and
     * the `MAX_SIDECAR_ATTEMPTS` exhaustion path can only fire against sidecars
     * left by an *earlier* run carrying the same millisecond-precision stamp.
     * Without a fixed stamp a test can only try to race the clock, which is not
     * evidence: with `COPYFILE_EXCL` deleted, "two merges produce different
     * sidecar names" still passed 8 runs in 10, because the names differed by
     * milliseconds rather than by the guard.
     */
    __sidecarStamp?: string;
}): Promise<WorkspaceMergeReport>;
//# sourceMappingURL=merge.d.ts.map