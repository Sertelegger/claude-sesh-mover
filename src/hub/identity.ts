import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HubBackend } from "./backend.js";
import { projectJsonPath, assertSafeHubId, type HubProjectJson } from "./layout.js";

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
  const uri = /^\w+:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(rest); // scheme://host/path
  if (uri) { host = uri[1]; path = uri[2]; }
  else if (scp) { host = scp[1]; path = scp[2]; }
  else return null;
  if (!host.includes(".") && host !== "localhost") return null;
  path = path.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!path) return null;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

export function localGitRemotes(projectPath: string): string[] {
  try {
    const out = execFileSync("git", ["remote", "-v"], {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"], // suppress git's stderr (e.g. "not a git repository")
    });
    const urls = new Set<string>();
    for (const line of out.split("\n")) {
      const m = /^\S+\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      if (m) {
        const norm = normalizeGitRemote(m[1]);
        if (norm) urls.add(norm);
      }
    }
    return [...urls];
  } catch {
    return []; // non-git dir, git missing, or timeout — all mean "no remotes"
  }
}

export async function listHubProjects(backend: HubBackend): Promise<HubProjectJson[]> {
  const files = await backend.list("projects");
  const projects: HubProjectJson[] = [];
  for (const f of files) {
    if (!/^projects\/[^/]+\/project\.json$/.test(f)) continue;
    try {
      const parsed = JSON.parse((await backend.read(f)).toString()) as HubProjectJson;
      assertSafeHubId(parsed.projectId, "projectId");
      projects.push(parsed);
    } catch {
      // unparseable/unsafe project.json (possibly mid-sync) — skip, never throw
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
