import {
  rmSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  renameSync,
} from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { exportSession, exportAllSessions } from "./exporter.js";
import { importSession } from "./importer.js";
import { encodeProjectPath } from "./platform.js";
import type {
  MigrateResult,
  ErrorResult,
  ExportResult,
  ImportResult,
  DryRunResult,
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
  renameDir?: boolean;
  /** When set, a warning is emitted if this path is inside `sourceProjectPath`
   *  (self-migration: the caller is running inside the directory being moved). */
  currentCwd?: string;
  /** Override the self-migration safety block. Only set this when the caller has
   *  verified the active Claude Code session is NOT in `sourceProjectPath`. */
  force?: boolean;
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
    renameDir,
    currentCwd,
    force,
  } = options;

  const isSelfMigration =
    !!currentCwd && isWithin(currentCwd, sourceProjectPath);

  const selfMigrationWarnings: string[] = [];
  if (isSelfMigration) {
    selfMigrationWarnings.push(
      currentCwd === sourceProjectPath
        ? `Self-migration detected: current working directory matches source path (${sourceProjectPath}). If this is the running Claude Code session, its JSONL is being actively written — the migration takes a snapshot, but new messages after this run go to the deleted source file. Exit this session and re-run migrate from an outer directory for a clean handoff.`
        : `Self-migration detected: current working directory (${currentCwd}) is inside source path (${sourceProjectPath}). ${renameDir ? "It will cease to exist after --rename-dir is applied." : "The session and shell may misbehave after cleanup."} Consider running migrate from an outer directory.`
    );
  }

  // Block actual self-migration runs unless the caller explicitly forces.
  // Dry-run is allowed through so the user can still preview the plan.
  if (isSelfMigration && !dryRun && !force) {
    return {
      success: false,
      command: "migrate",
      error: `Refusing self-migration: current working directory (${currentCwd}) is inside the source project path (${sourceProjectPath}). This Claude Code session is actively writing to a JSONL in the source; after cleanup, Claude Code recreates it at the old path and the session is orphaned with a stale cwd.`,
      suggestion:
        "Exit this Claude Code session, `cd` to an outer directory (e.g. ~/ or the parent of the project), start a fresh Claude Code session there, then re-run /sesh-mover:migrate. Override (unsafe): pass --force only if you are certain the active session is NOT in the source path.",
    };
  }

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

    // If dry-run, return preview without cleanup
    if (dryRun) {
      const dryResult = importResult as DryRunResult;
      return {
        success: true,
        command: "migrate",
        importedSessions: dryResult.importedSessions,
        cleanedUp: false,
        directoryRenamed: false,
        sourcePath: sourceProjectPath,
        targetPath: targetProjectPath,
        warnings: [
          ...selfMigrationWarnings,
          ...dryResult.warnings,
          "DRY RUN: no files were modified or deleted",
        ],
      };
    }

    const imported = importResult as ImportResult;

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

    // Step 4: Optionally rename the actual project directory
    let directoryRenamed = false;
    if (renameDir && sourceProjectPath !== targetProjectPath) {
      if (existsSync(sourceProjectPath) && !existsSync(targetProjectPath)) {
        try {
          // Ensure parent directory of target exists
          const targetParent = dirname(targetProjectPath);
          if (!existsSync(targetParent)) {
            const { mkdirSync } = await import("node:fs");
            mkdirSync(targetParent, { recursive: true });
          }
          renameSync(sourceProjectPath, targetProjectPath);
          directoryRenamed = true;
        } catch (e) {
          imported.warnings.push(
            `Failed to rename directory ${sourceProjectPath} → ${targetProjectPath}: ${(e as Error).message}. You may need to rename it manually.`
          );
        }
      } else if (!existsSync(sourceProjectPath)) {
        imported.warnings.push(
          `Source directory ${sourceProjectPath} does not exist — cannot rename. It may have already been moved.`
        );
      } else if (existsSync(targetProjectPath)) {
        imported.warnings.push(
          `Target directory ${targetProjectPath} already exists — skipping rename to avoid overwriting. Move files manually if needed.`
        );
      }
    }

    return {
      success: true,
      command: "migrate",
      importedSessions: imported.importedSessions,
      cleanedUp,
      directoryRenamed,
      sourcePath: sourceProjectPath,
      targetPath: targetProjectPath,
      warnings: [...selfMigrationWarnings, ...imported.warnings],
    };
  } finally {
    // Clean up temp export
    rmSync(tempExportDir, { recursive: true, force: true });
  }
}
