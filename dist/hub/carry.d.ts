/**
 * Byte budget for one carry payload: the diff plus every file copied beside it.
 *
 * Over budget the WHOLE carry is declined rather than trimmed. A partial
 * payload is the worse failure: the apply side (§6.2) copies untracked files
 * into the peer's tree, and half a dependency tree or half a generated
 * directory reads there as a corrupt install, not as a truncated upload. The
 * decline names the largest contributors so the offending `hubinclude` line is
 * obvious.
 */
export declare const CARRY_MAX_BYTES: number;
/**
 * A git operation the working tree is in the middle of. Recorded, never used to
 * refuse capture: the half-finished state IS the user's uncommitted work, and
 * dropping it silently would be the surprise. The apply side needs to know,
 * though — a patch taken mid-conflict carries `<<<<<<<` markers as ordinary
 * content, and the operation itself (MERGE_HEAD, the rebase todo list) does not
 * travel.
 *
 * `rebase` also covers `git am`, which shares the `rebase-apply` directory.
 */
export type GitOperationInProgress = "merge" | "rebase" | "cherry-pick" | "revert";
/** Why a push carried no uncommitted work. */
export type CarryDeclineReason = 
/** Not a git repository at all (or no runnable `git`). */
"not-git"
/** A real repository, but with no commit yet — so there is no base to describe changes against. */
 | "no-commits"
/** Nothing to carry once the carry rules have had their say. */
 | "clean"
/** Payload over `CARRY_MAX_BYTES`; nothing was written. */
 | "too-large"
/** A `git` invocation failed after HEAD had already resolved. */
 | "git-failed"
/** The payload could not be written to the bundle; nothing was left behind. */
 | "write-failed";
export interface CarryMeta {
    /** `git rev-parse HEAD` at capture time — the commit the patch applies to. */
    baseCommit: string;
    /** Branch name, or git's own spelling `HEAD` when detached (see `detached`). */
    branch: string;
    /** HEAD is not on a branch: mid-rebase, a `git checkout <sha>`, or a bisect. */
    detached: boolean;
    /** An operation the tree is in the middle of, if any — see `GitOperationInProgress`. */
    inProgress: GitOperationInProgress | null;
    capturedAt: string;
    /** Files under `carry/untracked/`, after the carry rules and after symlinks/directories are dropped. */
    untrackedCount: number;
    /** Total size of those files. */
    untrackedBytes: number;
    /** Size of `carry/changes.patch`. `0` is normal and means "untracked files only". */
    patchBytes: number;
    /**
     * How many carried files are gitignored and travelled only because
     * `hubinclude` names them. `.gitignore` is where `.env` lives, so this is the
     * security-relevant subset and it is stated rather than left to be inferred.
     */
    reIncludedCount: number;
    /** The first `MAX_REPORTED_REINCLUDED` of those paths, for the push warning. */
    reIncluded: string[];
    /**
     * `git rev-parse --show-prefix`: non-empty when the project directory is a
     * SUBDIRECTORY of the repository. The patch is then scoped to that subtree
     * and its paths are relative to it, so it applies at the project path — not
     * at the repository root.
     */
    repoPrefix: string;
}
export type CaptureResult = {
    captured: false;
    reason: CarryDeclineReason;
    detail?: string;
} | {
    captured: true;
    meta: CarryMeta;
};
export interface CaptureCarryOptions {
    /**
     * Somewhere to put anything that silently shrank the payload — an over-cap
     * `hubinclude`, an unreadable file. Every one of them fails CLOSED, which
     * from the outside is indistinguishable from "my files stopped syncing".
     * `hubPush` threads these into the push's `warnings` (same contract as
     * `readHubinclude`'s `diagnostics`).
     */
    diagnostics?: string[];
    /** Override `CARRY_MAX_BYTES` (tests; keeps the budget assertions cheap). */
    maxBytes?: number;
}
/**
 * Capture this project's uncommitted work into `destDir` (design §6.1).
 *
 * Uncommitted work rides the bundle so the other machine can pick up exactly
 * where this one left off, without pushing half-baked commits to a branch. The
 * payload is `carry.json` + `changes.patch` + `untracked/<relpaths…>`, and it
 * is written only if the whole thing fits the budget — a declined capture
 * leaves nothing behind, because a `carry/` directory with no manifest entry
 * would ship files the puller has no metadata for.
 *
 * What travels:
 *
 * - `git diff HEAD --binary --relative`: staged AND unstaged changes to tracked
 *   files, including deletions, mode changes, `git add -N` intents and binary
 *   files. `--relative` scopes the patch to the project directory and makes its
 *   paths relative to it, which matters whenever the project is a subdirectory
 *   of a larger repository: without it the patch describes the whole repo with
 *   repo-root-relative paths while the untracked list (which git already scopes
 *   to the cwd) describes just this subtree, and neither half applies.
 * - untracked, non-ignored files, minus what the carry rules drop.
 * - every gitignored path `hubinclude` names (design §6.0) — the deliberate,
 *   committed, reviewable exception, and the ONLY way a gitignored file travels.
 *
 * The patch is handled as BYTES from end to end. `git diff` writes a text
 * file's raw bytes into the patch body, so a file that is not valid UTF-8 (a
 * latin-1 `.txt`, say) is mangled by a decode/encode round trip and git then
 * refuses the result outright: measured, `git apply --check` fails with "patch
 * does not apply" on a patch that applies byte-for-byte before the round trip.
 *
 * `changes.patch` is always written, even at zero bytes (untracked files only),
 * so the layout never varies — but note for the apply side that `git apply`
 * REFUSES an empty patch (`error: No valid patches in input`, exit 128), so
 * `patchBytes === 0` must skip the `git apply` step rather than treat its
 * failure as a reason to fall back.
 */
export declare function captureCarry(projectPath: string, destDir: string, opts?: CaptureCarryOptions): Promise<CaptureResult>;
//# sourceMappingURL=carry.d.ts.map