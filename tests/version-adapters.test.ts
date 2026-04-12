import { describe, it, expect } from "vitest";

describe("version-adapters", () => {
  describe("getApplicableAdapters", () => {
    it("returns empty array for same version", async () => {
      const { getApplicableAdapters } = await import(
        "../src/version-adapters.js"
      );
      const adapters = getApplicableAdapters("2.1.81", "2.1.81");
      expect(adapters).toHaveLength(0);
    });

    it("returns adapters between source and target versions", async () => {
      const { getApplicableAdapters } = await import(
        "../src/version-adapters.js"
      );
      // Even if no real adapters exist yet, the function should work
      const adapters = getApplicableAdapters("1.0.0", "99.0.0");
      expect(Array.isArray(adapters)).toBe(true);
    });
  });

  describe("applyAdapters", () => {
    it("passes through entries when no adapters apply", async () => {
      const { applyAdapters } = await import("../src/version-adapters.js");
      const entry = {
        uuid: "1",
        type: "user",
        message: { role: "user", content: "hello" },
      };
      const { entry: result, applied } = applyAdapters(entry, []);
      expect(result).toEqual(entry);
      expect(applied).toHaveLength(0);
    });

    it("preserves unknown entry types", async () => {
      const { applyAdapters } = await import("../src/version-adapters.js");
      const entry = {
        uuid: "1",
        type: "future-unknown-type",
        data: { something: "new" },
      };
      const { entry: result } = applyAdapters(entry, []);
      expect(result).toEqual(entry);
    });
  });

  describe("compareVersions", () => {
    it("returns 0 for equal versions", async () => {
      const { compareVersions } = await import("../src/version-adapters.js");
      expect(compareVersions("2.1.81", "2.1.81")).toBe(0);
    });

    it("returns negative when first is older", async () => {
      const { compareVersions } = await import("../src/version-adapters.js");
      expect(compareVersions("2.0.0", "2.1.0")).toBeLessThan(0);
    });

    it("returns positive when first is newer", async () => {
      const { compareVersions } = await import("../src/version-adapters.js");
      expect(compareVersions("3.0.0", "2.1.81")).toBeGreaterThan(0);
    });
  });

  describe("classifyVersionDifference", () => {
    it("returns same for identical versions", async () => {
      const { classifyVersionDifference } = await import(
        "../src/version-adapters.js"
      );
      expect(classifyVersionDifference("2.1.81", "2.1.81")).toBe("same");
    });

    it("returns source-newer when export is from newer version", async () => {
      const { classifyVersionDifference } = await import(
        "../src/version-adapters.js"
      );
      expect(classifyVersionDifference("3.0.0", "2.1.81")).toBe(
        "source-newer"
      );
    });

    it("returns target-newer when target is newer", async () => {
      const { classifyVersionDifference } = await import(
        "../src/version-adapters.js"
      );
      expect(classifyVersionDifference("2.0.0", "2.1.81")).toBe(
        "target-newer"
      );
    });
  });
});
