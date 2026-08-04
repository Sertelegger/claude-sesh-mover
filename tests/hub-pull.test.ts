import { describe, it, expect } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, cpSync, readFileSync, readdirSync,
  appendFileSync, utimesSync,
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
import { createArchive, extractArchive } from "../src/archiver.js";
import { importSession } from "../src/importer.js";
import { readSyncState, getThreadId } from "../src/sync-state.js";
import { encodeProjectPath } from "../src/platform.js";
import type { HubPullListResult, HubPullResult, NotYetSyncedResult } from "../src/types.js";

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";
const FIXTURE_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
/** Uuid of the fixture session's last entry — every continuation's anchor. */
const FIXTURE_HEAD_UUID = "entry-3";

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
      expect(p.warnings.join(" ")).toContain("--target-path"); // names the fresh-dir recovery too
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

  it("in-place bootstrap: fresh dir + --project-id + NO target-path unpacks the workspace despite the just-planted metadata", async () => {
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
      // FRESH directory, no pre-link, no --target-path: identity linking via
      // --project-id plants .claude-sesh-mover/project.json into it before
      // the workspace gate runs. That metadata alone must count as "empty" —
      // otherwise the gate would skip with a warning whose --force-workspace
      // remedy can never work (the first pull already consumed the chain).
      projectB = mkdtempSync(join(tmpdir(), "sesh-pull-inplace-"));

      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true,
        projectIdOverride: pushResult.projectId,
        claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceUnpacked).not.toBeNull();
      expect(p.workspaceUnpacked!.path).toBe(projectB);
      expect(p.workspaceUnpacked!.fileCount).toBeGreaterThanOrEqual(1);
      expect(p.importedSessions).toHaveLength(1);
      // Payload arrived in place, alongside the planted metadata.
      expect(readFileSync(join(projectB, "README.md"), "utf-8")).toBe("hello\n");
      expect(existsSync(join(projectB, ".claude-sesh-mover", "project.json"))).toBe(true);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
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

// --- Continuation append path -------------------------------------------

/** Source paths a "pushed from a Windows machine" bundle claims to come from. */
const WIN_PROJECT = "C:\\Users\\alice\\projB";
const WIN_CONFIG = "C:\\Users\\alice\\.claude";
const WIN_FILE = "C:\\Users\\alice\\projB\\src\\index.ts";

type EntryMaker = (
  parentUuid: string,
  sessionId: string,
  projectPath: string
) => Array<Record<string, unknown>>;

/** Two plain entries whose only path field is the SOURCE machine's cwd. */
const plainEntries: EntryMaker = (parentUuid, sessionId, projectPath) => [
  {
    uuid: "b-entry-4", parentUuid, timestamp: "2026-04-11T09:00:00Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "user",
    message: { role: "user", content: "picking this up on the other machine" },
  },
  {
    uuid: "b-entry-5", parentUuid: "b-entry-4", timestamp: "2026-04-11T09:00:05Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "assistant",
    message: { model: "claude-opus-4-6", id: "msg_cont", content: [{ type: "text", text: "On it." }] },
  },
];

/**
 * Two entries carrying a Windows path in every field the rewriter is
 * responsible for: `cwd`, a `tool_result` body, `toolUseResult.stdout`, and a
 * `file-history-snapshot` backup key.
 */
const win32Entries: EntryMaker = (parentUuid, sessionId) => [
  {
    uuid: "b-entry-4", parentUuid, timestamp: "2026-04-11T09:00:00Z", sessionId,
    cwd: WIN_PROJECT, version: "2.1.81", type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: "toolu_cont", type: "tool_result", content: `file contents at ${WIN_FILE}` }],
    },
    toolUseResult: { stdout: `${WIN_FILE}: TypeScript file`, stderr: "" },
  },
  {
    uuid: "b-entry-5", parentUuid: "b-entry-4", timestamp: "2026-04-11T09:00:05Z", sessionId,
    cwd: WIN_PROJECT, version: "2.1.81", type: "file-history-snapshot",
    snapshot: { trackedFileBackups: { [WIN_FILE]: { backupId: "abc123@v1" } } },
  },
];

/** Push the base session out of the append liveness window. */
function ageOutOfLiveWindow(path: string): void {
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(path, old, old);
}

/**
 * Make the base look like a live Claude Code session: modified inside the
 * liveness window but STRICTLY in the past. Stamping "now" here is a race —
 * hubPull captures its `opNowMs` from `Date.now()` a moment later, and if
 * both land in the same millisecond the self-write exemption (`mtime >=
 * opNowMs`) fires and the append proceeds instead of declining.
 */
function makeLookLive(path: string): void {
  const recent = new Date(Date.now() - 30_000);
  utimesSync(path, recent, recent);
}

interface ContinuationArrangement {
  hub: string;
  configDirA: string;
  projectA: string;
  projectDirA: string;
  projectB: string;
  projectId: string;
  baseSessionId: string;
  basePath: string;
  cleanup(): void;
}

