import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
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

  // Regression: a thread id is ADOPTED from a foreign index (pull-select
  // records whatever the hub published into sync-state), and the only filter it
  // passed is isSafeSessionId, which answers a different question — every
  // Object.prototype name gets through. Measured against the committed dist/:
  // all three ids below threw a raw `TypeError: Cannot read properties of
  // undefined (reading 'slice')` straight out of `hub push`, because
  // `priorIndex?.threads[threadId]?.bundles` found Object.prototype rather than
  // nothing. `__proto__` also re-parented the accumulator, so a build that got
  // past that would have published an index with the thread simply missing.
  it.each(["__proto__", "constructor", "toString"])(
    "builds and publishes a thread whose id is the Object.prototype name %s",
    (threadId) => {
      // The prior index is this machine's OWN previous push and does not carry
      // the new thread — which is what makes the lookup hazardous: on a plain
      // record `threads["constructor"]` is not "absent", it is the `Object`
      // constructor, whose `.bundles` is undefined.
      const unrelated = buildIndexFile({
        projectId: "p", machineId: "m", projectPath: "/x",
        sessions: [{ ...SESSION, sessionId: "s0" }], state: stateWithThreads({ s0: "t-other" }),
        priorIndex: null, newBundles: [{ threadId: "t-other", record: RECORD }], now: "t-1",
      });
      const first = buildIndexFile({
        projectId: "p", machineId: "m", projectPath: "/x",
        sessions: [SESSION], state: stateWithThreads({ s1: threadId }),
        priorIndex: JSON.parse(JSON.stringify(unrelated)) as HubIndexJson,
        newBundles: [{ threadId, record: RECORD }], now: "t0",
      });
      expect(Object.hasOwn(first.threads, threadId)).toBe(true);
      expect(first.threads[threadId].bundles.map((b) => b.bundleId)).toEqual(["b1"]);

      // The prior index arrives as JSON parsed off the hub, so the second push
      // has to read that same history back through the same lookup.
      const prior = JSON.parse(JSON.stringify(first)) as HubIndexJson;
      expect(Object.hasOwn(prior.threads, threadId)).toBe(true);
      const next = buildIndexFile({
        projectId: "p", machineId: "m", projectPath: "/x",
        sessions: [{ ...SESSION, messageCount: 5, headEntryUuid: "u2" }],
        state: stateWithThreads({ s1: threadId }),
        priorIndex: prior,
        newBundles: [{ threadId, record: { ...RECORD, bundleId: "b2" } }],
        now: "t1",
      });
      expect(next.threads[threadId].bundles.map((b) => b.bundleId)).toEqual(["b1", "b2"]);
      // What reaches the hub is the serialized form — that is where a
      // re-parented map loses the entry without any error.
      const onDisk = JSON.parse(JSON.stringify(next)) as HubIndexJson;
      expect(Object.hasOwn(onDisk.threads, threadId)).toBe(true);
      expect(onDisk.threads[threadId].messageCount).toBe(5);
    }
  );

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
      // Each of these carries the machineId its FILENAME implies, so the only
      // thing wrong with it is the thing it is named for. Without that, #28's
      // identity check (which runs before both) would answer for them and each
      // case would stop proving the guard it exists for — a null for the wrong
      // reason is still a green test.
      await backend.writeAtomic(indexPath("p", "v9"), JSON.stringify({ ...indexWith([]), machineId: "v9", schemaVersion: 9 }));
      expect(await readMachineIndex(backend, "p", "v9")).toBeNull();
      await backend.writeAtomic(indexPath("p", "nothreads"), JSON.stringify({ schemaVersion: 1, machineId: "nothreads" }));
      expect(await readMachineIndex(backend, "p", "nothreads")).toBeNull();
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// IDENTITY: the FILENAME wins, and a disagreeing content field is a warning
// (#28).
//
// Two things say which machine wrote an index — the path `index/<machineId>.json`
// and the `machineId` inside it — and they could disagree. The filename is the
// authoritative one: it is what `indexPath` builds, what `readAllIndexes`
// dedupes on, and the only one of the two that has passed `assertSafeHubId` by
// the time the file is read. Per-machine ownership is what makes that a rule
// rather than a preference, so a disagreement is damage — a hand edit, a
// truncated write, a sync client's conflict copy — never a legitimate state.
//
// SKIP-AND-WARN rather than fatal, and rather than repaired in memory: a
// conflict copy must not turn a pull into a failure, and this machine does not
// own that file, so rewriting its declared id would publish an id no writer
// stands behind. (Fatal is the right answer once a second PERSON's machine can
// write to a hub. Dropping the redundant field is the clean end state and is an
// index schema change.)
// ---------------------------------------------------------------------------
describe("readMachineIndex reconciles the declared machineId against the filename", () => {
  it("skips the whole file, and names both the file's id and the one it declared", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      // Byte-identical to m1's own index, one filename over — what a sync
      // client's conflict copy or a hand-copied hub directory produces.
      await backend.writeAtomic(
        indexPath("p", "m1-conflicted-copy"),
        JSON.stringify(indexWith([OK_A]), null, 2) + "\n"
      );

      const warnings: string[] = [];
      expect(await readMachineIndex(backend, "p", "m1-conflicted-copy", warnings)).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("m1-conflicted-copy");
      expect(warnings[0]).toContain('"m1"');
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });

  it("skips a declared id that is path-unsafe, so it never reaches a consumer", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      // The filename is safe ("hostile"), the declared id is not. This is the
      // value `resolveThreads` used to copy verbatim into `ThreadCopy.machineId`
      // — path-unsafe, and validated by nothing on the way.
      await backend.writeAtomic(
        indexPath("p", "hostile"),
        JSON.stringify({ ...indexWith([OK_A]), machineId: "../evil" }, null, 2) + "\n"
      );

      const warnings: string[] = [];
      expect(await readMachineIndex(backend, "p", "hostile", warnings)).toBeNull();
      expect(warnings.join(" ")).toContain('"../evil"');
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });

  it("skips a file that declares no machineId at all", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      const { machineId: _dropped, ...noId } = indexWith([OK_A]);
      await backend.writeAtomic(indexPath("p", "m1"), JSON.stringify(noId, null, 2) + "\n");

      const warnings: string[] = [];
      expect(await readMachineIndex(backend, "p", "m1", warnings)).toBeNull();
      expect(warnings).toHaveLength(1);
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });

  it("readAllIndexes drops only that file, keeps every other machine, and reports it exactly once", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-hub-idx-"));
    try {
      const backend = createFsBackend(hub);
      await writeMachineIndex(backend, indexWith([OK_A]));                    // m1, agreeing
      await writeMachineIndex(backend, { ...indexWith([OK_B]), machineId: "m2" }); // m2, agreeing
      await backend.writeAtomic(
        indexPath("p", "m1-conflicted-copy"),
        JSON.stringify(indexWith([OK_A]), null, 2) + "\n"
      );

      const all = await readAllIndexes(backend, "p");
      // The blast radius is the file: m1 and m2 both still answer.
      expect(all.indexes.map((i) => i.machineId).sort()).toEqual(["m1", "m2"]);
      // EXACTLY ONE message for it. readMachineIndex explains this null itself,
      // so readAllIndexes must not also append its generic "unreadable" line —
      // one damaged file reported twice, the second time as something it is not
      // (the file parses perfectly).
      expect(all.warnings).toHaveLength(1);
      expect(all.warnings[0]).toContain("m1-conflicted-copy");
      expect(all.warnings[0]).not.toContain("unreadable");
    } finally { rmSync(hub, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// `HubThreadEntry.summary` has exactly ONE writer, and it writes the SLUG.
//
// An index file is plaintext by design, so everything in it is readable by
// anything with access to the shared hub directory. Three of this field's four
// writers put `slug` in it; the fourth — `hub reindex`'s synthetic prior, built
// from bundle manifests — put a real `SessionManifest.summary` there, which for
// any untitled session is up to 100 characters of the first user message
// (discovery.ts falls back to the session id for the slug, and
// extractSummaryFromFile rejects a UUID slug). And it stuck: a later ordinary
// push or pull read the poisoned entry back as its own `priorIndex` and copied
// it forward verbatim.
// ---------------------------------------------------------------------------

describe("buildIndexFile is the only writer of a thread entry's summary", () => {
  it("writes the slug for a live session, ignoring any summary the caller supplies", () => {
    // Shaped like the leak: a UUID slug (the untitled-session fallback) next to
    // an excerpt of the first user message. Held in a const rather than written
    // inline so the extra key survives to the call — it is the input a caller
    // ought not to be able to express, and the point is that it is IGNORED.
    const untitled = {
      ...SESSION,
      slug: "550e8400-e29b-41d4-a716-446655440000",
      summary: "SECRET help me reset my banking password",
    };
    const built = buildIndexFile({
      projectId: "p", machineId: "m", projectPath: "/x",
      sessions: [untitled], state: stateWithThreads({ s1: "t1" }),
      priorIndex: null, newBundles: [], now: "t",
    });
    expect(built.threads.t1.summary).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(built.threads.t1.summary).toBe(built.threads.t1.slug);
    expect(JSON.stringify(built)).not.toContain("SECRET");
  });

  // The sticky half. A thread whose local session has vanished is carried
  // forward from the prior index — that is deliberate (its bundles are still
  // pullable elsewhere) and must keep working — but it is also the one door an
  // already-poisoned entry comes back through, on every push and pull, forever.
  it("scrubs a poisoned summary out of a carried-forward thread, keeping its bundle history", () => {
    const poisoned: HubIndexJson = {
      schemaVersion: 1, agent: "claude-code", projectId: "p", machineId: "m",
      updatedAt: "t-1", projectPath: "/x",
      threads: {
        gone: {
          localSessionId: "s-gone",
          slug: "770e8400-e29b-41d4-a716-446655440000",
          summary: "SECRET help me reset my banking password",
          headEntryUuid: "u-gone", messageCount: 9,
          lastActiveAt: "2026-07-20T00:00:00Z", bundles: [RECORD],
        },
      },
    };
    // No live session claims that thread — exactly the shape reindex's synthetic
    // prior produces, and the shape a later push reads back off the hub.
    const built = buildIndexFile({
      projectId: "p", machineId: "m", projectPath: "/x",
      sessions: [], state: stateWithThreads({}),
      priorIndex: poisoned, newBundles: [], now: "t",
    });
    expect(built.threads.gone).toBeDefined();
    expect(built.threads.gone.summary).toBe("770e8400-e29b-41d4-a716-446655440000");
    expect(built.threads.gone.summary).toBe(built.threads.gone.slug);
    expect(JSON.stringify(built)).not.toContain("SECRET");
    // The carry-forward itself is untouched: this is a scrub, not a drop.
    expect(built.threads.gone.localSessionId).toBe("s-gone");
    expect(built.threads.gone.messageCount).toBe(9);
    expect(built.threads.gone.bundles.map((b) => b.bundleId)).toEqual(["b1"]);
  });

  /**
   * THE STRUCTURAL HALF — this is the assertion that fails when a second writer
   * appears, and it is deliberately about FILES rather than lines.
   *
   * The behavioural tests above pin the two doors `buildIndexFile` has today. A
   * second writer would not come through either: it would be a new hub module
   * assembling a `HubThreadEntry` of its own and handing it to
   * `writeMachineIndex`, which is precisely how the fourth writer arrived in the
   * first place (91869d6 added reindex's two together). So the claim under guard
   * is module ownership: within `src/hub/`, exactly these files may name this
   * key, and each for a different, stated reason.
   *
   * It reads every `.ts` in the directory ITSELF rather than trusting a search.
   * That is not ceremony: `src/hub/threads.ts` contains a raw NUL byte
   * (`sourcedKey`'s separator), so GNU grep classifies it as binary and a
   * `grep -rn` over `src/` reports NOTHING for it — the file is invisible to
   * exactly the audit someone would run before adding a writer. It is a reader
   * here; a writer hiding there would have been just as invisible.
   *
   * It is a text scan, so it is a checklist and not a verifier — the same class
   * of guard as `tests/hub-warning-flags.test.ts`, with the same limits. It
   * cannot see a second writer added INSIDE index-file.ts, and a `summary:` in
   * a trailing comment in another hub module will trip it. Both are the decision
   * it exists to force: rephrase, or add the file here with a reason.
   */
  it("no hub module outside the declaration, the writer and the two readers names the key", () => {
    const owners: Record<string, string> = {
      "layout.ts": "declares HubThreadEntry.summary — the on-disk schema",
      "index-file.ts": "buildIndexFile — the one writer, deriving it from the slug",
      "threads.ts": "reads an index entry's onto ThreadCopy/ResolvedThread",
      "whereis.ts": "reads a ResolvedThread's onto WhereisThread",
    };
    const hubDir = join(import.meta.dirname, "..", "src", "hub");
    const named: string[] = [];
    for (const file of readdirSync(hubDir).filter((f) => f.endsWith(".ts")).sort()) {
      const hit = readFileSync(join(hubDir, file), "utf-8")
        .split("\n")
        // Cheap comment rejection: a doc-comment body starts with `*`, a line
        // comment with `//` or `/*`. No parser, and no need for one — the
        // failure mode is a false ALARM, which this test is allowed to have.
        .map((l) => l.trim())
        .filter((l) => !l.startsWith("*") && !l.startsWith("//") && !l.startsWith("/*"))
        .some((l) => /\bsummary\s*:/.test(l));
      if (hit) named.push(file);
    }
    expect(named).toEqual(Object.keys(owners).sort());
    // ...and the scan really can see the key, so a comment filter that silently
    // ate everything cannot pass this as "no writers found".
    expect(named.length).toBe(4);
  });
});
