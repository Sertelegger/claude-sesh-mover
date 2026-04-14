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
    const { sourceConfigDir, targetConfigDir, sourceProjectPath, targetProjectPath, scope, sessionId, excludeLayers, claudeVersion, dryRun, renameDir, currentCwd, } = options;
    const selfMigrationWarnings = [];
    if (currentCwd && isWithin(currentCwd, sourceProjectPath)) {
        selfMigrationWarnings.push(currentCwd === sourceProjectPath
            ? `Self-migration detected: current working directory matches source path (${sourceProjectPath}). If this is the running Claude Code session, its JSONL is being actively written — the migration takes a snapshot, but new messages after this run go to the deleted source file. Exit this session and re-run migrate from an outer directory for a clean handoff.`
            : `Self-migration detected: current working directory (${currentCwd}) is inside source path (${sourceProjectPath}). ${renameDir ? "It will cease to exist after --rename-dir is applied." : "The session and shell may misbehave after cleanup."} Consider running migrate from an outer directory.`);
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
        // Step 3: Clean up source
        const sourceEncoded = (0, platform_js_1.encodeProjectPath)(sourceProjectPath);
        const sourceProjectDir = (0, node_path_1.join)(sourceConfigDir, "projects", sourceEncoded);
        let cleanedUp = false;
        if (scope === "current" && sessionId) {
            // Remove just this session's files
            const jsonlPath = (0, node_path_1.join)(sourceProjectDir, `${sessionId}.jsonl`);
            if ((0, node_fs_1.existsSync)(jsonlPath)) {
                (0, node_fs_1.rmSync)(jsonlPath);
            }
            // Remove session subdirectory (subagents, tool-results)
            const sessionSubDir = (0, node_path_1.join)(sourceProjectDir, sessionId);
            if ((0, node_fs_1.existsSync)(sessionSubDir)) {
                (0, node_fs_1.rmSync)(sessionSubDir, { recursive: true });
            }
            // Remove file history
            const fileHistoryDir = (0, node_path_1.join)(sourceConfigDir, "file-history", sessionId);
            if ((0, node_fs_1.existsSync)(fileHistoryDir)) {
                (0, node_fs_1.rmSync)(fileHistoryDir, { recursive: true });
            }
            cleanedUp = true;
        }
        else {
            // Remove all sessions for this project
            if ((0, node_fs_1.existsSync)(sourceProjectDir)) {
                // Keep memory directory if target is different project
                const files = (0, node_fs_1.readdirSync)(sourceProjectDir);
                for (const file of files) {
                    const filePath = (0, node_path_1.join)(sourceProjectDir, file);
                    if (file === "memory")
                        continue; // memory was merged, keep original
                    (0, node_fs_1.rmSync)(filePath, { recursive: true });
                }
                cleanedUp = true;
            }
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