import { describe, it, expect } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, cpSync,
  utimesSync, existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPEND_LIVE_WINDOW_MS } from "../src/hub/append.js";
import { overrideHome, homeEnv, type HomeOverrideHandle } from "./helpers/env.js";
import { readTextLf } from "./helpers/eol.js";
import { runCli } from "./helpers/run-cli.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { hubPull } from "../src/hub/pull.js";
import { hubWhereis } from "../src/hub/whereis.js";
import { createFsBackend } from "../src/hub/backend.js";
import { readAllIndexes } from "../src/hub/index-file.js";
import { bundleDir, indexPath } from "../src/hub/layout.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { setMachineName } from "../src/machine.js";
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

/**
 * Put a session's mtime far outside `APPEND_LIVE_WINDOW_MS` — i.e. state, as
 * the fixture, the one fact the scenario depends on: nobody is writing to this
 * transcript right now.
 *
 * Load-bearing, not cosmetic. A test that writes to the base with
 * `appendFileSync` and then pulls leaves the base's mtime at "now", and the
 * splice then only happens by accident: append.ts's self-write exemption
 * (`mtime >= opNowMs`) is the only thing keeping the liveness guard quiet, and
 * it holds only while the pull's `Date.now()` — truncated to a whole
 * millisecond — is still <= that fractional mtime. The fixture write and the
 * pull's clock read are ~110 us apart, so ~10% of runs have a millisecond
 * boundary fall between them: the exemption misses, the base looks live, and
 * the first continuation lands as a fragment. Same failure class, and same
 * remedy, as `ageToLive` in hub-append.test.ts and `makeLookLive` /
 * `ageOutOfLiveWindow` in hub-pull.test.ts.
 */
function ageOutOfLiveWindow(path: string): void {
  const old = new Date(Date.now() - APPEND_LIVE_WINDOW_MS - 60_000);
  utimesSync(path, old, old);
}

