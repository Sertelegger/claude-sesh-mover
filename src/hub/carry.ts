import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  formatBytes, isCarriedPath, isReIncluded, NEVER_INCLUDABLE, readCarryRules, type CarryRules,
} from "./workspace.js";

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
export const CARRY_MAX_BYTES = 5 * 1024 * 1024;

/**
 * What one carried FILE costs against the budget, on top of its bytes.
 *
 * A pure byte budget bounds the wrong thing: 200,000 zero-byte files measure
 * zero and sail through, then cost a copy syscall here, a tar header each, and
 * a file the peer has to write on every pull. `hubinclude: *` over a tree of
 * tiny generated files is exactly that shape. 512 bytes is one tar header —
 * small enough to be invisible for ordinary files (a 20 KB source file moves
 * the needle by 2.5%), decisive for a payload made of nothing but entries.
 */
const CARRY_PER_FILE_BYTES = 512;

/**
 * `git diff` is a PORCELAIN command: it renders for a human by default and the
 * user's own configuration decides what that means. Every one of these flags
 * closes a measured way an ordinary developer's config turns the patch into
 * something `git apply` cannot use — or, worse, into something it CAN use that
 * writes the wrong bytes (git 2.50.1, each reproduced):
 *
 * - `--no-ext-diff` — `diff.external` (and `GIT_EXTERNAL_DIFF`) replaces the
 *   patch wholesale with another program's output. A stub echoing one line
 *   produced a "patch" consisting of that line. Anyone using difftastic or
 *   difftool-style drivers has this set.
 * - `--no-textconv` — a `.gitattributes` `diff=<driver>` with a `textconv`
 *   filter diffs the CONVERTED text, so the patch reads `-V2/+V3` for a file
 *   whose real bytes are `v2/v3`. That patch applies cleanly and writes the
 *   transformed content into the peer's file: silent corruption, the worst
 *   shape of the five.
 * - `--no-color` — `color.diff = always` injects ANSI escapes into the body.
 * - `--src-prefix=a/ --dst-prefix=b/` — `diff.noprefix` drops the `a/`/`b/`
 *   prefixes (`git apply --check` then fails outright: "git diff header lacks
 *   filename information when removing 1 leading pathname component"), and
 *   `diff.mnemonicPrefix` renames them to `c/` and `w/`, which `-p1` strips
 *   into the wrong path. Deliberately NOT `--default-prefix`, which says the
 *   same thing but only exists in git 2.41+; these two are ancient.
 * - `-U3` — `diff.context = 0` produces hunks with no context at all
 *   (`@@ -5 +5 @@`), and `git apply --check` REFUSES them ("while searching
 *   for: …"); only `--unidiff-zero`, which the apply side must not be forced
 *   into, recovers such a patch. Note `GIT_DIFF_OPTS=-u0` says the same thing
 *   and git documents it as taking precedence over `-U`, so it is scrubbed from
 *   the child environment instead (see `SCRUBBED_GIT_ENV`).
 * - `--submodule=short` — `diff.submodule = log` (a widely recommended setting)
 *   renders a submodule pointer change as prose — `Submodule sub f99b19..c9763b:`
 *   with no `diff --git` header at all. On a patch that also touches ordinary
 *   files `git apply --check` PASSES and the pointer change is silently
 *   dropped; on a submodule-only change the whole patch is junk.
 * - `--ignore-submodules=none` — `diff.ignoreSubmodules = all` makes submodule
 *   changes vanish outright, so a tree whose only uncommitted work is a
 *   submodule pointer move is captured as `clean`.
 *
 * Task 7 met this class with `git merge-file` and could fix it by running from
 * a directory inside no repository. That escape does not exist here — the
 * command's whole job is to read THIS repository — so the flags are the fix.
 */
const PATCH_HARDENING = [
  "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/",
  "-U3", "--submodule=short", "--ignore-submodules=none",
];

