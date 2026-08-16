import { type DestinationBlock } from "./workspace.js";
/**
 * Byte budget for one carry payload: the diff plus every file copied beside it.
 *
 * Over budget the WHOLE carry is declined rather than trimmed. A partial
 * payload is the worse failure: the apply side (§6.2) copies untracked files
 * into the peer's tree, and half a dependency tree or half a generated
 * directory reads there as a corrupt install, not as a truncated upload. The
 * decline names the largest contributors so the offending `.sesh-mover-include` line is
 * obvious.
 *
 * This is the FALLBACK for a caller that passes no budget. The real one comes
 * from `hub.carryMaxMb` and reaches here through `captureCarry`'s `maxBytes` —
 * which matters because the decline is not retryable on demand (the carry rides
 * a bundle, and an immediate re-push answers `upToDate`), and because the
 * SessionEnd auto-push takes no flags, so config is the only lever there.
 *
 * It was 5 MB, on the reasoning that a carry is a *diff* of uncommitted work
 * where 5 MB already means generated artifacts. Measured against reality that
 * was simply wrong: this repository's own `.superpowers/` working notes are
 * ~12.6 MB of untracked, non-gitignored files the owner deliberately wants
 * carried, so the carry declined on the very repository that produced the tool.
 */
export declare const CARRY_MAX_BYTES: number;
/**
 * The environment every `git` child in this codebase runs with — a copy of the
 * parent's, minus `SCRUBBED_GIT_ENV`. Exported because the decision is about
 * `git` children, not about carry: `identity.ts` decides carry-vs-snapshot from
 * `git remote -v`, `push.ts` offers `ls-files --ignored` output as a
 * `.sesh-mover-include` line to paste, and `merge.ts` runs `git merge-file` from a
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
/** Payload over the carry budget; nothing was written. */
 | "too-large"
