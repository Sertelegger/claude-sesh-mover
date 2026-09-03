/**
 * # `hub compact` — the two pure decisions (#92)
 *
 * Compaction is the only operation in this slice whose mistakes are
 * irreversible, so these tests are written against the ways the predicate could
 * say YES when the answer is no. A false "outstanding" costs a wait; a false
 * "acknowledged" or a false "deletable" costs a transcript nobody else has.
 *
 * Two properties carry most of the weight and neither is visible in a happy
 * path:
 *
 * 1. **A machine that only ever pulls publishes no bundle id at all**, so
 *    #92's literal criterion — "every participating machine's index shows the
 *    consolidated bundle" — can never be satisfied by it. The tests below fix
 *    the substitute in place: acknowledgement is evidence of CONTENT (an
 *    advertised head, or a record anchored on one), never of a file name.
 * 2. **Coverage is containment, not chain shape.** A parked fork chains
 *    perfectly onto the same history and holds entries the surviving branch's
 *    full export does not have. Retiring it on link evidence deletes the hub's
 *    only copy. So there is a test whose fork is *structurally indistinguishable
 *    from a covered record* and is kept anyway.
 */

import { describe, it, expect } from "vitest";
import {
  planAck,
  planRetirement,
  COMPACTION_GRACE_MS,
  type AckPlanInput,
} from "../src/hub/compact-plan.js";
import type { HubBundleRecord, HubIndexJson } from "../src/hub/layout.js";

function record(over: Partial<HubBundleRecord> & { bundleId: string }): HubBundleRecord {
  return {
    file: `bundles/m/${over.bundleId}.tar.gz`,
    type: "continuation",
    sessionIdInBundle: "s-1",
    fromEntryUuid: null,
    headEntryUuid: `head-${over.bundleId}`,
    messageCount: 10,
    pushedAt: "2026-08-01T00:00:00Z",
    hasWorkspace: false,
    ...over,
  };
}

function index(
  machineId: string,
  threadId: string,
  entry: { headEntryUuid: string; bundles?: HubBundleRecord[] } | null
): HubIndexJson {
  return {
    schemaVersion: 1,
    agent: "claude-code",
    projectId: "p-1",
    machineId,
    updatedAt: "2026-08-01T00:00:00Z",
    projectPath: "/proj",
    threads: entry
      ? {
          [threadId]: {
            localSessionId: `local-${machineId}`,
            slug: "slug",
            summary: "summary",
            headEntryUuid: entry.headEntryUuid,
            messageCount: 10,
            lastActiveAt: "2026-08-01T00:00:00Z",
            bundles: entry.bundles ?? [],
          },
        }
      : {},
  };
}

const T = "thread-1";
const H = "head-consolidated";

function ack(over: Partial<AckPlanInput> & { indexes: HubIndexJson[] }) {
  return planAck({
    threadId: T,
    machineId: "me",
    consolidatedHead: H,
    retiringBundleIds: [],
    ...over,
  });
}

