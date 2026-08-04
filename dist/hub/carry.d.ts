import { type DestinationBlock } from "./workspace.js";
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
 * The environment every `git` child in this codebase runs with — a copy of the
 * parent's, minus `SCRUBBED_GIT_ENV`. Exported because the decision is about
 * `git` children, not about carry: `identity.ts` decides carry-vs-snapshot from
 * `git remote -v`, `push.ts` offers `ls-files --ignored` output as a
 * `hubinclude` line to paste, and `merge.ts` runs `git merge-file` from a
 * scratch directory precisely to escape ambient repository config — an escape
 * `GIT_DIR` walks straight through (verified: a repo-local `merge.conflictStyle`
 * that merge-file rejects makes it exit 128 from the scratch dir when `GIT_DIR`
 * points at that repo).
 */
export declare function gitChildEnv(): NodeJS.ProcessEnv;
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
    /**
     * The first `MAX_REPORTED_REINCLUDED` of those paths, for the push warning —
     * a sample the user can recognize, not an inventory (`reIncludedCount` is the
     * true size). Deliberately capped rather than complete: `CarryMeta` is
     * embedded in the bundle manifest, and `hubinclude` can legitimately name
     * thousands of files, so a full list would put hundreds of KB of paths into
     * every manifest. The full set is re-derivable on the sending machine from
     * two files the user already has — `git ls-files --others --ignored
     * --exclude-standard` filtered by `.claude-sesh-mover/hubinclude`.
     */
    reIncluded: string[];
    /**
     * Gitignored files that are ALSO TRACKED and whose uncommitted changes are in
     * `changes.patch`. Nothing re-included these and no rule can drop them: every
     * filter this module applies — `.gitignore`, `hubignore`, the built-in
     * excludes — governs the UNTRACKED enumeration, while `git diff HEAD`
     * describes every tracked file that changed. A `.env` that was committed once
     * and gitignored later (without `git rm --cached`) is the common shape, and
     * its new value travels in plaintext in the patch.
     *
     * Reported separately from `reIncluded` on purpose: `reIncluded` means "you
     * opted in via hubinclude, remove the line to stop it", which is a remedy that
     * does nothing here. The remedy for these is `git rm --cached`, or `--no-carry`.
     */
    trackedIgnoredCount: number;
    /** The first `MAX_REPORTED_REINCLUDED` of those paths, for the push warning. */
    trackedIgnored: string[];
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
 *   committed, reviewable exception, and the only way an UNTRACKED gitignored
 *   file travels.
 *
 * What the filters do and do NOT cover, stated exactly because the short version
 * ("gitignored files never travel") is false in one direction: `.gitignore`,
 * `hubignore`, the built-in excludes and `hubinclude` all govern the UNTRACKED
 * enumeration. `git diff HEAD` describes every TRACKED file that changed, and no
 * user-facing rule filters it — a file that is gitignored AND tracked (committed
 * once, ignored later, never `git rm --cached`; or `git add -f`) carries its
 * uncommitted changes in full. `trackedIgnored` reports exactly that set rather
 * than leaving it to be inferred. The one filter that DOES apply to the patch is
 * `FLOOR_PATHSPEC`, the `NEVER_INCLUDABLE` floor, because a tracked
 * `.claude-sesh-mover/config.json` can redirect `hub.path` on the machine that
 * applies it.
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
/** Why a carry payload was not applied to the working tree. */
export type CarryApplyDeclineReason = 
/** `--apply-carry` was not passed. The payload is saved, never applied. */
"not-requested"
/** No runnable `git`. */
 | "no-git"
/** The target directory is not inside a git repository. */
 | "not-git"
/** The target's `HEAD` is not the commit the patch was captured against. */
 | "wrong-base"
/** The target has uncommitted changes to tracked files. */
 | "dirty-tree"
/** The target is mid-merge/rebase/cherry-pick/revert. */
 | "in-progress"
/**
 * The payload names paths that can never be written, or carries symlinks.
 * A verdict about the PAYLOAD, never about this machine's git — a receiver
 * whose `git` cannot read its own repository declines through the guard that
 * names that state instead (`not-git`/`no-git`), because the security wording
 * this reason carries would otherwise accuse a peer of the user's own
 * configuration problem.
 */
 | "unsafe-payload"
