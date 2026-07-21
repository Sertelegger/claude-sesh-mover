import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFsBackend } from "../src/hub/backend.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { indexPath, machinePath, projectJsonPath, type HubMachineJson, type HubProjectJson } from "../src/hub/layout.js";
import { writeMachineIndex } from "../src/hub/index-file.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { hubWhereis } from "../src/hub/whereis.js";
import { idx, entry } from "./helpers/hub-fixtures.js";

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
      await writeMachineIndex(backend, {
        ...idx("remote-1", { "t-shared": entry({ localSessionId: "sRemote", lastActiveAt: "2026-07-21T00:00:00Z", headEntryUuid: "hRemote", messageCount: 7 }) }),
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

  it("local copy already matches the latest head -> pullNeeded false, localCopy.current true", async () => {
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
        ...idx("remote-1", { "t1": entry({ localSessionId: "sRemote", lastActiveAt: "2026-07-21T00:00:00Z", headEntryUuid: "hSame", messageCount: 3 }) }),
        projectId: PROJECT_ID,
      });

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

  it("unlinked project -> linked false, candidates listed, threads empty", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-whereis-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-whereis-hub-"));
    const projectDir = mkdtempSync(join(tmpdir(), "sesh-whereis-proj-")); // no .claude-sesh-mover/project.json, no .git
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
});
