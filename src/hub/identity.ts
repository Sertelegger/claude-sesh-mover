import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HubBackend } from "./backend.js";
import { projectJsonPath, assertSafeHubId, type HubProjectJson } from "./layout.js";
import { gitChildEnv } from "./carry.js";
import { projectJsonFilePath } from "../paths.js";

export interface LocalProjectId {
  projectId: string;
  name: string;
  createdAt: string;
  createdByMachine: string;
}

export function localProjectIdPath(projectPath: string): string {
  return projectJsonFilePath(projectPath);
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

/**
 * Remove this directory's hub link, but ONLY while it still names `projectId`.
 *
 * The re-read is the whole point: a link the user (or a concurrent operation)
 * changed underneath us is not ours to remove, so the check and the unlink are
 * as close together as they can be made. Two callers, one rule — `hub/push.ts`
 * rolling back a link its own failed push wrote, and `hub/delete`'s cleanup
 * after the hub project it pointed at has been destroyed. A second hand-written
 * copy of this is how one of them ends up unlinking a directory it did not link.
 *
 * It removes the FILE and nothing else — never an `rmdir` of the parent, which
 * since 0.8.0 is the user's project root (see `rollbackLocalLink`).
 *
 * `removed: true` with an empty `detail` also covers "there was no link", which
 * is the requested state either way.
 */
export function removeLocalProjectIdIfMatches(
  projectPath: string,
  projectId: string
): { removed: boolean; detail: string } {
  try {
    const still = readLocalProjectId(projectPath);
    if (!still) return { removed: true, detail: "" };
    if (still.projectId !== projectId) {
      return { removed: false, detail: "it now names a different hub project" };
    }
    rmSync(localProjectIdPath(projectPath), { force: true });
    return { removed: true, detail: "" };
  } catch (e) {
    return { removed: false, detail: (e as Error).message };
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
function gitMarkerAt(dir: string): string | null {
  const marker = join(dir, ".git");
  let stat;
  try {
    stat = statSync(marker, { throwIfNoEntry: false });
  } catch {
    return marker;
  }
  if (!stat) return null;
  if (!stat.isDirectory()) return stat.isFile() ? marker : null;
  try {
    return statSync(join(marker, "HEAD"), { throwIfNoEntry: false }) ? marker : null;
  } catch {
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
function findGitRepoMarker(projectPath: string): string | null {
  let dir = resolve(projectPath);
  // Bounded by construction: dirname() reaches a fixed point at the root.
  for (;;) {
    const marker = gitMarkerAt(dir);
    if (marker) return marker;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function scanGitRemotes(projectPath: string): GitRemoteScan {
  let names: string;
  let out: string;
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
  } catch (e) {
    // Every failure lands here: a missing binary (ENOENT from the spawn), a
    // timeout (SIGTERM), and every non-zero exit — "not a repository" (128) and
    // "detected dubious ownership" (also 128) among them. git's own exit codes
    // cannot tell those apart with stderr suppressed, and stderr text is
    // localized, so the discriminator is the filesystem: no `.git` anywhere
    // above us means there is no repository to have remotes.
    const marker = findGitRepoMarker(projectPath);
    if (!marker) return { kind: "none" };
    const err = e as { code?: string; signal?: string };
    const why =
      err.code === "ENOENT"
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
  if (rawCount === 0) return { kind: "none" };

  const urls = new Set<string>();
  for (const line of out.split("\n")) {
    // `git remote -v` prints `<name>\t<url> (fetch)`. Parsed by peeling the
    // ends off rather than with `(\S+)` for the url, because a url may contain
    // SPACES — a local-path remote such as `/Volumes/My Backup/repo.git` is the
    // ordinary case. A line that doesn't match is simply a url we don't get;
    // it can no longer change the kind, which is the whole point of taking
    // that from `git remote` above.
    const trimmed = line.trim();
    if (!trimmed.endsWith("(fetch)")) continue;
    const url = trimmed.slice(0, -"(fetch)".length).trim().replace(/^\S+\s+/, "").trim();
    if (!url) continue;
    const norm = normalizeGitRemote(url);
    if (norm) urls.add(norm);
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
export async function mintHubProject(
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
  return local;
}

export async function createHubProject(
  backend: HubBackend,
  projectPath: string,
  machineId: string
): Promise<LocalProjectId> {
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
export async function readHubProjectAsLocal(
  backend: HubBackend,
  projectId: string
): Promise<LocalProjectId> {
  assertSafeHubId(projectId, "projectId");
  const hub = JSON.parse(
    (await backend.read(projectJsonPath(projectId))).toString()
  ) as HubProjectJson;
  return {
    projectId: hub.projectId,
    name: hub.name,
    createdAt: hub.createdAt,
    createdByMachine: hub.createdByMachine,
  };
}

export async function linkToHubProject(
  backend: HubBackend,
  projectPath: string,
  projectId: string
): Promise<LocalProjectId> {
  const local = await readHubProjectAsLocal(backend, projectId);
  writeLocalProjectId(projectPath, local);
  return local;
}
