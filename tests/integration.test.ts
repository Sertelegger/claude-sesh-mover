import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import type { ExportResult, ImportResult } from "../src/types.js";

describe("integration: full export/import cycle", () => {
  let tempDir: string;
  let sourceConfigDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-integration-"));
    const fixture = createFixtureTree(tempDir);
    sourceConfigDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
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
});
