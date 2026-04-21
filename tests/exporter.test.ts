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

  it("incremental export emits continuation session for a session with new entries", async () => {
    const { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { readManifest } = await import("../src/manifest.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-inc-export-"));
    try {
      const fx = createFixtureTree(tempDir);
      const outputDir = join(tempDir, "exports");
      mkdirSync(outputDir, { recursive: true });

      const result = await exportAllSessions({
        configDir: fx.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "inc-test",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {
            [fx.sessionId]: {
              headEntryUuid: "entry-2",
              messageCount: 2,
              sentAsType: "full",
              sentAsSessionId: fx.sessionId,
            },
          },
        },
      });

      expect(result.success).toBe(true);
      const manifest = readManifest((result as { exportPath: string }).exportPath);
      expect(manifest.incremental).toBe(true);
      expect(manifest.sourceMachineId).toBe("machine-A");
      expect(manifest.baseline?.targetMachineId).toBe("machine-B");
      expect(manifest.sessions.length).toBe(1);
      const s = manifest.sessions[0];
      expect(s.type).toBe("continuation");
      expect(s.continuation?.fromEntryIndex).toBe(2);
      expect(s.continuation?.fromEntryUuid).toBe("entry-3");
      expect(s.continuation?.continuesLocalSessionId).toBe(fx.sessionId);

      const jsonlPath = join(
        (result as { exportPath: string }).exportPath,
        "sessions",
        `${s.sessionId}.jsonl`
      );
      expect(existsSync(jsonlPath)).toBe(true);
      const firstLine = JSON.parse(
        readFileSync(jsonlPath, "utf-8").split("\n")[0]
      );
      expect(firstLine.message.content).toContain("[sesh-mover continuation]");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("incremental export skips unchanged sessions", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { readManifest } = await import("../src/manifest.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-inc-unchanged-"));
    try {
      const fx = createFixtureTree(tempDir);
      const outputDir = join(tempDir, "exports");
      mkdirSync(outputDir, { recursive: true });

      const result = await exportAllSessions({
        configDir: fx.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "inc-unchanged",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {
            [fx.sessionId]: {
              headEntryUuid: "entry-3",
              messageCount: 3,
              sentAsType: "full",
              sentAsSessionId: fx.sessionId,
            },
          },
        },
      });

      expect(result.success).toBe(true);
      const manifest = readManifest((result as { exportPath: string }).exportPath);
      expect(manifest.sessions.length).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
