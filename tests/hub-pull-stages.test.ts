import { describe, it, expect } from "vitest";
import { stageOk, stageSkip, stageRefuse } from "../src/hub/pull-stages.js";

describe("stage outcome constructors", () => {
  it("stageOk carries the value and defaults to no reasons", () => {
    const o = stageOk({ count: 2 });
    expect(o.status).toBe("applied");
    expect(o.value).toEqual({ count: 2 });
    expect(o.reasons).toEqual([]);
  });

  it("stageOk keeps reasons alongside an applied value", () => {
    const o = stageOk({ count: 2 }, ["1 bundle unreachable"]);
    expect(o.status).toBe("applied");
    expect(o.reasons).toEqual(["1 bundle unreachable"]);
  });

  it("stageSkip and stageRefuse carry no value and exactly one reason", () => {
    const s = stageSkip<{ count: number }>("nothing to do");
    const r = stageRefuse<{ count: number }>("target not empty");
    expect(s.status).toBe("skipped");
    expect(s.value).toBeNull();
    expect(s.reasons).toEqual(["nothing to do"]);
    expect(r.status).toBe("refused");
    expect(r.value).toBeNull();
    expect(r.reasons).toEqual(["target not empty"]);
  });
});