describe("planAck — who still needs what is behind the consolidation", () => {
  it("counts a machine whose advertised head IS the consolidated head", () => {
    const plan = ack({
      indexes: [index("me", T, { headEntryUuid: H }), index("b", T, { headEntryUuid: H })],
    });
    expect(plan.outstanding).toEqual([]);
    expect(plan.acknowledged.sort()).toEqual(["b", "me"]);
  });

  it("counts a PULL-ONLY machine, which lists no bundle id and never will", () => {
    // The whole reason #92's literal criterion had to be replaced: a pull writes
    // its own index with `newBundles: []`, so this machine is fully caught up
    // and yet names no bundle at all. Waiting for it to "show the consolidated
    // bundle" would wait forever.
    const plan = ack({
      indexes: [
        index("me", T, { headEntryUuid: H }),
        index("puller", T, { headEntryUuid: H, bundles: [] }),
      ],
    });
    expect(plan.outstanding).toEqual([]);
    expect(plan.acknowledged).toContain("puller");
  });

  it("counts a machine that pushed a record anchored on an acknowledged head", () => {
    const plan = ack({
      indexes: [
        index("me", T, { headEntryUuid: H }),
        index("b", T, {
          // Its own head has moved past the consolidation, so the head test
          // alone would report it outstanding — but what it pushed proves it
          // held H to diff against.
          headEntryUuid: "head-b2",
          bundles: [record({ bundleId: "b2", anchorEntryUuid: H, headEntryUuid: "head-b2" })],
        }),
      ],
    });
    expect(plan.outstanding).toEqual([]);
  });

  it("extends the acknowledged set THROUGH another machine's continuation", () => {
    // C is not at H and never anchored on it; it is at the head of a
    // continuation that B pushed on top of H. The walk has to be cross-machine
    // or C is reported outstanding because a PEER, not C, moved the thread on.
    const plan = ack({
      indexes: [
        index("me", T, { headEntryUuid: H }),
        index("b", T, {
          headEntryUuid: "head-b2",
          bundles: [record({ bundleId: "b2", anchorEntryUuid: H, headEntryUuid: "head-b2" })],
        }),
        index("c", T, { headEntryUuid: "head-b2" }),
      ],
    });
    expect(plan.outstanding).toEqual([]);
    expect(plan.ackHeads).toContain("head-b2");
  });

  it("resolves regardless of the order records happen to appear in", () => {
    // Each index lists in its own order and a continuation can be seen before
    // the record it anchors on, so the closure has to be a fixed point rather
    // than one pass. Chain: H -> x1 -> x2 -> x3, listed backwards.
    const plan = ack({
      indexes: [
        index("me", T, { headEntryUuid: H }),
        index("b", T, {
          headEntryUuid: "head-x3",
          bundles: [
            record({ bundleId: "x3", anchorEntryUuid: "head-x2", headEntryUuid: "head-x3" }),
            record({ bundleId: "x2", anchorEntryUuid: "head-x1", headEntryUuid: "head-x2" }),
            record({ bundleId: "x1", anchorEntryUuid: H, headEntryUuid: "head-x1" }),
          ],
        }),
      ],
    });
    expect(plan.outstanding).toEqual([]);
    expect(plan.ackHeads.sort()).toEqual([H, "head-x1", "head-x2", "head-x3"].sort());
  });

  it("does NOT extend the set through a record this run is retiring", () => {
    // A head reachable only THROUGH a bundle about to be deleted is not
    // evidence that anyone still holds it afterwards. Counting it would let a
    // chain vouch for its own removal.
    const doomed = record({ bundleId: "old-1", anchorEntryUuid: H, headEntryUuid: "head-old-1" });
    const plan = ack({
      indexes: [
        index("me", T, { headEntryUuid: H, bundles: [doomed] }),
        index("b", T, { headEntryUuid: "head-old-1" }),
      ],
      retiringBundleIds: ["old-1"],
    });
    expect(plan.ackHeads).not.toContain("head-old-1");
    expect(plan.outstanding.map((o) => o.machineId)).toEqual(["b"]);
  });

  it("reports a machine that is genuinely behind, naming the head it advertises", () => {
    const plan = ack({
      indexes: [
        index("me", T, { headEntryUuid: H }),
        index("b", T, { headEntryUuid: "head-somewhere-else" }),
      ],
    });
    expect(plan.outstanding).toEqual([
      { machineId: "b", reason: "behind", advertisedHead: "head-somewhere-else" },
    ]);
  });

  it("treats a machine with NO entry for the thread as needing nothing", () => {
    // It has no local copy, so a first pull starts at the newest full bundle —
    // which after this run is the consolidated one. Safe, and the one blind
    // spot (an interrupted pull, whose index write never happened) is what the
    // grace window is for, not this predicate.
    const plan = ack({
      indexes: [index("me", T, { headEntryUuid: H }), index("fresh", T, null)],
    });
    expect(plan.outstanding).toEqual([]);
  });

  it("never lets an empty head match another empty head", () => {
    // `readLastEntryUuid(...) ?? ""` is how both index writers spell "the tail
    // scan found no conversation entry", so two machines can advertise `""`
    // legitimately. Treating those as equal would acknowledge a machine on the
    // strength of both sides knowing nothing.
    const plan = ack({
      indexes: [index("me", T, { headEntryUuid: "" }), index("b", T, { headEntryUuid: "" })],
      consolidatedHead: "",
    });
    expect(plan.outstanding).toEqual([
      { machineId: "b", reason: "unknown-head", advertisedHead: "" },
    ]);
  });

  it("distinguishes a pre-chain-assembly index, whose remedy is different", () => {
    // Every record predates `anchorEntryUuid`, so this machine can never
    // acknowledge by the anchor test however up to date it is. "Pull to catch
    // up" is the wrong advice for it, which is why it is not `behind`.
    const old = record({ bundleId: "old", headEntryUuid: "head-old" });
    delete (old as { anchorEntryUuid?: string | null }).anchorEntryUuid;
    const plan = ack({
      indexes: [
        index("me", T, { headEntryUuid: H }),
        index("b", T, { headEntryUuid: "head-old", bundles: [old] }),
      ],
    });
    expect(plan.outstanding).toEqual([
      { machineId: "b", reason: "no-anchor", advertisedHead: "head-old" },
    ]);
  });

  it("acknowledges the compacting machine tautologically", () => {
    const plan = ack({ indexes: [index("me", T, { headEntryUuid: "anything-at-all" })] });
    expect(plan.acknowledged).toEqual(["me"]);
    expect(plan.outstanding).toEqual([]);
  });
});

