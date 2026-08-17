import { describe, it, expect, vi } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, cpSync, readFileSync, readdirSync,
  appendFileSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { overrideHome, overridePath } from "./helpers/env.js";
import { readTextLf } from "./helpers/eol.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import {
  hubPull, selectNeededBundles, selectThreadBase, describeUnfetchable, type HubPullOptions,
} from "../src/hub/pull.js";
import { flushThreadMapping } from "../src/hub/pull-record.js";
import { hubWhereis } from "../src/hub/whereis.js";
import { createFsBackend } from "../src/hub/backend.js";
import { readAllIndexes, writeMachineIndex } from "../src/hub/index-file.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { machinePath } from "../src/hub/layout.js";
import { acquireProjectLock } from "../src/hub/lock.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { idx, entry, bundle } from "./helpers/hub-fixtures.js";
import { createArchive, extractArchive } from "../src/archiver.js";
import { importSession } from "../src/importer.js";
import { computeIntegrityHashFromFile, computeSessionsDigest } from "../src/manifest.js";
import { readSyncState, writeSyncState, getThreadId, syncStatePath } from "../src/sync-state.js";
import { readLastEntryUuid } from "../src/jsonl.js";
import { encodeProjectPath } from "../src/platform.js";
import type {
  ErrorResult, ExportManifest, HubPullListResult, HubPullResult, NotYetSyncedResult, ProgressEvent,
} from "../src/types.js";
import { isPluginStateName } from "../src/paths.js";

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";
const FIXTURE_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
/** Uuid of the fixture session's last entry — every continuation's anchor. */
const FIXTURE_HEAD_UUID = "entry-3";

// Same technique hub-push.test.ts uses (see its own comment): identity
// linking writes .sesh-mover-project.json under the real project
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

/**
 * The mid-chain durability step, at its own level.
 *
 * The end-to-end case is "a mid-chain abort maps the thread for the bundles it
 * DID apply" below. What is asserted HERE is the half that end-to-end coverage
 * cannot reach: the rule that it may never map a bundle this pull did not apply.
 * `runRecordStage` asks about `needed[needed.length - 1]` when nothing was
 * applied — a deliberate choice for the end of a pull, and the wrong one from
 * inside the loop, where it would credit a bundle nobody opened. Nothing else in
 * the suite fails when that gate is removed (measured), so it is pinned here.
 */
describe("flushThreadMapping (the mid-chain durability step)", () => {
  const bundle0 = { machineId: "m-a", record: rec({ bundleId: "b0", sessionIdInBundle: "s0" }) };
  const bundle1 = { machineId: "m-a", record: rec({ bundleId: "b1", sessionIdInBundle: "s1" }) };

  function arrange(label: string): { projectPath: string; cleanup: () => void } {
    const home = mkdtempSync(join(tmpdir(), `${label}-home-`));
    const restore = overrideHome(home);
    return {
      projectPath: join(home, "proj"),
      cleanup: () => {
        restore.restore();
        rmSync(home, { recursive: true, force: true });
      },
    };
  }

  /** A receipt for `s1`, i.e. for the bundle a `needed.length - 1` fallback asks about. */
  function plantReceipt(projectPath: string): void {
    const st = readSyncState(projectPath);
    st.peers["m-a"] = {
      name: "A", lastSentAt: null, lastReceivedAt: null, sent: {},
      received: { s1: { localSessionId: "local-1", type: "full", importedAt: "2026-08-01T00:00:00Z" } },
    };
    writeSyncState(st);
  }

  it("writes nothing when the pull applied no bundle, even though the plan's last bundle has a receipt", () => {
    const a = arrange("sesh-flush-none");
    try {
      plantReceipt(a.projectPath);
      expect(
        flushThreadMapping({
          effectiveProjectPath: a.projectPath, hubId: "hub-1", threadId: "t-1",
          needed: [bundle0, bundle1],
          apply: { lastAppliedIndex: -1, lastBundleManifest: null, threadLandedSessionId: null },
        })
      ).toBe(false);
      expect(readSyncState(a.projectPath).hub?.threadByLocalSession ?? {}).toEqual({});
    } finally {
      a.cleanup();
    }
  });

  it("maps the session an applied bundle landed in, and the second call writes nothing", () => {
    const a = arrange("sesh-flush-once");
    try {
      const args = {
        effectiveProjectPath: a.projectPath, hubId: "hub-1", threadId: "t-1",
        needed: [bundle0, bundle1],
        apply: { lastAppliedIndex: 0, lastBundleManifest: null, threadLandedSessionId: "local-0" },
      };
      expect(flushThreadMapping(args)).toBe(true);
      expect(getThreadId(readSyncState(a.projectPath), "local-0")).toBe("t-1");
      // Called once per bundle of the chain: the mapping is already what it
      // would write, so it must not touch the state file again.
      const before = readFileSync(syncStatePath(a.projectPath), "utf-8");
      expect(flushThreadMapping(args)).toBe(false);
      expect(readFileSync(syncStatePath(a.projectPath), "utf-8")).toBe(before);
    } finally {
      a.cleanup();
    }
  });

  it("falls back to the applied bundle's own receipt when nothing landed in this pull", () => {
    // The skipped-as-duplicate shape: `importSession` recorded the receipt and
    // imported nothing, so `threadLandedSessionId` is null while the content is
    // demonstrably here. `lastAppliedIndex` names the bundle that was handled,
    // and the receipt is read from THAT bundle's own machine.
    const a = arrange("sesh-flush-receipt");
    try {
      plantReceipt(a.projectPath);
      expect(
        flushThreadMapping({
          effectiveProjectPath: a.projectPath, hubId: "hub-1", threadId: "t-1",
          needed: [bundle0, bundle1],
          apply: { lastAppliedIndex: 1, lastBundleManifest: null, threadLandedSessionId: null },
        })
      ).toBe(true);
      expect(getThreadId(readSyncState(a.projectPath), "local-1")).toBe("t-1");
    } finally {
      a.cleanup();
    }
  });
});

