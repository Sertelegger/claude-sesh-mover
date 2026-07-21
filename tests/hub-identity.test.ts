import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createFsBackend } from "../src/hub/backend.js";
import {
  normalizeGitRemote, localGitRemotes, resolveProjectIdentity,
  createHubProject, linkToHubProject, readLocalProjectId, listHubProjects,
} from "../src/hub/identity.js";
import { projectJsonPath } from "../src/hub/layout.js";

function tmp(p: string): string { return mkdtempSync(join(tmpdir(), p)); }

describe("normalizeGitRemote", () => {
  it("unifies ssh and https forms", () => {
    expect(normalizeGitRemote("git@github.com:User/Repo.git")).toBe("github.com/user/repo");
    expect(normalizeGitRemote("https://GitHub.com/User/Repo.git")).toBe("github.com/user/repo");
    expect(normalizeGitRemote("ssh://git@github.com/User/Repo")).toBe("github.com/user/repo");
    expect(normalizeGitRemote("https://github.com/User/Repo/")).toBe("github.com/user/repo");
  });
  it("returns null on garbage", () => {
    expect(normalizeGitRemote("not a url")).toBeNull();
  });
  it("strips user:pass credentials from https forms", () => {
    expect(normalizeGitRemote("https://user:pass@Host.com/x/y.git")).toBe("host.com/x/y");
  });
});

describe("localGitRemotes", () => {
  it("returns [] for a non-git directory", () => {
    const dir = tmp("sesh-id-nogit-");
    try { expect(localGitRemotes(dir)).toEqual([]); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("returns normalized remotes for a git repo", () => {
    const dir = tmp("sesh-id-git-");
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:User/Repo.git"], { cwd: dir });
      expect(localGitRemotes(dir)).toEqual(["github.com/user/repo"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("identity resolution", () => {
  it("linked: local project.json wins without touching the hub", async () => {
    const dir = tmp("sesh-id-p-");
    const hub = tmp("sesh-id-hub-");
    try {
      const backend = createFsBackend(hub);
      mkdirSync(join(dir, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(
        join(dir, ".claude-sesh-mover", "project.json"),
        JSON.stringify({ projectId: "p-1", name: "x", createdAt: "t", createdByMachine: "m" })
      );
      const r = await resolveProjectIdentity(backend, dir);
      expect(r.kind).toBe("linked");
    } finally { for (const d of [dir, hub]) rmSync(d, { recursive: true, force: true }); }
  });

  it("match: git remote matches an existing hub project", async () => {
    const dir = tmp("sesh-id-p-");
    const hub = tmp("sesh-id-hub-");
    try {
      const backend = createFsBackend(hub);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/User/Repo.git"], { cwd: dir });
      await backend.writeAtomic(projectJsonPath("p-hub"), JSON.stringify({
        schemaVersion: 1, projectId: "p-hub", name: "repo",
        matchers: { gitRemotes: ["github.com/user/repo"] },
        createdAt: "t", createdByMachine: "m-other",
      }));
      const r = await resolveProjectIdentity(backend, dir);
      expect(r.kind).toBe("match");
      if (r.kind === "match") expect(r.hubProject.projectId).toBe("p-hub");
    } finally { for (const d of [dir, hub]) rmSync(d, { recursive: true, force: true }); }
  });

  it("skips project.json with malformed or missing matchers; good candidates survive", async () => {
    const dir = tmp("sesh-id-p-");
    const hub = tmp("sesh-id-hub-");
    try {
      const backend = createFsBackend(hub);
      // Valid JSON, safe id, but matchers is an empty object (no gitRemotes array)
      await backend.writeAtomic(projectJsonPath("p-bad-empty"), JSON.stringify({
        schemaVersion: 1, projectId: "p-bad-empty", name: "bad-empty", matchers: {},
        createdAt: "t", createdByMachine: "m",
      }));
      // Valid JSON, safe id, but no matchers key at all
      await backend.writeAtomic(projectJsonPath("p-bad-missing"), JSON.stringify({
        schemaVersion: 1, projectId: "p-bad-missing", name: "bad-missing",
        createdAt: "t", createdByMachine: "m",
      }));
      // A well-formed one that must survive
      await backend.writeAtomic(projectJsonPath("p-good"), JSON.stringify({
        schemaVersion: 1, projectId: "p-good", name: "good", matchers: { gitRemotes: [] },
        createdAt: "t", createdByMachine: "m",
      }));

      const projects = await listHubProjects(backend);
      expect(projects.map((p) => p.projectId)).toEqual(["p-good"]);

      const r = await resolveProjectIdentity(backend, dir);
      expect(r.kind).toBe("unlinked");
      if (r.kind === "unlinked") {
        expect(r.candidates.map((c) => c.projectId)).toEqual(["p-good"]);
      }
    } finally { for (const d of [dir, hub]) rmSync(d, { recursive: true, force: true }); }
  });

  it("unlinked: returns all hub projects as candidates", async () => {
    const dir = tmp("sesh-id-p-");
    const hub = tmp("sesh-id-hub-");
    try {
      const backend = createFsBackend(hub);
      await backend.writeAtomic(projectJsonPath("p-a"), JSON.stringify({
        schemaVersion: 1, projectId: "p-a", name: "a", matchers: { gitRemotes: [] },
        createdAt: "t", createdByMachine: "m",
      }));
      const r = await resolveProjectIdentity(backend, dir);
      expect(r.kind).toBe("unlinked");
      if (r.kind === "unlinked") expect(r.candidates.map((c) => c.projectId)).toEqual(["p-a"]);
    } finally { for (const d of [dir, hub]) rmSync(d, { recursive: true, force: true }); }
  });

  it("create mints local + hub records; link plants local from hub", async () => {
    const dirA = tmp("sesh-id-pA-");
    const dirB = tmp("sesh-id-pB-");
    const hub = tmp("sesh-id-hub-");
    try {
      const backend = createFsBackend(hub);
      const minted = await createHubProject(backend, dirA, "machine-1");
      expect(readLocalProjectId(dirA)?.projectId).toBe(minted.projectId);
      expect(await backend.exists(projectJsonPath(minted.projectId))).toBe(true);

      const linked = await linkToHubProject(backend, dirB, minted.projectId);
      expect(linked.projectId).toBe(minted.projectId);
      expect(readLocalProjectId(dirB)?.projectId).toBe(minted.projectId);
    } finally { for (const d of [dirA, dirB, hub]) rmSync(d, { recursive: true, force: true }); }
  });
});
