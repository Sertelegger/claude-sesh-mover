import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend } from "../src/hub/backend.js";
import { buildIndexFile, readMachineIndex, writeMachineIndex, readAllIndexes } from "../src/hub/index-file.js";
import type { SyncState } from "../src/types.js";

function stateWithThreads(map: Record<string, string>): SyncState {
  return { projectPath: "/x", schemaVersion: 2, peers: {}, lineage: {}, imported: {},
    hub: { hubId: "h", threadByLocalSession: map } };
}
const SESSION = { sessionId: "s1", slug: "sl", summary: "su", headEntryUuid: "u1",
  messageCount: 3, lastActiveAt: "2026-07-21T00:00:00Z" };
const RECORD = { bundleId: "b1", file: "projects/p/bundles/m/x.tar.gz", type: "full" as const,
  sessionIdInBundle: "s1", fromEntryUuid: null, headEntryUuid: "u1",
  messageCount: 3, pushedAt: "t", hasWorkspace: false };

describe("index file", () => {
  it("buildIndexFile maps sessions to threads and appends new bundle records to prior history", () => {
    const prior = buildIndexFile({
      projectId: "p", machineId: "m", projectPath: "/x",
      sessions: [SESSION], state: stateWithThreads({ s1: "t1" }),
      priorIndex: null, newBundles: [{ threadId: "t1", record: RECORD }], now: "t0",
    });
    expect(prior.threads.t1.bundles).toHaveLength(1);

    const next = buildIndexFile({
      projectId: "p", machineId: "m", projectPath: "/x",
      sessions: [{ ...SESSION, messageCount: 5, headEntryUuid: "u2" }],
      state: stateWithThreads({ s1: "t1" }),
      priorIndex: prior,
      newBundles: [{ threadId: "t1", record: { ...RECORD, bundleId: "b2", type: "continuation", fromEntryUuid: "u1", headEntryUuid: "u2" } }],
      now: "t1",
    });
    expect(next.threads.t1.bundles.map((b) => b.bundleId)).toEqual(["b1", "b2"]);
    expect(next.threads.t1.messageCount).toBe(5);
  });

  it("sessions without a thread mapping are omitted (never pushed)", () => {
    const built = buildIndexFile({
      projectId: "p", machineId: "m", projectPath: "/x",
      sessions: [SESSION], state: stateWithThreads({}),
      priorIndex: null, newBundles: [], now: "t",
    });
    expect(Object.keys(built.threads)).toHaveLength(0);
  });

  it("write/read round-trip; readAllIndexes skips unparseable with warning", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      const index = buildIndexFile({
        projectId: "p", machineId: "m1", projectPath: "/x",
        sessions: [SESSION], state: stateWithThreads({ s1: "t1" }),
        priorIndex: null, newBundles: [{ threadId: "t1", record: RECORD }], now: "t",
      });
      await writeMachineIndex(backend, index);
      expect((await readMachineIndex(backend, "p", "m1"))?.threads.t1.localSessionId).toBe("s1");
      await backend.writeAtomic("projects/p/index/m2.json", "{torn");
      const all = await readAllIndexes(backend, "p");
      expect(all.indexes).toHaveLength(1);
      expect(all.warnings.join(" ")).toContain("m2");
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });
});
