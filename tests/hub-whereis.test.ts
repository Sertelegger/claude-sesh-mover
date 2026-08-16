import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFsBackend } from "../src/hub/backend.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { indexPath, machinePath, projectJsonPath, type HubMachineJson, type HubProjectJson } from "../src/hub/layout.js";
import { writeMachineIndex } from "../src/hub/index-file.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { encodeProjectPath } from "../src/platform.js";
import { syncStatePath, writeSyncState } from "../src/sync-state.js";
import { hubWhereis } from "../src/hub/whereis.js";
import { bundle, emptySyncState, entry, idx, peer } from "./helpers/hub-fixtures.js";

const PROJECT_ID = "proj-1";

function writeMachineFile(backend: ReturnType<typeof createFsBackend>, id: string, name: string) {
  const record: HubMachineJson = { id, name, platform: "linux", lastSeenAt: "2026-07-21T00:00:00Z" };
  return backend.writeAtomic(machinePath(id), JSON.stringify(record, null, 2) + "\n");
}

describe("hub whereis", () => {
  it("linked project with threads from two machines: latest on remote with no local copy -> pullNeeded true", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-whereis-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-whereis-hub-"));
    const projectDir = mkdtempSync(join(tmpdir(), "sesh-whereis-proj-"));
    const restore = overrideHome(home);
    try {
      const me = loadOrCreateMachineId();
      writeLocalProjectId(projectDir, {
        projectId: PROJECT_ID, name: "proj", createdAt: "2026-07-01T00:00:00Z", createdByMachine: me.id,
      });
      const backend = createFsBackend(hub);
      await writeMachineFile(backend, me.id, "my-laptop");
      await writeMachineFile(backend, "remote-1", "office-desktop");

      // Local machine's own index owns a different, older thread — proves
      // whereis merges indexes from multiple machines, not just the remote's.
      await writeMachineIndex(backend, {
        ...idx(me.id, { "t-local": entry({ localSessionId: "sLocal", lastActiveAt: "2026-07-01T00:00:00Z", headEntryUuid: "hLocal" }) }),
        projectId: PROJECT_ID,
      });
      // Remote machine owns "t-shared", most recently active, and the local
      // machine has never pushed/pulled a copy of it.
      //
      // The bundle record is what makes the thread PULLABLE, and since #44 that
      // is what `pullNeeded` reports: the field answers "would a pull fetch
      // something", so an index entry listing no bundle at all — which is what
      // a machine that only ever pulled this thread writes — is a thread a pull
      // could not fetch either. Every machine that has PUSHED a thread lists at
      // least one, so this is also the shape the fixture always meant.
      await writeMachineIndex(backend, {
        ...idx("remote-1", {
          "t-shared": entry({
            localSessionId: "sRemote", lastActiveAt: "2026-07-21T00:00:00Z",
            headEntryUuid: "hRemote", messageCount: 7,
            bundles: [
              bundle({
                bundleId: "r1", file: "projects/proj-1/bundles/remote-1/r1.tar.gz",
                type: "full", sessionIdInBundle: "sRemote", headEntryUuid: "hRemote",
              }),
            ],
          }),
        }),
        projectId: PROJECT_ID,
      });

      const result = await hubWhereis({ configDir: home, projectPath: projectDir, hubPath: hub });
      expect(result.linked).toBe(true);
      expect(result.projectId).toBe(PROJECT_ID);
      expect(result.threads.map((t) => t.threadId).sort()).toEqual(["t-local", "t-shared"]);

      const shared = result.threads.find((t) => t.threadId === "t-shared")!;
      expect(shared.latest.machineId).toBe("remote-1");
      expect(shared.latest.machineName).toBe("office-desktop");
      expect(shared.localCopy).toBeNull();
      expect(shared.pullNeeded).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, projectDir]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The remote's one bundle is already RECEIVED here, and that — not the
   * matching head — is what makes `pullNeeded` false since #44. The fixture
   * keeps both facts true at once so its companion below can vary exactly one
   * of them.
   */
  it("every bundle the remote lists is already received here -> pullNeeded false, localCopy.current true", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-whereis-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-whereis-hub-"));
    const projectDir = mkdtempSync(join(tmpdir(), "sesh-whereis-proj-"));
    const restore = overrideHome(home);
    try {
      const me = loadOrCreateMachineId();
      writeLocalProjectId(projectDir, {
        projectId: PROJECT_ID, name: "proj", createdAt: "2026-07-01T00:00:00Z", createdByMachine: me.id,
      });
      const backend = createFsBackend(hub);
      await writeMachineFile(backend, me.id, "my-laptop");
      await writeMachineFile(backend, "remote-1", "office-desktop");

      // Same headEntryUuid on both copies — already in sync — even though
      // the remote copy is nominally "latest" by lastActiveAt/machineId.
      await writeMachineIndex(backend, {
        ...idx(me.id, { "t1": entry({ localSessionId: "sLocal", lastActiveAt: "2026-07-20T00:00:00Z", headEntryUuid: "hSame", messageCount: 3 }) }),
        projectId: PROJECT_ID,
      });
      await writeMachineIndex(backend, {
        ...idx("remote-1", {
          "t1": entry({
            localSessionId: "sRemote", lastActiveAt: "2026-07-21T00:00:00Z",
            headEntryUuid: "hSame", messageCount: 3,
            bundles: [
              bundle({
                bundleId: "r1", file: "projects/proj-1/bundles/remote-1/r1.tar.gz",
                type: "full", sessionIdInBundle: "sRemote", headEntryUuid: "hSame",
              }),
            ],
          }),
        }),
        projectId: PROJECT_ID,
      });
      // ...and the receipt for it, plus the local file the receipt names: a
      // receipt is trusted only while that file is still there (an export or a
      // migrate can outlive it), so both halves are the fixture.
      writeSyncState({
        ...emptySyncState(projectDir),
        peers: {
          "remote-1": peer({
            received: {
              sRemote: {
                localSessionId: "sLocal", type: "full", importedAt: "2026-07-21T01:00:00Z",
              },
            },
          }),
        },
      });
      const projectSessions = join(home, "projects", encodeProjectPath(projectDir));
      mkdirSync(projectSessions, { recursive: true });
      writeFileSync(join(projectSessions, "sLocal.jsonl"), "{}\n", "utf-8");

      const result = await hubWhereis({ configDir: home, projectPath: projectDir, hubPath: hub });
      expect(result.threads).toHaveLength(1);
      const t = result.threads[0];
      expect(t.latest.machineId).toBe("remote-1"); // later lastActiveAt still wins the "latest" label
      expect(t.localCopy).not.toBeNull();
      expect(t.localCopy!.current).toBe(true);
      expect(t.pullNeeded).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, projectDir]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * #44, the whereis half. `pullNeeded` fed the SessionStart notice and the
   * skill layer's "run /sesh-mover:pull" advice off HEAD EQUALITY, which is a
   * different question from the one `pull` answers — so on this arrangement
   * (the newest head is already here, the machine the thread resolves to still
   * lists a bundle that never arrived) `whereis` said `pullNeeded: false` about
   * a thread a pull fetches. Same fixture shape as the select-stage agreement
   * test in tests/hub-pull-stages.test.ts.
   *
   * `localCopy.current` stays TRUE here on purpose: head equality survives as a
   * display field, and the two fields answering differently is the fix, not a
   * contradiction.
   */
  it("head is current but the remote lists an unreceived bundle -> pullNeeded true", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-whereis-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-whereis-hub-"));
    const projectDir = mkdtempSync(join(tmpdir(), "sesh-whereis-proj-"));
    const restore = overrideHome(home);
    try {
      const me = loadOrCreateMachineId();
      writeLocalProjectId(projectDir, {
        projectId: PROJECT_ID, name: "proj", createdAt: "2026-07-01T00:00:00Z", createdByMachine: me.id,
      });
      const backend = createFsBackend(hub);
      await writeMachineFile(backend, me.id, "my-laptop");
      await writeMachineFile(backend, "remote-1", "office-desktop");

      await writeMachineIndex(backend, {
        ...idx(me.id, { "t1": entry({ localSessionId: "sLocal", lastActiveAt: "2026-07-20T00:00:00Z", headEntryUuid: "hSame", messageCount: 3 }) }),
        projectId: PROJECT_ID,
      });
      await writeMachineIndex(backend, {
        ...idx("remote-1", {
          "t1": entry({
            localSessionId: "sRemote", lastActiveAt: "2026-07-21T00:00:00Z",
            headEntryUuid: "hSame", messageCount: 3,
            bundles: [
              bundle({
                bundleId: "r1", file: "projects/proj-1/bundles/remote-1/r1.tar.gz",
                type: "full", sessionIdInBundle: "sRemote", headEntryUuid: "hSame",
              }),
            ],
          }),
        }),
        projectId: PROJECT_ID,
      });
      // No receipts at all — nothing from remote-1 has ever landed here.
      writeSyncState(emptySyncState(projectDir));

      const result = await hubWhereis({ configDir: home, projectPath: projectDir, hubPath: hub });
      const t = result.threads[0];
      expect(t.localCopy!.current).toBe(true);
      expect(t.pullNeeded).toBe(true);
      // Two machines only, so nothing is out of reach — this is the ordinary
      // "there is a bundle here for you" case, not the split-history one.
      expect(t.unfetchableBundles).toBeUndefined();
    } finally {
      restore.restore();
      for (const d of [home, hub, projectDir]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * #35, the whereis half — the shape the issue calls the indefinite nag.
   *
   * The conversation was started on remote-a and continued on remote-b, so half
   * its bundles are in each machine's index and neither holds it whole. This
   * machine has remote-b's half and, before chain assembly, that was the end of
   * it: the thread resolves to remote-b, remote-b's list was fully received, so
   * `pullNeeded` was FALSE forever while `unfetchableBundles` named remote-a's
   * bundle as out of reach — and the head matched, so the row read "current"
   * too. Three reassuring fields over half a conversation.
   *
   * `pullSourceFor` now asks the assembled chain, and `whereis` calls exactly
   * that function, so both fields moved with it and neither was edited here.
   */
  it("the earlier half of a thread sits on a third machine -> pullNeeded true, nothing unfetchable (#35)", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-whereis-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-whereis-hub-"));
    const projectDir = mkdtempSync(join(tmpdir(), "sesh-whereis-proj-"));
    const restore = overrideHome(home);
    try {
      const me = loadOrCreateMachineId();
      writeLocalProjectId(projectDir, {
        projectId: PROJECT_ID, name: "proj", createdAt: "2026-07-01T00:00:00Z", createdByMachine: me.id,
      });
      const backend = createFsBackend(hub);
      await writeMachineFile(backend, me.id, "my-laptop");
      await writeMachineFile(backend, "remote-a", "the-first-machine");
      await writeMachineFile(backend, "remote-b", "the-second-machine");

      // remote-a started it...
      await writeMachineIndex(backend, {
        ...idx("remote-a", {
          t1: entry({
            localSessionId: "sA", lastActiveAt: "2026-07-20T00:00:00Z", headEntryUuid: "head-a1",
            bundles: [
              bundle({
                bundleId: "a1", file: "projects/proj-1/bundles/remote-a/a1.tar.gz",
                type: "full", sessionIdInBundle: "sA",
                anchorEntryUuid: null, headEntryUuid: "head-a1",
              }),
            ],
          }),
        }),
        projectId: PROJECT_ID,
      });
      // ...and remote-b continued it, anchored on remote-a's head.
      await writeMachineIndex(backend, {
        ...idx("remote-b", {
          t1: entry({
            localSessionId: "sB", lastActiveAt: "2026-07-21T00:00:00Z", headEntryUuid: "head-b1",
            bundles: [
              bundle({
                bundleId: "b1", file: "projects/proj-1/bundles/remote-b/b1.tar.gz",
                type: "continuation", sessionIdInBundle: "sB",
                anchorEntryUuid: "head-a1", headEntryUuid: "head-b1",
              }),
            ],
          }),
        }),
        projectId: PROJECT_ID,
      });
      // This machine holds remote-b's half and advertises its head, so head
      // equality says "current" — the trap #35 names.
      await writeMachineIndex(backend, {
        ...idx(me.id, {
          t1: entry({
            localSessionId: "sLocal", lastActiveAt: "2026-07-19T00:00:00Z",
            headEntryUuid: "head-b1",
          }),
        }),
        projectId: PROJECT_ID,
      });
      writeSyncState({
        ...emptySyncState(projectDir),
        peers: {
          "remote-b": peer({
            received: {
              sB: { localSessionId: "sLocal", type: "continuation", importedAt: "2026-07-21T01:00:00Z" },
            },
          }),
        },
      });
      const projectSessions = join(home, "projects", encodeProjectPath(projectDir));
      mkdirSync(projectSessions, { recursive: true });
      writeFileSync(join(projectSessions, "sLocal.jsonl"), "{}\n", "utf-8");

      const result = await hubWhereis({ configDir: home, projectPath: projectDir, hubPath: hub });
      const t = result.threads[0];
      expect(t.latest.machineId).toBe("remote-b");
      // The head still matches, and still says nothing about wholeness.
      expect(t.localCopy!.current).toBe(true);
      // A pull WOULD fetch remote-a's root by following b1's anchor, so:
      expect(t.pullNeeded).toBe(true);
      // ...and nothing is out of reach, so nothing says it is. Before the fix
      // this named remote-a and its bundle a1.
      expect(t.unfetchableBundles).toBeUndefined();
    } finally {
      restore.restore();
      for (const d of [home, hub, projectDir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("unlinked project -> linked false, candidates listed, threads empty", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-whereis-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-whereis-hub-"));
    const projectDir = mkdtempSync(join(tmpdir(), "sesh-whereis-proj-")); // no .sesh-mover-project.json, no .git
    const restore = overrideHome(home);
    try {
      const backend = createFsBackend(hub);
      const hubProject: HubProjectJson = {
        schemaVersion: 1, projectId: "other-proj", name: "other-proj",
        matchers: { gitRemotes: ["github.com/someone/else"] },
        createdAt: "2026-07-01T00:00:00Z", createdByMachine: "m1",
      };
      await backend.writeAtomic(projectJsonPath("other-proj"), JSON.stringify(hubProject, null, 2) + "\n");

      const result = await hubWhereis({ configDir: home, projectPath: projectDir, hubPath: hub });
      expect(result.linked).toBe(false);
      expect(result.projectId).toBeNull();
      expect(result.threads).toEqual([]);
      expect(result.linkCandidates).toHaveLength(1);
      expect(result.linkCandidates![0].projectId).toBe("other-proj");
    } finally {
      restore.restore();
      for (const d of [home, hub, projectDir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("one machine's index file is torn -> good machine's threads still returned, warning names the bad machine", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-whereis-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-whereis-hub-"));
    const projectDir = mkdtempSync(join(tmpdir(), "sesh-whereis-proj-"));
    const restore = overrideHome(home);
    try {
      const me = loadOrCreateMachineId();
      writeLocalProjectId(projectDir, {
        projectId: PROJECT_ID, name: "proj", createdAt: "2026-07-01T00:00:00Z", createdByMachine: me.id,
      });
      const backend = createFsBackend(hub);
      await writeMachineFile(backend, me.id, "my-laptop");

      await writeMachineIndex(backend, {
        ...idx(me.id, { "t1": entry({ localSessionId: "sLocal" }) }),
        projectId: PROJECT_ID,
      });
      // Torn JSON under a safe machine-id filename.
      await backend.writeAtomic(indexPath(PROJECT_ID, "broken-machine"), "{bad");

      const result = await hubWhereis({ configDir: home, projectPath: projectDir, hubPath: hub });
      expect(result.threads).toHaveLength(1);
      expect(result.threads[0].threadId).toBe("t1");
      expect(result.warnings.join(" ")).toContain("broken-machine");
    } finally {
      restore.restore();
      for (const d of [home, hub, projectDir]) rmSync(d, { recursive: true, force: true });
    }
  });

  // SECURITY (Task 6 review, binding on this task): the machineId field
  // INSIDE a parsed index file is never validated by readMachineIndex — only
  // ids used in ITS OWN path building (derived from the filename) are. A
  // hostile index file can therefore declare an internal machineId that is
  // unsafe as a path component (e.g. "../evil"). resolveThreads copies that
  // internal field verbatim into ThreadCopy.machineId, so whereis's
  // machineName() helper — which calls machinePath(id) to read
  // machines/<id>.json — must be the one to contain the resulting throw
  // (machinePath asserts and throws on unsafe ids), not let it escape and
  // wedge the whole command.
  it("hostile internal machineId in an index file does not throw; that copy gets machineName null", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-whereis-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-whereis-hub-"));
    const projectDir = mkdtempSync(join(tmpdir(), "sesh-whereis-proj-"));
    const restore = overrideHome(home);
    try {
      const me = loadOrCreateMachineId();
      writeLocalProjectId(projectDir, {
        projectId: PROJECT_ID, name: "proj", createdAt: "2026-07-01T00:00:00Z", createdByMachine: me.id,
      });
      const backend = createFsBackend(hub);
      await writeMachineFile(backend, me.id, "my-laptop");

      // Safe filename ("hostile.json" -> derived id "hostile" passes
      // readAllIndexes's filename check) but the JSON content's own
      // machineId field is a hostile relative-path string.
      const hostileIndex = {
        ...idx("../evil", { "t1": entry({ localSessionId: "sRemote" }) }),
        projectId: PROJECT_ID,
      };
      await backend.writeAtomic(indexPath(PROJECT_ID, "hostile"), JSON.stringify(hostileIndex, null, 2) + "\n");

      const result = await hubWhereis({ configDir: home, projectPath: projectDir, hubPath: hub });
      expect(result.threads).toHaveLength(1);
      const t = result.threads[0];
      expect(t.latest.machineId).toBe("../evil");
      expect(t.latest.machineName).toBeNull();
      expect(t.copies.find((c) => c.machineId === "../evil")!.machineName).toBeNull();
    } finally {
      restore.restore();
      for (const d of [home, hub, projectDir]) rmSync(d, { recursive: true, force: true });
    }
  });

  // whereis is documented as a read-only view, and Task 12b gave it a reason
  // to read this machine's sync-state (peer bookkeeping is what tells a
  // genuinely missing half of a thread from one already held). readSyncState
  // renames a corrupt file aside — a write — so this path must use the
  // read-only reader. The SessionStart hook runs it too.
  it("does not touch a corrupt sync-state file", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-whereis-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-whereis-hub-"));
    const projectDir = mkdtempSync(join(tmpdir(), "sesh-whereis-proj-"));
    const restore = overrideHome(home);
    try {
      const me = loadOrCreateMachineId();
      writeLocalProjectId(projectDir, {
        projectId: PROJECT_ID, name: "proj", createdAt: "2026-07-01T00:00:00Z", createdByMachine: me.id,
      });
      const backend = createFsBackend(hub);
      await writeMachineFile(backend, me.id, "my-laptop");
      await writeMachineIndex(backend, {
        ...idx(me.id, { t1: entry({ localSessionId: "sLocal" }) }),
        projectId: PROJECT_ID,
      });

      const statePath = syncStatePath(projectDir);
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, "{not json", "utf-8");

      const result = await hubWhereis({ configDir: home, projectPath: projectDir, hubPath: hub });
      expect(result.linked).toBe(true);
      expect(existsSync(statePath)).toBe(true);
      expect(readFileSync(statePath, "utf-8")).toBe("{not json");
      expect(readdirSync(dirname(statePath))).toHaveLength(1); // nothing renamed aside either
    } finally {
      restore.restore();
      for (const d of [home, hub, projectDir]) rmSync(d, { recursive: true, force: true });
    }
  });
});
