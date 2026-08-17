/**
 * Extraction guard — the `fail` escape must forward the importer's own
 * diagnosis VERBATIM (`command: "import"` included, phrased for `import` and
 * not re-stamped for `pull`), while the disclosures collected before it survive
 * on `warnings`.
 *
 * **This reverses half of what this file used to assert, on purpose.** It
 * previously pinned `toBe(FAKE)` — same object identity — and, explicitly, that
 * the divergence sentence the stage had pushed a moment earlier "goes with it".
 * That second half was the defect, not the contract: bundles before the failing
 * one are applied and recorded as received, so they will never be offered
 * again, and a result that mentions none of them is untruthful about what the
 * command did. `ErrorResult.warnings` exists for exactly this, and the failure
 * contract puts truthfulness above completeness.
 *
 * The half that survives is the one that mattered: the importer's diagnosis is
 * not rewritten. `command`, `error`, `details` and `suggestion` still come
 * through untouched, because a suggestion phrased for `import` is worse than
 * useless once re-labelled `pull` — the reader cannot follow it.
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
  it("forwards the importer's diagnosis unrewritten, and keeps the disclosures collected before it", async () => {
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
      const r = (await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "fragment", claudeVersion: "2.1.81",
      })) as ErrorResult;

      // The diagnosis is the importer's, field for field. Nothing re-stamped.
      expect(r.command).toBe("import");
      expect(r.error).toBe(FAKE.error);
      expect(r.details).toBe(FAKE.details);
      expect(r.suggestion).toBe(FAKE.suggestion);

      // The disclosure the stage pushed a moment earlier now survives the
      // failure instead of vanishing with it.
      expect(r.warnings).toBeDefined();
      expect(JSON.stringify(r.warnings)).toContain("has diverged");

      // The importer's own object is NOT mutated on the way out — the pull
      // copies rather than writing a field into a result it does not own.
      // Without this, a caller holding the same object would see it change
      // under them, which is the failure mode "forwarded verbatim" invites.
      expect(Object.prototype.hasOwnProperty.call(FAKE, "warnings")).toBe(false);
    } finally {
      h.fail = null;
      a.cleanup();
    }
  });
});