describe("describeUnfetchable (pure)", () => {
  // Machine names come from the hostname, so a VM clone or two default installs
  // give two machine ids one name — and this sentence names a machine three
  // times in three roles, which with bare names reads "mbp holds bundles that
  // mbp does not list … the one machine it resolves to (mbp)".
  it("carries the machine id when two machines share a name", () => {
    const text = describeUnfetchable(
      "t1",
      [{ machineId: "id-beta", machineName: "mbp", bundleIds: ["b1", "b2"] }],
      { machineId: "id-alpha", machineName: "mbp" }
    );
    expect(text).toContain("mbp [id-beta] (2 bundles)");
    expect(text).toContain("mbp [id-alpha] does not list");
    expect(text).toContain("resolves to (mbp [id-alpha])");
  });

  it("leaves distinct names bare", () => {
    const text = describeUnfetchable(
      "t1",
      [{ machineId: "id-beta", machineName: "beta-desktop", bundleIds: ["b1"] }],
      { machineId: "id-alpha", machineName: "alpha-laptop" }
    );
    expect(text).toContain("beta-desktop (1 bundle)");
    expect(text).toContain("alpha-laptop does not list");
    expect(text).not.toContain("[id-");
  });

  it("falls back to the id when a machine has no name at all", () => {
    const text = describeUnfetchable(
      "t1",
      [{ machineId: "id-beta", machineName: null, bundleIds: ["b1"] }],
      { machineId: "id-alpha", machineName: null }
    );
    expect(text).toContain("id-beta (1 bundle)");
    expect(text).toContain("id-alpha does not list");
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
    // the bundle on the hub. It is written to .sesh-mover/ instead.
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
      // The saved payload directory, plus the identity file pull plants — the
      // latter is a ROOT DOTFILE since 0.7.0, not a member of the directory.
      expect(readdirSync(projectB).sort()).toEqual([".sesh-mover", ".sesh-mover-project.json"]);
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
      // README.md is TRACKED and `git apply` wrote it, so the receiving
      // checkout's EOL convention decides its line endings (see helpers/eol.ts);
      // scratch.txt is UNTRACKED and the carry code copied its bytes, so that
      // one stays byte-exact and would catch a text-mode transform in the copy.
      expect(readTextLf(join(projectB, "README.md"))).toBe("uncommitted\n");
      expect(readFileSync(join(projectB, "scratch.txt"), "utf-8")).toBe("wip\n");
      // Applied, therefore not also parked: no saved copy is written when the
      // payload reached the tree.
      // Nothing was parked, and since 0.7.0 the identity file lives at the
      // project root, so the plugin directory is not created at all.
      expect(existsSync(join(projectB, ".sesh-mover"))).toBe(false);
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
    // rewritten to carry a patch that writes `.sesh-mover./config.json`
    // — the trailing-dot spelling the sender's own pathspec floor cannot
    // express — plus a planted `.sesh-mover-include`, i.e. the file deciding what THIS
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
        const hostile = ".sesh-mover./config.json";
        writeFileSync(
          join(dir, "carry", "changes.patch"),
          `diff --git a/${hostile} b/${hostile}\nnew file mode 100644\nindex 0000000..d95f3ad\n` +
            `--- /dev/null\n+++ b/${hostile}\n@@ -0,0 +1 @@\n+{"hub":{"path":"/tmp/attacker"}}\n`
        );
        mkdirSync(join(dir, "carry", "untracked", ".sesh-mover"), { recursive: true });
        writeFileSync(join(dir, "carry", "untracked", ".sesh-mover-include"), "*\n");
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
      expect(existsSync(join(projectB, ".sesh-mover.")))
        .toBe(false);
      expect(existsSync(join(projectB, ".sesh-mover-include"))).toBe(false);
      expect(existsSync(join(projectB, ".sesh-mover", "config.json"))).toBe(false);
      // Only the plugin's own linking artifact and the saved payload are there.
      expect(readdirSync(join(projectB, ".sesh-mover")).sort().join(",")).toMatch(
        /^carry-[^,]+$/
      );
      expect(existsSync(join(projectB, ".sesh-mover-project.json"))).toBe(true);
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
      // .sesh-mover under it first and the "project path does not
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

      const plantedIdPath = join(targetPath, ".sesh-mover-project.json");
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
    // `.sesh-mover-include` — the list deciding what THIS machine's
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
        mkdirSync(join(ws, ".sesh-mover"), { recursive: true });
        mkdirSync(join(ws, ".git"), { recursive: true });
        writeFileSync(join(ws, ".sesh-mover-include"), "*\n");
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
      // `.sesh-mover` exists — pull plants its OWN project.json there —
      // but nothing of the payload's is inside it.
      expect(existsSync(join(targetPath, ".sesh-mover-project.json"))).toBe(true);
      expect(existsSync(join(targetPath, ".sesh-mover-include"))).toBe(false);
      expect(
        p.warnings.some((w) => w.includes("refused") && w.includes(".sesh-mover"))
      ).toBe(true);
      // A RESULT FIELD, not just prose: this is the strongest signal the
      // command produces, and the milestone's cross-layer rule is that a skill
      // discriminator keys on fields, never on warning text.
      expect(p.workspaceRefused?.slice().sort())
        .toEqual([".git", ".sesh-mover", ".sesh-mover-include"]);
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
      // at minimum non-empty from its own .sesh-mover-project.json).
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
      // The other branch that leaves both workspace fields empty is "the
      // manifest declared a payload the bundle does not hold" — this is not it,
      // and only the typed field tells the two apart.
      expect(p.workspaceDeclaredMissing).toBeUndefined();
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

  /**
   * The two tests above, fused into ONE fixture, because the fusion is the
   * claim: `--force-workspace` is advertised as a *re-run* remedy, and a remedy
   * is only real if the refusal it follows left the pull re-runnable. The
   * workspace refusal aborts before the record stage, so no bundle is marked
   * received and the identical second invocation still finds the same payload
   * on the hub. Two separate tests, each with its own fresh hub, cannot observe
   * that — they would pass just as happily if the first pull had consumed the
   * chain.
   */
  it("refuses a non-empty --target-path, and --force-workspace overrides it", async () => {
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
      targetPath = mkdtempSync(join(tmpdir(), "sesh-pull-retry-"));
      writeFileSync(join(targetPath, "README.md"), "stale\n"); // collides with the pushed workspace file
      writeFileSync(join(targetPath, "keep.txt"), "untouched\n");

      const opts: HubPullOptions = {
        configDir: configDirB, projectPath: identityAnchorB, hubPath: hub,
        targetPath, latest: true,
        projectIdOverride: pushResult.projectId,
        claudeVersion: "2.1.81",
      };

      // 1) The user named this destination explicitly and it is non-empty:
      //    refuse loudly rather than silently skipping the unpack.
      const refused = await hubPull(opts);
      expect(refused.success).toBe(false);
      if (refused.success) return;
      expect((refused as { suggestion?: string }).suggestion).toContain("--force-workspace");
      // The refusal is terminal AND clean: no session import, no project dir,
      // and not one byte written into the destination.
      expect(existsSync(join(configDirB, "projects", encodeProjectPath(targetPath)))).toBe(false);
      expect(readFileSync(join(targetPath, "README.md"), "utf-8")).toBe("stale\n");
      expect(readFileSync(join(targetPath, "keep.txt"), "utf-8")).toBe("untouched\n");

      // 2) THE SAME invocation plus the flag the refusal advised. It must reach
      //    the very same payload — if the refused run had recorded the bundle,
      //    this would come back with nothing to apply.
      const forced = await hubPull({ ...opts, forceWorkspace: true });
      expect(forced.success).toBe(true);
      if (!forced.success) return;
      const p = forced as HubPullResult;
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
      // --project-id plants .sesh-mover-project.json into it before
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
      expect(existsSync(join(projectB, ".sesh-mover-project.json"))).toBe(true);
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

/** Two further entries again, for a THIRD continuation on top of the second. */
const evenMoreEntries: EntryMaker = (parentUuid, sessionId, projectPath) => [
  {
    uuid: "b-entry-8", parentUuid, timestamp: "2026-04-13T09:00:00Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "user",
    message: { role: "user", content: "one last thing" },
  },
  {
    uuid: "b-entry-9", parentUuid: "b-entry-8", timestamp: "2026-04-13T09:00:05Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "assistant",
    message: { model: "claude-opus-4-6", id: "msg_cont3", content: [{ type: "text", text: "Finished." }] },
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
  pushMoreFromB(makeEntries: EntryMaker, push?: { noCarry?: boolean }): Promise<void>;
  cleanup(): void;
}

/** Options for `arrangeContinuation`. */
interface ArrangeOptions {
  /**
   * Make B's project a git repository with a remote and one uncommitted file,
   * so every push from B captures a git-diff carry payload (design §6.1). Off
   * by default: a carry costs a `git diff` per push and every other test in
   * this file is about sessions.
   */
  gitB?: boolean;
  /** Push B's FIRST continuation with --no-carry, so a later one owns the payload. */
  noCarryFirst?: boolean;
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
  makeEntries: EntryMaker = plainEntries,
  arrangeOpts: ArrangeOptions = {}
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
    if (arrangeOpts.gitB) {
      const { execFileSync } = await import("node:child_process");
      const g = (args: string[]): void => {
        execFileSync("git", args, { cwd: bProjectPath, stdio: "ignore" });
      };
      writeFileSync(join(bProjectPath, "tracked.txt"), "committed\n");
      g(["init", "-q"]);
      g(["config", "user.email", "t@example.com"]);
      g(["config", "user.name", "Test"]);
      g(["remote", "add", "origin", "https://github.com/User/Repo.git"]);
      g(["add", "tracked.txt"]);
      g(["commit", "-q", "-m", "init"]);
      // One untracked file and one modification: the payload the carry gate is
      // about, and the thing a suppressed carry silently loses.
      writeFileSync(join(bProjectPath, "wip.txt"), "work in progress on B\n");
      writeFileSync(join(bProjectPath, "tracked.txt"), "committed, then edited\n");
    }
    const pushFromB = async (make: EntryMaker, push?: { noCarry?: boolean }): Promise<void> => {
      const anchor = readLastEntryUuid(bJsonl);
      if (!anchor) throw new Error("arrange: B's session has no head entry");
      appendEntries(bJsonl, make(anchor, localB, bProjectPath));
      const pushed = await hubPush({
        configDir: configDirB, projectPath: bProjectPath, hubPath: hub,
        noWorkspace: true, noCarry: push?.noCarry, claudeVersion: "2.1.81",
      });
      if (!pushed.success) throw new Error(`arrange: B's push failed: ${JSON.stringify(pushed)}`);
      if (pushed.pushedSessions[0]?.type !== "continuation") {
        throw new Error("arrange: B pushed a full bundle, not a continuation");
      }
    };

    await pushFromB(makeEntries, { noCarry: arrangeOpts.noCarryFirst });

    restore.restore();
    restore = overrideHome(homeA);

    const projectDirA = join(configDirA, "projects", encodeProjectPath(projectA));
    const basePath = join(projectDirA, `${FIXTURE_SESSION_ID}.jsonl`);
    ageOutOfLiveWindow(basePath);

    return {
      hub, configDirA, projectA, projectDirA, projectB, configDirB, bSessionId: localB,
      projectId: pushA.projectId, baseSessionId: FIXTURE_SESSION_ID, basePath, cleanup,
      async pushMoreFromB(make: EntryMaker, push?: { noCarry?: boolean }): Promise<void> {
        restore.restore();
        restore = overrideHome(homeB);
        try {
          await pushFromB(make, push);
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
 * Re-point one continuation bundle at a different anchor entry, repairing both
 * halves of the bundle so it is indistinguishable from a genuine push: the
 * manifest's `integrityHash` (the pull refuses to splice a delta whose content
 * doesn't match it) and the index record's `fromEntryUuid`.
 *
 * WHY A FIXTURE HAS TO DO THIS. The shape under test is a chain whose bundles
 * belong to DIFFERENT branches of one thread — bundle 0 continues the branch
 * this machine holds, bundle 1 continues an older one — so bundle 0 splices and
 * bundle 1 forks. It is the ordinary product of `--on-divergence fragment`,
 * which is the DEFAULT: a machine pulling a diverged thread without the skill
 * layer mints a second local session `setThreadId`-mapped to the same thread,
 * and push.ts's index projection then emits two bundle records under one thread
 * entry. Default-on auto-push makes it routine. Arranging that end to end takes
 * five machine-role switches and four pushes, and every natural ordering of
 * them puts the FORKING bundle first (push order is index order), which is the
 * `i === 0` case that already works. Re-anchoring is the same state, minted
 * directly, and it keeps the numbers the reviewer measured pinnable.
 */
async function reanchorBundleEntry(
  hubPath: string,
  projectId: string,
  entryUuid: string,
  newParentUuid: string
): Promise<void> {
  const backend = createFsBackend(hubPath);
  const { indexes } = await readAllIndexes(backend, projectId);
  const stage = mkdtempSync(join(tmpdir(), "sesh-app-reanchor-"));
  try {
    for (const index of indexes) {
      for (const thread of Object.values(index.threads)) {
        for (const record of thread.bundles) {
          if (record.type !== "continuation") continue;
          const dir = join(stage, record.bundleId);
          mkdirSync(dir, { recursive: true });
          const tarPath = join(stage, `${record.bundleId}.tar.gz`);
          writeFileSync(tarPath, await backend.read(record.file));
          await extractArchive(tarPath, dir);

          const deltaPath = join(dir, "sessions", `${record.sessionIdInBundle}.jsonl`);
          if (!existsSync(deltaPath)) continue;
          const lines = readFileSync(deltaPath, "utf-8").split("\n").filter((l) => l !== "");
          const at = lines.findIndex((l) => (JSON.parse(l) as { uuid?: string }).uuid === entryUuid);
          if (at === -1) continue;

          const obj = JSON.parse(lines[at]) as Record<string, unknown>;
          obj.parentUuid = newParentUuid;
          lines[at] = JSON.stringify(obj);
          writeFileSync(deltaPath, lines.join("\n") + "\n", "utf-8");

          const manifestPath = join(dir, "manifest.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as ExportManifest;
          const session = manifest.sessions.find((s) => s.sessionId === record.sessionIdInBundle);
          if (!session) throw new Error("reanchor: bundle manifest lists no such session");
          session.integrityHash = await computeIntegrityHashFromFile(deltaPath);
          if (session.continuation) session.continuation.fromEntryUuid = newParentUuid;
          // This helper mints a legitimate-looking fork by rewriting the session
          // list, so it has to restamp the bundle-level digest too — otherwise
          // every arrangement built on it is a DAMAGED bundle and the pull
          // refuses it before the divergence logic under test is ever reached.
          // Exactly the failure mode the digest exists to catch, which is why
          // the fixture is the thing that changes here and not the check.
          manifest.sessionsDigest = computeSessionsDigest(manifest.sessions);
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

          const outPath = join(stage, `${record.bundleId}-out.tar.gz`);
          await createArchive(dir, outPath, "gzip");
          await backend.writeAtomic(record.file, readFileSync(outPath));

          record.fromEntryUuid = newParentUuid;
          await writeMachineIndex(backend, index);
          return;
        }
      }
    }
    throw new Error(`reanchor: no continuation bundle on the hub carries entry ${entryUuid}`);
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
      // The decline names the AGE and both candidate writers, and no longer
      // asserts "possible live session" as a diagnosis. Measured with no Claude
      // Code running anywhere: an earlier sesh-mover pull's own import stamps
      // the base's mtime, and 28s later this guard blamed a live session that
      // demonstrably did not exist. The self-write exemption only covers writes
      // from the SAME operation, so that writer lands here routinely.
      expect(p.warnings.join(" ")).toContain("live Claude Code session");
      expect(p.warnings.join(" ")).toContain("an earlier sesh-mover pull");
      expect(p.warnings.join(" ")).not.toContain("possible live session");
      expect(p.warnings.join(" ")).toContain("Nothing local was touched");
      expect(p.warnings.join(" ")).toContain("close the Claude Code session");
      // `--force-append` is named again, but SCOPED to a later pull of the
      // thread — the whole-branch round removed it entirely, and the reviewer
      // then measured that it does work on the next pull (splice succeeded, one
      // transcript). Foreclosed-for-this-bundle and useless-forever are
      // different claims; only the first one is true.
      expect(p.warnings.join(" ")).toContain("--force-append on the next pull of this thread");
      expect(p.warnings.join(" ")).toMatch(/no re-run applies it/);
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

  /**
   * THE EIGHTH FORECLOSURE, and the second to survive the guard built for the
   * class. The single-bundle round trip above passed while this failed.
   *
   * With TWO pending bundles the refusal protected only its own: the loop went
   * on to the next one, whose anchor is the head the refused bundle would have
   * installed — so it can never chain onto the local session either. It reached
   * the divergence branch with `adoptAvailable: false`, was fragment-imported
   * and RECORDED. `appliedNothing` flipped, the index was republished, and
   * `divergence.resolution` (one field for the whole pull) was overwritten
   * "skip" -> "fragment". The user picked adopt-hub, silently got a third
   * transcript, and the warning's own instruction then answered "Nothing to
   * pull" / "the latest copy of this thread is already local".
   *
   * The fix is that a divergence stops the whole THREAD, not one bundle: a chain
   * is not a set of independent items, so "applied and recorded nothing" is only
   * keepable at that granularity.
   */
  it("a refused adoption stops the whole chain, so a two-bundle re-run still adopts", async () => {
    const a = await arrangeDivergence();
    try {
      // A second continuation from B, on top of the first: the chain the
      // single-bundle fixture above cannot produce.
      await a.pushMoreFromB(moreEntries);
      const before = jsonlFiles(a.projectDirA);
      const baseBefore = readFileSync(a.basePath, "utf-8");
      makeLookLive(a.basePath);

      const refused = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", claudeVersion: "2.1.81",
      });
      expect(refused.success).toBe(true);
      if (!refused.success) return;
      const r = refused as HubPullResult;

      // The user's answer survives: still a skip, never silently rewritten to
      // the fragment the SECOND bundle would have produced.
      expect(r.divergence?.resolution).toBe("skip");
      expect(r.importedSessions).toHaveLength(0);
      expect(r.appended ?? []).toHaveLength(0);
      // No third transcript, and the local branch is byte-identical.
      expect(jsonlFiles(a.projectDirA)).toEqual(before);
      expect(readFileSync(a.basePath, "utf-8")).toBe(baseBefore);
      // ...and the rest of the chain is named as deliberately left behind,
      // rather than silently consumed.
      expect(r.warnings.join(" ")).toContain("adopt-hub refused");
      expect(r.warnings.join(" ")).toContain("1 later bundle in this thread's chain was not fetched");

      // The round trip the refusal promises, on the shape that used to break it.
      const forced = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", forceAppend: true, claudeVersion: "2.1.81",
      });
      expect(forced.success).toBe(true);
      if (!forced.success) return;
      const f = forced as HubPullResult;
      expect(f.divergence?.resolution).toBe("adopt-hub");
      expect(f.divergence?.preservedSessionId).toBeTruthy();
      // BOTH bundles land, in one transcript.
      expect(uuidsOf(a.basePath)).toEqual([
        "entry-1", "entry-2", FIXTURE_HEAD_UUID, "b-entry-4", "b-entry-5", "b-entry-6", "b-entry-7",
      ]);
      expect(uuidsOf(join(a.projectDirA, `${f.divergence!.preservedSessionId}.jsonl`))).toEqual([
        "entry-1", "entry-2", FIXTURE_HEAD_UUID, "a-local-1", "a-local-2",
      ]);
      // Exactly one new file — the preserved branch. No fragments.
      expect(jsonlFiles(a.projectDirA)).toHaveLength(before.length + 1);
      expect(f.importedSessions).toHaveLength(0);
    } finally {
      a.cleanup();
    }
  });

  /**
   * The second route into the same class, and it needs no second bundle:
   * `/sesh-mover:pull` probes with `--on-divergence skip` and re-runs with the
   * user's answer, and `hub.autoPush` is on by default. One SessionEnd between
   * the two publishes this machine's own diverged branch — which is the more
   * recently active side in the ordinary case — so the thread's newest copy
   * becomes local and the answer was refused outright.
   */
  it("an auto-push between the divergence probe and the answer does not foreclose the answer", async () => {
    const a = await arrangeDivergence();
    try {
      const before = jsonlFiles(a.projectDirA);
      const probe = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "skip", claudeVersion: "2.1.81",
      });
      expect(probe.success).toBe(true);
      if (!probe.success) return;
      const threadId = (probe as HubPullResult).threadId;
      expect((probe as HubPullResult).divergence?.resolution).toBe("skip");

      // The hook fires while the user is being asked.
      const auto = await hubPush({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        noWorkspace: true, claudeVersion: "2.1.81",
      });
      expect(auto.success).toBe(true);

      const answered = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        threadId, onDivergence: "fragment", claudeVersion: "2.1.81",
      });
      expect(answered.success).toBe(true);
      if (!answered.success) return;
      const ans = answered as HubPullResult;
      expect(ans.divergence?.resolution).toBe("fragment");
      expect(ans.importedSessions).toHaveLength(1);
      expect(jsonlFiles(a.projectDirA)).toHaveLength(before.length + 1);
      // ...and it says why it did not resolve to the newest copy.
      expect(ans.warnings.join(" ")).toContain("is this machine's own");
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

/**
 * THE NINTH FORECLOSURE — created by the fix for the eighth.
 *
 * `2e42022` made a divergence abort the whole THREAD (break the bundle loop)
 * instead of skipping one bundle, and the reasoning was right: a chain is not a
 * set of independent items, so "this pull applied and recorded NOTHING for this
 * thread" is only keepable at thread granularity.
 *
 * But that promise is only DELIVERED when the break lands at `i === 0`. At
 * `i > 0` it is an abort-from-here-onward wearing thread-abort wording, and
 * every test in the suite aborted at `i === 0` — including the two-bundle
 * refusal test above, whose fixture puts the FORKING bundle first. Reverting
 * the `break` to a `continue` left the suite green, so the branch
 * `/sesh-mover:pull` always runs (`--on-divergence skip`) was unpinned.
 *
 * Three defects lived in that gap, and these tests pin all three:
 *   - a carry payload out of a bundle the abort had ALREADY recorded was
 *     dropped permanently, while the warning said it had been left in its
 *     bundle for next time;
 *   - both abort warnings claimed nothing had changed, on a pull that had
 *     spliced entries into a transcript and republished this machine's index;
 *   - the fork report counted the pull's OWN just-delivered entries as the
 *     user's local divergence.
 */
describe("hub pull — a divergence that stops the chain part-way", () => {
  /**
   * A THREE-bundle chain: bundle 0 SPLICES onto the local session, bundle 1
   * FORKS from it, bundle 2 sits behind the fork. The two branches of one
   * thread are minted by re-anchoring — see `reanchorBundleEntry` for why.
   *
   * The third bundle is not padding. With the fork on the LAST bundle, `break`
   * and `continue` are indistinguishable (there is nothing after it either
   * way), which is exactly how the eighth foreclosure's own regression test
   * came to pass while the abort semantics were unpinned. Only a bundle AFTER
   * the fork can tell "the thread stopped" from "this bundle was skipped".
   *
   * `carryOn` decides which bundle carries the uncommitted work — bundle 0 (a
   * bundle this pull records, whose payload the re-run can never offer again)
   * or bundle 1 (the diverged one, which really is deferred).
   */
  async function arrangeSpliceThenFork(
    carryOn: 0 | 1 = 0
  ): Promise<ContinuationArrangement> {
    const a = await arrangeContinuation(plainEntries, {
      gitB: true, noCarryFirst: carryOn !== 0,
    });
    try {
      appendEntries(a.basePath, localEntries(FIXTURE_HEAD_UUID, a.baseSessionId, a.projectA));
      await a.pushMoreFromB(moreEntries, { noCarry: carryOn !== 1 });
      await a.pushMoreFromB(evenMoreEntries, { noCarry: true });
      // Bundle 0 continues A's own local head, so it splices...
      await reanchorBundleEntry(a.hub, a.projectId, "b-entry-4", "a-local-2");
      // ...and bundle 1 continues the older shared anchor, so it forks.
      await reanchorBundleEntry(a.hub, a.projectId, "b-entry-6", FIXTURE_HEAD_UUID);
      ageOutOfLiveWindow(a.basePath);
      return a;
    } catch (e) {
      a.cleanup();
      throw e;
    }
  }

  it("applies and records the bundles before the fork, and says so instead of 'nothing changed'", async () => {
    const a = await arrangeSpliceThenFork();
    try {
      const filesBefore = jsonlFiles(a.projectDirA);
      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "skip", claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;

      // Bundle 0 landed in the user's own transcript and IS recorded.
      expect(p.appended).toEqual([
        { threadId: p.threadId, baseSessionId: a.baseSessionId, entriesAppended: 2 },
      ]);
      expect(uuidsOf(a.basePath)).toEqual([
        "entry-1", "entry-2", FIXTURE_HEAD_UUID, "a-local-1", "a-local-2", "b-entry-4", "b-entry-5",
      ]);
      // Bundle 1 did not: no third transcript, nothing imported.
      expect(jsonlFiles(a.projectDirA)).toEqual(filesBefore);
      expect(p.importedSessions).toHaveLength(0);
      expect(p.divergence?.resolution).toBe("skip");

      // The sentence the skill layer repeats has to be true on both sides of
      // the boundary. "skipped, nothing changed" was measurably false here.
      const w = p.warnings.join(" ");
      expect(w).not.toContain("skipped, nothing changed");
      expect(w).toContain("the fork is still undecided");
      expect(w).toContain("1 earlier bundle in this chain was already applied and recorded");
      expect(w).toContain(`2 entries spliced into session ${a.baseSessionId}`);
      expect(w).toContain("the re-run resumes at this bundle, not at the start of the chain");
      // The thread stopped, not just this bundle: bundle 2 was never fetched.
      expect(w).toContain("1 later bundle in this thread's chain was not fetched");

      // And the fork report describes the USER's divergence, not this pull's
      // own delivery: 4 entries follow the anchor, but 2 of them are the ones
      // bundle 0 appended moments earlier.
      expect(p.divergence?.adoptAvailable).toBe(true);
      expect(p.divergence?.anchorUuid).toBe(FIXTURE_HEAD_UUID);
      expect(p.divergence?.localEntriesSinceAnchor).toBe(2);
      expect(w).toContain("with 2 entries the hub hasn't seen");

      // The promise the abort exists to keep: the re-run still reaches the
      // bundle that forked AND the one behind it. With a per-bundle skip both
      // were consumed by the pull above — fragment-imported and recorded — and
      // this second one answered "Already up to date with the source machine."
      const rerun = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "fragment", claudeVersion: "2.1.81",
      });
      expect(rerun.success).toBe(true);
      if (!rerun.success) return;
      const r = rerun as HubPullResult;
      expect(r.divergence?.resolution).toBe("fragment");
      expect(r.importedSessions).toHaveLength(1);
      expect(jsonlFiles(a.projectDirA)).toHaveLength(filesBefore.length + 1);
      // ...and bundle 2 splices onto the fragment bundle 1 just created, so
      // the whole deferred half really did arrive.
      expect(r.appended).toHaveLength(1);
      expect(uuidsOf(join(a.projectDirA, `${r.importedSessions[0].newId}.jsonl`)).slice(-4)).toEqual([
        "b-entry-6", "b-entry-7", "b-entry-8", "b-entry-9",
      ]);
    } finally {
      a.cleanup();
    }
  });

  it("keeps the carry of a bundle it already recorded, and drops only the one it defers", async () => {
    const a = await arrangeSpliceThenFork();
    try {
      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "skip", claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;
      expect(p.divergence?.resolution).toBe("skip");

      // Bundle 0's payload belongs to a bundle this pull RECORDED. Suppressing
      // it dropped it permanently: `selectNeededBundles` never offers that
      // bundle again, so the only surviving copy was the archive on the hub,
      // reachable by hand-extracting a tarball.
      expect(p.carryAvailable).toBeDefined();
      expect(p.carryAvailable?.untrackedCount).toBeGreaterThan(0);
      expect(p.carryApplied?.applied).toBe(false);
      const saved = p.carryApplied?.applied === false ? p.carryApplied.savedTo : undefined;
      expect(saved).toBeTruthy();
      expect(readFileSync(join(saved!, "untracked", "wip.txt"), "utf-8")).toBe(
        "work in progress on B\n"
      );
      // ...so the abort warning must not claim it was left behind for later.
      expect(p.warnings.join(" ")).not.toContain("uncommitted work that bundle carried was left");

      // The other half of the gate, demonstrated rather than asserted: the
      // re-run resolves the fork and reports NO carry, because bundle 1 never
      // carried one and bundle 0 is gone from `needed`. That is precisely why
      // suppressing bundle 0's payload was a permanent loss and not a deferral.
      const rerun = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "fragment", claudeVersion: "2.1.81",
      });
      expect(rerun.success).toBe(true);
      if (!rerun.success) return;
      expect((rerun as HubPullResult).carryAvailable).toBeUndefined();
    } finally {
      a.cleanup();
    }
  });

  it("still defers the carry of the bundle the fork stopped at, and says so", async () => {
    // The control for the gate above: when the payload rides the DIVERGED
    // bundle it really is deferred, so suppressing it is right and the warning
    // that says it was left in its bundle is true.
    const a = await arrangeSpliceThenFork(1);
    try {
      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "skip", claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const p = result as HubPullResult;
      expect(p.divergence?.resolution).toBe("skip");
      expect(p.appended).toHaveLength(1);
      expect(p.carryAvailable).toBeUndefined();
      expect(p.carryApplied).toBeUndefined();
      expect(p.warnings.join(" ")).toContain("uncommitted work that bundle carried was left in it");
      // The project IS linked (the identity file is a root dotfile since
      // 0.7.0) and yet nothing was parked: no saved payload directory exists.
      expect(existsSync(join(a.projectA, ".sesh-mover-project.json"))).toBe(true);
      expect(existsSync(join(a.projectA, ".sesh-mover"))).toBe(false);

      // Deferred, not dropped: the re-run delivers it.
      const rerun = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "fragment", claudeVersion: "2.1.81",
      });
      expect(rerun.success).toBe(true);
      if (!rerun.success) return;
      const r = rerun as HubPullResult;
      expect(r.carryAvailable).toBeDefined();
      const saved = r.carryApplied?.applied === false ? r.carryApplied.savedTo : undefined;
      expect(readFileSync(join(saved!, "untracked", "wip.txt"), "utf-8")).toBe(
        "work in progress on B\n"
      );
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

  /**
   * The skip warning used to end "Whichever you use, that machine and this one
   * then share a generation and later payloads merge 3-way" — naming
   * `--force-workspace` and `--target-path <fresh-dir>` as interchangeable ways
   * out. They are not. Every piece of local bookkeeping in `hubPull` is keyed
   * off `effectiveProjectPath`, which IS the `--target-path` when one is given,
   * so the generation an unpack there records belongs to the FRESH directory.
   * This project directory keeps none, and its next payload produces a
   * byte-identical skip repeating the same promise. README.md, commands/pull.md
   * and SKILL.md carried the same false sentence, and pull.md told the model to
   * offer `--target-path` FIRST.
   */
  it("--target-path records the generation under the fresh dir, not this project", async () => {
    const w = await arrangeWorkspacePair({ bootstrapB: false });
    const fresh = mkdtempSync(join(tmpdir(), "sesh-ws-fresh-"));
    try {
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 2: "A-EDIT" }));
      await w.pushFromA();

      w.useB();
      writeFileSync(join(w.projectB, "local-work.txt"), "mine\n");
      const skipped = await w.pullOnB();
      expect(skipped.success).toBe(true);
      if (!skipped.success) return;
      const warned = (skipped as HubPullResult).warnings.join(" ");
      // The flags are named for what each actually does, and the false
      // equivalence is gone.
      expect(warned).toContain("Only one thing ends that repetition for THIS directory: --force-workspace");
      expect(warned).toContain("the generation it records belongs to that fresh directory");
      expect(warned).not.toContain("Whichever you use");
      expect(readSyncState(w.projectB).hub?.workspaceGenerations).toBeUndefined();

      // Now take the non-destructive option the old text called equivalent.
      w.useA();
      writeFileSync(join(w.projectA, "shared.txt"), wsLines({ 3: "A-EDIT-2" }));
      await w.pushFromA();
      w.useB();
      const toFresh = await w.pullOnB({ targetPath: fresh });
      expect(toFresh.success).toBe(true);
      if (!toFresh.success) return;
      expect((toFresh as HubPullResult).workspaceUnpacked?.path).toBe(fresh);

      // The generation landed under the FRESH directory's key...
      expect(readSyncState(fresh).hub?.workspaceGenerations).toHaveLength(1);
      // ...and this project directory still shares nothing with the payload, so
      // the skip above is the standing state here, not a first-contact case.
      expect(readSyncState(w.projectB).hub?.workspaceGenerations).toBeUndefined();
      expect(readSyncState(w.projectB).hub?.lastWorkspace).toBeUndefined();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
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
        // Everything except this plugin's own state — the identity file that
        // links the project to its hub project is a ROOT DOTFILE since 0.7.0,
        // so a `name !== ".sesh-mover"` filter would unlink the project and
        // the pull would fail for a reason this test is not about.
        if (!isPluginStateName(name)) rmSync(join(w.projectB, name), { recursive: true, force: true });
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
    // the same thing an over-broad ignore list produces. push declares
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
      // Strip the payload the manifest keeps declaring, and put a plain FILE
      // where the directory was. Both reach the same `readdirSync`: a missing
      // path throws ENOENT, a file throws ENOTDIR, and either one escapes
      // hubPull BEFORE the session import. Checking existence alone would only
      // have closed the first, while the warning below claims to cover a
      // hand-made bundle — so the guard asks whether it is a directory.
      await mutateBundleTree(hub, push.projectId, push.bundleId, (dir) => {
        rmSync(join(dir, "workspace"), { recursive: true, force: true });
        writeFileSync(join(dir, "workspace"), "not a directory\n");
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
      // The typed discriminator: field-identical to the routine no-ancestor
      // skip otherwise (null workspaceUnpacked, absent workspaceMerge), and
      // that skip's remedies cannot deliver a payload the bundle never held.
      expect(p.workspaceDeclaredMissing).toBe(true);
      expect(p.workspaceMerge).toBeUndefined();
      // Nothing was applied, so nothing may be recorded as applied: a
      // generation this tree never held would make the next merge read the
      // whole payload as "deleted here" (the Task 8 rule).
      expect(readSyncState(projectB).hub?.lastWorkspace).toBeUndefined();
      expect(readdirSync(projectB).sort()).toEqual([".sesh-mover-project.json"]);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base, projectB]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Task 12b: the disclosure for a thread whose bundles are split across two
// OTHER machines. Hub state is written by hand here (rather than driven
// through three real pushes) for one reason: which machine a pull resolves to
// is decided by lastActiveAt/messageCount/head/machineId, and machine ids are
// random uuids — a scenario that has to assert a specific SOURCE and a
// specific unreachable machine must state both, not roll for them.
// ---------------------------------------------------------------------------
describe("hub pull: a thread split across two other machines", () => {
  const MACHINE_A = "machine-alpha";
  const MACHINE_B = "machine-beta";
  const THREAD = "thread-split";
  const PROJECT_ID = "proj-split";

  interface SplitFixture {
    home: string; hub: string; base: string; project: string; configDir: string;
    backend: ReturnType<typeof createFsBackend>;
    restore: { restore: () => void };
  }

  async function setupSplit(prefix: string, opts: { withB: boolean }): Promise<SplitFixture> {
    const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
    const hub = mkdtempSync(join(tmpdir(), `${prefix}-hub-`));
    const base = mkdtempSync(join(tmpdir(), `${prefix}-fix-`));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const project = createRealProject(base, configDir, "proj");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      writeLocalProjectId(project, {
        projectId: PROJECT_ID, name: "proj",
        createdAt: "2026-07-01T00:00:00Z", createdByMachine: MACHINE_A,
      });

      const backend = createFsBackend(hub);
      for (const [id, name] of [[MACHINE_A, "alpha-laptop"], [MACHINE_B, "beta-desktop"]]) {
        await backend.writeAtomic(
          machinePath(id),
          JSON.stringify({ id, name, platform: "linux", lastSeenAt: "2026-07-21T00:00:00Z" }) + "\n"
        );
      }
      // A is the newest copy, so a pull resolves to A and fetches A's list.
      await writeMachineIndex(backend, {
        ...idx(MACHINE_A, {
          [THREAD]: entry({
            localSessionId: "sA-local", lastActiveAt: "2026-07-21T12:00:00Z", headEntryUuid: "head-a1",
            bundles: [bundle({ bundleId: "a1", type: "full", sessionIdInBundle: "sA", headEntryUuid: "head-a1" })],
          }),
        }),
        projectId: PROJECT_ID,
      });
      if (opts.withB) {
        // B pushed its own continuation of the same thread. Nothing in A's
        // index mentions it — a machine only ever lists what IT pushed.
        await writeMachineIndex(backend, {
          ...idx(MACHINE_B, {
            [THREAD]: entry({
              localSessionId: "sB-local", lastActiveAt: "2026-07-21T09:00:00Z", headEntryUuid: "head-b1",
              bundles: [bundle({ bundleId: "b1", sessionIdInBundle: "sB", headEntryUuid: "head-b1" })],
            }),
          }),
          projectId: PROJECT_ID,
        });
      }

      // This machine already holds A's half: the fixture session IS the local
      // copy, and the peer bookkeeping says where it came from. That makes
      // A's bundle "already received", which is what drives the pull into the
      // "already up to date with the source machine" answer.
      const st = readSyncState(project);
      st.peers[MACHINE_A] = {
        name: "alpha-laptop", lastSentAt: null, lastReceivedAt: "2026-07-21T12:30:00Z",
        sent: {
          [FIXTURE_SESSION_ID]: {
            headEntryUuid: "head-a1", messageCount: 3, sentAsType: "full", sentAsSessionId: "sA",
          },
        },
        received: {
          sA: { localSessionId: FIXTURE_SESSION_ID, type: "full", importedAt: "2026-07-21T12:30:00Z" },
        },
      };
      writeSyncState(st);

      return { home, hub, base, project, configDir, backend, restore };
    } catch (e) {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
      throw e;
    }
  }

  function cleanupSplit(f: SplitFixture): void {
    f.restore.restore();
    for (const d of [f.home, f.hub, f.base]) rmSync(d, { recursive: true, force: true });
  }

  /**
   * THE FOLD, from the outside. This case used to be `success: false` with the
   * disclosure in `error`, and the exit moved for a reason worth stating: the
   * bundle B holds here is a PRE-ASSEMBLY record (the shared `bundle()` builder
   * emits no `anchorEntryUuid`, which is every bundle already sitting on every
   * hub), so assembly can say exactly what it is and why no pull reaches it.
   *
   * The rule the select stage now writes down: a pull that can NAME the
   * condition succeeds; a pull that can only name the machines fails. This pull
   * named it, changed nothing, and said so — under the failure contract
   * (truthfulness is the invariant, completeness is best-effort) that is a
   * complete and correct answer, and returning it as an error is the nag loop
   * the milestone exists to break, since an error tells the caller to retry and
   * every retry says the same thing forever.
   */
  it('"already up to date" succeeds and says WHICH machine holds the part it cannot fetch', async () => {
    const f = await setupSplit("sesh-pull-split", { withB: true });
    try {
      const pull = await hubPull({
        configDir: f.configDir, projectPath: f.project, hubPath: f.hub,
        threadId: THREAD, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      const reason = p.nothingToApply?.reason ?? "";
      const warned = p.warnings.join(" ");
      // Nothing landed, and nothing claims otherwise.
      expect(p.importedSessions).toEqual([]);
      expect(p.appended ?? []).toEqual([]);
      expect(reason).toContain("Nothing to apply");
      // Not silent about the half of the thread that is not here.
      expect(warned).toContain("could not be pulled whole");
      expect(warned).toContain("beta-desktop");
      expect(warned).toContain("alpha-laptop"); // the machine it did resolve to
      // ...and it says WHICH condition, which is the half `unfetchableBundles`
      // alone could never carry.
      expect(reason).toContain("pushed before sesh-mover recorded which entry");
      expect(p.unfetchableBundles).toEqual([
        { machineId: MACHINE_B, machineName: "beta-desktop", bundleIds: ["b1"] },
      ]);
      expect(p.unplaceableBundles).toEqual([
        { machineId: MACHINE_B, machineName: "beta-desktop", bundleId: "b1", preAssembly: true },
      ]);
      // No invented remedy: this branch still offers no flag.
      expect(`${reason} ${warned}`).not.toMatch(/--[a-z]/);
      // ...and the retired claim is gone from every string this exit produces.
      // "sesh-mover cannot yet assemble a thread whose history is split across
      // machines" was true when it was written and #35 is what makes it false;
      // a message that forecloses a remedy which now exists is the same defect
      // class as one that invents a remedy which does not.
      expect(`${reason} ${warned}`).not.toContain("split across machines");
      expect(`${reason} ${warned}`).not.toContain("cannot be assembled here yet");
      expect(`${reason} ${warned}`).not.toContain("no flag or re-run fetches them");
    } finally {
      cleanupSplit(f);
    }
  });

  it("says nothing extra when only one other machine has ever pushed the thread", async () => {
    // The false-positive control for the branch above: the SAME fixture with
    // B's index absent must produce the original two-machine answer, verbatim.
    const f = await setupSplit("sesh-pull-nosplit", { withB: false });
    try {
      const pull = await hubPull({
        configDir: f.configDir, projectPath: f.project, hubPath: f.hub,
        threadId: THREAD, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(false);
      if (pull.success) return;
      expect("error" in pull && pull.error).toBe("Already up to date with the source machine.");
      expect("suggestion" in pull && pull.suggestion).toBe("Run whereis to confirm.");
    } finally {
      cleanupSplit(f);
    }
  });

  it("says nothing when the other machine's bundle already arrived here", async () => {
    // Three machines, but nothing is missing: this machine pulled B's bundle
    // earlier. A disclosure here would fire on an ordinary synced project.
    const f = await setupSplit("sesh-pull-split-synced", { withB: true });
    try {
      const st = readSyncState(f.project);
      st.peers[MACHINE_B] = {
        name: "beta-desktop", lastSentAt: null, lastReceivedAt: "2026-07-21T13:00:00Z",
        sent: {
          [FIXTURE_SESSION_ID]: {
            headEntryUuid: "head-b1", messageCount: 5, sentAsType: "continuation", sentAsSessionId: "sB",
          },
        },
        received: {
          sB: { localSessionId: FIXTURE_SESSION_ID, type: "continuation", importedAt: "2026-07-21T13:00:00Z" },
        },
      };
      writeSyncState(st);

      const pull = await hubPull({
        configDir: f.configDir, projectPath: f.project, hubPath: f.hub,
        threadId: THREAD, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(false);
      if (pull.success) return;
      expect("error" in pull && pull.error).toBe("Already up to date with the source machine.");
    } finally {
      cleanupSplit(f);
    }
  });

  // The disclosure has to survive the branches that return BEFORE any bundle
  // is selected. `--latest` skips a thread this machine is "current" with, and
  // head equality is exactly what a fragment of a split thread produces — so
  // the machine holding the least of a conversation got the most reassuring
  // answer of all: "all threads are current".
  it("--latest discloses a split thread instead of saying everything is current", async () => {
    const f = await setupSplit("sesh-pull-split-latest", { withB: true });
    try {
      // This machine publishes A's head, so isCurrent() is true for the only
      // thread and --latest finds no candidate.
      const me = loadOrCreateMachineId();
      await writeMachineIndex(f.backend, {
        ...idx(me.id, {
          [THREAD]: entry({
            localSessionId: FIXTURE_SESSION_ID, lastActiveAt: "2026-07-21T11:00:00Z",
            headEntryUuid: "head-a1", bundles: [],
          }),
        }),
        projectId: PROJECT_ID,
      });

      const pull = await hubPull({
        configDir: f.configDir, projectPath: f.project, hubPath: f.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(false);
      if (pull.success) return;
      const err = "error" in pull ? pull.error : "";
      const sug = "suggestion" in pull ? (pull.suggestion ?? "") : "";
      expect(err).toContain("not every thread is whole here");
      expect(err).toContain("beta-desktop");
      // THIS EXIT STAYS AN ERROR, and deliberately: `--latest` resolves no
      // thread here — it looked at every one of them and found a source for
      // none — so there is no thread id and no source machine for a `report` to
      // be about. What it OWES the user is the same disclosure the resolved
      // exits give, and that is what changed: the branch now runs the same
      // assembly the fetching path runs, so it names the condition rather than
      // only the machines.
      expect(err).toContain("pushed before sesh-mover recorded which entry");
      // The retired claim, in both fields a caller reads. It said no flag or
      // re-run could fetch a thread split across machines and that sesh-mover
      // could not assemble one; assembly is what makes both false.
      expect(`${err} ${sug}`).not.toContain("split across machines");
      expect(`${err} ${sug}`).not.toContain("cannot be assembled here yet");
      expect(`${err} ${sug}`).not.toContain("no flag or re-run fetches them");
      expect(sug).not.toContain("nothing to re-run");
      expect(`${err} ${sug}`).not.toMatch(/--[a-z]/); // no invented remedy
    } finally {
      cleanupSplit(f);
    }
  });

  it("--latest keeps its plain answer when nothing is missing (control)", async () => {
    const f = await setupSplit("sesh-pull-nosplit-latest", { withB: false });
    try {
      const me = loadOrCreateMachineId();
      await writeMachineIndex(f.backend, {
        ...idx(me.id, {
          [THREAD]: entry({
            localSessionId: FIXTURE_SESSION_ID, lastActiveAt: "2026-07-21T11:00:00Z",
            headEntryUuid: "head-a1", bundles: [],
          }),
        }),
        projectId: PROJECT_ID,
      });
      const pull = await hubPull({
        configDir: f.configDir, projectPath: f.project, hubPath: f.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(false);
      if (pull.success) return;
      // #44 reworded this: the branch tests receipts, never head equality, so
      // "all threads are current on this machine" claimed something the code
      // no longer asks. The control property is unchanged — with only one
      // other machine in play the sentence carries no split disclosure.
      expect("error" in pull && pull.error).toBe(
        "Nothing to pull: every bundle the machine each thread resolves to lists has already been received here."
      );
    } finally {
      cleanupSplit(f);
    }
  });

  it('"the latest copy is already local" now fetches the unreceived half instead of refusing', async () => {
    const f = await setupSplit("sesh-pull-split-local", { withB: true });
    try {
      // Newest copy of all: this machine. That used to end the pull outright
      // ("The latest copy of this thread is already local"), which is a
      // statement about HEADS answering a question about BUNDLES — and the
      // default-on auto-push makes the two come apart routinely (see
      // `alternateSource`: probe with --on-divergence skip, one SessionEnd hook
      // publishes the local branch, and the user's answer is then refused).
      const me = loadOrCreateMachineId();
      await writeMachineIndex(f.backend, {
        ...idx(me.id, {
          [THREAD]: entry({
            localSessionId: FIXTURE_SESSION_ID, lastActiveAt: "2026-07-22T09:00:00Z",
            headEntryUuid: "head-local", bundles: [],
          }),
        }),
        projectId: PROJECT_ID,
      });
      const pull = await hubPull({
        configDir: f.configDir, projectPath: f.project, hubPath: f.hub,
        threadId: THREAD, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(false);
      if (pull.success) return;
      // It resolved to B and reached for B's bundle. (This fixture writes index
      // entries without the bundle archives behind them, so the pull stops at
      // the sync check — which is exactly the proof that the source flipped.)
      expect("reason" in pull && pull.reason).toBe("not-yet-synced");
      expect("missing" in pull && pull.missing.join(" ")).toContain("b1");
      expect("error" in pull ? pull.error : "").not.toContain("already local");
    } finally {
      cleanupSplit(f);
    }
  });

  it('still answers "already local" when the other machine has nothing this one lacks', async () => {
    // The control for the branch above: same shape, but B's bundle is already
    // accounted for here, so there is genuinely nothing to fetch and the
    // early return — with its disclosure — is the right answer.
    const f = await setupSplit("sesh-pull-split-local-ctl", { withB: true });
    try {
      const me = loadOrCreateMachineId();
      await writeMachineIndex(f.backend, {
        ...idx(me.id, {
          [THREAD]: entry({
            localSessionId: FIXTURE_SESSION_ID, lastActiveAt: "2026-07-22T09:00:00Z",
            headEntryUuid: "head-local", bundles: [],
          }),
        }),
        projectId: PROJECT_ID,
      });
      const st = readSyncState(f.project);
      st.peers[MACHINE_B] = {
        name: "beta-desktop", lastSentAt: null, lastReceivedAt: "2026-07-21T13:00:00Z",
        sent: {},
        received: {
          sB: { localSessionId: FIXTURE_SESSION_ID, type: "continuation", importedAt: "2026-07-21T13:00:00Z" },
        },
      };
      writeSyncState(st);

      const pull = await hubPull({
        configDir: f.configDir, projectPath: f.project, hubPath: f.hub,
        threadId: THREAD, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(false);
      if (pull.success) return;
      expect("error" in pull && pull.error).toBe("The latest copy of this thread is already local.");
    } finally {
      cleanupSplit(f);
    }
  });

  it("whereis reports the same split, on a thread it also calls current", async () => {
    const f = await setupSplit("sesh-pull-split-whereis", { withB: true });
    try {
      // This machine's own index publishes A's head — the shape that makes
      // `current` true while half the conversation is on a machine no pull
      // reads. The field is what stops that being reassuring.
      const me = loadOrCreateMachineId();
      await writeMachineIndex(f.backend, {
        ...idx(me.id, {
          [THREAD]: entry({
            localSessionId: FIXTURE_SESSION_ID, lastActiveAt: "2026-07-21T11:00:00Z",
            headEntryUuid: "head-a1", bundles: [],
          }),
        }),
        projectId: PROJECT_ID,
      });

      const w = await hubWhereis({ configDir: f.configDir, projectPath: f.project, hubPath: f.hub });
      expect(w.linked).toBe(true);
      const t = w.threads.find((x) => x.threadId === THREAD)!;
      expect(t.localCopy?.current).toBe(true);
      expect(t.pullNeeded).toBe(false);
      expect(t.unfetchableBundles).toEqual([
        { machineId: MACHINE_B, machineName: "beta-desktop", bundleIds: ["b1"] },
      ]);
    } finally {
      cleanupSplit(f);
    }
  });

  it("whereis is silent on the ordinary two-machine project", async () => {
    const f = await setupSplit("sesh-pull-nosplit-whereis", { withB: false });
    try {
      const me = loadOrCreateMachineId();
      await writeMachineIndex(f.backend, {
        ...idx(me.id, {
          [THREAD]: entry({
            localSessionId: FIXTURE_SESSION_ID, lastActiveAt: "2026-07-21T11:00:00Z",
            headEntryUuid: "head-a1", bundles: [],
          }),
        }),
        projectId: PROJECT_ID,
      });
      const w = await hubWhereis({ configDir: f.configDir, projectPath: f.project, hubPath: f.hub });
      expect(w.threads.every((t) => t.unfetchableBundles === undefined)).toBe(true);
    } finally {
      cleanupSplit(f);
    }
  });
});

// --- Bundle integrity, and the interrupted-pull thread mapping ------------

/**
 * Two failure classes a pull could previously walk straight through:
 *
 *   1. A DAMAGED bundle. `readManifest` only checks JSON shape and id safety,
 *      so a bundle whose session inventory had been edited, or that declared a
 *      session it did not contain, went on to drive the workspace merge, the
 *      carry, and the append path — which splices into a transcript the user
 *      already owns after checking the delta against a hash out of that same
 *      manifest.
 *   2. An INTERRUPTED pull (#28). `peers[...].received` is written inside the
 *      bundle loop; `setThreadId` runs after the whole chain. A crash between
 *      the two leaves this machine holding the content with no record of which
 *      thread it belongs to, and every re-pull returns early without repairing
 *      it — so the next push mints a SECOND thread for the same conversation.
 */
describe("hub pull — bundle integrity and interrupted-pull repair", () => {
  /** A pushed thread on a hub, pulled (or not yet) by machine B. */
  async function twoMachines(label: string) {
    const homeA = mkdtempSync(join(tmpdir(), `${label}-homeA-`));
    const homeB = mkdtempSync(join(tmpdir(), `${label}-homeB-`));
    const hub = mkdtempSync(join(tmpdir(), `${label}-hub-`));
    const base = mkdtempSync(join(tmpdir(), `${label}-fix-`));
    let restore = overrideHome(homeA);
    const { configDir: configDirA } = createFixtureTree(base);
    const projectA = createRealProject(base, configDirA, "projA");
    await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
    const pushResult = await hubPush({
      configDir: configDirA, projectPath: projectA, hubPath: hub,
      createProject: true, noWorkspace: true, claudeVersion: "2.1.81",
    });
    if (!pushResult.success) throw new Error("setup push failed");

    restore.restore();
    restore = overrideHome(homeB);
    const configDirB = join(homeB, ".claude");
    const projectB = mkdtempSync(join(tmpdir(), `${label}-projB-`));
    writeLocalProjectId(projectB, {
      projectId: pushResult.projectId, name: "projA",
      createdAt: new Date().toISOString(), createdByMachine: "machine-a",
    });
    return {
      hub, projectId: pushResult.projectId, configDirB, projectB,
      projectDirB: join(configDirB, "projects", encodeProjectPath(projectB)),
      pull: (over: Record<string, unknown> = {}) =>
        hubPull({
          configDir: configDirB, projectPath: projectB, hubPath: hub,
          latest: true, claudeVersion: "2.1.81", ...over,
        } as Parameters<typeof hubPull>[0]),
      push: () =>
        hubPush({
          configDir: configDirB, projectPath: projectB, hubPath: hub,
          noWorkspace: true, claudeVersion: "2.1.81",
        }),
      whereis: () => hubWhereis({ configDir: configDirB, projectPath: projectB, hubPath: hub }),
      cleanup: () => {
        restore.restore();
        for (const d of [homeA, homeB, hub, base, projectB]) {
          rmSync(d, { recursive: true, force: true });
        }
      },
    };
  }

  /** Rewrite the FULL bundle on the hub in place. */
  async function mutateFullBundle(
    hubPath: string,
    projectId: string,
    mutate: (bundleDir: string) => void
  ): Promise<void> {
    const backend = createFsBackend(hubPath);
    const { indexes } = await readAllIndexes(backend, projectId);
    const record = indexes
      .flatMap((i) => Object.values(i.threads))
      .flatMap((t) => t.bundles)[0];
    if (!record) throw new Error("no bundle on the hub to mutate");
    const stage = mkdtempSync(join(tmpdir(), "sesh-pull-mutate-full-"));
    try {
      const tarPath = join(stage, "in.tar.gz");
      writeFileSync(tarPath, await backend.read(record.file));
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

  it("refuses a bundle whose manifest session list no longer hashes to its own digest", async () => {
    const f = await twoMachines("sesh-pull-digest");
    try {
      await mutateFullBundle(f.hub, f.projectId, (dir) => {
        const p = join(dir, "manifest.json");
        const m = JSON.parse(readFileSync(p, "utf-8"));
        expect(m.sessionsDigest).toMatch(/^sha256:/);
        m.sessions[0].integrityHash = "sha256:0000";
        writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
      });

      const result = await f.pull();
      expect(result.success).toBe(false);
      expect((result as ErrorResult).error).toMatch(/failed its integrity check/);
      // Nothing landed, and nothing was recorded as received — the bundle stays
      // fetchable once the pushing machine replaces it.
      expect(existsSync(f.projectDirB) ? readdirSync(f.projectDirB) : []).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a bundle that declares a session it does not contain, instead of counting it imported", async () => {
    const f = await twoMachines("sesh-pull-missing");
    try {
      await mutateFullBundle(f.hub, f.projectId, (dir) => {
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
        rmSync(join(dir, "sessions", `${m.sessions[0].sessionId}.jsonl`));
      });

      const result = await f.pull();
      expect(result.success).toBe(false);
      expect((result as ErrorResult).error).toMatch(/does not contain it/);
      expect(existsSync(f.projectDirB) ? readdirSync(f.projectDirB) : []).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("an interrupted pull's lost thread mapping is restored on the re-pull, so the next push does not fork the thread", async () => {
    const f = await twoMachines("sesh-pull-crashwin");
    try {
      const first = await f.pull();
      expect(first.success).toBe(true);
      if (!first.success) return;
      const threadId = (first as HubPullResult).threadId;
      const localId = (first as HubPullResult).localSessionId!;
      expect(localId).toBeTruthy();

      // The crash window, reproduced exactly: `received` survives (written
      // inside the bundle loop by importSession), the thread mapping does not
      // (written after the chain, the workspace merge and the carry).
      const st = readSyncState(f.projectB);
      delete st.hub!.threadByLocalSession[localId];
      writeSyncState(st);
      expect(getThreadId(readSyncState(f.projectB), localId)).toBeNull();

      // The re-pull fetches nothing — every bundle is already recorded — and
      // this is the branch that used to return without repairing anything.
      const second = await f.pull();
      expect(second.success).toBe(false);
      expect((second as ErrorResult).details).toMatch(/mapping has been restored/);
      expect(getThreadId(readSyncState(f.projectB), localId)).toBe(threadId);

      // The consequence that made it matter: B's next push continues the
      // existing thread rather than minting a second one whose only bundle is
      // a continuation with no base in its own chain.
      appendFileSync(
        join(f.projectDirB, `${localId}.jsonl`),
        JSON.stringify({
          uuid: "b-new-1", parentUuid: readLastEntryUuid(join(f.projectDirB, `${localId}.jsonl`)),
          timestamp: "2026-07-22T10:00:00Z", sessionId: localId, cwd: f.projectB,
          version: "2.1.81", type: "user", message: { role: "user", content: "more" },
        }) + "\n"
      );
      const pushed = await f.push();
      expect(pushed.success).toBe(true);
      const w = await f.whereis();
      expect(w.threads.map((t) => t.threadId)).toEqual([threadId]);
    } finally {
      f.cleanup();
    }
  });

  /**
   * The same end state as the crash window above, reached WITHOUT a crash — and
   * the reason `backfillThreadMappings` cannot repair it.
   *
   * The receipts (`peers[...].received`, and the hub ledger `recordSentToPeer`
   * credits) are written INSIDE the per-bundle loop; the thread mapping used to
   * be written only after it. Three hard returns in that loop — a fetch abort, a
   * workspace abort, an import failure — leave bundles `0..i-1` applied and
   * credited and never reach the record stage. That is deliberate for the
   * bundles themselves ("the re-run resumes at this bundle, not at the start of
   * the chain"), and it is exactly why the mapping has to keep up with them.
   *
   * The trigger is ordinary rather than hostile: a bundle that arrived on this
   * machine's copy of the synced hub folder without the session it declares —
   * the condition the abort's own suggestion names.
   *
   * `backfillThreadMappings` is unreachable here, which is the whole point: it
   * runs only on exits where `needed` is EMPTY, and after a mid-chain abort the
   * deferred bundle was never recorded as received, so the re-run's `needed` is
   * non-empty and aborts at the same bundle again. The damage therefore persists
   * for as long as the hub copy does — and `hub reindex` does not repair it
   * either (`reindex.ts` drops a session with no thread mapping, with a warning).
   */
  it("a mid-chain abort maps the thread for the bundles it DID apply, so the next push does not fork it", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-midchain-homeA-"));
    const homeC = mkdtempSync(join(tmpdir(), "sesh-midchain-homeC-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-midchain-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-midchain-fix-"));
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
      const threadId = full.pushedSessions[0].threadId;
      const aJsonl = join(configDirA, "projects", encodeProjectPath(projectA), `${FIXTURE_SESSION_ID}.jsonl`);
      appendEntries(aJsonl, plainEntries(FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, projectA));
      expect((await hubPush(pushOpts)).success).toBe(true);

      // Bundle 1 of the chain: present on the hub, declaring a session it does
      // not carry. The fetch stage aborts on it, after bundle 0 is applied.
      await mutateContinuationBundle(hub, full.projectId, (dir) => {
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as ExportManifest;
        rmSync(join(dir, "sessions", `${m.sessions[0].sessionId}.jsonl`));
      });

      restore.restore();
      restore = overrideHome(homeC);
      const configDirC = join(homeC, ".claude");
      projectC = mkdtempSync(join(tmpdir(), "sesh-midchain-projC-"));
      writeLocalProjectId(projectC, {
        projectId: full.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      const pulled = await hubPull({
        configDir: configDirC, projectPath: projectC, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pulled.success).toBe(false);
      expect((pulled as ErrorResult).error).toMatch(/does not contain it/);

      // Bundle 0 really was applied and credited — the abort is not a rollback,
      // and this is the half the abort's message promises.
      const projectDirC = join(configDirC, "projects", encodeProjectPath(projectC));
      const landedFiles = readdirSync(projectDirC).filter((f) => f.endsWith(".jsonl"));
      expect(landedFiles).toHaveLength(1);
      const landed = landedFiles[0].replace(/\.jsonl$/, "");
      const stateC = readSyncState(projectC);
      expect(
        Object.values(stateC.peers).some((p) => Object.keys(p.received ?? {}).length > 0)
      ).toBe(true);
      // ...and the hub's own ledger was credited too, which is what makes the
      // missing mapping cost more than a duplicate: the forking push below ships
      // a DELTA, leaving a continuation chain with no base bundle to anchor it.
      expect(
        Object.entries(stateC.peers).some(
          ([id, p]) => id.startsWith("hub:") && Object.keys(p.sent ?? {}).length > 0
        )
      ).toBe(true);

      // The mapping has to be exactly as durable as those receipts.
      expect(getThreadId(readSyncState(projectC), landed)).toBe(threadId);

      // The re-run lands on the SAME abort (the deferred bundle was never
      // recorded, so `needed` is non-empty) — the backfill exit is unreachable.
      const again = await hubPull({
        configDir: configDirC, projectPath: projectC, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(again.success).toBe(false);
      expect((again as ErrorResult).error).toMatch(/does not contain it/);

      // The consequence, and the reason this is data loss rather than untidiness:
      // C's next push continues A's thread instead of minting a second one.
      appendEntries(join(projectDirC, `${landed}.jsonl`), [
        {
          uuid: "c-new-1", parentUuid: readLastEntryUuid(join(projectDirC, `${landed}.jsonl`)),
          timestamp: "2026-07-22T10:00:00Z", sessionId: landed, cwd: projectC,
          version: "2.1.81", type: "user", message: { role: "user", content: "more from C" },
        },
      ]);
      const pushedC = await hubPush({
        configDir: configDirC, projectPath: projectC, hubPath: hub,
        noWorkspace: true, claudeVersion: "2.1.81",
      });
      expect(pushedC.success).toBe(true);
      if (!pushedC.success) return;
      // Measured before the fix: a SECOND thread whose only bundle is a
      // `continuation` — a delta with no base bundle anywhere in its own chain,
      // which is the unreconstructable thread `recordSentToPeer`'s invariant
      // names. The delta is right; the thread it is filed under is the defect.
      expect(pushedC.pushedSessions[0].type).toBe("continuation");
      expect(pushedC.pushedSessions[0].threadId).toBe(threadId);
      const w = await hubWhereis({ configDir: configDirC, projectPath: projectC, hubPath: hub });
      expect(w.threads.map((t) => t.threadId)).toEqual([threadId]);
    } finally {
      restore.restore();
      for (const d of [homeA, homeC, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectC) rmSync(projectC, { recursive: true, force: true });
    }
  });

  /**
   * The same mid-chain shape, on the guard that used to have no `try`.
   *
   * `readManifest` throws — on an absent, unparseable or foreign `manifest.json`
   * — and the throw went straight past `hubPull` into the CLI's outer catch:
   * `outputError` prints `{success, command, error}` and exits **1**, where
   * every typed hub refusal goes through `output` and exits 0. So a damaged
   * bundle was reported in the shape of an internal fault, and the `suggestion`
   * that tells the user what to do about it — and that the bundles already
   * applied stay applied — did not exist at all.
   *
   * This asserts the refusal is a VALUE, on a pull that had already applied
   * bundle 0: the two facts a throw could not carry are the suggestion and the
   * intact half of the pull.
   */
  it("refuses, as a value with a suggestion, a mid-chain bundle whose manifest cannot be read", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-badmanifest-homeA-"));
    const homeC = mkdtempSync(join(tmpdir(), "sesh-badmanifest-homeC-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-badmanifest-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-badmanifest-fix-"));
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
      const aJsonl = join(configDirA, "projects", encodeProjectPath(projectA), `${FIXTURE_SESSION_ID}.jsonl`);
      appendEntries(aJsonl, plainEntries(FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, projectA));
      expect((await hubPush(pushOpts)).success).toBe(true);

      // Bundle 1 of the chain: an archive that unpacks perfectly and whose
      // manifest.json is not one this plugin can read.
      await mutateContinuationBundle(hub, full.projectId, (dir) => {
        writeFileSync(join(dir, "manifest.json"), "{ truncated in transit", "utf-8");
      });

      restore.restore();
      restore = overrideHome(homeC);
      const configDirC = join(homeC, ".claude");
      projectC = mkdtempSync(join(tmpdir(), "sesh-badmanifest-projC-"));
      writeLocalProjectId(projectC, {
        projectId: full.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      // A THROW would fail this call, not return from it.
      const pulled = await hubPull({
        configDir: configDirC, projectPath: projectC, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });

      expect(pulled.success).toBe(false);
      expect((pulled as ErrorResult).command).toBe("pull");
      expect((pulled as ErrorResult).error).toMatch(/does not carry a readable sesh-mover manifest/);
      // The half a throw structurally cannot carry, and the reason the exit code
      // matters: this is what tells the user the pull is re-runnable and what
      // it already kept.
      expect((pulled as ErrorResult).suggestion).toContain("Nothing from this bundle was applied.");
      expect((pulled as ErrorResult).suggestion).toContain("will not be refetched");

      // Bundle 0 really was applied and recorded before the refusal — so the
      // refusal describes a partly-completed pull, not a crash.
      const projectDirC = join(configDirC, "projects", encodeProjectPath(projectC));
      expect(readdirSync(projectDirC).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
      expect(
        Object.values(readSyncState(projectC).peers)
          .some((p) => Object.keys(p.received ?? {}).length > 0)
      ).toBe(true);
    } finally {
      restore.restore();
      for (const d of [homeA, homeC, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectC) rmSync(projectC, { recursive: true, force: true });
    }
  });

  it("stops a re-hashed continuation BEFORE the splice, where the per-session hash cannot help", async () => {
    // The case the bundle-level digest exists for, and the reason it is checked
    // in pull.ts rather than left to importSession: edit the delta AND the
    // `integrityHash` that describes it, and every per-session check agrees
    // with itself. The append path would then weld that content into a
    // transcript the user already owns, irreversibly. The digest is the only
    // thing that notices the inventory was rewritten.
    const a = await arrangeContinuation();
    try {
      const baseBefore = readFileSync(a.basePath, "utf-8");
      const filesBefore = jsonlFiles(a.projectDirA);
      await mutateContinuationBundle(a.hub, a.projectId, (dir) => {
        const manifestPath = join(dir, "manifest.json");
        const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as ExportManifest;
        const delta = join(dir, "sessions", `${m.sessions[0].sessionId}.jsonl`);
        appendFileSync(
          delta,
          JSON.stringify({
            uuid: "smuggled", parentUuid: "b-entry-5", timestamp: "2026-04-11T09:09:09Z",
            sessionId: m.sessions[0].sessionId, cwd: "/x", version: "2.1.81",
            type: "user", message: { role: "user", content: "content the exporter never hashed" },
          }) + "\n"
        );
        // Re-hashed so the per-session check PASSES. The digest is stale.
        m.sessions[0].integrityHash = `sha256:${createHash("sha256")
          .update(readFileSync(delta))
          .digest("hex")}`;
        writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
      });

      const result = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(false);
      expect((result as ErrorResult).error).toMatch(/failed its integrity check/);
      // The user's transcript is byte-identical and no fragment was minted.
      expect(readFileSync(a.basePath, "utf-8")).toBe(baseBefore);
      expect(jsonlFiles(a.projectDirA)).toEqual(filesBefore);
    } finally {
      a.cleanup();
    }
  });

  it("touches nothing when every local session already carries its thread mapping", async () => {
    // The repair must be invisible on the ordinary "already up to date" answer:
    // it may not rewrite sync-state, and it may not put a `details` line on a
    // result where nothing was wrong.
    const f = await twoMachines("sesh-pull-nobackfill");
    try {
      expect((await f.pull()).success).toBe(true);
      const statePath = syncStatePath(f.projectB);
      const before = readFileSync(statePath, "utf-8");
      const second = await f.pull();
      expect(second.success).toBe(false);
      expect((second as ErrorResult).details).toBeUndefined();
      expect(readFileSync(statePath, "utf-8")).toBe(before);
    } finally {
      f.cleanup();
    }
  });

  /**
   * #74 — what `--progress` actually emits, and the contract a consumer can
   * hold `hubPull` to.
   *
   * Nested HERE, inside the integrity fixtures, for one reason: the bug worth
   * fixing was a FETCH ABORT emitting `{percent: 0}` and never `{percent: 100}`,
   * so the arrangement it needs is a corrupt bundle — which is exactly what
   * `twoMachines` + `mutateFullBundle` above build. Duplicating them below would
   * be a second copy of a fixture, not a second test.
   */
  describe("--progress events", () => {
    /** Every event a pull emits, in order. */
    function recorder(): { events: ProgressEvent[]; onProgress: (ev: ProgressEvent) => void } {
      const events: ProgressEvent[] = [];
      return { events, onProgress: (ev) => events.push(ev) };
    }

    const hubPhase = (events: ProgressEvent[]): Array<number | undefined> =>
      events.filter((e) => e.phase === "hub-pull").map((e) => e.percent);

    /**
     * THE bug. A consumer that renders on the first event and closes on the
     * terminal one waited forever, because the abort returns from the middle of
     * the per-bundle loop — as do the workspace abort and the import failure
     * beside it. The fix is structural (the close is in `hubPull`'s `finally`),
     * so this one case standing in for the three is honest.
     */
    it("still emits the terminal event when a fetch aborts mid-pull", async () => {
      const f = await twoMachines("sesh-pull-prog-abort");
      const { events, onProgress } = recorder();
      try {
        await mutateFullBundle(f.hub, f.projectId, (dir) => {
          const p = join(dir, "manifest.json");
          const m = JSON.parse(readFileSync(p, "utf-8"));
          m.sessions[0].integrityHash = "sha256:0000";
          writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
        });

        const result = await f.pull({ onProgress });

        // Precondition: this really is the abort path, not some other refusal.
        expect(result.success).toBe(false);
        expect((result as ErrorResult).error).toMatch(/failed its integrity check/);
        expect(hubPhase(events)[0]).toBe(0);
        expect(hubPhase(events).at(-1)).toBe(100);
        expect(events.at(-1)).toEqual({ phase: "hub-pull", percent: 100 });
      } finally {
        f.cleanup();
      }
    });

    /**
     * The early exits — "already up to date", "nothing to pull", pick-required —
     * are the COMMON outcomes, and every one of them used to emit nothing at
     * all, because the opening event sat after thread selection. A consumer that
     * renders a bar on the first event showed nothing for the ordinary case and
     * an unclosed bar for the unusual one, which is precisely backwards.
     */
    it("emits a matched pair on an early exit that applies nothing", async () => {
      const f = await twoMachines("sesh-pull-prog-early");
      const { events, onProgress } = recorder();
      try {
        expect((await f.pull()).success).toBe(true);

        const second = await f.pull({ onProgress });

        expect(second.success).toBe(false);
        expect((second as ErrorResult).error).toMatch(/Nothing to pull/);
        // Exactly two, and no per-bundle events in between: nothing was fetched.
        expect(events).toEqual([
          { phase: "hub-pull", percent: 0 },
          { phase: "hub-pull", percent: 100 },
        ]);
      } finally {
        f.cleanup();
      }
    });

    /**
     * The other half of the contract, stated as a test because it is a decision
     * and not an oversight: the ONE exit above the lock emits nothing, so a
     * consumer gets either no events or a matched pair — never an opening event
     * with no close.
     */
    it("emits nothing at all when the project lock is already held", async () => {
      const f = await twoMachines("sesh-pull-prog-lock");
      const { events, onProgress } = recorder();
      const held = acquireProjectLock(f.projectB);
      try {
        const result = await f.pull({ onProgress });

        expect(result.success).toBe(false);
        expect("reason" in result && result.reason).toBe("lock-busy");
        expect(events).toEqual([]);
      } finally {
        held.release();
        f.cleanup();
      }
    });

    /**
     * Between the two hub-pull events, the detail comes from the stages: one
     * `hub-pull` percent per bundle from the fetch stage, and the importer's own
     * per-session phases, which `runApplySessionsStage` simply omitted at its
     * `importSession` call — so `--progress` on a pull reported nothing about
     * the work itself.
     */
    it("forwards the importer's per-session phases and one hub-pull percent per bundle", async () => {
      const f = await twoMachines("sesh-pull-prog-detail");
      const { events, onProgress } = recorder();
      try {
        const result = await f.pull({ onProgress });

        expect(result.success).toBe(true);
        // A one-bundle chain: bundle 0 of 1 reports 0%, and 100 is the
        // terminal event rather than the bundle's.
        expect(hubPhase(events)).toEqual([0, 0, 100]);
        const verify = events.filter((e) => e.phase === "import-verify");
        expect(verify).toHaveLength(1);
        expect(verify[0].sessionId).toBeTruthy();
        expect(events.some((e) => e.phase === "import-rewrite" && e.bytesTotal! > 0)).toBe(true);
      } finally {
        f.cleanup();
      }
    });

    /**
     * The terminal event fires from a `finally`, which is exactly where a
     * caller's throwing callback would REPLACE whatever the pull was reporting —
     * including `append.ts`'s refuse-and-throw, the loudest safety property in
     * the codebase. So it is wrapped, and a progress consumer's own fault is
     * never this operation's outcome.
     */
    it("does not let a throwing progress callback change the pull's outcome", async () => {
      const f = await twoMachines("sesh-pull-prog-throw");
      let calls = 0;
      try {
        const result = await f.pull({
          onProgress: (ev: ProgressEvent) => {
            calls++;
            if (ev.phase === "hub-pull" && ev.percent === 100) throw new Error("consumer blew up");
          },
        });

        expect(calls).toBeGreaterThan(0);
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect((result as HubPullResult).importedSessions.length).toBeGreaterThan(0);
      } finally {
        f.cleanup();
      }
    });
  });
});

/**
 * #59 item 3 — the shared-layer reconciliation reaches the PULL result as typed
 * fields, not only as warning prose.
 *
 * `commands/pull.md` branches on the fields and uses the warning for wording, so
 * a pull that parks a memory file and reports only a sentence cannot offer the
 * merge `/sesh-mover:import` offers: there is no `parkedAs` to act on. Warning
 * text is not an interface anywhere else in this result; it was not one here
 * either, and only the warnings crossed.
 */
describe("hub pull — the shared layers as typed result fields", () => {
  /** A's fixture memory, byte for byte, as `createFixtureTree` writes it. */
  const A_MEMORY_V1 = "Use vitest for testing.";
  const A_MEMORY_V2 = "---\nname: Test memory\n---\n\nSomething new was learned.\n";

  /** Machine A pushed the fixture thread; machine B is linked and has memory. */
  async function arrangeMemoryPull(label: string) {
    const homeA = mkdtempSync(join(tmpdir(), `${label}-homeA-`));
    const homeB = mkdtempSync(join(tmpdir(), `${label}-homeB-`));
    const hub = mkdtempSync(join(tmpdir(), `${label}-hub-`));
    const base = mkdtempSync(join(tmpdir(), `${label}-fix-`));
    let restore = overrideHome(homeA);
    const { configDir: configDirA } = createFixtureTree(base);
    const projectA = createRealProject(base, configDirA, "projA");
    const projectDirA = join(configDirA, "projects", encodeProjectPath(projectA));
    await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
    const first = await hubPush({
      configDir: configDirA, projectPath: projectA, hubPath: hub,
      createProject: true, noWorkspace: true, claudeVersion: "2.1.81",
    });
    if (!first.success) throw new Error("setup push failed");

    /**
     * A second push carrying a CHANGED memory. Both halves are required: the
     * exporter only ships `memory/` when its digest differs from the one the hub
     * peer is credited with, and `hub push` returns early with no bundle at all
     * when there is no new session content.
     */
    async function pushChangedMemory() {
      const back = overrideHome(homeA);
      try {
        writeFileSync(join(projectDirA, "memory", "test_memory.md"), A_MEMORY_V2);
        appendEntries(
          join(projectDirA, `${FIXTURE_SESSION_ID}.jsonl`),
          moreEntries(FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, projectA)
        );
        const second = await hubPush({
          configDir: configDirA, projectPath: projectA, hubPath: hub,
          noWorkspace: true, claudeVersion: "2.1.81",
        });
        if (!second.success) throw new Error("second push failed");
      } finally {
        back.restore();
      }
    }

    const toB = () => {
      restore.restore();
      restore = overrideHome(homeB);
    };

    const configDirB = join(homeB, ".claude");
    const projectB = mkdtempSync(join(tmpdir(), `${label}-projB-`));
    const memDirB = join(configDirB, "projects", encodeProjectPath(projectB), "memory");

    return {
      hub, projectId: first.projectId, configDirB, projectB, memDirB, toB,
      pushChangedMemory,
      /** Give B a memory of the same name with different text — a tier-2 conflict. */
      seedConflictingMemory() {
        mkdirSync(memDirB, { recursive: true });
        writeFileSync(join(memDirB, "MEMORY.md"), "- [Test memory](test_memory.md) — my version\n");
        writeFileSync(join(memDirB, "test_memory.md"), "---\nname: Test memory\n---\n\nMine, not theirs.\n");
      },
      link() {
        writeLocalProjectId(projectB, {
          projectId: first.projectId, name: "projA",
          createdAt: new Date().toISOString(), createdByMachine: "machine-a",
        });
      },
      pull: (over: Record<string, unknown> = {}) =>
        hubPull({
          configDir: configDirB, projectPath: projectB, hubPath: hub,
          latest: true, claudeVersion: "2.1.81", ...over,
        } as HubPullOptions),
      cleanup: () => {
        restore.restore();
        for (const d of [homeA, homeB, hub, base, projectB]) {
          rmSync(d, { recursive: true, force: true });
        }
      },
    };
  }

  it("a pull that parks a memory file exposes the parked path as a TYPED field", async () => {
    const f = await arrangeMemoryPull("sesh-pull-mem1");
    try {
      f.toB();
      f.link();
      f.seedConflictingMemory();

      const pull = await f.pull();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.importedSessions).toHaveLength(1);

      // The point of the whole issue: `parkedAs` and `memoryDir` are fields, so
      // the skill layer can find both texts on disk without parsing a sentence.
      expect(p.memoryDir).toBe(f.memDirB);
      expect(p.memoryConflicts).toHaveLength(1);
      const conflict = p.memoryConflicts![0];
      expect(conflict.filename).toBe("test_memory.md");
      expect(conflict.parkedAs).toBe("test_memory.incoming.md");
      expect(conflict.existingHash).not.toBe(conflict.incomingHash);

      // And the union ran — the #49 half of the same reconciliation. Both sides
      // point at `test_memory.md`, so it deduped rather than appending.
      // `added`/`alreadyPresent` describe the UNION only; the pointer at the
      // parked copy is written by the parking step and reported through
      // `memoryConflicts[].parkedAs`, not counted here.
      expect(p.memoryIndex).toBeDefined();
      expect(p.memoryIndex!.added).toEqual([]);
      expect(p.memoryIndex!.alreadyPresent).toBe(1);
      expect(p.memoryIndex!.unindexed).toEqual([]);

      // The fields describe files that really are there, and the local one was
      // not touched.
      expect(readTextLf(join(f.memDirB, conflict.filename))).toContain("Mine, not theirs.");
      expect(readTextLf(join(f.memDirB, conflict.parkedAs!))).toContain(A_MEMORY_V1);
      expect(readTextLf(join(f.memDirB, "MEMORY.md"))).toContain("(test_memory.incoming.md)");
    } finally {
      f.cleanup();
    }
  });

  it("a chain of bundles reports EVERY parked memory, not just the last bundle's", async () => {
    const f = await arrangeMemoryPull("sesh-pull-mem2");
    try {
      await f.pushChangedMemory();
      f.toB();
      f.link();
      f.seedConflictingMemory();

      // --no-append so both bundles go through an import rather than the second
      // being spliced onto the first; the aggregation is what is under test.
      const pull = await f.pull({ noAppend: true });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.importedSessions.length).toBeGreaterThan(1);

      // Two bundles, two different incoming versions, two parked copies — and
      // the result names both. Reporting only the last bundle's is the failure
      // this asserts against.
      expect(p.memoryConflicts).toHaveLength(2);
      const parked = p.memoryConflicts!.map((c) => c.parkedAs);
      expect(parked).toEqual(["test_memory.incoming.md", "test_memory.incoming-2.md"]);
      expect(readTextLf(join(f.memDirB, "test_memory.incoming.md"))).toContain(A_MEMORY_V1);
      expect(readTextLf(join(f.memDirB, "test_memory.incoming-2.md"))).toContain(
        "Something new was learned."
      );
      // Still exactly one local file, untouched.
      expect(readTextLf(join(f.memDirB, "test_memory.md"))).toContain("Mine, not theirs.");
      for (const name of parked) {
        expect(readTextLf(join(f.memDirB, "MEMORY.md"))).toContain(`(${name})`);
      }
    } finally {
      f.cleanup();
    }
  });

  it("a pull with no memory conflict says so by omission, not with an empty array", async () => {
    const f = await arrangeMemoryPull("sesh-pull-mem3");
    try {
      f.toB();
      f.link();

      const pull = await f.pull();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      expect(p.memoryConflicts).toBeUndefined();
      expect(p.planConflicts).toBeUndefined();
      // The layer still arrived and was reconciled — `memoryDir` and the index
      // report say so, which is what tells a caller "memory landed clean" apart
      // from "this bundle carried none".
      expect(p.memoryDir).toBe(f.memDirB);
      expect(p.memoryIndex).toBeDefined();
      expect(readTextLf(join(f.memDirB, "test_memory.md"))).toContain(A_MEMORY_V1);
    } finally {
      f.cleanup();
    }
  });
});
