import { describe, it, expect } from "vitest";
import {
  machinePath, projectJsonPath, indexPath, bundleDir, bundleFileName,
  assertHubRelPath, assertSafeHubId,
} from "../src/hub/layout.js";

describe("hub layout", () => {
  it("builds hub-relative paths with forward slashes", () => {
    expect(machinePath("m1")).toBe("machines/m1.json");
    expect(projectJsonPath("p1")).toBe("projects/p1/project.json");
    expect(indexPath("p1", "m1")).toBe("projects/p1/index/m1.json");
    expect(bundleDir("p1", "m1")).toBe("projects/p1/bundles/m1");
  });

  it("bundle file names are sortable and safe", () => {
    const name = bundleFileName("2026-07-21T10:20:30.123Z", "abc-123");
    expect(name).toBe("2026-07-21T10-20-30.123Z-abc-123.tar.gz"); // ':' sanitized for Windows
  });

  it("path builders reject unsafe ids", () => {
    expect(() => machinePath("../escape")).toThrow(/unsafe/i);
    expect(() => indexPath("p1", "a/b")).toThrow(/unsafe/i);
    expect(() => projectJsonPath("..")).toThrow(/unsafe/i);
  });

  it("assertHubRelPath rejects traversal and absolute paths", () => {
    expect(() => assertHubRelPath("/etc/passwd")).toThrow(/hub-relative/i);
    expect(() => assertHubRelPath("C:\\x")).toThrow(/hub-relative/i);
    expect(() => assertHubRelPath("a/../b")).toThrow(/hub-relative/i);
    expect(() => assertHubRelPath("")).toThrow(/hub-relative/i);
    expect(() => assertHubRelPath("a//b")).toThrow(/hub-relative/i);
    assertHubRelPath("projects/p1/index/m1.json"); // does not throw
  });

  it("assertSafeHubId narrows and throws with context", () => {
    expect(() => assertSafeHubId("../x", "projectId")).toThrow(/projectId/);
    assertSafeHubId("550e8400-e29b-41d4-a716-446655440000", "projectId");
  });
});
