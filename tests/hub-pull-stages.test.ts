import { describe, it, expect } from "vitest";
import { stageOk, stageSkip, stageRefuse } from "../src/hub/pull-stages.js";
import { initApplyState } from "../src/hub/pull-apply-state.js";
import { bundle } from "./helpers/hub-fixtures.js";

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

describe("initApplyState", () => {
  it("starts every accumulator empty", () => {
    const st = initApplyState({ needed: [bundle({ bundleId: "b0" })] });
    expect(st.appended).toEqual([]);
    expect(st.importedSessions).toEqual([]);
    expect(st.skippedSessions).toEqual([]);
    expect(st.chainWorkspaceBases).toEqual([]);
    expect(st.ourWritesFrom.size).toBe(0);
    expect(st.lastAppliedIndex).toBe(-1);
    expect(st.abortIndex).toBe(-1);
    expect(st.deferredBundles).toBe(0);
    expect(st.divergenceAborted).toBe(false);
    expect(st.skippedByDivergence).toBe(false);
    expect(st.lastCarry).toBeNull();
    expect(st.lastImportedNewId).toBeNull();
    expect(st.lastBundleManifest).toBeNull();
    expect(st.threadLandedSessionId).toBeNull();
    expect(st.lastDivergence).toBeUndefined();
    expect(st.workspaceUnpacked).toBeNull();
    expect(st.workspaceMerge).toBeUndefined();
    expect(st.workspaceRefused).toBeUndefined();
    expect(st.workspaceDeclaredMissing).toBeUndefined();
  });

  it("points workspaceBundleIndex at the NEWEST bundle carrying a payload", () => {
    const st = initApplyState({
      needed: [
        bundle({ bundleId: "b0", hasWorkspace: true }),
        bundle({ bundleId: "b1", hasWorkspace: true }),
        bundle({ bundleId: "b2", hasWorkspace: false }),
      ],
    });
    expect(st.workspaceBundleIndex).toBe(1);
  });

  it("falls back to index 0 when no bundle in the chain claims a payload", () => {
    const st = initApplyState({
      needed: [bundle({ bundleId: "b0" }), bundle({ bundleId: "b1" })],
    });
    expect(st.workspaceBundleIndex).toBe(0);
  });

  /**
   * The whole point of the extraction: one MUTABLE object passed by reference.
   * `describeApplied` must see pushes made after construction — a value-copy
   * refactor would still typecheck and would silently report "nothing landed"
   * in the divergence warnings.
   */
  it("is mutable state whose closures observe writes made after construction", () => {
    const st = initApplyState({ needed: [bundle()] });
    expect(st.describeApplied(0)).toBe("");
    st.importedSessions.push({ originalId: "a", newId: "b", slug: "s", messageCount: 1 });
    expect(st.describeApplied(1)).toBe(
      "the 1 earlier bundle in this chain was already applied and recorded (1 session imported)"
    );
    st.appended.push({ threadId: "t", baseSessionId: "s1", entriesAppended: 2 });
    st.skippedSessions.push({ originalId: "c", reason: "duplicate" });
    expect(st.describeApplied(2)).toBe(
      "the 2 earlier bundles in this chain were already applied and recorded " +
        "(2 entries spliced into session s1, 1 session imported, 1 session already present)"
    );
  });

  it("describeApplied names the gap when the earlier bundles landed nothing", () => {
    const st = initApplyState({ needed: [bundle()] });
    expect(st.describeApplied(3)).toBe(
      "the 3 earlier bundles in this chain were already applied and recorded (no session content landed from them)"
    );
  });

  it("rememberOurWrite keeps the earliest offset per path", () => {
    const st = initApplyState({ needed: [bundle()] });
    st.rememberOurWrite("/a.jsonl", 500);
    st.rememberOurWrite("/a.jsonl", 120);
    st.rememberOurWrite("/a.jsonl", 900);
    st.rememberOurWrite("/b.jsonl", 7);
    expect(st.ourWritesFrom.get("/a.jsonl")).toBe(120);
    expect(st.ourWritesFrom.get("/b.jsonl")).toBe(7);
  });
});