/** The carry budget is `0` — an explicit "carry nothing". Nothing was attempted. */
 | "budget-disabled"
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
     * `.sesh-mover-include` names them. `.gitignore` is where `.env` lives, so this is the
     * security-relevant subset and it is stated rather than left to be inferred.
     */
    reIncludedCount: number;
    /**
     * The first `MAX_REPORTED_REINCLUDED` of those paths, for the push warning —
     * a sample the user can recognize, not an inventory (`reIncludedCount` is the
     * true size). Deliberately capped rather than complete: `CarryMeta` is
     * embedded in the bundle manifest, and `.sesh-mover-include` can legitimately name
     * thousands of files, so a full list would put hundreds of KB of paths into
     * every manifest. The full set is re-derivable on the sending machine from
     * two files the user already has — `git ls-files --others --ignored
     * --exclude-standard` filtered by `.sesh-mover-include`.
     */
    reIncluded: string[];
    /**
     * Gitignored files that are ALSO TRACKED and whose uncommitted changes are in
     * `changes.patch`. Nothing re-included these and no rule can drop them: every
     * filter this module applies — `.gitignore`, `.sesh-mover-ignore`, the built-in
     * excludes — governs the UNTRACKED enumeration, while `git diff HEAD`
     * describes every tracked file that changed. A `.env` that was committed once
     * and gitignored later (without `git rm --cached`) is the common shape, and
     * its new value travels in plaintext in the patch.
     *
     * Reported separately from `reIncluded` on purpose: `reIncluded` means "you
     * opted in via the include list, remove the line to stop it", which is a remedy that
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
     * `.sesh-mover-include`, an unreadable file. Every one of them fails CLOSED, which
     * from the outside is indistinguishable from "my files stopped syncing".
     * `hubPush` threads these into the push's `warnings` (same contract as
     * `readIncludePatterns`'s `diagnostics`).
     */
    diagnostics?: string[];
    /**
     * The byte budget for this capture, overriding `CARRY_MAX_BYTES`.
     *
     * `hub/push.ts` passes the user's resolved `hub.carryMaxMb` through here, so
     * this is the production path, not only a test seam. `0` declines everything
     * (see `captureCarry`); tests use small values to keep budget assertions
     * cheap.
     */
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
 * - every gitignored path `.sesh-mover-include` names (design §6.0) — the deliberate,
 *   committed, reviewable exception, and the only way an UNTRACKED gitignored
 *   file travels.
 *
 * What the filters do and do NOT cover, stated exactly because the short version
 * ("gitignored files never travel") is false in one direction: `.gitignore`,
 * `.sesh-mover-ignore`, the built-in excludes and `.sesh-mover-include` all govern the UNTRACKED
 * enumeration. `git diff HEAD` describes every TRACKED file that changed, and no
 * user-facing rule filters it — a file that is gitignored AND tracked (committed
 * once, ignored later, never `git rm --cached`; or `git add -f`) carries its
 * uncommitted changes in full. `trackedIgnored` reports exactly that set rather
 * than leaving it to be inferred. The one filter that DOES apply to the patch is
 * `FLOOR_PATHSPEC`, the `NEVER_INCLUDABLE` floor, because a tracked
 * `.sesh-mover/config.json` can redirect `hub.path` on the machine that
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
/** Git's own answer to "what does this patch touch", split by how it was learned. */
interface GitPatchPaths {
    /** One per patch entry, from `--numstat`: the path git writes, deletes or chmods. */
    destinations: string[];
    /** Rename and copy SOURCES, from `--summary` — the half `--numstat` never prints. */
    sources: string[];
    /**
     * `--summary` lines this parser could not account for. Non-empty means git's
     * description of the patch was not read in full, so the floor cannot answer
     * for every path and the caller must refuse the payload whole.
     */
    unreadable: string[];
}
/**
 * Read `git apply --numstat -z --summary` output into the set of paths the
 * patch touches — the SINGLE authoritative source for the apply-side floor
 * (issue #38).
 *
 * The two halves and why both are needed (all measured on git 2.43.0):
 *
 * - **`--numstat -z`** prints one record per patch entry, `<added>\t<deleted>\t
 *   <path>`, NUL-terminated. The path is the one git will really write: already
 *   C-unquoted, already `-p`-stripped, and already composed with `--directory=`
 *   (measured: `--directory=sub/` turns `docs/notes.txt` into
 *   `sub/docs/notes.txt` in this output). `-z` also means it is never re-quoted,
 *   whatever `core.quotePath` says. It covers every entry shape the byte scan
 *   was written for — a mode-only change, a binary entry, an empty-file
 *   creation, a deletion — because those all have an entry, and every entry has
 *   a record. A path may itself hold TABs (`rename to X<TAB>sub/…` is a name git
 *   accepts), so the third field onward is re-joined rather than taken as one.
 * - **`--summary`** supplies the ONE path `--numstat` structurally omits: a
 *   rename's or copy's SOURCE. `--numstat` prints only the destination for
 *   both, which is what let `copy from .sesh-mover-include` / `copy to
 *   stolen.txt` materialise the RECEIVER's own plugin internals at an ordinary
 *   path. `--summary` prints ` copy .sesh-mover-include => stolen.txt (100%)`,
 *   including for `rename old`/`rename new`, git's legacy spelling — so git's
 *   own parse now answers the keyword family that had to be hand-listed before.
 *   Its lines follow the NUL-terminated records and are `\n`-separated even
 *   under `-z`, hence the `pop()`.
 *
 * Together they name every path the apply can touch, because both are printed
 * from the same in-memory patch list the apply walks (see `applyInvocation`).
 * There is no third half to miss: a delete's `old_name`, a mode change's and a
 * rewrite's name are each what `--numstat` already prints for that entry.
 */
declare function parseApplyPaths(stdout: string): GitPatchPaths;
/**
 * Git's own parse of a patch, exposed for `tests/hub-carry-header.test.ts` —
 * which uses it as the ORACLE it cross-checks the byte scan against, so the
 * harness measures the code that actually enforces the floor rather than a
 * second copy of it. Named `__`-first like the module's other test seams.
 */
