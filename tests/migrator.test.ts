import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
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

    it("emits a self-migration warning when currentCwd equals the source path", async () => {
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
        dryRun: true,
        currentCwd: "/Users/testuser/Projects/testproject",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        result.warnings.some((w) => w.includes("Self-migration detected"))
      ).toBe(true);
    });

    it("emits a self-migration warning when currentCwd is inside the source path", async () => {
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
        dryRun: true,
        currentCwd: "/Users/testuser/Projects/testproject/src",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        result.warnings.some((w) => w.includes("Self-migration detected"))
      ).toBe(true);
    });

    it("does not emit a self-migration warning when currentCwd is outside the source path", async () => {
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
        dryRun: true,
        currentCwd: "/Users/testuser",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        result.warnings.every((w) => !w.includes("Self-migration detected"))
      ).toBe(true);
    });

    it("does not emit a self-migration warning when currentCwd has a prefix match but is a sibling", async () => {
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
        dryRun: true,
        currentCwd: "/Users/testuser/Projects/testproject-sibling",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        result.warnings.every((w) => !w.includes("Self-migration detected"))
      ).toBe(true);
    });

    it("refuses to run an actual self-migration without --force", async () => {
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
        currentCwd: "/Users/testuser/Projects/testproject",
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.command).toBe("migrate");
      expect(result.error).toMatch(/self-migration/i);
      // Source files must NOT have been touched
      const sourceEncoded = "-Users-testuser-Projects-testproject";
      expect(
        existsSync(
          join(configDir, "projects", sourceEncoded, `${sessionId}.jsonl`)
        )
      ).toBe(true);
      // Suggestion should mention the recovery path (exit + outer dir)
      expect(result.suggestion ?? "").toMatch(/outer|exit|cd/i);
    });

    it("refuses self-migration for scope=all without --force", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "all",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        currentCwd: "/Users/testuser/Projects/testproject/src",
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/self-migration/i);
    });

    it("allows self-migration with force=true and still emits a warning", async () => {
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
        currentCwd: "/Users/testuser/Projects/testproject",
        force: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        result.warnings.some((w) => w.includes("Self-migration detected"))
      ).toBe(true);
    });

    it("merges into a target project dir that already has sessions", async () => {
      // Orphan-recovery scenario: after a botched self-migration, the source
      // project dir still has one stray session and the target already holds
      // the successfully-migrated sessions. Running migrate from an outer dir
      // must merge the orphan in without disturbing the existing sessions.
      const { migrateSession } = await import("../src/migrator.js");

      // Pre-populate the target project dir with an unrelated session
      const targetEncoded = "-Users-testuser-Projects-newproject";
      const targetProjectDir = join(configDir, "projects", targetEncoded);
      mkdirSync(targetProjectDir, { recursive: true });
      const preExistingId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      writeFileSync(
        join(targetProjectDir, `${preExistingId}.jsonl`),
        JSON.stringify({
          uuid: "pre-1",
          timestamp: "2026-04-14T10:00:00Z",
          sessionId: preExistingId,
          cwd: "/Users/testuser/Projects/newproject",
          version: "2.1.81",
          type: "user",
          message: { role: "user", content: "pre-existing" },
        }) + "\n"
      );

      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "current",
        sessionId,
        excludeLayers: [],
        claudeVersion: "2.1.81",
        currentCwd: "/Users/testuser", // outer dir — not self-migration
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Pre-existing session must still be there
      expect(
        existsSync(join(targetProjectDir, `${preExistingId}.jsonl`))
      ).toBe(true);

      // New session was imported alongside it
      const jsonls = readdirSync(targetProjectDir).filter((f) =>
        f.endsWith(".jsonl")
      );
      expect(jsonls.length).toBe(2);
    });

    it("still allows dry-run self-migration without --force (preview only)", async () => {
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
        dryRun: true,
        currentCwd: "/Users/testuser/Projects/testproject",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        result.warnings.some((w) => w.includes("Self-migration detected"))
      ).toBe(true);
    });
  });
});
