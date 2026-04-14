import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

describe("migrator", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-migrator-test-"));
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("migrateSession", () => {
    it("moves a session to a new project path on same config dir", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "current",
        sessionId,
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.cleanedUp).toBe(true);

      // Source should be cleaned up
      const sourceEncoded = "-Users-testuser-Projects-testproject";
      expect(
        existsSync(
          join(configDir, "projects", sourceEncoded, `${sessionId}.jsonl`)
        )
      ).toBe(false);

      // Target should exist
      const targetEncoded = "-Users-testuser-Projects-newproject";
      const newId = result.importedSessions[0].newId;
      expect(
        existsSync(
          join(configDir, "projects", targetEncoded, `${newId}.jsonl`)
        )
      ).toBe(true);
    });

    it("renames the project directory when renameDir is true", async () => {
      const { migrateSession } = await import("../src/migrator.js");

      // The fixture sessions are for "/Users/testuser/Projects/testproject"
      // which doesn't exist on disk, so rename will warn but not fail.
      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "current",
        sessionId,
        excludeLayers: [],
        claudeVersion: "2.1.81",
        renameDir: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Directory doesn't exist on disk, so rename is skipped with a warning
      expect(result.directoryRenamed).toBe(false);
      expect(result.warnings.some(w => w.includes("does not exist"))).toBe(true);
    });

    it("does not rename directory when renameDir is false", async () => {
      const { migrateSession } = await import("../src/migrator.js");

      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "current",
        sessionId,
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.directoryRenamed).toBe(false);
      // No rename warning since we didn't ask for it
      expect(result.warnings.every(w => !w.includes("does not exist"))).toBe(true);
    });

    it("migrates between config directories", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const targetConfig = join(tempDir, "other-claude");
      mkdirSync(join(targetConfig, "projects"), { recursive: true });

      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: targetConfig,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/testproject",
        scope: "current",
        sessionId,
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.cleanedUp).toBe(true);
    });
  });
});
