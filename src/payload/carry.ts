import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  budgetKey, classifyDestination, formatBytes, isCarriedPath, isNeverIncludable, isReIncluded,
  NEVER_INCLUDABLE, readCarryRules, type CarryRules, type DestinationBlock,
  type PayloadScope,
} from "./workspace.js";
import { PROJECT_DIR_NAME, projectSeshMoverDir, userSeshMoverDir } from "../paths.js";
import { DEFAULT_CARRY_MAX_MB } from "../config.js";

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
export const CARRY_MAX_BYTES = DEFAULT_CARRY_MAX_MB * 1024 * 1024;

/**
 * What one carried FILE costs against the budget, on top of its bytes.
 *
 * A pure byte budget bounds the wrong thing: 200,000 zero-byte files measure
 * zero and sail through, then cost a copy syscall here, a tar header each, and
 * a file the peer has to write on every pull. An include list of `*` over a tree of
 * tiny generated files is exactly that shape. 512 bytes is one tar header —
 * small enough to be invisible for ordinary files (a 20 KB source file moves
 * the needle by 2.5%), decisive for a payload made of nothing but entries.
 *
 * It stays a FIXED per-file cost now that the byte budget is configurable, and
 * that is the point: the charge is the real per-entry cost of a file (a tar
 * header, a syscall, a write on the peer), which does not change because a user
 * raised the ceiling. Scaling it with the budget would defeat it exactly where
 * it is needed — the file-count ceiling it implies rises WITH the budget
 * (10,240 empty files at 5 MB, 102,400 at 50 MB, ~2.1M at the 1 GB clamp), so
 * a raised budget buys proportionally more files, never unbounded ones.
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
 * `.sesh-mover/config.json` (which can redirect `hub.path`) or
 * `.sesh-mover-include` (which decides what the next push ships).
 * Committing that directory is what this project's own docs RECOMMEND, so the
 * shape is ordinary rather than exotic — and while today's pull ignores the
 * carry payload entirely, §6.2's `git apply` will not, and a patch is not
 * filtered by the untracked copy path's guard.
 *
 * Two spellings per name because they answer different questions: `**\/<name>`
 * catches a plain FILE with that name at any depth, `**\/<name>\/**` catches
 * everything inside a directory with that name at any depth (the backslashes
 * are this comment's, not the pathspec's). `icase` mirrors the CASE half of
 * `isNeverSegment`, which folds case because a `.GIT` store works on a
 * case-folding filesystem.
 *
 * It does NOT mirror that function's other folding: `isNeverSegment` also
 * strips trailing dots and whitespace (Win32 resolves `.git.` and `.git ` to
 * `.git`), and no pathspec spelling expresses that without also swallowing
 * `.sesh-moverX`. So `.sesh-mover./config.json` rides this patch.
 * The receiving side closes that: §6.2's `git apply` runs every path in the
 * patch through `isNeverIncludable`, which does fold, and refuses the payload
 * whole before writing anything. Do not treat this pathspec as the boundary.
 *
 * BE PRECISE ABOUT WHICH HALF IS CLOSED. The receiver's floor stops such a path
 * being WRITTEN; it does not stop it TRAVELLING. The bytes of a
 * `.sesh-mover./config.json` still leave this machine, ride the bundle,
 * and sit on the hub in plaintext — a disclosure gap, not a planting one, and
 * exactly the shape of the tracked-vs-untracked split documented at
 * `trackedIgnored`. It costs nothing on POSIX, where such a name is an ordinary
 * distinct file a user would have to create on purpose; it is Win32 where the
 * two names resolve to one thing. Closing the sending half needs the enumeration
 * to be filtered by `isNeverIncludable` rather than by a pathspec, which means
 * not using a pathspec for the patch at all.
 *
 * Verified on git 2.50.1 to compose with `--relative`
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
 *   `:(exclude,icase,glob)**\/.sesh-mover` reads as a literal filename and
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
 * `.sesh-mover-include` line to paste, and `merge.ts` runs `git merge-file` from a
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

/**
 * How an unreadable `CarryMeta` string field reads inside a sentence.
 *
 * `normalizeCarryMeta` replaces one with `""`, and an empty string interpolated
 * into prose reads as a missing WORD rather than as missing information — "the
 * changes were captured at  on branch " is indistinguishable from a rendering
 * bug, and a user who cannot tell those apart cannot act on either. Every
 * message that names one of those fields — here and in `pull-apply-carry.ts`,
 * which is why this is exported — goes through this, so the substitution is
 * decided in one place rather than per sentence.
 */
export function orNotRecorded(value: string): string {
  return value === "" ? "(not recorded)" : value;
}

/** The closed set `CarryMeta.inProgress` may name, beside `null`. */
const IN_PROGRESS_VALUES: readonly string[] = Object.freeze([
  "merge", "rebase", "cherry-pick", "revert",
]);

/** `normalizeCarryMeta`'s answer: a usable meta, plus what had to be replaced. */
export interface NormalizedCarryMeta {
  /**
   * A `CarryMeta` whose every field really is its declared type.
   *
   * IDENTICAL to the input — the same object, not a copy — whenever nothing had
   * to be replaced. That is deliberate: the routine case is a manifest a
   * sesh-mover push wrote, callers hand this straight to `HubPullResult` as
   * "what the bundle declared", and a copy there would quietly turn the sender's
   * claim into ours.
   */
  meta: CarryMeta;
  /**
   * The field names that were not of their declared type, in `CarryMeta`'s own
   * declaration order. Empty means the block was read exactly as written.
   */
  unreadable: string[];
}

/**
 * Read a bundle manifest's `carry` block into a `CarryMeta` that can be used.
 *
 * **This is the trust boundary for that block, and it had none.** `carry` is
 * parsed out of a `manifest.json` fetched from the hub — the same untrusted
 * surface `isBundleManifestShape`/`assertSafeManifestIds` guard on the session
 * list — and `ExportManifest` merely *declares* it a `CarryMeta`. Nothing
 * checked it, so a bundle carrying `carry: {}` reached
 * `meta.baseCommit.slice(0, 8)` in the pull's disclosure prose and threw a
 * `TypeError` out of `hubPull` into the CLI's outer catch: exit 1, no
 * suggestion, and the carried payload dropped along with the extraction
 * directory the pull's `finally` removes.
 *
 * **Total rather than a predicate, and that is the whole design.** A boolean
 * `isCarryMetaShape` has exactly one usable answer for a malformed block —
 * refuse it — and refusing means not reaching `applyCarry`, which is what SAVES
 * a payload the pull will never be able to offer again. So every field degrades
 * to its type's empty value instead, and the caller discloses which ones.
 * Fail-closed comes out of the values, not out of a refusal: `baseCommit`
 * becomes `""`, which no `git rev-parse HEAD` can ever equal, so `applyCarry`
 * declines `wrong-base` and saves. A malformed block therefore costs the apply
 * and never the payload.
 *
 * Strictness has a false-positive cost that is deliberately accepted: a bundle
 * from an older version that predates one of these fields lists it as
 * unreadable. That is one extra disclosure sentence and no behavioural change,
 * and the caller's wording names an older version first among the causes.
 */
export function normalizeCarryMeta(raw: unknown): NormalizedCarryMeta {
  // A non-object `carry` (a string, a number, `true`) is not a special case: it
  // simply supplies no field, so every one is unreadable and the disclosure
  // lists them all.
  const src: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const unreadable: string[] = [];
  const str = (name: string): string => {
    const v = src[name];
    if (typeof v === "string") return v;
    unreadable.push(name);
    return "";
  };
  // `Number.isFinite` rather than `typeof === "number"`: `NaN` and `Infinity`
  // are numbers that `formatBytes` renders as "NaN bytes".
  const num = (name: string): number => {
    const v = src[name];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    unreadable.push(name);
    return 0;
  };
  // Whole-array, never per-element: a list with one non-string in it is a list
  // this module cannot `join` honestly, and keeping the readable half would
  // report a sample that is not a sample of anything.
  const list = (name: string): string[] => {
    const v = src[name];
    if (Array.isArray(v) && v.every((e) => typeof e === "string")) return v as string[];
    unreadable.push(name);
    return [];
  };
  const bool = (name: string): boolean => {
    const v = src[name];
    if (typeof v === "boolean") return v;
    unreadable.push(name);
    return false;
  };
  const inProgress = ((): GitOperationInProgress | null => {
    const v = src.inProgress;
    if (v === null) return null;
    if (typeof v === "string" && IN_PROGRESS_VALUES.includes(v)) {
      return v as GitOperationInProgress;
    }
    unreadable.push("inProgress");
    return null;
  })();
  // Built in CarryMeta's declaration order so `unreadable` reads in it too.
  const meta: CarryMeta = {
    baseCommit: str("baseCommit"),
    branch: str("branch"),
    detached: bool("detached"),
    inProgress,
    capturedAt: str("capturedAt"),
    untrackedCount: num("untrackedCount"),
    untrackedBytes: num("untrackedBytes"),
    patchBytes: num("patchBytes"),
    reIncludedCount: num("reIncludedCount"),
    reIncluded: list("reIncluded"),
    trackedIgnoredCount: num("trackedIgnoredCount"),
    trackedIgnored: list("trackedIgnored"),
    repoPrefix: str("repoPrefix"),
  };
  // `inProgress` is evaluated above the object literal, so its name would sort
  // ahead of `baseCommit` without this.
  unreadable.sort(
    (a, b) => Object.keys(meta).indexOf(a) - Object.keys(meta).indexOf(b)
  );
  return { meta: unreadable.length === 0 ? (raw as CarryMeta) : meta, unreadable };
}

