import { describe, it, expect } from "vitest";
import {
  mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, cpSync, existsSync, truncateSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome, overridePath } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { readAllIndexes } from "../src/hub/index-file.js";
import { createFsBackend } from "../src/hub/backend.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { encodeProjectPath } from "../src/platform.js";
import { extractArchive } from "../src/archiver.js";
import { readSyncState } from "../src/sync-state.js";
import { WORKSPACE_MAX_BYTES } from "../src/hub/workspace.js";

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

// Identity linking writes `.claude-sesh-mover/project.json` under the real
// project directory (src/hub/identity.ts's writeLocalProjectId). The
// exporter/importer/migrator fixtures elsewhere in this suite get away with
// a purely virtual "/Users/testuser/Projects/testproject" projectPath
// because they never touch the real filesystem at that path — but hub
// identity does, and this sandbox can't write under a synthetic "/Users"
// root (no permission on "/"). So: create a REAL git-less directory and
// copy the fixture's session data into the config dir under ITS encoded
// name, then push using that real path. This is the same technique the
// brief spells out for the workspace-snapshot test, applied wherever a push
// actually needs to link project identity.
function createRealProject(base: string, configDir: string): string {
  const realProj = join(base, "realproj");
  mkdirSync(realProj, { recursive: true });
  writeFileSync(join(realProj, "README.md"), "hello\n");
  const realEncoded = encodeProjectPath(realProj);
  cpSync(join(configDir, "projects", FIXTURE_ENCODED), join(configDir, "projects", realEncoded), {
    recursive: true,
  });
  return realProj;
}

