import {
  rmSync,
  existsSync,
  readdirSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportSession, exportAllSessions } from "./exporter.js";
import { importSession } from "./importer.js";
import { encodeProjectPath } from "./platform.js";
import type {
  MigrateResult,
  ErrorResult,
  ExportResult,
  ImportResult,
  ExportLayer,
  SessionScope,
} from "./types.js";

export interface MigrateOptions {
  sourceConfigDir: string;
  targetConfigDir: string;
  sourceProjectPath: string;
  targetProjectPath: string;
  scope: SessionScope;
  sessionId?: string;
  excludeLayers: ExportLayer[];
  claudeVersion: string;
  dryRun?: boolean;
}

export async function migrateSession(
  options: MigrateOptions
): Promise<MigrateResult | ErrorResult> {
  const {
    sourceConfigDir,
    targetConfigDir,
    sourceProjectPath,
    targetProjectPath,
    scope,
    sessionId,
    excludeLayers,
    claudeVersion,
    dryRun,
  } = options;

  // Create temp directory for the intermediate export
  const tempExportDir = mkdtempSync(
    join(tmpdir(), "sesh-mover-migrate-")
  );

  try {
    // Step 1: Export
    const exportOpts = {
      configDir: sourceConfigDir,
      projectPath: sourceProjectPath,
      outputDir: tempExportDir,
      name: "migrate-temp",
      excludeLayers,
      claudeVersion,
    };

    const exportResult =
      scope === "current" && sessionId
        ? await exportSession({ ...exportOpts, sessionId })
        : await exportAllSessions(exportOpts);

    if (!exportResult.success) {
      return exportResult as ErrorResult;
    }

    const exported = exportResult as ExportResult;
    const exportPath = exported.exportPath;

    // Step 2: Import to target (or dry-run)
    const importResult = await importSession({
      exportPath,
      targetConfigDir,
      targetProjectPath,
      targetClaudeVersion: claudeVersion,
      dryRun: !!dryRun,
    });

    if (!importResult.success) {
      return importResult as ErrorResult;
    }

    const imported = importResult as ImportResult;

    // If dry-run, return preview without cleanup
    if (dryRun) {
      return {
        success: true,
        command: "migrate",
        importedSessions: imported.importedSessions,
        cleanedUp: false,
        sourcePath: sourceProjectPath,
        targetPath: targetProjectPath,
        warnings: [
          ...imported.warnings,
          "DRY RUN: no files were modified or deleted",
        ],
      };
    }

    // Step 3: Clean up source
    const sourceEncoded = encodeProjectPath(sourceProjectPath);
    const sourceProjectDir = join(
      sourceConfigDir,
      "projects",
      sourceEncoded
    );
    let cleanedUp = false;

    if (scope === "current" && sessionId) {
      // Remove just this session's files
      const jsonlPath = join(sourceProjectDir, `${sessionId}.jsonl`);
      if (existsSync(jsonlPath)) {
        rmSync(jsonlPath);
      }
      // Remove session subdirectory (subagents, tool-results)
      const sessionSubDir = join(sourceProjectDir, sessionId);
      if (existsSync(sessionSubDir)) {
        rmSync(sessionSubDir, { recursive: true });
      }
      // Remove file history
      const fileHistoryDir = join(
        sourceConfigDir,
        "file-history",
        sessionId
      );
      if (existsSync(fileHistoryDir)) {
        rmSync(fileHistoryDir, { recursive: true });
      }
      cleanedUp = true;
    } else {
      // Remove all sessions for this project
      if (existsSync(sourceProjectDir)) {
        // Keep memory directory if target is different project
        const files = readdirSync(sourceProjectDir);
        for (const file of files) {
          const filePath = join(sourceProjectDir, file);
          if (file === "memory") continue; // memory was merged, keep original
          rmSync(filePath, { recursive: true });
        }
        cleanedUp = true;
      }
    }

    return {
      success: true,
      command: "migrate",
      importedSessions: imported.importedSessions,
      cleanedUp,
      sourcePath: sourceProjectPath,
      targetPath: targetProjectPath,
      warnings: imported.warnings,
    };
  } finally {
    // Clean up temp export
    rmSync(tempExportDir, { recursive: true, force: true });
  }
}
