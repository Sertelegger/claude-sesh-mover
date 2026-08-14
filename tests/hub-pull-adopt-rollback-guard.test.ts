/**
  * Extraction guard — the same question for `adoptHubBranch`, which has its own
 * refuse-and-throw rollback rule and is reached only via --on-divergence
 * adopt-hub.
 */
import { describe, it, expect, vi } from "vitest";
import { hubPull } from "../src/hub/pull.js";
import { arrangeDivergence } from "./helpers/hub-fixtures.js";

vi.mock("../src/hub/append.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hub/append.js")>();
  return {
    ...actual,
    adoptHubBranch: (): never => {
      throw new Error("adopt rollback was REFUSED (simulated)");
    },
  };
});

describe("PROBE: adoptHubBranch's throw propagates out of hubPull", () => {
  it("rejects instead of returning a result", async () => {
    const a = await arrangeDivergence();
    try {
      await expect(
        hubPull({
          configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
          latest: true, onDivergence: "adopt-hub", forceAppend: true, claudeVersion: "2.1.81",
        })
      ).rejects.toThrow(/adopt rollback was REFUSED/);
    } finally {
      a.cleanup();
    }
  });
});
