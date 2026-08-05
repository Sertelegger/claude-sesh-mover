import { describe, it, expect } from "vitest";
import { resolveThreads } from "../src/hub/threads.js";
import { idx, entry } from "./helpers/hub-fixtures.js";

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
});
