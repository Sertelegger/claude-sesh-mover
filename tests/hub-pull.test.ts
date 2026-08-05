import { describe, it, expect, vi } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, cpSync, readFileSync, readdirSync,
  appendFileSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome, overridePath } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { hubPull, selectNeededBundles, selectThreadBase, type HubPullOptions } from "../src/hub/pull.js";
import { hubWhereis } from "../src/hub/whereis.js";
import { createFsBackend } from "../src/hub/backend.js";
import { readAllIndexes } from "../src/hub/index-file.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { createArchive, extractArchive } from "../src/archiver.js";
import { importSession } from "../src/importer.js";
import { readSyncState, writeSyncState, getThreadId } from "../src/sync-state.js";
import { readLastEntryUuid } from "../src/jsonl.js";
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

  it("reports a carried payload and saves it, without touching the tree, when --apply-carry is absent", async () => {
    // Design §6.2: a carry applies ONLY on request, so the working tree must be
    // untouched here. What it does NOT do is drop the payload: this pull
    // records its bundles as received, so a re-run with --apply-carry answers
    // "Already up to date" and the only surviving copy would be the one inside
    // the bundle on the hub. It is written to .claude-sesh-mover/ instead.
    // (This test was Task 10's "before" control, which asserted the pull said
    // nothing about a carry at all — see the task 11 report.)
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      const { execFileSync } = await import("node:child_process");
      const g = (args: string[]): void => {
        execFileSync("git", args, { cwd: projectA, stdio: "ignore" });
      };
      g(["init", "-q"]);
      g(["config", "user.email", "t@example.com"]);
      g(["config", "user.name", "Test"]);
      g(["remote", "add", "origin", "https://github.com/User/Repo.git"]);
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "init"]);
      writeFileSync(join(projectA, "README.md"), "uncommitted\n");
      writeFileSync(join(projectA, "scratch.txt"), "wip\n");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;
      expect("carry" in pushResult && pushResult.carry).toBeTruthy();

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
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.importedSessions).toHaveLength(1);
      // Nothing of the carry reached the tree.
      expect(existsSync(join(projectB, "scratch.txt"))).toBe(false);
      expect(readdirSync(projectB).sort()).toEqual([".claude-sesh-mover"]);
      // It IS reported, and it IS recoverable.
      expect(p.carryAvailable?.baseCommit).toBeTruthy();
      expect(p.carryApplied?.applied).toBe(false);
      if (p.carryApplied?.applied === false) {
        expect(p.carryApplied.reason).toBe("not-requested");
        const saved = p.carryApplied.savedTo!;
        expect(readFileSync(join(saved, "untracked", "scratch.txt"), "utf-8")).toBe("wip\n");
        expect(readFileSync(join(saved, "README.md"), "utf-8")).toContain("apply");
      }
      // And the warning does not name the one remedy that cannot work.
      expect(p.warnings.join(" ")).toMatch(/were not applied/);
      expect(p.warnings.join(" ")).not.toMatch(/re-run|run again|retry/i);

      // Why it cannot work, demonstrated rather than asserted: the bundle is
      // recorded as received by the end of the pull above, so the obvious
      // "run it again with --apply-carry" is refused outright. This is the
      // whole reason the payload is saved instead of merely reported.
      const again = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, applyCarry: true, claudeVersion: "2.1.81",
      });
      expect(again.success).toBe(false);
      if (!again.success) expect(again.error).toMatch(/nothing to pull|already up to date/i);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("--apply-carry applies the carried work into a clone at the same commit", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    const cloneRoot = mkdtempSync(join(tmpdir(), "sesh-pull-clone-"));
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      const { execFileSync } = await import("node:child_process");
      const g = (args: string[], cwd = projectA): void => {
        execFileSync("git", args, { cwd, stdio: "ignore" });
      };
      g(["init", "-q"]);
      g(["config", "user.email", "t@example.com"]);
      g(["config", "user.name", "Test"]);
      g(["remote", "add", "origin", "https://github.com/User/Repo.git"]);
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "init"]);
      // The clone is the realistic receiving shape for a git project: same
      // commit, clean tree, and the plugin's own project.json untracked in it.
      const projectB = join(cloneRoot, "projB");
      execFileSync("git", ["clone", "-q", projectA, projectB], { stdio: "ignore" });
      writeFileSync(join(projectA, "README.md"), "uncommitted\n");
      writeFileSync(join(projectA, "scratch.txt"), "wip\n");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success) return;

      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      writeLocalProjectId(projectB, {
        projectId: pushResult.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, applyCarry: true, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.carryApplied?.applied).toBe(true);
      if (p.carryApplied?.applied) {
        expect(p.carryApplied.filesChanged).toBe(1);
        expect(p.carryApplied.untrackedCopied).toBe(1);
        expect(p.carryApplied.refused).toEqual([]);
      }
      expect(readFileSync(join(projectB, "README.md"), "utf-8")).toBe("uncommitted\n");
      expect(readFileSync(join(projectB, "scratch.txt"), "utf-8")).toBe("wip\n");
      // Applied, therefore not also parked: no saved copy is written when the
      // payload reached the tree.
      expect(readdirSync(join(projectB, ".claude-sesh-mover")).some((n) => n.startsWith("carry-")))
        .toBe(false);
      // The sessions still arrived — the working tree is the optional half.
      expect(p.importedSessions).toHaveLength(1);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base, cloneRoot]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("refuses a hostile carry payload end to end, with --apply-carry and everything else passing", async () => {
    // The whole path, not just applyCarry: a bundle sitting on the hub is
    // rewritten to carry a patch that writes `.claude-sesh-mover./config.json`
    // — the trailing-dot spelling the sender's own pathspec floor cannot
    // express — plus a planted `hubinclude`, i.e. the file deciding what THIS
    // machine's next push uploads and the one that redirects hub.path.
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    const cloneRoot = mkdtempSync(join(tmpdir(), "sesh-pull-clone-"));
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      const { execFileSync } = await import("node:child_process");
      const g = (args: string[], cwd = projectA): void => {
        execFileSync("git", args, { cwd, stdio: "ignore" });
      };
      g(["init", "-q"]);
      g(["config", "user.email", "t@example.com"]);
      g(["config", "user.name", "Test"]);
      g(["remote", "add", "origin", "https://github.com/User/Repo.git"]);
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "init"]);
      const projectB = join(cloneRoot, "projB");
      execFileSync("git", ["clone", "-q", projectA, projectB], { stdio: "ignore" });
      writeFileSync(join(projectA, "README.md"), "uncommitted\n");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success || !pushResult.bundleId) return;

      await mutateBundleTree(hub, pushResult.projectId, pushResult.bundleId, (dir) => {
        const hostile = ".claude-sesh-mover./config.json";
        writeFileSync(
          join(dir, "carry", "changes.patch"),
          `diff --git a/${hostile} b/${hostile}\nnew file mode 100644\nindex 0000000..d95f3ad\n` +
            `--- /dev/null\n+++ b/${hostile}\n@@ -0,0 +1 @@\n+{"hub":{"path":"/tmp/attacker"}}\n`
        );
        mkdirSync(join(dir, "carry", "untracked", ".claude-sesh-mover"), { recursive: true });
        writeFileSync(join(dir, "carry", "untracked", ".claude-sesh-mover", "hubinclude"), "*\n");
      });

      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      writeLocalProjectId(projectB, {
        projectId: pushResult.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, applyCarry: true, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.carryApplied?.applied).toBe(false);
      if (p.carryApplied?.applied === false) {
        expect(p.carryApplied.reason).toBe("unsafe-payload");
        // The saved copy exists for inspection but refuses to teach the user to
        // apply it: following that command by hand would land exactly what the
        // guard just refused.
        const readme = readFileSync(join(p.carryApplied.savedTo!, "README.md"), "utf-8");
        expect(readme).toContain("refused");
        expect(readme).not.toContain("apply --whitespace=nowarn");
        // ...and the warning must not send the user there looking for the
        // commands the README deliberately withholds.
        expect(p.carryApplied.savedCommands).toBe(false);
        expect(p.warnings.join(" ")).not.toContain("README with the exact commands");
        expect(p.warnings.join(" ")).toContain("what was withheld");
      }
      expect(existsSync(join(projectB, ".claude-sesh-mover.")))
        .toBe(false);
      expect(existsSync(join(projectB, ".claude-sesh-mover", "hubinclude"))).toBe(false);
      expect(existsSync(join(projectB, ".claude-sesh-mover", "config.json"))).toBe(false);
      // Only the plugin's own linking artifact and the saved payload are there.
      expect(readdirSync(join(projectB, ".claude-sesh-mover")).sort().join(",")).toMatch(
        /^carry-[^,]+,project\.json$/
      );
      // The sessions still arrived: the working tree is the optional half.
      expect(p.importedSessions).toHaveLength(1);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base, cloneRoot]) {
        rmSync(d, { recursive: true, force: true });
      }
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

  it("a workspace payload carrying plugin/VCS internals cannot plant them, and says so", async () => {
    // The hub is a plain directory, so a bundle is peer-supplied data. The one
    // file such a payload would most want to write is
    // `.claude-sesh-mover/hubinclude` — the list deciding what THIS machine's
    // next push ships — which would turn a workspace payload into an
    // exfiltration primitive. `.git` is the other: a store, not content.
    const homeA = mkdtempSync(join(tmpdir(), "sesh-pull-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-pull-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-pull-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-pull-fix-"));
    let identityAnchorB: string | undefined;
    let targetParent: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA-plant");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      const pushResult = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushResult.success).toBe(true);
      if (!pushResult.success || !pushResult.bundleId) return;

      // Rewrite the bundle ON THE HUB to say what no pusher would say.
      await mutateBundleTree(hub, pushResult.projectId, pushResult.bundleId, (dir) => {
        const ws = join(dir, "workspace");
        mkdirSync(join(ws, ".claude-sesh-mover"), { recursive: true });
        mkdirSync(join(ws, ".git"), { recursive: true });
        writeFileSync(join(ws, ".claude-sesh-mover", "hubinclude"), "*\n");
        writeFileSync(join(ws, ".git", "config"), "[remote]\n");
      });

      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      identityAnchorB = mkdtempSync(join(tmpdir(), "sesh-pull-identB-"));
      targetParent = mkdtempSync(join(tmpdir(), "sesh-pull-targetparent-"));
      const targetPath = join(targetParent, "new-project");

      const pull = await hubPull({
        configDir: configDirB, projectPath: identityAnchorB, hubPath: hub,
        targetPath, latest: true,
        projectIdOverride: pushResult.projectId,
        claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      // The payload's own README still lands: the refusal is scoped to the two
      // names, not to the payload.
      expect(readFileSync(join(targetPath, "README.md"), "utf-8")).toBe("hello\n");
      expect(existsSync(join(targetPath, ".git"))).toBe(false);
      // `.claude-sesh-mover` exists — pull plants its OWN project.json there —
      // but nothing of the payload's is inside it.
      expect(existsSync(join(targetPath, ".claude-sesh-mover", "project.json"))).toBe(true);
      expect(existsSync(join(targetPath, ".claude-sesh-mover", "hubinclude"))).toBe(false);
      expect(
        p.warnings.some((w) => w.includes("refused") && w.includes(".claude-sesh-mover"))
      ).toBe(true);
      // A RESULT FIELD, not just prose: this is the strongest signal the
      // command produces, and the milestone's cross-layer rule is that a skill
      // discriminator keys on fields, never on warning text.
      expect(p.workspaceRefused?.slice().sort()).toEqual([".claude-sesh-mover", ".git"]);
      // …and the warning does not accuse the sender: a sesh-mover older than
      // this guard, on a case-insensitive filesystem, legitimately shipped a
      // `.GIT` store, which is exactly the leak the guard closed.
      const refusalWarning = p.warnings.find((w) => w.includes("refused"))!;
      expect(refusalWarning).not.toContain("hand-made");
      expect(refusalWarning).toContain("older version");
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

/** Two further entries, for a second continuation on top of the first. */
const moreEntries: EntryMaker = (parentUuid, sessionId, projectPath) => [
  {
    uuid: "b-entry-6", parentUuid, timestamp: "2026-04-12T09:00:00Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "user",
    message: { role: "user", content: "and a bit more" },
  },
  {
    uuid: "b-entry-7", parentUuid: "b-entry-6", timestamp: "2026-04-12T09:00:05Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "assistant",
    message: { model: "claude-opus-4-6", id: "msg_cont2", content: [{ type: "text", text: "Done." }] },
  },
];

function appendEntries(path: string, entries: Array<Record<string, unknown>>): void {
  appendFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

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
  configDirB: string;
  /** B's local session id for the thread (its layer dirs hang off this). */
  bSessionId: string;
  projectId: string;
  baseSessionId: string;
  basePath: string;
  /**
   * Append more entries on machine B (chained onto B's current head) and push
   * them as a further continuation, leaving HOME back on machine A.
   */
  pushMoreFromB(makeEntries: EntryMaker): Promise<void>;
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

    const bProjectPath = projectB;
    const pushFromB = async (make: EntryMaker): Promise<void> => {
      const anchor = readLastEntryUuid(bJsonl);
      if (!anchor) throw new Error("arrange: B's session has no head entry");
      appendEntries(bJsonl, make(anchor, localB, bProjectPath));
      const push = await hubPush({
        configDir: configDirB, projectPath: bProjectPath, hubPath: hub,
        noWorkspace: true, claudeVersion: "2.1.81",
      });
      if (!push.success) throw new Error(`arrange: B's push failed: ${JSON.stringify(push)}`);
      if (push.pushedSessions[0]?.type !== "continuation") {
        throw new Error("arrange: B pushed a full bundle, not a continuation");
      }
    };

    await pushFromB(makeEntries);

    restore.restore();
    restore = overrideHome(homeA);

    const projectDirA = join(configDirA, "projects", encodeProjectPath(projectA));
    const basePath = join(projectDirA, `${FIXTURE_SESSION_ID}.jsonl`);
    ageOutOfLiveWindow(basePath);

    return {
      hub, configDirA, projectA, projectDirA, projectB, configDirB, bSessionId: localB,
      projectId: pushA.projectId, baseSessionId: FIXTURE_SESSION_ID, basePath, cleanup,
      async pushMoreFromB(make: EntryMaker): Promise<void> {
        restore.restore();
        restore = overrideHome(homeB);
        try {
          await pushFromB(make);
        } finally {
          restore.restore();
          restore = overrideHome(homeA);
        }
      },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * Unpack the most recently pushed continuation bundle on the hub, hand its
 * directory to `mutate`, and put it back under the same hub path.
 */
async function mutateContinuationBundle(
  hubPath: string,
  projectId: string,
  mutate: (bundleDir: string) => void
): Promise<void> {
  const backend = createFsBackend(hubPath);
  const { indexes } = await readAllIndexes(backend, projectId);
  const continuations = indexes
    .flatMap((i) => Object.values(i.threads))
    .flatMap((t) => t.bundles)
    .filter((b) => b.type === "continuation");
  const record = continuations[continuations.length - 1];
  if (!record) throw new Error("no continuation bundle on the hub to mutate");

  const stage = mkdtempSync(join(tmpdir(), "sesh-app-mutate-"));
  try {
    const tarPath = join(stage, "in.tar.gz");
    writeFileSync(tarPath, await backend.read(record.file));
    // extractArchive strips the single top-level wrapper entry, and
    // createArchive re-adds one named after the directory — so extracting
    // into "bundle/" round-trips the archive's shape exactly.
    const dir = join(stage, "bundle");
    mkdirSync(dir, { recursive: true });
    await extractArchive(tarPath, dir);

    mutate(dir);

    const outPath = join(stage, "out.tar.gz");
    await createArchive(dir, outPath, "gzip");
    await backend.writeAtomic(record.file, readFileSync(outPath));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Make the pushed continuation claim it came from a Windows machine. Only
 * manifest METADATA changes — the session JSONL is untouched, so its manifest
 * integrity hash stays valid and the bundle is indistinguishable from a
 * genuine cross-platform push.
 */
async function repointBundleAtWindows(hubPath: string, projectId: string): Promise<void> {
  await mutateContinuationBundle(hubPath, projectId, (dir) => {
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.sourcePlatform = "win32";
    manifest.sourceProjectPath = WIN_PROJECT;
    manifest.sourceConfigDir = WIN_CONFIG;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  });
}

describe("selectThreadBase (pure)", () => {
  const cand = (localSessionId: string, headEntryUuid: string | null, lastActiveAt: string | null) =>
    ({ localSessionId, headEntryUuid, lastActiveAt });

  // The poisoned map: a declined splice leaves the stale base AND the
  // fragment both mapped to the thread, base first. Insertion order would
  // pick the base forever and every later pull would fork another fragment.
  const stale = cand("base", "entry-3", "2026-04-10T12:01:00Z");
  const fragment = cand("fragment", "b-entry-5", "2026-04-11T09:00:05Z");

  it("picks the session whose head IS the delta's anchor, not the first-mapped one", () => {
    expect(selectThreadBase([stale, fragment], "b-entry-5", null)).toBe("fragment");
  });

  it("falls back to the most recent when nothing carries the anchor", () => {
    expect(selectThreadBase([stale, fragment], "no-such-uuid", null)).toBe("fragment");
    expect(selectThreadBase([stale, fragment], null, null)).toBe("fragment");
  });

  it("prefers the session this pull already landed content in", () => {
    expect(selectThreadBase([stale, fragment], null, "base")).toBe("base");
  });

  it("but the anchor still outranks the preferred session", () => {
    expect(selectThreadBase([stale, fragment], "b-entry-5", "base")).toBe("fragment");
  });

  it("a candidate whose head could not be read is never an anchor match", () => {
    const unreadable = cand("broken", null, "2026-04-30T00:00:00Z"); // newest of the three
    expect(selectThreadBase([unreadable, fragment], "b-entry-5", null)).toBe("fragment");
    // ...but with no anchor to go on it is simply the most recent candidate
    expect(selectThreadBase([unreadable, fragment], null, null)).toBe("broken");
  });

  it("is a total order: the answer never depends on input order", () => {
    const a = cand("aaa", "same-head", "2026-04-10T12:00:00Z");
    const b = cand("bbb", "same-head", "2026-04-10T12:00:00Z");
    expect(selectThreadBase([a, b], "same-head", null)).toBe(selectThreadBase([b, a], "same-head", null));
  });

  it("returns null when there is nothing to pick", () => {
    expect(selectThreadBase([], "anything", null)).toBeNull();
  });
});

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

  it("recovers from a thread mapped to several sessions: the NEXT continuation appends to the fragment, not the stale base", async () => {
    const a = await arrangeContinuation();
    try {
      // Pull 1 declines (the base looks live) and forks a fragment. The
      // thread is now mapped to TWO local sessions — the stale base first,
      // the fragment second. This is the routine shape, not an exotic one:
      // any base written by a previous pull is "recently active" for five
      // minutes.
      makeLookLive(a.basePath);
      const first = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      if (!first.success) return;
      expect((first as HubPullResult).appended ?? []).toHaveLength(0);
      const twoFiles = readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"));
      expect(twoFiles).toHaveLength(2);

      const state = readSyncState(a.projectA);
      const mapped = Object.entries(state.hub?.threadByLocalSession ?? {})
        .filter(([, t]) => t === (first as HubPullResult).threadId)
        .map(([id]) => id);
      expect(mapped).toHaveLength(2); // the poisoned map, as reproduced in review
      expect(mapped[0]).toBe(a.baseSessionId); // ...and the STALE one is first

      // B carries the conversation further; the new continuation's anchor is
      // the fragment's head, not the base's.
      await a.pushMoreFromB(moreEntries);
      for (const f of twoFiles) ageOutOfLiveWindow(join(a.projectDirA, f));

      const second = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(second.success).toBe(true);
      if (!second.success) return;
      const p = second as HubPullResult;

      // No third file: the append found the fragment by its anchor.
      expect(readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"))).toEqual(twoFiles);
      expect(p.appended).toHaveLength(1);
      expect(p.appended![0].baseSessionId).not.toBe(a.baseSessionId);
      expect(p.appended![0].entriesAppended).toBe(2);

      // The stale base is untouched, and the fragment now carries the tail.
      expect(readFileSync(a.basePath, "utf-8").trim().split("\n")).toHaveLength(3);
      const fragmentId = p.appended![0].baseSessionId;
      const fragment = readFileSync(join(a.projectDirA, `${fragmentId}.jsonl`), "utf-8");
      const uuids = fragment.trim().split("\n").map((l) => JSON.parse(l).uuid);
      expect(uuids.slice(1)).toEqual(["b-entry-4", "b-entry-5", "b-entry-6", "b-entry-7"]);
    } finally {
      a.cleanup();
    }
  });

  it("a continuation whose content fails its integrity check is never spliced into an existing session", async () => {
    const a = await arrangeContinuation();
    try {
      // Corrupt the bundle's session JSONL while leaving the manifest hash
      // alone: a half-synced hub file that still gunzips and still chains.
      await mutateContinuationBundle(a.hub, a.projectId, (dir) => {
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
        const sessionFile = join(dir, "sessions", `${manifest.sessions[0].sessionId}.jsonl`);
        appendEntries(sessionFile, [
          {
            uuid: "smuggled", parentUuid: "b-entry-5", timestamp: "2026-04-11T09:09:09Z",
            sessionId: manifest.sessions[0].sessionId, cwd: "/x", version: "2.1.81",
            type: "user", message: { role: "user", content: "not in the hash" },
          },
        ]);
      });

      const before = readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"));
      const baseBefore = readFileSync(a.basePath, "utf-8");

      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      expect(p.appended ?? []).toHaveLength(0);
      // The user's existing transcript is byte-identical...
      expect(readFileSync(a.basePath, "utf-8")).toBe(baseBefore);
      // ...the content still arrived, in a new file...
      expect(readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"))).toHaveLength(
        before.length + 1
      );
      // ...and the user is told, twice: once by the refusal, once by the
      // importer's own corruption warning.
      expect(p.warnings.join(" ")).toContain("not spliced");
      expect(p.warnings.join(" ")).toContain("integrity check failed");
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

  it("rewrites spliced subagent transcripts but copies file-history backups verbatim", async () => {
    const a = await arrangeContinuation();
    try {
      // Layer files planted on B, carried by its next continuation bundle.
      const subagentDir = join(
        a.configDirB, "projects", encodeProjectPath(a.projectB), a.bSessionId, "subagents"
      );
      mkdirSync(subagentDir, { recursive: true });
      writeFileSync(
        join(subagentDir, "agent-x.jsonl"),
        JSON.stringify({
          uuid: "sub-x-1", sessionId: a.bSessionId, cwd: a.projectB, type: "user",
          message: { role: "user", content: "explore the src directory" }, isSidechain: true,
        }) + "\n"
      );

      // A file-history backup that happens to be named .jsonl — a snapshot of
      // the USER's own data file, not a Claude transcript. It must survive
      // byte-for-byte: rewriting it would corrupt their backup and stamp it
      // with a session id that means nothing in that file.
      const fhDir = join(a.configDirB, "file-history", a.bSessionId);
      mkdirSync(fhDir, { recursive: true });
      const backup = JSON.stringify({ sessionId: "user-data", cwd: a.projectB }) + "\n";
      writeFileSync(join(fhDir, "notes.jsonl"), backup);

      await a.pushMoreFromB(moreEntries);
      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect((result as HubPullResult).appended?.length).toBeGreaterThanOrEqual(1);

      const landedSubagent = JSON.parse(
        readFileSync(join(a.projectDirA, a.baseSessionId, "subagents", "agent-x.jsonl"), "utf-8")
      );
      expect(landedSubagent.cwd).toBe(a.projectA); // path-rewritten
      expect(landedSubagent.sessionId).toBe(a.baseSessionId); // re-stamped

      const landedBackup = readFileSync(
        join(a.configDirA, "file-history", a.baseSessionId, "notes.jsonl"), "utf-8"
      );
      expect(landedBackup).toBe(backup); // untouched, still B's paths and ids
    } finally {
      a.cleanup();
    }
  });

  it("a layer-copy failure after a committed splice warns but never re-lands the entries", async () => {
    const a = await arrangeContinuation();
    try {
      // Make copyLayerDirs' first mkdirSync fail: the session's layer
      // directory path is occupied by a regular file.
      rmSync(join(a.projectDirA, a.baseSessionId), { recursive: true, force: true });
      writeFileSync(join(a.projectDirA, a.baseSessionId), "not a directory\n");

      const before = readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"));
      const first = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      if (!first.success) return;
      const p = first as HubPullResult;

      // The splice itself committed...
      expect(p.appended).toHaveLength(1);
      expect(readFileSync(a.basePath, "utf-8").trim().split("\n")).toHaveLength(5);
      // ...the user hears the side files are missing...
      expect(p.warnings.join(" ")).toContain("side files are missing");

      // ...and the bookkeeping was written BEFORE the layer copy, so the
      // bundle is not "needed" again. Without that ordering the next pull
      // would re-fetch it, chain-mismatch against the now-longer base, and
      // land the same two entries a second time as a fragment.
      const second = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(second.success).toBe(false);
      expect(readdirSync(a.projectDirA).filter((f) => f.endsWith(".jsonl"))).toEqual(before);
      expect(readFileSync(a.basePath, "utf-8").trim().split("\n")).toHaveLength(5);
    } finally {
      a.cleanup();
    }
  });

  // The whole reason `opNowMs` is captured once per operation rather than per
  // bundle, and the reason the pull tracks which session it just landed
  // content in: a machine seeing this thread for the first time pulls a full
  // bundle plus every continuation after it, and each splice targets a base
  // THIS operation wrote moments earlier. Get either wrong and the liveness
  // guard re-arms against our own writes, scattering one conversation across
  // 1 + N sessions.
  it("a fresh machine pulling full+continuation+continuation lands ONE session, not three", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-chain-homeA-"));
    const homeC = mkdtempSync(join(tmpdir(), "sesh-chain-homeC-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-chain-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-chain-fix-"));
    let projectC: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      const pushOpts = {
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        noWorkspace: true, claudeVersion: "2.1.81",
      };
      const full = await hubPush({ ...pushOpts, createProject: true });
      expect(full.success).toBe(true);
      if (!full.success) return;

      // Two further rounds of work on A, each pushed as its own continuation,
      // so ONE machine's index carries full + cont + cont for the thread.
      const aJsonl = join(configDirA, "projects", encodeProjectPath(projectA), `${FIXTURE_SESSION_ID}.jsonl`);
      appendEntries(aJsonl, plainEntries(FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, projectA));
      expect((await hubPush(pushOpts)).success).toBe(true);
      appendEntries(aJsonl, moreEntries("b-entry-5", FIXTURE_SESSION_ID, projectA));
      expect((await hubPush(pushOpts)).success).toBe(true);

      restore.restore();
      restore = overrideHome(homeC);

      const configDirC = join(homeC, ".claude");
      projectC = mkdtempSync(join(tmpdir(), "sesh-chain-projC-"));
      writeLocalProjectId(projectC, {
        projectId: full.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      const pull = await hubPull({
        configDir: configDirC, projectPath: projectC, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      expect(p.importedSessions).toHaveLength(1); // the full bundle only
      expect(p.appended).toHaveLength(2); // both continuations spliced onto it

      const projectDirC = join(configDirC, "projects", encodeProjectPath(projectC));
      const files = readdirSync(projectDirC).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(1);

      const raw = readFileSync(join(projectDirC, files[0]), "utf-8");
      const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => l.uuid)).toEqual([
        "entry-1", "entry-2", "entry-3", "b-entry-4", "b-entry-5", "b-entry-6", "b-entry-7",
      ]);
      expect(raw).not.toContain("[sesh-mover continuation]");
      expect(new Set(lines.map((l) => l.sessionId)).size).toBe(1);
      expect(p.localSessionId).toBe(files[0].replace(/\.jsonl$/, ""));
      // Both spliced rounds were path-rewritten onto C. (The fixture's own
      // first three entries carry a synthetic cwd that was never A's project
      // path, so there is no mapping for them to match — only the entries
      // written against projectA are in scope here.)
      expect(lines.slice(3).every((l) => l.cwd === projectC)).toBe(true);
    } finally {
      restore.restore();
      for (const d of [homeA, homeC, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectC) rmSync(projectC, { recursive: true, force: true });
    }
  });
});

// --- Divergence resolution ------------------------------------------------

/**
 * The entries machine A adds to its OWN copy after pushing — the second half
 * of a genuine fork. They hang off the same anchor B's continuation does, so
 * neither branch is a prefix of the other and the chain guard has to refuse.
 */
const localEntries: EntryMaker = (parentUuid, sessionId, projectPath) => [
  {
    uuid: "a-local-1", parentUuid, timestamp: "2026-04-11T10:00:00Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "user",
    message: { role: "user", content: "meanwhile, back on machine A" },
  },
  {
    uuid: "a-local-2", parentUuid: "a-local-1", timestamp: "2026-04-11T10:00:05Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "assistant",
    message: { model: "claude-opus-4-6", id: "msg_local", content: [{ type: "text", text: "Carrying on here." }] },
  },
];

/**
 * arrangeContinuation, then fork A's side too: A extends its base from the
 * very entry B's continuation is anchored on, without pushing. The base is
 * aged back out of the live window afterwards — appending just moved its
 * mtime to now, which would otherwise make every divergence test a liveness
 * story instead of the one it names.
 */
async function arrangeDivergence(): Promise<ContinuationArrangement> {
  const a = await arrangeContinuation();
  try {
    appendEntries(a.basePath, localEntries(FIXTURE_HEAD_UUID, a.baseSessionId, a.projectA));
    ageOutOfLiveWindow(a.basePath);
    return a;
  } catch (e) {
    a.cleanup();
    throw e;
  }
}

function jsonlFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
}

function uuidsOf(path: string): string[] {
  return readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l).uuid);
}

describe("hub pull — divergence resolution", () => {
  it("reports divergence and defaults to fragment", async () => {
    const a = await arrangeDivergence();
    try {
      const before = jsonlFiles(a.projectDirA);
      const baseBefore = readFileSync(a.basePath, "utf-8");

      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      const d = p.divergence;
      expect(d).toBeDefined();
      if (!d) return;
      expect(d.threadId).toBe(p.threadId);
      expect(d.anchorUuid).toBe(FIXTURE_HEAD_UUID);
      expect(d.localSessionId).toBe(a.baseSessionId);
      expect(d.localHeadUuid).toBe("a-local-2");
      expect(d.localEntriesSinceAnchor).toBe(2);
      expect(d.hubHeadUuid).toBe("b-entry-5");
      expect(d.hubEntriesSinceAnchor).toBe(2); // header excluded
      expect(d.adoptAvailable).toBe(true);
      expect(d.resolution).toBe("fragment");
      expect(d.preservedSessionId).toBeUndefined();

      // Fragment fallback: content arrived in a NEW file, base untouched.
      expect(jsonlFiles(a.projectDirA)).toHaveLength(before.length + 1);
      expect(readFileSync(a.basePath, "utf-8")).toBe(baseBefore);
      expect(p.appended ?? []).toHaveLength(0);
      expect(p.warnings.join(" ")).toContain("diverged");
      expect(p.warnings.join(" ")).toContain("--on-divergence");
    } finally {
      a.cleanup();
    }
  });

  it("--on-divergence adopt-hub yields two complete sessions", async () => {
    const a = await arrangeDivergence();
    try {
      const before = jsonlFiles(a.projectDirA);

      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      const d = p.divergence;
      expect(d?.resolution).toBe("adopt-hub");
      expect(d?.preservedSessionId).toBeTruthy();
      const preservedId = d!.preservedSessionId!;

      // Session 1: the base is now the hub's branch, common history intact.
      expect(uuidsOf(a.basePath)).toEqual([
        "entry-1", "entry-2", FIXTURE_HEAD_UUID, "b-entry-4", "b-entry-5",
      ]);
      const baseLines = readFileSync(a.basePath, "utf-8")
        .trim().split("\n").map((l) => JSON.parse(l));
      expect(baseLines.every((l) => l.sessionId === a.baseSessionId)).toBe(true);
      // The spliced entries went through the import rewrite context, so B's
      // project path never lands in A's transcript.
      expect(baseLines[3].cwd).toBe(a.projectA);
      expect(readFileSync(a.basePath, "utf-8")).not.toContain(a.projectB);
      expect(readFileSync(a.basePath, "utf-8")).not.toContain("[sesh-mover continuation]");

      // Session 2: the local branch, with the FULL shared history in front of
      // it — a resumable conversation, not a fragment.
      const preservedPath = join(a.projectDirA, `${preservedId}.jsonl`);
      expect(existsSync(preservedPath)).toBe(true);
      expect(uuidsOf(preservedPath)).toEqual([
        "entry-1", "entry-2", FIXTURE_HEAD_UUID, "a-local-1", "a-local-2",
      ]);
      const preservedLines = readFileSync(preservedPath, "utf-8")
        .trim().split("\n").map((l) => JSON.parse(l));
      expect(preservedLines.every((l) => l.sessionId === preservedId)).toBe(true);

      expect(jsonlFiles(a.projectDirA)).toHaveLength(before.length + 1);
      expect(p.appended).toHaveLength(1);
      expect(p.appended![0].baseSessionId).toBe(a.baseSessionId);
      expect(p.appended![0].entriesAppended).toBe(2);
      expect(p.localSessionId).toBe(a.baseSessionId);

      // Registered, so `claude --resume` can find it, and labelled.
      const history = readFileSync(join(a.configDirA, "history.jsonl"), "utf-8")
        .trim().split("\n").map((l) => JSON.parse(l));
      const preservedHistory = history.find((h) => h.sessionId === preservedId);
      expect(preservedHistory).toBeDefined();
      expect(preservedHistory.display).toContain("local divergence");
      expect(preservedHistory.project).toBe(a.projectA);

      // Stated consequence: no thread mapping for the preserved session.
      const state = readSyncState(a.projectA);
      expect(state.hub?.threadByLocalSession?.[preservedId]).toBeUndefined();
      expect(p.warnings.join(" ")).toContain(preservedId);
      expect(p.warnings.join(" ")).toContain("own thread");

      // The hub is credited with the adopted head, so a push back does not
      // re-ship the branch we just took from it.
      const hubPeer = Object.entries(state.peers).find(([id]) => id.startsWith("hub:"));
      expect(hubPeer?.[1].sent[a.baseSessionId]?.headEntryUuid).toBe("b-entry-5");

      // Nothing left to pull, and the index sees the adopted base.
      const second = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", claudeVersion: "2.1.81",
      });
      expect(second.success).toBe(false);
      expect(jsonlFiles(a.projectDirA)).toHaveLength(before.length + 1);
    } finally {
      a.cleanup();
    }
  });

  it("--on-divergence skip leaves everything untouched", async () => {
    const a = await arrangeDivergence();
    try {
      const before = jsonlFiles(a.projectDirA);
      const baseBefore = readFileSync(a.basePath, "utf-8");

      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "skip", claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      expect(p.divergence?.resolution).toBe("skip");
      expect(p.divergence?.adoptAvailable).toBe(true);
      expect(jsonlFiles(a.projectDirA)).toEqual(before); // no new file
      expect(readFileSync(a.basePath, "utf-8")).toBe(baseBefore);
      expect(p.importedSessions).toHaveLength(0);
      expect(p.appended ?? []).toHaveLength(0);
      expect(p.warnings.join(" ")).toContain("nothing changed");
      // Nothing was recorded as received, so the decision can be revisited.
      const again = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", claudeVersion: "2.1.81",
      });
      expect(again.success).toBe(true);
      if (!again.success) return;
      expect((again as HubPullResult).divergence?.resolution).toBe("adopt-hub");
    } finally {
      a.cleanup();
    }
  });

  /**
   * A base that does NOT contain the continuation's anchor: A's copy was
   * compacted below it (or the thread mapping points at an unrelated session).
   * There is no shared point to splice or cut at, so adopt-hub is impossible
   * and every message about the fork has to say so rather than quoting entry
   * counts measured from an anchor that isn't there.
   */
  async function arrangeAnchorAbsent(): Promise<ContinuationArrangement> {
    const a = await arrangeContinuation();
    try {
      const kept = readFileSync(a.basePath, "utf-8").trim().split("\n").slice(0, 2);
      writeFileSync(a.basePath, kept.join("\n") + "\n", "utf-8");
      appendEntries(a.basePath, localEntries("entry-2", a.baseSessionId, a.projectA));
      ageOutOfLiveWindow(a.basePath);
      return a;
    } catch (e) {
      a.cleanup();
      throw e;
    }
  }

  it("adoptAvailable is false when the anchor is absent from the local base", async () => {
    const a = await arrangeAnchorAbsent();
    try {
      const before = jsonlFiles(a.projectDirA);
      const baseBefore = readFileSync(a.basePath, "utf-8");

      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      expect(p.divergence?.adoptAvailable).toBe(false);
      expect(p.divergence?.resolution).toBe("fragment"); // refused, fell through
      expect(p.divergence?.localEntriesSinceAnchor).toBe(0);
      expect(p.warnings.join(" ")).toContain("not present in the local session");
      expect(readFileSync(a.basePath, "utf-8")).toBe(baseBefore);
      expect(jsonlFiles(a.projectDirA)).toHaveLength(before.length + 1);
      expect(p.appended ?? []).toHaveLength(0);
    } finally {
      a.cleanup();
    }
  });

  // Regression: "your session S continues <anchor> with 0 entries the hub
  // hasn't seen" is false when S doesn't contain <anchor> at all — and since
  // /sesh-mover:pull always sends skip, that was the DEFAULT text for a stale
  // or unrelated thread mapping.
  it("never quotes entry counts from an anchor the local session doesn't contain", async () => {
    const a = await arrangeAnchorAbsent();
    try {
      const skip = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "skip", claudeVersion: "2.1.81",
      });
      expect(skip.success).toBe(true);
      if (!skip.success) return;
      const skipWarnings = (skip as HubPullResult).warnings.join(" ");
      expect((skip as HubPullResult).divergence?.adoptAvailable).toBe(false);
      expect(skipWarnings).toContain("does not contain");
      expect(skipWarnings).not.toContain("0 entries");
      // ...and adopt-hub is not offered as a way out, because it isn't one.
      expect(skipWarnings).not.toContain("adopt-hub");

      const fragment = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "fragment", claudeVersion: "2.1.81",
      });
      expect(fragment.success).toBe(true);
      if (!fragment.success) return;
      const fragmentWarnings = (fragment as HubPullResult).warnings.join(" ");
      expect(fragmentWarnings).toContain("does not contain");
      expect(fragmentWarnings).toContain("adopt-hub cannot help here");
      expect(fragmentWarnings).not.toContain("0 entries");
    } finally {
      a.cleanup();
    }
  });

  it("the skip message quotes both sides of a real fork", async () => {
    const a = await arrangeDivergence();
    try {
      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "skip", claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const w = (result as HubPullResult).warnings.join(" ");
      expect(w).toContain("2 entries the hub hasn't seen");
      expect(w).toContain("2 entries of its own");
      expect(w).toContain("adopt-hub");
    } finally {
      a.cleanup();
    }
  });

  /**
   * Loads a private copy of pull.ts whose `adoptHubBranch` always reports the
   * restore-and-give-up outcome. Sanctioned targeted fake: adoptHubBranch's
   * OWN byte-for-byte restore is covered for real in hub-append.test.ts; what
   * cannot be arranged from the outside is the orchestrator's reaction to it,
   * because the preserved session id is minted inside the pull.
   */
  async function loadPullWithFailingAdopt(): Promise<
    typeof import("../src/hub/pull.js").hubPull
  > {
    vi.resetModules();
    vi.doMock("../src/hub/append.js", async () => {
      const actual = await vi.importActual<typeof import("../src/hub/append.js")>(
        "../src/hub/append.js"
      );
      return {
        ...actual,
        adoptHubBranch: async () => ({ kind: "failed", detail: "injected adopt failure" }),
      };
    });
    const mod = await import("../src/hub/pull.js");
    return mod.hubPull;
  }

  it("a failed adoption leaves no preserved session and no history entry behind", async () => {
    const a = await arrangeDivergence();
    let pullWithFailingAdopt: Awaited<ReturnType<typeof loadPullWithFailingAdopt>>;
    try {
      pullWithFailingAdopt = await loadPullWithFailingAdopt();
      const before = jsonlFiles(a.projectDirA);
      const baseBefore = readFileSync(a.basePath, "utf-8");
      const historyPath = join(a.configDirA, "history.jsonl");
      const historyBefore = existsSync(historyPath) ? readFileSync(historyPath, "utf-8") : "";

      const result = await pullWithFailingAdopt({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      // Reported as the fragment it fell back to, not as an adoption.
      expect(p.divergence?.resolution).toBe("fragment");
      expect(p.divergence?.preservedSessionId).toBeUndefined();
      expect(p.appended ?? []).toHaveLength(0);
      expect(p.warnings.join(" ")).toContain("left unchanged");
      expect(p.warnings.join(" ")).toContain("injected adopt failure");

      // The local branch is exactly where it was...
      expect(readFileSync(a.basePath, "utf-8")).toBe(baseBefore);
      // ...the hub's branch arrived as a plain fragment, and nothing else...
      const after = jsonlFiles(a.projectDirA);
      expect(after).toHaveLength(before.length + 1);
      const fragment = after.find((f) => !before.includes(f))!;
      expect(uuidsOf(join(a.projectDirA, fragment)).slice(1)).toEqual([
        "b-entry-4", "b-entry-5",
      ]);
      // ...and no preserved session was ever registered.
      const history = readFileSync(historyPath, "utf-8");
      expect(history.startsWith(historyBefore)).toBe(true);
      expect(history).not.toContain("local divergence");
    } finally {
      vi.doUnmock("../src/hub/append.js");
      vi.resetModules();
      a.cleanup();
    }
  });

  // Adoption truncates, so it needs at least the consent the (less
  // destructive) plain append demands. The chain guard fires first, so a
  // diverged base reaches the adopt path with no liveness scrutiny at all —
  // and the likeliest invocation is a pull run from inside the very session
  // being adopted over.
  it("refuses to adopt a live-looking base without --force-append", async () => {
    const a = await arrangeDivergence();
    try {
      const before = jsonlFiles(a.projectDirA);
      const baseBefore = readFileSync(a.basePath, "utf-8");
      makeLookLive(a.basePath);

      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      // Refusing must not also foreclose: SKIP semantics, not fragment.
      // Recording a fragment here would put the bundle in
      // peers[...].received, and the re-run this very warning asks for would
      // report "already up to date" — terminal, recoverable only by hand.
      expect(p.divergence?.resolution).toBe("skip");
      expect(p.divergence?.preservedSessionId).toBeUndefined();
      expect(p.appended ?? []).toHaveLength(0);
      // ...the local transcript is untouched, not truncated...
      expect(readFileSync(a.basePath, "utf-8")).toBe(baseBefore);
      expect(uuidsOf(a.basePath)).toEqual([
        "entry-1", "entry-2", FIXTURE_HEAD_UUID, "a-local-1", "a-local-2",
      ]);
      // ...nothing landed at all...
      expect(jsonlFiles(a.projectDirA)).toEqual(before);
      expect(p.importedSessions).toHaveLength(0);
      // ...and the refusal names the age and the way through.
      const w = p.warnings.join(" ");
      expect(w).toContain("adopt-hub refused");
      expect(w).toMatch(/modified \d+s ago/);
      expect(w).toContain("--force-append");
      expect(w).toContain("nothing was recorded");
      // The skill needs the age to phrase the question, and it is in the payload.
      expect(Date.now() - new Date(p.divergence!.localLastActiveAt).getTime()).toBeLessThan(
        5 * 60 * 1000
      );

      // The round trip the warning promises: the user exits Claude Code and
      // re-runs with consent. THIS is what the skip semantics buy — with a
      // fragment recorded, this second pull would return
      // "Already up to date with the source machine."
      const forced = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", forceAppend: true, claudeVersion: "2.1.81",
      });
      expect(forced.success).toBe(true);
      if (!forced.success) return;
      const f = forced as HubPullResult;
      expect(f.divergence?.resolution).toBe("adopt-hub");
      expect(f.divergence?.preservedSessionId).toBeTruthy();
      expect(uuidsOf(a.basePath)).toEqual([
        "entry-1", "entry-2", FIXTURE_HEAD_UUID, "b-entry-4", "b-entry-5",
      ]);
      expect(uuidsOf(join(a.projectDirA, `${f.divergence!.preservedSessionId}.jsonl`))).toEqual([
        "entry-1", "entry-2", FIXTURE_HEAD_UUID, "a-local-1", "a-local-2",
      ]);
    } finally {
      a.cleanup();
    }
  });

  // The same door, from the other side: a refusal must also leave `fragment`
  // reachable, since that is the other branch the warning offers.
  it("a refused adoption can still be resolved as a fragment afterwards", async () => {
    const a = await arrangeDivergence();
    try {
      const before = jsonlFiles(a.projectDirA);
      makeLookLive(a.basePath);
      const refused = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", claudeVersion: "2.1.81",
      });
      expect(refused.success).toBe(true);
      if (!refused.success) return;
      expect((refused as HubPullResult).divergence?.resolution).toBe("skip");

      const kept = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "fragment", claudeVersion: "2.1.81",
      });
      expect(kept.success).toBe(true);
      if (!kept.success) return;
      const k = kept as HubPullResult;
      expect(k.divergence?.resolution).toBe("fragment");
      expect(k.importedSessions).toHaveLength(1);
      expect(jsonlFiles(a.projectDirA)).toHaveLength(before.length + 1);
    } finally {
      a.cleanup();
    }
  });

  it("--force-append adopts a live-looking base and restates the consequence", async () => {
    const a = await arrangeDivergence();
    try {
      makeLookLive(a.basePath);
      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", forceAppend: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      expect(p.divergence?.resolution).toBe("adopt-hub");
      expect(p.divergence?.preservedSessionId).toBeTruthy();
      expect(uuidsOf(a.basePath)).toEqual([
        "entry-1", "entry-2", FIXTURE_HEAD_UUID, "b-entry-4", "b-entry-5",
      ]);
      expect(uuidsOf(join(a.projectDirA, `${p.divergence!.preservedSessionId}.jsonl`))).toEqual([
        "entry-1", "entry-2", FIXTURE_HEAD_UUID, "a-local-1", "a-local-2",
      ]);
      const w = p.warnings.join(" ");
      expect(w).toContain("--force-append was passed");
      expect(w).toContain("exit it now");
    } finally {
      a.cleanup();
    }
  });
});

