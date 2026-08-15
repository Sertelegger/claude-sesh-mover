import { describe, it, expect } from "vitest";
import {
  mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, cpSync, existsSync, truncateSync,
  chmodSync, readdirSync, statSync,
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
import type { HubPushFailedResult } from "../src/types.js";

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

// Identity linking writes `.sesh-mover-project.json` under the real
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
   * `.sesh-mover-project.json` exists, `evaluateHookGate` lets the
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
      expect(existsSync(join(sessionless, ".sesh-mover-project.json"))).toBe(false);
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
      // Every hub-linked project has an untracked .sesh-mover-project.json
      // by the time carry runs — identity linking writes it earlier in this very
      // push. Nothing about it is gitignored, so only the NEVER floor keeps the
      // plugin's own state (and the file that decides what the NEXT push ships)
      // out of the bundle.
      expect(existsSync(join(extractDir, "carry", "untracked", ".sesh-mover"))).toBe(false);
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

  it("names the gitignored files the include list sent to the hub, in the warnings", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract((p) => {
      writeFileSync(join(p, ".gitignore"), "docs/\nsecret.env\n");
      mkdirSync(join(p, "docs"), { recursive: true });
      writeFileSync(join(p, "docs", "spec.md"), "# spec\n");
      writeFileSync(join(p, "secret.env"), "TOKEN=1\n");
      mkdirSync(join(p, ".sesh-mover"), { recursive: true });
      writeFileSync(join(p, ".sesh-mover-include"), "docs/\n");
    });
    try {
      expect(result.success).toBe(true);
      if (!result.success || !("carry" in result) || !result.carry) throw new Error("no carry");
      expect(result.carry.reIncluded).toEqual(["docs/spec.md"]);
      expect(result.warnings.some((w) => w.includes("docs/spec.md") && w.includes("sesh-mover-include"))).toBe(true);
      expect(existsSync(join(extractDir, "carry", "untracked", "docs", "spec.md"))).toBe(true);
      expect(existsSync(join(extractDir, "carry", "untracked", "secret.env"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("names the gitignored files git TRACKS separately, with the remedy that actually works", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract((p) => {
      // Committed first, gitignored after — the common shape, and the one the
      // "gitignored files never travel" wording used to hide. The include list never
      // touched it, so "remove the include-list line" is not the remedy.
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
      expect(warning).not.toContain("sesh-mover-include");
      // And it really is on the hub, in the bundle that just left the machine.
      expect(readFileSync(join(extractDir, "carry", "changes.patch"), "utf-8"))
        .toContain("+DB_PASSWORD=hunter2_NEW");
    } finally {
      cleanup();
    }
  });

  it("warns, without failing the push, when the carry busts the budget", async () => {
    // An explicit small budget rather than 6 MB against the default: since the
    // default is 50 MB, materializing enough bytes to bust it would cost every
    // run of this suite 50 MB of I/O to exercise one comparison. This is also
    // the path a user's `hub.carryMaxMb` takes to get here.
    const { result, extractDir, cleanup } = await pushAndExtract(
      (p) => {
        writeFileSync(join(p, "huge.bin"), "x".repeat(256 * 1024));
      },
      { budgets: { carryMaxBytes: 64 * 1024, workspaceMaxBytes: 50 * 1024 * 1024, warnings: [] } }
    );
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
  // path never travels unless the include list names it. This field is how a user
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

  it("reports top-level ignored paths not carried when the include list is absent", async () => {
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

  it("omits ignoredNotCarried once an include list exists", async () => {
    const reported = await pushIgnoreFixture("docs/\n", (p) => {
      mkdirSync(join(p, "docs"), { recursive: true });
      writeFileSync(join(p, "docs", "design.md"), "spec\n");
      // Present but empty of patterns: the user has already met the mechanism,
      // so the discovery aid has done its job and must stop nagging.
      mkdirSync(join(p, ".sesh-mover"), { recursive: true });
      writeFileSync(join(p, ".sesh-mover-include"), "# nothing yet\n");
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
      Array.from({ length: 14 }, (_, i) => `ig${i}/`).join("\n") + "\n.sesh-mover/\n",
      (p) => {
        for (let i = 0; i < 14; i++) {
          mkdirSync(join(p, `ig${i}`), { recursive: true });
          writeFileSync(join(p, `ig${i}`, "f.txt"), "x\n");
        }
      }
    );
    expect(reported).toHaveLength(10);
    expect(reported!.some((p) => p.startsWith(".sesh-mover"))).toBe(false);
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

/**
 * The other half of "a failed push must not leave the project linked".
 *
 * Deferring the identity write past the export only covers failures UP TO that
 * point. Everything after it — the archive, the bundle upload, the index write,
 * an unreadable file the workspace snapshot trips over — used to surface as a
 * bare thrown Error with `.sesh-mover-project.json` sitting in the project
 * directory, which is precisely what arms the default-on SessionEnd auto-push:
 * the next session end then uploads the whole working tree of a push the user
 * watched fail.
 *
 * Reproduced before that fix, twice, exactly as these tests inject it:
 * `ENOTDIR` when the bundle's parent directory path on the hub is already a
 * FILE, and `EACCES` inside the workspace snapshot. Both threw; both left
 * project.json behind.
 *
 * The local link is now committed at only two points, both of them AFTER this
 * push has delivered something: the up-to-date early return, and the moment the
 * bundle lands on the hub. So the two shapes above no longer write a link at
 * all — the strongest possible version of the guarantee — and the tests below
 * split accordingly: a failure BEFORE the bundle lands must leave nothing, a
 * failure AFTER it must roll the link back, and either way the result says
 * which in FIELDS (`linked`, `linkRolledBack`, `orphanHubProjectId`,
 * `orphanBundle`) rather than only in prose. The fields are what the unattended
 * SessionEnd push records; `recordAutoPushOutcome` never reads `details`.
 *
 * The hub half is NOT closed here and cannot be: nothing in src/ deletes a hub
 * file, so a `--create-project` push that fails afterwards leaves a hub project
 * nothing can remove. That one is reported instead — with the flag that links
 * to it rather than minting a second.
 */
describe("hub push — a failure after the identity is resolved", () => {
  const PROJECT_ID = "11111111-2222-3333-4444-555555555555";

  /** A hub project some other machine created, ready to be linked to. */
  function seedHubProject(hub: string, projectId = PROJECT_ID): string {
    mkdirSync(join(hub, "projects", projectId), { recursive: true });
    writeFileSync(
      join(hub, "projects", projectId, "project.json"),
      JSON.stringify({
        schemaVersion: 1, projectId, name: "seeded", matchers: { gitRemotes: [] },
        createdAt: "2026-07-01T00:00:00.000Z", createdByMachine: "some-other-machine",
      }, null, 2) + "\n"
    );
    return projectId;
  }

  /**
   * Make the bundle undeliverable: `writeStreamAtomic` mkdir's the bundle
   * directory, and a FILE already sitting at that path is an ENOTDIR the push
   * cannot route around. Chosen over a permission bit because it behaves the
   * same on every platform and says nothing about the user running the suite.
   */
  function blockBundleDir(hub: string, projectId = PROJECT_ID): void {
    writeFileSync(join(hub, "projects", projectId, "bundles"), "not a directory\n");
  }

  /**
   * The same trick one step later: the bundle uploads fine and the INDEX write
   * behind it is the ENOTDIR. This is the only injectable failure that lands
   * past the link commit, so it is the arrangement every rollback assertion in
   * this block is built on.
   */
  function blockIndexDir(hub: string, projectId = PROJECT_ID): void {
    writeFileSync(join(hub, "projects", projectId, "index"), "not a directory\n");
  }

  const linkPath = (projectPath: string): string =>
    join(projectPath, ".sesh-mover-project.json");

  /**
   * Narrow to the structured failure, asserting the discriminator on the way —
   * so a cast can never quietly pass over a result that lost its shape.
   */
  function asFailed(r: Awaited<ReturnType<typeof hubPush>>): HubPushFailedResult {
    expect(r.success).toBe(false);
    expect("reason" in r && r.reason).toBe("failed-after-link");
    return r as HubPushFailedResult;
  }

  it("writes no link at all when the failure lands before the bundle does", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-rb-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-rb-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-rb-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);
      blockBundleDir(hub);
      expect(existsSync(linkPath(projectPath))).toBe(false);

      const r = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });

      // Typed refusal, not a thrown Error: the one thing the user has to be
      // told — whether this project is linked now — is not in an exception,
      // and a throw would also skip `recordAutoPushOutcome` entirely, so an
      // unattended push's failure would leave no trace anywhere.
      const f = asFailed(r);
      expect(f.command).toBe("push");
      expect(f.error).toMatch(/ENOTDIR|not a directory/);
      expect(f.details).toMatch(/NOT linked/);

      // The consent gate was never opened: the bundle never landed, so the
      // link was never written and there was nothing to roll back. This is
      // stronger than the write-then-remove it replaced — an interrupted
      // process (SIGKILL between the two) cannot leave a link behind either.
      expect(f.linked).toBe(false);
      expect(f.linkRolledBack).toBe(false);
      expect(f.orphanBundle).toBe(false);
      expect(f.orphanHubProjectId).toBeNull();
      expect(f.projectId).toBe(PROJECT_ID);
      expect(existsSync(linkPath(projectPath))).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("removes only the link it wrote, leaving the user's own files beside it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-rb2-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-rb2-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-rb2-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      // The user's own files, written long before this push. All four are
      // siblings of the link file (0.8.0 root dotfiles), which is exactly why
      // the rollback may only ever name ONE path.
      mkdirSync(join(projectPath, ".sesh-mover"), { recursive: true });
      writeFileSync(join(projectPath, ".sesh-mover", "config.json"), "{}\n");
      writeFileSync(join(projectPath, ".sesh-mover-ignore"), "build/\n");
      writeFileSync(join(projectPath, ".sesh-mover-include"), "docs/\n");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);
      // Past the bundle upload, so a link really is written and really is
      // rolled back — the pre-bundle shape above never writes one.
      blockIndexDir(hub);

      const r = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      const f = asFailed(r);
      expect(f.linked).toBe(false);
      expect(f.linkRolledBack).toBe(true);
      expect(existsSync(linkPath(projectPath))).toBe(false);
      expect(readFileSync(join(projectPath, ".sesh-mover-ignore"), "utf-8")).toBe("build/\n");
      expect(readFileSync(join(projectPath, ".sesh-mover-include"), "utf-8")).toBe("docs/\n");
      expect(readFileSync(join(projectPath, ".sesh-mover", "config.json"), "utf-8")).toBe("{}\n");
      expect(existsSync(join(projectPath, "README.md"))).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * THE REGRESSION THIS BLOCK FAILED TO CATCH.
   *
   * The rollback used to `rmdirSync(dirname(link))` after removing the link,
   * and that was safe on the day it was written: the link lived at
   * `<project>/.claude-sesh-mover/project.json`, so the parent was a directory
   * the plugin owned. Since 0.8.0 the link is the root dotfile
   * `<project>/.sesh-mover-project.json` and the parent is THE USER'S PROJECT
   * DIRECTORY. `rmdirSync` succeeds on an empty directory, so a failed push
   * into a directory holding nothing else deleted the directory it was asked to
   * push — reachable from `push --project-path <empty-dir>`, since push never
   * requires the directory to exist and the link write mkdir's it.
   *
   * The assertion that should have caught it was vacuous: it checked that a
   * `.sesh-mover` directory the fixture never created was absent. This one
   * fails against the old code.
   */
  it("never removes the project directory itself, even when the link was its only file", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-rmdir-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-rmdir-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-rmdir-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      // Deliberately NOT createRealProject: that plants a README.md, which
      // would keep the directory non-empty and make the rmdir fail on its own.
      const projectPath = join(base, "emptyproj");
      mkdirSync(projectPath, { recursive: true });
      cpSync(
        join(configDir, "projects", FIXTURE_ENCODED),
        join(configDir, "projects", encodeProjectPath(projectPath)),
        { recursive: true }
      );
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);
      blockIndexDir(hub);

      const r = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      const f = asFailed(r);
      // The link was written (the bundle landed) and rolled back...
      expect(f.linkRolledBack).toBe(true);
      expect(existsSync(linkPath(projectPath))).toBe(false);
      // ...and the now-empty directory it lived in is still there.
      expect(existsSync(projectPath)).toBe(true);
      expect(statSync(projectPath).isDirectory()).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("a link that pre-dates the push survives the failure, and the result says so", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-keep-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-keep-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-keep-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);
      // Linked before this push ever ran — committed to the repo, in the real
      // flow. A failure of OURS is not licence to delete it.
      mkdirSync(join(projectPath, ".sesh-mover"), { recursive: true });
      const preExisting = JSON.stringify({
        projectId: PROJECT_ID, name: "seeded",
        createdAt: "2026-07-01T00:00:00.000Z", createdByMachine: "some-other-machine",
      }, null, 2) + "\n";
      writeFileSync(linkPath(projectPath), preExisting);
      blockBundleDir(hub);

      const r = await hubPush({ configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81" });
      const f = asFailed(r);
      expect(f.command).toBe("push");
      expect(f.details).toMatch(/already linked/);
      expect(f.details).toMatch(/stays linked/);
      // The disclosure that matters: this directory is linked RIGHT NOW, so
      // the SessionEnd auto-push is armed for it and will run again unattended.
      // Nothing was rolled back, because nothing here was ours to undo.
      expect(f.linked).toBe(true);
      expect(f.linkRolledBack).toBe(false);
      expect(f.projectId).toBe(PROJECT_ID);
      expect(readFileSync(linkPath(projectPath), "utf-8")).toBe(preExisting);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("names the hub project a failed --create-project left behind, and how to link to it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-orph-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-orph-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-orph-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      // `--create-project` mints a hub project id nobody can predict, so the
      // fault has to sit outside the hub: an unreadable file the workspace
      // snapshot's copy pass trips over (EACCES), which is the second shape the
      // reviewer reproduced. Mode bits say nothing when the suite runs as root.
      const locked = join(projectPath, "locked.txt");
      writeFileSync(locked, "nope\n");
      chmodSync(locked, 0o000);
      let enforced = false;
      try { readFileSync(locked); } catch { enforced = true; }
      if (!enforced) { chmodSync(locked, 0o644); return; }

      let r;
      try {
        r = await hubPush({
          configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
        });
      } finally {
        chmodSync(locked, 0o644); // so the temp tree can be cleaned up
      }

      const f = asFailed(r);
      expect(f.command).toBe("push");
      expect(f.error).toMatch(/EACCES|permission denied/);
      expect(existsSync(linkPath(projectPath))).toBe(false);

      // The half that cannot be rolled back: the hub project exists and nothing
      // removes it. It has to be named, with the flag that links to that one
      // rather than minting a second on the next attempt.
      const orphans = readdirSync(join(hub, "projects"));
      expect(orphans).toHaveLength(1);
      expect(f.suggestion).toContain(`--project-id ${orphans[0]}`);
      expect(f.details).toMatch(/NOT linked/);
      // As a field, not just as prose: this is the one thing a caller has to be
      // able to act on, and the id is unguessable. It is recorded the instant
      // the HUB file lands — a throw between that write and the local one used
      // to leave nothing recorded at all, so the orphan went unmentioned.
      expect(f.orphanHubProjectId).toBe(orphans[0]);
      expect(f.projectId).toBe(orphans[0]);
      expect(f.linked).toBe(false);
      expect(f.linkRolledBack).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("discloses a bundle that reached the hub before the index write failed", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-idx-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-idx-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-idx-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);
      // Bundle upload fine; the index write behind it is the ENOTDIR. The
      // bundle is atomic, so it really is on the hub when this throws.
      blockIndexDir(hub);

      const r = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      const f = asFailed(r);
      expect(existsSync(linkPath(projectPath))).toBe(false);
      expect(f.details).toMatch(/did reach the hub/);
      expect(f.orphanBundle).toBe(true);
      // This is the one window where a link IS written before the failure, so
      // it is also the only place the rollback itself is exercised.
      expect(f.linked).toBe(false);
      expect(f.linkRolledBack).toBe(true);
      // ...and it is really there, unreferenced by any index.
      expect(
        readdirSync(join(hub, "projects", PROJECT_ID, "bundles"), { recursive: true }).length
      ).toBeGreaterThan(0);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("the up-to-date no-op push still links the project", async () => {
    // The deliberate exception the deferral must not swallow, and the reason
    // `commitLocalLink` has TWO call sites: this push has nothing to send, so
    // it never reaches the bundle upload the other call site sits behind, yet
    // it is a successful push whose projectId is part of the result. A user who
    // lost the committed .sesh-mover-project.json gets it back from a no-op
    // push, and deferring past this point would take that away.
    const home = mkdtempSync(join(tmpdir(), "sesh-push-utd-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-utd-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-utd-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);

      const first = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      // Unlink it again — project.json is a committed file a user can lose, and
      // the re-link on an otherwise no-op push is what puts it back.
      rmSync(linkPath(projectPath), { force: true });

      const second = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect(second.upToDate).toBe(true);
      expect(existsSync(linkPath(projectPath))).toBe(true);
      expect(JSON.parse(readFileSync(linkPath(projectPath), "utf-8")).projectId).toBe(PROJECT_ID);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * A rollback the push REFUSES to perform, and the only shape that reports
   * `linked: true` after a link this push wrote.
   *
   * `rollbackLocalLink` re-reads the file before removing it: it is ours to
   * delete only while it still names the project id we wrote. Anything else
   * means something changed it underneath us — a concurrent pull, another push,
   * the user — and a link someone else put there is not collateral for our
   * failure. The user must then be told the truth, which is the uncomfortable
   * one: this directory IS linked and the SessionEnd auto-push IS armed.
   *
   * Arranged with the caller's own progress callback because that is the only
   * hook this module offers between the link write and a failure: on the
   * up-to-date path the link is committed immediately before the final progress
   * event, so a callback that rewrites the file and then throws reproduces the
   * concurrent-modification race deterministically, with no mocks and no
   * timing. It doubles as coverage that a throwing caller callback cannot leave
   * the link state undisclosed.
   */
  it("refuses to remove a link that now names a different project, and says the project IS linked", async () => {
    const OTHER_ID = "99999999-8888-7777-6666-555555555555";
    const home = mkdtempSync(join(tmpdir(), "sesh-push-refuse-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-refuse-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-refuse-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);

      const first = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      rmSync(linkPath(projectPath), { force: true }); // so the next push re-links

      const stolen = JSON.stringify({
        projectId: OTHER_ID, name: "someone else's link",
        createdAt: "2026-07-02T00:00:00.000Z", createdByMachine: "another-machine",
      }, null, 2) + "\n";
      const r = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
        onProgress: (ev) => {
          // The final hub-push event: emitted on the up-to-date path AFTER the
          // link has been committed. Earlier events (percent 0, and the
          // exporter's own phases) must not trigger this.
          if (ev.phase !== "hub-push" || ev.percent !== 100) return;
          expect(JSON.parse(readFileSync(linkPath(projectPath), "utf-8")).projectId).toBe(PROJECT_ID);
          writeFileSync(linkPath(projectPath), stolen);
          throw new Error("simulated failure after the link was committed");
        },
      });

      const f = asFailed(r);
      expect(f.error).toMatch(/simulated failure/);
      expect(f.linked).toBe(true);
      expect(f.linkRolledBack).toBe(false);
      expect(f.details).toMatch(/could NOT be removed/);
      expect(f.details).toMatch(/different hub project/);
      // The remedy has to be reachable without a shell incantation now that
      // there is a verb for it.
      expect(f.details).toMatch(/hub unlink/);
      // Untouched: the file the push found is the file the push left.
      expect(readFileSync(linkPath(projectPath), "utf-8")).toBe(stolen);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});
