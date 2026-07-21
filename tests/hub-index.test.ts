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

  // Regression (Task 12 keystone integration test): a continuation pull
  // creates a BRAND NEW local session file thread-mapped to the SAME
  // threadId as the original session it continues (see hub/pull.ts's
  // setThreadId call) — so a single project can have multiple local
  // sessions mapped to one thread. The projection must keep whichever is
  // genuinely most recent, not whichever happens to appear last in
  // `inputs.sessions` (discoverSessions returns sessions most-recent-first,
  // so "last wins" silently picked the OLDEST one and made a machine's own
  // index report a stale head for a thread it had, in fact, just updated).
  it("two local sessions mapped to the same thread: the more recent one wins, regardless of input order", () => {
    const older = { ...SESSION, sessionId: "s-old", lastActiveAt: "2026-04-10T12:01:00Z", headEntryUuid: "u-old" };
    const newer = { ...SESSION, sessionId: "s-new", lastActiveAt: "2026-07-21T01:00:05Z", headEntryUuid: "u-new" };
    const state = stateWithThreads({ "s-old": "t1", "s-new": "t1" });

    // Most-recent-first order (discoverSessions's actual convention).
    const mostRecentFirst = buildIndexFile({
      projectId: "p", machineId: "m", projectPath: "/x",
      sessions: [newer, older], state, priorIndex: null, newBundles: [], now: "t",
    });
    expect(mostRecentFirst.threads.t1.localSessionId).toBe("s-new");
    expect(mostRecentFirst.threads.t1.headEntryUuid).toBe("u-new");

    // Reversed order must produce the SAME winner — the projection can't
    // depend on caller iteration order.
    const oldestFirst = buildIndexFile({
      projectId: "p", machineId: "m", projectPath: "/x",
      sessions: [older, newer], state, priorIndex: null, newBundles: [], now: "t",
    });
    expect(oldestFirst.threads.t1.localSessionId).toBe("s-new");
    expect(oldestFirst.threads.t1.headEntryUuid).toBe("u-new");
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

  it("readAllIndexes contains filename-unsafe machine ids: skips + warns, never throws", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      const index = buildIndexFile({
        projectId: "p", machineId: "m1", projectPath: "/x",
        sessions: [SESSION], state: stateWithThreads({ s1: "t1" }),
        priorIndex: null, newBundles: [{ threadId: "t1", record: RECORD }], now: "t",
      });
      await writeMachineIndex(backend, index);
      // Hostile/corrupt filenames whose derived machineId is filename-unsafe:
      // ".json" -> machineId "", "..json" -> machineId "." — both would make
      // indexPath's assertSafeHubId throw if they reached readMachineIndex.
      await backend.writeAtomic("projects/p/index/.json", "{}");
      await backend.writeAtomic("projects/p/index/..json", "{}");
      const all = await readAllIndexes(backend, "p");
      expect(all.indexes).toHaveLength(1);
      expect(all.indexes[0].machineId).toBe("m1");
      expect(all.warnings).toHaveLength(2);
      // Warnings must name the offending FILE, not the (unsafe) derived id.
      expect(all.warnings.join(" ")).toContain("projects/p/index/.json");
      expect(all.warnings.join(" ")).toContain("projects/p/index/..json");
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });
});