/**
 * The `NEVER_INCLUDABLE` floor, expressed as `git` pathspecs.
 *
 * `isCarriedPath` filters the UNTRACKED enumeration; nothing filtered the patch,
 * and `git diff HEAD` happily describes changes to a TRACKED
 * `.claude-sesh-mover/config.json` (which can redirect `hub.path`) or
 * `.claude-sesh-mover/hubinclude` (which decides what the next push ships).
 * Committing that directory is what this project's own docs RECOMMEND, so the
 * shape is ordinary rather than exotic — and while today's pull ignores the
 * carry payload entirely, §6.2's `git apply` will not, and a patch is not
 * filtered by the untracked copy path's guard.
 *
 * Two spellings per name because they answer different questions: `**\/<name>`
 * catches a plain FILE with that name at any depth, `**\/<name>\/**` catches
 * everything inside a directory with that name at any depth (the backslashes
 * are this comment's, not the pathspec's). `icase` mirrors
 * `isNeverSegment`, which folds case because a `.GIT` store works on a
 * case-folding filesystem. Verified on git 2.50.1 to compose with `--relative`
 * (the pathspecs are cwd-relative, so a project that is a repo SUBDIRECTORY
 * excludes its own plugin directory, not the repo root's).
 *
 * `:(exclude)` magic is git 1.9+ (2014), `:(icase)`/`:(glob)` 1.8.5.
 */
const FLOOR_PATHSPEC = [
  "--",
  ".",
  ...NEVER_INCLUDABLE.flatMap((name) => [
    `:(exclude,icase,glob)**/${name}`,
    `:(exclude,icase,glob)**/${name}/**`,
  ]),
];

/**
 * Environment variables stripped from every `git` child this module spawns.
 *
 * The flags above pin how git RENDERS a diff, but a flag cannot answer an
 * environment variable that git documents as beating it, and none of them
 * answers an environment variable that points git at a different repository.
 * Inheriting the parent environment wholesale is therefore not a neutral
 * default, so the child's environment is decided here rather than assumed. The
 * dividing line: strip what REDIRECTS the repository/index or ALTERS rendering,
 * keep what merely describes the user's own configuration.
 *
 * Stripped, and why (all measured on git 2.50.1):
 *
 * - `GIT_DIFF_OPTS` — documented to take precedence over `-U`. `GIT_DIFF_OPTS=-u0`
 *   defeats `-U3` and produces a patch `git apply` refuses. There is no flag
 *   that beats it; removing it is the only fix.
 * - `GIT_EXTERNAL_DIFF` — belt and braces. `--no-ext-diff` does neutralize it
 *   (verified: a stub that prints `PWNED` is ignored with the flag, obeyed
 *   without it), but a variable that can replace the payload wholesale should
 *   not be one flag away from doing so.
 * - `GIT_LITERAL_PATHSPECS` / `GIT_GLOB_PATHSPECS` / `GIT_NOGLOB_PATHSPECS` /
 *   `GIT_ICASE_PATHSPECS` — these reinterpret `FLOOR_PATHSPEC`.
 *   `GIT_LITERAL_PATHSPECS=1` turns off pathspec magic entirely, so
 *   `:(exclude,icase,glob)**\/.claude-sesh-mover` reads as a literal filename and
 *   the floor SILENTLY stops excluding anything (verified).
 * - `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` / `GIT_INDEX_FILE` /
 *   `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` /
 *   `GIT_NAMESPACE` / `GIT_PREFIX` — these override `cwd`, and `captureCarry`'s
 *   entire contract is "the repository at THIS project path". Git sets several
 *   of them in the children it spawns, so they arrive for free in anything run
 *   from a git hook or `git rebase --exec` (verified: with `GIT_DIR` set,
 *   `rev-parse --absolute-git-dir` answers the other repository, and a stale
 *   `GIT_INDEX_FILE` changes which files `git diff HEAD` reports).
 * - `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>` /
 *   `GIT_CONFIG_VALUE_<n>` — how git propagates `-c` into its own children, i.e.
 *   a transient per-invocation config injection inherited from whatever ran us.
 *
 * Deliberately KEPT: `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`,
 * `GIT_CONFIG_SYSTEM`. They name the user's persistent configuration, and
 * `--exclude-standard` reads `core.excludesFile` from it — dropping them would
 * change which files count as untracked, in the direction of carrying MORE.
 * Also kept: `GIT_CEILING_DIRECTORIES` and `GIT_DISCOVERY_ACROSS_FILESYSTEM`,
 * which say where the user considers repositories to live and can never point
 * us at a different one.
 */
const SCRUBBED_GIT_ENV: readonly string[] = Object.freeze([
  "GIT_DIFF_OPTS", "GIT_EXTERNAL_DIFF",
  "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
  "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
]);

