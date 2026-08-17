import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alternateSource, assembleChain, planThreadPull, pullSourceFor, resolveThreads,
  findUnfetchableBundles,
} from "../src/hub/threads.js";
import type { AssembledChain, ResolvedThread } from "../src/hub/threads.js";
import type { SyncState } from "../src/types.js";
import {
  idx, entry, bundle, copy, peer, syncState, chainHead, chainIndexes,
} from "./helpers/hub-fixtures.js";
import type { ChainIndexesOptions, ChainRecordInput } from "./helpers/hub-fixtures.js";

describe("resolveThreads", () => {
  it("merges copies across machines under one thread", () => {
    const r = resolveThreads([
      idx("mA", { t1: entry({ localSessionId: "sA", lastActiveAt: "2026-07-20T00:00:00Z" }) }),
      idx("mB", { t1: entry({ localSessionId: "sB", lastActiveAt: "2026-07-21T00:00:00Z" }) }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].copies).toHaveLength(2);
    expect(r[0].latest.machineId).toBe("mB");
  });

  it("tiebreaks equal lastActiveAt by messageCount then headEntryUuid", () => {
    const r = resolveThreads([
      idx("mA", { t1: entry({ messageCount: 5, headEntryUuid: "bbb" }) }),
      idx("mB", { t1: entry({ messageCount: 5, headEntryUuid: "aaa" }) }),
      idx("mC", { t1: entry({ messageCount: 9, headEntryUuid: "zzz" }) }),
    ]);
    expect(r[0].latest.machineId).toBe("mC"); // higher messageCount wins the tie
    const r2 = resolveThreads([
      idx("mA", { t1: entry({ headEntryUuid: "bbb" }) }),
      idx("mB", { t1: entry({ headEntryUuid: "aaa" }) }),
    ]);
    expect(r2[0].latest.machineId).toBe("mB"); // lexical asc wins
  });

  it("takes machineId from the index FILE, not from a thread entry that claims one", () => {
    // A thread entry is peer-authored data. With `{ machineId, ...entry }` the
    // entry won, so a hostile or corrupt index could rename itself — and that
    // id now selects `state.peers[...]` in findUnfetchableBundles and feeds
    // pull's alternateSource, i.e. it decides which machine a pull fetches
    // from. A prototype key here was one route into the same crash the
    // `received` guard closes.
    const poisoned = idx("mA", { t1: entry({ localSessionId: "sA" }) });
    (poisoned.threads.t1 as unknown as Record<string, unknown>).machineId = "SPOOFED";
    expect(resolveThreads([poisoned])[0].latest.machineId).toBe("mA");
  });

  it("breaks a total tie by machineId, so the answer never depends on index order", () => {
    // Reachable from the milestone's own headline flow: A pushes, B pulls and
    // continues, A pulls the continuation back and splices it into its own
    // session. Both machines then publish the SAME lastActiveAt, the same
    // messageCount and the same head uuid — and with every declared key equal,
    // `newer` returned the reduce accumulator, i.e. whichever index file the
    // hub directory happened to list first. That copy decides which machine a
    // third machine pulls FROM, and the two copies list different bundles, so
    // it decides what that machine receives. The module's own contract says the
    // answer must not depend on iteration order; without a final key it did.
    const copies = [
      idx("mB", { t1: entry({ localSessionId: "sB" }) }),
      idx("mA", { t1: entry({ localSessionId: "sA" }) }),
    ];
    expect(resolveThreads(copies)[0].latest.machineId).toBe("mA");
    expect(resolveThreads([...copies].reverse())[0].latest.machineId).toBe("mA");
  });

  it("breaks the tie BELOW machineId too, when two index files declare the same one", () => {
    // machineId was the LAST key, and it is not an identity: resolveThreads
    // stamps a copy with the id an index file's CONTENT declares, while
    // readAllIndexes dedupes on the id derived from the file's NAME. Two
    // differently-named files that both declare "X" therefore arrive as two
    // copies with every key equal, and `copies.reduce(newer)` fell back to the
    // accumulator — readdirSync order — deciding which bundle list
    // `pullSourceFor` hands to a pull. Measured against the shipped dist/: the
    // forward listing resolved to one file's bundles and the reverse to the
    // other's.
    const shared = { localSessionId: "sX", headEntryUuid: "u", messageCount: 1,
      lastActiveAt: "2026-07-21T00:00:00Z" };
    const fileA = idx("X", { t1: entry({ ...shared, bundles: [bundle({ bundleId: "FROM-FILE-A" })] }) });
    const fileB = idx("X", { t1: entry({ ...shared, bundles: [bundle({ bundleId: "FROM-FILE-B" })] }) });
    const pick = (indexes: ReturnType<typeof idx>[]): string[] =>
      resolveThreads(indexes)[0].latest.bundles.map((b) => b.bundleId);
    expect(pick([fileA, fileB])).toEqual(pick([fileB, fileA]));
    // Arbitrary as a preference and stable, which is the property being bought.
    expect(pick([fileA, fileB])).toEqual(["FROM-FILE-A"]);
  });

  it("sorts threads by latest activity desc and takes slug/summary from latest", () => {
    const r = resolveThreads([
      idx("mA", {
        t1: entry({ slug: "old", lastActiveAt: "2026-07-01T00:00:00Z" }),
        t2: entry({ slug: "new", lastActiveAt: "2026-07-21T00:00:00Z" }),
      }),
      idx("mB", { t1: entry({ slug: "newer-t1", lastActiveAt: "2026-07-22T00:00:00Z" }) }),
    ]);
    expect(r.map((t) => t.threadId)).toEqual(["t1", "t2"]);
    expect(r[0].slug).toBe("newer-t1");
  });

  it("orders equal-timestamped THREADS deterministically too, not just equal copies", () => {
    // Same invariant as the copy-level tiebreak above, one level up. The
    // obvious `a < b ? 1 : -1` is an inconsistent comparator — it returns -1
    // for equal values — so ties came back in whatever order the threads were
    // built in. Both consumers pick positionally (`pull --latest` takes the
    // first non-current thread; the SessionStart notice takes the most recent
    // stale one), so an arbitrary winner among ties is an arbitrary answer to
    // "which thread needs attention".
    const same = "2026-07-21T00:00:00Z";
    const ids = ["t5", "t1", "t9", "t3", "t7", "t2", "t8", "t4", "t6"];
    const build = (order: string[]): string[] =>
      resolveThreads([
        idx("mA", Object.fromEntries(order.map((t) => [t, entry({ lastActiveAt: same })]))),
      ]).map((t) => t.threadId);

    const forward = build(ids);
    expect(build([...ids].reverse())).toEqual(forward);
    expect(build([...ids].sort())).toEqual(forward);
    // Ties resolve on threadId, so the order is stated rather than incidental.
    expect(forward).toEqual([...ids].sort());
  });

  it("still puts a genuinely newer thread first regardless of tie handling", () => {
    // Negative control for the above: the tiebreak must not reorder threads
    // that differ on the field that actually matters.
    const r = resolveThreads([
      idx("mA", {
        zzz: entry({ lastActiveAt: "2026-07-22T00:00:00Z" }),
        aaa: entry({ lastActiveAt: "2026-07-01T00:00:00Z" }),
      }),
    ]);
    expect(r.map((t) => t.threadId)).toEqual(["zzz", "aaa"]);
  });
});

// Task 12b: the disclosure for Critical 3 — a chain that spans two machines
// can never be pulled whole by a third, because a machine's index lists only
// the bundles IT pushed and a pull fetches exactly one machine's list.
//
// The FALSE-POSITIVE property is the load-bearing one: this must be silent on
// the ordinary two-machine flow, or it fires on every pull and gets ignored.
describe("findUnfetchableBundles", () => {
  // Both hub READ commands (`pull` and `whereis`) run this. A peers entry that
  // PARSES but lacks `received` — an interrupted write, a hand edit, a file an
  // older version wrote — used to reach `peer.received[id]` and throw
  // `Cannot read properties of undefined` straight out of both. It never
  // self-healed: the file parses, so readSyncState does not rename it aside,
  // and no message named it. Guarded at the access AND normalized in
  // parseSyncState, because either alone leaves the other reader exposed.
  it("survives a peers entry with no `received`, instead of wedging pull and whereis", () => {
    const malformed = {
      schemaVersion: 1 as const, projectPath: "/p", lineage: {}, imported: {},
      // Deliberately NOT built by peer(): the whole point is a shape the
      // parser accepts and the types claim cannot happen.
      peers: { mB: { name: "b", lastSentAt: null, lastReceivedAt: null } },
    } as unknown as Parameters<typeof findUnfetchableBundles>[0]["state"];
    const copies = [
      copy("mA", { bundles: [bundle({ bundleId: "b1", sessionIdInBundle: "sA" })] }),
      copy("mB", { bundles: [bundle({ bundleId: "b2", sessionIdInBundle: "sB" })] }),
    ];
    expect(() =>
      findUnfetchableBundles({ copies, sourceMachineId: "mA", localMachineId: "mC", state: malformed })
    ).not.toThrow();
    // And it still answers correctly rather than swallowing the thread.
    expect(
      findUnfetchableBundles({ copies, sourceMachineId: "mA", localMachineId: "mC", state: malformed })
    ).toEqual([{ machineId: "mB", bundleIds: ["b2"] }]);
  });

  const A = "machine-a";
  const B = "machine-b";
  const C = "machine-c";

  // The canonical two-machine round trip: A pushed the full bundle, B pushed
  // the continuation. Whichever way the pull resolves, the OTHER copy is
  // either the source or this machine — so there is no candidate at all.
  const twoMachineCopies = [
    copy(A, { bundles: [bundle({ bundleId: "b1", type: "full", sessionIdInBundle: "sA" })] }),
    copy(B, { bundles: [bundle({ bundleId: "b2", sessionIdInBundle: "sB" })] }),
  ];

  it("is silent on the ordinary two-machine flow, whichever machine the pull resolves to", () => {
    expect(
      findUnfetchableBundles({
        copies: twoMachineCopies, sourceMachineId: B, localMachineId: A, state: syncState(),
      })
    ).toEqual([]);
    expect(
      findUnfetchableBundles({
        copies: twoMachineCopies, sourceMachineId: A, localMachineId: B, state: syncState(),
      })
    ).toEqual([]);
    // ...and with the source resolving to this machine itself (whereis asks
    // that question on the machine holding the latest copy).
    expect(
      findUnfetchableBundles({
        copies: twoMachineCopies, sourceMachineId: A, localMachineId: A,
        state: syncState({
          [B]: peer({ received: { sB: { localSessionId: "sLocal", type: "continuation", importedAt: "t" } } }),
        }),
      })
    ).toEqual([]);
  });

  it("names the machine whose bundles a third machine's pull cannot reach", () => {
    // Machine C is fresh: it has received nothing from anyone.
    expect(
      findUnfetchableBundles({
        copies: twoMachineCopies, sourceMachineId: A, localMachineId: C, state: syncState(),
      })
    ).toEqual([{ machineId: B, bundleIds: ["b2"] }]);
    // Resolving the other way truncates the other half — and says so.
    expect(
      findUnfetchableBundles({
        copies: twoMachineCopies, sourceMachineId: B, localMachineId: C, state: syncState(),
      })
    ).toEqual([{ machineId: A, bundleIds: ["b1"] }]);
  });

  it("stays silent about a machine whose content already arrived here", () => {
    // C pulled A's bundle earlier (peer bookkeeping records it), and is now
    // pulling B's newer continuation. Nothing is missing — do not cry wolf.
    const state = syncState({
      [A]: peer({
        received: { sA: { localSessionId: "sC", type: "full", importedAt: "t" } },
        sent: { sC: { headEntryUuid: "head-b1", messageCount: 3, sentAsType: "full", sentAsSessionId: "sA" } },
      }),
    });
    expect(
      findUnfetchableBundles({ copies: twoMachineCopies, sourceMachineId: B, localMachineId: C, state })
    ).toEqual([]);
  });

  it("still reports a machine's LATER push after an earlier one of its bundles arrived", () => {
    // The coarse "received something from that machine" test would go silent
    // here: b1 and b3 share a sessionIdInBundle. The recorded head says how
    // far along that machine's own (append-ordered) list we actually got.
    const copies = [
      copy(A, {
        bundles: [
          bundle({ bundleId: "b1", type: "full", sessionIdInBundle: "sA" }),
          bundle({ bundleId: "b3", sessionIdInBundle: "sA" }),
        ],
      }),
      copy(B, { bundles: [bundle({ bundleId: "b2", sessionIdInBundle: "sB" })] }),
    ];
    const state = syncState({
      [A]: peer({
        received: { sA: { localSessionId: "sC", type: "full", importedAt: "t" } },
        sent: { sC: { headEntryUuid: "head-b1", messageCount: 3, sentAsType: "full", sentAsSessionId: "sA" } },
      }),
    });
    expect(
      findUnfetchableBundles({ copies, sourceMachineId: B, localMachineId: C, state })
    ).toEqual([{ machineId: A, bundleIds: ["b3"] }]);

    // Once b3's head is the head we hold from A, A is fully accounted for.
    const caughtUp = syncState({
      [A]: peer({
        received: { sA: { localSessionId: "sC", type: "continuation", importedAt: "t" } },
        sent: { sC: { headEntryUuid: "head-b3", messageCount: 5, sentAsType: "continuation", sentAsSessionId: "sA" } },
      }),
    });
    expect(
      findUnfetchableBundles({ copies, sourceMachineId: B, localMachineId: C, state: caughtUp })
    ).toEqual([]);
  });

  it("falls back to the coarse received test when no recorded head matches", () => {
    // Silent direction by design: we know content came from that machine for
    // that session but cannot place it in the list, so we do not accuse.
    const copies = [copy(A, { bundles: [bundle({ bundleId: "b1", sessionIdInBundle: "sA" })] })];
    const state = syncState({
      [A]: peer({
        received: { sA: { localSessionId: "sC", type: "full", importedAt: "t" } },
        sent: { sC: { headEntryUuid: "something-else", messageCount: 3, sentAsType: "full", sentAsSessionId: "sA" } },
      }),
    });
    expect(
      findUnfetchableBundles({ copies, sourceMachineId: B, localMachineId: C, state })
    ).toEqual([]);
  });

  it("never reports the source's own bundles, this machine's own bundles, or an empty union", () => {
    const copies = [
      copy(A, { bundles: [bundle({ bundleId: "b1", sessionIdInBundle: "sA" })] }),
      copy(C, { bundles: [bundle({ bundleId: "b9", sessionIdInBundle: "sC" })] }),
    ];
    expect(
      findUnfetchableBundles({ copies, sourceMachineId: A, localMachineId: C, state: syncState() })
    ).toEqual([]);
    expect(findUnfetchableBundles({ copies: [], sourceMachineId: A, localMachineId: C, state: syncState() })).toEqual([]);
  });

  it("ignores a machine that has pulled the thread but never pushed a bundle of its own", () => {
    // The commonest third-machine shape: a joiner's index entry has an EMPTY
    // bundle list (hub/pull.ts writes its index with newBundles: []).
    const copies = [
      copy(A, { bundles: [bundle({ bundleId: "b1", sessionIdInBundle: "sA" })] }),
      copy(B, { bundles: [] }),
    ];
    expect(
      findUnfetchableBundles({ copies, sourceMachineId: A, localMachineId: C, state: syncState() })
    ).toEqual([]);
  });

  it("counts a bundle id the source also lists as fetchable, and dedupes within a machine", () => {
    const copies = [
      copy(A, { bundles: [bundle({ bundleId: "b1", sessionIdInBundle: "sA" })] }),
      copy(B, {
        bundles: [
          bundle({ bundleId: "b1", sessionIdInBundle: "sB" }), // same id as the source's
          bundle({ bundleId: "b2", sessionIdInBundle: "sB" }),
          bundle({ bundleId: "b2", sessionIdInBundle: "sB" }), // repeated in one list
        ],
      }),
    ];
    expect(
      findUnfetchableBundles({ copies, sourceMachineId: A, localMachineId: C, state: syncState() })
    ).toEqual([{ machineId: B, bundleIds: ["b2"] }]);
  });

  it("reports one row per machine, ordered by machine id, with four machines in play", () => {
    const copies = [
      copy("m-d", { bundles: [bundle({ bundleId: "d1", sessionIdInBundle: "sD" })] }),
      copy("m-a", { bundles: [bundle({ bundleId: "a1", sessionIdInBundle: "sA" })] }),
      copy("m-b", {
        bundles: [
          bundle({ bundleId: "b1", sessionIdInBundle: "sB" }),
          bundle({ bundleId: "b2", sessionIdInBundle: "sB2" }),
        ],
      }),
      copy("m-c", { bundles: [bundle({ bundleId: "c1", sessionIdInBundle: "sC" })] }),
    ];
    const forward = findUnfetchableBundles({
      copies, sourceMachineId: "m-a", localMachineId: "m-z", state: syncState(),
    });
    expect(forward).toEqual([
      { machineId: "m-b", bundleIds: ["b1", "b2"] },
      { machineId: "m-c", bundleIds: ["c1"] },
      { machineId: "m-d", bundleIds: ["d1"] },
    ]);
    // Deterministic: the answer never depends on index iteration order.
    expect(
      findUnfetchableBundles({
        copies: [...copies].reverse(), sourceMachineId: "m-a", localMachineId: "m-z", state: syncState(),
      })
    ).toEqual(forward);
  });

  it("merges two index files that declare the same internal machineId", () => {
    // readMachineIndex never validates the machineId INSIDE an index file
    // (only the one derived from its filename), so two copies can carry the
    // same id. One row, not two.
    const copies = [
      copy(A, { bundles: [bundle({ bundleId: "a1", sessionIdInBundle: "sA" })] }),
      copy(B, { bundles: [bundle({ bundleId: "b1", sessionIdInBundle: "sB" })] }),
      copy(B, { bundles: [bundle({ bundleId: "b2", sessionIdInBundle: "sB" })] }),
    ];
    expect(
      findUnfetchableBundles({ copies, sourceMachineId: A, localMachineId: C, state: syncState() })
    ).toEqual([{ machineId: B, bundleIds: ["b1", "b2"] }]);
  });

  it("does not treat an empty head uuid as a match (the shared link rule)", () => {
    // Both sides can legitimately be "" (a bundle boundary landing on a
    // uuid-less bookkeeping line) — matching them would silence a real gap.
    const copies = [
      copy(A, {
        bundles: [
          bundle({ bundleId: "b1", sessionIdInBundle: "sA", headEntryUuid: "" }),
          bundle({ bundleId: "b3", sessionIdInBundle: "sA", headEntryUuid: "head-b3" }),
        ],
      }),
    ];
    const state = syncState({
      [A]: peer({
        received: { sA: { localSessionId: "sC", type: "full", importedAt: "t" } },
        sent: { sC: { headEntryUuid: "", messageCount: 3, sentAsType: "full", sentAsSessionId: "sA" } },
      }),
    });
    // No usable head match -> coarse fallback -> silent (never a false alarm
    // built on two empty strings being "equal").
    expect(
      findUnfetchableBundles({ copies, sourceMachineId: B, localMachineId: C, state })
    ).toEqual([]);
  });
});

// #35 chain assembly. Every case is driven through `chainIndexes` and the REAL
// resolver, so what is measured is the shape a machine's index file actually
// carries — not a hand-built record list that could disagree with one.
//
// Two prohibitions are asserted rather than assumed, because each has already
// shipped as a defect: the plan is ordered by LINKS (the fixtures make
// `pushedAt` descend in link order, so an implementation that sorts by it
// fails here), and the output is a separate structure that merges nothing back
// into any machine's stored bundle list.
describe("assembleChain", () => {
  function assembleFrom(
    spec: Record<string, ChainRecordInput[]>,
    over: { opts?: ChainIndexesOptions; localHeadEntryUuid?: string | null } = {}
  ): AssembledChain {
    const resolved = resolveThreads(chainIndexes(spec, over.opts));
    expect(resolved).toHaveLength(1);
    return assembleChain({
      copies: resolved[0].copies,
      localHeadEntryUuid: over.localHeadEntryUuid,
    });
  }
  const ids = (a: AssembledChain): string[] => a.chain.map((s) => s.record.bundleId);
  /**
   * Everything the answer consists of, with the two fields a fixture stamps
   * from DECLARATION order projected away (`pushedAt`, and the `file` name
   * built from it). Reversing a spec's machine keys reverses those stamps and
   * nothing else, so this is what "the answer does not move" means — and the
   * projection is itself the point: neither field may reach a decision.
   */
  const shape = (a: AssembledChain): unknown => ({
    ...a,
    chain: a.chain.map((s) => [s.machineId, s.record.bundleId, s.record.anchorEntryUuid]),
  });

  describe("linear", () => {
    it("orders one thread's bundles across three machines, root first", () => {
      const a = assembleFrom({ m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b1"] });

      expect(ids(a)).toEqual(["b0", "b1", "b2"]);
      expect(a.stoppedBecause).toBe("end");
      expect(a.rootChoice).toBe("sole");
      expect(a.gaps).toEqual([]);
      expect(a.forks).toEqual([]);
      expect(a.unanchored).toEqual([]);
      expect(a.advertisedUnshipped).toEqual([]);
      expect(a.unreachableBundleIds).toEqual([]);
    });

    it("stamps every record with the machine that LISTED it, not one scalar", () => {
      // The §4.6 ripple: three sites downstream spend this on a peer ledger, and
      // a chain that spans machines has a per-bundle source. A plan whose
      // records all carried the resolved machine would mis-credit two of three.
      const a = assembleFrom({ m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b1"] });
      expect(a.chain.map((s) => s.machineId)).toEqual(["m1", "m2", "m3"]);
      expect(a.chain.map((s) => s.record.file)).toEqual([
        expect.stringContaining("/bundles/m1/"),
        expect.stringContaining("/bundles/m2/"),
        expect.stringContaining("/bundles/m3/"),
      ]);
    });

    it("orders by links, NEVER by pushedAt — which descends in these fixtures", () => {
      const a = assembleFrom({ m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b1"] });
      const stamps = a.chain.map((s) => s.record.pushedAt);
      expect(ids(a)).toEqual(["b0", "b1", "b2"]);
      // Strictly DESCENDING wall clocks in link order: sorting by `pushedAt`
      // would produce exactly the reverse, which is the silent-revert shape.
      expect([...stamps].sort()).toEqual([...stamps].reverse());
    });

    it("links on anchorEntryUuid and is indifferent to fromEntryUuid", () => {
      // fromEntryUuid is the anchor's CHILD on a real hub and links nothing; an
      // assembler that fell back to it would chain on this garbage instead.
      const garbage = assembleFrom({
        m1: ["b0"],
        m2: [{ id: "b1", from: "b0", fromUuid: chainHead("b0") }],
        m3: [{ id: "b2", from: "b1", fromUuid: "not-a-uuid-at-all" }],
      });
      expect(ids(garbage)).toEqual(["b0", "b1", "b2"]);
      expect(garbage.gaps).toEqual([]);

      // Same spec under the old spec's (mistaken) reading of the field: the
      // chain must come out identical, because neither reads it.
      const asAnchor = assembleFrom(
        { m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b1"] },
        { opts: { linkStyle: "anchor" } }
      );
      const asPush = assembleFrom({ m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b1"] });
      expect(ids(asAnchor)).toEqual(ids(asPush));
    });

    it("does not depend on the order the indexes are read in", () => {
      const forward = assembleFrom({ m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b1"] });
      const reverse = assembleFrom({ m3: ["b2<-b1"], m2: ["b1<-b0"], m1: ["b0"] });
      expect(shape(reverse)).toEqual(shape(forward));
      // The two runs really did differ in what an order-sensitive walk would
      // have keyed on: reversing the spec reverses every `pushedAt`.
      expect(reverse.chain.map((s) => s.record.pushedAt)).not.toEqual(
        forward.chain.map((s) => s.record.pushedAt)
      );
    });

    it("merges nothing back into any machine's stored bundle list (§4.4.2)", () => {
      const copies = resolveThreads(chainIndexes({ m1: ["b0"], m2: ["b1<-b0"] }))[0].copies;
      const before = JSON.parse(JSON.stringify(copies)) as unknown;
      const a = assembleChain({ copies });
      expect(ids(a)).toEqual(["b0", "b1"]);
      // Every machine's list is still its OWN pushes, in push order — the
      // linearity `basedOn`'s merge-ancestor walk relies on.
      expect(JSON.parse(JSON.stringify(copies))).toEqual(before);
      expect(copies.map((c) => c.bundles.length)).toEqual([1, 1]);
    });
  });

  describe("gap", () => {
    it("applies the contiguous prefix and names the anchor plus what it strands", () => {
      // b1 is deliberately absent: b2 anchors on a head no machine's index ships.
      const a = assembleFrom({
        m1: ["b0"],
        m2: [{ id: "b2", anchorUuid: chainHead("b1") }, { id: "b3", from: "b2" }],
      });

      expect(ids(a)).toEqual(["b0"]);
      expect(a.stoppedBecause).toBe("end");
      expect(a.gaps).toEqual([
        {
          anchorEntryUuid: chainHead("b1"),
          machineId: "m2",
          bundleId: "b2",
          // The stranded record AND everything chaining onto it: "N later
          // bundles unreachable" is this length.
          strandedBundleIds: ["b2", "b3"],
        },
      ]);
      expect(a.unreachableBundleIds).toEqual(["b2", "b3"]);
      // A gap is not a fork, not a second root, and not a pre-assembly record.
      expect(a.roots.map((r) => r.bundleId)).toEqual(["b0"]);
      expect(a.forks).toEqual([]);
      expect(a.unanchored).toEqual([]);
    });

    it("never resumes past a gap, and names only the record AT the boundary", () => {
      // b0 -> b1 -> [b2 missing] -> b3 -> b4 -> b5. The run behind the gap is
      // perfectly well linked, and it is refused whole: resuming past a gap
      // yields a non-contiguous transcript, which `tryAppendContinuation`'s
      // chain guard would refuse anyway. b4 and b5 are stranded but are NOT
      // gaps — their anchors name heads that are right there on the hub, and
      // reporting three gaps for one missing bundle would be three times wrong.
      const a = assembleFrom({
        m1: ["b0", "b1<-b0"],
        m2: [{ id: "b3", anchorUuid: chainHead("b2") }, "b4<-b3", "b5<-b4"],
      });
      expect(ids(a)).toEqual(["b0", "b1"]);
      expect(a.gaps).toHaveLength(1);
      expect(a.gaps[0]).toEqual({
        anchorEntryUuid: chainHead("b2"),
        machineId: "m2",
        bundleId: "b3",
        strandedBundleIds: ["b3", "b4", "b5"],
      });
      expect(a.unreachableBundleIds).toEqual(["b3", "b4", "b5"]);
    });

    it("treats an EMPTY anchor as a gap, never as a root and never as a link", () => {
      // No writer of ours emits `anchorEntryUuid: ""` — an empty recorded head
      // is a full push — so this is the damaged/hostile index case.
      const a = assembleFrom({
        m1: ["b0", { id: "b1", from: "b0", head: "" }],
        m2: [{ id: "b2", from: "b1" }, { id: "b3", from: "b2", head: "" }, { id: "b4", from: "b3" }],
      });

      // b2 and b4 anchor on "" (their anchors' heads are empty), so neither
      // links to anything — and they do not link to EACH OTHER either.
      expect(a.gaps.map((g) => [g.bundleId, g.anchorEntryUuid])).toEqual([
        ["b2", ""],
        ["b4", ""],
      ]);
      expect(a.gaps[0].strandedBundleIds).toEqual(["b2", "b3"]);
      expect(a.roots.map((r) => r.bundleId)).toEqual(["b0"]);
      expect(a.unreachableBundleIds).toEqual(["b2", "b3", "b4"]);
    });

    it("stops at a record whose own head is empty, and says that is why", () => {
      // Unlinkable FORWARD by construction: a successor may exist and no walk
      // can match it. Calling that a clean end is the head-equality trap.
      const a = assembleFrom({ m1: ["b0", { id: "b1", from: "b0", head: "" }] });
      expect(ids(a)).toEqual(["b0", "b1"]);
      expect(a.stoppedBecause).toBe("empty-head");
      // ...and the ordinary case is distinguishable from it.
      expect(assembleFrom({ m1: ["b0", "b1<-b0"] }).stoppedBecause).toBe("end");
    });
  });

  describe("fork", () => {
    it("follows the longer branch with no local base, and parks the other whole", () => {
      const a = assembleFrom({
        m1: ["b0"],
        m2: ["b1<-b0", "b3<-b1"],
        m3: ["b2<-b0"],
      });

      expect(ids(a)).toEqual(["b0", "b1", "b3"]);
      expect(a.forks).toEqual([
        {
          anchorEntryUuid: chainHead("b0"),
          followedBundleId: "b1",
          reason: "longest",
          parked: [{ machineId: "m3", bundleId: "b2", bundleIds: ["b2"] }],
        },
      ]);
      expect(a.unreachableBundleIds).toEqual(["b2"]);
      // A fork is not a gap: every anchor here names a head that IS on the hub.
      expect(a.gaps).toEqual([]);
    });

    it("follows the branch the local base sits on, overriding branch length", () => {
      const spec = { m1: ["b0"], m2: ["b1<-b0", "b3<-b1"], m3: ["b2<-b0"] };
      // Without a local base the longer branch (b1) wins — asserted above. With
      // one on the SHORT branch, the shape of the answer changes entirely, so
      // this cannot pass by accident.
      const a = assembleFrom(spec, { localHeadEntryUuid: chainHead("b2") });
      expect(ids(a)).toEqual(["b0", "b2"]);
      expect(a.forks[0].reason).toBe("local-base");
      expect(a.forks[0].parked.map((p) => p.bundleIds)).toEqual([["b1", "b3"]]);

      // And a local base on the long branch keeps it there, by the same rule
      // rather than by luck.
      const long = assembleFrom(spec, { localHeadEntryUuid: chainHead("b3") });
      expect(ids(long)).toEqual(["b0", "b1", "b3"]);
      expect(long.forks[0].reason).toBe("local-base");
    });

    it("ignores a local base that is empty, unknown, or sits AT the fork point", () => {
      const spec = { m1: ["b0"], m2: ["b1<-b0", "b3<-b1"], m3: ["b2<-b0"] };
      for (const localHeadEntryUuid of [
        "", // the empty-head rule applies to this input too
        null,
        undefined,
        "a-head-no-bundle-ships",
        chainHead("b0"), // the fork's own anchor: on BOTH branches, so decides nothing
      ]) {
        const a = assembleFrom(spec, { localHeadEntryUuid });
        expect(a.forks[0].reason, `local head ${JSON.stringify(localHeadEntryUuid)}`).toBe("longest");
        expect(ids(a)).toEqual(["b0", "b1", "b3"]);
      }
    });

    it("breaks an equal-length fork on bundle id, and parks every other branch", () => {
      const a = assembleFrom({ m1: ["b0"], m3: ["b2<-b0"], m2: ["b1<-b0"], m4: ["b9<-b0"] });
      expect(ids(a)).toEqual(["b0", "b1"]);
      expect(a.forks[0].reason).toBe("bundle-id");
      expect(a.forks[0].parked.map((p) => p.bundleId)).toEqual(["b2", "b9"]);
      // Stable: the same answer with the machines declared the other way round.
      const reverse = assembleFrom({ m4: ["b9<-b0"], m2: ["b1<-b0"], m3: ["b2<-b0"], m1: ["b0"] });
      expect(shape(reverse)).toEqual(shape(a));
    });

    it("reports a fork MET, never every fork on the hub", () => {
      // The fork behind an unfollowed root is disclosed through that root's own
      // reachable set instead — `forks` says which branch this plan took, and
      // there is no branch to have taken on a root the plan does not walk.
      const a = assembleFrom({
        m1: ["b0", "b5"],
        m2: ["b1<-b0", "b3<-b1", "b4<-b3"],
        m3: ["b6<-b5", "b7<-b5"],
      });
      expect(ids(a)).toEqual(["b0", "b1", "b3", "b4"]);
      expect(a.forks).toEqual([]);
      expect(a.roots.find((r) => r.bundleId === "b5")?.bundleIds).toEqual(["b5", "b6", "b7"]);
      expect(a.unreachableBundleIds).toEqual(["b5", "b6", "b7"]);
    });
  });

  describe("multiple roots", () => {
    it("is ORDINARY: two full bundles in one thread, both reported, neither merged", () => {
      // src/diff.ts re-sends a session whole whenever the recorded head is empty
      // or gone (compaction, truncation, rollback) and push.ts files that under
      // the SAME thread id. Two roots, one thread, no anomaly.
      const a = assembleFrom({ m1: ["b0", "b2"], m2: ["b1<-b0"] });

      expect(a.roots).toEqual([
        { machineId: "m1", bundleId: "b0", bundleIds: ["b0", "b1"], followed: true, preAssembly: false },
        { machineId: "m1", bundleId: "b2", bundleIds: ["b2"], followed: false, preAssembly: false },
      ]);
      // The plan is ONE root's linked list. The other's records are not spliced
      // onto the end of it.
      expect(ids(a)).toEqual(["b0", "b1"]);
      expect(a.rootChoice).toBe("longest");
      expect(a.unreachableBundleIds).toEqual(["b2"]);
      expect(a.gaps).toEqual([]);
    });

    it("prefers the root the local base sits on over the longest one", () => {
      const spec = { m1: ["b0", "b2"], m2: ["b1<-b0"] };
      const a = assembleFrom(spec, { localHeadEntryUuid: chainHead("b2") });
      expect(ids(a)).toEqual(["b2"]);
      expect(a.rootChoice).toBe("local-base");
      expect(a.roots.map((r) => r.followed)).toEqual([false, true]);
      // A local base matching NO root is the expected state after a compaction,
      // and falls back to the longest rather than refusing.
      const compacted = assembleFrom(spec, { localHeadEntryUuid: "rewritten-by-compaction" });
      expect(ids(compacted)).toEqual(["b0", "b1"]);
      expect(compacted.rootChoice).toBe("longest");
    });

    it("breaks an equal-length root tie on bundle id ascending, never on pushedAt", () => {
      // b2 is declared FIRST, so it carries the newer pushedAt — sorting by the
      // clock would pick it; the stated rule picks b0.
      const a = assembleFrom({ m1: ["b2", "b0"] });
      expect(ids(a)).toEqual(["b0"]);
      expect(a.rootChoice).toBe("bundle-id");
      const stamps = Object.fromEntries(
        resolveThreads(chainIndexes({ m1: ["b2", "b0"] }))[0].copies[0].bundles.map((b) => [
          b.bundleId, b.pushedAt,
        ])
      );
      expect(stamps.b2 > stamps.b0).toBe(true);
    });
  });

  describe("advertised-but-unshipped", () => {
    it("names a machine whose thread head no bundle record ships", () => {
      const a = assembleFrom(
        { m1: ["b0"], m2: ["b1<-b0"] },
        { opts: { advertise: { m2: { headEntryUuid: "local-work-never-pushed" } } } }
      );
      expect(a.advertisedUnshipped).toEqual([
        { machineId: "m2", headEntryUuid: "local-work-never-pushed" },
      ]);
      // It is not a gap and not a missing bundle: the chain is whole.
      expect(ids(a)).toEqual(["b0", "b1"]);
      expect(a.gaps).toEqual([]);
      expect(a.unreachableBundleIds).toEqual([]);
    });

    it("says nothing about a machine advertising a head it did ship", () => {
      // The control that keeps the assertion above from passing vacuously.
      expect(assembleFrom({ m1: ["b0"], m2: ["b1<-b0"] }).advertisedUnshipped).toEqual([]);
    });

    it("says nothing about an EMPTY advertised head — it advertises nothing", () => {
      const a = assembleFrom(
        { m1: ["b0"], m2: [] },
        { opts: { advertise: { m2: { headEntryUuid: "" } } } }
      );
      expect(a.advertisedUnshipped).toEqual([]);
    });

    it("counts a head on a PARKED branch as shipped, because it was", () => {
      // The test is against every record on the hub, not against the followed
      // chain: a machine whose work sits on the branch this plan parked has
      // pushed it, and reporting it as unshipped would be a second, wrong story
      // about the same bundles.
      const a = assembleFrom({ m1: ["b0"], m2: ["b1<-b0", "b3<-b1"], m3: ["b2<-b0"] });
      expect(ids(a)).toEqual(["b0", "b1", "b3"]);
      expect(a.forks[0].parked.map((p) => p.bundleId)).toEqual(["b2"]);
      expect(a.advertisedUnshipped).toEqual([]);
    });

    it("reports one row per machine, machine id ascending", () => {
      const a = assembleFrom(
        { m9: ["b0"], m2: [], m5: [] },
        {
          opts: {
            advertise: {
              m2: { headEntryUuid: "unshipped-2" },
              m5: { headEntryUuid: "unshipped-5" },
            },
          },
        }
      );
      expect(a.advertisedUnshipped).toEqual([
        { machineId: "m2", headEntryUuid: "unshipped-2" },
        { machineId: "m5", headEntryUuid: "unshipped-5" },
      ]);
    });
  });

  describe("pre-assembly (unanchored)", () => {
    it("keeps a full bundle as a root and calls the continuation unanchored, not a gap", () => {
      // Every bundle already sitting on every hub. "Pushed before chain assembly
      // existed" is a different sentence from "a bundle is missing", and only
      // one of them describes something that could be found.
      const a = assembleFrom({ m1: ["b0"], m2: ["b1<-b0"] }, { opts: { linkStyle: "pre-assembly" } });

      expect(a.roots).toEqual([
        { machineId: "m1", bundleId: "b0", bundleIds: ["b0"], followed: true, preAssembly: true },
      ]);
      expect(a.unanchored).toEqual([{ machineId: "m2", bundleId: "b1", preAssembly: true }]);
      expect(a.gaps).toEqual([]);
      expect(ids(a)).toEqual(["b0"]);
      expect(a.unreachableBundleIds).toEqual(["b1"]);
    });

    it("never promotes a pre-assembly CONTINUATION to a root", () => {
      // The rule that decides a root is `type === "full"`, not the anchor's
      // absence — a pre-assembly full record lacks the field too. Promoting the
      // continuation would invent a second starting point for the thread and
      // hand the plan a chain that starts mid-conversation.
      const a = assembleFrom({ m1: [{ id: "b1", from: "b0", preAssembly: true }], m2: ["b0"] });
      expect(a.roots.map((r) => r.bundleId)).toEqual(["b0"]);
      expect(a.unanchored.map((u) => u.bundleId)).toEqual(["b1"]);
      expect(ids(a)).toEqual(["b0"]);

      // With no full bundle anywhere there is no root at all, and the walk says
      // so rather than starting from an orphan. `b0` is the OTHER spelling of
      // "no anchor": an explicit null on a continuation, which is a
      // contradiction only a damaged index can produce — reported as unanchored
      // and flagged as not-pre-assembly, never promoted to a starting point.
      const orphansOnly = assembleFrom({
        m1: [{ id: "b1", from: "b0", preAssembly: true }, { id: "b0", type: "continuation" }],
      });
      expect(orphansOnly.chain).toEqual([]);
      expect(orphansOnly.stoppedBecause).toBe("no-root");
      expect(orphansOnly.rootChoice).toBe("none");
      expect(orphansOnly.unanchored).toEqual([
        { machineId: "m1", bundleId: "b0", preAssembly: false },
        { machineId: "m1", bundleId: "b1", preAssembly: true },
      ]);
      expect(orphansOnly.unreachableBundleIds).toEqual(["b0", "b1"]);
    });

    it("survives a MIXED hub — old bundles beside new ones", () => {
      // The realistic state right after this ships: b1 was pushed by the old
      // code, b2 by the new. b2's anchor is good, but b1 cannot be reached from
      // b0, so everything behind the pre-assembly record is stranded — and the
      // report says which of the two conditions broke the chain.
      const a = assembleFrom({
        m1: ["b0"],
        m2: [{ id: "b1", from: "b0", preAssembly: true }],
        m3: ["b2<-b1"],
      });

      expect(ids(a)).toEqual(["b0"]);
      expect(a.unanchored).toEqual([{ machineId: "m2", bundleId: "b1", preAssembly: true }]);
      // b2's anchor names a head that IS on the hub, so it is not a gap.
      expect(a.gaps).toEqual([]);
      expect(a.unreachableBundleIds).toEqual(["b1", "b2"]);
    });

    it("distinguishes an absent anchor from a null one", () => {
      // JSON cannot express `undefined`, so absence is the only signal a
      // pre-assembly record carries. `?? null` here would make every one of them
      // a root.
      const modern = assembleFrom({ m1: ["b0"], m2: ["b1<-b0"] });
      const legacy = assembleFrom({ m1: ["b0"], m2: ["b1<-b0"] }, { opts: { linkStyle: "pre-assembly" } });
      expect(modern.roots[0].preAssembly).toBe(false);
      expect(legacy.roots[0].preAssembly).toBe(true);
      expect(ids(modern)).toEqual(["b0", "b1"]);
      expect(ids(legacy)).toEqual(["b0"]);
    });
  });

  describe("degenerate input", () => {
    it("returns an empty plan for a thread nobody lists bundles for", () => {
      const a = assembleChain({ copies: [] });
      expect(a).toEqual({
        chain: [],
        stoppedBecause: "no-root",
        rootChoice: "none",
        roots: [],
        forks: [],
        gaps: [],
        unanchored: [],
        advertisedUnshipped: [],
        unreachableBundleIds: [],
      });
    });

    it("terminates on a cyclic index instead of walking it forever", () => {
      // Transcript uuids do not form loops, so only a damaged or hostile index
      // reaches this — and the alternative to the guard is an unbounded loop
      // inside a pull, over peer-authored data.
      const a = assembleFrom({
        m1: ["b0"],
        m2: [{ id: "b1", from: "b0" }, { id: "b2", from: "b1", head: chainHead("b0") }],
      });
      expect(ids(a)).toEqual(["b0", "b1", "b2"]);
      expect(a.stoppedBecause).toBe("cycle");
      // Each record exactly once: the guard stops the walk, it does not drop
      // what had already been assembled.
      expect(new Set(ids(a)).size).toBe(3);
    });

    it("keeps two machines listing the same bundle id apart", () => {
      // readMachineIndex validates only the id derived from an index file's
      // NAME, so nothing stops two machines listing one bundle id. Identity is
      // the record, never the id.
      const copies = [
        copy("mA", { headEntryUuid: "head-b1", bundles: [bundle({ bundleId: "b1", type: "full", anchorEntryUuid: null })] }),
        copy("mB", { headEntryUuid: "head-b1", bundles: [bundle({ bundleId: "b1", type: "full", anchorEntryUuid: null })] }),
      ];
      const a = assembleChain({ copies });
      expect(a.roots).toHaveLength(2);
      expect(a.chain).toHaveLength(1);
      expect(a.chain[0].machineId).toBe("mA");
      expect(a.rootChoice).toBe("bundle-id");
      expect(a.unreachableBundleIds).toEqual(["b1"]);
    });
  });
});

/**
 * THE SELECTORS, after chain assembly (#35).
 *
 * `planThreadPull` is what replaced "take the resolved machine's bundle list
 * and slice it from its last full record onward". `pullSourceFor` is the one
 * question every selector asks — `pull --latest`, `pull --thread` and
 * `whereis`'s `pullNeeded` all call it — and #44 shipped it scoped to the
 * same-machine half, saying so in as many words. These cases are that scope
 * note coming off: the question is now asked of the ASSEMBLED chain, so all
 * three selectors moved together with no edit at any call site.
 */
describe("planThreadPull / pullSourceFor", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sesh-plan-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const ME = "me";
  const ctx = (): { machineId: string; targetProjectDir: string } => ({
    machineId: ME,
    targetProjectDir: dir,
  });

  /** One thread, built from a chain spec, with `mB` pinned as the latest copy. */
  function thread(
    spec: Record<string, ChainRecordInput[]>,
    opts: ChainIndexesOptions = {}
  ): ResolvedThread {
    const resolved = resolveThreads(
      chainIndexes(spec, {
        advertise: { mB: { lastActiveAt: "2026-07-22T00:00:00Z" } },
        ...opts,
      })
    );
    expect(resolved).toHaveLength(1);
    return resolved[0];
  }

  /** A receipt for one machine's bundles, with the local file it names present. */
  function received(machineId: string, localSessionId = `local-${machineId}`): SyncState {
    writeFileSync(join(dir, `${localSessionId}.jsonl`), "{}\n", "utf-8");
    return syncState({
      [machineId]: peer({
        received: {
          [`sess-${machineId}`]: {
            localSessionId, type: "full", importedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      }),
    });
  }

  const plan = (t: ResolvedThread, st: SyncState) =>
    planThreadPull({
      thread: t, source: t.latest, state: st, machineId: ME, targetProjectDir: dir,
    });

  it("plans across every machine's list, root first, when one machine holds only part", () => {
    const t = thread({ mA: ["b0"], mB: ["b1<-b0"] });
    expect(t.latest.machineId).toBe("mB");

    const p = plan(t, syncState());

    expect(p.needed.map((s) => [s.machineId, s.record.bundleId])).toEqual([
      ["mA", "b0"],
      ["mB", "b1"],
    ]);
    expect(p.assembledCoversSource).toBe(true);
    expect(p.outstanding).toEqual([]);
  });

  it("still finds work when the resolved machine's own list is fully received (the #35 nag)", () => {
    // The shape that answered "Already up to date with the source machine"
    // forever: everything mB lists is here, and the earlier half of the
    // conversation — listed only by mA — is not.
    const t = thread({ mA: ["b0"], mB: ["b1<-b0"] });
    const st = received("mB");

    expect(pullSourceFor(t, st, ctx())?.machineId).toBe("mB");
    expect(plan(t, st).needed.map((s) => s.record.bundleId)).toEqual(["b0"]);
  });

  it("answers nothing-to-pull only when the whole assembled chain is here", () => {
    const t = thread({ mA: ["b0"], mB: ["b1<-b0"] });
    const st = received("mB");
    st.peers.mA = peer({
      received: {
        "sess-mA": {
          localSessionId: "local-mB", type: "full", importedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });

    expect(pullSourceFor(t, st, ctx())).toBeUndefined();
    expect(plan(t, st).needed).toEqual([]);
  });

  it("never re-fetches this machine's own pushes, though the walk must still cross them", () => {
    // Our own record is the ROOT: dropping it from the walk would strand
    // everything anchored on it, so it stays in the chain and leaves the plan.
    const t = thread({ [ME]: ["b0"], mB: ["b1<-b0"] });

    const p = plan(t, syncState());

    expect(p.assembled.chain.map((s) => s.record.bundleId)).toEqual(["b0", "b1"]);
    expect(p.needed.map((s) => [s.machineId, s.record.bundleId])).toEqual([["mB", "b1"]]);
  });

  it("orders by links, never by pushedAt — which descends in these fixtures", () => {
    const stamps = plan(thread({ mA: ["b0"], mB: ["b1<-b0"] }), syncState()).needed.map(
      (s) => s.record.pushedAt
    );
    expect([...stamps].sort()).toEqual([...stamps].reverse());
  });

  it("falls back to the resolved machine's own list when no link can cover it", () => {
    // Every bundle on every hub today predates `anchorEntryUuid`, so assembly
    // reduces this thread to its root. Narrowing the plan to that would stop
    // this release fetching continuations it fetches today — assembly may widen
    // a plan and may reorder it, never shrink it below one machine's list.
    const t = thread({ mB: ["b0", "b1<-b0"] }, { linkStyle: "pre-assembly" });

    const p = plan(t, syncState());

    expect(p.assembled.chain.map((s) => s.record.bundleId)).toEqual(["b0"]);
    expect(p.assembledCoversSource).toBe(false);
    expect(p.needed.map((s) => [s.machineId, s.record.bundleId])).toEqual([
      ["mB", "b0"],
      ["mB", "b1"],
    ]);
    expect(pullSourceFor(t, syncState(), ctx())?.machineId).toBe("mB");
  });

  it("names what it is leaving behind, and never what is already here", () => {
    // b2 predates the anchor field, so no walk can place it and no fallback
    // reaches it (it is not on the resolved machine's list). b0/b1 are being
    // fetched, so neither is outstanding.
    const t = thread({
      mA: ["b0", { id: "b2", from: "b0", preAssembly: true }],
      mB: ["b1<-b0"],
    });

    const p = plan(t, syncState());

    expect(p.needed.map((s) => s.record.bundleId)).toEqual(["b0", "b1"]);
    expect(p.outstanding.map((s) => [s.machineId, s.record.bundleId])).toEqual([["mA", "b2"]]);
    // Unlinkable, and specifically NOT a gap: a gap is a link naming an entry
    // no bundle carries, which sends a user hunting for a missing bundle.
    expect(p.assembled.unanchored).toEqual([
      { machineId: "mA", bundleId: "b2", preAssembly: true },
    ]);
    expect(p.assembled.gaps).toEqual([]);
  });

  it("merges nothing back into any machine's stored bundle list (§4.4.2)", () => {
    const t = thread({ mA: ["b0"], mB: ["b1<-b0"] });
    const before = JSON.parse(JSON.stringify(t.copies)) as unknown;

    plan(t, syncState());

    expect(JSON.parse(JSON.stringify(t.copies))).toEqual(before);
    expect(t.copies.map((c) => c.bundles.length)).toEqual([1, 1]);
  });

  it("delegates the local-latest case to alternateSource, chain or no chain", () => {
    // Our copy is newest and lists nothing; mB still holds an unreceived
    // bundle. Re-gating unconditionally here would run the receipt filter over
    // OUR list, where a missing receipt is ordinary, and start re-fetching our
    // own pushes.
    const t = thread(
      { mB: ["b0"], [ME]: [] },
      { advertise: { [ME]: { lastActiveAt: "2026-07-23T00:00:00Z" } } }
    );
    expect(t.latest.machineId).toBe(ME);

    expect(alternateSource(t, syncState(), ctx())?.machineId).toBe("mB");
    expect(pullSourceFor(t, syncState(), ctx())?.machineId).toBe("mB");
    expect(pullSourceFor(t, received("mB"), ctx())).toBeUndefined();
  });

  /**
   * SPEC §6'S CROSS-CHECK, and it is a SUBSET relation rather than an equality
   * — written as an equality it fails on precisely the case #35 fixes, which is
   * the one case worth running it for.
   *
   * `findUnfetchableBundles` answers "which bundles do other machines list that
   * the RESOLVED machine's list does not offer". Before assembly that WAS the
   * unfetchable set, because a pull read one machine's list. Assembly's whole
   * purpose is to make most of them fetchable, so the two sets are expected to
   * differ, in one direction only:
   *
   *     assemblySet ⊆ heuristicSet
   *
   * where `assemblySet` is what a pull now DISCLOSES (the heuristic minus the
   * assembled plan — the subtraction both disclosure sites apply) and
   * `heuristicSet` is the raw union-difference. Three assertions, and the third
   * is the one that catches a silent drop:
   *
   *   1. assembly never invents an unfetchable bundle the heuristic did not see;
   *   2. the difference is NON-EMPTY here — otherwise assembly changed nothing
   *      and the fix did not land;
   *   3. every id in the difference is FETCHED, not merely reclassified. Without
   *      this an assembly bug that quietly discards a bundle passes 1 and 2 both.
   *
   * `findUnfetchableBundles` is kept for ONE RELEASE to be this cross-check, then
   * removed (its own doc says so). This is what "kept for" means, so deleting the
   * function means deleting this block, not silently orphaning it.
   */
  describe("the §6 cross-check against findUnfetchableBundles", () => {
    /** The three sets §6 names, for one thread and one resolved source. */
    function sets(t: ResolvedThread, st: SyncState) {
      const p = planThreadPull({
        thread: t, source: t.latest, state: st, machineId: ME, targetProjectDir: dir,
      });
      const fetching = new Set(p.needed.map((s) => `${s.machineId} ${s.record.bundleId}`));
      const heuristic = findUnfetchableBundles({
        copies: t.copies,
        sourceMachineId: t.latest.machineId,
        localMachineId: ME,
        state: st,
      });
      const heuristicSet = new Set(heuristic.flatMap((u) => u.bundleIds));
      // Exactly the subtraction pull-select.ts and whereis.ts both apply.
      const assemblySet = new Set(
        heuristic.flatMap((u) => u.bundleIds.filter((id) => !fetching.has(`${u.machineId} ${id}`)))
      );
      return { plan: p, heuristicSet, assemblySet };
    }

    function crossCheck(t: ResolvedThread, st: SyncState, expectDifference: boolean): void {
      const { plan: p, heuristicSet, assemblySet } = sets(t, st);
      // (1) ⊆ — a violation means assembly lost a link the union-difference
      // could still see.
      for (const id of assemblySet) {
        expect([...heuristicSet], `assembly invented an unfetchable bundle: ${id}`).toContain(id);
      }
      const difference = [...heuristicSet].filter((id) => !assemblySet.has(id));
      if (expectDifference) {
        // (2) non-empty, or assembly changed nothing on a fixture built to make
        // it change something.
        expect(difference.length, "assembly reclassified nothing here").toBeGreaterThan(0);
      }
      // (3) every id in the difference is actually FETCHED.
      const plannedIds = new Set(p.needed.map((s) => s.record.bundleId));
      for (const id of difference) {
        expect(
          [...plannedIds],
          `${id} left the unfetchable set without entering the fetch plan`
        ).toContain(id);
      }
    }

    it("holds on the three-machine chain a pull now assembles whole (#35)", () => {
      // mC resolves, and the earlier half of the conversation is listed only by
      // mA — the shape the heuristic was built to disclose and assembly now
      // fetches. Every one of mA's records must move from "unfetchable" into
      // the plan, not merely out of the set.
      const t = thread(
        { mA: ["b0"], mB: ["b1<-b0"], mC: ["b2<-b1"] },
        { advertise: { mC: { lastActiveAt: "2026-07-23T00:00:00Z" } } }
      );
      expect(t.latest.machineId).toBe("mC");

      crossCheck(t, syncState(), true);
    });

    it("holds when the resolved machine's own list is already fully received", () => {
      // The #35 nag shape: mC's list is here, so the pull used to answer
      // "already up to date" while the rest of the thread sat on mA and mB.
      const t = thread(
        { mA: ["b0"], mB: ["b1<-b0"], mC: ["b2<-b1"] },
        { advertise: { mC: { lastActiveAt: "2026-07-23T00:00:00Z" } } }
      );

      crossCheck(t, received("mC"), true);
    });

    it("holds when a gap keeps the far half genuinely out of reach", () => {
      // b1 anchors on a head no record ships, so mB's and mC's records stay
      // unfetchable — the difference may be empty, and the ⊆ half plus "nothing
      // silently left the set" are what the check is for here.
      const t = thread(
        {
          mA: ["b0"],
          mB: [{ id: "b1", anchorUuid: chainHead("missing") }],
          mC: ["b2<-b1"],
        },
        { advertise: { mA: { lastActiveAt: "2026-07-23T00:00:00Z" } } }
      );
      expect(t.latest.machineId).toBe("mA");

      const { plan: p } = sets(t, syncState());
      expect(p.assembled.gaps.map((g) => g.bundleId)).toEqual(["b1"]);
      crossCheck(t, syncState(), false);
    });

    it("holds on a wholly pre-assembly hub, where no walk links anything", () => {
      // Every bundle already on every hub. Assembly reduces the thread to its
      // root and the plan falls back to the resolved machine's own list, so
      // whatever leaves the heuristic set has to be in that fallback.
      const t = thread(
        { mA: ["b0", "b1<-b0"], mB: ["b2<-b1"], mC: ["b3<-b2"] },
        {
          linkStyle: "pre-assembly",
          advertise: { mA: { lastActiveAt: "2026-07-23T00:00:00Z" } },
        }
      );
      expect(t.latest.machineId).toBe("mA");

      crossCheck(t, syncState(), false);
    });
  });
});