/**
 * `git apply --check`, `git apply`, or the `--numstat` parse refused it —
 * i.e. a working `git` on this machine could not use the patch. Nothing
 * unsafe was found in it; a parse refusal means a damaged or truncated
 * bundle, and the saved README says so rather than giving a command.
 */
 | "apply-failed";
/** What an applied carry did to the working tree. */
export interface CarryApplied {
    applied: true;
    /** File entries in `changes.patch`. `0` means the payload was untracked files only. */
    filesChanged: number;
    /** Untracked files written. Excludes collisions, refusals and blocks below. */
    untrackedCopied: number;
    /**
     * Payload paths that already existed here with DIFFERENT bytes. The local
     * file is untouched and the incoming copy sits beside it as
     * `<name>.incoming-<stamp>`. Identical content is a silent no-op, not a
     * collision.
     */
    collisions: string[];
    /**
     * Payload paths refused because they name plugin or VCS internals
     * (`NEVER_INCLUDABLE`) at some segment, in some casing or dot/space spelling.
     * Nothing from them was written. A current sesh-mover never produces such a
     * payload; callers must report these without naming a culprit (see
     * `unpackWorkspace`'s `refused` for the same argument).
     */
    refused: string[];
    /**
     * Payload paths not written because of what already occupies them HERE — a
     * symlink on the path (never written through) or a directory where a file
     * belongs — plus any that failed to copy. Nothing was written near them.
     */
    blocked: Array<{
        path: string;
        reason: DestinationBlock | "io-error";
    }>;
}
export interface CarryNotApplied {
    applied: false;
    reason: CarryApplyDeclineReason;
    detail: string;
    /**
     * Where the whole payload was written instead — patch, untracked tree,
     * `carry.json`, a `README.md` of manual steps and a self-ignoring
     * `.gitignore`. `null` only when even that could not be written, which is the
     * one branch where the payload is genuinely lost and the caller must say so.
     */
    savedTo: string | null;
}
export type ApplyResult = CarryApplied | CarryNotApplied;
export interface ApplyCarryOptions {
    /** The extracted `<bundle>/carry` directory. */
    carryDir: string;
    /** Where the project lives on THIS machine. */
    targetPath: string;
    meta: CarryMeta;
    /**
     * Save the payload without touching the working tree — what a pull does when
     * `--apply-carry` was not passed. Saving rather than reporting-and-dropping
     * is deliberate: a pull records its bundles as received, so re-running it
     * with the flag answers "Already up to date" and the payload would be gone
     * for good (the extraction directory is removed when the pull returns).
     */
    saveOnly?: boolean;
    /** Test seam: pin the stamp naming saved directories and sidecars. */
    __stamp?: string;
}
/**
 * Apply a pulled carry payload to this machine's working tree (design §6.2).
 *
 * Writing another machine's uncommitted work into a real git repository is the
 * sharpest thing this plugin does, so every guard runs BEFORE any mutation and
 * any doubt degrades to "here is your patch, apply it yourself" rather than to
 * a half-applied working tree.
 *
 * The guards are not a checklist, they are what makes the operation
 * REVERSIBLE: with `HEAD` equal to the captured base and no uncommitted changes
 * to tracked files, everything this function writes can be undone with `git
 * checkout -- .` plus deleting the files it reports copying. That is also why a
 * patch DELETING a tracked file is safe to apply — the bytes are in `HEAD`.
 * Weaken either guard and that stops being true.
 *
 * What is deliberately NOT a guard: untracked files. `git status --porcelain`
 * lists them by default, and `pull` plants `.claude-sesh-mover/project.json`
 * into the project earlier in the same run, so counting them as dirt would
 * refuse every hub-linked git project that has not committed the plugin
 * directory — permanently, since the payload is never offered twice. They are
 * safe to leave out: `git apply` refuses to create a file that already exists
 * (measured, and `--check` catches it), and the untracked copy path never
 * overwrites.
 *
 * The patch is applied to the WORKING TREE only, never `--index`: it arrives as
 * uncommitted work and it stays uncommitted work, which is also what keeps
 * `git checkout -- .` a complete undo.
 */
export declare function applyCarry(opts: ApplyCarryOptions): Promise<ApplyResult>;
//# sourceMappingURL=carry.d.ts.map