/** Prefixed families that go with `GIT_CONFIG_COUNT` (`GIT_CONFIG_KEY_0`, …). */
const SCRUBBED_GIT_ENV_PREFIXES: readonly string[] = Object.freeze([
  "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_",
]);

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
export function gitChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of SCRUBBED_GIT_ENV) delete env[name];
  for (const name of Object.keys(env)) {
    if (SCRUBBED_GIT_ENV_PREFIXES.some((p) => name.startsWith(p))) delete env[name];
  }
  return env;
}

/** Long enough for a huge working tree, short enough to never wedge a push. */
const GIT_TIMEOUT_MS = 15_000;

/** `reIncluded` is a sample the user can recognize, not an inventory. */
const MAX_REPORTED_REINCLUDED = 10;

/** How many "this is what filled the budget" paths a decline names. */
const MAX_REPORTED_LARGEST = 3;

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
  | "not-git"
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

export type CaptureResult =
  | { captured: false; reason: CarryDeclineReason; detail?: string }
  | { captured: true; meta: CarryMeta };

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

type GitResult =
  | { ok: true; stdout: Buffer }
  | { ok: false; status: number | null; code: string | number | undefined; stderr: string };

/**
 * One `git` invocation, as a value rather than an exception.
 *
 * `maxBuffer` is a budget, not a safety margin: the caller sets it to
 * `maxBytes + 1` so an over-budget diff is REFUSED rather than buffered. Node
 * kills the child with SIGTERM and reports `ENOBUFS` in that case, which is
 * harmless for the read-only commands used here.
 */
function git(cwd: string, args: string[], maxBuffer: number): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      // Not the inherited environment: see SCRUBBED_GIT_ENV. Two of the
      // variables it removes can silently defeat the flags this module relies
      // on (GIT_DIFF_OPTS beats -U3, GIT_LITERAL_PATHSPECS disables the floor
      // pathspec), and several point git at a different repository entirely.
      env: gitChildEnv(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
      // stderr is captured, not discarded: it is the only thing that can tell a
      // user (or a reviewer) why a carry declined.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (e) {
    const err = e as {
      status?: number | null; code?: string | number; stderr?: Buffer | string;
    };
    return {
      ok: false,
      status: typeof err.status === "number" ? err.status : null,
      code: err.code,
      stderr: (err.stderr?.toString() ?? "").split("\n")[0]!.trim().slice(0, 200),
    };
  }
}

/**
 * Cap on a file LIST, sized for a pathological tree (~800k paths) rather than
 * for the payload budget: the list itself is cheap, and refusing to read it
 * would decline the carry for a reason the user cannot see.
 */
const LS_FILES_MAX_BUFFER = 32 * 1024 * 1024;

/** NUL-separated `git ls-files -z` output as paths. */
function splitZ(stdout: Buffer): string[] {
  return stdout.toString("utf-8").split("\0").filter((p) => p.length > 0);
}

/** A failed `git ls-files`, with ENOBUFS translated out of its libuv spelling. */
function listFailure(r: Extract<GitResult, { ok: false }>): CaptureResult {
  return {
    captured: false,
    reason: "git-failed",
    detail:
      r.code === "ENOBUFS"
        ? "this working tree lists too many untracked files to enumerate"
        : r.stderr || String(r.code ?? ""),
  };
}

/**
 * Which operation, if any, the working tree is in the middle of. Read from the
 * git directory (which is `.git/worktrees/<name>` in a linked worktree, hence
 * `--absolute-git-dir` rather than a hand-built path).
 */
function detectInProgress(gitDir: string): GitOperationInProgress | null {
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    return "rebase";
  }
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
  return null;
}

interface CarriedFile {
  rel: string;
  size: number;
  /** Gitignored, and here only because `hubinclude` names it. */
  reIncluded: boolean;
}

