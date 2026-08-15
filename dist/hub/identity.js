import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { projectJsonPath, assertSafeHubId } from "./layout.js";
import { gitChildEnv } from "./carry.js";
import { projectJsonFilePath } from "../paths.js";
export function localProjectIdPath(projectPath) {
    return projectJsonFilePath(projectPath);
}
export function readLocalProjectId(projectPath) {
    const p = localProjectIdPath(projectPath);
    if (!existsSync(p))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(p, "utf-8"));
        if (!parsed.projectId)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
export function writeLocalProjectId(projectPath, id) {
    const p = localProjectIdPath(projectPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(id, null, 2) + "\n", "utf-8");
}
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
 * Is there a git repository at or above `projectPath`?
 *
 * A filesystem fact, deliberately — it is the one thing still knowable when
 * `git` itself cannot be run, which is exactly the case that must not be read
 * as "no remotes". Walks up because git's own discovery does: a monorepo
 * package has no `.git` of its own but is inside a repository, and its remotes
 * belong to it. `.git` may be a directory or a file (worktrees, submodules).
 */
function hasGitRepoMarker(projectPath) {
    let dir = resolve(projectPath);
    // Bounded by construction: dirname() reaches a fixed point at the root.
    for (;;) {
        if (existsSync(join(dir, ".git")))
            return true;
        const parent = dirname(dir);
        if (parent === dir)
            return false;
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
        if (!hasGitRepoMarker(projectPath))
            return { kind: "none" };
        const err = e;
        return {
            kind: "unknown",
            reason: err.code === "ENOENT" ? "git-missing" : "git-failed",
            detail: err.code === "ENOENT"
                ? "`git` was not found on PATH"
                : err.signal
                    ? `\`git remote\` timed out (${err.signal})`
                    : "`git remote` failed in this repository (a dubious-ownership refusal looks like this — try `git status` there)",
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
export async function listHubProjects(backend) {
    const files = await backend.list("projects");
    const projects = [];
    for (const f of files) {
        if (!/^projects\/[^/]+\/project\.json$/.test(f))
            continue;
        try {
            const parsed = JSON.parse((await backend.read(f)).toString());
            assertSafeHubId(parsed.projectId, "projectId");
            // Shape check: a valid-JSON record with missing/malformed matchers would
            // otherwise crash consumers (resolveProjectIdentity's candidate map) —
            // one bad hub file must not break identity resolution for everyone.
            if (!Array.isArray(parsed.matchers?.gitRemotes))
                throw new Error("malformed matchers");
            projects.push(parsed);
        }
        catch {
            // unparseable/unsafe/malformed project.json (possibly mid-sync) — skip, never throw
        }
    }
    return projects;
}
export async function resolveProjectIdentity(backend, projectPath) {
    const local = readLocalProjectId(projectPath);
    if (local)
        return { kind: "linked", local };
    const remotes = localGitRemotes(projectPath);
    const hubProjects = await listHubProjects(backend);
    if (remotes.length > 0) {
        for (const hp of hubProjects) {
            const hit = hp.matchers.gitRemotes.find((r) => remotes.includes(r));
            if (hit)
                return { kind: "match", hubProject: hp, matchedRemote: hit };
        }
    }
    return {
        kind: "unlinked",
        candidates: hubProjects.map((p) => ({
            projectId: p.projectId, name: p.name, gitRemotes: p.matchers.gitRemotes,
        })),
    };
}
/**
 * The HUB-side half of `createHubProject`: mint an id and write
 * `projects/<id>/project.json`. Writes NOTHING under the project directory.
 *
 * Split out because the two halves have different failure semantics and a
 * caller may need them at different moments. The hub write cannot be undone —
 * there is no `backend.delete` call anywhere in src/ — while the local link
 * can, so `hub/push.ts` records "a hub project was minted" the instant this
 * resolves and defers the local link until the bundle is on the hub. Fusing
 * them, as this function's caller below does, means a throw BETWEEN the two
 * writes leaves an orphan hub project no result mentions.
 */
export async function mintHubProject(backend, projectPath, machineId) {
    const local = {
        projectId: randomUUID(),
        name: basename(projectPath),
        createdAt: new Date().toISOString(),
        createdByMachine: machineId,
    };
    const hub = {
        schemaVersion: 1,
        projectId: local.projectId,
        name: local.name,
        matchers: { gitRemotes: localGitRemotes(projectPath) },
        createdAt: local.createdAt,
        createdByMachine: machineId,
    };
    await backend.writeAtomic(projectJsonPath(local.projectId), JSON.stringify(hub, null, 2) + "\n");
    return local;
}
export async function createHubProject(backend, projectPath, machineId) {
    const local = await mintHubProject(backend, projectPath, machineId);
    writeLocalProjectId(projectPath, local);
    return local;
}
/**
 * Read a hub project as the `LocalProjectId` a link to it would carry, WITHOUT
 * writing that link.
 *
 * The read is not a formality: it is the existence gate that keeps a typo'd
 * `--project-id` from linking a directory to a hub project that does not
 * exist, and `assertSafeHubId` is the path-safety chokepoint. Callers that
 * want the gate at one moment and the link at another (see `hub/push.ts`) take
 * this and `writeLocalProjectId` separately; everyone else takes
 * `linkToHubProject`, which is exactly the two in sequence.
 */
export async function readHubProjectAsLocal(backend, projectId) {
    assertSafeHubId(projectId, "projectId");
    const hub = JSON.parse((await backend.read(projectJsonPath(projectId))).toString());
    return {
        projectId: hub.projectId,
        name: hub.name,
        createdAt: hub.createdAt,
        createdByMachine: hub.createdByMachine,
    };
}
export async function linkToHubProject(backend, projectPath, projectId) {
    const local = await readHubProjectAsLocal(backend, projectId);
    writeLocalProjectId(projectPath, local);
    return local;
}
//# sourceMappingURL=identity.js.map