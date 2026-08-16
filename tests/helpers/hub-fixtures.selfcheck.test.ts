/**
 * Self-check for the shared hub fixtures.
 *
 * A fixture that lies is worse than no fixture: a test built on
 * `writeCorruptBundle` passes just as green when the "corrupt" bundle is
 * actually fine and the code under test never refused anything. So each fixture
 * here is measured against the REAL verifier it is meant to trip
 * (`src/manifest.ts`) or the real resolver it is meant to feed
 * (`src/hub/threads.ts`), never against a restatement of its own construction.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend } from "../../src/hub/backend.js";
import { extractArchive } from "../../src/archiver.js";
import {
  computeIntegrityHashFromFile,
  readManifest,
  verifySessionsDigest,
} from "../../src/manifest.js";
import { resolveThreads } from "../../src/hub/threads.js";
import { readAllIndexes } from "../../src/hub/index-file.js";
import { getThreadId } from "../../src/sync-state.js";
import {
  arrangeThreeMachines,
  chainDeltaStart,
  chainHead,
  chainIndexes,
  currentThreadIndexes,
  emptySyncState,
  writeCorruptBundle,
  CHAIN_LAST_ACTIVE_AT,
  CORRUPT_BUNDLE_HEAD_UUID,
} from "./hub-fixtures.js";
import type { HubIndexJson } from "../../src/hub/layout.js";

/** Pull the bundle back off the hub and unpack it, the way hub/pull.ts does. */
async function fetchAndExtract(hubPath: string, file: string, into: string): Promise<void> {
  const backend = createFsBackend(hubPath);
  const tarPath = join(into, "in.tar.gz");
  mkdirSync(into, { recursive: true });
  writeFileSync(tarPath, await backend.read(file));
  await extractArchive(tarPath, into);
}

