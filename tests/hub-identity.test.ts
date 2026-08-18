import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createFsBackend } from "../src/hub/backend.js";
import {
  resolveProjectIdentity,
  createHubProject, linkToHubProject, readLocalProjectId, listHubProjects,
} from "../src/hub/identity.js";
import {
  normalizeGitRemote, localGitRemotes, scanGitRemotes,
} from "../src/payload/git-scan.js";
import { projectJsonPath } from "../src/hub/layout.js";
import { overridePath } from "./helpers/env.js";

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

// The whole-branch review's Critical 2: `localGitRemotes` returned [] for three
// materially different situations, and `push` read all three as "this project
// has no remote" — the condition that makes it upload the entire working tree,
// .gitignore not consulted, unattended, from the SessionEnd hook.
describe("scanGitRemotes", () => {
  it('a plain directory is "none" — the case the workspace snapshot is FOR', () => {
    const dir = tmp("sesh-scan-nogit-");
    try { expect(scanGitRemotes(dir)).toEqual({ kind: "none" }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a git repo with no remotes is "none" too', () => {
    const dir = tmp("sesh-scan-noremote-");
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      expect(scanGitRemotes(dir)).toEqual({ kind: "none" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a remote normalizeGitRemote cannot canonicalize still counts as a remote", () => {
    // `git@gitserver:team/repo.git` — an ordinary self-hosted server whose host
    // carries no dot, so normalizeGitRemote returns null. Before this split the
    // project reclassified as remote-less and its whole tree was snapshotted.
    const dir = tmp("sesh-scan-selfhosted-");
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "git@gitserver:team/repo.git"], { cwd: dir });
      expect(normalizeGitRemote("git@gitserver:team/repo.git")).toBeNull();
      expect(scanGitRemotes(dir)).toEqual({ kind: "remotes", normalized: [], rawCount: 1 });
      // Linking behaviour is deliberately unchanged: no matcher to link by.
      expect(localGitRemotes(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports normalized remotes alongside the raw count", () => {
    const dir = tmp("sesh-scan-mixed-");
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:User/Repo.git"], { cwd: dir });
      execFileSync("git", ["remote", "add", "internal", "git@gitserver:team/repo.git"], { cwd: dir });
      const scan = scanGitRemotes(dir);
      expect(scan.kind).toBe("remotes");
      if (scan.kind !== "remotes") return;
      expect(scan.rawCount).toBe(2);
      expect(scan.normalized).toEqual(["github.com/user/repo"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("counts a remote that has NO fetch url — the shape that shipped secrets", () => {
    // `git remote -v` prints one line per URL, and a remote can have none:
    // set `remote.origin.pushurl` with no `remote.origin.url` (a push-only
    // mirror or deploy remote) and git emits `origin\t` — no url, and no
    // `(fetch)` marker to count. Deriving the kind from those lines read a
    // real git project as remote-less, which took the whole-tree snapshot
    // path; measured, `.env` and `secrets/id_rsa` landed in a hub bundle with
    // an empty warnings array. `git remote` lists the NAME either way, which
    // is why the kind comes from there and only the urls come from `-v`.
    const dir = tmp("sesh-scan-nofetch-");
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/private.git"], { cwd: dir });
      execFileSync("git", ["config", "--unset", "remote.origin.url"], { cwd: dir });
      execFileSync("git", ["config", "remote.origin.pushurl", "git@github.com:acme/private.git"], { cwd: dir });
      const scan = scanGitRemotes(dir);
      // The kind is what matters: `remotes` keeps the unfiltered snapshot away
      // from this project. There is no fetch url to normalize, so that list is
      // legitimately empty — and an empty `normalized` must never read as
      // "no remotes" again.
      expect(scan.kind).toBe("remotes");
      if (scan.kind !== "remotes") return;
      expect(scan.rawCount).toBe(1);
      expect(scan.normalized).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a remote whose URL contains spaces", () => {
    // `git remote -v` puts the url between a tab and " (fetch)", and a
    // local-path remote may well have a space in it. A url pattern of `\S+`
    // matched nothing here and the project read as remote-less — the same
    // reclassification, by a different route.
    const dir = tmp("sesh-scan-spacey-");
    const remote = join(tmp("sesh-scan-My Backup-"), "repo.git");
    try {
      execFileSync("git", ["init", "-q", "--bare", remote]);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
      const scan = scanGitRemotes(dir);
      expect(scan.kind).toBe("remotes");
      if (scan.kind !== "remotes") return;
      expect(scan.rawCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('git that cannot be run inside a repository is "unknown", not "none"', () => {
    // The dangerous one: the SessionEnd hook runs detached with whatever PATH
    // it inherits, and a missing `git` used to read as "no remotes".
    const dir = tmp("sesh-scan-nogitbin-");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const path = overridePath(tmp("sesh-scan-emptybin-"));
    try {
      const scan = scanGitRemotes(dir);
      expect(scan.kind).toBe("unknown");
      if (scan.kind !== "unknown") return;
      expect(scan.reason).toBe("git-missing");
    } finally {
      path.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('...while a NON-repository with no git is still "none"', () => {
    const dir = tmp("sesh-scan-nogitbin-nodir-");
    const path = overridePath(tmp("sesh-scan-emptybin2-"));
    try {
      expect(scanGitRemotes(dir)).toEqual({ kind: "none" });
    } finally {
      path.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #50. The ancestor walk is right; `existsSync(<dir>/.git)` is not the test
  // for "there is a repository here". An EMPTY `.git` directory satisfies it and
  // git itself would not — a real `.git` always carries HEAD. Measured: one
  // stray, months-old, zero-entry `/tmp/.git` turned 38 tests across 4 files red
  // (every fixture is built under mkdtempSync, i.e. under it), and in production
  // it silently declined the workspace payload of every git-less project on the
  // machine while the warning pointed at git rather than at the directory.
  describe("what counts as a .git marker", () => {
    it("an EMPTY .git directory in an ancestor leaves a plain directory at none", () => {
      const root = tmp("sesh-scan-emptymarker-");
      const proj = join(root, "project");
      try {
        mkdirSync(join(root, ".git"));
        mkdirSync(proj);
        expect(scanGitRemotes(proj)).toEqual({ kind: "none" });
        // And for the same reason with no git to ask at all: the predicate
        // decides this, not git's exit code.
        const path = overridePath(tmp("sesh-scan-emptybin4-"));
        try {
          expect(scanGitRemotes(proj)).toEqual({ kind: "none" });
        } finally {
          path.restore();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("a directory named .git with unrelated contents and no HEAD is not a marker", () => {
      const root = tmp("sesh-scan-fakemarker-");
      const proj = join(root, "project");
      try {
        mkdirSync(join(root, ".git"));
        writeFileSync(join(root, ".git", "notes.txt"), "not a repository\n");
        mkdirSync(proj);
        expect(scanGitRemotes(proj)).toEqual({ kind: "none" });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("a .git FILE is still a marker — worktrees and submodules use one", () => {
      const dir = tmp("sesh-scan-gitfile-");
      writeFileSync(join(dir, ".git"), "gitdir: /nonexistent/worktrees/x\n");
      const path = overridePath(tmp("sesh-scan-emptybin5-"));
      try {
        const scan = scanGitRemotes(dir);
        expect(scan.kind).toBe("unknown");
        if (scan.kind !== "unknown") return;
        expect(scan.reason).toBe("git-missing");
        // The disclosure that makes the warning actionable: WHICH marker put
        // this path inside a repository.
        expect(scan.detail).toContain(join(dir, ".git"));
      } finally {
        path.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a .git directory containing HEAD is a marker", () => {
      const root = tmp("sesh-scan-headmarker-");
      const proj = join(root, "project");
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(proj);
      const path = overridePath(tmp("sesh-scan-emptybin6-"));
      try {
        const scan = scanGitRemotes(proj);
        expect(scan.kind).toBe("unknown");
        if (scan.kind !== "unknown") return;
        expect(scan.detail).toContain(join(root, ".git"));
      } finally {
        path.restore();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("a project inside a repository (no .git of its own) is not mistaken for a bare directory", () => {
    const repo = tmp("sesh-scan-monorepo-");
    const pkg = join(repo, "packages", "app");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/u/r.git"], { cwd: repo });
    mkdirSync(pkg, { recursive: true });
    try {
      expect(scanGitRemotes(pkg)).toEqual({
        kind: "remotes", normalized: ["github.com/u/r"], rawCount: 1,
      });
      // and with git gone, the ancestor walk is what keeps it out of "none"
      const path = overridePath(tmp("sesh-scan-emptybin3-"));
      try {
        expect(scanGitRemotes(pkg).kind).toBe("unknown");
      } finally {
        path.restore();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("identity resolution", () => {
  it("linked: local project.json wins without touching the hub", async () => {
    const dir = tmp("sesh-id-p-");
    const hub = tmp("sesh-id-hub-");
    try {
      const backend = createFsBackend(hub);
      mkdirSync(join(dir, ".sesh-mover"), { recursive: true });
      writeFileSync(
        join(dir, ".sesh-mover-project.json"),
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