describe("hub push", () => {
  it("first push creates project, bundle, index; repeat push is up-to-date", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const first = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      if (!first.success) return;
      expect(first.pushedSessions).toHaveLength(1);
      expect(first.pushedSessions[0].type).toBe("full");
      expect(first.upToDate).toBe(false);

      const backend = createFsBackend(hub);
      const machine = loadOrCreateMachineId();
      const { indexes } = await readAllIndexes(backend, first.projectId);
      expect(indexes).toHaveLength(1);
      const thread = Object.values(indexes[0].threads)[0];
      expect(thread.bundles).toHaveLength(1);
      expect(await backend.exists(thread.bundles[0].file)).toBe(true);
      expect(indexes[0].machineId).toBe(machine.id);

      const second = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        claudeVersion: "2.1.81",
      });
      expect(second.success && second.success === true ? second.upToDate : false).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * Linking IS the consent gate for the default-on automation: once
   * `.claude-sesh-mover/project.json` exists, `evaluateHookGate` lets the
   * SessionEnd auto-push run, and for a git-less project that push uploads the
   * WHOLE working tree without reading .gitignore. So a push that FAILED must
   * not leave the project linked.
   *
   * Measured before this fix: `push --create-project` in a directory with no
   * sessions returned `{"success":false,"command":"export","error":"No sessions
   * found for this project"}` — the exporter's own result — while project.json
   * and the hub project had already been written. commands/push.md says report
   * and stop, so nothing disclosed the link, and the next session end uploaded
   * the tree, `.env` included.
   */
  it("a push that fails in the exporter leaves the project unlinked and says `push`", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-nolink-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-nolink-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-nolink-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      // A real directory with a `.env` in it and NO sessions in the config dir
      // — the shape a user lands in by running /sesh-mover:push from a fresh
      // scratch project.
      const sessionless = join(base, "sessionless");
      mkdirSync(sessionless, { recursive: true });
      writeFileSync(join(sessionless, ".env"), "DB_PASSWORD=hunter2\n");

      const r = await hubPush({
        configDir, projectPath: sessionless, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(r.success).toBe(false);
      if (r.success) return;
      // M1: every result is keyed by the command the user ran.
      expect(r.command).toBe("push");
      expect("error" in r && r.error).toContain("No sessions found");

      // Nothing local was linked...
      expect(existsSync(join(sessionless, ".claude-sesh-mover", "project.json"))).toBe(false);
      // ...and no hub project was minted for it either.
      expect(existsSync(join(hub, "projects"))).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("unlinked project with no candidates and no --create-project returns unlinked", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      // Identity resolution here is read-only (no --create-project, no
      // existing link) so the virtual fixture project path is fine — no
      // filesystem write is ever attempted against it.
      const r = await hubPush({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        hubPath: hub,
        claudeVersion: "2.1.81",
      });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect((r as { reason?: string }).reason).toBe("unlinked");
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("multi-session-id push bundles exactly the requested subset", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      const realEncoded = encodeProjectPath(projectPath);
      const idB = "660e8400-e29b-41d4-a716-446655440001";
      const idC = "660e8400-e29b-41d4-a716-446655440002";
      for (const [id, slug] of [
        [idB, "session-b"],
        [idC, "session-c"],
      ] as const) {
        writeFileSync(
          join(configDir, "projects", realEncoded, `${id}.jsonl`),
          JSON.stringify({
            uuid: `${slug}-e1`,
            timestamp: "2026-07-20T00:00:00Z",
            sessionId: id,
            cwd: projectPath,
            version: "2.1.81",
            slug,
            type: "user",
            message: { role: "user", content: `hello from ${slug}` },
          }) + "\n"
        );
      }
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const result = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        sessionIds: [sessionId, idB],
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.pushedSessions.map((s) => s.sessionId).sort()).toEqual(
        [sessionId, idB].sort()
      );

      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, result.projectId);
      const bundleFile = Object.values(indexes[0].threads).flatMap((t) => t.bundles)[0].file;
      const archiveTmp = join(base, "subset-bundle.tar.gz");
      writeFileSync(archiveTmp, await backend.read(bundleFile));
      const extractDir = join(base, "subset-extracted");
      mkdirSync(extractDir, { recursive: true });
      await extractArchive(archiveTmp, extractDir);

      const manifest = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf-8"));
      expect(manifest.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(
        [sessionId, idB].sort()
      );
      expect(existsSync(join(extractDir, "sessions", `${idC}.jsonl`))).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("empty sessionIds array behaves like undefined — pushes all, mints all threads", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      // [] is programmatically distinct from omitted but must behave
      // identically: not "mint zero threads yet export everything" (the bug
      // this guards against — see src/hub/push.ts's sessionIds normalization).
      const result = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        sessionIds: [],
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.pushedSessions.map((s) => s.sessionId)).toEqual([sessionId]);

      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, result.projectId);
      expect(indexes).toHaveLength(1);
      const threads = Object.values(indexes[0].threads);
      // One thread minted (for the one session), matching the pushed set —
      // not zero threads with a fully-exported bundle underneath.
      expect(threads).toHaveLength(1);
      expect(threads[0].bundles).toHaveLength(1);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("workspace snapshot included for non-git projects; manifest records it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const result = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.hasWorkspace).toBe(true);

      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, result.projectId);
      const thread = Object.values(indexes[0].threads)[0];
      const bundleFile = thread.bundles[0].file;

      const archiveTmp = join(base, "bundle.tar.gz");
      writeFileSync(archiveTmp, await backend.read(bundleFile));
      const extractDir = join(base, "extracted");
      mkdirSync(extractDir, { recursive: true });
      await extractArchive(archiveTmp, extractDir);

      const manifest = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf-8"));
      expect(manifest.workspace).toBeDefined();
      expect(manifest.workspace.fileCount).toBeGreaterThanOrEqual(1);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("hub push — git-diff carry", () => {
  function gitCommit(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  /** A real git project with a remote, one commit, and the fixture's sessions. */
  function makeCommittedGitProject(base: string, configDir: string): string {
    const projectPath = createRealProject(base, configDir);
    gitCommit(projectPath, ["init", "-q"]);
    gitCommit(projectPath, ["config", "user.email", "t@example.com"]);
    gitCommit(projectPath, ["config", "user.name", "Test"]);
    gitCommit(projectPath, ["remote", "add", "origin", "https://github.com/User/Repo.git"]);
    gitCommit(projectPath, ["add", "-A"]);
    gitCommit(projectPath, ["commit", "-q", "-m", "init"]);
    return projectPath;
  }

  async function pushAndExtract(
    prepare: (projectPath: string) => void,
    pushOverrides: Partial<Parameters<typeof hubPush>[0]> = {}
  ): Promise<{ result: Awaited<ReturnType<typeof hubPush>>; extractDir: string; cleanup: () => void }> {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    const cleanup = (): void => {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    };
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = makeCommittedGitProject(base, configDir);
      prepare(projectPath);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true,
        claudeVersion: "2.1.81", ...pushOverrides,
      });
      const extractDir = join(base, "extracted");
      if (result.success && "bundleId" in result && result.bundleId) {
        const backend = createFsBackend(hub);
        const { indexes } = await readAllIndexes(backend, result.projectId);
        const bundleFile = Object.values(indexes[0].threads)[0].bundles[0].file;
        const archiveTmp = join(base, "bundle.tar.gz");
        writeFileSync(archiveTmp, await backend.read(bundleFile));
        mkdirSync(extractDir, { recursive: true });
        await extractArchive(archiveTmp, extractDir);
      }
      return { result, extractDir, cleanup };
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  it("a dirty git project's bundle carries the patch, and the manifest records the base commit", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract((p) => {
      writeFileSync(join(p, "README.md"), "edited, uncommitted\n");
      writeFileSync(join(p, "scratch.txt"), "new work\n");
      // Names that survive git only because of `-z`; they then have to survive
      // the tar round trip too, which is where the payload actually travels.
      writeFileSync(join(p, "café note.txt"), "unicode\n");
    });
    try {
      expect(result.success).toBe(true);
      if (!result.success || !("carry" in result) || !result.carry) throw new Error("no carry");
      expect(result.hasWorkspace).toBe(false); // git remote: carry, not snapshot
      const manifest = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf-8"));
      expect(manifest.carry.baseCommit).toBe(result.carry.baseCommit);
      expect(manifest.carry.baseCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(readFileSync(join(extractDir, "carry", "changes.patch"), "utf-8")).toContain("README.md");
      expect(readFileSync(join(extractDir, "carry", "untracked", "scratch.txt"), "utf-8")).toBe("new work\n");
      // Every hub-linked project has an untracked .claude-sesh-mover/project.json
      // by the time carry runs — identity linking writes it earlier in this very
      // push. Nothing about it is gitignored, so only the NEVER floor keeps the
      // plugin's own state (and the file that decides what the NEXT push ships)
      // out of the bundle.
      expect(existsSync(join(extractDir, "carry", "untracked", ".claude-sesh-mover"))).toBe(false);
      expect(result.carry.untrackedCount).toBe(2);
      expect(readFileSync(join(extractDir, "carry", "untracked", "café note.txt"), "utf-8")).toBe("unicode\n");
    } finally {
      cleanup();
    }
  });

  it("carries nothing, and says nothing, for a clean git project", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract(() => {});
    try {
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect("carry" in result && result.carry).toBeFalsy();
      expect(existsSync(join(extractDir, "carry"))).toBe(false);
      expect(result.warnings.some((w) => w.includes("carr"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("--no-carry leaves uncommitted work at home", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract(
      (p) => { writeFileSync(join(p, "scratch.txt"), "new work\n"); },
      { noCarry: true }
    );
    try {
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect("carry" in result && result.carry).toBeFalsy();
      expect(existsSync(join(extractDir, "carry"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("names the gitignored files hubinclude sent to the hub, in the warnings", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract((p) => {
      writeFileSync(join(p, ".gitignore"), "docs/\nsecret.env\n");
      mkdirSync(join(p, "docs"), { recursive: true });
      writeFileSync(join(p, "docs", "spec.md"), "# spec\n");
      writeFileSync(join(p, "secret.env"), "TOKEN=1\n");
      mkdirSync(join(p, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(p, ".claude-sesh-mover", "hubinclude"), "docs/\n");
    });
    try {
      expect(result.success).toBe(true);
      if (!result.success || !("carry" in result) || !result.carry) throw new Error("no carry");
      expect(result.carry.reIncluded).toEqual(["docs/spec.md"]);
      expect(result.warnings.some((w) => w.includes("docs/spec.md") && w.includes("hubinclude"))).toBe(true);
      expect(existsSync(join(extractDir, "carry", "untracked", "docs", "spec.md"))).toBe(true);
      expect(existsSync(join(extractDir, "carry", "untracked", "secret.env"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("names the gitignored files git TRACKS separately, with the remedy that actually works", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract((p) => {
      // Committed first, gitignored after — the common shape, and the one the
      // "gitignored files never travel" wording used to hide. hubinclude never
      // touched it, so "remove the hubinclude line" is not the remedy.
      writeFileSync(join(p, ".env"), "DB_PASSWORD=old\n");
      execFileSync("git", ["add", ".env"], { cwd: p, stdio: "ignore" });
      execFileSync("git", ["commit", "-q", "-m", "oops"], { cwd: p, stdio: "ignore" });
      writeFileSync(join(p, ".gitignore"), ".env\n");
      execFileSync("git", ["add", ".gitignore"], { cwd: p, stdio: "ignore" });
      execFileSync("git", ["commit", "-q", "-m", "ignore it"], { cwd: p, stdio: "ignore" });
      writeFileSync(join(p, ".env"), "DB_PASSWORD=hunter2_NEW\n");
    });
    try {
      expect(result.success).toBe(true);
      if (!result.success || !("carry" in result) || !result.carry) throw new Error("no carry");
      expect(result.carry.trackedIgnored).toEqual([".env"]);
      expect(result.carry.reIncludedCount).toBe(0);
      const warning = result.warnings.find((w) => w.includes(".env"));
      expect(warning).toBeDefined();
      expect(warning).toContain("git rm --cached");
      expect(warning).not.toContain("hubinclude");
      // And it really is on the hub, in the bundle that just left the machine.
      expect(readFileSync(join(extractDir, "carry", "changes.patch"), "utf-8"))
        .toContain("+DB_PASSWORD=hunter2_NEW");
    } finally {
      cleanup();
    }
  });

  it("warns, without failing the push, when the carry busts the budget", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract((p) => {
      writeFileSync(join(p, "huge.bin"), "x".repeat(6 * 1024 * 1024));
    });
    try {
      expect(result.success).toBe(true);
      if (!result.success) return;
      // The sessions still push — the bundle is the point of the operation.
      expect(result.pushedSessions.length).toBeGreaterThan(0);
      expect("carry" in result && result.carry).toBeFalsy();
      expect(existsSync(join(extractDir, "carry"))).toBe(false);
      const warning = result.warnings.find((w) => w.includes("not carried"));
      expect(warning).toBeDefined();
      expect(warning).toContain("huge.bin");
      // The remedy has to be honest: this push already recorded its sessions as
      // sent, so an immediate re-push is "nothing to push" and the fixed carry
      // rides the NEXT push that has session content.
      expect(warning).toContain("next push");
    } finally {
      cleanup();
    }
  });

  // The whole-branch review's Critical 2. Which payload a push builds is decided
  // by asking git for this project's remotes, and "I could not ask" used to be
  // indistinguishable from "there are none" — the answer that uploads the entire
  // working tree, .gitignore not consulted, from an unattended hook.
  describe("payload routing when git's answer is not a plain yes/no", () => {
    it("a remote sesh-mover cannot canonicalize takes the CARRY path, not a whole-tree snapshot", async () => {
      const { result, extractDir, cleanup } = await pushAndExtract((p) => {
        // An ordinary self-hosted server: no dot in the host, so
        // normalizeGitRemote returns null and the project used to reclassify
        // as remote-less.
        gitCommit(p, ["remote", "set-url", "origin", "git@gitserver:team/repo.git"]);
        writeFileSync(join(p, ".gitignore"), ".env\n");
        writeFileSync(join(p, ".env"), "DB_PASSWORD=hunter2\n");
        writeFileSync(join(p, "README.md"), "edited, uncommitted\n");
      });
      try {
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.hasWorkspace).toBe(false);
        expect(existsSync(join(extractDir, "workspace"))).toBe(false);
        expect("carry" in result && result.carry).toBeTruthy();
        // The secret .gitignore is there to protect never leaves the machine.
        expect(existsSync(join(extractDir, "carry", "untracked", ".env"))).toBe(false);
        expect(readFileSync(join(extractDir, "carry", "changes.patch"), "utf-8")).not.toContain(
          "hunter2"
        );
      } finally {
        cleanup();
      }
    });

    it("git that cannot be run inside a repository builds NEITHER payload and says so", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
      const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
      const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
      const restore = overrideHome(home);
      const emptyBin = mkdtempSync(join(tmpdir(), "sesh-push-nobin-"));
      try {
        const { configDir } = createFixtureTree(base);
        const projectPath = makeCommittedGitProject(base, configDir);
        writeFileSync(join(projectPath, ".gitignore"), ".env\n");
        writeFileSync(join(projectPath, ".env"), "DB_PASSWORD=hunter2\n");
        await hubInit({ hubPath: hub, configScope: "user", cwd: home });

        // The SessionEnd hook's actual hazard: a detached process with a PATH
        // that has no git on it, in a project that very much has a remote.
        const path = overridePath(emptyBin);
        let result;
        try {
          result = await hubPush({
            configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
          });
        } finally {
          path.restore();
        }
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.hasWorkspace).toBe(false);
        expect("carry" in result && result.carry).toBeFalsy();
        expect(result.warnings.join(" ")).toMatch(/could not be established/);

        // ...and the bundle proves it: sessions only.
        const backend = createFsBackend(hub);
        const { indexes } = await readAllIndexes(backend, result.projectId);
        const bundleFile = Object.values(indexes[0].threads)[0].bundles[0].file;
        const archiveTmp = join(base, "bundle.tar.gz");
        writeFileSync(archiveTmp, await backend.read(bundleFile));
        const extractDir = join(base, "extracted-nogit");
        mkdirSync(extractDir, { recursive: true });
        await extractArchive(archiveTmp, extractDir);
        expect(existsSync(join(extractDir, "workspace"))).toBe(false);
        expect(existsSync(join(extractDir, "carry"))).toBe(false);
        expect(existsSync(join(extractDir, "sessions"))).toBe(true);
      } finally {
        restore.restore();
        for (const d of [home, hub, base, emptyBin]) rmSync(d, { recursive: true, force: true });
      }
    });

    it("a genuinely git-less project still gets its workspace snapshot with no git on PATH", async () => {
      // The false-positive control for the refusal above: the case the snapshot
      // exists for must not become collateral damage.
      const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
      const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
      const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
      const restore = overrideHome(home);
      const emptyBin = mkdtempSync(join(tmpdir(), "sesh-push-nobin2-"));
      try {
        const { configDir } = createFixtureTree(base);
        const projectPath = createRealProject(base, configDir);
        await hubInit({ hubPath: hub, configScope: "user", cwd: home });
        const path = overridePath(emptyBin);
        let result;
        try {
          result = await hubPush({
            configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
          });
        } finally {
          path.restore();
        }
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.hasWorkspace).toBe(true);
        expect(result.warnings.join(" ")).not.toMatch(/could not be established/);
      } finally {
        restore.restore();
        for (const d of [home, hub, base, emptyBin]) rmSync(d, { recursive: true, force: true });
      }
    });
  });
});

describe("hub push — ignoredNotCarried discovery aid", () => {
  // A git project's payload ships tracked/untracked-but-not-ignored files only
  // (Task 10 builds it); .gitignore is also where .env lives, so an ignored
  // path never travels unless hubinclude names it. This field is how a user
  // finds out the mechanism exists — it names what stayed behind.
  function makeGitProject(base: string, configDir: string, ignoreBody: string): string {
    const projectPath = createRealProject(base, configDir);
    execFileSync("git", ["init", "-q"], { cwd: projectPath, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/User/Repo.git"], {
      cwd: projectPath, stdio: "ignore",
    });
    writeFileSync(join(projectPath, ".gitignore"), ignoreBody);
    return projectPath;
  }

  async function pushIgnoreFixture(
    ignoreBody: string,
    prepare: (projectPath: string) => void,
    pushOverrides: Partial<Parameters<typeof hubPush>[0]> = {}
  ): Promise<string[] | undefined> {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = makeGitProject(base, configDir, ignoreBody);
      prepare(projectPath);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true,
        claudeVersion: "2.1.81", ...pushOverrides,
      });
      expect(result.success).toBe(true);
      if (!result.success) return undefined;
      expect(result.hasWorkspace).toBe(false); // git remote present: no snapshot
      return result.ignoredNotCarried;
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  }

  it("reports top-level ignored paths not carried when hubinclude is absent", async () => {
    const reported = await pushIgnoreFixture("docs/\nnode_modules/\nsecret.env\n", (p) => {
      mkdirSync(join(p, "docs", "specs"), { recursive: true });
      mkdirSync(join(p, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(p, "docs", "specs", "design.md"), "spec\n");
      writeFileSync(join(p, "node_modules", "pkg", "index.js"), "dep\n");
      writeFileSync(join(p, "secret.env"), "TOKEN=1\n");
    });
    expect(reported).toBeDefined();
    expect(reported).toContain("docs/");
    expect(reported).toContain("node_modules/");
    expect(reported).toContain("secret.env");
  });

  it("omits ignoredNotCarried once a hubinclude exists", async () => {
    const reported = await pushIgnoreFixture("docs/\n", (p) => {
      mkdirSync(join(p, "docs"), { recursive: true });
      writeFileSync(join(p, "docs", "design.md"), "spec\n");
      // Present but empty of patterns: the user has already met the mechanism,
      // so the discovery aid has done its job and must stop nagging.
      mkdirSync(join(p, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(p, ".claude-sesh-mover", "hubinclude"), "# nothing yet\n");
    });
    expect(reported).toBeUndefined();
  });

  it("stays silent for the auto-push hook (quiet)", async () => {
    const reported = await pushIgnoreFixture("docs/\n", (p) => {
      mkdirSync(join(p, "docs"), { recursive: true });
      writeFileSync(join(p, "docs", "design.md"), "spec\n");
    }, { quiet: true });
    expect(reported).toBeUndefined();
  });

  it("caps the report at 10 paths and never names plugin or VCS internals", async () => {
    const reported = await pushIgnoreFixture(
      Array.from({ length: 14 }, (_, i) => `ig${i}/`).join("\n") + "\n.claude-sesh-mover/\n",
      (p) => {
        for (let i = 0; i < 14; i++) {
          mkdirSync(join(p, `ig${i}`), { recursive: true });
          writeFileSync(join(p, `ig${i}`, "f.txt"), "x\n");
        }
      }
    );
    expect(reported).toHaveLength(10);
    expect(reported!.some((p) => p.startsWith(".claude-sesh-mover"))).toBe(false);
  });

  it("an over-budget workspace pushes the sessions, declares no payload, and records NO generation", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      // Sparse where the filesystem supports it: statSync reports the full size
      // without the test writing 51 MB of zeros.
      const huge = join(projectPath, "huge.bin");
      writeFileSync(huge, "");
      truncateSync(huge, WORKSPACE_MAX_BYTES + 1024 * 1024);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.pushedSessions.length).toBeGreaterThan(0); // sessions still travel
      expect(result.hasWorkspace).toBe(false);
      expect(result.warnings.some((w) => w.includes("snapshot budget"))).toBe(true);

      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, result.projectId);
      const bundleFile = Object.values(indexes[0].threads)[0].bundles[0].file;
      const archiveTmp = join(base, "bundle.tar.gz");
      writeFileSync(archiveTmp, await backend.read(bundleFile));
      const extractDir = join(base, "extracted");
      mkdirSync(extractDir, { recursive: true });
      await extractArchive(archiveTmp, extractDir);
      const manifest = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf-8"));
      expect(manifest.workspace).toBeUndefined();
      expect(existsSync(join(extractDir, "workspace"))).toBe(false);

      // The load-bearing half: recording a generation the hub never received
      // makes the next 3-way merge read the whole un-sent tree as "deleted
      // here" (design §5.2, Task 8's ancestor rule).
      const state = readSyncState(projectPath);
      expect(state.hub?.lastWorkspace).toBeUndefined();
      expect(state.hub?.workspaceGenerations ?? []).toEqual([]);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });


  it("is absent for a project with no git remote (its files travel as a workspace snapshot)", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.hasWorkspace).toBe(true);
      expect(result.ignoredNotCarried).toBeUndefined();
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});
