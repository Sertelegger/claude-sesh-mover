import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { hubReindex } from "../src/hub/reindex.js";
import { readMachineIndex } from "../src/hub/index-file.js";
import { createFsBackend } from "../src/hub/backend.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { encodeProjectPath } from "../src/platform.js";
import type { HubIndexJson } from "../src/hub/layout.js";

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

// Same real-directory technique hub-push.test.ts uses: identity linking
// writes `.claude-sesh-mover/project.json` under the real project directory,
// which this sandbox can't do against a virtual "/Users/..." root.
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

// Strip the one field a rebuild is expected to differ on (the rebuild runs
// at a different wall-clock moment than the original push).
function withoutUpdatedAt(index: HubIndexJson): Omit<HubIndexJson, "updatedAt"> {
  const { updatedAt: _updatedAt, ...rest } = index;
  return rest;
}

describe("hub reindex", () => {
  it("rebuilds a deleted index to match the original push, modulo updatedAt", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const pushed = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(true);
      if (!pushed.success) return;

      const backend = createFsBackend(hub);
      const machine = loadOrCreateMachineId();
      const original = await readMachineIndex(backend, pushed.projectId, machine.id);
      expect(original).not.toBeNull();
      if (!original) return;

      // Blow away the index file entirely — the scenario reindex exists for.
      const { indexPath } = await import("../src/hub/layout.js");
      await backend.delete(indexPath(pushed.projectId, machine.id));
      expect(await readMachineIndex(backend, pushed.projectId, machine.id)).toBeNull();

      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.projects).toEqual([
        { projectId: pushed.projectId, threads: 1, bundlesScanned: 1 },
      ]);
      expect(result.warnings).toEqual([]);

      const rebuilt = await readMachineIndex(backend, pushed.projectId, machine.id);
      expect(rebuilt).not.toBeNull();
      if (!rebuilt) return;
      expect(withoutUpdatedAt(rebuilt)).toEqual(withoutUpdatedAt(original));
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("unlinked project returns an error suggesting push first", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      // Never linked (no push/--create-project ever ran against it) — the
      // path need not even exist; readLocalProjectId is a plain existsSync
      // check, same as hub-push's own unlinked test.
      const result = await hubReindex({
        configDir: join(home, ".claude"),
        projectPath: "/Users/testuser/Projects/testproject",
        hubPath: hub,
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/not linked/i);
      expect(result.suggestion).toMatch(/push/i);
    } finally {
      restore.restore();
      rmSync(home, { recursive: true, force: true });
      rmSync(hub, { recursive: true, force: true });
    }
  });

  it("carries forward a thread whose local session was deleted after being pushed", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const pushed = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(true);
      if (!pushed.success) return;

      const backend = createFsBackend(hub);
      const machine = loadOrCreateMachineId();
      const original = await readMachineIndex(backend, pushed.projectId, machine.id);
      expect(original).not.toBeNull();
      if (!original) return;
      const [threadId, originalEntry] = Object.entries(original.threads)[0];
      expect(originalEntry.localSessionId).toBe(sessionId);

      // The session that was just pushed no longer exists locally — the
      // realistic "moved on, deleted the old session" scenario a repair
      // reindex must survive.
      const realEncoded = encodeProjectPath(projectPath);
      rmSync(join(configDir, "projects", realEncoded, `${sessionId}.jsonl`), { force: true });

      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(true);
      if (!result.success) return;
      // Still one thread even though zero sessions are live locally now.
      expect(result.projects).toEqual([
        { projectId: pushed.projectId, threads: 1, bundlesScanned: 1 },
      ]);

      const rebuilt = await readMachineIndex(backend, pushed.projectId, machine.id);
      expect(rebuilt).not.toBeNull();
      if (!rebuilt) return;
      expect(rebuilt.threads[threadId]).toBeDefined();
      expect(rebuilt.threads[threadId].localSessionId).toBe(sessionId);
      expect(rebuilt.threads[threadId].bundles).toHaveLength(1);
      expect(rebuilt.threads[threadId].bundles[0].sessionIdInBundle).toBe(
        originalEntry.bundles[0].sessionIdInBundle
      );
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});
