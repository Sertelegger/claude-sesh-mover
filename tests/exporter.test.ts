import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

describe("exporter", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-exporter-test-"));
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("exportSession", () => {
    it("exports a single session with all layers", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-output");
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "test-export",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessions).toHaveLength(1);

      // Verify exported files
      const exportPath = result.exportPath;
      expect(existsSync(join(exportPath, "manifest.json"))).toBe(true);
      expect(existsSync(join(exportPath, "sessions", `${sessionId}.jsonl`))).toBe(true);
      expect(existsSync(join(exportPath, "memory", "MEMORY.md"))).toBe(true);
      expect(existsSync(join(exportPath, "memory", "test_memory.md"))).toBe(true);

      // Verify manifest
      const manifest = JSON.parse(
        readFileSync(join(exportPath, "manifest.json"), "utf-8")
      );
      expect(manifest.version).toBe(1);
      expect(manifest.plugin).toBe("sesh-mover");
      expect(manifest.sessions[0].sessionId).toBe(sessionId);
      expect(manifest.sessions[0].integrityHash).toMatch(/^sha256:/);
    });

    it("respects layer exclusions", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-no-history");
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "no-history",
        excludeLayers: ["file-history", "plans"],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        existsSync(join(result.exportPath, "file-history"))
      ).toBe(false);
      expect(existsSync(join(result.exportPath, "plans"))).toBe(false);
      expect(
        existsSync(join(result.exportPath, "sessions", `${sessionId}.jsonl`))
      ).toBe(true);
    });

    it("detects name collision", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-collision");

      // First export
      await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "same-name",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      // Second export with same name
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "same-name",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        collisionCheck: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.collision).toBe(true);
    });
  });

  describe("exportAllSessions", () => {
    it("exports all sessions for a project", async () => {
      const { exportAllSessions } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-all");
      const result = await exportAllSessions({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "all-sessions",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    });
  });
});
