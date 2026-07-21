import { describe, it, expect } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { hubPull } from "../src/hub/pull.js";
import { hubWhereis } from "../src/hub/whereis.js";
import { createFsBackend } from "../src/hub/backend.js";
import { readAllIndexes } from "../src/hub/index-file.js";
import { indexPath } from "../src/hub/layout.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { encodeProjectPath } from "../src/platform.js";
import type { HubPullResult, HubPushResult, NotYetSyncedResult } from "../src/types.js";

// Keystone integration suite (spec §9): a full A -> B -> A round trip through
// REAL temp dirs, simulating two machines via distinct HOME overrides (each
// with its own ~/.claude-sesh-mover/machine-id.json) sharing ONE hub
// directory. This proves the Slice-1 flow end-to-end; branch/edge coverage
// for each orchestrator already lives in its own per-task test file — this
// file asserts through public results and filesystem counts only.

const CLAUDE_VERSION = "2.1.81";
const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

// Same technique every other hub test uses: hub identity linking writes a
// real `.claude-sesh-mover/project.json` under the project directory, and
// this sandbox has no permission to create top-level dirs like "/Users" — so
// every hub test operates against a REAL git-less directory, with the
// fixture's session content copied into its encoded config-dir slot.
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

function sessionFilePath(configDir: string, projectPath: string, sessionId: string): string {
  return join(configDir, "projects", encodeProjectPath(projectPath), `${sessionId}.jsonl`);
}

function lastUuid(path: string): string {
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  return (JSON.parse(lines[lines.length - 1]) as { uuid: string }).uuid;
}

// Appends two fresh user entries (fixture entry shape, parentUuid-chained
// onto whatever is currently last in the file) directly onto an imported
// session's live JSONL — simulating machine B continuing the conversation
// after pulling it.
function appendContinuationEntries(path: string, sessionId: string, cwd: string): void {
  const parent = lastUuid(path);
  const e1 = {
    uuid: "b-append-1", parentUuid: parent, timestamp: "2026-07-21T01:00:00Z",
    sessionId, cwd, version: CLAUDE_VERSION, type: "user",
    message: { role: "user", content: "picking this up on machine B" },
  };
  const e2 = {
    uuid: "b-append-2", parentUuid: "b-append-1", timestamp: "2026-07-21T01:00:05Z",
    sessionId, cwd, version: CLAUDE_VERSION, type: "user",
    message: { role: "user", content: "and one more thought" },
  };
  appendFileSync(path, JSON.stringify(e1) + "\n" + JSON.stringify(e2) + "\n");
}

interface ThreeMachineFixture {
  hub: string;
  homeA: string;
  homeB: string;
  baseA: string;
  projectB: string;
  configDirA: string;
  projectA: string;
  configDirB: string;
  pushA: HubPushResult;
  pullB1: HubPullResult;
  pushB: HubPushResult;
  machineIdA: string;
  machineIdB: string;
  restore: HomeOverrideHandle;
  // Snapshots taken immediately after phase 1 (before B's later push adds its
  // own index/bundles to the hub) — assertions about "just after A's first
  // push" must read these, not re-query hub state after all phases ran.
  indexCountAfterPush1: number;
  bundleCountAfterPush1: number;
}

