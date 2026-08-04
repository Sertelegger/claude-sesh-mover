import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { readAllIndexes } from "../src/hub/index-file.js";
import { createFsBackend } from "../src/hub/backend.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { encodeProjectPath } from "../src/platform.js";
import { extractArchive } from "../src/archiver.js";

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
