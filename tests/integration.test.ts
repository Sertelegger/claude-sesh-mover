import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { overrideHome, setHome, type HomeOverrideHandle } from "./helpers/env.js";
import type { ExportResult, ImportResult } from "../src/types.js";

describe("integration: full export/import cycle", () => {
  let tempDir: string;
  let sourceConfigDir: string;
  let sessionId: string;
  let homeOverride: HomeOverrideHandle;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-integration-"));
    homeOverride = overrideHome(tempDir);
    const fixture = createFixtureTree(tempDir);
    sourceConfigDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    homeOverride.restore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exports, archives, extracts, and imports a session to a new path", async () => {
    const { exportSession } = await import("../src/exporter.js");
    const { createArchive, extractArchive } = await import(
      "../src/archiver.js"
    );
    const { importSession } = await import("../src/importer.js");

    // 1. Export
    const exportDir = join(tempDir, "exports");
    const exportResult = await exportSession({
      configDir: sourceConfigDir,
      projectPath: "/Users/testuser/Projects/testproject",
      sessionId,
      outputDir: exportDir,
      name: "integration-test",
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });
    expect(exportResult.success).toBe(true);
    const exportPath = (exportResult as ExportResult).exportPath;

    // 2. Archive
    const archivePath = join(tempDir, "integration-test.tar.gz");
    await createArchive(exportPath, archivePath, "gzip");
    expect(existsSync(archivePath)).toBe(true);

    // 3. Extract (simulating transfer to another machine)
    const extractDir = join(tempDir, "extracted");
    mkdirSync(extractDir);
    await extractArchive(archivePath, extractDir);
    expect(existsSync(join(extractDir, "manifest.json"))).toBe(true);

    // 4. Import to a new config dir and project path
    const targetConfigDir = join(tempDir, "target-claude");
    mkdirSync(join(targetConfigDir, "projects"), { recursive: true });

    const importResult = await importSession({
      exportPath: extractDir,
      targetConfigDir,
      targetProjectPath: "/home/devuser/projects/testproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    });
    expect(importResult.success).toBe(true);
    const imported = (importResult as ImportResult).importedSessions[0];
    expect(imported.originalId).toBe(sessionId);
    expect(imported.newId).not.toBe(sessionId);

    // 5. Verify rewritten content
    const targetEncoded = "-home-devuser-projects-testproject";
    const newJsonl = readFileSync(
      join(
        targetConfigDir,
        "projects",
        targetEncoded,
        `${imported.newId}.jsonl`
      ),
      "utf-8"
    );

    // Paths should be rewritten
    expect(newJsonl).toContain("/home/devuser/projects/testproject");
    expect(newJsonl).not.toContain("/Users/testuser/Projects/testproject");

    // Session ID should be rewritten
    expect(newJsonl).toContain(imported.newId);

    // Memory should be copied
    expect(
      existsSync(
        join(
          targetConfigDir,
          "projects",
          targetEncoded,
          "memory",
          "MEMORY.md"
        )
      )
    ).toBe(true);

    // File history should be under new session ID
    expect(
      existsSync(
        join(targetConfigDir, "file-history", imported.newId, "abc123@v1")
      )
    ).toBe(true);

    // History.jsonl should have the new entry
    const history = readFileSync(
      join(targetConfigDir, "history.jsonl"),
      "utf-8"
    );
    expect(history).toContain(imported.newId);
    expect(history).toContain("/home/devuser/projects/testproject");
  });

  it("imports with correct path rewriting when source and target paths differ significantly", async () => {
    const { exportSession } = await import("../src/exporter.js");
    const { importSession } = await import("../src/importer.js");

    // Export
    const exportDir = join(tempDir, "exports-rewrite");
    const exportResult = await exportSession({
      configDir: sourceConfigDir,
      projectPath: "/Users/testuser/Projects/testproject",
      sessionId,
      outputDir: exportDir,
      name: "rewrite-test",
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });
    expect(exportResult.success).toBe(true);

    // Import to a path that simulates WSL-like target
    const targetConfigDir = join(tempDir, "wsl-target-claude");
    mkdirSync(join(targetConfigDir, "projects"), { recursive: true });

    const importResult = await importSession({
      exportPath: (exportResult as ExportResult).exportPath,
      targetConfigDir,
      targetProjectPath: "/home/devuser/projects/testproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    });

    expect(importResult.success).toBe(true);
    const imported = (importResult as ImportResult).importedSessions[0];

    // Verify tool result paths were rewritten
    const targetEncoded = "-home-devuser-projects-testproject";
    const jsonl = readFileSync(
      join(targetConfigDir, "projects", targetEncoded, `${imported.newId}.jsonl`),
      "utf-8"
    );
    // Tool result stdout should be rewritten
    expect(jsonl).toContain("/home/devuser/projects/testproject");
    // Original paths should NOT be present in tool results
    expect(jsonl).not.toContain("/Users/testuser/Projects/testproject");
  });

  it("carries projectId through export → import and plants it at the target", async () => {
    const { exportSession } = await import("../src/exporter.js");
    const { importSession } = await import("../src/importer.js");
    const { encodeProjectPath } = await import("../src/platform.js");
    const { readManifest } = await import("../src/manifest.js");
    const { writeLocalProjectId, readLocalProjectId } = await import(
      "../src/hub/identity.js"
    );

    // Arrange like the neighboring round-trip tests, but with real
    // (writable) source/target project directories — unlike the
    // "/Users/testuser/..."-style literal paths used elsewhere, this test
    // needs an actual filesystem project directory to plant
    // .claude-sesh-mover/project.json into and read it back from.
    const carrySourceProjectPath = join(tempDir, "carry-source-project");
    mkdirSync(carrySourceProjectPath, { recursive: true });
    writeLocalProjectId(carrySourceProjectPath, {
      projectId: "prj-carry-1",
      name: "t",
      createdAt: "t",
      createdByMachine: "m",
    });

    const carrySessionId = "11111111-1111-1111-1111-111111111111";
    const carryConfigDir = join(tempDir, "carry-source-claude");
    const carryEncoded = encodeProjectPath(carrySourceProjectPath);
    const carryProjectDir = join(carryConfigDir, "projects", carryEncoded);
    mkdirSync(carryProjectDir, { recursive: true });
    writeFileSync(
      join(carryProjectDir, `${carrySessionId}.jsonl`),
      JSON.stringify({
        uuid: "entry-1",
        timestamp: "2026-04-10T12:00:00Z",
        sessionId: carrySessionId,
        cwd: carrySourceProjectPath,
        version: "2.1.81",
        gitBranch: "main",
        slug: "carry-test-session",
        type: "user",
        message: { role: "user", content: "hello" },
      }) + "\n"
    );

    // Act: export
    const carryExportDir = join(tempDir, "carry-export");
    const exportResult = await exportSession({
      configDir: carryConfigDir,
      projectPath: carrySourceProjectPath,
      sessionId: carrySessionId,
      outputDir: carryExportDir,
      name: "carry-test",
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });
    expect(exportResult.success).toBe(true);
    const carryExportPath = (exportResult as ExportResult).exportPath;

    // Assert: bundle manifest carries the source projectId
    const manifest = readManifest(carryExportPath);
    expect(manifest.projectId).toBe("prj-carry-1");

    // Act: import into a fresh target project dir
    const carryTargetProjectPath = join(tempDir, "carry-target-project");
    mkdirSync(carryTargetProjectPath, { recursive: true });
    const carryTargetConfigDir = join(tempDir, "carry-target-claude");
    mkdirSync(join(carryTargetConfigDir, "projects"), { recursive: true });

    const importResult = await importSession({
      exportPath: carryExportPath,
      targetConfigDir: carryTargetConfigDir,
      targetProjectPath: carryTargetProjectPath,
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    });
    expect(importResult.success).toBe(true);

    // Assert: the target project dir now has the planted project.json
    const planted = readLocalProjectId(carryTargetProjectPath);
    expect(planted?.projectId).toBe("prj-carry-1");
  });

  it("migrates a session to a new path and cleans up source", async () => {
    const { migrateSession } = await import("../src/migrator.js");

    const result = await migrateSession({
      sourceConfigDir,
      targetConfigDir: sourceConfigDir,
      sourceProjectPath: "/Users/testuser/Projects/testproject",
      targetProjectPath: "/Users/testuser/Projects/newlocation",
      scope: "current",
      sessionId,
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Source cleaned up
    expect(
      existsSync(
        join(
          sourceConfigDir,
          "projects",
          "-Users-testuser-Projects-testproject",
          `${sessionId}.jsonl`
        )
      )
    ).toBe(false);

    // Target exists
    const targetEncoded = "-Users-testuser-Projects-newlocation";
    const newId = result.importedSessions[0].newId;
    expect(
      existsSync(
        join(
          sourceConfigDir,
          "projects",
          targetEncoded,
          `${newId}.jsonl`
        )
      )
    ).toBe(true);
  });

  it("round-trip: A full export → B import → B continues session → B incremental export → A import with continuation", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { importSession } = await import("../src/importer.js");
    const { readSyncState } = await import("../src/sync-state.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const homeA = mkdtempSync(join(tmpdir(), "rt-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "rt-homeB-"));

    const workspaceA = mkdtempSync(join(tmpdir(), "rt-wsA-"));
    const workspaceB = mkdtempSync(join(tmpdir(), "rt-wsB-"));

    // Capture the pre-test HOME/USERPROFILE once; subsequent switches between
    // homeA/homeB below use setHome() directly and don't need their own snapshot.
    const rtHomeOverride = overrideHome(homeA);

    try {
      // --- A: initial full (incremental-from-empty) export ---
      const fxA = createFixtureTree(workspaceA);
      const exportsA = join(workspaceA, "exports");
      mkdirSync(exportsA, { recursive: true });

      const { loadOrCreateMachineId: loadA } = await import("../src/machine.js");
      const machineA = loadA();

      const fullA = await exportAllSessions({
        configDir: fxA.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir: exportsA,
        name: "initial-full",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: machineA.id,
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {},
        },
      });
      expect(fullA.success).toBe(true);

      // --- B: import the full bundle ---
      setHome(homeB);
      const targetB = join(workspaceB, ".claude");
      mkdirSync(join(targetB, "projects"), { recursive: true });

      const bImport = await importSession({
        exportPath: (fullA as { exportPath: string }).exportPath,
        targetConfigDir: targetB,
        targetProjectPath: "/Users/b/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(bImport.success).toBe(true);

      // --- B: append 2 new entries to the imported session JSONL ---
      const imported = (bImport as { importedSessions: Array<{ newId: string }> }).importedSessions[0];
      const bJsonlPath = join(
        targetB,
        "projects",
        "-Users-b-Projects-testproject",
        `${imported.newId}.jsonl`
      );
      const bEntriesNew = [
        {
          uuid: "b-new-1",
          timestamp: "2026-04-21T09:00:00Z",
          sessionId: imported.newId,
          cwd: "/Users/b/Projects/testproject",
          version: "2.1.114",
          type: "user",
          message: { role: "user", content: "extend on B" },
        },
        {
          uuid: "b-new-2",
          timestamp: "2026-04-21T09:00:05Z",
          sessionId: imported.newId,
          cwd: "/Users/b/Projects/testproject",
          version: "2.1.114",
          type: "assistant",
          message: { model: "x", id: "m", content: [{ type: "text", text: "ok" }] },
        },
      ];
      appendFileSync(
        bJsonlPath,
        bEntriesNew.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf-8"
      );

      // --- B: incremental export back to A ---
      const exportsB = join(workspaceB, "exports");
      mkdirSync(exportsB, { recursive: true });

      const stateB2 = readSyncState("/Users/b/Projects/testproject");
      const sentToA = stateB2.peers[machineA.id]?.sent ?? {};

      const { loadOrCreateMachineId: loadB } = await import("../src/machine.js");
      const machineB = loadB();

      const incB = await exportAllSessions({
        configDir: targetB,
        projectPath: "/Users/b/Projects/testproject",
        outputDir: exportsB,
        name: "incremental-b-to-a",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: machineB.id,
          sourceMachineName: "B",
          targetMachineId: machineA.id,
          targetMachineName: "A",
          peerSent: sentToA,
        },
      });
      expect(incB.success).toBe(true);
      const incManifest = JSON.parse(
        readFileSync(
          join((incB as { exportPath: string }).exportPath, "manifest.json"),
          "utf-8"
        )
      );
      const continuations = incManifest.sessions.filter(
        (s: { type: string }) => s.type === "continuation"
      );
      expect(continuations.length).toBe(1);

      // --- A: import the incremental bundle ---
      setHome(homeA);
      const aImport = await importSession({
        exportPath: (incB as { exportPath: string }).exportPath,
        targetConfigDir: fxA.configDir,
        targetProjectPath: "/Users/testuser/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(aImport.success).toBe(true);

      // A should now have 2 sessions: the original + the continuation
      const aProjectDir = join(
        fxA.configDir,
        "projects",
        "-Users-testuser-Projects-testproject"
      );
      const jsonlFiles = readdirSync(aProjectDir).filter((f) => f.endsWith(".jsonl"));
      expect(jsonlFiles.length).toBe(2);
    } finally {
      rtHomeOverride.restore();
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
      rmSync(workspaceA, { recursive: true, force: true });
      rmSync(workspaceB, { recursive: true, force: true });
    }
  });
});