/**
 * Take the paths `git` handed us and keep the ones that may actually travel.
 *
 * Everything is filtered through `isCarriedPath`, which is the same rule the
 * workspace walk applies — including the `NEVER_INCLUDABLE` floor, which is
 * what stops `.claude-sesh-mover/config.json` (a file that can redirect
 * `hub.path`) and `.claude-sesh-mover/hubinclude` (the file deciding what the
 * NEXT push ships) from riding along as ordinary untracked files. They are
 * untracked and usually NOT gitignored, so nothing else would have stopped them.
 *
 * Two filesystem facts decide the rest, and both need `lstat`:
 *
 * - a symlink is never carried. `git ls-files --others` lists symlinks like any
 *   other entry, and a `stat`-based check follows them: a `key -> ~/.ssh/id_rsa`
 *   link would put the TARGET's bytes in the bundle.
 * - a directory is never carried. `git ls-files --others` emits exactly one
 *   directory shape — `vendor/lib/`, an untracked nested repository — and
 *   counting it as a file makes `untrackedCount` a lie.
 */
function collectFiles(
  projectPath: string,
  rels: Iterable<{ rel: string; reIncluded: boolean }>,
  rules: CarryRules,
  diagnostics: string[]
): CarriedFile[] {
  const files: CarriedFile[] = [];
  for (const { rel, reIncluded } of rels) {
    if (!isCarriedPath(rel, rules)) continue;
    let st;
    try {
      st = lstatSync(join(projectPath, rel));
    } catch {
      // Almost always a filename git reported in bytes this platform cannot
      // round-trip through UTF-8; occasionally a file deleted mid-push. Either
      // way it does not travel, and a silent omission is what this exists to
      // prevent.
      diagnostics.push(
        `Uncommitted file ${JSON.stringify(rel)} could not be read and was left out of this push's carry payload.`
      );
      continue;
    }
    if (!st.isFile()) continue; // symlink, directory (nested repo), socket, FIFO
    files.push({ rel, size: st.size, reIncluded });
  }
  return files;
}

/**
 * `a/b.txt 4.1 MB, c.bin 1.0 MB` — the biggest contributors to an over-budget
 * payload, or `""` when there are none worth naming.
 *
 * Zero-byte entries are dropped rather than listed: a payload that busts the
 * budget purely on the per-file term is made of empty files, and
 * `largest: many/f1 0 bytes, many/f10 0 bytes, many/f100 0 bytes` names three
 * arbitrary files and explains nothing. The caller omits the clause entirely in
 * that case, leaving the file COUNT — which is the actual cause — to speak.
 */
function describeLargest(files: CarriedFile[], patchBytes: number): string {
  const rows = files
    .map((f) => ({ label: f.rel, size: f.size }))
    .concat(patchBytes > 0 ? [{ label: "the uncommitted diff", size: patchBytes }] : [])
    .filter((r) => r.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_REPORTED_LARGEST);
  return rows.map((r) => `${r.label} ${formatBytes(r.size)}`).join(", ");
}

/**
 * Gitignored files that are also TRACKED and that the patch actually changes.
 *
 * This is the honest answer to "what gitignored content left my machine", and
 * it is not `reIncluded`: `hubinclude` had nothing to do with it and no
 * exclusion rule in this module can drop it, because every one of them filters
 * the untracked enumeration while the patch describes tracked files.
 *
 * Two `git` calls, and the second only ever runs on a repository that HAS
 * tracked-but-ignored files — which most do not, so the common case costs one
 * index scan. `git ls-files` is subtree-scoped and prints cwd-relative paths by
 * default, which is exactly what `--relative` makes the diff names, so the two
 * lists are directly comparable.
 */
