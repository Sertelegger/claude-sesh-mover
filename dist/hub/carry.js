import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { formatBytes, isCarriedPath, isReIncluded, readCarryRules, } from "./workspace.js";
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
 *
 * Task 7 met this class with `git merge-file` and could fix it by running from
 * a directory inside no repository. That escape does not exist here — the
 * command's whole job is to read THIS repository — so the flags are the fix.
 */
const PATCH_HARDENING = [
    "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/",
];
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
/** `a/b.txt 4.1 MB, c.bin 1.0 MB` — the biggest contributors to an over-budget payload. */
function describeLargest(files, patchBytes) {
    const rows = files
        .map((f) => ({ label: f.rel, size: f.size }))
        .concat(patchBytes > 0 ? [{ label: "the uncommitted diff", size: patchBytes }] : [])
        .sort((a, b) => b.size - a.size)
        .slice(0, MAX_REPORTED_LARGEST);
    return rows.map((r) => `${r.label} ${formatBytes(r.size)}`).join(", ");
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
            ? { captured: false, reason: "no-commits", detail: head.stderr }
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
    const diff = git(projectPath, ["diff", "HEAD", "--binary", "--relative", ...PATCH_HARDENING], 
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
        return {
            captured: false,
            reason: "too-large",
            // Reports the REAL size, then explains the per-file term — otherwise a
            // payload of empty files reads as "0 bytes exceeds 5 MB".
            detail: `${formatBytes(patch.length + untrackedBytes)} of uncommitted work across ${files.length} file(s) exceeds the ${formatBytes(maxBytes)} carry budget (each file also counts ${CARRY_PER_FILE_BYTES} bytes toward it; largest: ${describeLargest(files, patch.length)})`,
        };
    }
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
//# sourceMappingURL=carry.js.map