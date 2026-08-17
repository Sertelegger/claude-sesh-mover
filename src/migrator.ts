import {
  rmSync,
  existsSync,
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
  ProgressEvent,
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
  onProgress?: (ev: ProgressEvent) => void;
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** What the `--rename-dir` step will do (apply) / would do (dry-run). */
interface RenamePlan {
  /** True iff every precondition for the `mv` is currently satisfied. */
  rename: boolean;
  /** Prose for `warnings`, when there is something the caller must know. */
  warning?: string;
}

/**
 * Single source of truth for the `--rename-dir` preconditions, shared by the
 * dry-run preview and the apply path.
 *
 * It exists because the two used to disagree: the preview hardcoded
 * `directoryRenamed: false` and emitted no rename warning, so a dry-run with
 * `--rename-dir` was byte-identical to one without it — and the model reading
 * that preview reported "the directory will not be renamed" immediately before
 * the real run `mv`-ed it. A preview that omits the most destructive step of
 * the plan is worse than no preview, so both paths now ask the same question
 * here and only the tense of the prose differs.
 *
 * Evaluating this at dry-run time is faithful: cleanup (step 3) only ever
 * deletes files under `<configDir>/projects/…`, never the project directories
 * themselves, so the existence checks the apply path makes after cleanup see
 * exactly what these see. It performs no filesystem mutation in either mode.
 */
function planDirectoryRename(
  renameDir: boolean | undefined,
  sourceProjectPath: string,
  targetProjectPath: string,
  mode: "dry-run" | "apply"
): RenamePlan {
  if (!renameDir) return { rename: false };

  if (sourceProjectPath === targetProjectPath) {
    return {
      rename: false,
      // The apply path is silent here (nothing happens, nothing to undo); a
      // preview owes the user the reason its requested rename isn't in the plan.
      warning:
        mode === "dry-run"
          ? `DRY RUN: --rename-dir was requested, but the source and target project paths are identical (${sourceProjectPath}) — no directory would be renamed.`
          : undefined,
    };
  }

  if (!existsSync(sourceProjectPath)) {
    return {
      rename: false,
      warning:
        mode === "dry-run"
          ? `DRY RUN: source directory ${sourceProjectPath} does not exist — the rename would be skipped. It may have already been moved.`
          : `Source directory ${sourceProjectPath} does not exist — cannot rename. It may have already been moved.`,
    };
  }

  if (existsSync(targetProjectPath)) {
    return {
      rename: false,
      warning:
        mode === "dry-run"
          ? `DRY RUN: target directory ${targetProjectPath} already exists — the rename would be skipped to avoid overwriting. Move files manually if needed.`
          : `Target directory ${targetProjectPath} already exists — skipping rename to avoid overwriting. Move files manually if needed.`,
    };
  }

  return {
    rename: true,
    warning:
      mode === "dry-run"
        ? `DRY RUN: the project directory ${sourceProjectPath} would be renamed to ${targetProjectPath}.`
        : undefined,
  };
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
    onProgress,
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

  if (scope === "current" && !sessionId) {
    return {
      success: false,
      command: "migrate",
      error:
        "Migrate with --scope current requires --session-id: without it the previous behavior silently migrated and deleted ALL sessions for the project.",
      suggestion:
        "Pass --session-id <id> to move one session, or --scope all to intentionally move every session for this project.",
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
      onProgress,
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
      onProgress,
    });

    if (!importResult.success) {
      return importResult as ErrorResult;
    }

    // If dry-run, return preview without cleanup.
    //
    // `dryRun: true` marks EVERY field below as a prediction: `cleanedUp` and
    // `directoryRenamed` answer "would this happen", not "did this happen".
    // Nothing outside the (temp) export staging dir is touched on this path.
    if (dryRun) {
      const dryResult = importResult as DryRunResult;
      const renamePlan = planDirectoryRename(
        renameDir,
        sourceProjectPath,
        targetProjectPath,
        "dry-run"
      );
      // Cleanup deletes the source copy of every session the real run would
      // move — imported plus skipped-as-duplicate (see step 3 below).
      const wouldCleanUp =
        dryResult.importedSessions.length + dryResult.skippedSessions.length > 0;
      return {
        success: true,
        command: "migrate",
        dryRun: true,
        importedSessions: dryResult.importedSessions,
        skippedSessions: dryResult.skippedSessions,
        cleanedUp: wouldCleanUp,
        directoryRenamed: renamePlan.rename,
        sourcePath: sourceProjectPath,
        targetPath: targetProjectPath,
        // The shared-layer preview, forwarded rather than re-derived. A migrate
        // is an import, so its dry run has the same memory plan an `import
        // --dry-run` has, and dropping it here was why `commands/migrate.md`
        // could preview sessions but not the one part of the move that touches
        // a directory the target already owns.
        memoryPlan: dryResult.memoryPlan,
        memoryDir: dryResult.memoryDir,
        planConflicts: dryResult.planConflicts,
        warnings: [
          ...selfMigrationWarnings,
          // The export runs for real even on a dry run (into a temp staging
          // dir), so its warnings are already true of what the real migrate
          // would carry — including the `--exclude` disclosure the apply path
          // relays for the same reason.
          ...exported.warnings,
          ...dryResult.warnings,
          ...(renamePlan.warning ? [renamePlan.warning] : []),
          "DRY RUN: no files were modified or deleted",
        ],
      };
    }

    const imported = importResult as ImportResult;

    // Step 3: Clean up source — only sessions confirmed moved. Sessions the
    // import skipped as duplicates still count: identical content already
    // exists at the target, so migrate semantics (source ends up gone) hold.
    const movedIds = new Set(imported.importedSessions.map((s) => s.originalId));
    for (const s of imported.skippedSessions ?? []) movedIds.add(s.originalId);
    const sourceEncoded = encodeProjectPath(sourceProjectPath);
    const sourceProjectDir = join(sourceConfigDir, "projects", sourceEncoded);
    let cleanedUp = false;

    for (const movedId of movedIds) {
      const jsonlPath = join(sourceProjectDir, `${movedId}.jsonl`);
      if (existsSync(jsonlPath)) rmSync(jsonlPath);
      const sessionSubDir = join(sourceProjectDir, movedId);
      if (existsSync(sessionSubDir)) rmSync(sessionSubDir, { recursive: true });
      const fileHistoryDir = join(sourceConfigDir, "file-history", movedId);
      if (existsSync(fileHistoryDir)) rmSync(fileHistoryDir, { recursive: true });
      cleanedUp = true;
    }

    // Step 4: Optionally rename the actual project directory. The
    // preconditions are decided by the same helper the dry-run preview uses,
    // so the preview can never again disagree with what happens here.
    let directoryRenamed = false;
    const renamePlan = planDirectoryRename(
      renameDir,
      sourceProjectPath,
      targetProjectPath,
      "apply"
    );
    if (renamePlan.warning) imported.warnings.push(renamePlan.warning);
    if (renamePlan.rename) {
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
    }

    return {
      success: true,
      command: "migrate",
      importedSessions: imported.importedSessions,
      skippedSessions: imported.skippedSessions,
      cleanedUp,
      directoryRenamed,
      sourcePath: sourceProjectPath,
      targetPath: targetProjectPath,
      // The typed shared-layer fields, forwarded ALONGSIDE the import's warnings
      // rather than instead of them (#59 item 3). A migrate reconciles `memory/`
      // and `plans/` into the target exactly as an import does — it IS an import
      // — so a migrate that parks a memory file must hand the skill layer the
      // same `parkedAs`/`memoryDir` pair `commands/import.md` acts on. Only the
      // warnings crossed this line before, which made the parked copy visible
      // and unactionable. One migrate is one import call, so there is nothing to
      // aggregate here (unlike a pull, which walks a chain).
      memoryConflicts: imported.memoryConflicts,
      memoryIndex: imported.memoryIndex,
      memoryDir: imported.memoryDir,
      planConflicts: imported.planConflicts,
      // `plansSkipped` matters MORE here than on import, not less. `migrate`
      // declares no `--include-plans`, so it always takes the skip — and unlike
      // an import, the user is moving a session and may reasonably read that as
      // "everything came with it". The warning already crosses; without this
      // the count is the one part the skill layer cannot branch on. (It is not
      // data loss either way: cleanup deletes only the source project's
      // sessions and file-history, never `<sourceConfigDir>/plans`, so the
      // source plans stay where they are. The visible gap is a cross-config-dir
      // migrate.)
      plansSkipped: imported.plansSkipped,
      // The EXPORT's warnings ride along too, and they are not decoration on a
      // migrate: `--exclude` drops a layer from the bundle, but cleanup then
      // deletes the whole source session directory and its file-history
      // regardless — so the excluded layer is destroyed rather than left
      // behind. "<layer> excluded by user request" is the only thing that says
      // so, and returning only the IMPORT's warnings swallowed it.
      warnings: [...selfMigrationWarnings, ...exported.warnings, ...imported.warnings],
    };
  } finally {
    // Clean up temp export
    rmSync(tempExportDir, { recursive: true, force: true });
  }
}
