"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateSession = migrateSession;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const exporter_js_1 = require("./exporter.js");
const importer_js_1 = require("./importer.js");
const platform_js_1 = require("./platform.js");
function isWithin(child, parent) {
    const rel = (0, node_path_1.relative)(parent, child);
    return rel === "" || (!rel.startsWith("..") && !(0, node_path_1.isAbsolute)(rel));
}
async function migrateSession(options) {
    const { sourceConfigDir, targetConfigDir, sourceProjectPath, targetProjectPath, scope, sessionId, excludeLayers, claudeVersion, dryRun, renameDir, currentCwd, force, onProgress, } = options;
    const isSelfMigration = !!currentCwd && isWithin(currentCwd, sourceProjectPath);
    const selfMigrationWarnings = [];
    if (isSelfMigration) {
        selfMigrationWarnings.push(currentCwd === sourceProjectPath
            ? `Self-migration detected: current working directory matches source path (${sourceProjectPath}). If this is the running Claude Code session, its JSONL is being actively written — the migration takes a snapshot, but new messages after this run go to the deleted source file. Exit this session and re-run migrate from an outer directory for a clean handoff.`
            : `Self-migration detected: current working directory (${currentCwd}) is inside source path (${sourceProjectPath}). ${renameDir ? "It will cease to exist after --rename-dir is applied." : "The session and shell may misbehave after cleanup."} Consider running migrate from an outer directory.`);
    }
    // Block actual self-migration runs unless the caller explicitly forces.
    // Dry-run is allowed through so the user can still preview the plan.
    if (isSelfMigration && !dryRun && !force) {
        return {
            success: false,
            command: "migrate",
            error: `Refusing self-migration: current working directory (${currentCwd}) is inside the source project path (${sourceProjectPath}). This Claude Code session is actively writing to a JSONL in the source; after cleanup, Claude Code recreates it at the old path and the session is orphaned with a stale cwd.`,
            suggestion: "Exit this Claude Code session, `cd` to an outer directory (e.g. ~/ or the parent of the project), start a fresh Claude Code session there, then re-run /sesh-mover:migrate. Override (unsafe): pass --force only if you are certain the active session is NOT in the source path.",
        };
    }
    if (scope === "current" && !sessionId) {
        return {
            success: false,
            command: "migrate",
            error: "Migrate with --scope current requires --session-id: without it the previous behavior silently migrated and deleted ALL sessions for the project.",
            suggestion: "Pass --session-id <id> to move one session, or --scope all to intentionally move every session for this project.",
        };
    }
    // Create temp directory for the intermediate export
    const tempExportDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "sesh-mover-migrate-"));
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
        const exportResult = scope === "current" && sessionId
            ? await (0, exporter_js_1.exportSession)({ ...exportOpts, sessionId })
            : await (0, exporter_js_1.exportAllSessions)(exportOpts);
        if (!exportResult.success) {
            return exportResult;
        }
        const exported = exportResult;
        const exportPath = exported.exportPath;
        // Step 2: Import to target (or dry-run)
        const importResult = await (0, importer_js_1.importSession)({
            exportPath,
            targetConfigDir,
            targetProjectPath,
            targetClaudeVersion: claudeVersion,
            dryRun: !!dryRun,
            onProgress,
        });
        if (!importResult.success) {
            return importResult;
        }
        // If dry-run, return preview without cleanup
        if (dryRun) {
            const dryResult = importResult;
            return {
                success: true,
                command: "migrate",
                importedSessions: dryResult.importedSessions,
                skippedSessions: dryResult.skippedSessions,
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
        const imported = importResult;
        // Step 3: Clean up source — only sessions confirmed moved. Sessions the
        // import skipped as duplicates still count: identical content already
        // exists at the target, so migrate semantics (source ends up gone) hold.
        const movedIds = new Set(imported.importedSessions.map((s) => s.originalId));
        for (const s of imported.skippedSessions ?? [])
            movedIds.add(s.originalId);
        const sourceEncoded = (0, platform_js_1.encodeProjectPath)(sourceProjectPath);
        const sourceProjectDir = (0, node_path_1.join)(sourceConfigDir, "projects", sourceEncoded);
        let cleanedUp = false;
        for (const movedId of movedIds) {
            const jsonlPath = (0, node_path_1.join)(sourceProjectDir, `${movedId}.jsonl`);
            if ((0, node_fs_1.existsSync)(jsonlPath))
                (0, node_fs_1.rmSync)(jsonlPath);
            const sessionSubDir = (0, node_path_1.join)(sourceProjectDir, movedId);
            if ((0, node_fs_1.existsSync)(sessionSubDir))
                (0, node_fs_1.rmSync)(sessionSubDir, { recursive: true });
            const fileHistoryDir = (0, node_path_1.join)(sourceConfigDir, "file-history", movedId);
            if ((0, node_fs_1.existsSync)(fileHistoryDir))
                (0, node_fs_1.rmSync)(fileHistoryDir, { recursive: true });
            cleanedUp = true;
        }
        // Step 4: Optionally rename the actual project directory
        let directoryRenamed = false;
        if (renameDir && sourceProjectPath !== targetProjectPath) {
            if ((0, node_fs_1.existsSync)(sourceProjectPath) && !(0, node_fs_1.existsSync)(targetProjectPath)) {
                try {
                    // Ensure parent directory of target exists
                    const targetParent = (0, node_path_1.dirname)(targetProjectPath);
                    if (!(0, node_fs_1.existsSync)(targetParent)) {
                        const { mkdirSync } = await import("node:fs");
                        mkdirSync(targetParent, { recursive: true });
                    }
                    (0, node_fs_1.renameSync)(sourceProjectPath, targetProjectPath);
                    directoryRenamed = true;
                }
                catch (e) {
                    imported.warnings.push(`Failed to rename directory ${sourceProjectPath} → ${targetProjectPath}: ${e.message}. You may need to rename it manually.`);
                }
            }
            else if (!(0, node_fs_1.existsSync)(sourceProjectPath)) {
                imported.warnings.push(`Source directory ${sourceProjectPath} does not exist — cannot rename. It may have already been moved.`);
            }
            else if ((0, node_fs_1.existsSync)(targetProjectPath)) {
                imported.warnings.push(`Target directory ${targetProjectPath} already exists — skipping rename to avoid overwriting. Move files manually if needed.`);
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
            warnings: [...selfMigrationWarnings, ...imported.warnings],
        };
    }
    finally {
        // Clean up temp export
        (0, node_fs_1.rmSync)(tempExportDir, { recursive: true, force: true });
    }
}
//# sourceMappingURL=migrator.js.map