export type CaptureResult =
  | { captured: false; reason: CarryDeclineReason; detail?: string }
  | { captured: true; meta: CarryMeta };

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
  /**
   * Which command is capturing — decides only which config key a budget decline
   * names. See `PayloadScope`.
   */
  scope?: PayloadScope;
  /**
   * Compute the whole `CarryMeta` and write NOTHING — no `changes.patch`, no
   * `untracked/`, no `carry.json`, no `destDir`.
   *
   * Everything the disclosure needs is already computed before the first write:
   * the base commit, the branch, the in-progress operation, the patch size, the
   * filtered untracked list, `reIncluded` and `trackedIgnored`. Exposing that
   * point is what lets `commands/export.md` tell a user what a payload would
   * carry BEFORE the artifact exists (#47), rather than writing the secrets to
   * disk and then offering to delete them.
   *
   * The meta it returns describes the payload that WOULD land, with one honest
   * difference from a real run: `untrackedCount`/`untrackedBytes` count the
   * files that passed the rules, where a real capture counts the ones that
   * copied — a file that becomes unreadable between the two is in the measure
   * and not in the capture, and the real run says so in `diagnostics`.
   */
  measureOnly?: boolean;
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
  /** Gitignored, and here only because `.sesh-mover-include` names it. */
  reIncluded: boolean;
}

