import { describe, it, expect } from "vitest";
import { resolveThreads, findUnfetchableBundles } from "../src/hub/threads.js";
import { idx, entry, bundle, copy, peer, syncState } from "./helpers/hub-fixtures.js";

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

  it("does not treat an empty head uuid as a match", () => {
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
