import { describe, it, expect } from "vitest";
import type { DiscoveredSession, SyncStateSessionSent } from "../src/types.js";

function fakeSession(id: string, messageCount = 3): DiscoveredSession {
  return {
    sessionId: id,
    projectPath: "/p",
    encodedProjectDir: "-p",
    jsonlPath: `/p/${id}.jsonl`,
    slug: `slug-${id}`,
    createdAt: "2026-04-10T12:00:00Z",
    lastActiveAt: "2026-04-10T12:05:00Z",
    messageCount,
    gitBranch: "main",
    entrypoint: "cli",
    hasSubagents: false,
    hasToolResults: false,
    hasFileHistory: false,
  };
}

function entries(...uuids: string[]): Array<{ uuid: string }> {
  return uuids.map((u) => ({ uuid: u }));
}

describe("diff.computeIncrementalPlan", () => {
  it("treats unknown sessions as full", async () => {
    const { computeIncrementalPlan } = await import("../src/diff.js");
    const s = fakeSession("s1");
    const plan = computeIncrementalPlan([s], {}, () => entries("u1", "u2", "u3"));
    expect(plan.full.map((x) => x.sessionId)).toEqual(["s1"]);
    expect(plan.continuation).toEqual([]);
    expect(plan.unchanged).toEqual([]);
  });

  it("marks sessions with unchanged head as unchanged", async () => {
    const { computeIncrementalPlan } = await import("../src/diff.js");
    const s = fakeSession("s1", 3);
    const sent: Record<string, SyncStateSessionSent> = {
      s1: {
        headEntryUuid: "u3",
        messageCount: 3,
        sentAsType: "full",
        sentAsSessionId: "s1",
      },
    };
    const plan = computeIncrementalPlan([s], sent, () => entries("u1", "u2", "u3"));
    expect(plan.unchanged.map((x) => x.sessionId)).toEqual(["s1"]);
    expect(plan.full).toEqual([]);
    expect(plan.continuation).toEqual([]);
  });

  it("emits continuation for sessions with new entries after the stored head", async () => {
    const { computeIncrementalPlan } = await import("../src/diff.js");
    const s = fakeSession("s1", 5);
    const sent: Record<string, SyncStateSessionSent> = {
      s1: {
        headEntryUuid: "u3",
        messageCount: 3,
        sentAsType: "full",
        sentAsSessionId: "s1",
      },
    };
    const plan = computeIncrementalPlan([s], sent, () =>
      entries("u1", "u2", "u3", "u4", "u5")
    );
    expect(plan.continuation.length).toBe(1);
    expect(plan.continuation[0].session.sessionId).toBe("s1");
    expect(plan.continuation[0].fromEntryIndex).toBe(3);
    expect(plan.continuation[0].fromEntryUuid).toBe("u4");
    // The anchor is the RECORDED head — one BEFORE the first entry shipped.
    // The two are adjacent and never equal, which is why a chain has to link on
    // the anchor and not on fromEntryUuid (#35 / spec §0b).
    expect(plan.continuation[0].anchorEntryUuid).toBe("u3");
    expect(plan.continuation[0].anchorEntryUuid).not.toBe(
      plan.continuation[0].fromEntryUuid
    );
    expect(plan.full).toEqual([]);
    expect(plan.unchanged).toEqual([]);
  });

  it("carries the recorded head as the anchor even when the first shipped entry is uuid-less", async () => {
    const { computeIncrementalPlan } = await import("../src/diff.js");
    const s = fakeSession("s1", 5);
    const sent: Record<string, SyncStateSessionSent> = {
      s1: { headEntryUuid: "u3", messageCount: 3, sentAsType: "full", sentAsSessionId: "s1" },
    };
    // readEntryUuids maps every uuid-less or unparseable line to "" (jsonl.ts),
    // and the line after a head is frequently uuid-less bookkeeping — so ""
    // is an ORDINARY fromEntryUuid. The anchor must not inherit that emptiness:
    // an empty link matches nothing, ever.
    const plan = computeIncrementalPlan([s], sent, () => entries("u1", "u2", "u3", "", "u5"));

    expect(plan.continuation).toHaveLength(1);
    expect(plan.continuation[0].fromEntryUuid).toBe("");
    expect(plan.continuation[0].anchorEntryUuid).toBe("u3");
  });

  it("never plans a continuation with an empty anchor: an empty recorded head is a full push", async () => {
    const { computeIncrementalPlan } = await import("../src/diff.js");
    const s = fakeSession("s1", 5);
    // The guard that makes `anchorEntryUuid` non-empty by construction. Both
    // fallbacks that produce a root are exercised: an empty recorded head, and
    // a head no longer present in the transcript.
    for (const headEntryUuid of ["", "u-gone"]) {
      const sent: Record<string, SyncStateSessionSent> = {
        s1: { headEntryUuid, messageCount: 3, sentAsType: "full", sentAsSessionId: "s1" },
      };
      const plan = computeIncrementalPlan([s], sent, () => entries("u1", "u2", "u3", "u4", "u5"));
      expect(plan.continuation).toEqual([]);
      expect(plan.full.map((x) => x.sessionId)).toEqual(["s1"]);
    }
  });

  it("treats a session with fewer entries than recorded as full, with warning", async () => {
    const { computeIncrementalPlan } = await import("../src/diff.js");
    const s = fakeSession("s1", 1);
    const sent: Record<string, SyncStateSessionSent> = {
      s1: {
        headEntryUuid: "u5",
        messageCount: 5,
        sentAsType: "full",
        sentAsSessionId: "s1",
      },
    };
    const plan = computeIncrementalPlan([s], sent, () => entries("u1"));
    expect(plan.full.map((x) => x.sessionId)).toEqual(["s1"]);
    expect(plan.warnings.some((w) => /shorter than recorded/i.test(w))).toBe(true);
  });

  it("treats a session whose stored head UUID is absent from current entries as full, with warning", async () => {
    const { computeIncrementalPlan } = await import("../src/diff.js");
    const s = fakeSession("s1", 3);
    const sent: Record<string, SyncStateSessionSent> = {
      s1: {
        headEntryUuid: "u-gone",
        messageCount: 3,
        sentAsType: "full",
        sentAsSessionId: "s1",
      },
    };
    const plan = computeIncrementalPlan([s], sent, () =>
      entries("u1", "u2", "u3")
    );
    expect(plan.full.map((x) => x.sessionId)).toEqual(["s1"]);
    expect(plan.warnings.some((w) => /head uuid/i.test(w))).toBe(true);
  });

  it("treats an empty recorded head UUID as full, with warning", async () => {
    const { computeIncrementalPlan } = await import("../src/diff.js");
    const s = fakeSession("s1", 3);
    const sent: Record<string, SyncStateSessionSent> = {
      s1: {
        headEntryUuid: "",
        messageCount: 3,
        sentAsType: "full",
        sentAsSessionId: "s1",
      },
    };
    // Local entries include an unparseable line mapped to uuid:"" — the old
    // code would findIndex-match it and produce a bogus slice point.
    const plan = computeIncrementalPlan([s], sent, () =>
      entries("u1", "", "u3")
    );
    expect(plan.full.map((x) => x.sessionId)).toEqual(["s1"]);
    expect(plan.continuation).toEqual([]);
    expect(plan.warnings.some((w) => /empty/i.test(w))).toBe(true);
  });
});
