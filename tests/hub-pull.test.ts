import { describe, it, expect } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, cpSync, readFileSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { hubPull, selectNeededBundles } from "../src/hub/pull.js";
import { hubWhereis } from "../src/hub/whereis.js";
import { createFsBackend } from "../src/hub/backend.js";
import { readAllIndexes } from "../src/hub/index-file.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { extractArchive } from "../src/archiver.js";
import { importSession } from "../src/importer.js";
import { readSyncState, getThreadId } from "../src/sync-state.js";
import { encodeProjectPath } from "../src/platform.js";
import type { HubPullListResult, HubPullResult, NotYetSyncedResult } from "../src/types.js";

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

// Same technique hub-push.test.ts uses (see its own comment): identity
// linking writes .claude-sesh-mover/project.json under the real project
// directory, and this sandbox has no permission to create top-level dirs
// like "/Users" — so every hub test that links identity works against a
// REAL git-less directory, with the fixture's session content copied into
// its encoded config-dir slot.
function createRealProject(base: string, configDir: string, name: string): string {
  const realProj = join(base, name);
  mkdirSync(realProj, { recursive: true });
  writeFileSync(join(realProj, "README.md"), "hello\n");
  const realEncoded = encodeProjectPath(realProj);
  cpSync(join(configDir, "projects", FIXTURE_ENCODED), join(configDir, "projects", realEncoded), {
    recursive: true,
  });
  return realProj;
}

function rec(over: Partial<import("../src/hub/layout.js").HubBundleRecord>): import("../src/hub/layout.js").HubBundleRecord {
  return {
    bundleId: "b", file: "f", type: "full", sessionIdInBundle: "s",
    fromEntryUuid: null, headEntryUuid: "h", messageCount: 1, pushedAt: "t", hasWorkspace: false,
    ...over,
  };
}

describe("selectNeededBundles (pure)", () => {
  it("no full bundle at all -> the whole chain is needed", () => {
    const bundles = [
      rec({ bundleId: "c1", type: "continuation", sessionIdInBundle: "s1" }),
      rec({ bundleId: "c2", type: "continuation", sessionIdInBundle: "s2" }),
    ];
    expect(selectNeededBundles(bundles, undefined, () => false).map((b) => b.bundleId)).toEqual(["c1", "c2"]);
  });

  it("takes the LAST full bundle plus everything after it, dropping earlier fulls/continuations", () => {
    const bundles = [
      rec({ bundleId: "full-old", type: "full", sessionIdInBundle: "s0" }),
      rec({ bundleId: "cont-old", type: "continuation", sessionIdInBundle: "s0b" }),
      rec({ bundleId: "full-new", type: "full", sessionIdInBundle: "s1" }),
      rec({ bundleId: "cont-new", type: "continuation", sessionIdInBundle: "s1b" }),
    ];
    expect(selectNeededBundles(bundles, undefined, () => false).map((b) => b.bundleId)).toEqual([
      "full-new", "cont-new",
    ]);
  });

  it("drops a record already received AND whose local file still exists; keeps it if the file is gone", () => {
    const bundles = [
      rec({ bundleId: "full-new", type: "full", sessionIdInBundle: "s1" }),
      rec({ bundleId: "cont-new", type: "continuation", sessionIdInBundle: "s1b" }),
    ];
    const received = { s1: { localSessionId: "local-s1" } };
    const keptWhenFileExists = selectNeededBundles(bundles, received, (id) => id === "local-s1");
    expect(keptWhenFileExists.map((b) => b.bundleId)).toEqual(["cont-new"]);

    const keptWhenFileMissing = selectNeededBundles(bundles, received, () => false);
    expect(keptWhenFileMissing.map((b) => b.bundleId)).toEqual(["full-new", "cont-new"]);
  });
});

