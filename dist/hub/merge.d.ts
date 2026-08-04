/** A file was left alone and the incoming copy parked beside it. */
export type SidecarReason = 
/** NUL byte in the first 8 KB on either side — `git merge-file` refuses these. */
"binary"
/** No usable `git merge-file` on this machine (missing, or too old for our invocation). */
 | "git-unavailable"
/** `git merge-file` was reachable but failed on this file; `detail` carries its stderr. */
 | "merge-failed";
/** A file the merge deliberately did not touch. */
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
    /** absent locally -> created */
    created: string[];
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
 * Resolution table (design §5.3); comparison is by sha256 content hash, never
 * mtime. This function **never deletes a file** and never resolves a conflict
 * by discarding one side: the worst case for any file is "local kept, incoming
 * parked beside it" or "both sides present between conflict markers".
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
}): Promise<WorkspaceMergeReport>;
//# sourceMappingURL=merge.d.ts.map