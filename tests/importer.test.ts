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
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-importer-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

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
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
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

    it("refuses a bundle whose manifest sessionId escapes the bundle (no file read outside)", async () => {
      const { importSession } = await import("../src/importer.js");
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } =
        await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const root = mkdtempSync(join(tmpdir(), "sesh-mover-exfil-"));
      try {
        // A secret two levels above the bundle's sessions/ dir.
        mkdirSync(join(root, "secret"), { recursive: true });
        writeFileSync(join(root, "secret", "pwned.jsonl"), "TOP_SECRET_MARKER\n");
        const bundle = join(root, "bundle");
        mkdirSync(join(bundle, "sessions"), { recursive: true });
        writeFileSync(
          join(bundle, "manifest.json"),
          JSON.stringify({
            version: 1,
            plugin: "sesh-mover",
            exportedAt: "2026-07-14T00:00:00Z",
            sourcePlatform: "linux",
            sourceProjectPath: "/p",
            sourceConfigDir: "/c",
            sourceClaudeVersion: "2.1.114",
            sessionScope: "current",
            includedLayers: ["jsonl"],
            sessions: [
              {
                sessionId: "../../secret/pwned",
                slug: "evil",
                summary: "",
                createdAt: "",
                lastActiveAt: "",
                messageCount: 1,
                gitBranch: "",
                entrypoint: "cli",
                integrityHash: "sha256:x",
              },
            ],
          })
        );
        const targetConfig = join(root, "target");
        mkdirSync(join(targetConfig, "projects"), { recursive: true });

        const result = await importSession({
          exportPath: bundle,
          targetConfigDir: targetConfig,
          targetProjectPath: "/home/victim/proj",
          targetClaudeVersion: "2.1.114",
          dryRun: false,
          noRegister: true,
        });

        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toMatch(/unsafe session id|manifest/i);
        // Nothing written; the secret never reached the target store.
        const projDir = join(targetConfig, "projects", "-home-victim-proj");
        const leaked =
          existsSync(projDir) &&
          readdirSync(projDir).some((f) =>
            f.endsWith(".jsonl") &&
            require("node:fs").readFileSync(join(projDir, f), "utf-8").includes("TOP_SECRET_MARKER")
          );
        expect(leaked).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
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
      expect(state.lineage[newLocalId].postRewriteHash).toMatch(/^sha256:/);

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

  it("re-imports an incremental bundle when the received session's JSONL file is gone even though a peer record exists", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { importSession } = await import("../src/importer.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-import-idem-heal-"));
    const tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-import-idem-heal-home-"));
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
        name: "inc-idem-heal",
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
      if (!first.success) return;
      const firstNewId = (first as ImportResult).importedSessions[0].newId;

      // Delete the previously-imported JSONL: the sync-state peer record
      // still references it, but the file itself is gone.
      const encoded = "-Users-target-Projects-testproject";
      const priorJsonl = join(targetConfig, "projects", encoded, `${firstNewId}.jsonl`);
      expect(existsSync(priorJsonl)).toBe(true);
      rmSync(priorJsonl);

      const second = await importSession({
        exportPath: (exportResult as { exportPath: string }).exportPath,
        targetConfigDir: targetConfig,
        targetProjectPath: "/Users/target/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect((second as ImportResult).importedSessions).toHaveLength(1);
      expect((second as ImportResult).skippedSessions).toHaveLength(0);
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("skips re-import of an identical non-incremental bundle and reports skippedSessions", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    };
    const first = await importSession(opts);
    expect(first.success).toBe(true);

    const second = await importSession(opts);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.importedSessions).toHaveLength(0);
    expect((second as any).skippedSessions).toEqual([
      { originalId: sessionId, reason: "duplicate" },
    ]);
    expect(second.warnings.some((w) => /already imported/i.test(w))).toBe(true);
  });

  it("a registered import proceeds over a prior --no-register copy", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    };
    const first = await importSession({ ...opts, noRegister: true });
    expect(first.success).toBe(true);

    const second = await importSession(opts); // registered run
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.importedSessions).toHaveLength(1);
    expect(second.resumable).toBe(true);
    expect(second.warnings.some((w) => /unregistered/i.test(w))).toBe(true);

    const third = await importSession(opts); // now a registered copy exists
    expect(third.success).toBe(true);
    if (!third.success) return;
    expect(third.importedSessions).toHaveLength(0);
    expect((third as any).skippedSessions[0].reason).toBe("duplicate");
  });

  it("a --no-register re-import of an unregistered copy is still skipped", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
      noRegister: true,
    };
    await importSession(opts);
    const second = await importSession(opts);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.importedSessions).toHaveLength(0);
  });

  it("--allow-duplicates re-imports an already-present bundle", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    };
    await importSession(opts);
    const second = await importSession({ ...opts, allowDuplicates: true });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.importedSessions).toHaveLength(1);
  });

  it("re-imports when the registry hash record exists but the prior JSONL file is gone", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    };
    const first = await importSession(opts);
    expect(first.success).toBe(true);
    if (!first.success) return;
    const firstNewId = (first as ImportResult).importedSessions[0].newId;

    // Simulate data loss: the previously-imported JSONL file disappeared
    // (e.g. a migrate deleted it), but the registry record still points at it.
    const encoded = "-Users-newuser-Projects-newproject";
    const priorJsonl = join(targetConfigDir, "projects", encoded, `${firstNewId}.jsonl`);
    expect(existsSync(priorJsonl)).toBe(true);
    rmSync(priorJsonl);

    const second = await importSession(opts);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect((second as ImportResult).importedSessions).toHaveLength(1);
    expect((second as ImportResult).skippedSessions).toHaveLength(0);
  });

  it("dry-run of a fully-duplicate bundle still reports dryRun: true", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    };
    const first = await importSession(opts);
    expect(first.success).toBe(true);

    const secondDryRun = await importSession({ ...opts, dryRun: true });
    expect(secondDryRun.success).toBe(true);
    if (!secondDryRun.success) return;
    expect((secondDryRun as DryRunResult).dryRun).toBe(true);
    expect((secondDryRun as DryRunResult).importedSessions).toHaveLength(0);
    expect((secondDryRun as DryRunResult).skippedSessions).toHaveLength(1);
  });

  it("migrate cleans up source sessions that were skipped as duplicates at target", async () => {
    const { migrateSession } = await import("../src/migrator.js");
    const { importSession } = await import("../src/importer.js");
    // Pre-import the bundle to the migrate target so the migrate's own
    // import skips everything as duplicate…
    const pre = await importSession({
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    });
    expect(pre.success).toBe(true);

    const result = await migrateSession({
      sourceConfigDir,
      targetConfigDir,
      sourceProjectPath: "/Users/testuser/Projects/testproject",
      targetProjectPath: "/Users/newuser/Projects/newproject",
      scope: "current",
      sessionId,
      excludeLayers: [],
      claudeVersion: "2.1.81",
      currentCwd: "/Users/testuser",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // …but the source is still cleaned up: identical content already lives
    // at the target, so migrate semantics are satisfied.
    expect(
      existsSync(
        join(sourceConfigDir, "projects", "-Users-testuser-Projects-testproject", `${sessionId}.jsonl`)
      )
    ).toBe(false);
    // Verify skippedSessions are surfaced on MigrateResult
    expect((result as any).skippedSessions).toEqual([
      { originalId: sessionId, reason: "duplicate" },
    ]);
  });
});