/**
 * Take the paths `git` handed us and keep the ones that may actually travel.
 *
 * Everything is filtered through `isCarriedPath`, which is the same rule the
 * workspace walk applies — including the `NEVER_INCLUDABLE` floor, which is
 * what stops `.sesh-mover/config.json` (a file that can redirect
 * `hub.path`) and `.sesh-mover-include` (the file deciding what the
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
 * it is not `reIncluded`: `.sesh-mover-include` had nothing to do with it and no
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
export async function captureCarry(
  projectPath: string,
  destDir: string,
  opts?: CaptureCarryOptions
): Promise<CaptureResult> {
  const diagnostics = opts?.diagnostics ?? [];
  const scope: PayloadScope = opts?.scope ?? "hub";
  // `Math.max(0, …)`, not `Math.max(1, …)`: a configured budget of 0 means
  // "carry nothing" and has to stay exactly 0, or the early return below never
  // fires and a 1-byte budget declines with a message about sizes instead.
  const maxBytes = Math.max(0, opts?.maxBytes ?? CARRY_MAX_BYTES);
  if (maxBytes === 0) {
    // Answered before `git` is spawned at all: a disabled budget should cost
    // nothing, and `git diff` with a 1-byte maxBuffer would otherwise decline
    // through ENOBUFS with a size complaint that explains the wrong thing.
    return {
      captured: false,
      reason: "budget-disabled",
      detail: `the carry budget is set to 0, so no uncommitted work is carried (${budgetKey(scope, "carry")})`,
    };
  }

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

  // the include list re-adds deliberately-ignored paths (this repo's own
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
    // exceeds 50 MB". `largest:` is omitted when every contributor measures zero
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

  /**
   * Everything above this line is measurement; everything below it writes.
   *
   * The `CarryMeta` fields that differ between the two are exactly the two the
   * copy loop counts (`untrackedCount`/`untrackedBytes`) and `reIncluded`,
   * which the copy loop fills from the files it managed to read. A measure
   * takes them from the filtered list instead, so it describes the payload as
   * the rules decided it rather than as the filesystem allowed it — see
   * `measureOnly`.
   */
  const metaOf = (
    untrackedCountValue: number,
    untrackedBytesValue: number,
    reIncludedPaths: string[]
  ): CarryMeta => ({
    baseCommit,
    branch,
    detached: !symref.ok,
    inProgress: gitDir ? detectInProgress(gitDir) : null,
    capturedAt: new Date().toISOString(),
    untrackedCount: untrackedCountValue,
    untrackedBytes: untrackedBytesValue,
    patchBytes: patch.length,
    reIncludedCount: reIncludedPaths.length,
    reIncluded: reIncludedPaths.slice(0, MAX_REPORTED_REINCLUDED),
    trackedIgnoredCount: trackedIgnored.length,
    trackedIgnored: trackedIgnored.slice(0, MAX_REPORTED_REINCLUDED),
    repoPrefix,
  });

  if (opts?.measureOnly) {
    return {
      captured: true,
      meta: metaOf(
        files.length,
        untrackedBytes,
        files.filter((f) => f.reIncluded).map((f) => f.rel)
      ),
    };
  }

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
    const meta: CarryMeta = metaOf(written, writtenBytes, reIncluded);
    writeFileSync(join(destDir, "carry.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
    return { captured: true, meta };
  } catch (e) {
    cleanupPartial();
    return { captured: false, reason: "write-failed", detail: (e as Error).message.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Apply (design §6.2)
// ---------------------------------------------------------------------------

/**
 * `git apply` is porcelain too, and its configuration surface is smaller than
 * `git diff`'s but sharper: both of its knobs change the BYTES that land in the
 * user's file while the command still exits 0. Measured on git 2.50.1, each
 * reproduced:
 *
 * - `apply.whitespace = fix` — applies the patch and silently STRIPS the
 *   whitespace it was asked to add. A peer's `beta   \n` arrives as `beta\n`:
 *   the patch applies cleanly, exit 0, and the file holds bytes neither machine
 *   has. `apply.whitespace = error` is the same setting in refuse mode (exit
 *   128 from both `--check` and apply). `--whitespace=nowarn` beats both.
 * - `apply.ignoreWhitespace = change` — makes `git apply` accept a patch whose
 *   context does NOT match the local file and rewrite that file's indentation
 *   to the patch's. Measured: a tab-indented local file met a space-indented
 *   patch, `--check` passed, and the result mixed both — the edited line
 *   space-indented, its untouched neighbour still a tab. Only `-c
 *   apply.ignoreWhitespace=no` was found to beat it reliably; the `--no-`
 *   spelling parses on this version but `-c` is the form that cannot be older
 *   than the config key it overrides.
 *
 * Not pinned, and why: `core.autocrlf` and `.gitattributes` text/eol/filter
 * settings are the RECEIVING checkout's own conventions and `git apply`
 * honours them exactly as `git checkout` would (measured both ways — an LF
 * patch applied into a CRLF worktree produced CRLF, and a clean/smudge filter
 * round-tripped correctly). Fighting them would write files that disagree with
 * every other file in the user's tree.
 */
const APPLY_FLAGS = ["--whitespace=nowarn"];

/** Config pinned per invocation, ahead of the subcommand — see `APPLY_FLAGS`. */
const APPLY_CONFIG = ["-c", "apply.ignoreWhitespace=no"];

/**
 * Every `git apply` this module runs, built in ONE place — because the four of
 * them (`--numstat` for the floor check, `--numstat` for `filesChanged`,
 * `--check`, and the apply itself) are the same command with the same
 * path-resolution and the same configuration surface, and they are only correct
 * while they agree. Two defects came from letting them drift:
 *
 * - **`--directory` on some but not all.** Inside a repository `git apply`
 *   resolves patch paths against the REPOSITORY ROOT and silently ignores
 *   anything that lands outside the current directory (exit 0, no stderr,
 *   nothing written — measured). Applied to `--numstat` that means a
 *   subdirectory project reports NO entries at all, so a floor check reading
 *   its output passes vacuously: measured, a `GIT binary patch` creating
 *   `.sesh-mover-include` was refused at a repo-root project and
 *   APPLIED at a subdirectory one, as were an empty-file creation of
 *   `.sesh-mover/config.json` and an `old mode`/`new mode` chmod. The
 *   same omission zeroed `filesChanged` on every subdirectory project.
 * - **`APPLY_CONFIG`/`APPLY_FLAGS` on some but not all.** `git apply --numstat`
 *   honours `apply.whitespace=error` and exits 128 on a patch that adds
 *   trailing whitespace (measured), so an unhardened `--numstat` turned an
 *   innocent payload on a receiver with that config into a SECURITY refusal
 *   (`unsafe-payload`, "could not be parsed") — with the security README text
 *   and no apply command. The flags are the fix; the floor check's split of
 *   "git failed" from "the payload failed" (see `applyCarry`) is the second
 *   line, for the receiver-side failures no flag can pre-empt.
 *
 * `mode` is what distinguishes them (`["--numstat", "-z", "--summary"]` for the
 * floor check, `["--numstat", "-z"]` for `filesChanged`, `["--check"]`, or
 * nothing at all); everything else is shared by construction.
 *
 * That sharing is what makes the floor check AUTHORITATIVE rather than merely
 * well-informed. `git apply` parses the patch once into a single `struct patch`
 * list and then walks that same list to print `--numstat`, to print `--summary`
 * and to write the files; two invocations that differ only in `mode` therefore
 * describe and apply the identical set of paths. A second parser — of the patch
 * bytes, or of git's C sources — can disagree with git. This cannot.
 */
function applyInvocation(applyPrefix: string, mode: string[], patchPath: string): string[] {
  return [
    ...APPLY_CONFIG,
    "apply",
    ...APPLY_FLAGS,
    ...(applyPrefix ? [`--directory=${applyPrefix}`] : []),
    ...mode,
    patchPath,
  ];
}

/**
 * Every path an entry of a `--summary` line can name that `--numstat` does not.
 *
 * `git apply --summary` is `show_rename_copy` in apply.c, **not** `git diff
 * --summary`'s `pprint_rename` — measured, and the difference matters: it
 * compacts only a common PREFIX (never a suffix) and it never C-quotes, so
 * every byte of both paths is present raw. What it does not do is escape `{`,
 * `}` or ` => `, which makes the line ambiguous on its face: a rename of
 * `d/.sesh-mover/{f.txt` to `d/out.txt` prints
 * ` rename d/{.sesh-mover/{f.txt => out.txt} (100%)`, and reading that with a
 * `(.*)\{(.*) => (.*)\}(.*)` regex yields `d/{.sesh-mover/f.txt` — whose first
 * segment is `{.sesh-mover`, so a genuine floor path reads as an innocent one.
 *
 * It is not ambiguous once the DESTINATION is known, and `--numstat` reports
 * that exactly. The two shapes git's own `printf`s can produce (read out of the
 * shipped binary with `strings`: `" %s %s => %s (%d%%)"` and
 * `" %s %.*s{%s => %s} (%d%%)"`) are then both anchored:
 *
 * - plain: `body === <src> " => " <dest>`;
 * - compacted: `body === <pfx> "{" <srcRest> " => " <dstRest> "}"`, where
 *   `<pfx>` ends in `/` and `<pfx><dstRest> === <dest>` — so every `/` in the
 *   destination is one candidate split and at most one of them can fit.
 *
 * The true source is ALWAYS among the readings, because git built the body from
 * it with one of exactly those two `printf`s. So a single reading is the source;
 * more than one, or none, is reported to the caller as unreadable and refuses
 * the payload. Guessing is the one thing this must not do — a silently
 * mis-expanded source is a floor path scored as innocent.
 */
function renameCopySources(body: string, destinations: readonly string[]): string[] {
  const found = new Set<string>();
  for (const dest of destinations) {
    const plain = ` => ${dest}`;
    if (body.length > plain.length && body.endsWith(plain)) {
      found.add(body.slice(0, body.length - plain.length));
    }
    for (let i = 0; i < dest.length; i++) {
      if (dest[i] !== "/") continue;
      const open = `${dest.slice(0, i + 1)}{`;
      const close = ` => ${dest.slice(i + 1)}}`;
      if (body.length < open.length + close.length) continue;
      if (!body.startsWith(open) || !body.endsWith(close)) continue;
      found.add(dest.slice(0, i + 1) + body.slice(open.length, body.length - close.length));
    }
  }
  return [...found];
}

/** ` rename <body> (100%)` / ` copy <body> (100%)` — the only lines carrying a path `--numstat` omits. */
const SUMMARY_RENAME_COPY = /^ (?:rename|copy) (.*) \(\d+%\)$/;

/**
 * Every OTHER line `git apply --summary` can print, as a closed grammar.
 *
 * Closed rather than "skip what we don't recognise", and that is the whole
 * defence of the single-source floor. `--summary` interpolates BOTH paths of a
 * rename raw, and the destination is attacker-controlled, so a destination
 * holding a newline splits the line git prints:
 *
 *     rename from .sesh-mover-include
 *     rename to "moved\nX => Y (1%)"
 *
 * makes git print ` rename .sesh-mover-include => moved` and `X => Y (1%) (100%)`
 * on two physical lines, neither of which matches `SUMMARY_RENAME_COPY` — so a
 * reader that skipped what it did not recognise would learn nothing about the
 * source and let git DELETE the receiver's `.sesh-mover-include`. Measured end
 * to end on git 2.43.0: `applied ok`, floor evaded. With the grammar closed,
 * both lines are unaccounted for and the payload is refused.
 *
 * The shapes are git's own `printf` format strings, read out of the shipped
 * binary (`strings`, git 2.43.0) and each one reproduced: `" %s mode %06o %s"`
 * and `" %s %s"` (create/delete, the second when the patch carries no mode
 * line), `" mode change %06o => %06o %s"` and its nameless twin `" mode change
 * %06o => %06o"` (printed after a rewrite), and `" rewrite %s (%d%%)"`. None of
 * them names a path `--numstat` has not already printed, so they only have to be
 * RECOGNISED, never parsed.
 *
 * The drift this closes over is a git version that adds a TENTH shape: such a
 * line is unaccounted for and the payload is refused. That is the fail-CLOSED
 * direction — a saved payload the user is told to read, never a file written —
 * and the fix is to re-read the format strings out of the new binary the same
 * way, NOT to loosen this into "skip what we don't recognise", which is exactly
 * the reading the split-line evasion above defeats.
 */
const SUMMARY_ACCOUNTED_FOR: readonly RegExp[] = Object.freeze([
  /^ (?:create|delete) mode [0-7]{6} ./,
  /^ (?:create|delete) ./,
  /^ mode change [0-7]{6} => [0-7]{6}( .*)?$/,
  /^ rewrite .* \(\d+%\)$/,
]);

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
function parseApplyPaths(stdout: string): GitPatchPaths {
  const records = stdout.split("\0");
  // The summary block trails the last NUL, so it is never a numstat record.
  const summary = records.pop() ?? "";
  const destinations = records
    .filter((rec) => rec.length > 0)
    .map((rec) => rec.split("\t").slice(2).join("\t"))
    .filter((p) => p.length > 0);
  const sources: string[] = [];
  const unreadable: string[] = [];
  for (const line of summary.split("\n")) {
    if (line.length === 0) continue;
    const renameCopy = SUMMARY_RENAME_COPY.exec(line);
    if (renameCopy !== null) {
      const readings = renameCopySources(renameCopy[1]!, destinations);
      if (readings.length === 1) sources.push(readings[0]!);
      else unreadable.push(line);
      continue;
    }
    if (!SUMMARY_ACCOUNTED_FOR.some((shape) => shape.test(line))) unreadable.push(line);
  }
  return { destinations, sources, unreadable };
}

/**
 * Git's own parse of a patch, exposed for `tests/hub-carry-header.test.ts` —
 * which uses it as the ORACLE it cross-checks the byte scan against, so the
 * harness measures the code that actually enforces the floor rather than a
 * second copy of it. Named `__`-first like the module's other test seams.
 */
export { parseApplyPaths as __parseApplyPathsForTests };

/**
 * Cap on a patch this module will INSPECT. Over it the payload is declined
 * rather than applied unchecked: the floor and symlink guards below both read
 * the whole patch, and a guard that silently gives up on large input is not a
 * guard.
 *
 * It has to sit ABOVE the sender's default budget, and that is why it moved
 * with it. At 32 MB against a 5 MB sender it only ever bit a hand-made or
 * damaged bundle; against a 50 MB sender it would have started refusing
 * ordinary payloads on the receiving side, where the remedy (`hub.carryMaxMb`)
 * lives on the OTHER machine. This is a receiver-side constant and cannot know
 * what the sender configured, so the relationship is stated rather than
 * enforced: a machine that raises `hub.carryMaxMb` above this produces payloads
 * its peers save but do not apply — the fail-closed direction, with the saved
 * copy and its README as the remedy.
 */
const PATCH_SCAN_MAX_BYTES = 128 * 1024 * 1024;

/**
 * How many saved carry payloads a project keeps. A carry rides every push that
 * has session content and `hub.carryDiff` is on by default, so an unapplied
 * carry is the ROUTINE case, not the exception — without a bound the project
 * would accumulate one copy of the peer's working tree per pull. Pruning only
 * ever removes this module's own `carry-<stamp>` directories, newest kept.
 */
const SAVED_CARRY_RETENTION = 5;

/** Why a carry payload was not applied to the working tree. */
export type CarryApplyDeclineReason =
  /** `--apply-carry` was not passed. The payload is saved, never applied. */
  | "not-requested"
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
  blocked: Array<{ path: string; reason: DestinationBlock | "io-error" }>;
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

/** `2026-08-04T09-12-33-501Z` — filesystem-safe and lexically sortable. */
function stampNow(override?: string): string {
  return override ?? new Date().toISOString().replace(/[:.]/g, "-");
}

/** The one-character escapes `unquote_c_style` knows, and nothing else. */
const C_QUOTE_ESCAPES: Record<string, number> = {
  a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92,
};

/**
 * Decode git's C-quoted path spelling (`"caf\303\251.txt"`), or `null` when
 * this is not a spelling git's own `unquote_c_style` decodes.
 *
 * `core.quotePath` is on by default and it quotes at the SENDER, inside the
 * patch bytes — so no flag on this side changes it. Left encoded, a quoted
 * `".sesh-mover/x"` reads as a single segment starting with `"` and
 * walks straight past the floor check.
 *
 * Three details are git's, not conveniences, and each one was a hole:
 *
 * - **It stops at the first UNESCAPED closing quote and ignores everything
 *   after it.** Requiring the token to END with the quote (what this function
 *   did) means one appended junk byte — `".sesh-mover-include"X` —
 *   leaves the literal token as the only reading, whose leading `"` fuses into
 *   the first segment so `isNeverSegment` no longer matches, while git decodes
 *   the real path and applies it. Measured on a healthy-git receiver at both
 *   layouts: that spelling on a `rename from` line DELETED the receiver's
 *   `.sesh-mover-include`, and on a `copy from` line reproduced it at
 *   an ordinary path from where the next auto-push would upload it.
 * - **An octal escape is exactly three digits with the first in 0–3**; two
 *   digits (`\56`) or a leading `4`–`7` is an ERROR, not a shorter escape.
 * - **An unknown escape (`\z`) is an error too.**
 *
 * On error git's `find_name` falls back to reading the LITERAL bytes, which is
 * why `null` here is not "no path": every caller keeps the raw token as a
 * candidate of its own, exactly mirroring that fallback.
 */
function unquoteGitPath(raw: string): string | null {
  if (!raw.startsWith('"')) return null;
  const bytes: number[] = [];
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"') return Buffer.from(bytes).toString("utf-8");
    if (ch !== "\\") {
      bytes.push(raw.charCodeAt(i) & 0xff);
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break; // trailing backslash: unterminated
    if (next >= "0" && next <= "3") {
      const d2 = raw[i + 1];
      const d3 = raw[i + 2];
      if (d2 === undefined || d2 < "0" || d2 > "7") return null;
      if (d3 === undefined || d3 < "0" || d3 > "7") return null;
      bytes.push(parseInt(raw.slice(i, i + 3), 8) & 0xff);
      i += 2;
      continue;
    }
    const code = C_QUOTE_ESCAPES[next];
    if (code === undefined) return null; // includes octal starting 4-7
    bytes.push(code);
  }
  return null; // no closing quote — git's unquote fails and the literal wins
}

/**
 * Which of git's two name-termination rules reads this keyword's line.
 *
 * **`"name"` — `---` and `+++` only.** Those two lines are read by two
 * different git functions depending on where they sit, and BOTH readings have
 * to be offered because the byte scan is line-based and does not know which:
 * inside a `diff --git` block `gitdiff_verify_name` calls `find_name(…,
 * TERM_TAB)`, so a TAB ends the name; standing alone (a traditional patch)
 * `find_name_traditional` applies TERM_TAB **only when it finds no trailing
 * timestamp**, and passes `terminate = 0` when it does — the name then runs to
 * the end of the line minus the timestamp, TABs and all.
 *
 * **`"rename-copy"` — the other six.** `gitdiff_renamesrc`/`renamedst`/
 * `copysrc`/`copydst` all call `find_name(…, 0)`. A TAB never terminates there
 * and no timestamp is ever stripped: the name is the whole rest of the line.
 *
 * Every clause above was MEASURED against `git apply --numstat -z --summary`
 * (git 2.50.1), not read off a comment — the claim that TAB terminates
 * everywhere was itself the hole this distinction closes. `git apply` writes
 * these paths for real: `+++ b<TAB>Q/.sesh-mover/config.json<TAB><ts>`
 * created the project-root `.sesh-mover/config.json`, `copy to X<TAB>sub/
 * .sesh-mover/evil` applied, and `+++ b/sub/.sesh-mover <ts>`
 * (space-separated timestamp, forbidden segment LAST) created that file — all
 * three invisible to a scan that truncated at the first TAB. The exhaustive
 * statement of the rule, and the thing that keeps it true, is the `tab-inside`
 * / `ts-*` axis in `tests/hub-carry-header.test.ts`.
 */
type HeaderLineKind = "name" | "rename-copy";

/**
 * A trailing GNU-diff timestamp on a traditional `---`/`+++` line, matched
 * permissively rather than ported from `diff_timestamp_len`.
 *
 * Only the LAST path component can be affected by one — a timestamp is appended
 * to the name — so this matters exactly when the forbidden segment is the leaf,
 * and the unstripped reading (always offered too) covers every other position.
 * Permissive is the safe side: an extra candidate can only ever cause a refusal.
 * Every form git was measured to strip (`\t2024-01-02 00:00:00.000000000 +0000`,
 * the same space-separated, second- and fraction-less variants, and a bare
 * `\t12345`) is a run of digits, `-`, `+`, `:`, `.` and blanks, so requiring
 * that shape is wide enough; requiring the run to hold no LETTERS is what keeps
 * `docs/.sesh-mover notes.md` — a real tracked name in the harness's
 * negative corpus — from being trimmed back to a forbidden segment.
 */
const TRAILING_TIMESTAMP = /[ \t][-+0-9:.][-+0-9:.\t ]*$/;

/**
 * Every path one single-name header line (`---`, `+++`, `rename from/to`,
 * `rename old/new`, `copy from/to`) can be read as — the decoded form AND the
 * literal one, because git itself tries both in that order (`find_name` calls
 * `find_name_gnu` first and falls back to `find_name_common` when the unquote
 * fails). Collecting both is what keeps a malformed escape from hiding a path:
 * whichever reading git ends up using, the floor has seen it.
 *
 * `kind` selects the termination rules (see `HeaderLineKind`); where git's
 * reading depends on context the union of the possible readings is offered,
 * since a candidate git will not use can only ever add a refusal.
 *
 * Each reading is also offered with an `a/`/`b/` prefix stripped, since that is
 * the component git removes at `-p1`. The unstripped form is kept as well and
 * costs nothing: `isNeverIncludable` judges EVERY segment, so a leading
 * component can only ever add one — which is also why the scan does not try to
 * model `-p1` stripping a component spelled anything else. Stripping only ever
 * REMOVES a segment, so the unstripped reading already covers whatever git's
 * stripped one names.
 */
function headerPathCandidates(rest: string, kind: HeaderLineKind): string[] {
  const readings = [rest, rest.trim()];
  if (kind === "name") {
    const tabbed = rest.split("\t")[0]!;
    readings.push(tabbed, tabbed.trim());
    const dated = rest.replace(TRAILING_TIMESTAMP, "");
    if (dated !== rest) readings.push(dated, dated.trim());
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const reading of readings) {
    if (seen.has(reading)) continue;
    seen.add(reading);
    for (const form of [reading, unquoteGitPath(reading)]) {
      // `/dev/null` is git's "no such side" marker, not a path the floor judges.
      if (form === null || form.length === 0 || form === "/dev/null") continue;
      out.push(form);
      const stripped = form.replace(/^[ab]\//, "");
      if (stripped !== form && stripped.length > 0) out.push(stripped);
    }
  }
  return out;
}

/**
 * Longest `diff --git` header this scan will parse, the most separator
 * positions it will try inside one, and a budget across the whole patch.
 *
 * The parse below is quadratic in the number of separators, and the patch is
 * attacker-supplied, so all three are needed. Nothing git emits comes close:
 * two paths, each bounded by the platform's `PATH_MAX` even after C-quoting
 * expands every byte to four characters, separated by ONE space (a separator
 * count is a count of spaces, TABs and CRs in the header — git C-escapes all
 * three inside a path it quotes, so an honest header holds exactly one).
 * Exceeding any of these fails the whole scan CLOSED (`unsafe-payload`) rather
 * than parsing a prefix of the header and trusting the answer.
 */
const HEADER_SCAN_MAX_LEN = 16 * 1024;
const HEADER_SCAN_MAX_SPLITS = 256;
const HEADER_SCAN_BUDGET = 32 * 1024 * 1024;

/**
 * Every way one half of a `diff --git` header can be read.
 *
 * Three readings rather than one, because git's parser reaches the same half by
 * three different routes and picking one of them is how a spelling slips past:
 *
 * - **byte-exact** — what git compares when both names are unquoted (its final
 *   loop demands the two halves match byte for byte).
 * - **whitespace-trimmed** — git skips its `isspace` run between a quoted first
 *   name and the second (`"a/x"   "b/x"` is accepted, measured), so the padding
 *   is not part of either name there.
 * - **C-unquoted** — the decoded path, when the trimmed form opens a quote.
 *   `unquoteGitPath` ignores whatever trails the closing quote, as git does, so
 *   `"b/x"JUNK` still reads as `b/x`.
 *
 * Extra readings can only ever make a header AGREE with more spellings, i.e.
 * collect more candidate paths, i.e. refuse more — never write more.
 */
function halfReadings(raw: string): string[] {
  const out = [raw];
  const trimmed = raw.trim();
  if (trimmed !== raw) out.push(trimmed);
  const decoded = unquoteGitPath(trimmed);
  if (decoded !== null && decoded !== trimmed) out.push(decoded);
  return out;
}

/** Everything past the first `/`, or `null` when there is no component to strip. */
function stripOneComponent(path: string): string | null {
  const slash = path.indexOf("/");
  return slash === -1 ? null : path.slice(slash + 1);
}

/**
 * Every path a `diff --git <a> <b>` line can name — the ONLY path reference
 * some entries have.
 *
 * Four shapes carry no `---`/`+++` lines and no `rename`/`copy` lines at all,
 * so without this the raw scan sees nothing in them (all measured, and all four
 * were APPLIED on a machine with no runnable `git`, where `--numstat` — the
 * other source — cannot run either): a mode-only change, a new or changed
 * BINARY file, a deletion of a binary file, and an empty-file creation.
 *
 * **The standard here is what `git apply` ACCEPTS, not what `git diff` emits.**
 * The threat model for this line is a hand-crafted payload — that is the only
 * way `copy from .sesh-mover-include` arises either — so covering
 * git's own output is not enough. Two spellings real git accepts walked past an
 * earlier "split at the midpoint, require the halves to match after stripping
 * `a/`/`b/`" reading of this header, both measured end to end (`--numstat`
 * prints the path, `--check` exits 0, `git apply` writes the file):
 *
 * - **asymmetric quoting**, `diff --git a/<p> "b/<p>"` — the halves have
 *   different lengths, so the midpoint is not the separator. (Its mirror,
 *   `"a/<p>" b/<p>`, git rejects; one direction is enough.) The same holds for
 *   two quoted halves spelled with different escapes (`"a/.claude…"` against
 *   `"b/\056claude…"`).
 * - **prefixes that are not `a/`/`b/`**, `diff --git c/<p> d/<p>` — exactly what
 *   `git diff --src-prefix=c/ --dst-prefix=d/` emits, and `diff.mnemonicPrefix`
 *   (documented at the top of this file) renames them for ordinary users.
 *
 * So this is a deliberate OVER-approximation of git's `git_header_name`, not a
 * port of it: try EVERY separator position, read each half every way git can
 * read one (`halfReadings`), and strip ONE leading component whatever it is
 * spelled. Git accepts a header when some split makes the two halves agree, and
 * that is the question asked here — but where git's parser is exact this one is
 * permissive, so every header git accepts is also collected here and a few it
 * rejects are collected too. Extra candidates only ever cause a REFUSAL.
 *
 * Claiming a line-for-line port was itself the bug in an earlier round: the two
 * places this really did diverge from `git_header_name` were both holes, both
 * measured applying on a healthy-git receiver, and neither would have existed
 * in a faithful port —
 *
 * - the C-unquote demanded the half END at its closing quote, where git's
 *   `unquote_c_style` stops at the first unescaped one and ignores the rest
 *   (`"b/<p>"JUNK`); see `unquoteGitPath`;
 * - the separator class was `' '`/`'\t'`, where git's is its SANE `isspace` —
 *   `' '`, `'\t'`, `'\r'` all separate names, while `'\v'` and `'\f'` do not
 *   (all four measured: `a/<p>\r"b/<p>"` applies, `a/<p>\v"b/<p>"` is rejected
 *   outright with "git diff header lacks filename information").
 *
 * `'\v'`/`'\f'` are therefore deliberately NOT accepted here: a header git
 * refuses to parse names nothing at all, and adding them defensively would only
 * invent refusals. `'\n'` cannot occur — the caller splits on it.
 *
 * Both the stripped and the raw form are collected — `git diff --no-prefix`
 * emits a header with no component to strip and `git apply -p0` then writes the
 * path verbatim (measured).
 *
 * The agreement requirement is what keeps this honest rather than a
 * false-refusal machine: no split of `a/tracked.txt b/renamed.txt` agrees, and
 * neither does any mis-split of a path containing spaces (`a/docs/.sesh-mover
 * notes.md b/…` agrees only at the real separator). Everything a split can
 * still get wrong ends in a REFUSAL, never a pass.
 *
 * Returns `null` when the header is too large to parse exhaustively; the caller
 * fails the whole scan closed rather than trusting a partial answer.
 */
function diffGitHeaderPaths(rest: string, budget: { left: number }): string[] | null {
  if (rest.length > HEADER_SCAN_MAX_LEN) return null;
  const out: string[] = [];
  let splits = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    // Git's separator class here is its own `isspace` (sane_ctype): space, TAB
    // and CR separate the two names; VT and FF do not.
    if (ch !== " " && ch !== "\t" && ch !== "\r") continue;
    if (++splits > HEADER_SCAN_MAX_SPLITS) return null;
    const lefts = halfReadings(rest.slice(0, i));
    const rights = halfReadings(rest.slice(i + 1));
    // The budget counts bytes COMPARED, so growing the readings per half grows
    // the charge with it rather than silently multiplying the work behind a
    // per-split charge. Over budget the whole scan fails closed.
    budget.left -= rest.length * lefts.length * rights.length;
    if (budget.left < 0) return null;
    for (const left of lefts) {
      for (const right of rights) {
        const leftStripped = stripOneComponent(left);
        const rightStripped = stripOneComponent(right);
        const strippedAgree = leftStripped !== null && leftStripped === rightStripped;
        if (!strippedAgree && left !== right) continue;
        if (strippedAgree) out.push(leftStripped);
        out.push(left, right);
      }
    }
  }
  // `/dev/null` never appears in a `diff --git` line and is not a path the
  // floor should judge; empty strings are the residue of a `a/ b/` header.
  return out.filter((p) => p.length > 0 && p !== "/dev/null");
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
function scanPatchBytes(patchPath: string): { paths: string[]; symlink: string | null } | null {
  let size: number;
  try {
    size = statSync(patchPath).size;
  } catch {
    return null;
  }
  if (size > PATCH_SCAN_MAX_BYTES) return null;
  let text: string;
  try {
    // latin1: a lossless byte<->char mapping, so a binary hunk cannot throw off
    // line splitting and a path's bytes survive to be re-decoded as UTF-8.
    text = readFileSync(patchPath).toString("latin1");
  } catch {
    return null;
  }
  const paths: string[] = [];
  let symlink: string | null = null;
  const headerBudget = { left: HEADER_SCAN_BUDGET };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (
      /^(new file mode|deleted file mode|old mode|new mode) 120000$/.test(line) ||
      /^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/.test(line)
    ) {
      symlink ??= line;
      continue;
    }
    let found: string[] = [];
    if (line.startsWith("--- ") || line.startsWith("+++ ")) found = headerPathCandidates(line.slice(4), "name");
    else if (line.startsWith("rename from ")) found = headerPathCandidates(line.slice(12), "rename-copy");
    else if (line.startsWith("rename to ")) found = headerPathCandidates(line.slice(10), "rename-copy");
    // Git's legacy spelling of the same two lines, still in its keyword table
    // and still accepted (measured end to end).
    else if (line.startsWith("rename old ")) found = headerPathCandidates(line.slice(11), "rename-copy");
    else if (line.startsWith("rename new ")) found = headerPathCandidates(line.slice(11), "rename-copy");
    else if (line.startsWith("copy from ")) found = headerPathCandidates(line.slice(10), "rename-copy");
    else if (line.startsWith("copy to ")) found = headerPathCandidates(line.slice(8), "rename-copy");
    else if (line.startsWith("diff --git ")) {
      const header = diffGitHeaderPaths(line.slice(11), headerBudget);
      // Unparseable within the budget: the floor cannot answer for this entry,
      // and on a machine where `--numstat` cannot run this scan is the whole
      // floor. Fail the scan closed.
      if (header === null) return null;
      found = header;
    }
    // Read as latin1 above, so a path's bytes are intact and re-decode as UTF-8
    // here — the spelling `isNeverIncludable` has to fold.
    for (const path of found) paths.push(Buffer.from(path, "latin1").toString("utf-8"));
  }
  return { paths, symlink };
}

/**
 * The raw byte scan, exposed for `tests/hub-carry-header.test.ts` — the
 * differential harness that cross-checks it against real `git apply` output
 * spelling by spelling. Named `__`-first like the module's other test seams
 * (`__stamp`): it is not part of the plugin's supported surface, and nothing in
 * `src/` calls it through this name.
 */
export { scanPatchBytes as __scanPatchBytesForTests };

/** Files under a payload directory, "/"-joined, symlinks and specials dropped. */
function listPayloadFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // Never followed, never copied: the archiver rejects symlink tar entries,
      // so this only bites a hand-made payload — which is exactly the one that
      // would point at ~/.ssh.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk(root, "");
  return out.sort();
}

/**
 * Copy a payload tree into the saved directory, dropping symlinks — and
 * dropping anything under `untracked/` that the floor would refuse.
 *
 * The floor applies HERE and not only on the `--apply-carry` path because the
 * saved directory is not an archive, it is a set of instructions: the README it
 * ships alongside tells the user to run `cp -R '<saved>/untracked/.' .`, and
 * that command copies dot-entries. So an `untracked/.git/hooks/pre-commit` or
 * `untracked/.sesh-mover-include` that `applyCarry` refuses outright
 * (`refused[]`, nothing written) was planted by the routine `not-requested`
 * path the moment the user followed our own instructions — the one path whose
 * sibling has the defence. Only a hand-made, damaged or pre-floor bundle can
 * contain such a path, which is what makes this defence in depth rather than a
 * live hole; it is still the same floor, applied where the write happens.
 *
 * Returns the refused repo-relative paths so the README can say what is missing
 * from the copy it is describing.
 */
function copyPayloadTree(src: string, dest: string): { refused: string[] } {
  const refused: string[] = [];
  for (const rel of listPayloadFiles(src)) {
    // `untracked/<repo-relative path>` is the only half of a payload that
    // becomes a file in the user's tree verbatim; `changes.patch` and
    // `carry.json` are the payload's own metadata and are judged by the patch
    // scan instead.
    if (rel.startsWith("untracked/")) {
      const inner = rel.slice("untracked/".length);
      if (isNeverIncludable(inner)) {
        refused.push(inner);
        continue;
      }
    }
    const to = join(dest, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(src, rel), to);
  }
  return { refused };
}

/**
 * First line of the `.gitignore` every saved payload carries — and the marker
 * that makes a `carry-*` directory OURS to delete. `.sesh-mover/` is also
 * where `export --scope project` puts a bundle the user named, so a name match
 * alone would let retention delete a user's own `carry-…` export.
 */
const SAVED_CARRY_MARKER = "# sesh-mover: a peer's uncommitted work, saved for you to apply by hand.";

/** The self-ignoring `.gitignore` that both marks and protects a saved payload. */
const SAVED_CARRY_GITIGNORE =
  `${SAVED_CARRY_MARKER}\n# Self-ignoring so it can never be committed by accident.\n*\n`;

/** Is this directory one WE wrote — as opposed to a same-named export? */
function isSavedCarryDir(dir: string): boolean {
  try {
    return readFileSync(join(dir, ".gitignore"), "utf-8").startsWith(SAVED_CARRY_MARKER);
  } catch {
    return false;
  }
}

/**
 * Drop all but the newest `SAVED_CARRY_RETENTION` saved payloads. Best effort:
 * a failure here must never turn a successful save into a failed one.
 *
 * Two things it is not allowed to do, both of which it did before:
 *
 * - **Delete the payload this run just wrote.** Retention is by NAME, and a
 *   name is only chronological because the stamps are ISO timestamps — a pinned
 *   `__stamp`, a clock stepped backwards or a machine in a different timezone
 *   all produce a fresh directory that sorts oldest, and pruning it would leave
 *   `savedTo` naming nothing at all while the result claims the payload was
 *   saved. `keepName` is excluded from the candidates outright (it still counts
 *   against the budget, so the total stays bounded).
 * - **Delete something that is not ours.** `.sesh-mover/` is also where a
 *   project-scope `sesh-mover export` lands, so a user export named `carry-…`
 *   matched the name filter. Ownership is now proven by the marker inside the
 *   directory, not by its name.
 */
function pruneSavedCarries(pluginDir: string, keepName: string): void {
  try {
    const ours = readdirSync(pluginDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("carry-"))
      .map((e) => e.name)
      .filter((name) => name === keepName || isSavedCarryDir(join(pluginDir, name)))
      .sort();
    const excess = Math.max(0, ours.length - SAVED_CARRY_RETENTION);
    for (const name of ours.filter((n) => n !== keepName).slice(0, excess)) {
      rmSync(join(pluginDir, name), { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
}

/**
 * Write the payload where the user can get at it, plus instructions.
 *
 * This is the ONLY remedy on every declining path, and it has to be a real one:
 * a pull records its bundles as received before it returns, so "re-run with
 * --apply-carry" cannot work and the extraction directory is gone the moment
 * the pull finishes. Everything needed to finish the job by hand is therefore
 * copied out now.
 *
 * It lands under `.sesh-mover/`, which is on the `NEVER_INCLUDABLE`
 * floor — so a saved payload can never be swept up by the next push's own
 * carry — and it carries a `.gitignore` of `*` so that a project which COMMITS
 * its `.sesh-mover` directory (which this project's own docs recommend)
 * cannot commit a peer's uncommitted work, secrets included, with a `git add
 * -A`. That `.gitignore` is also what keeps the saved copy out of the
 * dirty-tree check on the NEXT attempt, whichever way that check is spelled.
 */
function saveCarryPayload(opts: {
  carryDir: string;
  targetPath: string;
  meta: CarryMeta;
  detail: string;
  advice: SavedAdvice;
  applyPrefix: string;
  prefixKnown: boolean;
  stamp: string;
}): { dir: string; refused: string[] } | null {
  const stamp = opts.stamp;
  const roots = [projectSeshMoverDir(opts.targetPath), userSeshMoverDir()];
  for (const [index, root] of roots.entries()) {
    if (index === 0) {
      // Two reasons to skip the in-project destination. A symlink where the
      // plugin directory belongs would put a peer's payload outside the project
      // (`classifyDestination` is the same guard both workspace apply paths
      // use); and a project directory that is not on this machine at all must
      // not be CONJURED into existence by `mkdirSync -p` just to hold a saved
      // payload.
      if (!existsSync(opts.targetPath)) continue;
      const dest = classifyDestination(opts.targetPath, PROJECT_DIR_NAME, "dir");
      if (!dest.ok) continue;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const name = attempt === 0 ? `carry-${stamp}` : `carry-${stamp}-${attempt + 1}`;
      const dir = join(root, name);
      if (existsSync(dir)) continue;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, ".gitignore"), SAVED_CARRY_GITIGNORE, "utf-8");
        const { refused } = copyPayloadTree(opts.carryDir, dir);
        // Counted from what actually landed, never from `meta.untrackedCount`:
        // the manifest is the SENDER's claim about its own payload, so a bundle
        // declaring `0` while shipping an `untracked/` tree would get a README
        // that never mentions the copies sitting beside it. Nothing is written
        // either way — this only decides what the note says — but a note that
        // describes the directory it is in has to describe THIS directory.
        const untrackedSaved = listPayloadFiles(join(dir, "untracked")).length;
        writeFileSync(
          join(dir, "README.md"),
          renderSavedReadme({ ...opts, dir, untrackedSaved, refused }),
          "utf-8"
        );
        pruneSavedCarries(root, name);
        return { dir, refused };
      } catch {
        // A collision with a directory created between the check and the
        // mkdir, an unwritable root, or a fault part-way through the copy.
        // Remove whatever landed before trying the next name and then the next
        // root: a half-copied directory looks exactly like a complete one from
        // the outside, and the next root's save would leave it behind as a
        // silent, plausible-looking decoy of the peer's working tree.
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* nothing more this function can do; the next root still gets a try */
        }
        continue;
      }
    }
  }
  return null;
}

/**
 * What the saved README may tell the user to do with this payload.
 *
 * Three states rather than a boolean because two very different things withhold
 * the apply command, and saying the wrong one is a real cost either way: the
 * security paragraph on a merely damaged bundle accuses a peer of an attack,
 * and the damaged-bundle paragraph on a hostile one invites the user to fix it
 * up and apply it.
 */
type SavedAdvice =
  /** Guards declined, but the payload itself is sound: give the command. */
  | "apply"
  /** The floor or the symlink check fired. No command, and say why. */
  | "unsafe"
  /** `git apply` here could not parse it. No command, and DON'T call it hostile. */
  | "unparseable";

/**
 * A POSIX-shell single-quoted literal.
 *
 * The README's command block is copy-paste bait — it is the sole remedy on
 * every declining path — and every path in it is interpolated from the
 * project's own location. Unquoted inside `"…"`, a project at `<repo>/dol$lar`
 * emitted `--directory="dol$lar/"`, which the shell expands to `--directory=
 * "dol/"` (measured: the command then fails, or worse, applies somewhere else),
 * and a backtick or `$( )` in a directory name makes the line
 * command-injection-capable against the user pasting it. Self-inflicted — it is
 * the user's own path — but this is documentation of a command, and a command
 * we print has to be correct for the path it is printed for.
 *
 * Single quotes rather than escaping inside double quotes: nothing at all is
 * special inside them, so the only case to handle is the quote itself.
 */
function shQuote(raw: string): string {
  return `'${raw.split("'").join(`'\\''`)}'`;
}

/** The same, for the PowerShell line: single quotes, doubled to escape. */
function psQuote(raw: string): string {
  return `'${raw.split("'").join("''")}'`;
}

/**
 * Is there a `.git` at this path or above it?
 *
 * Used for exactly one judgment: when `git rev-parse` refuses, does that mean
 * "not a repository" (an empty apply prefix is then correct) or "this git
 * cannot read this repository" (the prefix is unknown and the README must say
 * so)? A linked worktree's `.git` is a FILE, so `existsSync` rather than a
 * directory test. Wrong in the safe direction on both sides: a stray `.git`
 * above an ordinary directory only adds the README's "find your prefix" note,
 * and a repository with no discoverable `.git` (a bare `GIT_DIR`, which this
 * module scrubs from the environment anyway) only omits it.
 *
 * That "safe in both directions" claim holds only because the walk goes all the
 * way to the filesystem root. An earlier depth cap of 64 broke it in the UNSAFE
 * direction: a project more than 64 directories deep answered `false`, i.e. "a
 * known-empty prefix", so a broken-git receiver was handed a README command
 * with no `--directory` and no caveat — the silent no-op this whole path exists
 * to prevent (measured at depth 70). `dirname` is purely lexical and strictly
 * shortens until it reaches a fixpoint, so the walk always terminates; the
 * counter below is a belt-and-braces guard that gives up towards "unknown".
 */
function hasGitAncestor(start: string): boolean {
  let dir = start;
  for (let depth = 0; depth < 4096; depth++) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return true;
}

/**
 * The manual-steps note that ships beside every saved payload.
 *
 * The command in here is the SOLE remedy on every declining path — a pull
 * records its bundles as received before it returns, so the re-run is
 * foreclosed — which makes `--directory` load-bearing rather than cosmetic. Get
 * it wrong on a subdirectory project and the command handed to the user exits
 * 0, writes nothing and says nothing (measured), while the result tells them
 * their payload is safely saved. `applyPrefix` is therefore read from THIS
 * machine before any decline can return, and when it could not be read at all
 * (no project directory here, no runnable `git`) the note says so rather than
 * guessing — `meta.repoPrefix` is the SENDER's layout and the same project can
 * be a monorepo package there and a plain clone here.
 */
function renderSavedReadme(opts: {
  dir: string;
  meta: CarryMeta;
  detail: string;
  advice: SavedAdvice;
  applyPrefix: string;
  prefixKnown: boolean;
  /** Untracked files really present in `dir` — see `saveCarryPayload`. */
  untrackedSaved: number;
  /** Untracked paths the floor kept OUT of `dir` — see `copyPayloadTree`. */
  refused: string[];
}): string {
  const { meta } = opts;
  const patch = join(opts.dir, "changes.patch");
  const untracked = join(opts.dir, "untracked");
  const directory = opts.applyPrefix ? ` --directory=${shQuote(opts.applyPrefix)}` : "";
  const lines = [
    "# Carried uncommitted changes (not applied)",
    "",
    `Reason: ${opts.detail}`,
    "",
    // Every one of the three through `orNotRecorded`: a manifest whose carry
    // block could not be read reaches here with empty strings, and this note is
    // the ONLY thing the user has to identify the payload sitting beside it.
    `Captured on branch \`${orNotRecorded(meta.branch)}\`${meta.detached ? " (detached HEAD)" : ""} at commit \`${orNotRecorded(meta.baseCommit)}\` on ${orNotRecorded(meta.capturedAt)}.`,
    `It holds a ${formatBytes(meta.patchBytes)} patch and ${opts.untrackedSaved} untracked file(s).`,
    "",
  ];
  if (meta.inProgress) {
    lines.push(
      `The other machine was in the middle of a \`${meta.inProgress}\` when this was captured, so the patch contains conflict markers as ordinary content and the ${meta.inProgress} itself did not travel.`,
      ""
    );
  }
  if (opts.refused.length > 0) {
    // Said HERE and not only in the pull's warnings, because this file is what
    // the user reads while running the copy command below — and that command
    // would have planted these paths verbatim.
    lines.push(
      `**${opts.refused.length} path(s) in this payload were left out of this directory on purpose** — they name plugin or VCS internals that sesh-mover never writes (\`.git\` or \`.sesh-mover\` at some depth, in some casing): ${opts.refused.slice(0, 5).map((p) => `\`${p}\``).join(", ")}. They are not below, so the commands in this file cannot plant them. A current sesh-mover never puts such a path in a bundle, so this one came from an older version, was damaged in transit, or was not produced by sesh-mover at all — nothing needs re-running, but read the rest of it before you use it.`,
      ""
    );
  }
  if (opts.advice === "unsafe") {
    lines.push(
      "**This payload was refused, not merely deferred.** It names paths that can never be written by sesh-mover (`.git` or `.sesh-mover` at some depth) or it carries symbolic links. Read it before you do anything with it — `.sesh-mover-include` decides what this machine's next push uploads, and the project-scope `config.json` decides where the hub is. No apply command is given here on purpose.",
      ""
    );
    return lines.join("\n") + "\n";
  }
  if (opts.advice === "unparseable") {
    // Deliberately NOT the paragraph above: this payload named nothing unsafe.
    // `git apply` on this machine could not parse it at all, so the checks that
    // decide whether it is safe to apply could not finish — which is a reason
    // to withhold the command, not a reason to accuse the sender.
    //
    // Unlike the `unsafe` branch this does NOT return early: what could not be
    // read is the PATCH, and a damaged patch says nothing whatever about the
    // untracked files sitting beside it. Withholding their copy command too
    // would be an accident, not a decision.
    lines.push(
      "**`git apply` on this machine could not read this patch**, so sesh-mover could not finish checking it and gives no apply command here. Nothing about it was found to be unsafe — the bundle looks damaged or truncated rather than hostile. The patch is beside this file if you want to inspect it; the surer fix is to have the other machine push again.",
      ""
    );
  } else {
    lines.push(
      "To apply it by hand, from the project directory:",
      "",
      "```bash",
      `git -c apply.ignoreWhitespace=no apply --whitespace=nowarn${directory} ${shQuote(patch)}`,
      "```",
      "",
      "Both settings matter: `apply.whitespace=fix` silently strips whitespace the patch adds, and `apply.ignoreWhitespace=change` will apply a patch whose context does not match and rewrite your indentation to it.",
      "",
    );
    if (!opts.prefixKnown) {
      lines.push(
        "This machine could not be asked where the project sits inside its repository, so the command above has no `--directory`. **If this project directory is inside a git repository but is not its root, add one** — from the project directory, `git rev-parse --show-prefix` prints exactly what it needs (for example `--directory='pkg/app/'`). Without it `git apply` resolves the patch's paths against the repository root, ignores everything outside your current directory, and exits 0 having written nothing.",
        "",
      );
    } else if (opts.applyPrefix) {
      lines.push(
        `\`--directory\` is not optional here: this project is the subdirectory \`${opts.applyPrefix}\` of its repository, and \`git apply\` resolves patch paths against the repository ROOT. Without it the command exits 0 and writes nothing at all.`,
        "",
      );
    }
  }
  if (opts.untrackedSaved > 0) {
    lines.push(
      (opts.advice === "unparseable"
        ? "The untracked files travelled as ordinary copies, not in the patch, so nothing above affects them. They are under `untracked/`."
        : "The untracked files are under `untracked/`.") +
        " Copying them OVERWRITES same-named files — sesh-mover's own apply never does that — so check first:",
      "",
      "```bash",
      `# macOS / Linux`,
      `cp -R ${shQuote(`${untracked}/.`)} .`,
      "```",
      "",
      "```powershell",
      `# Windows (PowerShell)`,
      `Copy-Item -Recurse -Force ${psQuote(join(untracked, "*"))} .`,
      "```",
      "",
    );
  }
  lines.push(
    "Delete this directory once you are done; nothing else reads it, and sesh-mover keeps only the most recent few."
  );
  return lines.join("\n") + "\n";
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
export async function applyCarry(opts: ApplyCarryOptions): Promise<ApplyResult> {
  const { carryDir, targetPath, meta } = opts;
  const stamp = stampNow(opts.__stamp);
  const patchPath = join(carryDir, "changes.patch");
  let patchBytes = 0;
  try {
    patchBytes = statSync(patchPath).size;
  } catch {
    patchBytes = 0;
  }

  // Read before anything else so that even a `no-git` machine's saved README
  // knows whether it may recommend applying this patch.
  const scan = patchBytes > 0 ? scanPatchBytes(patchPath) : { paths: [], symlink: null };
  /**
   * The half of the byte scan that is still ENFORCEMENT, on every receiver.
   *
   * A symlink entry, because git's own `--summary` does not report a re-pointed
   * one at all (measured); and a scan that could not run, because then the
   * symlink question itself is unanswered. Neither reads a path, so neither
   * carries the parsing surface issue #38 is about.
   */
  const scanBlocking = scan === null || scan.symlink !== null;
  /**
   * The whole scan verdict, path half included. Since #38 this decides only
   * what the SAVED README may say, plus the floor on the last-resort paths
   * where git could not parse the patch — and nothing is ever applied there.
   */
  const scanUnsafe =
    scan === null ||
    scan.symlink !== null ||
    scan.paths.some((p) => isNeverIncludable(p));

  // `applyPrefix` is deliberately mutable and read at CALL time by `decline`:
  // it is what the saved README's apply command needs, and that README is the
  // only remedy every declining path has. A prefix threaded as an argument was
  // simply absent from every decline that returns before it is measured — which
  // included the routine `not-requested` one.
  let applyPrefix = "";
  let prefixKnown = false;

  const decline = (
    reason: CarryApplyDeclineReason,
    detail: string,
    // Defaulted rather than passed at every call site: "did the floor fire?" is
    // the question, and only the one caller that knows better overrides it.
    advice: SavedAdvice = scanUnsafe || reason === "unsafe-payload" ? "unsafe" : "apply"
  ): CarryNotApplied => {
    const saved = saveCarryPayload({
      carryDir, targetPath, meta, detail, stamp, applyPrefix, prefixKnown, advice,
    });
    return {
      applied: false,
      reason,
      detail,
      savedTo: saved?.dir ?? null,
      // What the README actually contains, decided at the one place that knows.
      // Callers describe the save to the user and must not offer commands the
      // two withholding branches deliberately left out.
      savedCommands: saved !== null && advice === "apply",
      refused: saved?.refused ?? [],
    };
  };

  /**
   * The byte scan's own refusal, deferred so that git's parse — which names the
   * path with the prefix it would REALLY have applied — gets to speak first
   * when both sources see the same entry. Nothing between here and the call
   * site writes anything: the prefix probe and `--numstat` are both read-only.
   */
  const declineScan = (): CarryNotApplied =>
    decline(
      "unsafe-payload",
      scan === null
        ? "the patch could not be read or is too large to inspect"
        : scan.symlink !== null
          ? `the patch creates or changes a symbolic link (${scan.symlink}), which is never applied`
          : `the patch writes paths that never travel (${scan.paths.filter((p) => isNeverIncludable(p)).slice(0, 3).join(", ")})`
    );

  // Where this project sits inside its repository, measured BEFORE any decline
  // can return. Two things need it and both are load-bearing:
  //
  // 1. Every `git apply` below. `git apply` resolves patch paths against the
  //    REPOSITORY ROOT and silently ignores anything outside the current
  //    directory — exit 0, no stderr, nothing written, and `--check` and
  //    `--numstat` are just as quiet (all measured). A `--relative` patch
  //    applied at a project that is a repo SUBDIRECTORY is a silent no-op
  //    without this, and a `--numstat` floor check reading no entries at all
  //    passes vacuously.
  // 2. The saved README's apply command, on every decline.
  //
  // Read from THIS machine, never from `meta.repoPrefix`: the same project can
  // be a monorepo package on one machine and a plain clone on the other, and
  // what has to be translated is where the patch lands HERE.
  //
  // Spawning with a cwd that does not exist fails with the SAME `ENOENT` a
  // missing git binary does (verified), so the directory is checked first.
  const targetExists = existsSync(targetPath);
  let gitDir = "";
  // Did `git` actually ANSWER a question about this directory? Everything below
  // that reads git's opinion of the PATCH depends on it: a `git` that cannot
  // read this repository refuses every command the same way, and reading such a
  // refusal as a verdict on the payload accuses the sender of the receiver's
  // problem (see the floor check below).
  let gitAnswered = false;
  if (targetExists) {
    const where = git(targetPath, ["rev-parse", "--absolute-git-dir", "--show-prefix"], 64 * 1024);
    if (where.ok) {
      const [dir = "", prefix = ""] = where.stdout.toString("utf-8").split("\n").map((l) => l.trim());
      gitDir = dir;
      applyPrefix = prefix;
      prefixKnown = true;
      gitAnswered = true;
    } else if (where.code !== "ENOENT" && !hasGitAncestor(targetPath)) {
      // A real `git` refused AND there is no `.git` anywhere above this
      // directory: the answer is "not a repository", and the empty prefix is
      // then the RIGHT answer rather than a missing one — outside a repository
      // `git apply` resolves paths against the cwd (measured).
      //
      // With a `.git` present the same refusal means git could not READ the
      // repository (an unparseable `.git/config`, `safe.directory` ownership,
      // an unreadable `.git`), and claiming an empty prefix there would hand a
      // SUBDIRECTORY project a command that exits 0 and writes nothing once
      // they fix their git — the silent no-op this module exists to avoid. So
      // the prefix stays unknown and the README says how to find it.
      prefixKnown = true;
    }
  }

  // git's own parse of the patch — since issue #38 the ONLY floor source, and
  // the only one that is authoritative about how git will actually resolve each
  // entry. `--summary` rides along with `--numstat` because it carries the one
  // path `--numstat` structurally omits, a rename's or copy's SOURCE; see
  // `parseApplyPaths`.
  //
  // It runs BEFORE the `saveOnly` return on purpose. Saving is the routine
  // path, its README recommends applying the patch by hand, and recommending a
  // payload that `--apply-carry` would refuse as `unsafe-payload` is exactly
  // the advice this guard exists to withhold.
  //
  // A FAILURE here has three readings and they must not be conflated — the
  // whole point of the split below. `unsafe-payload` is a verdict about the
  // SENDER: it carries the security wording, it withholds the apply command,
  // and the skill layer relays it as "read this before you touch it". So it may
  // only be reached when the payload is what went wrong:
  //
  // 1. `git` could not be run at all (ENOENT) — diagnosed as `no-git` below.
  // 2. `git` ran but never answered a question about this directory
  //    (`gitAnswered` false): an unparseable `.git/config`, `safe.directory`
  //    ownership, an unreadable `.git`. It then refuses EVERY command with the
  //    same words, so its refusal of this one is no evidence about the patch.
  //    Measured: a `.git/config` with a bad line turned a perfectly ordinary
  //    payload into `unsafe-payload: the patch could not be parsed (fatal: bad
  //    config line 12 …)` — the receiver's own problem, reported as a hostile
  //    sender, on the routine no-flag path as well as under `--apply-carry`.
  // 3. `git` is working here and refused THIS patch (a corrupt or truncated
  //    bundle). That is a real defect in the payload, but it is not the floor
  //    firing — nothing unsafe was named — so it declines as `apply-failed`
  //    with git's own words, and the saved README says the patch could not be
  //    inspected rather than that it named paths that can never be written.
  //
  // (1) and (2) fall through: the guard chain below diagnoses the receiver's
  // state in git's own words, and the raw byte scan above — which needs no git
  // — remains the floor there.
  //
  // `gitFloorAnswered` is what the write path is gated on further down: this
  // block is the ONLY place the floor is decided for a patch, so an execution
  // that reaches `--check` without it having succeeded would apply an
  // un-floored patch. Falling through here is not rare — a timeout, an
  // over-budget buffer or a receiver whose git cannot read its own repository
  // all land in the branches below.
  let gitFloorAnswered = false;
  let gitFloorDetail = "";
  if (patchBytes > 0 && targetExists) {
    const numstat = git(
      targetPath,
      applyInvocation(applyPrefix, ["--numstat", "-z", "--summary"], patchPath),
      LS_FILES_MAX_BUFFER
    );
    if (numstat.ok) {
      const described = parseApplyPaths(numstat.stdout.toString("utf-8"));
      if (described.unreadable.length > 0) {
        // Git described the patch and this module could not read the whole
        // description back, so the floor cannot answer for every path it names.
        // A refusal is the only honest verdict: the measured way to produce this
        // is a rename destination holding a newline, which splits the very line
        // that carries the rename's SOURCE (see `SUMMARY_ACCOUNTED_FOR`).
        return decline(
          "unsafe-payload",
          `git's own description of this patch could not be read back, so the paths it writes could not all be checked (${described.unreadable.slice(0, 2).map((l) => JSON.stringify(l)).join(", ")})`
        );
      }
      gitFloorAnswered = true;
      const unsafe = [...described.destinations, ...described.sources]
        .filter((p) => isNeverIncludable(p));
      if (unsafe.length > 0) {
        return decline(
          "unsafe-payload",
          `the patch writes paths that never travel (${unsafe.slice(0, 3).join(", ")})`
        );
      }
    } else if (gitAnswered && numstat.status !== null && !scanUnsafe) {
      // `status !== null` means the process ran to completion and made a
      // judgment. A timeout, an over-budget buffer or a permission fault leave
      // it null — those are this machine failing to ask, not git answering.
      //
      // `!scanUnsafe` because hostile outranks damaged: a patch git cannot
      // parse can still carry a header naming plugin internals, and that user
      // must get the security wording rather than "looks damaged".
      return decline(
        "apply-failed",
        `the carried patch could not be parsed here (${numstat.stderr || String(numstat.code ?? "")})`,
        "unparseable"
      );
    }
    if (!gitFloorAnswered) {
      gitFloorDetail = numstat.ok
        ? ""
        : numstat.stderr || String(numstat.code ?? "git could not describe the patch");
    }
  }

  // The byte scan's verdict.
  //
  // Its SYMLINK half speaks on every receiver — `--summary` reports nothing at
  // all for a re-pointed symlink (measured), so this is the only source for that
  // shape. Its PATH half speaks only where git's own parse could not run or
  // could not be trusted: `!gitFloorAnswered`. Since #38 those are exactly the
  // executions that can never write anything (the gate below refuses them), so
  // what the path half decides there is the saved README's wording, not a file
  // on disk — and where git DID answer, the byte scan no longer over-refuses a
  // spelling git discards at `-p1`.
  if (scanBlocking || (!gitFloorAnswered && scanUnsafe)) return declineScan();

  if (opts.saveOnly) {
    return decline(
      "not-requested",
      "the pull did not ask for carried changes to be applied (--apply-carry)"
    );
  }

  if (!targetExists) {
    // Without this a pull into a project directory that is not here yet would
    // report "git could not be run" — a diagnosis pointing at the wrong
    // machine entirely.
    return decline("not-git", "the project directory does not exist on this machine");
  }
  const head = git(targetPath, ["rev-parse", "--verify", "HEAD"], 4096);
  if (!head.ok) {
    return head.code === "ENOENT"
      ? decline("no-git", "git could not be run on this machine")
      : decline(
          "not-git",
          `the project directory is not inside a git repository with commits (${head.stderr || String(head.code ?? "")})`
        );
  }
  const headSha = head.stdout.toString("utf-8").trim();

  // Also the gate a carry block that could not be read falls through:
  // `normalizeCarryMeta` leaves `baseCommit` as `""`, which no `rev-parse HEAD`
  // can equal, so an unreadable base declines here and SAVES rather than
  // applying an unanchored patch. See that function for why fail-closed is
  // expressed as a value instead of a refusal.
  if (headSha !== meta.baseCommit) {
    return decline(
      "wrong-base",
      `this machine is at commit ${headSha.slice(0, 8)}, the changes were captured at ${orNotRecorded(meta.baseCommit.slice(0, 8))} on branch ${orNotRecorded(meta.branch)}`
    );
  }
  const inProgress = gitDir ? detectInProgress(gitDir) : null;
  if (inProgress) {
    // A tree can be perfectly clean mid-rebase (`git rebase --exec` stopping on
    // a failed command, an `edit`/`break` stop), so the dirty check below
    // cannot see this. Applying there leaves `git rebase --continue` refusing
    // to run against a dirty tree, for reasons the user never asked for.
    return decline(
      "in-progress",
      `this machine is in the middle of a ${inProgress} — finish or abort it first`
    );
  }
  // `-- .` scopes the question to the project directory: a monorepo package
  // must not be blocked by unrelated dirt elsewhere in the repository, and the
  // patch cannot reach outside the subtree anyway.
  const status = git(targetPath, ["status", "--porcelain", "-uno", "--", "."], LS_FILES_MAX_BUFFER);
  if (!status.ok) {
    return decline(
      "dirty-tree",
      `this machine's working tree could not be verified as clean (${status.stderr || String(status.code ?? "")})`
    );
  }
  if (status.stdout.toString("utf-8").trim().length > 0) {
    return decline(
      "dirty-tree",
      "this machine has uncommitted changes of its own, which the carried patch would be mixed into irreversibly"
    );
  }

  let filesChanged = 0;
  if (patchBytes > 0) {
    // THE gate that makes git the single floor source safe (issue #38).
    //
    // Everything above this line is read-only; everything below it writes. The
    // floor is decided in exactly one place — the `--numstat -z --summary` call
    // — and that call is allowed to FAIL without returning: a receiver whose git
    // cannot read its own repository must be diagnosed by the guard chain in
    // git's own words rather than accused of a hostile payload, and a timeout or
    // an over-budget buffer is this machine failing to ask rather than git
    // answering. Both fell through to `git apply` before this gate existed,
    // where `rev-parse --verify HEAD` succeeding was mistaken for "git has
    // answered about the patch". It had answered about the DIRECTORY. Nothing
    // may be written until it has answered about the PATCH.
    if (!gitFloorAnswered) {
      return decline(
        "apply-failed",
        `git could not describe the carried patch here, so the paths it writes could not be checked${gitFloorDetail ? ` (${gitFloorDetail})` : ""}`,
        // Never the default: a clean byte scan must not be read as permission to
        // recommend a patch whose paths were never checked.
        scanUnsafe ? "unsafe" : "unparseable"
      );
    }
    const check = git(
      targetPath,
      applyInvocation(applyPrefix, ["--check"], patchPath),
      1024 * 1024
    );
    if (!check.ok) {
      return decline(
        "apply-failed",
        `the carried patch does not apply here (${check.stderr || String(check.code ?? "")})`
      );
    }
    const applied = git(targetPath, applyInvocation(applyPrefix, [], patchPath), 1024 * 1024);
    if (!applied.ok) {
      // `--check` just passed, so this is an IO fault rather than a mismatch.
      // `git apply` is all-or-nothing on the mismatch class (measured: a
      // two-file patch whose second file conflicts leaves the first untouched),
      // but a write fault mid-run is not covered by that, so the detail says to
      // look rather than promising nothing happened.
      return decline(
        "apply-failed",
        `git apply failed after its dry run passed (${applied.stderr || String(applied.code ?? "")}) — check \`git status\` before re-trying`
      );
    }
    filesChanged = patchFileCount(targetPath, applyPrefix, patchPath);
  }

  const collisions: string[] = [];
  const refused: string[] = [];
  const blocked: CarryApplied["blocked"] = [];
  let untrackedCopied = 0;
  const untrackedRoot = join(carryDir, "untracked");
  if (existsSync(untrackedRoot)) {
    for (const rel of listPayloadFiles(untrackedRoot)) {
      // The floor again, on the other half of the payload: these paths were
      // filtered by the SENDING machine, which says nothing about a hand-made
      // or older bundle. Skipping one path (rather than refusing the whole
      // payload as the patch does) follows `unpackWorkspace`: there is no
      // half-applied state to worry about, and the rest of the payload is
      // useful.
      if (isNeverIncludable(rel)) {
        refused.push(rel);
        continue;
      }
      const dest = classifyDestination(targetPath, rel, "file");
      if (!dest.ok) {
        blocked.push({ path: rel, reason: dest.reason });
        continue;
      }
      const src = join(untrackedRoot, rel);
      const to = join(targetPath, ...rel.split("/"));
      try {
        if (existsSync(to)) {
          if (readFileSync(to).equals(readFileSync(src))) continue; // identical: no-op
          const sidecar = uniqueSidecarPath(to, stamp);
          if (sidecar === null) {
            blocked.push({ path: rel, reason: "io-error" });
            continue;
          }
          copyFileSync(src, sidecar);
          collisions.push(rel);
          continue;
        }
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(src, to);
        untrackedCopied++;
      } catch {
        // One unwritable file must not cost the user the rest of the payload,
        // and it must not be silent either.
        blocked.push({ path: rel, reason: "io-error" });
      }
    }
  }

  return { applied: true, filesChanged, untrackedCopied, collisions, refused, blocked };
}

/**
 * How many file entries the patch changed, from git's own parse.
 *
 * Deliberately not `git diff --name-only` after the fact: that is a second
 * porcelain surface to harden, it cannot see files the patch CREATED (they are
 * untracked), and it would count unrelated dirt if the tree check were ever
 * loosened. A rename counts once, which is what `--numstat` reports.
 *
 * Built through `applyInvocation` like the other three, and `applyPrefix` is
 * not optional here either: without it a subdirectory project reported `0`
 * verbatim to the user for every patch it had just successfully applied.
 */
function patchFileCount(cwd: string, applyPrefix: string, patchPath: string): number {
  const numstat = git(
    cwd,
    applyInvocation(applyPrefix, ["--numstat", "-z"], patchPath),
    LS_FILES_MAX_BUFFER
  );
  if (!numstat.ok) return 0;
  return numstat.stdout.toString("utf-8").split("\0").filter((r) => r.length > 0).length;
}

/**
 * `<dest>.incoming-<stamp>`, uniquified.
 *
 * Two applies can share a stamp — the test seam pins it, and two pulls in the
 * same millisecond would too — and silently overwriting the earlier sidecar
 * would lose the very copy this path exists to preserve.
 */
function uniqueSidecarPath(dest: string, stamp: string): string | null {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${dest}.incoming-${stamp}${attempt === 0 ? "" : `-${attempt + 1}`}`;
    if (!existsSync(candidate)) return candidate;
  }
  return null;
}
