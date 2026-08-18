import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { gitChildEnv } from "./carry.js";
/**
 * THE GIT-REMOTE SCAN — the input that decides WHICH file payload a project may
 * send, and therefore the one piece of git knowledge that is not hub-specific.
 *
 * It lives beside the two payload builders rather than in `hub/identity.ts`
 * because both transports need the same answer: `hub push` chooses between the
 * snapshot and the carry with it, and so does `export --include-workspace /
 * --include-carry` (#47). `hub/identity.ts` still owns the OTHER thing remotes
 * are used for — matching a clone to a hub project — and imports
 * `localGitRemotes` from here for it.
 *
 * Read `GitRemoteScan`'s own doc before touching anything below: the three-way
 * answer, and specifically the `unknown` arm, is a security boundary rather than
 * a diagnostic nicety.
 */
// "github.com/user/repo" — host and path lowercased, scheme/credentials/.git
// stripped. Lowercasing the path trades rare case-sensitive hosts for
// reliable ssh↔https matching (documented).
export function normalizeGitRemote(url) {
    let rest = url.trim();
    let host;
    let path;
    const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(rest); // git@host:path
    const uri = /^\w+:\/\/(?:[\w.%-]+(?::[^@/]*)?@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(rest); // scheme://[user[:pass]@]host/path
    if (uri) {
        host = uri[1];
        path = uri[2];
    }
    else if (scp) {
        host = scp[1];
        path = scp[2];
    }
    else
        return null;
    if (!host.includes(".") && host !== "localhost")
        return null;
    path = path.replace(/\.git$/i, "").replace(/\/+$/, "");
    if (!path)
        return null;
    return `${host.toLowerCase()}/${path.toLowerCase()}`;
}
/**
 * Is `<dir>/.git` a repository marker? Returns its path, or null.
 *
 * `existsSync` is NOT this test, and the gap is not theoretical (#50): an EMPTY
 * `.git` directory satisfies existence and git itself would not recognize it —
 * a real `.git` directory always carries `HEAD`. One stray zero-entry
 * `/tmp/.git`, created months earlier by something unrelated, made every
 * mkdtemp fixture on the machine look like it was inside a repository: 38 tests
 * across 4 files red, and in production the workspace payload of every git-less
 * project under it silently declined while the warning talked about git.
 *
 * - a FILE → marker. Worktrees and submodules legitimately use one, and its
 *   `gitdir:` target is not ours to validate.
 * - a DIRECTORY → marker only with `HEAD` in it.
 * - anything else (an empty directory, a stray one with unrelated contents, a
 *   socket) → not a marker; keep walking up.
 *
 * Unreadable is not absent, and the asymmetry is deliberate: a `.git` we cannot
 * stat counts as a marker, because "there is no repository here" is the answer
 * that authorizes an unfiltered whole-tree snapshot, and a permission-refused
 * or root-owned repository is precisely a case where git cannot answer either.
 * `throwIfNoEntry: false` is what keeps that distinct from a genuine ENOENT,
 * which returns undefined rather than throwing.
 */
function gitMarkerAt(dir) {
    const marker = join(dir, ".git");
    let stat;
    try {
        stat = statSync(marker, { throwIfNoEntry: false });
    }
    catch {
        return marker;
    }
    if (!stat)
        return null;
    if (!stat.isDirectory())
        return stat.isFile() ? marker : null;
    try {
        return statSync(join(marker, "HEAD"), { throwIfNoEntry: false }) ? marker : null;
    }
    catch {
        return marker;
    }
}
/**
 * The git repository marker at or above `projectPath`, or null if there is none.
 *
 * A filesystem fact, deliberately — it is the one thing still knowable when
 * `git` itself cannot be run, which is exactly the case that must not be read
 * as "no remotes". Walks up because git's own discovery does: a monorepo
 * package has no `.git` of its own but is inside a repository, and its remotes
 * belong to it. `.git` may be a directory or a file (worktrees, submodules).
 *
 * Returns the path rather than a boolean because the caller reports it: "git
 * could not answer" is only actionable next to the marker that made this path
 * count as a repository, which is routinely a directory well outside the
 * project the user is looking at.
 */
function findGitRepoMarker(projectPath) {
    let dir = resolve(projectPath);
    // Bounded by construction: dirname() reaches a fixed point at the root.
    for (;;) {
        const marker = gitMarkerAt(dir);
        if (marker)
            return marker;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
export function scanGitRemotes(projectPath) {
    let names;
    let out;
    try {
        // TWO calls, and the split matters. `git remote` lists every remote git
        // knows about, one bare name per line — that is the only trustworthy
        // answer to "does this project have a remote", which is the question that
        // decides whether an unfiltered whole-tree snapshot leaves the machine.
        //
        // `git remote -v` is NOT that answer. It prints a line per URL, and a
        // remote can have none: configure `remote.origin.pushurl` without
        // `remote.origin.url` (a push-only mirror or deploy remote) and git emits
        // `origin\t` with no `(fetch)` marker at all. Counting `(fetch)` lines
        // then reads a real git project as remote-less and ships its `.gitignore`d
        // secrets to the hub — measured, with `.env` and `secrets/id_rsa` landing
        // in a bundle. Counting `(push)` too would fix that shape and not the
        // URL-less-remote shape. So: names decide the KIND, `-v` supplies the
        // normalized urls, and neither job is done by the other's output.
        names = execFileSync("git", ["remote"], {
            cwd: projectPath, encoding: "utf-8", timeout: 5000,
            env: gitChildEnv(),
            stdio: ["ignore", "pipe", "ignore"],
        });
        out = execFileSync("git", ["remote", "-v"], {
            cwd: projectPath, encoding: "utf-8", timeout: 5000,
            // Not the inherited environment (see `gitChildEnv`): this answer is what
            // decides whether push takes the git-carry path or the workspace-snapshot
            // path, and an ambient GIT_DIR would have it read a different repository's
            // remotes than the one `captureCarry` then diffs.
            env: gitChildEnv(),
            stdio: ["ignore", "pipe", "ignore"], // suppress git's stderr (e.g. "not a git repository")
        });
    }
    catch (e) {
        // Every failure lands here: a missing binary (ENOENT from the spawn), a
        // timeout (SIGTERM), and every non-zero exit — "not a repository" (128) and
        // "detected dubious ownership" (also 128) among them. git's own exit codes
        // cannot tell those apart with stderr suppressed, and stderr text is
        // localized, so the discriminator is the filesystem: no `.git` anywhere
        // above us means there is no repository to have remotes.
        const marker = findGitRepoMarker(projectPath);
        if (!marker)
            return { kind: "none" };
        const err = e;
        const why = err.code === "ENOENT"
            ? "`git` was not found on PATH"
            : err.signal
                ? `\`git remote\` timed out (${err.signal})`
                : "`git remote` failed in this repository (a dubious-ownership refusal looks like this — try `git status` there)";
        return {
            kind: "unknown",
            reason: err.code === "ENOENT" ? "git-missing" : "git-failed",
            // The marker path is half the message, not decoration. Without it the
            // warning names git as the problem while the actual cause is a `.git`
            // the user never thinks about — frequently in an ancestor OUTSIDE the
            // project, which is unfindable from any wording that omits the path.
            detail: `${why}; the \`.git\` at ${marker} is what puts this path inside a repository`,
        };
    }
    // The KIND comes from the names, never from the url lines.
    const rawCount = names.split("\n").filter((l) => l.trim().length > 0).length;
    if (rawCount === 0)
        return { kind: "none" };
    const urls = new Set();
    for (const line of out.split("\n")) {
        // `git remote -v` prints `<name>\t<url> (fetch)`. Parsed by peeling the
        // ends off rather than with `(\S+)` for the url, because a url may contain
        // SPACES — a local-path remote such as `/Volumes/My Backup/repo.git` is the
        // ordinary case. A line that doesn't match is simply a url we don't get;
        // it can no longer change the kind, which is the whole point of taking
        // that from `git remote` above.
        const trimmed = line.trim();
        if (!trimmed.endsWith("(fetch)"))
            continue;
        const url = trimmed.slice(0, -"(fetch)".length).trim().replace(/^\S+\s+/, "").trim();
        if (!url)
            continue;
        const norm = normalizeGitRemote(url);
        if (norm)
            urls.add(norm);
    }
    return { kind: "remotes", normalized: [...urls], rawCount };
}
/**
 * The project's remotes in matcher form, for hub-project identity only.
 *
 * Deliberately still collapses "no remotes", "remotes I could not normalize"
 * and "could not ask git" into `[]`: an empty matcher list means "do not link
 * by remote", which is the right answer in all three. Anything deciding what
 * LEAVES the machine must use `scanGitRemotes` instead — see its doc.
 */
export function localGitRemotes(projectPath) {
    const scan = scanGitRemotes(projectPath);
    return scan.kind === "remotes" ? scan.normalized : [];
}
//# sourceMappingURL=git-scan.js.map