export { parseApplyPaths as __parseApplyPathsForTests };
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
    /**
     * Whether that saved `README.md` carries the commands to finish by hand.
     *
     * Two declines deliberately WITHHOLD them — `unsafe-payload` (the floor or
     * the symlink check fired) and an `apply-failed` whose patch `git apply`
     * could not parse — so a caller that promises "a README with the exact
     * commands" on every decline sends the user looking for something that was
     * withheld on purpose. `false` whenever `savedTo` is `null`, since there is
     * no README then either.
     */
    savedCommands: boolean;
    /**
     * Payload paths dropped from the SAVED copy because they name plugin or VCS
     * internals (`NEVER_INCLUDABLE`) — the same floor, and the same reporting
     * rule, as `CarryApplied.refused`.
     *
     * It is not a duplicate of that field: the saved README tells the user to
     * `cp -R '<saved>/untracked/.' .`, which copies dot-entries, so a saved
     * `.git/hooks/pre-commit` would be planted by following our own instructions
     * on the path that never applies anything. Empty on every payload a current
     * sesh-mover produces, and empty when `savedTo` is `null`.
     */
    refused: string[];
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
 * Everything the apply side has to know about a patch before it may run.
 *
 * Two things are being decided, and neither can be delegated to `git apply`:
 *
 * 1. **The `NEVER_INCLUDABLE` floor.** `git apply` refuses `.git/…` and `..`
 *    traversal itself (measured: exit 128, "invalid path"), but it writes
 *    `.sesh-mover/config.json` — and `.sesh-mover./config.json` —
 *    without a murmur. The capture side's `FLOOR_PATHSPEC` closes the ordinary
 *    case, but its `icase` mirrors only the CASE half of `isNeverSegment`: no
 *    pathspec spelling folds trailing dots and whitespace without also
 *    swallowing `.sesh-moverX`. An older sesh-mover, a hand-made bundle
 *    and that trailing-dot spelling all arrive here, and the prize is the file
 *    deciding what this machine's NEXT push ships plus the project-scope
 *    `config.json` that redirects `hub.path`.
 * 2. **Symlink entries.** A STAGED symlink enters `git diff HEAD` as `new file
 *    mode 120000` with its target as content, and `git apply` MATERIALISES it
 *    (measured: `evil -> /etc/hosts` on the peer). The untracked copy path
 *    drops symlinks via `lstat`; the patch path has no such guard.
 *
 * Both are answered by refusing the WHOLE patch rather than filtering it: a
 * partially applied patch is worse than none, and `git apply --exclude` would
 * leave exactly that.
 *
 * **What this function is FOR, since issue #38 (read this before extending it).**
 * It is no longer the floor. `parseApplyPaths` is — git's own description of the
 * patch, printed from the same in-memory list the apply walks — and it answers
 * at every point where anything can be written. This scan keeps exactly two
 * jobs, and both of them were measured rather than assumed:
 *
 * 1. **SYMLINK entries, unconditionally.** This is enforcement and it is the
 *    one thing git's own output cannot supply. `--summary` names three of the
 *    four shapes (` create mode 120000 …`, ` delete mode 120000 …`, ` mode
 *    change 100644 => 120000 …`) but prints NOTHING AT ALL for a re-pointed
 *    symlink — an `index <a>..<b> 120000` entry whose mode does not change
 *    (measured: the whole output is the one numstat record). The `120000`
 *    matches below carry no path semantics — no quoting, no termination rule,
 *    no separator class — so none of the parsing hazards that made the path
 *    half a liability apply to them.
 * 2. **The path half, as a LAST RESORT where git could not parse the patch** —
 *    no runnable `git`, a `git` that cannot read this repository, a `git` that
 *    refused these bytes. Nothing is ever applied on any of those paths (see the
 *    `gitFloorAnswered` gate in `applyCarry`), so what it decides there is the
 *    saved README's wording: whether the copy the user is told to apply by hand
 *    may carry a command at all. That is a human-facing recommendation, and it
 *    is why the four areas issue #38 names as unswept — `--directory=`
 *    composition, CRLF per keyword, `GIT binary patch` bodies, Unicode folding —
 *    stopped being security questions. They are not gone; they cost a README
 *    that fails to warn on a machine with no git, not a file on disk.
 *
 * Where git DID parse the patch this scan's path half says nothing, which also
 * ends its over-refusals: `diff --git .sesh-mover/x .sesh-mover/x` resolves to
 * `x` for git (the `-p1` strip), and a payload git will write as `x` is no
 * longer refused for a spelling git discarded.
 *
 * The two readings it covers, for the last-resort case: every path git can name
 * in a header — `---`/`+++`, `rename from`/`to`, **`rename old`/`new`**,
 * `copy from`/`to`, and the `diff --git` line itself (the only reference a
 * mode-only change or a binary entry has) — plus the `120000` mode lines above.
 *
 * The list of spellings is not a guess and not "what `git diff` emits" — it is
 * git's own `parse_git_header` keyword table, read out of the shipped binary
 * (`strings`, git 2.50.1). Sixteen entries; the nine path-bearing ones are the
 * nine above. `similarity index`, `dissimilarity index`, `index` and the four
 * mode lines carry no path. **`rename old `/`rename new ` are git's legacy
 * spelling of `rename from`/`to`, and it still accepts them** — measured: an
 * otherwise identical payload deleted `.sesh-mover-include` and
 * created `moved.txt`, `applied: true`, at BOTH layouts, on a receiver with a
 * perfectly healthy `git`, because `--numstat` prints only a rename's
 * destination and the scan did not read the source line.
 *
 * **The nine do not share one termination rule**, and assuming they did was a
 * hole of its own: only `---`/`+++` are read with `TERM_TAB`, and even they drop
 * it when a traditional patch line carries a trailing timestamp. See
 * `HeaderLineKind`.
 *
 * A body line cannot be mistaken for a header: every one carries a leading
 * ` `, `+`, `-`, `@` or `\`, and no base85 line inside a `GIT binary patch`
 * block can contain a space (it is not in the alphabet), so none of the header
 * spellings below can occur inside one. The residual is a patch that DELETES a
 * line spelled `-- a/…`, which reads as a header path — a false positive, i.e.
 * a refusal, which is the safe direction.
 *
 * **How this stays right: `tests/hub-carry-header.test.ts` is a DIFFERENTIAL
 * test, not a matrix.** Three consecutive review rounds each closed a
 * hand-listed family of header spellings and each missed the next one, so the
 * spellings are now generated mechanically over the axes that produced the
 * holes (separator bytes, quoting symmetry, escape spelling, prefix pairs,
 * trailing bytes, every path-bearing keyword) and each one is cross-checked
 * against real `git apply --numstat -z --summary` on a scratch repo, read by
 * `parseApplyPaths` — the production parser, so the harness measures the code
 * that enforces the floor rather than a second copy of it. The invariant it
 * enforces is the one this function still owes its last-resort caller: **if git
 * resolves a spelling to a path the floor forbids, this scan produces a
 * candidate the floor forbids.** Add an axis value there when a new spelling
 * shows up; do not add a case to a list here.
 */
declare function scanPatchBytes(patchPath: string): {
    paths: string[];
    symlink: string | null;
} | null;
/**
 * The raw byte scan, exposed for `tests/hub-carry-header.test.ts` — the
 * differential harness that cross-checks it against real `git apply` output
 * spelling by spelling. Named `__`-first like the module's other test seams
 * (`__stamp`): it is not part of the plugin's supported surface, and nothing in
 * `src/` calls it through this name.
 */
export { scanPatchBytes as __scanPatchBytesForTests };
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
 * lists them by default, and `pull` plants `.sesh-mover-project.json`
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