function readEntries(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

function jsonlFiles(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
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
  machineNameB: string;
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
    // Distinct, stated machine NAMES: both temp homes run on one host, so the
    // hostname default would give A and B the same name and any assertion about
    // "which machine is this notice about" would pass vacuously. The push below
    // re-registers the machine on the hub, so the rename lands there.
    const machineIdA = setMachineName("keystone-machine-a").id;

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
    const machineNameB = "keystone-machine-b";
    const machineIdB = setMachineName(machineNameB).id;

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
      pushA, pullB1, pushB, machineIdA, machineIdB, machineNameB, restore,
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
  // THE milestone assertion (design §10, "keystone extension"): the round trip
  // closes back into the ORIGINAL session file, not into a second one.
  //
  // This test used to assert the opposite — `importedSessions` of length 1,
  // i.e. a fragment — and it passed for a reason that was nothing to do with
  // intent: A's base carried the mtime of the fixture's own `cpSync`, a few
  // hundred milliseconds before the pull's clock read, so append.ts's liveness
  // guard called it a live session and declined. The fixture's setup cost was
  // deciding the product behaviour under test. Task 12 flipped it deliberately:
  // the age of A's base is now STATED (`ageOutOfLiveWindow` — the user left
  // this session and is pulling it back), and with the guard answering the
  // question it was written to answer, the continuation splices.
  it("A pushes, B pulls and continues, A pulls the continuation back INTO its own session, then idempotent", async () => {
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
        const localA = f.pushA.pushedSessions[0].sessionId;
        const pathA = sessionFilePath(f.configDirA, f.projectA, localA);
        const projectDirA = join(f.configDirA, "projects", encodeProjectPath(f.projectA));
        const filesBeforePull = jsonlFiles(projectDirA);
        const entriesBeforePull = readEntries(pathA).length;
        // A's session is one the user left on this machine and is now pulling
        // back into — not one being written this instant. Say so, rather than
        // racing the pull's clock (see `ageOutOfLiveWindow`).
        ageOutOfLiveWindow(pathA);

        const pullA = await hubPull({
          configDir: f.configDirA, projectPath: f.projectA, hubPath: f.hub,
          latest: true, claudeVersion: CLAUDE_VERSION,
        });
        expect(pullA.success).toBe(true);
        if (!pullA.success) return;
        const pA = pullA as HubPullResult;
        expect(pA.threadId).toBe(f.pullB1.threadId);

        // Appended, not imported: no new session file, and A's own file grew by
        // exactly the two entries B wrote.
        expect(pA.importedSessions).toHaveLength(0);
        expect(pA.appended ?? []).toHaveLength(1);
        expect(pA.appended![0]).toMatchObject({
          threadId: f.pullB1.threadId, baseSessionId: localA, entriesAppended: 2,
        });
        expect(pA.localSessionId).toBe(localA);
        expect(jsonlFiles(projectDirA)).toEqual(filesBeforePull);

        const after = readEntries(pathA);
        expect(after).toHaveLength(entriesBeforePull + 2);
        expect(lastUuid(pathA)).toBe("b-append-2"); // B's last uuid is now A's head
        expect(after.map((e) => e.uuid)).toContain("b-append-1");
        // One transcript, one identity: everything spliced in belongs to A's
        // session now, so `claude --resume <localA>` replays the whole thing.
        expect(after.every((e) => e.sessionId === localA)).toBe(true);
        // And it is one unbroken chain — B's first entry hangs off A's old head.
        expect(after[entriesBeforePull].parentUuid).toBe(after[entriesBeforePull - 1].uuid);

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
        // no new session file appears (dedup idempotency). The splice published
        // B's head as A's own, so this is the "all threads are current" branch
        // rather than the per-source "already up to date" one.
        const pullA2 = await hubPull({
          configDir: f.configDirA, projectPath: f.projectA, hubPath: f.hub,
          latest: true, claudeVersion: CLAUDE_VERSION,
        });
        expect(pullA2.success).toBe(false);
        if (!pullA2.success) expect("error" in pullA2 && pullA2.error).toMatch(/nothing to pull/i);

        expect(jsonlFiles(projectDirA)).toEqual(filesBeforePull);
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
      // Two bundles for this thread exist ON THE HUB (A's original full push,
      // B's continuation push) — but they sit in two different machines'
      // indexes, and a pull only ever fetches the chosen source's list, so
      // this pull needs B's continuation alone. Deleting it simulates a sync
      // client that hasn't finished materializing the latest file yet.
      //
      // Do NOT read this as evidence that a cross-machine chain pulls whole:
      // it doesn't. See the Task 12 carry in the SDD ledger.
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
  // Task 6b, end to end over a REALISTIC transcript. Claude Code brackets
  // conversation entries with uuid-less bookkeeping, so all three of these are
  // the normal case, not edge cases:
  //   - the local base's final line is bookkeeping (head derivation),
  //   - the delta's FIRST unsent line is bookkeeping (slice boundary),
  //   - the delta's final line is bookkeeping (delta head derivation).
  // Before the bounded conversation scan the base head was `null`, the chain
  // guard could never match, and this pull produced a second, fragmentary
  // session file instead of one continuous transcript.
  it("splices into ONE session when both transcripts are bracketed by uuid-less bookkeeping", async () => {
    const f = await setupThroughAppendPush("sesh-keystone-bk");
    try {
      // Phase 3b (B): bookkeeping, two more messages, then more bookkeeping.
      // The recorded head from phase 3 is `b-append-2`, so the next unsent line
      // — where the continuation slice starts — is a uuid-less entry.
      const localB = f.pullB1.localSessionId!;
      const pathB = sessionFilePath(f.configDirB, f.projectB, localB);
      appendFileSync(
        pathB,
        [
          { type: "last-prompt", lastPrompt: "more", leafUuid: "b-append-2", sessionId: localB },
          { type: "mode", mode: "normal", sessionId: localB },
          {
            uuid: "b-append-3", parentUuid: "b-append-2", timestamp: "2026-07-21T02:00:00Z",
            sessionId: localB, cwd: f.projectB, version: CLAUDE_VERSION, type: "user",
            message: { role: "user", content: "third thought" },
          },
          {
            uuid: "b-append-4", parentUuid: "b-append-3", timestamp: "2026-07-21T02:00:05Z",
            sessionId: localB, cwd: f.projectB, version: CLAUDE_VERSION, type: "user",
            message: { role: "user", content: "fourth thought" },
          },
          {
            type: "pr-link", sessionId: localB, prNumber: 12,
            prUrl: "https://example.test/12", prRepository: "o/r",
            timestamp: "2026-07-21T02:30:00Z",
          },
          { type: "permission-mode", permissionMode: "auto", sessionId: localB },
        ].map((e) => JSON.stringify(e)).join("\n") + "\n"
      );
      const pushB2 = await hubPush({
        configDir: f.configDirB, projectPath: f.projectB, hubPath: f.hub,
        claudeVersion: CLAUDE_VERSION,
      });
      expect(pushB2.success).toBe(true);
      if (!pushB2.success) return;
      expect(pushB2.pushedSessions[0].type).toBe("continuation");

      // Phase 4 (A): give A's own base a bookkeeping tail too, then pull.
      f.restore.restore();
      const restoreA = overrideHome(f.homeA);
      try {
        const localA = f.pushA.pushedSessions[0].sessionId;
        const pathA = sessionFilePath(f.configDirA, f.projectA, localA);
        const headA = lastUuid(pathA);
        appendFileSync(
          pathA,
          [
            { type: "last-prompt", lastPrompt: "waiting", leafUuid: headA, sessionId: localA },
            {
              type: "file-history-snapshot", messageId: headA,
              snapshot: { files: {} }, isSnapshotUpdate: false, sessionId: localA,
            },
          ].map((e) => JSON.stringify(e)).join("\n") + "\n"
        );
        // A's session is one the user left and is now pulling back into — not
        // one being written this instant. Say so, rather than racing the pull's
        // clock for the self-write exemption (see `ageOutOfLiveWindow`).
        ageOutOfLiveWindow(pathA);

        const projectDirA = join(f.configDirA, "projects", encodeProjectPath(f.projectA));
        const filesBefore = readdirSync(projectDirA).filter((n) => n.endsWith(".jsonl"));

        const pullA = await hubPull({
          configDir: f.configDirA, projectPath: f.projectA, hubPath: f.hub,
          latest: true, claudeVersion: CLAUDE_VERSION,
        });
        expect(pullA.success).toBe(true);
        if (!pullA.success) return;
        const pA = pullA as HubPullResult;

        // Spliced, not fragmented: both of B's bundles landed in A's own file.
        // Asserting the COUNT, not just "non-empty": if the first continuation
        // is declined for any reason it becomes a fragment session, and the
        // second one then legitimately splices onto that fragment — a run with
        // one append onto the wrong base is the exact shape of the bug this
        // test exists to catch, so it has to fail here rather than downstream.
        expect(pA.appended ?? []).toHaveLength(2);
        expect((pA.appended ?? []).every((a) => a.baseSessionId === localA)).toBe(true);
        expect(pA.importedSessions).toHaveLength(0);
        expect(readdirSync(projectDirA).filter((n) => n.endsWith(".jsonl"))).toEqual(filesBefore);

        const after = readFileSync(pathA, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        const uuids = after.map((e) => e.uuid).filter(Boolean);
        expect(uuids).toContain("b-append-1");
        expect(uuids).toContain("b-append-4");
        expect(uuids[uuids.length - 1]).toBe("b-append-4"); // one continuous chain
        // A's own pre-existing bookkeeping survived the splice untouched, and
        // B's travelled with the delta rather than being dropped in transit.
        expect(after.filter((e) => e.type === "file-history-snapshot")).toHaveLength(1);
        expect(after.filter((e) => e.type === "pr-link")).toHaveLength(1);
        // Everything spliced in belongs to A's session now.
        expect(after.every((e) => e.sessionId === localA)).toBe(true);
      } finally {
        restoreA.restore();
      }
    } finally {
      cleanup(f);
    }
  });

  // The other half of the headline promise: a machine that was never part of
  // the conversation gets ONE session, not 1 + N fragments. Nothing here ages
  // anything out of the liveness window on purpose — C writes the base itself,
  // in this same pull, and the self-write exemption (one `opNowMs` for the
  // whole operation) is precisely what has to hold for the continuation to land
  // in the file the full bundle just created.
  it("a fresh machine pulling a full+continuation chain lands ONE session, in order, header-free", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-keystone-chain-hub-"));
    const homeA = mkdtempSync(join(tmpdir(), "sesh-keystone-chain-homeA-"));
    const homeC = mkdtempSync(join(tmpdir(), "sesh-keystone-chain-homeC-"));
    const baseA = mkdtempSync(join(tmpdir(), "sesh-keystone-chain-fixA-"));
    const projectC = mkdtempSync(join(tmpdir(), "sesh-keystone-chain-projC-"));
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(baseA);
      const projectA = createRealProject(baseA, configDirA, "proj");
      const initA = await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      expect(initA.success).toBe(true);
      const machineIdA = setMachineName("keystone-chain-a").id;

      const push1 = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(push1.success).toBe(true);
      if (!push1.success) return;
      expect(push1.pushedSessions[0].type).toBe("full");

      const localA = push1.pushedSessions[0].sessionId;
      const pathA = sessionFilePath(configDirA, projectA, localA);
      const historyUuids = readEntries(pathA).map((e) => e.uuid);
      appendContinuationEntries(pathA, localA, projectA);
      const push2 = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(push2.success).toBe(true);
      if (!push2.success) return;
      expect(push2.pushedSessions[0].type).toBe("continuation");

      restore.restore();
      const restoreC = overrideHome(homeC);
      try {
        const configDirC = join(homeC, ".claude");
        const initC = await hubInit({ hubPath: hub, configScope: "user", cwd: homeC });
        expect(initC.success).toBe(true);
        setMachineName("keystone-chain-c");
        writeLocalProjectId(projectC, {
          projectId: push1.projectId, name: "proj",
          createdAt: new Date().toISOString(), createdByMachine: machineIdA,
        });

        const pullC = await hubPull({
          configDir: configDirC, projectPath: projectC, hubPath: hub,
          latest: true, claudeVersion: CLAUDE_VERSION,
        });
        expect(pullC.success).toBe(true);
        if (!pullC.success) return;
        const pC = pullC as HubPullResult;
        expect(pC.importedSessions).toHaveLength(1);
        expect(pC.appended ?? []).toHaveLength(1);

        const projectDirC = join(configDirC, "projects", encodeProjectPath(projectC));
        const files = jsonlFiles(projectDirC);
        expect(files).toHaveLength(1);
        const landed = join(projectDirC, files[0]);
        const entries = readEntries(landed);
        expect(entries.map((e) => e.uuid)).toEqual([...historyUuids, "b-append-1", "b-append-2"]);
        expect(entries.every((e) => e.sessionId === pC.localSessionId)).toBe(true);
        // One transcript means no seam: the synthetic header exists to explain
        // a fragment, so its presence anywhere here would mean the chain was
        // NOT reassembled.
        expect(readFileSync(landed, "utf-8")).not.toContain("[sesh-mover continuation]");
      } finally {
        restoreC.restore();
      }
    } finally {
      restore.restore();
      for (const d of [hub, homeA, homeC, baseA, projectC]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("divergence: adopt-hub makes the hub's branch canonical and keeps A's fork as a second complete session", async () => {
    const f = await setupThroughAppendPush("sesh-keystone-fork");
    try {
      f.restore.restore();
      const restoreA = overrideHome(f.homeA);
      try {
        const localA = f.pushA.pushedSessions[0].sessionId;
        const pathA = sessionFilePath(f.configDirA, f.projectA, localA);
        const projectDirA = join(f.configDirA, "projects", encodeProjectPath(f.projectA));
        // A genuine two-sided fork: A carried on from the SAME entry B
        // continued from, so neither branch contains the other.
        const anchor = lastUuid(pathA);
        const commonHistory = readEntries(pathA).map((e) => e.uuid);
        appendFileSync(
          pathA,
          [
            {
              uuid: "a-fork-1", parentUuid: anchor, timestamp: "2026-07-21T03:00:00Z",
              sessionId: localA, cwd: f.projectA, version: CLAUDE_VERSION, type: "user",
              message: { role: "user", content: "meanwhile, back on machine A" },
            },
            {
              uuid: "a-fork-2", parentUuid: "a-fork-1", timestamp: "2026-07-21T03:00:05Z",
              sessionId: localA, cwd: f.projectA, version: CLAUDE_VERSION, type: "user",
              message: { role: "user", content: "and a second local thought" },
            },
          ].map((e) => JSON.stringify(e)).join("\n") + "\n"
        );
        // Adoption truncates a transcript the user owns, so pull refuses it
        // outright on a base that looks live. State that this session was left
        // behind rather than leaning on a clock coincidence.
        ageOutOfLiveWindow(pathA);

        const pullA = await hubPull({
          configDir: f.configDirA, projectPath: f.projectA, hubPath: f.hub,
          latest: true, onDivergence: "adopt-hub", claudeVersion: CLAUDE_VERSION,
        });
        expect(pullA.success).toBe(true);
        if (!pullA.success) return;
        const pA = pullA as HubPullResult;

        expect(pA.divergence?.resolution).toBe("adopt-hub");
        expect(pA.divergence?.adoptAvailable).toBe(true);
        const preservedId = pA.divergence?.preservedSessionId;
        expect(typeof preservedId).toBe("string");
        expect(pA.appended ?? []).toHaveLength(1);
        expect(pA.appended![0].baseSessionId).toBe(localA);

        // The base IS the hub's branch now: common history, then B's entries,
        // and A's fork cut away from it.
        expect(readEntries(pathA).map((e) => e.uuid)).toEqual([
          ...commonHistory, "b-append-1", "b-append-2",
        ]);

        // ...and A's own branch survives in full, under its own session id, so
        // `claude --resume <preserved>` replays everything A ever had.
        const preservedPath = join(projectDirA, `${preservedId}.jsonl`);
        const preserved = readEntries(preservedPath);
        expect(preserved.map((e) => e.uuid)).toEqual([...commonHistory, "a-fork-1", "a-fork-2"]);
        expect(preserved.every((e) => e.sessionId === preservedId)).toBe(true);
        expect(jsonlFiles(projectDirA)).toHaveLength(2);

        // Registered where Claude Code lists sessions, and named as what it is.
        const history = readFileSync(join(f.configDirA, "history.jsonl"), "utf-8");
        const row = history.trim().split("\n").map((l) => JSON.parse(l) as { display: string; sessionId: string })
          .find((h) => h.sessionId === preservedId);
        expect(row).toBeDefined();
        expect(row!.display).toContain("local divergence");
      } finally {
        restoreA.restore();
      }
    } finally {
      cleanup(f);
    }
  });

  it("the SessionEnd hook endpoint pushes this project to the hub, silently", async () => {
    // CLI level on purpose: this is the path Claude Code actually takes, and it
    // is the only one that proves the endpoint's stdout/exit contract together
    // with a real push. No Claude Code involved — just the payload it sends.
    const f = await setupThroughAppendPush("sesh-keystone-hookend");
    try {
      f.restore.restore();
      const restoreA = overrideHome(f.homeA);
      try {
        const localA = f.pushA.pushedSessions[0].sessionId;
        const pathA = sessionFilePath(f.configDirA, f.projectA, localA);
        // Give the hook something to push: the session grew since A's own push.
        appendContinuationEntries(pathA, localA, f.projectA);

        const backend = createFsBackend(f.hub);
        const before = await backend.list(bundleDir(f.pushA.projectId, f.machineIdA));

        const r = runCli(["hub", "hook-session-end"], {
          env: { ...homeEnv(f.homeA), CLAUDE_CONFIG_DIR: f.configDirA },
          input: JSON.stringify({ cwd: f.projectA, session_id: localA, reason: "clear" }),
        });
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);

        const after = await backend.list(bundleDir(f.pushA.projectId, f.machineIdA));
        expect(after).toHaveLength(before.length + 1);
        // And it is a real continuation of the same thread, not a second copy:
        // the auto-push rides the same incremental bookkeeping a manual push
        // does, which is what keeps the hub cheap enough to hook at all.
        const { indexes } = await readAllIndexes(backend, f.pushA.projectId);
        const mine = indexes.find((i) => i.machineId === f.machineIdA)!;
        const thread = mine.threads[f.pullB1.threadId];
        expect(thread).toBeDefined();
        expect(thread.bundles.map((b) => b.type)).toEqual(["full", "continuation"]);
      } finally {
        restoreA.restore();
      }
    } finally {
      cleanup(f);
    }
  });

  it("the SessionStart hook endpoint announces the other machine's newer work", async () => {
    const f = await setupThroughAppendPush("sesh-keystone-hookstart");
    try {
      // A has not pulled B's continuation, so B genuinely holds newer work.
      // Every field in the notice below comes out of the REAL two-machine hub
      // state this fixture built — index, machine registry and thread slug —
      // rather than a hand-written index file.
      const r = runCli(["hub", "hook-session-start"], {
        env: { ...homeEnv(f.homeA), CLAUDE_CONFIG_DIR: f.configDirA },
        input: JSON.stringify({ cwd: f.projectA, session_id: "whatever", source: "startup" }),
      });
      expect(r.status).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      const context = parsed.hookSpecificOutput.additionalContext;
      expect(context).toContain(f.machineNameB);
      expect(context).toContain("test-session"); // the thread's slug
      expect(context).toContain("/sesh-mover:pull");
      expect(context).not.toContain("undefined");
    } finally {
      cleanup(f);
    }
  });

  // --- Composition seams: both halves of a pull in one operation -------------
  //
  // Slice 2 put three payload kinds on one bundle chain. Sessions and the
  // workspace merge ride the SAME pull (the merge is applied inside the bundle
  // loop, the splice right after it, against the same project); sessions and a
  // carry ride the same pull too, with the carry applied after the whole chain.
  // Each half is covered on its own in hub-pull/hub-merge/hub-carry; what is
  // only visible here is that neither half disturbs the other.

  it("one pull merges the workspace 3-way AND splices the continuation", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-keystone-ws-hub-"));
    const homeA = mkdtempSync(join(tmpdir(), "sesh-keystone-ws-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-keystone-ws-homeB-"));
    const baseA = mkdtempSync(join(tmpdir(), "sesh-keystone-ws-fixA-"));
    const projectB = mkdtempSync(join(tmpdir(), "sesh-keystone-ws-projB-"));
    const lines = (over: Record<number, string> = {}): string =>
      Array.from({ length: 10 }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(baseA);
      const projectA = createRealProject(baseA, configDirA, "proj");
      writeFileSync(join(projectA, "shared.txt"), lines());
      const initA = await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      expect(initA.success).toBe(true);
      const machineIdA = setMachineName("keystone-ws-a").id;

      // No `noWorkspace` here — a git-less project is exactly the case the
      // workspace payload exists for.
      const push1 = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(push1.success).toBe(true);
      if (!push1.success) return;
      expect(push1.hasWorkspace).toBe(true);
      const localA = push1.pushedSessions[0].sessionId;
      const pathA = sessionFilePath(configDirA, projectA, localA);

      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      const initB = await hubInit({ hubPath: hub, configScope: "user", cwd: homeB });
      expect(initB.success).toBe(true);
      setMachineName("keystone-ws-b");
      writeLocalProjectId(projectB, {
        projectId: push1.projectId, name: "proj",
        createdAt: new Date().toISOString(), createdByMachine: machineIdA,
      });

      // B bootstraps: the tree lands and the generation is recorded, which is
      // what makes the LATER merge legal (a generation common to both trees).
      const pullB = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(pullB.success).toBe(true);
      if (!pullB.success) return;
      const pB = pullB as HubPullResult;
      expect(pB.workspaceUnpacked?.fileCount).toBeGreaterThan(0);
      expect(readFileSync(join(projectB, "shared.txt"), "utf-8")).toBe(lines());

      // B works: one file edited, two messages added.
      writeFileSync(join(projectB, "shared.txt"), lines({ 2: "B-EDIT" }));
      const localB = pB.localSessionId!;
      appendContinuationEntries(sessionFilePath(configDirB, projectB, localB), localB, projectB);
      const pushB = await hubPush({
        configDir: configDirB, projectPath: projectB, hubPath: hub, claudeVersion: CLAUDE_VERSION,
      });
      expect(pushB.success).toBe(true);
      if (!pushB.success) return;
      expect(pushB.hasWorkspace).toBe(true);
      expect(pushB.pushedSessions[0].type).toBe("continuation");

      // A meanwhile edited a DIFFERENT line of the same file, and left the
      // session behind.
      restore.restore();
      restore = overrideHome(homeA);
      writeFileSync(join(projectA, "shared.txt"), lines({ 8: "A-EDIT" }));
      ageOutOfLiveWindow(pathA);

      const pullA = await hubPull({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(pullA.success).toBe(true);
      if (!pullA.success) return;
      const pA = pullA as HubPullResult;

      // Half one: the workspace merged, keeping both edits, no conflict.
      expect(pA.workspaceMerge?.merged).toContain("shared.txt");
      expect(pA.workspaceMerge?.conflicted ?? []).toHaveLength(0);
      expect(readFileSync(join(projectA, "shared.txt"), "utf-8")).toBe(
        lines({ 2: "B-EDIT", 8: "A-EDIT" })
      );

      // Half two: the session spliced into A's own transcript, in the same pull.
      expect(pA.appended ?? []).toHaveLength(1);
      expect(pA.appended![0]).toMatchObject({ baseSessionId: localA, entriesAppended: 2 });
      expect(pA.importedSessions).toHaveLength(0);
      expect(jsonlFiles(join(configDirA, "projects", encodeProjectPath(projectA)))).toHaveLength(1);
      expect(lastUuid(pathA)).toBe("b-append-2");
    } finally {
      restore.restore();
      for (const d of [hub, homeA, homeB, baseA, projectB]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("one pull applies the carried patch AND splices the continuation", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-keystone-carry-hub-"));
    const homeA = mkdtempSync(join(tmpdir(), "sesh-keystone-carry-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-keystone-carry-homeB-"));
    const baseA = mkdtempSync(join(tmpdir(), "sesh-keystone-carry-fixA-"));
    const cloneRoot = mkdtempSync(join(tmpdir(), "sesh-keystone-carry-clone-"));
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(baseA);
      const projectA = createRealProject(baseA, configDirA, "proj");
      const git = (args: string[], cwd = projectA): void => {
        execFileSync("git", args, { cwd, stdio: "ignore" });
      };
      git(["init", "-q"]);
      git(["config", "user.email", "t@example.com"]);
      git(["config", "user.name", "Test"]);
      git(["remote", "add", "origin", "https://github.com/User/Repo.git"]);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "init"]);
      // The realistic receiving shape for a project with a remote: same commit,
      // clean tree. Cloned BEFORE A dirties its tree.
      const projectB = join(cloneRoot, "projB");
      execFileSync("git", ["clone", "-q", projectA, projectB], { stdio: "ignore" });
      writeFileSync(join(projectA, "README.md"), "work in progress\n");
      writeFileSync(join(projectA, "scratch.txt"), "wip\n");

      const initA = await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      expect(initA.success).toBe(true);
      const machineIdA = setMachineName("keystone-carry-a").id;
      const push1 = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(push1.success).toBe(true);
      if (!push1.success) return;
      expect("carry" in push1 && push1.carry).toBeTruthy();
      const localA = push1.pushedSessions[0].sessionId;
      const pathA = sessionFilePath(configDirA, projectA, localA);

      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      const initB = await hubInit({ hubPath: hub, configScope: "user", cwd: homeB });
      expect(initB.success).toBe(true);
      setMachineName("keystone-carry-b");
      writeLocalProjectId(projectB, {
        projectId: push1.projectId, name: "proj",
        createdAt: new Date().toISOString(), createdByMachine: machineIdA,
      });

      // First pull WITHOUT --apply-carry: the session lands, the payload is
      // only reported and saved, and B's working tree stays clean — which is
      // what lets the second pull's carry apply.
      const pullB1 = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(pullB1.success).toBe(true);
      if (!pullB1.success) return;
      const p1 = pullB1 as HubPullResult;
      expect(p1.importedSessions).toHaveLength(1);
      expect(p1.carryApplied?.applied).toBe(false);
      expect(readTextLf(join(projectB, "README.md"))).toBe("hello\n");
      const localB = p1.localSessionId!;
      const pathB = sessionFilePath(configDirB, projectB, localB);

      // A carries on working: two more messages, and one more uncommitted edit.
      restore.restore();
      restore = overrideHome(homeA);
      appendContinuationEntries(pathA, localA, projectA);
      writeFileSync(join(projectA, "README.md"), "work in progress, take two\n");
      const push2 = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub, claudeVersion: CLAUDE_VERSION,
      });
      expect(push2.success).toBe(true);
      if (!push2.success) return;
      expect(push2.pushedSessions[0].type).toBe("continuation");

      restore.restore();
      restore = overrideHome(homeB);
      ageOutOfLiveWindow(pathB);
      const pullB2 = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, applyCarry: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(pullB2.success).toBe(true);
      if (!pullB2.success) return;
      const p2 = pullB2 as HubPullResult;

      // Half one: A's uncommitted work is in B's tree.
      expect(p2.carryApplied?.applied).toBe(true);
      expect(readTextLf(join(projectB, "README.md"))).toBe("work in progress, take two\n");
      expect(readTextLf(join(projectB, "scratch.txt"))).toBe("wip\n");

      // Half two: the transcript is one session, extended in place.
      expect(p2.appended ?? []).toHaveLength(1);
      expect(p2.appended![0]).toMatchObject({ baseSessionId: localB, entriesAppended: 2 });
      expect(p2.importedSessions).toHaveLength(0);
      expect(jsonlFiles(join(configDirB, "projects", encodeProjectPath(projectB)))).toHaveLength(1);
      expect(lastUuid(pathB)).toBe("b-append-2");
      // The applied payload is not also parked, so nothing invites the user to
      // apply it a second time.
      expect(existsSync(join(projectB, ".claude-sesh-mover"))).toBe(true);
      expect(
        readdirSync(join(projectB, ".claude-sesh-mover")).filter((n) => n.startsWith("carry-"))
      ).toHaveLength(1); // the FIRST pull's save, and only that one
    } finally {
      restore.restore();
      for (const d of [hub, homeA, homeB, baseA, cloneRoot]) rmSync(d, { recursive: true, force: true });
    }
  });

  // Task 12b, and the artifact Critical 3 never had: a thread whose history
  // spans TWO machines cannot be pulled whole by a THIRD, because each index
  // lists only the bundles its own machine pushed and a pull fetches exactly
  // one machine's list. This test asserts the DISCLOSURE — that the pull says
  // which machine holds the part it could not fetch — and, in the same
  // fixture, that the ordinary two-machine round trip stays completely silent.
  // It does not assert the truncation as a desired outcome; assembling such a
  // chain is a later slice.
  it("three machines: the half a pull cannot fetch is disclosed, and the two-machine flow stays silent", async () => {
    const f = await setupThroughAppendPush("sesh-keystone-split");
    const homeC = mkdtempSync(join(tmpdir(), "sesh-keystone-split-homeC-"));
    const projectC = mkdtempSync(join(tmpdir(), "sesh-keystone-split-projC-"));
    try {
      // Phase 4 (A): the ordinary round trip — A pulls B's continuation back
      // into its own session. FALSE-POSITIVE CONTROL: with only two machines
      // on the hub, neither the pull nor whereis may say a word about split
      // history, because there is none.
      f.restore.restore();
      const restoreA = overrideHome(f.homeA);
      try {
        const localA = f.pushA.pushedSessions[0].sessionId;
        ageOutOfLiveWindow(sessionFilePath(f.configDirA, f.projectA, localA));
        const pullA = await hubPull({
          configDir: f.configDirA, projectPath: f.projectA, hubPath: f.hub,
          latest: true, claudeVersion: CLAUDE_VERSION,
        });
        expect(pullA.success).toBe(true);
        if (!pullA.success) return;
        expect((pullA as HubPullResult).appended ?? []).toHaveLength(1); // the splice really happened
        expect((pullA as HubPullResult).unfetchableBundles).toBeUndefined();

        const whereisA = await hubWhereis({
          configDir: f.configDirA, projectPath: f.projectA, hubPath: f.hub,
        });
        expect(whereisA.threads).toHaveLength(1);
        expect(whereisA.threads[0].unfetchableBundles).toBeUndefined();
      } finally {
        restoreA.restore();
      }

      const restoreB = overrideHome(f.homeB);
      try {
        const whereisB = await hubWhereis({
          configDir: f.configDirB, projectPath: f.projectB, hubPath: f.hub,
        });
        expect(whereisB.threads).toHaveLength(1);
        expect(whereisB.threads[0].unfetchableBundles).toBeUndefined();
      } finally {
        restoreB.restore();
      }

      // Phase 5 (C): a third machine joins and pulls the same thread. The two
      // bundles that make up this conversation sit in two different machines'
      // index files; this pull reads one of them.
      const restoreC = overrideHome(homeC);
      try {
        const configDirC = join(homeC, ".claude");
        const initC = await hubInit({ hubPath: f.hub, configScope: "user", cwd: homeC });
        expect(initC.success).toBe(true);
        setMachineName("keystone-machine-c");
        writeLocalProjectId(projectC, {
          projectId: f.pushA.projectId, name: "proj",
          createdAt: new Date().toISOString(), createdByMachine: f.machineIdA,
        });

        const pullC = await hubPull({
          configDir: configDirC, projectPath: projectC, hubPath: f.hub,
          latest: true, claudeVersion: CLAUDE_VERSION,
        });
        expect(pullC.success).toBe(true);
        if (!pullC.success) return;
        const pC = pullC as HubPullResult;

        // Which machine this pull resolves to is a deterministic function of
        // the two copies (threads.ts), but it is not this test's subject — the
        // disclosure has to be right EITHER way, so the expectation is derived
        // from the result rather than assumed.
        const backend = createFsBackend(f.hub);
        const { indexes } = await readAllIndexes(backend, f.pushA.projectId);
        const bundlesOf = (machineId: string) =>
          Object.values(indexes.find((i) => i.machineId === machineId)?.threads ?? {})
            .flatMap((t) => t.bundles);
        const otherId = pC.sourceMachineId === f.machineIdA ? f.machineIdB : f.machineIdA;
        const otherName = otherId === f.machineIdB ? f.machineNameB : "keystone-machine-a";
        const unfetched = bundlesOf(otherId);
        expect(unfetched.length).toBeGreaterThan(0);

        // The typed field: which machine, and exactly which bundles.
        expect(pC.unfetchableBundles).toEqual([
          {
            machineId: otherId,
            machineName: otherName,
            bundleIds: unfetched.map((b) => b.bundleId),
          },
        ]);

        // The warning: what is missing, who has it, and NO remedy — there is
        // no --from-machine, --thread resolves to the same source, and hub
        // reindex only rebuilds this machine's index from its own bundles.
        const disclosure = pC.warnings.find((w) => w.includes("could not be pulled whole"));
        expect(disclosure).toBeDefined();
        expect(disclosure!).toContain(otherName);
        expect(disclosure!).toContain("split across machines");
        expect(disclosure!).toContain("still on the hub");
        expect(disclosure!).not.toMatch(/--[a-z]/); // no flag is named, because none exists
        expect(disclosure!).toContain("no flag or re-run fetches them"); // it forecloses instead

        // ...and it is not decorative: the entries in the bundle it names are
        // genuinely absent from every transcript this pull produced.
        const projectDirC = join(configDirC, "projects", encodeProjectPath(projectC));
        const uuidsOnC = new Set(
          jsonlFiles(projectDirC).flatMap((n) =>
            readEntries(join(projectDirC, n)).map((e) => e.uuid as string)
          )
        );
        for (const b of unfetched) expect(uuidsOnC.has(b.headEntryUuid)).toBe(false);

        // whereis on C repeats the same signal, per thread — this is the view
        // that otherwise reports the thread as "current" on a machine holding
        // half of it.
        const whereisC = await hubWhereis({
          configDir: configDirC, projectPath: projectC, hubPath: f.hub,
        });
        const tC = whereisC.threads.find((t) => t.threadId === pC.threadId);
        expect(tC?.unfetchableBundles).toEqual(pC.unfetchableBundles);
      } finally {
        restoreC.restore();
      }
    } finally {
      rmSync(homeC, { recursive: true, force: true });
      rmSync(projectC, { recursive: true, force: true });
      cleanup(f);
    }
  });
});