describe("hub pull", () => {
  it("pull --latest imports the thread; whereis afterwards shows the local copy current", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;

      restore.restore();
      restore = overrideHome(homeB);

      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), "sesh-pull-projB-"));
      // Pre-link B to A's hub project directly (same idiom hub-whereis.test.ts
      // uses) rather than exercising --project-id's own write path here —
      // that write path is exercised separately by test 5.
      writeLocalProjectId(projectB, {
        projectId: pushResult.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.importedSessions).toHaveLength(1);
      expect(p.skippedSessions).toHaveLength(0);
      expect(p.workspaceUnpacked).toBeNull();
      expect(p.sourceMachineId).not.toBe("");

      const whereisB = await hubWhereis({ configDir: configDirB, projectPath: projectB, hubPath: hub });
      expect(whereisB.linked).toBe(true);
      const thread = whereisB.threads.find((t) => t.threadId === p.threadId);
      expect(thread).toBeDefined();
      expect(thread!.localCopy).not.toBeNull();
      expect(thread!.localCopy!.current).toBe(true);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("pull with neither --thread nor --latest returns a pick-required thread list", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;

      restore.restore();
      restore = overrideHome(homeB);

      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), "sesh-pull-projB-"));
      writeLocalProjectId(projectB, {
        projectId: pushResult.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const list = pull as HubPullListResult;
      expect(list.pickRequired).toBe(true);
      expect(list.threads).toHaveLength(1);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("a bundle file missing from the hub dir -> not-yet-synced naming the file", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;

      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, pushResult.projectId);
      const bundleFile = Object.values(indexes[0].threads)[0].bundles[0].file;
      await backend.delete(bundleFile);
      expect(await backend.exists(bundleFile)).toBe(false);

      restore.restore();
      restore = overrideHome(homeB);

      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), "sesh-pull-projB-"));
      writeLocalProjectId(projectB, {
        projectId: pushResult.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(false);
      if (pull.success) return;
      const notSynced = pull as NotYetSyncedResult;
      expect(notSynced.reason).toBe("not-yet-synced");
      expect(notSynced.missing).toContain(bundleFile);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("repeated pull is idempotent: no extra session files land, second pull reports nothing to do", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;

      restore.restore();
      restore = overrideHome(homeB);

      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), "sesh-pull-projB-"));
      writeLocalProjectId(projectB, {
        projectId: pushResult.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      const first = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      if (!first.success) return;
      const firstPull = first as HubPullResult;

      const targetProjectDir = join(configDirB, "projects", encodeProjectPath(projectB));
      const filesBefore = readdirSync(targetProjectDir).filter((f) => f.endsWith(".jsonl"));
      expect(filesBefore).toHaveLength(1);

      // --latest: this machine's copy is now current for every thread, so
      // there is deterministically nothing left to pick regardless of any
      // "latest copy" tie-break between the two now-identical copies.
      const second = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(second.success).toBe(false);

      // Explicit --thread re-pull of the same thread must also be a no-op —
      // either because it's already-local-latest or because every bundle in
      // its chain was already received (both are valid ErrorResult outcomes;
      // what matters is that it never re-imports).
      const third = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        threadId: firstPull.threadId, claudeVersion: "2.1.81",
      });
      expect(third.success).toBe(false);

      const filesAfter = readdirSync(targetProjectDir).filter((f) => f.endsWith(".jsonl"));
      expect(filesAfter).toEqual(filesBefore);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("workspace round-trip: pull with --target-path unpacks files and plants the pushed project id", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let identityAnchorB: string | undefined;
    let targetParent: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      // Real, git-less project dir with content — push captures a workspace
      // snapshot (same arrangement as hub-push.test.ts's "workspace snapshot
      // included for non-git projects" test), since noWorkspace is NOT set
      // and the directory exists on disk.
      const projectA = createRealProject(base, configDirA, "projA-ws");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;
      expect(pushResult.hasWorkspace).toBe(true);

      restore.restore();
      restore = overrideHome(homeB);

      const configDirB = join(homeB, ".claude");
      // Identity is linked via --project-id against a SEPARATE real
      // directory from the unpack destination (opts.projectPath), so the
      // unpack destination (opts.targetPath) is left genuinely nonexistent
      // going into the pull — otherwise linking would materialize
      // .claude-sesh-mover under it first and the "project path does not
      // exist locally" workspace gate would never fire.
      identityAnchorB = mkdtempSync(join(tmpdir(), "sesh-pull-identB-"));
      targetParent = mkdtempSync(join(tmpdir(), "sesh-pull-targetparent-"));
      const targetPath = join(targetParent, "new-project");
      expect(existsSync(targetPath)).toBe(false);

      const pull = await hubPull({
        configDir: configDirB, projectPath: identityAnchorB, hubPath: hub,
        targetPath, latest: true,
        projectIdOverride: pushResult.projectId,
        claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceUnpacked).not.toBeNull();
      expect(p.workspaceUnpacked!.path).toBe(targetPath);
      expect(p.workspaceUnpacked!.fileCount).toBeGreaterThanOrEqual(1);
      expect(p.importedSessions).toHaveLength(1);

      expect(existsSync(join(targetPath, "README.md"))).toBe(true);
      expect(readFileSync(join(targetPath, "README.md"), "utf-8")).toBe("hello\n");

      const plantedIdPath = join(targetPath, ".claude-sesh-mover", "project.json");
      expect(existsSync(plantedIdPath)).toBe(true);
      const planted = JSON.parse(readFileSync(plantedIdPath, "utf-8"));
      expect(planted.projectId).toBe(pushResult.projectId);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (identityAnchorB) rmSync(identityAnchorB, { recursive: true, force: true });
      if (targetParent) rmSync(targetParent, { recursive: true, force: true });
    }
  });

  it("explicit --target-path at a non-empty dir without --force-workspace refuses with the force suggestion", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let identityAnchorB: string | undefined;
    let targetPath: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA-ws");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;
      expect(pushResult.hasWorkspace).toBe(true);

      restore.restore();
      restore = overrideHome(homeB);

      const configDirB = join(homeB, ".claude");
      identityAnchorB = mkdtempSync(join(tmpdir(), "sesh-pull-identB-"));
      // The user EXPLICITLY asked for this destination and it is non-empty:
      // refuse loudly instead of silently skipping the unpack.
      targetPath = mkdtempSync(join(tmpdir(), "sesh-pull-occupied-"));
      writeFileSync(join(targetPath, "occupied.txt"), "already here\n");

      const pull = await hubPull({
        configDir: configDirB, projectPath: identityAnchorB, hubPath: hub,
        targetPath, latest: true,
        projectIdOverride: pushResult.projectId,
        claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(false);
      if (pull.success) return;
      expect((pull as { suggestion?: string }).suggestion).toContain("--force-workspace");
      // Refusal happens before any session import: no project dir was created
      // for the target path, and the occupied file is untouched.
      expect(existsSync(join(configDirB, "projects", encodeProjectPath(targetPath)))).toBe(false);
      expect(readFileSync(join(targetPath, "occupied.txt"), "utf-8")).toBe("already here\n");
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (identityAnchorB) rmSync(identityAnchorB, { recursive: true, force: true });
      if (targetPath) rmSync(targetPath, { recursive: true, force: true });
    }
  });

  it("no explicit target: non-empty project dir skips the workspace unpack with a warning, sessions still import", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA-ws");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;
      expect(pushResult.hasWorkspace).toBe(true);

      restore.restore();
      restore = overrideHome(homeB);

      const configDirB = join(homeB, ".claude");
      // Routine repeat-pull shape: the project already exists locally (it is
      // at minimum non-empty from its own .claude-sesh-mover/project.json).
      projectB = mkdtempSync(join(tmpdir(), "sesh-pull-projB-"));
      writeLocalProjectId(projectB, {
        projectId: pushResult.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });
      writeFileSync(join(projectB, "local-work.txt"), "mine\n");

      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      // Unpack was skipped, not errored — sessions still imported.
      expect(p.workspaceUnpacked).toBeNull();
      expect(p.importedSessions).toHaveLength(1);
      expect(p.warnings.join(" ")).toContain("--force-workspace");
      // The bundle's workspace payload (README.md from projA) was NOT written.
      expect(existsSync(join(projectB, "README.md"))).toBe(false);
      expect(readFileSync(join(projectB, "local-work.txt"), "utf-8")).toBe("mine\n");
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("--force-workspace merges into a non-empty target, overwriting collided files and keeping the rest", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let identityAnchorB: string | undefined;
    let targetPath: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA-ws");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;
      expect(pushResult.hasWorkspace).toBe(true);

      restore.restore();
      restore = overrideHome(homeB);

      const configDirB = join(homeB, ".claude");
      identityAnchorB = mkdtempSync(join(tmpdir(), "sesh-pull-identB-"));
      targetPath = mkdtempSync(join(tmpdir(), "sesh-pull-merge-"));
      writeFileSync(join(targetPath, "README.md"), "stale\n"); // collides with the pushed workspace file
      writeFileSync(join(targetPath, "keep.txt"), "untouched\n");

      const pull = await hubPull({
        configDir: configDirB, projectPath: identityAnchorB, hubPath: hub,
        targetPath, latest: true, forceWorkspace: true,
        projectIdOverride: pushResult.projectId,
        claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceUnpacked).not.toBeNull();
      expect(p.workspaceUnpacked!.path).toBe(targetPath);
      expect(p.importedSessions).toHaveLength(1);
      // Incoming content wins the collision; unrelated local files survive.
      expect(readFileSync(join(targetPath, "README.md"), "utf-8")).toBe("hello\n");
      expect(readFileSync(join(targetPath, "keep.txt"), "utf-8")).toBe("untouched\n");
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (identityAnchorB) rmSync(identityAnchorB, { recursive: true, force: true });
      if (targetPath) rmSync(targetPath, { recursive: true, force: true });
    }
  });

  it("cross-route duplicate: thread mapping falls back to the imported-hash registry", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let projectB: string | undefined;
    let extractStage: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;

      restore.restore();
      restore = overrideHome(homeB);

      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), "sesh-pull-projB-"));
      writeLocalProjectId(projectB, {
        projectId: pushResult.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      // Cross-route arrangement: the SAME bundle content reaches B first via
      // a plain import whose manifest carries no source machine id — so only
      // the integrity-hash registry (state.imported) records it, never
      // peers[A].received. A subsequent pull then sees the bundle as needed
      // (no received entry), and its inner import skips it as a "duplicate"
      // via the hash registry.
      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, pushResult.projectId);
      const bundleFile = Object.values(indexes[0].threads)[0].bundles[0].file;
      extractStage = mkdtempSync(join(tmpdir(), "sesh-pull-xroute-"));
      const tarPath = join(extractStage, "bundle.tar.gz");
      writeFileSync(tarPath, await backend.read(bundleFile));
      const extractedDir = join(extractStage, "extracted");
      mkdirSync(extractedDir, { recursive: true });
      await extractArchive(tarPath, extractedDir);
      const manifestPath = join(extractedDir, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      delete manifest.sourceMachineId;
      delete manifest.sourceMachineName;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

      const plainImport = await importSession({
        exportPath: extractedDir,
        targetConfigDir: configDirB,
        targetProjectPath: projectB,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });
      expect(plainImport.success).toBe(true);
      if (!plainImport.success) return;
      const priorLocalId = (plainImport.importedSessions as Array<{ newId: string }>)[0].newId;
      const stateBefore = readSyncState(projectB);
      expect(Object.keys(stateBefore.peers)).toHaveLength(0); // no peer bookkeeping recorded

      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.importedSessions).toHaveLength(0);
      expect(p.skippedSessions.map((s) => s.reason)).toEqual(["duplicate"]);
      // The resolved local session id comes from the imported-hash registry,
      // never a fabricated "".
      expect(p.localSessionId).toBe(priorLocalId);
      // ...and setThreadId really ran against that id.
      const stateAfter = readSyncState(projectB);
      expect(getThreadId(stateAfter, priorLocalId)).toBe(p.threadId);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
      if (extractStage) rmSync(extractStage, { recursive: true, force: true });
    }
  });
});
