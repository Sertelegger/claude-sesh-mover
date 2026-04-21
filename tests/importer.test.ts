import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import type { ExportResult, ImportResult, DryRunResult } from "../src/types.js";

describe("importer", () => {
  let tempDir: string;
  let sourceConfigDir: string;
  let targetConfigDir: string;
  let sessionId: string;
  let exportPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-importer-test-"));

    // Create source fixture and export it
    const fixture = createFixtureTree(tempDir);
    sourceConfigDir = fixture.configDir;
    sessionId = fixture.sessionId;

    const { exportSession } = await import("../src/exporter.js");
    const exportDir = join(tempDir, "exports");
    const result = await exportSession({
      configDir: sourceConfigDir,
      projectPath: "/Users/testuser/Projects/testproject",
      sessionId,
      outputDir: exportDir,
      name: "test-export",
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });

    if (!result.success) throw new Error("Export failed in test setup");
    exportPath = (result as ExportResult).exportPath;

    // Create empty target config dir
    targetConfigDir = join(tempDir, "target-claude");
    mkdirSync(join(targetConfigDir, "projects"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("importSession", () => {
    it("imports a session to a new project path", async () => {
      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.importedSessions).toHaveLength(1);
      expect(result.importedSessions[0].originalId).toBe(sessionId);
      expect(result.importedSessions[0].newId).not.toBe(sessionId);

      // Verify files exist in target
      const encoded = "-Users-newuser-Projects-newproject";
      const newId = result.importedSessions[0].newId;
      expect(
        existsSync(
          join(targetConfigDir, "projects", encoded, `${newId}.jsonl`)
        )
      ).toBe(true);

      // Verify path rewriting
      const jsonl = readFileSync(
        join(targetConfigDir, "projects", encoded, `${newId}.jsonl`),
        "utf-8"
      );
      expect(jsonl).toContain("/Users/newuser/Projects/newproject");
      expect(jsonl).not.toContain("/Users/testuser/Projects/testproject");
    });

    it("dry-run returns report without writing", async () => {
      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect((result as DryRunResult).dryRun).toBe(true);
      // Verify nothing was written
      const encoded = "-Users-newuser-Projects-newproject";
      expect(
        existsSync(join(targetConfigDir, "projects", encoded))
      ).toBe(false);
    });

    it("imports specific sessions from multi-session export", async () => {
      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
        sessionIds: [sessionId],
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.importedSessions).toHaveLength(1);
    });

    it("merges memory files without overwriting existing", async () => {
      const { importSession } = await import("../src/importer.js");
      const { writeFileSync } = await import("node:fs");

      // Create pre-existing memory in target
      const encoded = "-Users-newuser-Projects-newproject";
      const targetMemDir = join(
        targetConfigDir,
        "projects",
        encoded,
        "memory"
      );
      mkdirSync(targetMemDir, { recursive: true });
      writeFileSync(
        join(targetMemDir, "existing.md"),
        "---\nname: existing\n---\nExisting memory\n"
      );

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(true);
      // Both existing and imported memory files should be present
      expect(existsSync(join(targetMemDir, "existing.md"))).toBe(true);
      expect(existsSync(join(targetMemDir, "MEMORY.md"))).toBe(true);
    });

    it("verifies integrity hash on import", async () => {
      const { importSession } = await import("../src/importer.js");
      // Corrupt the JSONL file in the export
      const { writeFileSync } = await import("node:fs");
      const jsonlPath = join(
        exportPath,
        "sessions",
        `${sessionId}.jsonl`
      );
      writeFileSync(jsonlPath, "corrupted data\n");

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.warnings.some((w) => w.includes("integrity"))).toBe(true);
    });
  });

  it("records lineage and peer state when importing an incremental bundle", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { importSession } = await import("../src/importer.js");
    const { readSyncState } = await import("../src/sync-state.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-import-inc-"));
    const tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-import-inc-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const fx = createFixtureTree(tempDir);
      const outputDir = join(tempDir, "exports");
      mkdirSync(outputDir, { recursive: true });

      const exportResult = await exportAllSessions({
        configDir: fx.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "inc-import-test",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {},
        },
      });
      expect(exportResult.success).toBe(true);

      const targetConfig = join(tempDir, "target-config");
      mkdirSync(targetConfig, { recursive: true });
      const importResult = await importSession({
        exportPath: (exportResult as { exportPath: string }).exportPath,
        targetConfigDir: targetConfig,
        targetProjectPath: "/Users/target/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(importResult.success).toBe(true);

      const state = readSyncState("/Users/target/Projects/testproject");
      expect(state.peers["machine-A"]).toBeDefined();
      expect(state.peers["machine-A"].name).toBe("A");
      expect(Object.keys(state.peers["machine-A"].received).length).toBe(1);
      expect(Object.keys(state.lineage).length).toBe(1);
      const [newLocalId] = Object.keys(state.lineage);
      expect(state.lineage[newLocalId].sourceMachineId).toBe("machine-A");
      expect(state.lineage[newLocalId].type).toBe("full");

      expect(Object.keys(state.peers["machine-A"].sent).length).toBe(1);
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("skips an already-received full session on second import (idempotent)", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { importSession } = await import("../src/importer.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-import-idem-"));
    const tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-import-idem-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const fx = createFixtureTree(tempDir);
      const outputDir = join(tempDir, "exports");
      mkdirSync(outputDir, { recursive: true });

      const exportResult = await exportAllSessions({
        configDir: fx.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "inc-idem",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {},
        },
      });
      expect(exportResult.success).toBe(true);

      const targetConfig = join(tempDir, "target-config");
      mkdirSync(targetConfig, { recursive: true });

      const first = await importSession({
        exportPath: (exportResult as { exportPath: string }).exportPath,
        targetConfigDir: targetConfig,
        targetProjectPath: "/Users/target/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(first.success).toBe(true);

      const second = await importSession({
        exportPath: (exportResult as { exportPath: string }).exportPath,
        targetConfigDir: targetConfig,
        targetProjectPath: "/Users/target/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(second.success).toBe(true);
      expect(
        (second as { warnings: string[] }).warnings.some((w) =>
          /already received/i.test(w)
        )
      ).toBe(true);
      expect((second as { importedSessions: unknown[] }).importedSessions.length).toBe(0);
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
