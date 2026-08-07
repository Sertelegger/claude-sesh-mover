import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend } from "../src/hub/backend.js";
import { buildIndexFile, readMachineIndex, writeMachineIndex, readAllIndexes } from "../src/hub/index-file.js";
import { indexPath, type HubBundleRecord, type HubIndexJson } from "../src/hub/layout.js";
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

  // Regression: the winner used to be decided by `>=`, so an EXACT tie kept
  // whichever session `inputs.sessions` yielded FIRST — i.e. discoverSessions'
  // listing order, which is not a decision. A pull that splices a continuation
  // onto a fresh local file lands both files' mtimes in the same millisecond,
  // so the tie is reachable from the ordinary round trip.
  it("two local sessions with a byte-identical lastActiveAt: the winner does not depend on input order", () => {
    const same = "2026-07-21T01:00:05.000Z";
    const a = { ...SESSION, sessionId: "s-aaa", lastActiveAt: same, headEntryUuid: "u-aaa" };
    const b = { ...SESSION, sessionId: "s-bbb", lastActiveAt: same, headEntryUuid: "u-bbb" };
    const state = stateWithThreads({ "s-aaa": "t1", "s-bbb": "t1" });
    const build = (sessions: typeof SESSION[]) => buildIndexFile({
      projectId: "p", machineId: "m", projectPath: "/x",
      sessions, state, priorIndex: null, newBundles: [], now: "t",
    });

    const forward = build([a, b]);
    const reversed = build([b, a]);
    expect(reversed.threads.t1.localSessionId).toBe(forward.threads.t1.localSessionId);
    expect(reversed.threads.t1.headEntryUuid).toBe(forward.threads.t1.headEntryUuid);
    // Same tiebreak both ways round; the value itself is arbitrary-but-stable
    // (lower sessionId wins, as threads.ts does for machineId).
    expect(forward.threads.t1.localSessionId).toBe("s-aaa");
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

  // Regression: backend.list walks RECURSIVELY and readAllIndexes derived the
  // machine id with `file.split("/").pop()`, so anything nested under index/
  // that happened to be named `<machineId>.json` was read as a second, distinct
  // index for that machine. The hub is a shared/synced directory by design, so
  // the folders that produce exactly that — Syncthing's `.stversions/`, a
  // Dropbox "conflicted copy" directory — are the EXPECTED environment, not a
  // hostile one. The duplicates flow into resolveThreads, i.e. into "which
  // machine has my latest work".
  it("readAllIndexes reads only immediate index/<machineId>.json files: sync-folder litter never doubles a machine", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      const index = buildIndexFile({
        projectId: "p", machineId: "m1", projectPath: "/x",
        sessions: [SESSION], state: stateWithThreads({ s1: "t1" }),
        priorIndex: null, newBundles: [{ threadId: "t1", record: RECORD }], now: "t",
      });
      await writeMachineIndex(backend, index);
      const raw = JSON.stringify(index, null, 2) + "\n";
      // Syncthing parks superseded copies here; Dropbox names a conflict
      // directory with spaces and an apostrophe. Both are byte-identical
      // copies of m1's own index, one directory deeper.
      await backend.writeAtomic("projects/p/index/.stversions/m1.json", raw);
      await backend.writeAtomic("projects/p/index/office's conflicted copy 2026-08-03/m1.json", raw);
      // Ordinary litter with no `.json` suffix — never written by indexPath,
      // so it is not an index file and must not be reported as a corrupt one.
      await backend.writeAtomic("projects/p/index/README", "not an index\n");

      const all = await readAllIndexes(backend, "p");
      // A warning that fires on every pull against a healthy hub trains users
      // to ignore warnings, so the litter is skipped silently. (Checked before
      // the count so a regression reports the litter, not just the duplicate.)
      expect(all.warnings).toEqual([]);
      expect(all.indexes).toHaveLength(1);
      expect(all.indexes[0].machineId).toBe("m1");
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// readMachineIndex: one poisoned record costs that record, not the index.
// ---------------------------------------------------------------------------

const OK_A: HubBundleRecord = { ...RECORD, bundleId: "b-a", file: "projects/p/bundles/m1/a.tar.gz" };
const OK_B: HubBundleRecord = { ...RECORD, bundleId: "b-b", file: "projects/p/bundles/m1/b.tar.gz" };

function indexWith(bundles: HubBundleRecord[]): HubIndexJson {
  return {
    schemaVersion: 1, agent: "claude-code", projectId: "p", machineId: "m1",
    updatedAt: "t", projectPath: "/x",
    threads: {
      t1: {
        localSessionId: "s1", slug: "sl", summary: "su", headEntryUuid: "u1",
        messageCount: 3, lastActiveAt: "2026-07-21T00:00:00Z", bundles,
      },
    },
  };
}

describe("readMachineIndex degrades on a poisoned bundle record", () => {
  // `b.file` was validated nowhere: assertSafeHubId ran on threadId, bundleId
  // and sessionIdInBundle only. It first becomes a path in hub/pull.ts, at
  // `backend.exists(record.file)` — where the backend's assertHubRelPath throws
  // a raw internal string straight OUT of hubPull. One poisoned record killed
  // the whole pull and took every other bundle in the index with it.
  it("an unsafe file path drops only that record", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      await writeMachineIndex(backend, indexWith([
        OK_A,
        { ...RECORD, bundleId: "b-evil", file: "../../etc/passwd" },
        OK_B,
      ]));

      const warnings: string[] = [];
      const read = await readMachineIndex(backend, "p", "m1", warnings);
      expect(read).not.toBeNull();
      expect(read!.threads.t1.bundles.map((b) => b.bundleId)).toEqual(["b-a", "b-b"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("b-evil");
      expect(warnings[0]).toContain("../../etc/passwd");
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });

  // The ids that WERE checked did not degrade either: assertSafeHubId threw
  // inside the try, the catch returned null, and the entire index was reported
  // as unreadable. Same class of defect, same fix.
  it("an unsafe bundleId drops only that record, never the whole index", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      await writeMachineIndex(backend, indexWith([
        OK_A,
        { ...RECORD, bundleId: "../../../evil", file: "projects/p/bundles/m1/evil.tar.gz" },
        OK_B,
      ]));

      const warnings: string[] = [];
      const read = await readMachineIndex(backend, "p", "m1", warnings);
      expect(read).not.toBeNull();
      expect(read!.threads.t1.bundles.map((b) => b.bundleId)).toEqual(["b-a", "b-b"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("../../../evil");
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });

  it("readAllIndexes surfaces the dropped-record warning and still returns the index", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      await writeMachineIndex(backend, indexWith([
        OK_A,
        { ...RECORD, bundleId: "b-evil", file: "/etc/passwd" },
        OK_B,
      ]));

      const all = await readAllIndexes(backend, "p");
      expect(all.indexes).toHaveLength(1);
      expect(all.indexes[0].threads.t1.bundles.map((b) => b.bundleId)).toEqual(["b-a", "b-b"]);
      expect(all.warnings.join(" ")).toContain("b-evil");
      // Not the "unreadable index" message — the index IS readable.
      expect(all.warnings.join(" ")).not.toContain("unreadable");
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });

  it("a poisoned thread key drops that thread, not its siblings", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      const base = indexWith([OK_A]);
      base.threads["../evil"] = { ...base.threads.t1, bundles: [OK_B] };
      await writeMachineIndex(backend, base);

      const warnings: string[] = [];
      const read = await readMachineIndex(backend, "p", "m1", warnings);
      expect(read).not.toBeNull();
      expect(Object.keys(read!.threads)).toEqual(["t1"]);
      expect(read!.threads.t1.bundles.map((b) => b.bundleId)).toEqual(["b-a"]);
      expect(warnings.join(" ")).toContain("../evil");
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });

  it("still returns null for the structurally unusable cases", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      expect(await readMachineIndex(backend, "p", "absent")).toBeNull();
      await backend.writeAtomic(indexPath("p", "torn"), "{not json");
      expect(await readMachineIndex(backend, "p", "torn")).toBeNull();
      await backend.writeAtomic(indexPath("p", "v9"), JSON.stringify({ ...indexWith([]), schemaVersion: 9 }));
      expect(await readMachineIndex(backend, "p", "v9")).toBeNull();
      await backend.writeAtomic(indexPath("p", "nothreads"), JSON.stringify({ schemaVersion: 1 }));
      expect(await readMachineIndex(backend, "p", "nothreads")).toBeNull();
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });
});