/**
 * The shared two-machine continuation arrangement for the append tests:
 *
 *   1. machine A pushes the fixture session (full bundle),
 *   2. machine B pulls it, appends `makeEntries(...)` to its imported copy,
 *      and pushes the resulting continuation bundle,
 *   3. HOME is switched back to A and A's base session file is aged out of
 *      the append liveness window (it was written seconds ago by the fixture
 *      copy, which would otherwise make every test a "recently-active"
 *      decline rather than a test of the behavior it names).
 *
 * B's appended entries deliberately carry B's OWN paths — the pull under test
 * is what has to translate them onto A.
 */
async function arrangeContinuation(
  makeEntries: EntryMaker = plainEntries
): Promise<ContinuationArrangement> {
  const homeA = mkdtempSync(join(tmpdir(), "sesh-app-homeA-"));
  const homeB = mkdtempSync(join(tmpdir(), "sesh-app-homeB-"));
  const hub = mkdtempSync(join(tmpdir(), "sesh-app-hub-"));
  const base = mkdtempSync(join(tmpdir(), "sesh-app-fix-"));
  let projectB: string | undefined;
  let restore = overrideHome(homeA);
  const cleanup = (): void => {
    restore.restore();
    for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
    if (projectB) rmSync(projectB, { recursive: true, force: true });
  };

  try {
    const { configDir: configDirA } = createFixtureTree(base);
    const projectA = createRealProject(base, configDirA, "projA");
    await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
    const pushA = await hubPush({
      configDir: configDirA, projectPath: projectA, hubPath: hub,
      createProject: true, noWorkspace: true, claudeVersion: "2.1.81",
    });
    if (!pushA.success) throw new Error(`arrange: A's push failed: ${JSON.stringify(pushA)}`);

    restore.restore();
    restore = overrideHome(homeB);

    const configDirB = join(homeB, ".claude");
    projectB = mkdtempSync(join(tmpdir(), "sesh-app-projB-"));
    writeLocalProjectId(projectB, {
      projectId: pushA.projectId, name: "projA",
      createdAt: new Date().toISOString(), createdByMachine: "machine-a",
    });
    const pullB = await hubPull({
      configDir: configDirB, projectPath: projectB, hubPath: hub,
      latest: true, claudeVersion: "2.1.81",
    });
    if (!pullB.success) throw new Error(`arrange: B's pull failed: ${JSON.stringify(pullB)}`);
    const localB = (pullB as HubPullResult).localSessionId;
    if (!localB) throw new Error("arrange: B's pull identified no local session");

    const bJsonl = join(configDirB, "projects", encodeProjectPath(projectB), `${localB}.jsonl`);
    const entries = makeEntries(FIXTURE_HEAD_UUID, localB, projectB);
    appendFileSync(bJsonl, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    const pushB = await hubPush({
      configDir: configDirB, projectPath: projectB, hubPath: hub,
      noWorkspace: true, claudeVersion: "2.1.81",
    });
    if (!pushB.success) throw new Error(`arrange: B's push failed: ${JSON.stringify(pushB)}`);
    if (pushB.pushedSessions[0]?.type !== "continuation") {
      throw new Error("arrange: B pushed a full bundle, not a continuation");
    }

    restore.restore();
    restore = overrideHome(homeA);

    const projectDirA = join(configDirA, "projects", encodeProjectPath(projectA));
    const basePath = join(projectDirA, `${FIXTURE_SESSION_ID}.jsonl`);
    ageOutOfLiveWindow(basePath);

    return {
      hub, configDirA, projectA, projectDirA, projectB,
      projectId: pushA.projectId, baseSessionId: FIXTURE_SESSION_ID, basePath, cleanup,
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * Rewrite the continuation bundle already sitting on the hub so it claims to
 * have been pushed from a Windows machine. Only manifest METADATA changes —
 * the session JSONL is untouched, so its manifest integrity hash stays valid
 * and the bundle is indistinguishable from a genuine cross-platform push.
 */
async function repointBundleAtWindows(hubPath: string, projectId: string): Promise<void> {
  const backend = createFsBackend(hubPath);
  const { indexes } = await readAllIndexes(backend, projectId);
  const record = indexes
    .flatMap((i) => Object.values(i.threads))
    .flatMap((t) => t.bundles)
    .find((b) => b.type === "continuation");
  if (!record) throw new Error("no continuation bundle on the hub to repoint");

  const stage = mkdtempSync(join(tmpdir(), "sesh-app-repoint-"));
  try {
    const tarPath = join(stage, "in.tar.gz");
    writeFileSync(tarPath, await backend.read(record.file));
    // extractArchive strips the single top-level wrapper entry, and
    // createArchive re-adds one named after the directory — so extracting
    // into "bundle/" round-trips the archive's shape exactly.
    const dir = join(stage, "bundle");
    mkdirSync(dir, { recursive: true });
    await extractArchive(tarPath, dir);

    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.sourcePlatform = "win32";
    manifest.sourceProjectPath = WIN_PROJECT;
    manifest.sourceConfigDir = WIN_CONFIG;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const outPath = join(stage, "out.tar.gz");
    await createArchive(dir, outPath, "gzip");
    await backend.writeAtomic(record.file, readFileSync(outPath));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

describe("hub pull — continuation append", () => {
  it("pulling a continuation appends to the local base instead of creating a fragment", async () => {
    const a = await arrangeContinuation();
    try {
      const before = readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"));
      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      const after = readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"));
      expect(after).toEqual(before); // NO new session file — appended
      expect(p.appended).toHaveLength(1);
      expect(p.appended![0].entriesAppended).toBe(2);
      expect(p.appended![0].baseSessionId).toBe(a.baseSessionId);
      expect(p.appended![0].threadId).toBe(p.threadId);
      expect(p.localSessionId).toBe(a.baseSessionId);

      const raw = readFileSync(a.basePath, "utf-8");
      const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
      expect(lines).toHaveLength(5); // 3 original + 2 appended
      expect(lines.every((l) => l.sessionId === a.baseSessionId)).toBe(true);
      expect(raw).not.toContain("[sesh-mover continuation]");
      // Same-platform, different project dir: the source machine's project
      // path must not survive into the local transcript.
      expect(lines[3].cwd).toBe(a.projectA);
      expect(lines[4].cwd).toBe(a.projectA);
      expect(raw).not.toContain(a.projectB);

      // The index projection has to pick the extended base up as the thread's
      // copy, or the append would be invisible to the other machine.
      const whereis = await hubWhereis({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
      });
      const thread = whereis.threads.find((t) => t.threadId === p.threadId);
      expect(thread?.localCopy?.current).toBe(true);
      expect(thread?.localCopy?.localSessionId).toBe(a.baseSessionId);
      expect(thread?.pullNeeded).toBe(false);
    } finally {
      a.cleanup();
    }
  });

  it("a cross-platform continuation lands with LOCAL paths in cwd, tool results and snapshot keys", async () => {
    const a = await arrangeContinuation(win32Entries);
    try {
      await repointBundleAtWindows(a.hub, a.projectId);

      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;
      expect(p.appended).toHaveLength(1);
      expect(p.appended![0].entriesAppended).toBe(2);

      const raw = readFileSync(a.basePath, "utf-8");
      const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
      expect(lines).toHaveLength(5);

      const localFile = join(a.projectA, "src", "index.ts");
      const toolEntry = lines[3];
      const snapshotEntry = lines[4];

      expect(toolEntry.cwd).toBe(a.projectA);
      expect(toolEntry.message.content[0].content).toBe(`file contents at ${localFile}`);
      expect(toolEntry.toolUseResult.stdout).toBe(`${localFile}: TypeScript file`);

      expect(snapshotEntry.cwd).toBe(a.projectA);
      expect(Object.keys(snapshotEntry.snapshot.trackedFileBackups)).toEqual([localFile]);

      // Catch-all: nothing from the source machine's user/home survived.
      expect(raw).not.toContain("alice");
    } finally {
      a.cleanup();
    }
  });

  it("--no-append keeps the Slice-1 fragment behavior", async () => {
    const a = await arrangeContinuation();
    try {
      const before = readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"));
      const baseBefore = readFileSync(a.basePath, "utf-8");
      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, noAppend: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      expect(p.appended ?? []).toHaveLength(0);
      const after = readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"));
      expect(after).toHaveLength(before.length + 1);
      expect(readFileSync(a.basePath, "utf-8")).toBe(baseBefore);

      const fragment = after.find((f) => !before.includes(f))!;
      const firstLine = readFileSync(join(a.projectDirA, fragment), "utf-8").split("\n")[0];
      expect(firstLine).toContain("[sesh-mover continuation]");
    } finally {
      a.cleanup();
    }
  });

  it("a live-looking base declines the append and falls back to a fragment with a warning", async () => {
    const a = await arrangeContinuation();
    try {
      const before = readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"));
      const baseBefore = readFileSync(a.basePath, "utf-8");
      makeLookLive(a.basePath);

      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      expect(p.appended ?? []).toHaveLength(0);
      const after = readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"));
      expect(after).toHaveLength(before.length + 1);
      expect(readFileSync(a.basePath, "utf-8")).toBe(baseBefore);
      expect(p.warnings.join(" ")).toContain("live session");
      expect(p.warnings.join(" ")).toContain("--force-append");
    } finally {
      a.cleanup();
    }
  });

  it("--force-append splices onto a live-looking base anyway", async () => {
    const a = await arrangeContinuation();
    try {
      const before = readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"));
      makeLookLive(a.basePath);

      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, forceAppend: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      expect(p.appended).toHaveLength(1);
      expect(readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"))).toEqual(before);
      expect(readFileSync(a.basePath, "utf-8").trim().split("\n")).toHaveLength(5);
    } finally {
      a.cleanup();
    }
  });
});
