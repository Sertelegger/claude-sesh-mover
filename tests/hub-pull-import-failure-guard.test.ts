/**
  * Extraction guard — the `fail` escape must return the importer's own
 * ErrorResult VERBATIM (same object, `command: "import"` included), and every
 * warning collected so far — the stage's and the pull's — must be dropped with
 * it.
 */
import { describe, it, expect, vi } from "vitest";
import { hubPull } from "../src/hub/pull.js";
import { arrangeDivergence } from "./helpers/hub-fixtures.js";
import type { ErrorResult } from "../src/types.js";

const h = vi.hoisted(() => ({
  fail: null as ErrorResult | null,
}));

vi.mock("../src/importer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/importer.js")>();
  return {
    ...actual,
    importSession: async (a: Parameters<typeof actual.importSession>[0]) =>
      h.fail ?? actual.importSession(a),
  };
});

describe("PROBE: the fragment-import failure is forwarded verbatim", () => {
  it("returns the importer's ErrorResult object itself, warnings dropped", async () => {
    const a = await arrangeDivergence();
    try {
      const FAKE: ErrorResult = {
        success: false,
        command: "import",
        error: "simulated importer failure",
        details: "details from the importer",
        suggestion: "a suggestion phrased for `import`, not for `pull`",
      };
      h.fail = FAKE;
      const r = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "fragment", claudeVersion: "2.1.81",
      });
      // Same object identity: nothing re-stamped, nothing re-wrapped.
      expect(r).toBe(FAKE);
      expect((r as ErrorResult).command).toBe("import");
      // No warnings channel at all on the failure path — the divergence
      // sentence the stage pushed a moment earlier goes with it.
      expect(Object.prototype.hasOwnProperty.call(r, "warnings")).toBe(false);
      expect(JSON.stringify(r)).not.toContain("has diverged");
    } finally {
      h.fail = null;
      a.cleanup();
    }
  });
});