// --- Workspace 3-way merge (ancestor tracking) ----------------------------

/** Nine well-separated lines; `edits` replaces individual 1-based lines. */
function wsLines(edits: Record<number, string> = {}): string {
  return Array.from({ length: 9 }, (_, i) => edits[i + 1] ?? `L${i + 1}`).join("\n") + "\n";
}

/**
 * One entry per call, so repeated pushes from A never reuse a uuid.
 *
 * Timestamps are derived arithmetically rather than interpolated into a date
 * string: the obvious `2026-04-1${n}` form silently stops being a date at
 * n = 10 ("2026-04-110T…"), and since `resolveThreads` compares `lastActiveAt`
 * LEXICALLY, that made A's copy sort BEFORE B's from the tenth push in the
 * file onward — i.e. which machine counted as "latest" depended on how many
 * earlier tests had run. Every entry here is strictly newer than the last, and
 * every one is well before `B_FORK_AT`.
 */
const A_ENTRY_EPOCH = Date.parse("2026-04-11T10:00:00Z");
/** A local fork on B, deliberately more recent than anything A pushes. */
const B_FORK_AT = "2026-05-01T10:00:00Z";
let aWsEntrySeq = 0;
function aWorkspaceEntry(
  parentUuid: string,
  sessionId: string,
  projectPath: string
): Array<Record<string, unknown>> {
  const n = ++aWsEntrySeq;
  return [
    {
      uuid: `a-ws-${n}`, parentUuid,
      timestamp: new Date(A_ENTRY_EPOCH + n * 60_000).toISOString(),
      sessionId, cwd: projectPath, version: "2.1.81", type: "user",
      message: { role: "user", content: `more work on A (${n})` },
    },
  ];
}

