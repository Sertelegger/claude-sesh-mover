import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import { encodeProjectPath } from "../src/platform.js";

describe("migrator", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;
  let homeOverride: HomeOverrideHandle;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-migrator-test-"));
    homeOverride = overrideHome(tempDir);
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    homeOverride.restore();
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

    it("blocks self-migration by default, and --force overrides the block", async () => {
      // The proof behind the block's own suggestion. It ends "Override
      // (unsafe): pass --force …", which is a claim that the block returns
      // BEFORE export, import and cleanup — so the same invocation plus the
      // flag still has a migration left to perform. Unsafe is a separate
      // matter from reachable; this test is about reachable.
      const { migrateSession } = await import("../src/migrator.js");
      const sourceProjectPath = "/Users/testuser/Projects/testproject";
      const sourceEncoded = encodeProjectPath(sourceProjectPath);
      const sourceJsonl = join(configDir, "projects", sourceEncoded, `${sessionId}.jsonl`);
      const opts = {
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath,
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "current" as const,
        sessionId,
        excludeLayers: [],
        claudeVersion: "2.1.81",
        currentCwd: join(sourceProjectPath, "src"),
      };

      const blocked = await migrateSession(opts);
      expect(blocked.success).toBe(false);
      if (blocked.success) return;
      expect(blocked.error).toMatch(/Refusing self-migration/);
      expect(blocked.suggestion ?? "").toContain("--force");
      // Nothing has run: migrate is export + import + cleanup, and the source
      // session is exactly what cleanup would have deleted.
      expect(existsSync(sourceJsonl)).toBe(true);

      const forced = await migrateSession({ ...opts, force: true });
      expect(forced.success).toBe(true);
      if (!forced.success) return;
      expect(forced.importedSessions).toHaveLength(1);
      expect(forced.cleanedUp).toBe(true);
      expect(
        forced.warnings.some((w) => w.includes("Self-migration detected"))
      ).toBe(true);
      // The migration really happened: source gone, target holds the session.
      expect(existsSync(sourceJsonl)).toBe(false);
      const targetEncoded = encodeProjectPath("/Users/testuser/Projects/newproject");
      expect(
        existsSync(
          join(
            configDir,
            "projects",
            targetEncoded,
            `${forced.importedSessions[0].newId}.jsonl`
          )
        )
      ).toBe(true);
    });

    it("requires --session-id for scope current, and migrates once it is supplied", async () => {
      // Argument validation, raised before any read or write — so the remedy
      // the message names ("Pass --session-id <id> …, or --scope all") runs the
      // same invocation from the top.
      const { migrateSession } = await import("../src/migrator.js");
      const sourceProjectPath = "/Users/testuser/Projects/testproject";
      const sourceEncoded = encodeProjectPath(sourceProjectPath);
      const sourceJsonl = join(configDir, "projects", sourceEncoded, `${sessionId}.jsonl`);
      const opts = {
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath,
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "current" as const,
        excludeLayers: [],
        claudeVersion: "2.1.81",
        currentCwd: "/Users/testuser", // outer dir — not a self-migration
      };

      const refused = await migrateSession(opts);
      expect(refused.success).toBe(false);
      if (refused.success) return;
      expect(refused.error).toContain(
        "Migrate with --scope current requires --session-id"
      );
      expect(refused.suggestion ?? "").toContain("--session-id");
      expect(refused.suggestion ?? "").toContain("--scope all");
      expect(existsSync(sourceJsonl)).toBe(true);

      const migrated = await migrateSession({ ...opts, sessionId });
      expect(migrated.success).toBe(true);
      if (!migrated.success) return;
      expect(migrated.importedSessions).toHaveLength(1);
      expect(migrated.importedSessions[0].originalId).toBe(sessionId);
      expect(existsSync(sourceJsonl)).toBe(false);
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

    it("refuses scope=current without a sessionId instead of migrating everything", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "current",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        currentCwd: "/Users/testuser",
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/session-id/i);
      expect(result.suggestion ?? "").toMatch(/--scope all/);
      // Source untouched
      const sourceEncoded = "-Users-testuser-Projects-testproject";
      expect(
        existsSync(join(configDir, "projects", sourceEncoded, `${sessionId}.jsonl`))
      ).toBe(true);
    });

    it("cleanup removes only sessions that were actually imported (scope=all)", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      // Add a second, corrupt session to the source project: export will skip
      // it (unparseable), so cleanup must leave it in place.
      const sourceEncoded = "-Users-testuser-Projects-testproject";
      const strayPath = join(
        configDir, "projects", sourceEncoded, "not-a-session.jsonl"
      );
      writeFileSync(strayPath, "this is not json\n");

      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "all",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        currentCwd: "/Users/testuser",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      // The good session moved and was cleaned up…
      expect(
        existsSync(join(configDir, "projects", sourceEncoded, `${sessionId}.jsonl`))
      ).toBe(false);
      // …but the stray file the import never touched must survive.
      expect(existsSync(strayPath)).toBe(true);
    });

  });

  // The dry-run preview used to hardcode `directoryRenamed: false` and emit no
  // rename warning, so a preview WITH --rename-dir was indistinguishable from
  // one without it — the plan's most destructive step (an `mv` of the user's
  // project directory) was missing from the screen the user confirms against.
  // These tests pin the preview to the same preconditions the apply path uses.
  describe("migrateSession dry-run --rename-dir preview", () => {
    /** A real on-disk project dir plus a session registered for it. */
    function seedRealProject(name: string): {
      projectPath: string;
      seededSessionId: string;
    } {
      const projectPath = join(tempDir, name);
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(join(projectPath, "marker.txt"), "project payload\n");

      const seededSessionId = "11111111-2222-3333-4444-555555555555";
      const encoded = encodeProjectPath(projectPath);
      const projectDir = join(configDir, "projects", encoded);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, `${seededSessionId}.jsonl`),
        JSON.stringify({
          uuid: "seed-1",
          timestamp: "2026-04-14T10:00:00Z",
          sessionId: seededSessionId,
          cwd: projectPath,
          version: "2.1.81",
          slug: "seeded-session",
          type: "user",
          message: { role: "user", content: "seeded" },
        }) + "\n"
      );
      return { projectPath, seededSessionId };
    }

    function baseOpts(source: string, target: string, id: string) {
      return {
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: source,
        targetProjectPath: target,
        scope: "current" as const,
        sessionId: id,
        excludeLayers: [],
        claudeVersion: "2.1.81",
        currentCwd: tempDir,
      };
    }

    /** Nothing the preview promises not to touch may have changed. */
    function expectUntouched(source: string, sourceSessionId: string) {
      expect(existsSync(source)).toBe(true);
      expect(existsSync(join(source, "marker.txt"))).toBe(true);
      expect(
        existsSync(
          join(
            configDir,
            "projects",
            encodeProjectPath(source),
            `${sourceSessionId}.jsonl`
          )
        )
      ).toBe(true);
    }

    it("dry-run with renameDir reports the planned directory rename", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const { projectPath, seededSessionId } = seedRealProject("rename-src");
      const target = join(tempDir, "rename-dst");

      const result = await migrateSession({
        ...baseOpts(projectPath, target, seededSessionId),
        dryRun: true,
        renameDir: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.dryRun).toBe(true);
      // The preview must say the mv is part of the plan.
      expect(result.directoryRenamed).toBe(true);
      expect(
        result.warnings.some(
          (w) => w.includes("would be renamed") && w.includes(target)
        )
      ).toBe(true);
      // …and must not have performed any part of it.
      expectUntouched(projectPath, seededSessionId);
      expect(existsSync(target)).toBe(false);
    });

    it("dry-run without renameDir reports no directory rename", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const { projectPath, seededSessionId } = seedRealProject("norename-src");
      const target = join(tempDir, "norename-dst");

      const result = await migrateSession({
        ...baseOpts(projectPath, target, seededSessionId),
        dryRun: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.directoryRenamed).toBe(false);
      expect(result.warnings.every((w) => !w.includes("renamed"))).toBe(true);
      expectUntouched(projectPath, seededSessionId);
      expect(existsSync(target)).toBe(false);
    });

    it("dry-run with renameDir reports the skip when the target directory already exists", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const { projectPath, seededSessionId } = seedRealProject("collide-src");
      const target = join(tempDir, "collide-dst");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "occupant.txt"), "already here\n");

      const result = await migrateSession({
        ...baseOpts(projectPath, target, seededSessionId),
        dryRun: true,
        renameDir: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      // Same conditional the apply path takes: target exists => no rename.
      expect(result.directoryRenamed).toBe(false);
      expect(
        result.warnings.some(
          (w) => w.includes("already exists") && w.includes("skipped")
        )
      ).toBe(true);
      expectUntouched(projectPath, seededSessionId);
      expect(existsSync(join(target, "occupant.txt"))).toBe(true);
    });

    it("dry-run with renameDir reports the skip when the source directory does not exist", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const result = await migrateSession({
        ...baseOpts(
          "/Users/testuser/Projects/testproject",
          "/Users/testuser/Projects/newproject",
          sessionId
        ),
        dryRun: true,
        renameDir: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.directoryRenamed).toBe(false);
      expect(
        result.warnings.some((w) => w.includes("does not exist"))
      ).toBe(true);
    });

    it("dry-run with renameDir explains that identical paths leave nothing to rename", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const { projectPath, seededSessionId } = seedRealProject("same-src");
      const otherConfig = join(tempDir, "other-claude-same");
      mkdirSync(join(otherConfig, "projects"), { recursive: true });

      const result = await migrateSession({
        ...baseOpts(projectPath, projectPath, seededSessionId),
        targetConfigDir: otherConfig,
        dryRun: true,
        renameDir: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.directoryRenamed).toBe(false);
      expect(
        result.warnings.some((w) => w.includes("identical"))
      ).toBe(true);
      expectUntouched(projectPath, seededSessionId);
    });

    it("the dry-run rename prediction matches what the real run then does", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const { projectPath, seededSessionId } = seedRealProject("parity-src");
      const target = join(tempDir, "parity-dst");

      const preview = await migrateSession({
        ...baseOpts(projectPath, target, seededSessionId),
        dryRun: true,
        renameDir: true,
      });
      expect(preview.success).toBe(true);
      if (!preview.success) return;

      const real = await migrateSession({
        ...baseOpts(projectPath, target, seededSessionId),
        renameDir: true,
      });
      expect(real.success).toBe(true);
      if (!real.success) return;

      expect(real.directoryRenamed).toBe(preview.directoryRenamed);
      expect(real.directoryRenamed).toBe(true);
      expect(real.cleanedUp).toBe(preview.cleanedUp);
      // Real runs carry no dryRun marker.
      expect(real.dryRun).toBeUndefined();
      // And the mv really happened.
      expect(existsSync(projectPath)).toBe(false);
      expect(existsSync(join(target, "marker.txt"))).toBe(true);
    });

    it("an excluded layer is destroyed rather than left behind (migrate is not export)", async () => {
      // Cleanup deletes the whole session subdirectory and file-history dir for
      // every moved session, whatever the export carried — so `--exclude` on a
      // migrate is permanent loss, not "leave it at the source". Pinned here
      // because commands/migrate.md now warns the user about exactly this.
      const { migrateSession } = await import("../src/migrator.js");
      const srcEncoded = "-Users-testuser-Projects-testproject";
      const tgtEncoded = "-Users-testuser-Projects-newproject";

      expect(existsSync(join(configDir, "file-history", sessionId))).toBe(true);

      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "current",
        sessionId,
        excludeLayers: ["file-history", "subagents", "tool-results"],
        claudeVersion: "2.1.81",
        currentCwd: "/Users/testuser",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      const newId = result.importedSessions[0].newId;

      // Gone from the source…
      expect(existsSync(join(configDir, "file-history", sessionId))).toBe(false);
      expect(
        existsSync(join(configDir, "projects", srcEncoded, sessionId))
      ).toBe(false);
      // …and never written to the target.
      expect(existsSync(join(configDir, "file-history", newId))).toBe(false);
      expect(
        existsSync(join(configDir, "projects", tgtEncoded, newId))
      ).toBe(false);

      // And the user is TOLD. The exporter's "<layer> excluded by user request"
      // warnings were being dropped on the floor — migrate returned only the
      // IMPORT's warnings — so the one message that discloses a destructive
      // exclusion never reached anyone.
      const w = result.warnings.join(" ");
      for (const layer of ["file-history", "subagents", "tool-results"]) {
        expect(w).toContain(`${layer} excluded by user request`);
      }
    });

    it("a dry run discloses the same exclusions, before anything is deleted", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "current",
        sessionId,
        excludeLayers: ["file-history"],
        dryRun: true,
        claudeVersion: "2.1.81",
        currentCwd: "/Users/testuser",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.warnings.join(" ")).toContain("file-history excluded by user request");
      // Still a preview: the source layer is untouched.
      expect(existsSync(join(configDir, "file-history", sessionId))).toBe(true);
    });
  });

  /**
   * #59 item 3 — the shared-layer reconciliation reaches the MIGRATE result as
   * typed fields, not only as warning prose.
   *
   * A migrate IS an import (export + import + cleanup), so it touches the same
   * two directories the target already owns. Until this, only the importer's
   * `warnings` were forwarded, so `commands/migrate.md` could relay a sentence
   * about a parked memory and had no `parkedAs` to act on — and the intermediate
   * bundle is a temp dir the migrate deletes, which makes the parked file the
   * only copy of the incoming text on the machine.
   */
  describe("migrateSession — the shared layers as typed result fields", () => {
    const TARGET = "/Users/testuser/Projects/newproject";
    const targetMemDir = () =>
      join(configDir, "projects", encodeProjectPath(TARGET), "memory");

    function seedTargetMemory(): void {
      mkdirSync(targetMemDir(), { recursive: true });
      writeFileSync(
        join(targetMemDir(), "MEMORY.md"),
        "- [Test memory](test_memory.md) — my version\n"
      );
      writeFileSync(
        join(targetMemDir(), "test_memory.md"),
        "---\nname: Test memory\n---\n\nMine, not theirs.\n"
      );
    }

    function opts(over: Record<string, unknown> = {}) {
      return {
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: TARGET,
        scope: "current" as const,
        sessionId,
        excludeLayers: [],
        claudeVersion: "2.1.81",
        currentCwd: "/Users/testuser",
        ...over,
      };
    }

    it("a migrate that parks a memory file exposes parkedAs and memoryDir", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      seedTargetMemory();

      const result = await migrateSession(opts());
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.memoryDir).toBe(targetMemDir());
      expect(result.memoryConflicts).toHaveLength(1);
      const conflict = result.memoryConflicts![0];
      expect(conflict.filename).toBe("test_memory.md");
      expect(conflict.parkedAs).toBe("test_memory.incoming.md");
      expect(conflict.existingHash).not.toBe(conflict.incomingHash);
      expect(result.memoryIndex).toBeDefined();

      // The fields describe files that are really there, and the target's own
      // memory was not overwritten.
      const read = (n: string) => readFileSync(join(targetMemDir(), n), "utf-8");
      expect(read("test_memory.md")).toContain("Mine, not theirs.");
      expect(read("test_memory.incoming.md")).toContain("Use vitest for testing.");
      expect(read("MEMORY.md")).toContain("(test_memory.incoming.md)");
    });

    it("nothing to reconcile is reported by omission, not with an empty array", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      // No seeded target memory: the layer arrives clean, so there is no
      // conflict — but it DID arrive, which `memoryDir` is what says.
      const result = await migrateSession(opts());
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.memoryConflicts).toBeUndefined();
      expect(result.planConflicts).toBeUndefined();
      expect(result.memoryDir).toBe(targetMemDir());
      expect(
        readFileSync(join(targetMemDir(), "test_memory.md"), "utf-8")
      ).toContain("Use vitest for testing.");
    });

    it("the dry run previews the memory plan the real run executes, and writes nothing", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      seedTargetMemory();

      const preview = await migrateSession(opts({ dryRun: true }));
      expect(preview.success).toBe(true);
      if (!preview.success) return;
      expect(preview.dryRun).toBe(true);
      expect(preview.memoryDir).toBe(targetMemDir());
      const parked = preview.memoryPlan?.find((e) => e.filename === "test_memory.md");
      expect(parked).toBeDefined();
      expect(parked!.verdict).toBe("park");
      expect(parked!.parkedAs).toBe("test_memory.incoming.md");
      // A preview writes nothing, and reports no conflict either: nothing was
      // parked, so there is no `parkedAs` on disk to act on yet.
      expect(preview.memoryConflicts).toBeUndefined();
      expect(existsSync(join(targetMemDir(), "test_memory.incoming.md"))).toBe(false);
      expect(
        readFileSync(join(targetMemDir(), "MEMORY.md"), "utf-8")
      ).not.toContain("incoming");
    });
  });
});