// Phases 1-3 of the brief, shared by every test below: A pushes a full
// bundle, B joins and pulls it, then B appends two entries and pushes back.
// Leaves HOME overridden to B on return (callers needing A re-override it).
async function setupThroughAppendPush(prefix: string): Promise<ThreeMachineFixture> {
  const hub = mkdtempSync(join(tmpdir(), `${prefix}-hub-`));
  const homeA = mkdtempSync(join(tmpdir(), `${prefix}-homeA-`));
  const homeB = mkdtempSync(join(tmpdir(), `${prefix}-homeB-`));
  const baseA = mkdtempSync(join(tmpdir(), `${prefix}-fixA-`));
  const projectB = mkdtempSync(join(tmpdir(), `${prefix}-projB-`));

  let restore = overrideHome(homeA);
  // Self-cleaning: this helper runs BEFORE its caller's own try/finally, so
  // if any step below throws (e.g. an unexpected phase failure) it must
  // still restore HOME and remove its temp dirs itself — otherwise a
  // dangling HOME override would cascade into every later test in this
  // worker process instead of failing just this one.
  try {
    // Phase 1 (A): join the hub, push the fixture session as a brand-new hub
    // project. First push of a never-before-shared session -> one full bundle.
    const { configDir: configDirA } = createFixtureTree(baseA);
    const projectA = createRealProject(baseA, configDirA, "proj");
    const initA = await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
    if (!initA.success) throw new Error(`hubInit(A) failed: ${JSON.stringify(initA)}`);
    const machineIdA = loadOrCreateMachineId().id;

    const pushA = await hubPush({
      configDir: configDirA, projectPath: projectA, hubPath: hub,
      createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
    });
    if (!pushA.success) throw new Error(`phase1 push failed: ${JSON.stringify(pushA)}`);

    const backendSnapshot = createFsBackend(hub);
    const { indexes: indexesAfterPush1 } = await readAllIndexes(backendSnapshot, pushA.projectId);
    const indexCountAfterPush1 = indexesAfterPush1.length;
    const bundleCountAfterPush1 = Object.values(indexesAfterPush1[0]?.threads ?? {})[0]?.bundles.length ?? 0;

    // Phase 2 (B): a distinct machine (distinct HOME -> distinct machine-id.json)
    // joins the same hub and pulls the only thread available.
    restore.restore();
    restore = overrideHome(homeB);
    const configDirB = join(homeB, ".claude");
    const initB = await hubInit({ hubPath: hub, configScope: "user", cwd: homeB });
    if (!initB.success) throw new Error(`hubInit(B) failed: ${JSON.stringify(initB)}`);
    const machineIdB = loadOrCreateMachineId().id;

    writeLocalProjectId(projectB, {
      projectId: pushA.projectId, name: "proj",
      createdAt: new Date().toISOString(), createdByMachine: machineIdA,
    });

    const pullB1Raw = await hubPull({
      configDir: configDirB, projectPath: projectB, hubPath: hub,
      latest: true, claudeVersion: CLAUDE_VERSION,
    });
    if (!pullB1Raw.success) throw new Error(`phase2 pull failed: ${JSON.stringify(pullB1Raw)}`);
    const pullB1 = pullB1Raw as HubPullResult;

    // Phase 3 (B): continue the conversation locally, then push. The
    // incremental machinery must recognize this as hub-mediated continuation
    // content, not a fresh full copy.
    const localSessionId = pullB1.localSessionId!;
    const sessionPath = sessionFilePath(configDirB, projectB, localSessionId);
    appendContinuationEntries(sessionPath, localSessionId, projectB);

    const pushB = await hubPush({
      configDir: configDirB, projectPath: projectB, hubPath: hub, claudeVersion: CLAUDE_VERSION,
    });
    if (!pushB.success) throw new Error(`phase3 push failed: ${JSON.stringify(pushB)}`);

    return {
      hub, homeA, homeB, baseA, projectB, configDirA, projectA, configDirB,
      pushA, pullB1, pushB, machineIdA, machineIdB, restore,
      indexCountAfterPush1, bundleCountAfterPush1,
    };
  } catch (e) {
    restore.restore();
    for (const d of [hub, homeA, homeB, baseA, projectB]) rmSync(d, { recursive: true, force: true });
    throw e;
  }
}

function cleanup(f: ThreeMachineFixture): void {
  f.restore.restore();
  for (const d of [f.hub, f.homeA, f.homeB, f.baseA, f.projectB]) rmSync(d, { recursive: true, force: true });
}

