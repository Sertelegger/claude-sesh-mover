import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { classifyDestination, formatBytes, isCarriedPath, isNeverIncludable, isReIncluded, NEVER_INCLUDABLE, readCarryRules, } from "./workspace.js";
import { PROJECT_DIR_NAME, projectSeshMoverDir, userSeshMoverDir } from "../paths.js";
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
 * `.sesh-mover/config.json` (which can redirect `hub.path`) or
 * `.sesh-mover-hubinclude` (which decides what the next push ships).
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
const SCRUBBED_GIT_ENV = Object.freeze([
    "GIT_DIFF_OPTS", "GIT_EXTERNAL_DIFF",
    "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
    "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
]);
/** Prefixed families that go with `GIT_CONFIG_COUNT` (`GIT_CONFIG_KEY_0`, …). */
const SCRUBBED_GIT_ENV_PREFIXES = Object.freeze([
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
export function gitChildEnv() {
    const env = { ...process.env };
    for (const name of SCRUBBED_GIT_ENV)
        delete env[name];
    for (const name of Object.keys(env)) {
        if (SCRUBBED_GIT_ENV_PREFIXES.some((p) => name.startsWith(p)))
            delete env[name];
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
 * One `git` invocation, as a value rather than an exception.
 *
 * `maxBuffer` is a budget, not a safety margin: the caller sets it to
 * `maxBytes + 1` so an over-budget diff is REFUSED rather than buffered. Node
 * kills the child with SIGTERM and reports `ENOBUFS` in that case, which is
 * harmless for the read-only commands used here.
 */
function git(cwd, args, maxBuffer) {
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
    }
    catch (e) {
        const err = e;
        return {
            ok: false,
            status: typeof err.status === "number" ? err.status : null,
            code: err.code,
            stderr: (err.stderr?.toString() ?? "").split("\n")[0].trim().slice(0, 200),
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
function splitZ(stdout) {
    return stdout.toString("utf-8").split("\0").filter((p) => p.length > 0);
}
/** A failed `git ls-files`, with ENOBUFS translated out of its libuv spelling. */
function listFailure(r) {
    return {
        captured: false,
        reason: "git-failed",
        detail: r.code === "ENOBUFS"
            ? "this working tree lists too many untracked files to enumerate"
            : r.stderr || String(r.code ?? ""),
    };
}
/**
 * Which operation, if any, the working tree is in the middle of. Read from the
 * git directory (which is `.git/worktrees/<name>` in a linked worktree, hence
 * `--absolute-git-dir` rather than a hand-built path).
 */
function detectInProgress(gitDir) {
    if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
        return "rebase";
    }
    if (existsSync(join(gitDir, "MERGE_HEAD")))
        return "merge";
    if (existsSync(join(gitDir, "CHERRY_PICK_HEAD")))
        return "cherry-pick";
    if (existsSync(join(gitDir, "REVERT_HEAD")))
        return "revert";
    return null;
}
/**
 * Take the paths `git` handed us and keep the ones that may actually travel.
 *
 * Everything is filtered through `isCarriedPath`, which is the same rule the
 * workspace walk applies — including the `NEVER_INCLUDABLE` floor, which is
 * what stops `.sesh-mover/config.json` (a file that can redirect
 * `hub.path`) and `.sesh-mover-hubinclude` (the file deciding what the
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
function collectFiles(projectPath, rels, rules, diagnostics) {
    const files = [];
    for (const { rel, reIncluded } of rels) {
        if (!isCarriedPath(rel, rules))
            continue;
        let st;
        try {
            st = lstatSync(join(projectPath, rel));
        }
        catch {
            // Almost always a filename git reported in bytes this platform cannot
            // round-trip through UTF-8; occasionally a file deleted mid-push. Either
            // way it does not travel, and a silent omission is what this exists to
            // prevent.
            diagnostics.push(`Uncommitted file ${JSON.stringify(rel)} could not be read and was left out of this push's carry payload.`);
            continue;
        }
        if (!st.isFile())
            continue; // symlink, directory (nested repo), socket, FIFO
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
function describeLargest(files, patchBytes) {
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
function findTrackedIgnored(projectPath, diagnostics) {
    const tracked = git(projectPath, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"], LS_FILES_MAX_BUFFER);
    if (!tracked.ok) {
        diagnostics.push("Could not determine whether any gitignored file is tracked and travelled in this push's patch " +
            `(${tracked.stderr || String(tracked.code ?? "git failed")}).`);
        return [];
    }
    const ignoredTracked = new Set(splitZ(tracked.stdout));
    if (ignoredTracked.size === 0)
        return [];
    const changed = git(projectPath, ["diff", "HEAD", "--name-only", "-z", "--relative", ...PATCH_HARDENING, ...FLOOR_PATHSPEC], LS_FILES_MAX_BUFFER);
    if (!changed.ok) {
        diagnostics.push("Could not determine which gitignored tracked files travelled in this push's patch " +
            `(${changed.stderr || String(changed.code ?? "git failed")}).`);
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
export async function captureCarry(projectPath, destDir, opts) {
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
    const diff = git(projectPath, ["diff", "HEAD", "--binary", "--relative", ...PATCH_HARDENING, ...FLOOR_PATHSPEC], 
    // +1 so a diff that exactly fills the budget is still measurable, and
    // anything past it is refused by Node instead of being buffered.
    maxBytes + 1);
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
    const untracked = git(projectPath, 
    // -z is not a nicety: without it git applies core.quotePath, so a name with
    // a space, a quote or any non-ASCII byte comes back C-quoted and
    // octal-escaped — a spelling that never lstats, so the file would vanish
    // from the payload in silence.
    ["ls-files", "--others", "--exclude-standard", "-z"], LS_FILES_MAX_BUFFER);
    if (!untracked.ok)
        return listFailure(untracked);
    const rules = readCarryRules(projectPath, diagnostics);
    const candidates = new Map(); // rel -> came from re-inclusion
    for (const rel of splitZ(untracked.stdout))
        candidates.set(rel, false);
    // hubinclude re-adds deliberately-ignored paths (this repo's own
    // docs/superpowers is the canonical case). Everything else gitignored stays
    // put — .gitignore is also where secrets live, so inclusion is opt-in,
    // committed and reviewable. `isReIncluded` decides it, on the full
    // repo-relative path: re-deriving the rule here is how the two would drift.
    if (rules.includePatterns.length > 0) {
        const ignored = git(projectPath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], LS_FILES_MAX_BUFFER);
        if (!ignored.ok)
            return listFailure(ignored);
        for (const rel of splitZ(ignored.stdout)) {
            if (!candidates.has(rel) && isReIncluded(rel, rules.includePatterns))
                candidates.set(rel, true);
        }
    }
    const files = collectFiles(projectPath, [...candidates].map(([rel, reIncluded]) => ({ rel, reIncluded })), rules, diagnostics);
    // Decided AFTER filtering: a tree whose only "dirt" is plugin state or an
    // excluded build directory is clean as far as the hub is concerned, and
    // writing an empty payload for it would be noise on every push.
    if (patch.length === 0 && files.length === 0)
        return { captured: false, reason: "clean" };
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
    const cleanupPartial = () => {
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
            }
            catch {
                /* best effort: the caller's staging directory is removed wholesale anyway */
            }
        }
    };
    let written = 0;
    let writtenBytes = 0;
    const reIncluded = [];
    try {
        mkdirSync(destDir, { recursive: true });
        writeFileSync(join(destDir, "changes.patch"), patch);
        for (const file of files) {
            const dest = join(destDir, "untracked", ...file.rel.split("/"));
            try {
                mkdirSync(dirname(dest), { recursive: true });
                copyFileSync(join(projectPath, file.rel), dest);
            }
            catch (e) {
                // One unreadable file must not cost the user the whole push: the
                // session bundle this carry rides on is the point of the operation.
                diagnostics.push(`Uncommitted file ${JSON.stringify(file.rel)} could not be copied into this push's carry payload (${e.message.slice(0, 120)}).`);
                continue;
            }
            written++;
            writtenBytes += file.size;
            if (file.reIncluded)
                reIncluded.push(file.rel);
        }
        const meta = {
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
    }
    catch (e) {
        cleanupPartial();
        return { captured: false, reason: "write-failed", detail: e.message.slice(0, 200) };
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
 *   `.sesh-mover-hubinclude` was refused at a repo-root project and
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
 * `mode` is what distinguishes them (`["--numstat", "-z"]`, `["--check"]`, or
 * nothing at all); everything else is shared by construction.
 */
function applyInvocation(applyPrefix, mode, patchPath) {
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
 * Cap on a patch this module will INSPECT. Over it the payload is declined
 * rather than applied unchecked: the floor and symlink guards below both read
 * the whole patch, and a guard that silently gives up on large input is not a
 * guard. The sender's own budget is `CARRY_MAX_BYTES` (5 MB), so this only ever
 * bites a hand-made or damaged bundle.
 */
const PATCH_SCAN_MAX_BYTES = 32 * 1024 * 1024;
/**
 * How many saved carry payloads a project keeps. A carry rides every push that
 * has session content and `hub.carryDiff` is on by default, so an unapplied
 * carry is the ROUTINE case, not the exception — without a bound the project
 * would accumulate one copy of the peer's working tree per pull. Pruning only
 * ever removes this module's own `carry-<stamp>` directories, newest kept.
 */
const SAVED_CARRY_RETENTION = 5;
/** `2026-08-04T09-12-33-501Z` — filesystem-safe and lexically sortable. */
function stampNow(override) {
    return override ?? new Date().toISOString().replace(/[:.]/g, "-");
}
/** The one-character escapes `unquote_c_style` knows, and nothing else. */
const C_QUOTE_ESCAPES = {
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
 *   did) means one appended junk byte — `".sesh-mover-hubinclude"X` —
 *   leaves the literal token as the only reading, whose leading `"` fuses into
 *   the first segment so `isNeverSegment` no longer matches, while git decodes
 *   the real path and applies it. Measured on a healthy-git receiver at both
 *   layouts: that spelling on a `rename from` line DELETED the receiver's
 *   `.sesh-mover-hubinclude`, and on a `copy from` line reproduced it at
 *   an ordinary path from where the next auto-push would upload it.
 * - **An octal escape is exactly three digits with the first in 0–3**; two
 *   digits (`\56`) or a leading `4`–`7` is an ERROR, not a shorter escape.
 * - **An unknown escape (`\z`) is an error too.**
 *
 * On error git's `find_name` falls back to reading the LITERAL bytes, which is
 * why `null` here is not "no path": every caller keeps the raw token as a
 * candidate of its own, exactly mirroring that fallback.
 */
function unquoteGitPath(raw) {
    if (!raw.startsWith('"'))
        return null;
    const bytes = [];
    for (let i = 1; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '"')
            return Buffer.from(bytes).toString("utf-8");
        if (ch !== "\\") {
            bytes.push(raw.charCodeAt(i) & 0xff);
            continue;
        }
        const next = raw[++i];
        if (next === undefined)
            break; // trailing backslash: unterminated
        if (next >= "0" && next <= "3") {
            const d2 = raw[i + 1];
            const d3 = raw[i + 2];
            if (d2 === undefined || d2 < "0" || d2 > "7")
                return null;
            if (d3 === undefined || d3 < "0" || d3 > "7")
                return null;
            bytes.push(parseInt(raw.slice(i, i + 3), 8) & 0xff);
            i += 2;
            continue;
        }
        const code = C_QUOTE_ESCAPES[next];
        if (code === undefined)
            return null; // includes octal starting 4-7
        bytes.push(code);
    }
    return null; // no closing quote — git's unquote fails and the literal wins
}
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
function headerPathCandidates(rest, kind) {
    const readings = [rest, rest.trim()];
    if (kind === "name") {
        const tabbed = rest.split("\t")[0];
        readings.push(tabbed, tabbed.trim());
        const dated = rest.replace(TRAILING_TIMESTAMP, "");
        if (dated !== rest)
            readings.push(dated, dated.trim());
    }
    const out = [];
    const seen = new Set();
    for (const reading of readings) {
        if (seen.has(reading))
            continue;
        seen.add(reading);
        for (const form of [reading, unquoteGitPath(reading)]) {
            // `/dev/null` is git's "no such side" marker, not a path the floor judges.
            if (form === null || form.length === 0 || form === "/dev/null")
                continue;
            out.push(form);
            const stripped = form.replace(/^[ab]\//, "");
            if (stripped !== form && stripped.length > 0)
                out.push(stripped);
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
function halfReadings(raw) {
    const out = [raw];
    const trimmed = raw.trim();
    if (trimmed !== raw)
        out.push(trimmed);
    const decoded = unquoteGitPath(trimmed);
    if (decoded !== null && decoded !== trimmed)
        out.push(decoded);
    return out;
}
/** Everything past the first `/`, or `null` when there is no component to strip. */
function stripOneComponent(path) {
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
 * way `copy from .sesh-mover-hubinclude` arises either — so covering
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
function diffGitHeaderPaths(rest, budget) {
    if (rest.length > HEADER_SCAN_MAX_LEN)
        return null;
    const out = [];
    let splits = 0;
    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        // Git's separator class here is its own `isspace` (sane_ctype): space, TAB
        // and CR separate the two names; VT and FF do not.
        if (ch !== " " && ch !== "\t" && ch !== "\r")
            continue;
        if (++splits > HEADER_SCAN_MAX_SPLITS)
            return null;
        const lefts = halfReadings(rest.slice(0, i));
        const rights = halfReadings(rest.slice(i + 1));
        // The budget counts bytes COMPARED, so growing the readings per half grows
        // the charge with it rather than silently multiplying the work behind a
        // per-split charge. Over budget the whole scan fails closed.
        budget.left -= rest.length * lefts.length * rights.length;
        if (budget.left < 0)
            return null;
        for (const left of lefts) {
            for (const right of rights) {
                const leftStripped = stripOneComponent(left);
                const rightStripped = stripOneComponent(right);
                const strippedAgree = leftStripped !== null && leftStripped === rightStripped;
                if (!strippedAgree && left !== right)
                    continue;
                if (strippedAgree)
                    out.push(leftStripped);
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
 * Two sources, because neither is complete alone:
 *
 * - `git apply --numstat -z` is git's own parse — authoritative and unquoted.
 *   But for a RENAME **or a COPY** it prints only the DESTINATION (measured
 *   both), so the source path is invisible to it: `copy from
 *   .sesh-mover-hubinclude` / `copy to stolen.txt` materialises the
 *   RECEIVER's own plugin internals at an ordinary path, from where the next
 *   auto-push carries them to the hub. It also cannot run at all on a machine
 *   with no `git`, or on one whose `git` cannot read this repository.
 * - A raw scan of the patch bytes covers every path git can name in a header:
 *   `---`/`+++`, `rename from`/`to`, **`rename old`/`new`**, `copy from`/`to`,
 *   the `diff --git` line itself (the only reference a mode-only change or a
 *   binary entry has), and the `index … 120000` line of a re-pointed symlink —
 *   which `--summary` does NOT print (measured: nothing at all for that shape).
 *   It needs no `git`, so it is the whole floor on a machine where the other
 *   source cannot run, and the saved README's recommendation rests on it there.
 *
 * The list of spellings is not a guess and not "what `git diff` emits" — it is
 * git's own `parse_git_header` keyword table, read out of the shipped binary
 * (`strings`, git 2.50.1). Sixteen entries; the nine path-bearing ones are the
 * nine above. `similarity index`, `dissimilarity index`, `index` and the four
 * mode lines carry no path. **`rename old `/`rename new ` are git's legacy
 * spelling of `rename from`/`to`, and it still accepts them** — measured: an
 * otherwise identical payload deleted `.sesh-mover-hubinclude` and
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
 * against real `git apply --numstat -z --summary` on a scratch repo. The
 * invariant it enforces is exactly the one this function owes its caller: **if
 * git resolves a spelling to a path the floor forbids, this scan produces a
 * candidate the floor forbids.** Add an axis value there when a new spelling
 * shows up; do not add a case to a list here.
 */
function scanPatchBytes(patchPath) {
    let size;
    try {
        size = statSync(patchPath).size;
    }
    catch {
        return null;
    }
    if (size > PATCH_SCAN_MAX_BYTES)
        return null;
    let text;
    try {
        // latin1: a lossless byte<->char mapping, so a binary hunk cannot throw off
        // line splitting and a path's bytes survive to be re-decoded as UTF-8.
        text = readFileSync(patchPath).toString("latin1");
    }
    catch {
        return null;
    }
    const paths = [];
    let symlink = null;
    const headerBudget = { left: HEADER_SCAN_BUDGET };
    for (const rawLine of text.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (/^(new file mode|deleted file mode|old mode|new mode) 120000$/.test(line) ||
            /^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/.test(line)) {
            symlink ??= line;
            continue;
        }
        let found = [];
        if (line.startsWith("--- ") || line.startsWith("+++ "))
            found = headerPathCandidates(line.slice(4), "name");
        else if (line.startsWith("rename from "))
            found = headerPathCandidates(line.slice(12), "rename-copy");
        else if (line.startsWith("rename to "))
            found = headerPathCandidates(line.slice(10), "rename-copy");
        // Git's legacy spelling of the same two lines, still in its keyword table
        // and still accepted (measured end to end).
        else if (line.startsWith("rename old "))
            found = headerPathCandidates(line.slice(11), "rename-copy");
        else if (line.startsWith("rename new "))
            found = headerPathCandidates(line.slice(11), "rename-copy");
        else if (line.startsWith("copy from "))
            found = headerPathCandidates(line.slice(10), "rename-copy");
        else if (line.startsWith("copy to "))
            found = headerPathCandidates(line.slice(8), "rename-copy");
        else if (line.startsWith("diff --git ")) {
            const header = diffGitHeaderPaths(line.slice(11), headerBudget);
            // Unparseable within the budget: the floor cannot answer for this entry,
            // and on a machine where `--numstat` cannot run this scan is the whole
            // floor. Fail the scan closed.
            if (header === null)
                return null;
            found = header;
        }
        // Read as latin1 above, so a path's bytes are intact and re-decode as UTF-8
        // here — the spelling `isNeverIncludable` has to fold.
        for (const path of found)
            paths.push(Buffer.from(path, "latin1").toString("utf-8"));
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
function listPayloadFiles(root) {
    const out = [];
    const walk = (dir, rel) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            // Never followed, never copied: the archiver rejects symlink tar entries,
            // so this only bites a hand-made payload — which is exactly the one that
            // would point at ~/.ssh.
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory())
                walk(join(dir, entry.name), childRel);
            else if (entry.isFile())
                out.push(childRel);
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
 * `untracked/.sesh-mover-hubinclude` that `applyCarry` refuses outright
 * (`refused[]`, nothing written) was planted by the routine `not-requested`
 * path the moment the user followed our own instructions — the one path whose
 * sibling has the defence. Only a hand-made, damaged or pre-floor bundle can
 * contain such a path, which is what makes this defence in depth rather than a
 * live hole; it is still the same floor, applied where the write happens.
 *
 * Returns the refused repo-relative paths so the README can say what is missing
 * from the copy it is describing.
 */
function copyPayloadTree(src, dest) {
    const refused = [];
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
const SAVED_CARRY_GITIGNORE = `${SAVED_CARRY_MARKER}\n# Self-ignoring so it can never be committed by accident.\n*\n`;
/** Is this directory one WE wrote — as opposed to a same-named export? */
function isSavedCarryDir(dir) {
    try {
        return readFileSync(join(dir, ".gitignore"), "utf-8").startsWith(SAVED_CARRY_MARKER);
    }
    catch {
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
function pruneSavedCarries(pluginDir, keepName) {
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
    }
    catch {
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
function saveCarryPayload(opts) {
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
            if (!existsSync(opts.targetPath))
                continue;
            const dest = classifyDestination(opts.targetPath, PROJECT_DIR_NAME, "dir");
            if (!dest.ok)
                continue;
        }
        for (let attempt = 0; attempt < 20; attempt++) {
            const name = attempt === 0 ? `carry-${stamp}` : `carry-${stamp}-${attempt + 1}`;
            const dir = join(root, name);
            if (existsSync(dir))
                continue;
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
                writeFileSync(join(dir, "README.md"), renderSavedReadme({ ...opts, dir, untrackedSaved, refused }), "utf-8");
                pruneSavedCarries(root, name);
                return { dir, refused };
            }
            catch {
                // A collision with a directory created between the check and the
                // mkdir, an unwritable root, or a fault part-way through the copy.
                // Remove whatever landed before trying the next name and then the next
                // root: a half-copied directory looks exactly like a complete one from
                // the outside, and the next root's save would leave it behind as a
                // silent, plausible-looking decoy of the peer's working tree.
                try {
                    rmSync(dir, { recursive: true, force: true });
                }
                catch {
                    /* nothing more this function can do; the next root still gets a try */
                }
                continue;
            }
        }
    }
    return null;
}
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
function shQuote(raw) {
    return `'${raw.split("'").join(`'\\''`)}'`;
}
/** The same, for the PowerShell line: single quotes, doubled to escape. */
function psQuote(raw) {
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
function hasGitAncestor(start) {
    let dir = start;
    for (let depth = 0; depth < 4096; depth++) {
        if (existsSync(join(dir, ".git")))
            return true;
        const parent = dirname(dir);
        if (parent === dir)
            return false;
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
function renderSavedReadme(opts) {
    const { meta } = opts;
    const patch = join(opts.dir, "changes.patch");
    const untracked = join(opts.dir, "untracked");
    const directory = opts.applyPrefix ? ` --directory=${shQuote(opts.applyPrefix)}` : "";
    const lines = [
        "# Carried uncommitted changes (not applied)",
        "",
        `Reason: ${opts.detail}`,
        "",
        `Captured on branch \`${meta.branch}\`${meta.detached ? " (detached HEAD)" : ""} at commit \`${meta.baseCommit}\` on ${meta.capturedAt}.`,
        `It holds a ${formatBytes(meta.patchBytes)} patch and ${opts.untrackedSaved} untracked file(s).`,
        "",
    ];
    if (meta.inProgress) {
        lines.push(`The other machine was in the middle of a \`${meta.inProgress}\` when this was captured, so the patch contains conflict markers as ordinary content and the ${meta.inProgress} itself did not travel.`, "");
    }
    if (opts.refused.length > 0) {
        // Said HERE and not only in the pull's warnings, because this file is what
        // the user reads while running the copy command below — and that command
        // would have planted these paths verbatim.
        lines.push(`**${opts.refused.length} path(s) in this payload were left out of this directory on purpose** — they name plugin or VCS internals that sesh-mover never writes (\`.git\` or \`.sesh-mover\` at some depth, in some casing): ${opts.refused.slice(0, 5).map((p) => `\`${p}\``).join(", ")}. They are not below, so the commands in this file cannot plant them. A current sesh-mover never puts such a path in a bundle, so this one came from an older version, was damaged in transit, or was not produced by sesh-mover at all — nothing needs re-running, but read the rest of it before you use it.`, "");
    }
    if (opts.advice === "unsafe") {
        lines.push("**This payload was refused, not merely deferred.** It names paths that can never be written by sesh-mover (`.git` or `.sesh-mover` at some depth) or it carries symbolic links. Read it before you do anything with it — `.sesh-mover-hubinclude` decides what this machine's next push uploads, and the project-scope `config.json` decides where the hub is. No apply command is given here on purpose.", "");
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
        lines.push("**`git apply` on this machine could not read this patch**, so sesh-mover could not finish checking it and gives no apply command here. Nothing about it was found to be unsafe — the bundle looks damaged or truncated rather than hostile. The patch is beside this file if you want to inspect it; the surer fix is to have the other machine push again.", "");
    }
    else {
        lines.push("To apply it by hand, from the project directory:", "", "```bash", `git -c apply.ignoreWhitespace=no apply --whitespace=nowarn${directory} ${shQuote(patch)}`, "```", "", "Both settings matter: `apply.whitespace=fix` silently strips whitespace the patch adds, and `apply.ignoreWhitespace=change` will apply a patch whose context does not match and rewrite your indentation to it.", "");
        if (!opts.prefixKnown) {
            lines.push("This machine could not be asked where the project sits inside its repository, so the command above has no `--directory`. **If this project directory is inside a git repository but is not its root, add one** — from the project directory, `git rev-parse --show-prefix` prints exactly what it needs (for example `--directory='pkg/app/'`). Without it `git apply` resolves the patch's paths against the repository root, ignores everything outside your current directory, and exits 0 having written nothing.", "");
        }
        else if (opts.applyPrefix) {
            lines.push(`\`--directory\` is not optional here: this project is the subdirectory \`${opts.applyPrefix}\` of its repository, and \`git apply\` resolves patch paths against the repository ROOT. Without it the command exits 0 and writes nothing at all.`, "");
        }
    }
    if (opts.untrackedSaved > 0) {
        lines.push((opts.advice === "unparseable"
            ? "The untracked files travelled as ordinary copies, not in the patch, so nothing above affects them. They are under `untracked/`."
            : "The untracked files are under `untracked/`.") +
            " Copying them OVERWRITES same-named files — sesh-mover's own apply never does that — so check first:", "", "```bash", `# macOS / Linux`, `cp -R ${shQuote(`${untracked}/.`)} .`, "```", "", "```powershell", `# Windows (PowerShell)`, `Copy-Item -Recurse -Force ${psQuote(join(untracked, "*"))} .`, "```", "");
    }
    lines.push("Delete this directory once you are done; nothing else reads it, and sesh-mover keeps only the most recent few.");
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
export async function applyCarry(opts) {
    const { carryDir, targetPath, meta } = opts;
    const stamp = stampNow(opts.__stamp);
    const patchPath = join(carryDir, "changes.patch");
    let patchBytes = 0;
    try {
        patchBytes = statSync(patchPath).size;
    }
    catch {
        patchBytes = 0;
    }
    // Read before anything else so that even a `no-git` machine's saved README
    // knows whether it may recommend applying this patch.
    const scan = patchBytes > 0 ? scanPatchBytes(patchPath) : { paths: [], symlink: null };
    const scanUnsafe = scan === null ||
        scan.symlink !== null ||
        scan.paths.some((p) => isNeverIncludable(p));
    // `applyPrefix` is deliberately mutable and read at CALL time by `decline`:
    // it is what the saved README's apply command needs, and that README is the
    // only remedy every declining path has. A prefix threaded as an argument was
    // simply absent from every decline that returns before it is measured — which
    // included the routine `not-requested` one.
    let applyPrefix = "";
    let prefixKnown = false;
    const decline = (reason, detail, 
    // Defaulted rather than passed at every call site: "did the floor fire?" is
    // the question, and only the one caller that knows better overrides it.
    advice = scanUnsafe || reason === "unsafe-payload" ? "unsafe" : "apply") => {
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
    const declineScan = () => decline("unsafe-payload", scan === null
        ? "the patch could not be read or is too large to inspect"
        : scan.symlink !== null
            ? `the patch creates or changes a symbolic link (${scan.symlink}), which is never applied`
            : `the patch writes paths that never travel (${scan.paths.filter((p) => isNeverIncludable(p)).slice(0, 3).join(", ")})`);
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
        }
        else if (where.code !== "ENOENT" && !hasGitAncestor(targetPath)) {
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
    // git's own parse of the patch — the second floor source, and the only one
    // that is authoritative about how git will actually resolve each entry.
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
    if (patchBytes > 0 && targetExists) {
        const numstat = git(targetPath, applyInvocation(applyPrefix, ["--numstat", "-z"], patchPath), LS_FILES_MAX_BUFFER);
        if (numstat.ok) {
            const unsafe = numstat.stdout
                .toString("utf-8")
                .split("\0")
                .filter((r) => r.length > 0)
                .map((row) => row.split("\t").slice(2).join("\t"))
                .filter((p) => p.length > 0 && isNeverIncludable(p));
            if (unsafe.length > 0) {
                return decline("unsafe-payload", `the patch writes paths that never travel (${unsafe.slice(0, 3).join(", ")})`);
            }
        }
        else if (gitAnswered && numstat.status !== null && !scanUnsafe) {
            // `status !== null` means the process ran to completion and made a
            // judgment. A timeout, an over-budget buffer or a permission fault leave
            // it null — those are this machine failing to ask, not git answering.
            //
            // `!scanUnsafe` because hostile outranks damaged: a patch git cannot
            // parse can still carry a header naming plugin internals, and that user
            // must get the security wording rather than "looks damaged".
            return decline("apply-failed", `the carried patch could not be parsed here (${numstat.stderr || String(numstat.code ?? "")})`, "unparseable");
        }
    }
    // The byte scan's verdict, second only because git's is better worded.
    if (scanUnsafe)
        return declineScan();
    if (opts.saveOnly) {
        return decline("not-requested", "the pull did not ask for carried changes to be applied (--apply-carry)");
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
            : decline("not-git", `the project directory is not inside a git repository with commits (${head.stderr || String(head.code ?? "")})`);
    }
    const headSha = head.stdout.toString("utf-8").trim();
    if (headSha !== meta.baseCommit) {
        return decline("wrong-base", `this machine is at commit ${headSha.slice(0, 8)}, the changes were captured at ${meta.baseCommit.slice(0, 8)} on branch ${meta.branch}`);
    }
    const inProgress = gitDir ? detectInProgress(gitDir) : null;
    if (inProgress) {
        // A tree can be perfectly clean mid-rebase (`git rebase --exec` stopping on
        // a failed command, an `edit`/`break` stop), so the dirty check below
        // cannot see this. Applying there leaves `git rebase --continue` refusing
        // to run against a dirty tree, for reasons the user never asked for.
        return decline("in-progress", `this machine is in the middle of a ${inProgress} — finish or abort it first`);
    }
    // `-- .` scopes the question to the project directory: a monorepo package
    // must not be blocked by unrelated dirt elsewhere in the repository, and the
    // patch cannot reach outside the subtree anyway.
    const status = git(targetPath, ["status", "--porcelain", "-uno", "--", "."], LS_FILES_MAX_BUFFER);
    if (!status.ok) {
        return decline("dirty-tree", `this machine's working tree could not be verified as clean (${status.stderr || String(status.code ?? "")})`);
    }
    if (status.stdout.toString("utf-8").trim().length > 0) {
        return decline("dirty-tree", "this machine has uncommitted changes of its own, which the carried patch would be mixed into irreversibly");
    }
    let filesChanged = 0;
    if (patchBytes > 0) {
        const check = git(targetPath, applyInvocation(applyPrefix, ["--check"], patchPath), 1024 * 1024);
        if (!check.ok) {
            return decline("apply-failed", `the carried patch does not apply here (${check.stderr || String(check.code ?? "")})`);
        }
        const applied = git(targetPath, applyInvocation(applyPrefix, [], patchPath), 1024 * 1024);
        if (!applied.ok) {
            // `--check` just passed, so this is an IO fault rather than a mismatch.
            // `git apply` is all-or-nothing on the mismatch class (measured: a
            // two-file patch whose second file conflicts leaves the first untouched),
            // but a write fault mid-run is not covered by that, so the detail says to
            // look rather than promising nothing happened.
            return decline("apply-failed", `git apply failed after its dry run passed (${applied.stderr || String(applied.code ?? "")}) — check \`git status\` before re-trying`);
        }
        filesChanged = patchFileCount(targetPath, applyPrefix, patchPath);
    }
    const collisions = [];
    const refused = [];
    const blocked = [];
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
                    if (readFileSync(to).equals(readFileSync(src)))
                        continue; // identical: no-op
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
            }
            catch {
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
function patchFileCount(cwd, applyPrefix, patchPath) {
    const numstat = git(cwd, applyInvocation(applyPrefix, ["--numstat", "-z"], patchPath), LS_FILES_MAX_BUFFER);
    if (!numstat.ok)
        return 0;
    return numstat.stdout.toString("utf-8").split("\0").filter((r) => r.length > 0).length;
}
/**
 * `<dest>.incoming-<stamp>`, uniquified.
 *
 * Two applies can share a stamp — the test seam pins it, and two pulls in the
 * same millisecond would too — and silently overwriting the earlier sidecar
 * would lose the very copy this path exists to preserve.
 */
function uniqueSidecarPath(dest, stamp) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = `${dest}.incoming-${stamp}${attempt === 0 ? "" : `-${attempt + 1}`}`;
        if (!existsSync(candidate))
            return candidate;
    }
    return null;
}
//# sourceMappingURL=carry.js.map