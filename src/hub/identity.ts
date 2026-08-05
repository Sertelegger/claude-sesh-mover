import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HubBackend } from "./backend.js";
import { projectJsonPath, assertSafeHubId, type HubProjectJson } from "./layout.js";
import { gitChildEnv } from "./carry.js";

export interface LocalProjectId {
  projectId: string;
  name: string;
  createdAt: string;
  createdByMachine: string;
}

export function localProjectIdPath(projectPath: string): string {
  return join(projectPath, ".claude-sesh-mover", "project.json");
}

export function readLocalProjectId(projectPath: string): LocalProjectId | null {
  const p = localProjectIdPath(projectPath);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as LocalProjectId;
    if (!parsed.projectId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLocalProjectId(projectPath: string, id: LocalProjectId): void {
  const p = localProjectIdPath(projectPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(id, null, 2) + "\n", "utf-8");
}

// "github.com/user/repo" — host and path lowercased, scheme/credentials/.git
// stripped. Lowercasing the path trades rare case-sensitive hosts for
// reliable ssh↔https matching (documented).
export function normalizeGitRemote(url: string): string | null {
  let rest = url.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(rest); // git@host:path
  const uri = /^\w+:\/\/(?:[\w.%-]+(?::[^@/]*)?@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(rest); // scheme://[user[:pass]@]host/path
  if (uri) { host = uri[1]; path = uri[2]; }
  else if (scp) { host = scp[1]; path = scp[2]; }
  else return null;
  if (!host.includes(".") && host !== "localhost") return null;
  path = path.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!path) return null;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

/**
 * What `git remote -v` established about this project, keeping the three
 * answers that used to collapse into one empty array APART.
 *
 * The distinction is load-bearing, not cosmetic. `push` gates the WORKSPACE
 * SNAPSHOT — a copy of the whole project directory that deliberately does not
 * read `.gitignore` — on "this project has no remotes", and the SessionEnd hook
 * runs that push unattended. Reading "I could not ask git" as "there is no
 * remote" therefore uploads a git project's entire working tree, `.env` and
 * `secrets/` included, with nothing said. Only `kind: "none"` may take that
 * path.
 *
 * - `remotes` — git answered and this project HAS at least one remote.
 *   `normalized` holds the ones `normalizeGitRemote` could canonicalize, which
 *   may be FEWER than `rawCount` (a self-hosted `git@gitserver:team/repo.git`
 *   normalizes to null because the host carries no dot) or even empty. Only
 *   `normalized` is used for hub-project matching; `rawCount > 0` is what
 *   decides the payload.
 * - `none` — git answered with no remotes at all, or there is demonstrably no
 *   repository here (no `.git` at this path or any ancestor). Both are
 *   genuinely "no remote to reconstruct this project from".
 * - `unknown` — a repository exists but git could not be asked (missing
 *   binary, timeout, unreadable/dubious-ownership repo). Not an answer.
 */
export type GitRemoteScan =
  | { kind: "remotes"; normalized: string[]; rawCount: number }
  | { kind: "none" }
  | { kind: "unknown"; reason: "git-missing" | "git-failed"; detail: string };

/**
 * Is there a git repository at or above `projectPath`?
 *
 * A filesystem fact, deliberately — it is the one thing still knowable when
 * `git` itself cannot be run, which is exactly the case that must not be read
 * as "no remotes". Walks up because git's own discovery does: a monorepo
 * package has no `.git` of its own but is inside a repository, and its remotes
 * belong to it. `.git` may be a directory or a file (worktrees, submodules).
 */
function hasGitRepoMarker(projectPath: string): boolean {
  let dir = resolve(projectPath);
  // Bounded by construction: dirname() reaches a fixed point at the root.
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function scanGitRemotes(projectPath: string): GitRemoteScan {
  let out: string;
  try {
    out = execFileSync("git", ["remote", "-v"], {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
      // Not the inherited environment (see `gitChildEnv`): this answer is what
      // decides whether push takes the git-carry path or the workspace-snapshot
      // path, and an ambient GIT_DIR would have it read a different repository's
      // remotes than the one `captureCarry` then diffs.
      env: gitChildEnv(),
      stdio: ["ignore", "pipe", "ignore"], // suppress git's stderr (e.g. "not a git repository")
    });
  } catch (e) {
    // Every failure lands here: a missing binary (ENOENT from the spawn), a
    // timeout (SIGTERM), and every non-zero exit — "not a repository" (128) and
    // "detected dubious ownership" (also 128) among them. git's own exit codes
    // cannot tell those apart with stderr suppressed, and stderr text is
    // localized, so the discriminator is the filesystem: no `.git` anywhere
    // above us means there is no repository to have remotes.
    if (!hasGitRepoMarker(projectPath)) return { kind: "none" };
    const err = e as { code?: string; signal?: string };
    return {
      kind: "unknown",
      reason: err.code === "ENOENT" ? "git-missing" : "git-failed",
      detail:
        err.code === "ENOENT"
          ? "`git` was not found on PATH"
          : err.signal
            ? `\`git remote -v\` timed out (${err.signal})`
            : "`git remote -v` failed in this repository",
    };
  }
  let rawCount = 0;
  const urls = new Set<string>();
  for (const line of out.split("\n")) {
    // `git remote -v` prints `<name>\t<url> (fetch)`. Parsed by peeling the
    // ends off rather than with `(\S+)` for the url, because a url may contain
    // SPACES — a local-path remote such as `/Volumes/My Backup/repo.git` is the
    // ordinary case. An unmatched line used to leave rawCount at 0, which is
    // the same defect this function exists to fix: a project with a remote
    // reading as one without, and taking the whole-tree snapshot path.
    const trimmed = line.trim();
    if (!trimmed.endsWith("(fetch)")) continue;
    const url = trimmed.slice(0, -"(fetch)".length).trim().replace(/^\S+\s+/, "").trim();
    if (!url) continue;
    rawCount++;
    const norm = normalizeGitRemote(url);
    if (norm) urls.add(norm);
  }
  return rawCount === 0 ? { kind: "none" } : { kind: "remotes", normalized: [...urls], rawCount };
}

/**
 * The project's remotes in matcher form, for hub-project identity only.
 *
 * Deliberately still collapses "no remotes", "remotes I could not normalize"
 * and "could not ask git" into `[]`: an empty matcher list means "do not link
 * by remote", which is the right answer in all three. Anything deciding what
 * LEAVES the machine must use `scanGitRemotes` instead — see its doc.
 */
export function localGitRemotes(projectPath: string): string[] {
  const scan = scanGitRemotes(projectPath);
  return scan.kind === "remotes" ? scan.normalized : [];
}

export async function listHubProjects(backend: HubBackend): Promise<HubProjectJson[]> {
  const files = await backend.list("projects");
  const projects: HubProjectJson[] = [];
  for (const f of files) {
    if (!/^projects\/[^/]+\/project\.json$/.test(f)) continue;
    try {
      const parsed = JSON.parse((await backend.read(f)).toString()) as HubProjectJson;
      assertSafeHubId(parsed.projectId, "projectId");
      // Shape check: a valid-JSON record with missing/malformed matchers would
      // otherwise crash consumers (resolveProjectIdentity's candidate map) —
      // one bad hub file must not break identity resolution for everyone.
      if (!Array.isArray(parsed.matchers?.gitRemotes)) throw new Error("malformed matchers");
      projects.push(parsed);
    } catch {
      // unparseable/unsafe/malformed project.json (possibly mid-sync) — skip, never throw
    }
  }
  return projects;
}

export type IdentityResolution =
  | { kind: "linked"; local: LocalProjectId }
  | { kind: "match"; hubProject: HubProjectJson; matchedRemote: string }
  | { kind: "unlinked"; candidates: Array<{ projectId: string; name: string; gitRemotes: string[] }> };

export async function resolveProjectIdentity(
  backend: HubBackend,
  projectPath: string
): Promise<IdentityResolution> {
  const local = readLocalProjectId(projectPath);
  if (local) return { kind: "linked", local };

  const remotes = localGitRemotes(projectPath);
  const hubProjects = await listHubProjects(backend);
  if (remotes.length > 0) {
    for (const hp of hubProjects) {
      const hit = hp.matchers.gitRemotes.find((r) => remotes.includes(r));
      if (hit) return { kind: "match", hubProject: hp, matchedRemote: hit };
    }
  }
  return {
    kind: "unlinked",
    candidates: hubProjects.map((p) => ({
      projectId: p.projectId, name: p.name, gitRemotes: p.matchers.gitRemotes,
    })),
  };
}

export async function createHubProject(
  backend: HubBackend,
  projectPath: string,
  machineId: string
): Promise<LocalProjectId> {
  const local: LocalProjectId = {
    projectId: randomUUID(),
    name: basename(projectPath),
    createdAt: new Date().toISOString(),
    createdByMachine: machineId,
  };
  const hub: HubProjectJson = {
    schemaVersion: 1,
    projectId: local.projectId,
    name: local.name,
    matchers: { gitRemotes: localGitRemotes(projectPath) },
    createdAt: local.createdAt,
    createdByMachine: machineId,
  };
  await backend.writeAtomic(projectJsonPath(local.projectId), JSON.stringify(hub, null, 2) + "\n");
  writeLocalProjectId(projectPath, local);
  return local;
}

export async function linkToHubProject(
  backend: HubBackend,
  projectPath: string,
  projectId: string
): Promise<LocalProjectId> {
  assertSafeHubId(projectId, "projectId");
  const hub = JSON.parse(
    (await backend.read(projectJsonPath(projectId))).toString()
  ) as HubProjectJson;
  const local: LocalProjectId = {
    projectId: hub.projectId,
    name: hub.name,
    createdAt: hub.createdAt,
    createdByMachine: hub.createdByMachine,
  };
  writeLocalProjectId(projectPath, local);
  return local;
}