interface WorkspacePair {
  hub: string;
  configDirA: string;
  projectA: string;
  /** A's session file for the thread. */
  aJsonl: string;
  configDirB: string;
  projectB: string;
  /** B's local session file for the thread (absent until B has pulled). */
  bJsonl: string;
  projectId: string;
  useA(): void;
  useB(): void;
  /** One new entry on A's session, then a push carrying a fresh snapshot. */
  pushFromA(): Promise<{ bundleId: string }>;
  /** Pull on B (HOME switches to B for the call and stays there). */
  pullOnB(over?: Partial<HubPullOptions>): Promise<Awaited<ReturnType<typeof hubPull>>>;
  cleanup(): void;
}

/**
 * Two machines sharing one non-git project through the hub, with workspace
 * payloads switched ON (the whole point here — `arrangeContinuation` pushes
 * with `noWorkspace`).
 *
 *   A: real project dir with README.md + shared.txt, hubInit, push #1
 *   B: linked to the same hub project, and — unless `bootstrapB` is false —
 *      pulled once, which unpacks snapshot #1 into an otherwise empty dir and
 *      records it as B's ancestor generation.
 *
 * HOME is left pointing at B, because every test's act is a pull on B.
 */
async function arrangeWorkspacePair(
  opts: { bootstrapB?: boolean } = {}
): Promise<WorkspacePair> {
  const bootstrapB = opts.bootstrapB !== false;
  const homeA = mkdtempSync(join(tmpdir(), "sesh-ws-homeA-"));
  const homeB = mkdtempSync(join(tmpdir(), "sesh-ws-homeB-"));
  const hub = mkdtempSync(join(tmpdir(), "sesh-ws-hub-"));
  const base = mkdtempSync(join(tmpdir(), "sesh-ws-fix-"));
  let projectB: string | undefined;
  let restore = overrideHome(homeA);
  const cleanup = (): void => {
    restore.restore();
    for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
    if (projectB) rmSync(projectB, { recursive: true, force: true });
  };

  try {
    const { configDir: configDirA } = createFixtureTree(base);
    const projectA = createRealProject(base, configDirA, "projA-ws");
    writeFileSync(join(projectA, "shared.txt"), wsLines());
    const aJsonl = join(
      configDirA, "projects", encodeProjectPath(projectA), `${FIXTURE_SESSION_ID}.jsonl`
    );
    await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
    const push1 = await hubPush({
      configDir: configDirA, projectPath: projectA, hubPath: hub,
      createProject: true, claudeVersion: "2.1.81",
    });
    if (!push1.success) throw new Error(`arrange: A's push failed: ${JSON.stringify(push1)}`);
    if (!push1.hasWorkspace) throw new Error("arrange: A's push carried no workspace payload");
    // Pushing a workspace is one of the two ways a machine learns its ancestor.
    if (!readSyncState(projectA).hub?.lastWorkspace) {
      throw new Error("arrange: A's push recorded no workspace generation");
    }

    const useA = (): void => { restore.restore(); restore = overrideHome(homeA); };
    const useB = (): void => { restore.restore(); restore = overrideHome(homeB); };

    const pushFromA = async (): Promise<{ bundleId: string }> => {
      const anchor = readLastEntryUuid(aJsonl);
      if (!anchor) throw new Error("arrange: A's session has no head entry");
      appendEntries(aJsonl, aWorkspaceEntry(anchor, FIXTURE_SESSION_ID, projectA));
      const push = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub, claudeVersion: "2.1.81",
      });
      if (!push.success) throw new Error(`arrange: A's push failed: ${JSON.stringify(push)}`);
      if (!push.bundleId) throw new Error("arrange: A's push produced no bundle");
      if (!push.hasWorkspace) throw new Error("arrange: A's push carried no workspace payload");
      return { bundleId: push.bundleId };
    };

    useB();
    const configDirB = join(homeB, ".claude");
    projectB = mkdtempSync(join(tmpdir(), "sesh-ws-projB-"));
    writeLocalProjectId(projectB, {
      projectId: push1.projectId, name: "projA-ws",
      createdAt: new Date().toISOString(), createdByMachine: "machine-a",
    });
    const bProjectPath = projectB;

    let bSessionId: string | null = null;
    const pullOnB = async (
      over: Partial<HubPullOptions> = {}
    ): Promise<Awaited<ReturnType<typeof hubPull>>> => {
      useB();
      // State the base's age explicitly rather than leaning on append.ts's
      // self-write exemption (milestone rule: that exemption is a sub-ms clock
      // coincidence, never a fixture). B's session was last written by an
      // earlier pull in this same test, i.e. seconds ago.
      if (bSessionId) {
        const p = join(configDirB, "projects", encodeProjectPath(bProjectPath), `${bSessionId}.jsonl`);
        if (existsSync(p)) ageOutOfLiveWindow(p);
      }
      const result = await hubPull({
        configDir: configDirB, projectPath: bProjectPath, hubPath: hub,
        latest: true, claudeVersion: "2.1.81", ...over,
      });
      if (result.success && "localSessionId" in result && result.localSessionId) {
        bSessionId = result.localSessionId;
      }
      return result;
    };

    if (bootstrapB) {
      const pullB = await pullOnB();
      if (!pullB.success) throw new Error(`arrange: B's pull failed: ${JSON.stringify(pullB)}`);
      const p = pullB as HubPullResult;
      if (p.workspaceUnpacked === null) throw new Error("arrange: B's bootstrap unpacked no workspace");
      // Applying a payload is the other way a machine learns its ancestor —
      // without this, every later pull would fall back to no-ancestor mode.
      if (!readSyncState(bProjectPath).hub?.lastWorkspace) {
        throw new Error("arrange: B's bootstrap recorded no workspace generation");
      }
    }

    return {
      hub, configDirA, projectA, aJsonl, configDirB, projectB, projectId: push1.projectId,
      get bJsonl(): string {
        return join(
          configDirB, "projects", encodeProjectPath(bProjectPath), `${bSessionId ?? "none"}.jsonl`
        );
      },
      useA, useB, pushFromA, pullOnB, cleanup,
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * Rewrite one field of a bundle's manifest as it sits on the hub.
 *
 * The hub is a plain directory, so anything in it is peer-supplied data a
 * hostile or merely broken machine could have written. Round-tripping the
 * archive is how a test gets to say something the pushing code would never say
 * — which is the only way to pin what the PULLING code does with it.
 */
async function patchBundleManifest(
  hubPath: string,
  projectId: string,
  bundleId: string,
  mutate: (manifest: Record<string, unknown>) => void
): Promise<void> {
  await mutateBundleTree(hubPath, projectId, bundleId, (dir) => {
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    mutate(manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  });
}

/** Round-trip a bundle archive on the hub, letting a test rewrite its tree. */
async function mutateBundleTree(
  hubPath: string,
  projectId: string,
  bundleId: string,
  mutate: (bundleDir: string) => void
): Promise<void> {
  const backend = createFsBackend(hubPath);
  const { indexes } = await readAllIndexes(backend, projectId);
  let file: string | null = null;
  for (const idx of indexes) {
    for (const thread of Object.values(idx.threads)) {
      for (const r of thread.bundles) if (r.bundleId === bundleId) file = r.file;
    }
  }
  if (!file) throw new Error(`patchBundleManifest: no hub record for bundle ${bundleId}`);

  const work = mkdtempSync(join(tmpdir(), "sesh-ws-patch-"));
  try {
    const tar = join(work, "in.tar.gz");
    writeFileSync(tar, await backend.read(file));
    const dir = join(work, "bundle");
    mkdirSync(dir, { recursive: true });
    await extractArchive(tar, dir);
    mutate(dir);
    const out = join(work, "out.tar.gz");
    await createArchive(dir, out, "gzip");
    await backend.writeAtomic(file, readFileSync(out));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("hub pull — workspace 3-way merge", () => {
  it("merges a workspace payload 3-way against the last synced generation", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      writeFileSync(join(w.projectA, "a-only.txt"), "new on A\n");
      const push2 = await w.pushFromA();

      w.useB();
      writeFileSync(join(w.projectB, "shared.txt"), wsLines({ 8: "B-EDIT" }));
      writeFileSync(join(w.projectB, "b-only.txt"), "mine\n");

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      expect(p.workspaceMerge).toBeDefined();
      const m = p.workspaceMerge!;
      expect(m.merged).toContain("shared.txt");
      expect(m.conflicted).toEqual([]);
      expect(m.created).toContain("a-only.txt");
      expect(m.sidecars).toEqual([]);
      expect(m.skipped).toEqual([]);

      // Both machines' edits survive, with no conflict markers anywhere.
      const merged = readFileSync(join(w.projectB, "shared.txt"), "utf-8");
      expect(merged).toContain("A-EDIT");
      expect(merged).toContain("B-EDIT");
      expect(merged).not.toContain("<<<<<<<");
      // ...and neither machine's unrelated file was touched.
      expect(readFileSync(join(w.projectB, "b-only.txt"), "utf-8")).toBe("mine\n");
      expect(readFileSync(join(w.projectB, "a-only.txt"), "utf-8")).toBe("new on A\n");

      // The ancestor advanced to the generation just applied.
      expect(readSyncState(w.projectB).hub?.lastWorkspace?.bundleId).toBe(push2.bundleId);
    } finally {
      w.cleanup();
    }
  });

  it("writes conflict markers, never a silent overwrite, when both machines edit the same line", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 5: "A-EDIT" }));
      await w.pushFromA();

      w.useB();
      writeFileSync(join(w.projectB, "shared.txt"), wsLines({ 5: "B-EDIT" }));

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge!.conflicted).toEqual(["shared.txt"]);
      const text = readFileSync(join(w.projectB, "shared.txt"), "utf-8");
      expect(text).toContain("<<<<<<< local");
      expect(text).toContain("||||||| ancestor");
      expect(text).toContain(">>>>>>> incoming");
      expect(text).toContain("B-EDIT");
      expect(text).toContain("A-EDIT");
      expect(p.warnings.join(" ")).toContain("shared.txt");
      expect(p.warnings.join(" ")).toContain("conflict");
      // Exactly one file, so the sentence has to agree with itself. n = 1 is the
      // commonest case a user ever sees these warnings in.
      expect(p.warnings.join(" ")).toContain("1 workspace file was merged with conflict markers");
    } finally {
      w.cleanup();
    }
  });

  it("does not resurrect a file this machine deleted, and says so", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useB();
      rmSync(join(w.projectB, "README.md"));

      w.useA();
      // README.md is untouched on A and still in its snapshot.
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge!.localDeleted).toEqual(["README.md"]);
      expect(p.workspaceMerge!.created).toEqual([]);
      expect(existsSync(join(w.projectB, "README.md"))).toBe(false);
      const warned = p.warnings.join(" ");
      expect(warned).toContain("README.md");
      // The withholding is permanent as far as ordinary pulls go (the shared
      // generation advances past it every time), and this row cannot actually
      // prove a deletion happened — a file an earlier sync could not write
      // looks identical from here. So the sentence must not assert one, and it
      // must name the remedy for the case where it is wrong.
      expect(warned).not.toMatch(/you deleted here/);
      expect(warned).toContain("Nothing will offer it again");
      expect(warned).toContain("--force-workspace");
      // `--force-workspace` stopped being inert once a generation is on record,
      // so recommending it here recommends an UNPACK over this directory — it
      // can destroy local edits this very merge was preserving (measured). The
      // sentence must lead with the non-destructive route and must not describe
      // the flag as a merge.
      expect(warned).toContain("--target-path <fresh-dir>");
      expect(warned).toContain("OVERWRITING");
      expect(warned).not.toMatch(/--force-workspace to merge/);
      // The other machine's edit still arrived.
      expect(readFileSync(join(w.projectB, "shared.txt"), "utf-8")).toContain("A-EDIT");
    } finally {
      w.cleanup();
    }
  });

  it("restores a locally-deleted file the other machine changed, and says why", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useB();
      rmSync(join(w.projectB, "README.md"));

      w.useA();
      writeFileSync(join(w.projectA, "README.md"), "changed on A\n");
      await w.pushFromA();

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge!.restored).toEqual(["README.md"]);
      expect(p.workspaceMerge!.localDeleted).toEqual([]);
      expect(readFileSync(join(w.projectB, "README.md"), "utf-8")).toBe("changed on A\n");
      expect(p.warnings.join(" ")).toContain("README.md");
    } finally {
      w.cleanup();
    }
  });

  it("never deletes a file the other machine removed, and reports it", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      rmSync(join(w.projectA, "README.md"));
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge!.upstreamDeleted).toEqual(["README.md"]);
      expect(existsSync(join(w.projectB, "README.md"))).toBe(true);
      expect(p.warnings.join(" ")).toContain("deleted on the other machine");
    } finally {
      w.cleanup();
    }
  });

  it("falls back to no-ancestor behavior when no generation was recorded", async () => {
    const w = await arrangeWorkspacePair({ bootstrapB: false });
    try {
      // The peer pushes a SECOND workspace payload before this machine ever
      // joins, so the payload it receives declares a base (gen-1) instead of
      // null. That distinction is the whole test: with a single push the
      // payload declares nothing and any ancestor rule at all reaches this
      // branch, so a one-push fixture cannot tell a working gate from a broken
      // one — and the version of this file that had one hid a machine merging
      // against a tree it had never held, writing conflict markers into an
      // unrelated local README and withholding the peer's own files forever.
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();

      w.useB();
      // A pre-existing, non-empty tree on a machine that has never synced this
      // project's workspace: NO generation is shared with the payload, whatever
      // the payload says it descends from, so a 3-way merge is impossible.
      writeFileSync(join(w.projectB, "local-work.txt"), "mine\n");
      writeFileSync(join(w.projectB, "README.md"), "B's OWN readme — precious\n");

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      expect(p.workspaceMerge).toBeUndefined();
      expect(p.workspaceUnpacked).toBeNull();
      expect(p.importedSessions).toHaveLength(1); // sessions still land
      const warned = p.warnings.join(" ");
      expect(warned).toContain("--force-workspace");
      expect(warned.toLowerCase()).toContain("overwrit"); // §5.4: force now NAMES its semantics
      expect(warned).toContain("--target-path");
      // Nothing was applied, so nothing may be recorded as this machine's
      // ancestor — otherwise the next pull would read the whole payload as
      // "deleted here" and withhold it forever.
      expect(readSyncState(w.projectB).hub?.lastWorkspace).toBeUndefined();
      expect(readSyncState(w.projectB).hub?.workspaceGenerations).toBeUndefined();
      expect(existsSync(join(w.projectB, "shared.txt"))).toBe(false);
      expect(readFileSync(join(w.projectB, "local-work.txt"), "utf-8")).toBe("mine\n");
      // Not one byte of this machine's own tree was touched — in particular no
      // conflict markers in a file that merely shares a name with the peer's.
      expect(readFileSync(join(w.projectB, "README.md"), "utf-8")).toBe("B's OWN readme — precious\n");
    } finally {
      w.cleanup();
    }
  });

  it("refuses an explicit --target-path at a non-empty dir even when the payload declares a base", async () => {
    // The loud branch of the same gate, and the one a peer's `basedOn` used to
    // bypass: the payload names a generation this machine has never held, so
    // "we have an ancestor" must stay false and the ErrorResult must stand.
    const w = await arrangeWorkspacePair({ bootstrapB: false });
    const occupied = mkdtempSync(join(tmpdir(), "sesh-ws-occupied-"));
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();

      w.useB();
      writeFileSync(join(occupied, "unrelated.txt"), "someone else's project\n");
      writeFileSync(join(occupied, "README.md"), "UNRELATED readme\n");

      const pull = await w.pullOnB({ targetPath: occupied });
      expect(pull.success).toBe(false);
      if (pull.success) return;
      expect((pull as { error: string }).error).toContain("is not empty");
      expect((pull as { suggestion?: string }).suggestion).toContain("--force-workspace");
      expect(existsSync(join(occupied, "shared.txt"))).toBe(false);
      expect(readFileSync(join(occupied, "README.md"), "utf-8")).toBe("UNRELATED readme\n");
    } finally {
      rmSync(occupied, { recursive: true, force: true });
      w.cleanup();
    }
  });

  it("--force-workspace overrides the merge and unpacks over the tree, so it never goes inert", async () => {
    // Once a generation is on record every payload merges, which would leave
    // --force-workspace unreachable forever — and with it the only way to ask
    // for the hub's copy wholesale, which is also the only remedy named for a
    // file the merge withheld.
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();

      w.useB();
      writeFileSync(join(w.projectB, "shared.txt"), wsLines({ 8: "B-EDIT" }));
      writeFileSync(join(w.projectB, "b-only.txt"), "mine\n");

      const pull = await w.pullOnB({ forceWorkspace: true });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge).toBeUndefined();
      expect(p.workspaceUnpacked).not.toBeNull();
      // Overwritten, not combined — and said so, naming the flag rather than
      // claiming there was nothing to merge against.
      expect(readFileSync(join(w.projectB, "shared.txt"), "utf-8")).toBe(wsLines({ 2: "A-EDIT" }));
      // A file only this machine has is still not deleted by an unpack.
      expect(readFileSync(join(w.projectB, "b-only.txt"), "utf-8")).toBe("mine\n");
      expect(p.warnings.join(" ")).toContain("--force-workspace was passed");
      // The generation still advances, so the next pull merges normally.
      expect(readSyncState(w.projectB).hub?.workspaceGenerations).toHaveLength(2);
    } finally {
      w.cleanup();
    }
  });

  it("bootstrapping an empty tree unpacks (never merges) and records the generation", async () => {
    // Covered indirectly by every arrangement, but pinned here: an empty
    // target must NOT go through the merge, where every file would read as a
    // local deletion and nothing would be written at all.
    const w = await arrangeWorkspacePair({ bootstrapB: false });
    try {
      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge).toBeUndefined();
      expect(p.workspaceUnpacked).not.toBeNull();
      expect(readFileSync(join(w.projectB, "shared.txt"), "utf-8")).toBe(wsLines());
      expect(readSyncState(w.projectB).hub?.lastWorkspace).toBeDefined();
    } finally {
      w.cleanup();
    }
  });

  it("an emptied project directory bootstraps again instead of reading as a whole-tree deletion", async () => {
    // sync-state lives in the home dir, not the project, so a recorded
    // ancestor outlives `rm -rf project/*` — the obvious way to ask for a
    // clean copy from the hub. Merging there would classify EVERY file as
    // deleted-here-and-unchanged-upstream and write nothing at all.
    const w = await arrangeWorkspacePair();
    try {
      w.useB();
      for (const name of readdirSync(w.projectB)) {
        if (name !== ".claude-sesh-mover") rmSync(join(w.projectB, name), { recursive: true, force: true });
      }
      expect(readSyncState(w.projectB).hub?.lastWorkspace).toBeDefined();

      w.useA();
      await w.pushFromA();

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge).toBeUndefined();
      expect(p.workspaceUnpacked).not.toBeNull();
      expect(readFileSync(join(w.projectB, "shared.txt"), "utf-8")).toBe(wsLines());
      expect(readFileSync(join(w.projectB, "README.md"), "utf-8")).toBe("hello\n");
    } finally {
      w.cleanup();
    }
  });

  it("merges what it can without git, parking the rest, instead of skipping the payload", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      writeFileSync(join(w.projectA, "a-only.txt"), "new on A\n");
      await w.pushFromA();

      w.useB();
      writeFileSync(join(w.projectB, "shared.txt"), wsLines({ 8: "B-EDIT" }));

      const emptyPathDir = mkdtempSync(join(tmpdir(), "sesh-ws-nopath-"));
      const pathOverride = overridePath(emptyPathDir);
      let pull;
      try {
        pull = await w.pullOnB();
      } finally {
        pathOverride.restore();
        rmSync(emptyPathDir, { recursive: true, force: true });
      }
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      const m = p.workspaceMerge!;
      expect(m.gitUnavailable).toBe(true);
      // The rows that need no merge engine are still resolved correctly...
      expect(m.created).toContain("a-only.txt");
      expect(readFileSync(join(w.projectB, "a-only.txt"), "utf-8")).toBe("new on A\n");
      // ...and the one that does is parked beside the local file, not lost.
      expect(m.sidecars.map((s) => s.path)).toEqual(["shared.txt"]);
      expect(m.sidecars[0]!.reason).toBe("git-unavailable");
      expect(readFileSync(join(w.projectB, "shared.txt"), "utf-8")).toBe(wsLines({ 8: "B-EDIT" }));
      const parked = readFileSync(join(w.projectB, m.sidecars[0]!.sidecar), "utf-8");
      expect(parked).toBe(wsLines({ 2: "A-EDIT" }));
      expect(p.warnings.join(" ")).toContain("git");
    } finally {
      w.cleanup();
    }
  });

  it("an ancestor bundle that is gone from the hub degrades to no-ancestor mode, never a crash", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();

      w.useB();
      // Prune the generation B recorded as its ancestor (hub housekeeping,
      // a half-synced folder, a peer that re-initialised the hub).
      const ref = readSyncState(w.projectB).hub?.lastWorkspace;
      expect(ref).toBeDefined();
      await createFsBackend(w.hub).delete(ref!.file);
      writeFileSync(join(w.projectB, "shared.txt"), wsLines({ 8: "B-EDIT" }));

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge).toBeUndefined();
      expect(p.workspaceUnpacked).toBeNull();
      // Local work is untouched and the payload is still on the hub.
      expect(readFileSync(join(w.projectB, "shared.txt"), "utf-8")).toBe(wsLines({ 8: "B-EDIT" }));
      expect(p.warnings.join(" ")).toContain("--force-workspace");
    } finally {
      w.cleanup();
    }
  });

  it("an unreadable ancestor archive degrades to no-ancestor mode, never a failed pull", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();

      w.useB();
      // Half-written / truncated / not-a-tar: the hub is a synced folder, so
      // a file that exists but does not gunzip is an ordinary state to be in.
      const ref = readSyncState(w.projectB).hub?.lastWorkspace;
      await createFsBackend(w.hub).writeAtomic(ref!.file, Buffer.from("not a tarball at all"));
      writeFileSync(join(w.projectB, "shared.txt"), wsLines({ 8: "B-EDIT" }));

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge).toBeUndefined();
      expect(p.workspaceUnpacked).toBeNull();
      expect(p.importedSessions.length + (p.appended?.length ?? 0)).toBeGreaterThan(0);
      expect(readFileSync(join(w.projectB, "shared.txt"), "utf-8")).toBe(wsLines({ 8: "B-EDIT" }));
      expect(p.warnings.join(" ")).toContain("could not be read back");
    } finally {
      w.cleanup();
    }
  });

  it("a poisoned generation pointer is refused by the hub path guard and the merge falls back to an OLDER generation", async () => {
    const w = await arrangeWorkspacePair();
    try {
      // Build a second generation on B, so its history is [gen-2, gen-1] and
      // there is somewhere older to fall back TO.
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A2" }));
      await w.pushFromA();
      const merged1 = await w.pullOnB();
      expect(merged1.success).toBe(true);
      expect(readSyncState(w.projectB).hub?.workspaceGenerations).toHaveLength(2);

      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A2", 4: "A4" }));
      await w.pushFromA();

      w.useB();
      // sync-state is an ordinary JSON file in the user's home; a traversing
      // path in it must not become a read outside the hub directory. The
      // bundleId is left intact so the poisoned entry is still the CHOSEN
      // ancestor — the guard is genuinely exercised rather than skipped over.
      const poisoned = readSyncState(w.projectB);
      poisoned.hub!.lastWorkspace!.file = "../../../../etc/passwd";
      poisoned.hub!.workspaceGenerations![0]!.file = "../../../../etc/passwd";
      writeSyncState(poisoned);
      writeFileSync(join(w.projectB, "shared.txt"), wsLines({ 2: "A2", 8: "B-EDIT" }));

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      // Refused at the hub-path chokepoint, named in a warning, and the pull
      // recovers by dropping to the next-OLDER generation of our own — never by
      // following the path, never by climbing back up to a newer one (which is
      // the direction that silently overwrites work), and never silently.
      const warned = p.warnings.join(" ");
      expect(warned).toContain("not a safe hub-relative path");
      expect(warned).toContain("older workspace generation");
      expect(p.workspaceMerge!.merged).toContain("shared.txt");
      const text = readFileSync(join(w.projectB, "shared.txt"), "utf-8");
      expect(text).toContain("A4");      // the other machine's new edit arrived
      expect(text).toContain("B-EDIT");  // and this machine's survived
      expect(text).not.toContain("<<<<<<<");
    } finally {
      w.cleanup();
    }
  });

  it("applies the NEWEST workspace generation in the chain, not the oldest", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "GEN-2" }));
      await w.pushFromA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "GEN-3" }));
      const push3 = await w.pushFromA();

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      // Both bundles are pulled; the tree ends up at the LATEST generation,
      // and that is what gets recorded as the ancestor.
      expect(readFileSync(join(w.projectB, "shared.txt"), "utf-8")).toBe(wsLines({ 2: "GEN-3" }));
      expect(readSyncState(w.projectB).hub?.lastWorkspace?.bundleId).toBe(push3.bundleId);
      expect(p.workspaceMerge!.taken).toContain("shared.txt");
    } finally {
      w.cleanup();
    }
  });

  it("never reverts local work to a peer's older snapshot when both machines pushed without pulling", async () => {
    // The shape auto-push makes routine: each machine pushes at session end,
    // neither pulls first. B's payload is based on the generation BEFORE A's
    // own last push, so A's recorded generation is NOT common to both trees —
    // merging against it makes every file of A's look untouched and hands the
    // whole tree back to B's older copy.
    const w = await arrangeWorkspacePair();
    try {
      // B (already holding gen-1) edits a file A does not touch, and pushes.
      // A session entry rides along because a workspace-only change produces
      // no bundle at all — push returns "up to date" and uploads nothing.
      w.useB();
      writeFileSync(join(w.projectB, "b-note.txt"), "B's note\n");
      appendEntries(w.bJsonl, [{
        uuid: "b-ws-1", parentUuid: FIXTURE_HEAD_UUID, timestamp: B_FORK_AT,
        sessionId: FIXTURE_SESSION_ID, cwd: w.projectB, version: "2.1.81", type: "user",
        message: { role: "user", content: "work on B" },
      }]);
      const bPush = await hubPush({
        configDir: w.configDirB, projectPath: w.projectB, hubPath: w.hub,
        claudeVersion: "2.1.81",
      });
      expect(bPush.success).toBe(true);
      if (!bPush.success) return;
      expect(bPush.hasWorkspace).toBe(true);

      // A, which never saw B's push, edits shared.txt and pushes gen-3.
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();
      ageOutOfLiveWindow(w.aJsonl);

      // Now A pulls B's copy. A's own generation (gen-3) is newer than the one
      // B's payload descends from, so the older, genuinely common one has to
      // win.
      const pullA = await hubPull({
        configDir: w.configDirA, projectPath: w.projectA, hubPath: w.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pullA.success).toBe(true);
      if (!pullA.success) return;
      const p = pullA as HubPullResult;

      // A's edit survives, and B's new file still arrives.
      expect(readFileSync(join(w.projectA, "shared.txt"), "utf-8")).toBe(wsLines({ 2: "A-EDIT" }));
      expect(p.workspaceMerge!.kept).toContain("shared.txt");
      expect(existsSync(join(w.projectA, "b-note.txt"))).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  it("a forged basedOn.file never becomes a path: the puller resolves the generation through its OWN record", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      const push2 = await w.pushFromA();
      // Everything but the id is decoration on the receiving side. Prove it by
      // planting a traversal where a lazier implementation would have fetched:
      // the id still resolves (it names a generation B genuinely holds), so the
      // merge must run — and must run against B's own pointer, never this one.
      await patchBundleManifest(w.hub, w.projectId, push2.bundleId, (m) => {
        const ws = m.workspace as { basedOn: { file: string; pushedAt: string } };
        ws.basedOn.file = "../../../../../../etc/passwd";
        ws.basedOn.pushedAt = "1970-01-01T00:00:00.000Z";
      });

      w.useB();
      writeFileSync(join(w.projectB, "shared.txt"), wsLines({ 8: "B-EDIT" }));

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.warnings.join(" ")).not.toContain("not a safe hub-relative path");
      expect(p.workspaceMerge!.merged).toContain("shared.txt");
      const text = readFileSync(join(w.projectB, "shared.txt"), "utf-8");
      expect(text).toContain("A-EDIT");
      expect(text).toContain("B-EDIT");
    } finally {
      w.cleanup();
    }
  });

  it("a forged basedOn.bundleId naming a generation we never held merges nothing at all", async () => {
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      const push2 = await w.pushFromA();
      // A peer cannot nominate a merge base of its choosing: an id this machine
      // has never held proves nothing about what the two trees share, so the
      // payload has to degrade to the loud no-ancestor branch rather than being
      // merged against a stranger.
      await patchBundleManifest(w.hub, w.projectId, push2.bundleId, (m) => {
        (m.workspace as { basedOn: { bundleId: string } }).basedOn.bundleId =
          "11111111-2222-3333-4444-555555555555";
      });

      w.useB();
      writeFileSync(join(w.projectB, "shared.txt"), wsLines({ 8: "B-EDIT" }));
      const before = readSyncState(w.projectB).hub!.lastWorkspace!.bundleId;

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge).toBeUndefined();
      expect(p.workspaceUnpacked).toBeNull();
      expect(readFileSync(join(w.projectB, "shared.txt"), "utf-8")).toBe(wsLines({ 8: "B-EDIT" }));
      expect(p.warnings.join(" ")).toContain("--force-workspace");
      // Nothing applied, so the recorded generation must not move.
      expect(readSyncState(w.projectB).hub!.lastWorkspace!.bundleId).toBe(before);
    } finally {
      w.cleanup();
    }
  });

  it("no timestamp decides the merge base: hostile pushedAt stamps change nothing", async () => {
    // `pushedAt` is the PUSHING machine's wall clock — the hub stamps nothing —
    // so ordering two machines' generations by it is meaningless. Ordering by
    // it anyway reinstates the silent revert exactly: with a one-hour skew on
    // the peer, this same arrangement reported `taken` and threw A's edit away.
    // Here every stamp in sight is inverted (ours the oldest possible, theirs
    // the newest) and the outcome must be identical to the honest-clock run.
    const w = await arrangeWorkspacePair();
    try {
      // Divergence: B pushes from gen-1 while A, also at gen-1, pushes its own.
      w.useB();
      writeFileSync(join(w.projectB, "b-note.txt"), "B's note\n");
      appendEntries(w.bJsonl, [{
        uuid: "b-ws-skew-1", parentUuid: FIXTURE_HEAD_UUID, timestamp: B_FORK_AT,
        sessionId: FIXTURE_SESSION_ID, cwd: w.projectB, version: "2.1.81", type: "user",
        message: { role: "user", content: "work on B" },
      }]);
      const bPush = await hubPush({
        configDir: w.configDirB, projectPath: w.projectB, hubPath: w.hub, claudeVersion: "2.1.81",
      });
      expect(bPush.success).toBe(true);
      if (!bPush.success || !bPush.bundleId) return;

      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();
      ageOutOfLiveWindow(w.aJsonl);

      // Now make every clock lie in the direction that used to flip the choice:
      // A's OWN newest generation stamped as the oldest thing on the hub, and
      // the genuinely-common older one — the correct answer — stamped as the
      // newest. Any rule that orders candidates by these stamps picks A's own
      // and reverts A's edit; the set-membership rule cannot see them at all.
      const skewed = readSyncState(w.projectA);
      skewed.hub!.lastWorkspace!.pushedAt = "1970-01-01T00:00:00.000Z";
      skewed.hub!.workspaceGenerations![0]!.pushedAt = "1970-01-01T00:00:00.000Z";
      const common = skewed.hub!.workspaceGenerations![1]!;
      common.pushedAt = "2099-12-31T23:59:59.999Z";
      writeSyncState(skewed);
      await patchBundleManifest(w.hub, w.projectId, bPush.bundleId, (m) => {
        (m.workspace as { basedOn: { pushedAt: string } }).basedOn.pushedAt =
          "2099-12-31T23:59:59.999Z";
      });

      const pullA = await hubPull({
        configDir: w.configDirA, projectPath: w.projectA, hubPath: w.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pullA.success).toBe(true);
      if (!pullA.success) return;
      const p = pullA as HubPullResult;
      expect(p.workspaceMerge!.kept).toContain("shared.txt");
      expect(p.workspaceMerge!.taken).not.toContain("shared.txt");
      expect(readFileSync(join(w.projectA, "shared.txt"), "utf-8")).toBe(wsLines({ 2: "A-EDIT" }));
      expect(existsSync(join(w.projectA, "b-note.txt"))).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  it("a peer that pushed twice since our last sync still merges, via the chain's older base", async () => {
    // The routine shape under auto-push: the payload we apply declares a base
    // we never held (the peer's own previous generation), while the EARLIER
    // bundle in the same chain declares one we do. Without walking the chain
    // this degrades to a skip on every repeat pull.
    const w = await arrangeWorkspacePair();
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "GEN-2" }));
      await w.pushFromA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "GEN-2", 4: "GEN-3" }));
      await w.pushFromA();

      w.useB();
      writeFileSync(join(w.projectB, "b-only.txt"), "mine\n");

      const pull = await w.pullOnB();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.workspaceMerge).toBeDefined();
      expect(p.workspaceMerge!.taken).toContain("shared.txt");
      expect(readFileSync(join(w.projectB, "shared.txt"), "utf-8"))
        .toBe(wsLines({ 2: "GEN-2", 4: "GEN-3" }));
      expect(readFileSync(join(w.projectB, "b-only.txt"), "utf-8")).toBe("mine\n");
      // No file of the peer's was withheld as a phantom local deletion.
      expect(p.workspaceMerge!.localDeleted).toEqual([]);
    } finally {
      w.cleanup();
    }
  });

  it("a divergence skip alongside a workspace merge stays re-runnable", async () => {
    const w = await arrangeWorkspacePair();
    try {
      // Fork the session on B, so A's next continuation cannot chain onto it.
      // B's branch is the MORE RECENT copy — the realistic shape (you fork by
      // carrying on working here), and the one where republishing B's index
      // would make B the thread's latest copy and refuse the very re-run the
      // skip warning promises.
      w.useB();
      appendEntries(w.bJsonl, [{
        uuid: "b-local-1", parentUuid: FIXTURE_HEAD_UUID, timestamp: B_FORK_AT,
        sessionId: FIXTURE_SESSION_ID, cwd: w.projectB, version: "2.1.81", type: "user",
        message: { role: "user", content: "meanwhile, on B" },
      }]);
      writeFileSync(join(w.projectB, "shared.txt"), wsLines({ 8: "B-EDIT" }));

      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();

      const skipped = await w.pullOnB({ onDivergence: "skip" });
      expect(skipped.success).toBe(true);
      if (!skipped.success) return;
      const s = skipped as HubPullResult;
      expect(s.divergence?.resolution).toBe("skip");
      // The workspace half of the pull still happened...
      expect(s.workspaceMerge!.merged).toContain("shared.txt");

      // ...and the session half stays decidable. A workspace application
      // changes no session, so it must not publish this machine's index and
      // make the promised re-run impossible.
      const rerun = await w.pullOnB({ onDivergence: "fragment" });
      expect(rerun.success).toBe(true);
      if (!rerun.success) return;
      const r = rerun as HubPullResult;
      expect(r.divergence?.resolution).toBe("fragment");
      expect(r.importedSessions).toHaveLength(1);
    } finally {
      w.cleanup();
    }
  });

  it("a project whose workspace snapshot carries no files still pulls, sessions and all", async () => {
    // The empty-project shape (`mkdir scratch && cd scratch && claude`), and
    // the same thing an over-broad hubignore produces. push declares
    // `manifest.workspace` for it — fileCount 0 is a legitimate snapshot, not a
    // skipped one — so the puller runs its apply step, and before
    // snapshotWorkspace created the payload directory unconditionally there was
    // no `workspace/` in the bundle to apply: ENOENT out of hubPull, no
    // sessions imported, nothing recorded, so every retry crashed the same way.
    const homeA = mkdtempSync(join(tmpdir(), "sesh-ws0-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-ws0-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-ws0-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-ws0-fix-"));
    const projectA = mkdtempSync(join(tmpdir(), "sesh-ws0-projA-"));
    const projectB = mkdtempSync(join(tmpdir(), "sesh-ws0-projB-"));
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      // Deliberately NOT createRealProject: that plants a README.md, and an
      // empty project directory is the whole point here.
      cpSync(
        join(configDirA, "projects", FIXTURE_ENCODED),
        join(configDirA, "projects", encodeProjectPath(projectA)),
        { recursive: true }
      );
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      const push = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(push.success).toBe(true);
      if (!push.success) return;
      // The precondition this test rests on: a payload IS declared.
      expect(push.hasWorkspace).toBe(true);

      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      writeLocalProjectId(projectB, {
        projectId: push.projectId, name: "projA",
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
      expect(p.workspaceUnpacked).toEqual({ path: projectB, fileCount: 0 });
      // An applied generation, even an empty one, is what lets the NEXT payload
      // merge instead of hitting the no-ancestor skip.
      expect(readSyncState(projectB).hub?.lastWorkspace).toBeTruthy();
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base, projectA, projectB]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("a bundle that declares a workspace payload it does not contain warns instead of failing the pull", async () => {
    // Defence in depth for the bundles already on hubs: every sesh-mover before
    // this guard wrote exactly this bundle whenever a snapshot carried no
    // files, and a hand-made or truncated one can say it too. The transcripts
    // are the point of a pull — the working tree is the optional half — so a
    // payload that isn't there must degrade to a warning, never take the
    // sessions down with it.
    const homeA = mkdtempSync(join(tmpdir(), "sesh-wsx-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-wsx-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-wsx-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-wsx-fix-"));
    const projectB = mkdtempSync(join(tmpdir(), "sesh-wsx-projB-"));
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA-wsx");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      const push = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(push.success).toBe(true);
      if (!push.success || !push.bundleId) return;
      expect(push.hasWorkspace).toBe(true);
      // Strip the payload the manifest keeps declaring.
      await mutateBundleTree(hub, push.projectId, push.bundleId, (dir) => {
        rmSync(join(dir, "workspace"), { recursive: true, force: true });
      });

      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      writeLocalProjectId(projectB, {
        projectId: push.projectId, name: "projA-wsx",
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
      expect(p.workspaceUnpacked).toBeNull();
      expect(p.warnings.join(" ")).toMatch(/does not contain/i);
      // Nothing was applied, so nothing may be recorded as applied: a
      // generation this tree never held would make the next merge read the
      // whole payload as "deleted here" (the Task 8 rule).
      expect(readSyncState(projectB).hub?.lastWorkspace).toBeUndefined();
      expect(readdirSync(projectB).sort()).toEqual([".claude-sesh-mover"]);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base, projectB]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});