function findTrackedIgnored(projectPath: string, diagnostics: string[]): string[] {
  const tracked = git(
    projectPath,
    ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"],
    LS_FILES_MAX_BUFFER
  );
  if (!tracked.ok) {
    diagnostics.push(
      "Could not determine whether any gitignored file is tracked and travelled in this push's patch " +
        `(${tracked.stderr || String(tracked.code ?? "git failed")}).`
    );
    return [];
  }
  const ignoredTracked = new Set(splitZ(tracked.stdout));
  if (ignoredTracked.size === 0) return [];
  const changed = git(
    projectPath,
    ["diff", "HEAD", "--name-only", "-z", "--relative", ...PATCH_HARDENING, ...FLOOR_PATHSPEC],
    LS_FILES_MAX_BUFFER
  );
  if (!changed.ok) {
    diagnostics.push(
      "Could not determine which gitignored tracked files travelled in this push's patch " +
        `(${changed.stderr || String(changed.code ?? "git failed")}).`
    );
    return [];
  }
  return splitZ(changed.stdout).filter((rel) => ignoredTracked.has(rel));
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
export async function captureCarry(
  projectPath: string,
  destDir: string,
  opts?: CaptureCarryOptions
): Promise<CaptureResult> {
  const diagnostics = opts?.diagnostics ?? [];
  const maxBytes = Math.max(1, opts?.maxBytes ?? CARRY_MAX_BYTES);

  // `--verify` so a failure is unambiguous: plain `rev-parse HEAD` prints
  // "HEAD" on stdout AND exits 128 when HEAD is unborn.
  const head = git(projectPath, ["rev-parse", "--verify", "HEAD"], 4096);
  if (!head.ok) {
    // Same failure for "not a repo" and "no commit yet", and the two want
    // different answers: a repo with a remote but no commits is a real project
    // whose push should say so, not one that quietly carries nothing.
    const inRepo = git(projectPath, ["rev-parse", "--absolute-git-dir"], 4096).ok;
    return inRepo
      // NOT git's own words here: `rev-parse --verify HEAD` says "fatal: Needed
      // a single revision", which surfaces in a push warning as a sentence no
      // user can act on.
      ? { captured: false, reason: "no-commits", detail: "this repository has no commits yet" }
      : { captured: false, reason: "not-git", detail: head.stderr };
  }
  const baseCommit = head.stdout.toString("utf-8").trim();

  // One invocation, two answers, in argument order (verified against git
  // 2.50.1): the absolute git dir, then the path prefix — empty at the repo
  // root. Both are diagnostics, so a failure degrades rather than declines.
  const where = git(projectPath, ["rev-parse", "--absolute-git-dir", "--show-prefix"], 64 * 1024);
  const [gitDir = "", repoPrefix = ""] = where.ok
    ? where.stdout.toString("utf-8").split("\n").map((l) => l.trim())
    : [];
  // `symbolic-ref` exits 1 with no output when HEAD is detached, which
  // `--abbrev-ref` cannot express — it answers the literal string "HEAD".
  const symref = git(projectPath, ["symbolic-ref", "--short", "-q", "HEAD"], 64 * 1024);
  const branch = symref.ok ? symref.stdout.toString("utf-8").trim() : "HEAD";

  const diff = git(
    projectPath,
    ["diff", "HEAD", "--binary", "--relative", ...PATCH_HARDENING, ...FLOOR_PATHSPEC],
    // +1 so a diff that exactly fills the budget is still measurable, and
    // anything past it is refused by Node instead of being buffered.
    maxBytes + 1
  );
  if (!diff.ok) {
    if (diff.code === "ENOBUFS") {
      return {
        captured: false,
        reason: "too-large",
        detail: `the uncommitted diff is larger than the ${formatBytes(maxBytes)} carry budget`,
      };
    }
    return { captured: false, reason: "git-failed", detail: diff.stderr || String(diff.code ?? "") };
  }
  const patch = diff.stdout;
  // Boundary guard, and deliberately kept even though the ENOBUFS branch above
  // absorbs almost every over-budget diff: with `maxBuffer = maxBytes + 1` the
  // only size that reaches here over budget is exactly `maxBytes + 1`. It is
  // the one place that stays correct if that bound is ever loosened.
  if (patch.length > maxBytes) {
    return {
      captured: false,
      reason: "too-large",
      detail: `the uncommitted diff is ${formatBytes(patch.length)}, over the ${formatBytes(maxBytes)} carry budget`,
    };
  }

  const untracked = git(
    projectPath,
    // -z is not a nicety: without it git applies core.quotePath, so a name with
    // a space, a quote or any non-ASCII byte comes back C-quoted and
    // octal-escaped — a spelling that never lstats, so the file would vanish
    // from the payload in silence.
    ["ls-files", "--others", "--exclude-standard", "-z"],
    LS_FILES_MAX_BUFFER
  );
  if (!untracked.ok) return listFailure(untracked);

  const rules = readCarryRules(projectPath, diagnostics);
  const candidates = new Map<string, boolean>(); // rel -> came from re-inclusion
  for (const rel of splitZ(untracked.stdout)) candidates.set(rel, false);

  // hubinclude re-adds deliberately-ignored paths (this repo's own
  // docs/superpowers is the canonical case). Everything else gitignored stays
  // put — .gitignore is also where secrets live, so inclusion is opt-in,
  // committed and reviewable. `isReIncluded` decides it, on the full
  // repo-relative path: re-deriving the rule here is how the two would drift.
  if (rules.includePatterns.length > 0) {
    const ignored = git(
      projectPath,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      LS_FILES_MAX_BUFFER
    );
    if (!ignored.ok) return listFailure(ignored);
    for (const rel of splitZ(ignored.stdout)) {
      if (!candidates.has(rel) && isReIncluded(rel, rules.includePatterns)) candidates.set(rel, true);
    }
  }

  const files = collectFiles(
    projectPath,
    [...candidates].map(([rel, reIncluded]) => ({ rel, reIncluded })),
    rules,
    diagnostics
  );

  // Decided AFTER filtering: a tree whose only "dirt" is plugin state or an
  // excluded build directory is clean as far as the hub is concerned, and
  // writing an empty payload for it would be noise on every push.
  if (patch.length === 0 && files.length === 0) return { captured: false, reason: "clean" };

  const untrackedBytes = files.reduce((sum, f) => sum + f.size, 0);
  const cost = patch.length + untrackedBytes + files.length * CARRY_PER_FILE_BYTES;
  if (cost > maxBytes) {
    // Reports the REAL size AND the file count, because either one alone can be
    // the cause: without the count a payload of empty files reads as "0 bytes
    // exceeds 5 MB". `largest:` is omitted when every contributor measures zero
    // — three arbitrary empty filenames explain nothing.
    const largest = describeLargest(files, patch.length);
    return {
      captured: false,
      reason: "too-large",
      detail: `${formatBytes(patch.length + untrackedBytes)} of uncommitted work across ${files.length} file(s) exceeds the ${formatBytes(maxBytes)} carry budget (each file also counts ${CARRY_PER_FILE_BYTES} bytes toward it${largest ? `; largest: ${largest}` : ""})`,
    };
  }

  // Computed only for a capture that is actually going to happen, and only
  // reaches a second `git` call on a repository that has tracked-but-ignored
  // files at all. See `findTrackedIgnored` for why this is not `reIncluded`.
  const trackedIgnored = patch.length > 0 ? findTrackedIgnored(projectPath, diagnostics) : [];

  const preexisting = existsSync(destDir);
  const cleanupPartial = (): void => {
    // Each removal stands alone: whatever made the write fail may well make one
    // of these fail too (the test for this branch parks a DIRECTORY at
    // carry.json, and a single shared try/catch let that first failure skip the
    // removal of everything after it — leaving exactly the metadata-less
    // payload this function exists to prevent).
    const targets = preexisting
      ? ["carry.json", "changes.patch", "untracked"].map((p) => join(destDir, p))
      : [destDir];
    for (const target of targets) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* best effort: the caller's staging directory is removed wholesale anyway */
      }
    }
  };

  let written = 0;
  let writtenBytes = 0;
  const reIncluded: string[] = [];
  try {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "changes.patch"), patch);
    for (const file of files) {
      const dest = join(destDir, "untracked", ...file.rel.split("/"));
      try {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(projectPath, file.rel), dest);
      } catch (e) {
        // One unreadable file must not cost the user the whole push: the
        // session bundle this carry rides on is the point of the operation.
        diagnostics.push(
          `Uncommitted file ${JSON.stringify(file.rel)} could not be copied into this push's carry payload (${(e as Error).message.slice(0, 120)}).`
        );
        continue;
      }
      written++;
      writtenBytes += file.size;
      if (file.reIncluded) reIncluded.push(file.rel);
    }
    const meta: CarryMeta = {
      baseCommit,
      branch,
      detached: !symref.ok,
      inProgress: gitDir ? detectInProgress(gitDir) : null,
      capturedAt: new Date().toISOString(),
      untrackedCount: written,
      untrackedBytes: writtenBytes,
      patchBytes: patch.length,
      reIncludedCount: reIncluded.length,
      reIncluded: reIncluded.slice(0, MAX_REPORTED_REINCLUDED),
      trackedIgnoredCount: trackedIgnored.length,
      trackedIgnored: trackedIgnored.slice(0, MAX_REPORTED_REINCLUDED),
      repoPrefix,
    };
    writeFileSync(join(destDir, "carry.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
    return { captured: true, meta };
  } catch (e) {
    cleanupPartial();
    return { captured: false, reason: "write-failed", detail: (e as Error).message.slice(0, 200) };
  }
}
