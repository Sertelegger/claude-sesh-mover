import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
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