describe("hub keystone: multi-machine round trip", () => {
  it("A pushes, B pulls and continues, A pulls back to one unified thread, then idempotent", async () => {
    const f = await setupThroughAppendPush("sesh-keystone");
    try {
      // Phase 1 assertions: exactly one full bundle landed on the hub.
      expect(f.pushA.pushedSessions).toHaveLength(1);
      expect(f.pushA.pushedSessions[0].type).toBe("full");
      expect(f.indexCountAfterPush1).toBe(1);
      expect(f.bundleCountAfterPush1).toBe(1);

      // Phase 2 assertions: B imported exactly one session, and its own
      // local copy is reported current.
      expect(f.pullB1.importedSessions).toHaveLength(1);
      expect(f.pullB1.skippedSessions).toHaveLength(0);
      const whereisB1 = await hubWhereis({ configDir: f.configDirB, projectPath: f.projectB, hubPath: f.hub });
      expect(whereisB1.linked).toBe(true);
      const threadB1 = whereisB1.threads.find((t) => t.threadId === f.pullB1.threadId);
      expect(threadB1).toBeDefined();
      expect(threadB1!.localCopy).not.toBeNull();
      expect(threadB1!.localCopy!.current).toBe(true);

      // Phase 3 assertion: the incremental machinery engaged hub-mediated —
      // this is a continuation of the thread, not a second full copy.
      expect(f.pushB.pushedSessions).toHaveLength(1);
      expect(f.pushB.pushedSessions[0].type).toBe("continuation");
      expect(f.pushB.pushedSessions[0].threadId).toBe(f.pullB1.threadId);

      // Phase 4 (A): pull the continuation back.
      f.restore.restore();
      const restoreA = overrideHome(f.homeA);
      try {
        const pullA = await hubPull({
          configDir: f.configDirA, projectPath: f.projectA, hubPath: f.hub,
          latest: true, claudeVersion: CLAUDE_VERSION,
        });
        expect(pullA.success).toBe(true);
        if (!pullA.success) return;
        const pA = pullA as HubPullResult;
        expect(pA.importedSessions).toHaveLength(1);
        expect(pA.threadId).toBe(f.pullB1.threadId);

        // The milestone's core promise: A now sees ONE thread for this
        // project, current locally, whose copies span BOTH machines.
        const whereisA = await hubWhereis({ configDir: f.configDirA, projectPath: f.projectA, hubPath: f.hub });
        expect(whereisA.threads).toHaveLength(1);
        const threadA = whereisA.threads[0];
        expect(threadA.threadId).toBe(f.pullB1.threadId);
        expect(threadA.localCopy).not.toBeNull();
        expect(threadA.localCopy!.current).toBe(true);
        expect(threadA.copies.map((c) => c.machineId).sort()).toEqual(
          [f.machineIdA, f.machineIdB].sort()
        );

        // Phase 5 (A): pulling again is a no-op — nothing left to pull, and
        // no new session file appears (dedup idempotency).
        const projectDirA = join(f.configDirA, "projects", encodeProjectPath(f.projectA));
        const filesBefore = readdirSync(projectDirA).filter((n) => n.endsWith(".jsonl"));

        const pullA2 = await hubPull({
          configDir: f.configDirA, projectPath: f.projectA, hubPath: f.hub,
          latest: true, claudeVersion: CLAUDE_VERSION,
        });
        expect(pullA2.success).toBe(false);

        const filesAfter = readdirSync(projectDirA).filter((n) => n.endsWith(".jsonl"));
        expect(filesAfter).toEqual(filesBefore);
      } finally {
        restoreA.restore();
      }
    } finally {
      cleanup(f);
    }
  });

  it("sync-lag: a missing bundle in a real (full + continuation) chain blocks a fresh machine's pull", async () => {
    const f = await setupThroughAppendPush("sesh-keystone-lag");
    try {
      // The thread now has a genuine two-bundle chain on the hub (A's
      // original full push, B's continuation push) — delete the
      // continuation bundle to simulate a sync client that hasn't finished
      // materializing the latest file yet.
      const backend = createFsBackend(f.hub);
      const { indexes } = await readAllIndexes(backend, f.pushA.projectId);
      const allBundles = indexes.flatMap((idx) => Object.values(idx.threads)).flatMap((t) => t.bundles);
      expect(allBundles.length).toBeGreaterThanOrEqual(2);
      const continuationBundle = allBundles.find((b) => b.type === "continuation");
      expect(continuationBundle).toBeDefined();
      await backend.delete(continuationBundle!.file);

      // A fresh machine (fresh HOME, fresh project dir) joins the hub and
      // tries to pull the thread's latest.
      f.restore.restore();
      const homeC = mkdtempSync(join(tmpdir(), "sesh-keystone-lag-homeC-"));
      const projectC = mkdtempSync(join(tmpdir(), "sesh-keystone-lag-projC-"));
      const restoreC = overrideHome(homeC);
      try {
        const configDirC = join(homeC, ".claude");
        const initC = await hubInit({ hubPath: f.hub, configScope: "user", cwd: homeC });
        expect(initC.success).toBe(true);
        writeLocalProjectId(projectC, {
          projectId: f.pushA.projectId, name: "proj",
          createdAt: new Date().toISOString(), createdByMachine: f.machineIdA,
        });

        const pullC = await hubPull({
          configDir: configDirC, projectPath: projectC, hubPath: f.hub,
          latest: true, claudeVersion: CLAUDE_VERSION,
        });
        expect(pullC.success).toBe(false);
        if (pullC.success) return;
        const notSynced = pullC as NotYetSyncedResult;
        expect(notSynced.reason).toBe("not-yet-synced");
        expect(notSynced.missing).toContain(continuationBundle!.file);
      } finally {
        restoreC.restore();
        rmSync(homeC, { recursive: true, force: true });
        rmSync(projectC, { recursive: true, force: true });
      }
    } finally {
      cleanup(f);
    }
  });

  it("torn index: machine A's real index file corrupted still lets B's own thread copy resolve, warning names A", async () => {
    const f = await setupThroughAppendPush("sesh-keystone-torn");
    try {
      // Corrupt A's REAL index file (written during phase 1's push) in
      // place — B's own index (written during phase 3's push) is untouched.
      const backend = createFsBackend(f.hub);
      await backend.writeAtomic(indexPath(f.pushA.projectId, f.machineIdA), "{bad");

      const whereisB = await hubWhereis({ configDir: f.configDirB, projectPath: f.projectB, hubPath: f.hub });
      expect(whereisB.linked).toBe(true);
      // B's own copy of the thread (from B's still-readable index) is
      // returned despite A's index being unreadable.
      expect(whereisB.threads).toHaveLength(1);
      const thread = whereisB.threads[0];
      expect(thread.threadId).toBe(f.pullB1.threadId);
      expect(thread.copies.some((c) => c.machineId === f.machineIdB)).toBe(true);
      expect(whereisB.warnings.join(" ")).toContain(f.machineIdA);
    } finally {
      cleanup(f);
    }
  });
});
