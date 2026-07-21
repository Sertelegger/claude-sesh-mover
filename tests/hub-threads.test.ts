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