describe("planRetirement — what the consolidated bundle provably replaces", () => {
  const covered = new Set(["head-a", "head-b", H]);
  const coversUuid = (u: string): boolean => covered.has(u);

  it("retires records whose head the consolidated transcript contains", () => {
    const plan = planRetirement({
      ownRecords: [record({ bundleId: "a", headEntryUuid: "head-a" })],
      consolidatedBundleId: "C",
      coversUuid,
    });
    expect(plan.deletable.map((r) => r.bundleId)).toEqual(["a"]);
    expect(plan.retained).toEqual([]);
  });

  it("KEEPS a parked fork that chains perfectly but is not contained", () => {
    // The property that makes containment the test rather than link structure.
    // This record is structurally identical to a covered one — same anchor,
    // well-formed head, same position in the chain — and the only thing
    // separating them is whether the new full export actually holds its
    // entries. Divergence handling parks branches like this routinely, and the
    // local copy has already been replaced, so the hub's is the only one.
    const plan = planRetirement({
      ownRecords: [
        record({ bundleId: "a", anchorEntryUuid: H, headEntryUuid: "head-a" }),
        record({ bundleId: "fork", anchorEntryUuid: H, headEntryUuid: "head-fork" }),
      ],
      consolidatedBundleId: "C",
      coversUuid,
    });
    expect(plan.deletable.map((r) => r.bundleId)).toEqual(["a"]);
    expect(plan.retained).toEqual([{ bundleId: "fork", why: "not-covered" }]);
  });

  it("keeps a record with no usable head — an unanswerable question is not a yes", () => {
    const plan = planRetirement({
      ownRecords: [record({ bundleId: "blank", headEntryUuid: "" })],
      consolidatedBundleId: "C",
      coversUuid,
    });
    expect(plan.deletable).toEqual([]);
    expect(plan.retained).toEqual([{ bundleId: "blank", why: "unknown-head" }]);
  });

  it("never retires the consolidated bundle itself", () => {
    const plan = planRetirement({
      ownRecords: [record({ bundleId: "C", headEntryUuid: H })],
      consolidatedBundleId: "C",
      coversUuid,
    });
    expect(plan.deletable).toEqual([]);
    expect(plan.retained).toEqual([{ bundleId: "C", why: "consolidated" }]);
  });

  it("keeps everything when the coverage scan could not answer", () => {
    // A scan that failed returns false for everything, and false has to mean
    // KEEP. This is the direction the whole module is biased in.
    const plan = planRetirement({
      ownRecords: [record({ bundleId: "a" }), record({ bundleId: "b" })],
      consolidatedBundleId: "C",
      coversUuid: () => false,
    });
    expect(plan.deletable).toEqual([]);
    expect(plan.retained.map((r) => r.why)).toEqual(["not-covered", "not-covered"]);
  });
});

describe("COMPACTION_GRACE_MS", () => {
  it("is its own constant, shorter than retirement's and not derived from it", async () => {
    // Retirement waits 48h for an ASSERTION to reach a machine that may be off
    // until Monday. Acknowledgement is proof of receipt, so that axis is
    // already closed and re-importing 48h would wait for something known. What
    // is left is the in-flight pull, which is hours — and a machine that is
    // switched off cannot have one.
    expect(COMPACTION_GRACE_MS).toBe(6 * 60 * 60 * 1000);
    const { RETIREMENT_GRACE_MS } = await import("../src/hub/tombstone.js");
    expect(COMPACTION_GRACE_MS).toBeLessThan(RETIREMENT_GRACE_MS);
  });
});