describe("writeCorruptBundle", () => {
  it("lands a real archive on the hub that extracts and parses", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-fx-hub-"));
    const work = mkdtempSync(join(tmpdir(), "sesh-fx-work-"));
    try {
      const backend = createFsBackend(hub);
      const record = await writeCorruptBundle(backend, "p1");

      expect(record.file).toMatch(/^projects\/p1\/bundles\/m1\/.*\.tar\.gz$/);
      expect(await backend.exists(record.file)).toBe(true);

      // Structurally sound: gzip CRC intact, tar entries safe, strip:1 puts the
      // bundle tree directly under the extract dir.
      const out = join(work, "extract");
      await expect(fetchAndExtract(hub, record.file, out)).resolves.toBeUndefined();
      expect(existsSync(join(out, "manifest.json"))).toBe(true);

      const manifest = readManifest(out);
      expect(manifest.plugin).toBe("sesh-mover");
      expect(manifest.sessions).toHaveLength(1);
      expect(manifest.sessions[0].sessionId).toBe(record.sessionIdInBundle);
      expect(record.headEntryUuid).toBe(CORRUPT_BUNDLE_HEAD_UUID);

      // The bundle declares a session and actually contains it — the OTHER
      // failure hub/pull.ts checks for right after extraction, which this
      // fixture must not be confused with.
      const jsonlPath = join(out, "sessions", `${record.sessionIdInBundle}.jsonl`);
      expect(existsSync(jsonlPath)).toBe(true);

      // Every line still parses: the damage is in the hashes, not the syntax.
      const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter((l) => l !== "");
      expect(lines).toHaveLength(manifest.sessions[0].messageCount);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      expect((JSON.parse(lines[lines.length - 1]) as { uuid: string }).uuid).toBe(
        CORRUPT_BUNDLE_HEAD_UUID
      );
    } finally {
      for (const d of [hub, work]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("fails the manifest's own sessions digest", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-fx-hub-"));
    const work = mkdtempSync(join(tmpdir(), "sesh-fx-work-"));
    try {
      const backend = createFsBackend(hub);
      const record = await writeCorruptBundle(backend, "p1");
      const out = join(work, "extract");
      await fetchAndExtract(hub, record.file, out);

      // The real check hub/pull.ts runs on every fetched bundle.
      const problem = verifySessionsDigest(readManifest(out));
      expect(problem).not.toBeNull();
      expect(problem).toMatch(/digest/i);
    } finally {
      for (const d of [hub, work]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("fails the per-session content hash: the transcript is not what the manifest declares", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-fx-hub-"));
    const work = mkdtempSync(join(tmpdir(), "sesh-fx-work-"));
    try {
      const backend = createFsBackend(hub);
      const record = await writeCorruptBundle(backend, "p1");
      const out = join(work, "extract");
      await fetchAndExtract(hub, record.file, out);

      const declared = readManifest(out).sessions[0].integrityHash;
      const actual = await computeIntegrityHashFromFile(
        join(out, "sessions", `${record.sessionIdInBundle}.jsonl`)
      );
      expect(declared).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(actual).not.toBe(declared);
    } finally {
      for (const d of [hub, work]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("honours its overrides so two corrupt bundles can coexist on one hub", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-fx-hub-"));
    try {
      const backend = createFsBackend(hub);
      const a = await writeCorruptBundle(backend, "p1");
      const b = await writeCorruptBundle(backend, "p1", {
        machineId: "m2",
        bundleId: "corrupt-two",
        sessionId: "11111111-2222-3333-4444-555555555555",
        pushedAt: "2026-07-22T00:00:00.000Z",
      });

      expect(b.file).not.toBe(a.file);
      expect(b.file).toContain("/bundles/m2/");
      expect(b.file).toContain("corrupt-two");
      // ':' is illegal in a Windows filename — bundleFileName sanitizes it.
      expect(b.file).not.toContain(":");
      expect(await backend.exists(a.file)).toBe(true);
      expect(await backend.exists(b.file)).toBe(true);
      expect(b.sessionIdInBundle).toBe("11111111-2222-3333-4444-555555555555");
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  });
});

describe("currentThreadIndexes", () => {
  it("resolves to threads whose latest copy is m1's own — every thread current there", () => {
    const indexes = currentThreadIndexes();
    expect(indexes).toHaveLength(1);
    expect(indexes[0].machineId).toBe("m1");

    const resolved = resolveThreads(indexes);
    expect(resolved.map((t) => t.threadId).sort()).toEqual(["t1", "t2"]);
    for (const t of resolved) {
      // hub/pull.ts's `isCurrent`, restated against the real resolver.
      const local = t.copies.find((c) => c.machineId === "m1");
      expect(local).toBeDefined();
      expect(local?.headEntryUuid).toBe(t.latest.headEntryUuid);
      // No other machine lists bundles, so no `alternateSource` exists either.
      expect(t.copies.filter((c) => c.machineId !== "m1")).toHaveLength(0);
      expect(t.latest.bundles.length).toBeGreaterThan(0);
      expect(t.latest.bundles.every((b) => b.type === "full")).toBe(true);
    }
  });

  it("takes overrides for machine, project and thread ids", () => {
    const indexes = currentThreadIndexes({
      machineId: "laptop",
      projectId: "proj-9",
      threadIds: ["only-thread"],
    });
    expect(indexes[0].machineId).toBe("laptop");
    expect(indexes[0].projectId).toBe("proj-9");
    expect(Object.keys(indexes[0].threads)).toEqual(["only-thread"]);
    expect(indexes[0].threads["only-thread"].bundles[0].file).toContain("/bundles/laptop/");
  });
});

// ---- chainIndexes ----
//
// Every assertion below reads the LINK STRUCTURE back out of `resolveThreads`'s
// output, never out of the spec that produced it. `chainView` is the head-keyed
// walk an assembler has to build; it is written here, against the real resolver,
// precisely so a builder that emitted the wrong anchor cannot be green-lit by a
// test that restates what the builder was asked for.
//
// It links on `anchorEntryUuid` and NEVER on `fromEntryUuid` — the two are
// different fields carrying different facts, and linking on the latter is the
// #35 defect (see `chainDeltaStart`). A record with no `anchorEntryUuid` key at
// all is pre-assembly: a root if it is `full`, an orphan if it is a
// `continuation`, and unlinkable either way.

interface ChainRecordView {
  machineId: string;
  bundleId: string;
  type: "full" | "continuation";
  from: string | null;
  /** `undefined` = the key is absent = pre-assembly. `null` = a root. */
  anchor: string | null | undefined;
  head: string;
}

interface ChainView {
  threadId: string;
  /** The thread head each machine ADVERTISES — the other half of the projection. */
  advertised: Record<string, string>;
  records: ChainRecordView[];
  roots: ChainRecordView[];
  /** Keys of the head-indexed map a walk builds. `""` must never be one. */
  headKeys: string[];
  /** Records whose anchor uuid matches no record's head: the gaps. */
  dangling: ChainRecordView[];
  /** Continuations carrying no anchor at all: pushed before assembly existed. */
  unanchored: ChainRecordView[];
  /** Anchors shared by more than one record: the forks. */
  forks: string[];
  /** Forward walk from each root, in order. */
  chains: ChainRecordView[][];
  /** Records no walk from any root reaches. */
  unreachable: ChainRecordView[];
}

function chainView(indexes: HubIndexJson[]): ChainView {
  const threads = resolveThreads(indexes);
  expect(threads).toHaveLength(1);
  const t = threads[0];
  const records: ChainRecordView[] = t.copies.flatMap((c) =>
    c.bundles.map((b) => ({
      machineId: c.machineId,
      bundleId: b.bundleId,
      type: b.type,
      from: b.fromEntryUuid,
      // `in`, not `?? null`: absent and null are two different facts here.
      anchor: "anchorEntryUuid" in b ? b.anchorEntryUuid : undefined,
      head: b.headEntryUuid,
    }))
  );

  // "" is never a link, so it is never a KEY here: two empty heads would
  // collide and one record would silently vanish from the chain
  // (src/hub/threads.ts, "two empty strings are not a match").
  const byHead = new Map<string, ChainRecordView>();
  for (const r of records) if (r.head !== "") byHead.set(r.head, r);
  const byAnchor = new Map<string, ChainRecordView[]>();
  for (const r of records) {
    if (typeof r.anchor !== "string" || r.anchor === "") continue;
    byAnchor.set(r.anchor, [...(byAnchor.get(r.anchor) ?? []), r]);
  }

  // A root is a record that starts a chain: one that declares no anchor
  // (`null`), or a pre-assembly `full` bundle, whose type is the only thing
  // left saying so. A pre-assembly CONTINUATION is not a root — it is an
  // orphan, and calling it a root would invent a second starting point.
  const roots = records.filter((r) => r.anchor === null || (r.anchor === undefined && r.type === "full"));
  const chains: ChainRecordView[][] = roots.map((root) => {
    const order = [root];
    let cur = root;
    for (;;) {
      if (cur.head === "") break; // unlinkable forward by construction: a gap
      const next = byAnchor.get(cur.head) ?? [];
      if (next.length !== 1) break; // 0 = end or gap, >1 = fork
      cur = next[0];
      order.push(cur);
    }
    return order;
  });
  const reached = new Set(chains.flat().map((r) => r.bundleId));

  return {
    threadId: t.threadId,
    advertised: Object.fromEntries(t.copies.map((c) => [c.machineId, c.headEntryUuid])),
    records,
    roots,
    headKeys: [...byHead.keys()],
    dangling: records.filter((r) => typeof r.anchor === "string" && !byHead.has(r.anchor)),
    unanchored: records.filter((r) => r.anchor === undefined && r.type === "continuation"),
    forks: [...byAnchor.entries()].filter(([, rs]) => rs.length > 1).map(([uuid]) => uuid),
    chains,
    unreachable: records.filter((r) => !reached.has(r.bundleId)),
  };
}

describe("chainIndexes", () => {
  it("linear across three machines: one root, one chain, three machines, no gap or fork", () => {
    const v = chainView(chainIndexes({ m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b1"] }));

    expect(v.roots.map((r) => r.bundleId)).toEqual(["b0"]);
    expect(v.chains).toHaveLength(1);
    expect(v.chains[0].map((r) => r.bundleId)).toEqual(["b0", "b1", "b2"]);
    // The point of the fixture: no ONE machine's index holds the chain.
    expect(v.chains[0].map((r) => r.machineId)).toEqual(["m1", "m2", "m3"]);
    expect(v.dangling).toEqual([]);
    expect(v.forks).toEqual([]);
    expect(v.unreachable).toEqual([]);
    // A root is a full bundle and a linked record is a continuation, as both
    // writers spell it — nothing here has to say so at the call site.
    expect(v.records.map((r) => r.type)).toEqual(["full", "continuation", "continuation"]);
  });

  it("gap: a record anchored on a head no machine's index ships stops the chain", () => {
    // b1 is deliberately absent from the spec — chainHead names its head so the
    // absence is stated rather than a typo's side effect.
    const v = chainView(chainIndexes({ m1: ["b0"], m2: [{ id: "b2", anchorUuid: chainHead("b1") }] }));

    expect(v.records.map((r) => r.bundleId).sort()).toEqual(["b0", "b2"]);
    expect(v.dangling.map((r) => r.bundleId)).toEqual(["b2"]);
    expect(v.chains.map((c) => c.map((r) => r.bundleId))).toEqual([["b0"]]);
    expect(v.unreachable.map((r) => r.bundleId)).toEqual(["b2"]);
    // A gap is not a fork, not a second root, and not a pre-assembly record —
    // four different conditions, and only one of them is repairable.
    expect(v.roots.map((r) => r.bundleId)).toEqual(["b0"]);
    expect(v.forks).toEqual([]);
    expect(v.unanchored).toEqual([]);
    // anchorUuid rides through verbatim: it is the raw uuid, not a bundle id.
    expect(v.records.find((r) => r.bundleId === "b2")?.anchor).toBe("head-b1");
    // A declared anchor makes it a continuation even though it names nothing.
    expect(v.records.find((r) => r.bundleId === "b2")?.type).toBe("continuation");
  });

  it("throws on an anchor naming an undeclared record, so a typo cannot become a gap", () => {
    expect(() => chainIndexes({ m1: ["b0"], m2: ["b1<-b_typo"] })).toThrow(/undeclared record/);
    expect(() => chainIndexes({ m1: ["b0"], m2: ["b0<-b0"] })).toThrow(/duplicate bundle id/);
    expect(() =>
      chainIndexes({ m1: ["b0"], m2: [{ id: "b1", from: "b0", anchorUuid: "x" }] })
    ).toThrow(/both "from" and "anchorUuid"/);
  });

  it("a nonsense fromEntryUuid does not disturb the chain: the anchor is the link", () => {
    // The regression guard for #35's actual defect. `fromEntryUuid` is the
    // anchor's CHILD on a real hub and links nothing; an assembler that fell
    // back to it would chain on this garbage instead.
    const v = chainView(
      chainIndexes({
        m1: ["b0"],
        m2: [{ id: "b1", from: "b0", fromUuid: chainHead("b0") }],
        m3: [{ id: "b2", from: "b1", fromUuid: "not-a-uuid-at-all" }],
      })
    );
    expect(v.chains.map((c) => c.map((r) => r.bundleId))).toEqual([["b0", "b1", "b2"]]);
    expect(v.records.find((r) => r.bundleId === "b2")?.from).toBe("not-a-uuid-at-all");
    expect(v.dangling).toEqual([]);
  });

  it("fork: two records share one anchor", () => {
    const v = chainView(chainIndexes({ m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b0"] }));

    expect(v.forks).toEqual([chainHead("b0")]);
    expect(v.roots.map((r) => r.bundleId)).toEqual(["b0"]);
    // The walk stops AT the fork rather than picking a branch: choosing one is
    // the assembler's job, not the fixture's.
    expect(v.chains.map((c) => c.map((r) => r.bundleId))).toEqual([["b0"]]);
    expect(v.unreachable.map((r) => r.bundleId).sort()).toEqual(["b1", "b2"]);
    expect(v.dangling).toEqual([]);
  });

  it("multiple roots in ONE thread resolve without throwing — ordinary, not anomalous", () => {
    // src/diff.ts re-sends a session whole whenever the recorded head is empty
    // or is no longer present (compaction, truncation, rollback), and
    // src/hub/push.ts files that record under the SAME thread id — it mints a
    // new one only for a session that has none. Two roots, one thread.
    const indexes = chainIndexes({ m1: ["b0", "b2"], m2: ["b1<-b0"] });
    expect(() => resolveThreads(indexes)).not.toThrow();

    const v = chainView(indexes);
    expect(v.roots.map((r) => r.bundleId)).toEqual(["b0", "b2"]);
    expect(v.roots.every((r) => r.type === "full")).toBe(true);
    // One thread, two independent linked lists — never merged into one list.
    expect(v.chains.map((c) => c.map((r) => r.bundleId))).toEqual([["b0", "b1"], ["b2"]]);
    expect(v.unreachable).toEqual([]);
    expect(v.dangling).toEqual([]);
  });

  it("an empty head terminates its chain, and two empty heads do not link to each other", () => {
    // b0 -> b1(head "") ; b2 anchors on b1, so its own anchor is "" ;
    // b3 chains onto b2 and also ships an empty head ; b4 anchors on b3.
    const indexes = chainIndexes({
      m1: ["b0", { id: "b1", from: "b0", head: "" }],
      m2: [{ id: "b2", from: "b1" }, { id: "b3", from: "b2", head: "" }, { id: "b4", from: "b3" }],
    });
    const v = chainView(indexes);

    // The builder does NOT repair the anchor when the record it names ships an
    // empty head: b2 and b4 anchor on "", exactly the shape the rule rejects.
    expect(v.records.filter((r) => r.head === "").map((r) => r.bundleId)).toEqual(["b1", "b3"]);
    expect(v.records.filter((r) => r.anchor === "").map((r) => r.bundleId)).toEqual(["b2", "b4"]);

    // "" is never a KEY: two empty-headed records would otherwise collide and
    // one would vanish from the chain. Every other record contributes one key.
    expect(v.headKeys).not.toContain("");
    expect(v.headKeys.sort()).toEqual([chainHead("b0"), chainHead("b2"), chainHead("b4")]);

    // Two empty strings are not a match: b2 does not chain onto b1, b4 does not
    // chain onto b3, and neither anchors onto the other's empty head either.
    expect(v.chains.map((c) => c.map((r) => r.bundleId))).toEqual([["b0", "b1"]]);
    expect(v.unreachable.map((r) => r.bundleId).sort()).toEqual(["b2", "b3", "b4"]);
    // An anchor of "" matches nothing, ever — so it is a gap, not a root.
    expect(v.dangling.map((r) => r.bundleId)).toEqual(["b2", "b4"]);
    expect(v.roots.map((r) => r.bundleId)).toEqual(["b0"]);
    expect(v.forks).toEqual([]);
  });

  it("'push' — the default, and what the writers emit — LINKS, and 'anchor' agrees with it", () => {
    // The measurement this task moved. src/diff.ts still sets fromEntryUuid to
    // entries[headIndex + 1].uuid — one PAST the head — and both index writers
    // still copy that through unchanged. What changed is that they now also
    // carry `anchorEntryUuid`, the head the delta WAS diffed against, and that
    // is what the walk links on. So the two styles differ on fromEntryUuid and
    // agree on the chain, which is the property assembly needs.
    const push = chainView(chainIndexes({ m1: ["b0"], m2: ["b1<-b0"] }));
    const anchor = chainView(chainIndexes({ m1: ["b0"], m2: ["b1<-b0"] }, { linkStyle: "anchor" }));

    expect(push.records.find((r) => r.bundleId === "b1")?.from).toBe(chainDeltaStart("b1"));
    expect(anchor.records.find((r) => r.bundleId === "b1")?.from).toBe(chainHead("b0"));
    // ...and the anchor is the same value in both, regardless.
    for (const v of [push, anchor]) {
      expect(v.records.find((r) => r.bundleId === "b1")?.anchor).toBe(chainHead("b0"));
      expect(v.chains.map((c) => c.map((r) => r.bundleId))).toEqual([["b0", "b1"]]);
      expect(v.dangling).toEqual([]);
      expect(v.unanchored).toEqual([]);
      expect(v.roots.map((r) => r.bundleId)).toEqual(["b0"]);
      // A root declares an anchor too — an explicit null, "no anchor exists",
      // which is a different fact from the absent key a pre-assembly record has.
      expect(v.roots[0].anchor).toBeNull();
    }
  });

  it("'pre-assembly' carries no anchor at all: the root stands, the continuation is an orphan", () => {
    // Every bundle already on every hub. Nothing distinguishes such a record
    // from a new one except the absence of the key, which is exactly why the
    // field had to be additive rather than a redefinition of fromEntryUuid.
    const v = chainView(chainIndexes({ m1: ["b0"], m2: ["b1<-b0"] }, { linkStyle: "pre-assembly" }));

    expect(v.records.every((r) => r.anchor === undefined)).toBe(true);
    expect(v.records.find((r) => r.bundleId === "b1")?.from).toBe(chainDeltaStart("b1"));
    // The full bundle is still a root — its type says so. The continuation is
    // unlinkable, and it is reported as pre-assembly, NOT as a gap: a gap names
    // a bundle that should exist, and nothing here is missing.
    expect(v.roots.map((r) => r.bundleId)).toEqual(["b0"]);
    expect(v.unanchored.map((r) => r.bundleId)).toEqual(["b1"]);
    expect(v.dangling).toEqual([]);
    expect(v.chains.map((c) => c.map((r) => r.bundleId))).toEqual([["b0"]]);
    expect(v.unreachable.map((r) => r.bundleId)).toEqual(["b1"]);
  });

  it("per-record preAssembly builds a MIXED hub: old bundles beside new ones", () => {
    // The realistic state right after this ships, and the one Task 4 has to
    // survive: b1 was pushed by the old code and b2 by the new. b2's anchor is
    // b1's head and is perfectly good — but b1 cannot be reached from b0, so
    // the contiguous chain from the root stops at b0 and everything behind the
    // pre-assembly record is stranded.
    const v = chainView(
      chainIndexes({ m1: ["b0"], m2: [{ id: "b1", from: "b0", preAssembly: true }], m3: ["b2<-b1"] })
    );

    expect(v.unanchored.map((r) => r.bundleId)).toEqual(["b1"]);
    expect(v.records.find((r) => r.bundleId === "b2")?.anchor).toBe(chainHead("b1"));
    expect(v.chains.map((c) => c.map((r) => r.bundleId))).toEqual([["b0"]]);
    expect(v.unreachable.map((r) => r.bundleId).sort()).toEqual(["b1", "b2"]);
    // b2's anchor names a head that IS on the hub, so it is not dangling — the
    // break is b1's missing anchor, and the report must say which.
    expect(v.dangling).toEqual([]);
  });

  it("advertised-but-unshipped: a machine's thread head matches no bundle record", () => {
    const indexes = chainIndexes(
      { m1: ["b0"], m2: ["b1<-b0"] },
      { advertise: { m2: { headEntryUuid: "local-work-never-pushed" } } }
    );
    const v = chainView(indexes);

    const shippedHeads = new Set(v.records.map((r) => r.head));
    expect(shippedHeads.has(v.advertised.m2)).toBe(false);
    // m1 by contrast advertises exactly what it shipped — the default, and the
    // control that keeps the assertion above from passing vacuously.
    expect(v.advertised.m1).toBe(chainHead("b0"));
    expect(shippedHeads.has(v.advertised.m1)).toBe(true);
    // The bundle list is untouched by an advertise override.
    expect(v.chains.map((c) => c.map((r) => r.bundleId))).toEqual([["b0", "b1"]]);
  });

  it("a machine that lists no bundles advertises nothing, rather than borrowing a head", () => {
    const v = chainView(chainIndexes({ m1: ["b0"], m2: [] }));
    expect(v.advertised.m2).toBe("");
    expect(v.records.map((r) => r.machineId)).toEqual(["m1"]);
  });

  it("ties on every resolver key by default, so nothing is pinned by accident", () => {
    const indexes = chainIndexes({ m1: ["b0"], m2: ["b1<-b0"] });
    const copies = resolveThreads(indexes)[0].copies;
    expect(copies.map((c) => c.lastActiveAt)).toEqual([CHAIN_LAST_ACTIVE_AT, CHAIN_LAST_ACTIVE_AT]);
    expect(new Set(copies.map((c) => c.messageCount)).size).toBe(1);
  });

  it("advertise pins the resolution on lastActiveAt, the resolver's first key", () => {
    const spec = { m1: ["b0"], m2: ["b1<-b0"] };
    const pin = { lastActiveAt: "2026-07-22T00:00:00.000Z" };

    expect(resolveThreads(chainIndexes(spec, { advertise: { m2: pin } }))[0].latest.machineId)
      .toBe("m2");
    expect(resolveThreads(chainIndexes(spec, { advertise: { m1: pin } }))[0].latest.machineId)
      .toBe("m1");
  });

  it("resolution does not move when the spec's machine keys are written in the other order", () => {
    const pin = { m2: { lastActiveAt: "2026-07-22T00:00:00.000Z" } };
    const forward = chainIndexes({ m1: ["b0"], m2: ["b1<-b0"] }, { advertise: pin });
    const reverse = chainIndexes({ m2: ["b1<-b0"], m1: ["b0"] }, { advertise: pin });

    // Declaration order is preserved in the array — the fixture does NOT sort,
    // because sorting would hide any index-iteration-order dependence in the
    // code under test rather than exposing it.
    expect(forward.map((i) => i.machineId)).toEqual(["m1", "m2"]);
    expect(reverse.map((i) => i.machineId)).toEqual(["m2", "m1"]);
    expect(resolveThreads(reverse)[0].latest.machineId).toBe(
      resolveThreads(forward)[0].latest.machineId
    );
  });

  it("stamps pushedAt AGAINST link order, so an implementation that sorts by it fails", () => {
    const v = chainView(chainIndexes({ m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b1"] }));
    const stampOf = (id: string): string => {
      const rec = resolveThreads(chainIndexes({ m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b1"] }))[0]
        .copies.flatMap((c) => c.bundles)
        .find((b) => b.bundleId === id);
      return rec!.pushedAt;
    };
    const linkOrder = v.chains[0].map((r) => r.bundleId);
    const byPushedAt = [...linkOrder].sort((a, b) => (stampOf(a) < stampOf(b) ? -1 : 1));
    expect(linkOrder).toEqual(["b0", "b1", "b2"]);
    expect(byPushedAt).toEqual(["b2", "b1", "b0"]);
  });

  it("builds every bundle path through the real layout builders", () => {
    const v = chainIndexes({ laptop: ["b0"] }, { projectId: "proj-9" });
    const record = v[0].threads.t1.bundles[0];
    expect(record.file.startsWith("projects/proj-9/bundles/laptop/")).toBe(true);
    expect(record.file.endsWith("-b0.tar.gz")).toBe(true);
    // ':' is illegal in a Windows filename — bundleFileName sanitizes it.
    expect(record.file).not.toContain(":");
    expect(v[0].projectId).toBe("proj-9");
    expect(v[0].schemaVersion).toBe(1);
  });
});

describe("arrangeThreeMachines", () => {
  it("resolvesTo B: the chain is A's root plus B's continuation, and C resolves to B", async () => {
    const f = await arrangeThreeMachines();
    try {
      expect(f.resolvesTo).toBe("B");
      expect(f.latestMachineId).toBe(f.machineIdB);
      expect(f.machineIdC).not.toBe(f.machineIdA);
      expect(f.machineIdC).not.toBe(f.machineIdB);

      const { indexes } = await readAllIndexes(createFsBackend(f.hub), f.projectId);
      const v = chainView(indexes);
      expect(v.threadId).toBe(f.threadId);
      // A holds the only root; B holds the continuation. One conversation, two
      // machines, and neither index lists it whole — the #35 shape.
      expect(v.roots).toHaveLength(1);
      expect(v.roots[0].machineId).toBe(f.machineIdA);
      expect(v.roots[0].type).toBe("full");
      expect(f.bundleIdsA).toHaveLength(1);
      expect(f.bundleIdsB).toHaveLength(1);
      expect(v.records.find((r) => r.machineId === f.machineIdB)?.type).toBe("continuation");

      // C has joined and linked, and has pulled nothing: no index, no session.
      expect(indexes.some((i) => i.machineId === f.machineIdC)).toBe(false);
      expect(existsSync(f.projectDirC)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("resolvesTo A: A republishes after pulling B back, and C resolves to A", async () => {
    const f = await arrangeThreeMachines({ resolvesTo: "A" });
    try {
      expect(f.resolvesTo).toBe("A");
      expect(f.latestMachineId).toBe(f.machineIdA);

      const { indexes } = await readAllIndexes(createFsBackend(f.hub), f.projectId);
      const v = chainView(indexes);
      // A: root + republished continuation. B: the middle link. So the true
      // order is A -> B -> A and NO machine's list is contiguous on its own —
      // the branch where a pull resolving to A finds a hole in the middle.
      expect(f.bundleIdsA).toHaveLength(2);
      expect(f.bundleIdsB).toHaveLength(1);
      expect(v.roots.map((r) => r.machineId)).toEqual([f.machineIdA]);

      // The pin is lastActiveAt, and it is A's republished entry's own
      // timestamp — the first key, decided through the production path.
      const copies = resolveThreads(indexes)[0].copies;
      const at = (machineId: string): string =>
        copies.find((c) => c.machineId === machineId)!.lastActiveAt;
      expect(at(f.machineIdA) > at(f.machineIdB)).toBe(true);
      expect(at(f.machineIdA)).toBe("2026-04-12T08:00:05Z");
    } finally {
      f.cleanup();
    }
  });

  // THE property the whole walk rests on, measured on REAL pushed bundles
  // rather than on a synthetic record — A pushes, B pulls and continues, B
  // pushes, A pulls back and republishes. Before Task 3.5 this test asserted
  // the opposite (`fromEntryUuid` is the head's child, so a head-keyed map
  // links nothing); the fields it measures have not changed, the record simply
  // now carries the anchor beside them.
  it("the real bundles link on anchorEntryUuid, while fromEntryUuid stays the head's CHILD", async () => {
    const f = await arrangeThreeMachines({ resolvesTo: "A" });
    try {
      const { indexes } = await readAllIndexes(createFsBackend(f.hub), f.projectId);
      const v = chainView(indexes);

      const root = v.records.find((r) => r.bundleId === f.bundleIdsA[0])!;
      const middle = v.records.find((r) => r.machineId === f.machineIdB)!;
      const last = v.records.find((r) => r.bundleId === f.bundleIdsA[1])!;

      // The assertion this task exists for: B's continuation record's anchor IS
      // A's bundle's headEntryUuid. Nothing derives it — both sides are read
      // back off the hub, written by two separate real pushes on two machines.
      expect(root.head).toBe("entry-3");
      expect(middle.anchor).toBe(root.head);
      expect(last.anchor).toBe(middle.head);
      expect(root.anchor).toBeNull(); // a full bundle: no anchor exists

      // So the whole A -> B -> A chain assembles from the root, across three
      // records that no single machine's index lists together.
      expect(v.chains.map((c) => c.map((r) => r.bundleId))).toEqual([
        [f.bundleIdsA[0], f.bundleIdsB[0], f.bundleIdsA[1]],
      ]);
      expect(v.dangling).toEqual([]);
      expect(v.unanchored).toEqual([]);
      expect(v.unreachable).toEqual([]);
      expect(v.forks).toEqual([]);

      // fromEntryUuid is UNCHANGED and still not a link: it is the anchor's
      // child in the transcript. Pinned so a later "simplification" that
      // collapses the two fields into one reddens here.
      const parentOf = new Map<string, string | null>(
        readFileSync(f.basePath, "utf-8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as { uuid?: string; parentUuid?: string })
          .filter((e): e is { uuid: string; parentUuid?: string } => typeof e.uuid === "string")
          .map((e) => [e.uuid, e.parentUuid ?? null])
      );
      expect(middle.from).toBe("b-entry-4");
      expect(middle.from).not.toBe(middle.anchor);
      expect(parentOf.get(middle.from!)).toBe(root.head);
      expect(parentOf.get(last.from!)).toBe(middle.head);
    } finally {
      f.cleanup();
    }
  });

  it("its C helpers run under C's HOME and put it back", async () => {
    const f = await arrangeThreeMachines();
    const homeBefore = process.env.HOME;
    try {
      const seen = await f.onC(async () => process.env.HOME);
      expect(seen).toBe(f.homeC);
      expect(process.env.HOME).toBe(homeBefore);

      const whereis = await f.whereisC();
      expect(whereis.linked).toBe(true);
      expect(whereis.projectId).toBe(f.projectId);
      expect(whereis.threads.map((t) => t.threadId)).toEqual([f.threadId]);
      expect(process.env.HOME).toBe(homeBefore);
    } finally {
      f.cleanup();
    }
  });
});

describe("emptySyncState", () => {
  it("is a valid v1 state that maps no session to any thread", () => {
    const state = emptySyncState();
    expect(state.schemaVersion).toBe(1);
    expect(state.hub).toBeUndefined();
    expect(state.peers).toEqual({});
    expect(state.lineage).toEqual({});
    expect(state.imported).toEqual({});
    expect(getThreadId(state, "local-t1")).toBeNull();
    expect(state.projectPath).toBe("/x");
    expect(emptySyncState("/tmp/other").projectPath).toBe("/tmp/other");
  });
});
