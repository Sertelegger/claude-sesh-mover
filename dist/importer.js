"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.importSession = importSession;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const manifest_js_1 = require("./manifest.js");
const rewriter_js_1 = require("./rewriter.js");
const platform_js_1 = require("./platform.js");
const version_adapters_js_1 = require("./version-adapters.js");
async function importSession(options) {
    const { exportPath, targetConfigDir, targetProjectPath, targetClaudeVersion, dryRun, sessionIds, noRegister, } = options;
    const warnings = [];
    // Step 1: Read manifest
    let manifest;
    try {
        manifest = (0, manifest_js_1.readManifest)(exportPath);
    }
    catch (e) {
        return {
            success: false,
            command: "import",
            error: `Failed to read manifest: ${e.message}`,
        };
    }
    // Filter sessions if specific IDs requested
    const targetSessions = sessionIds
        ? manifest.sessions.filter((s) => sessionIds.includes(s.sessionId))
        : manifest.sessions;
    if (targetSessions.length === 0) {
        return {
            success: false,
            command: "import",
            error: "No matching sessions found in export",
        };
    }
    // Step 1.5: Version reconciliation
    const versionDiff = (0, version_adapters_js_1.classifyVersionDifference)(manifest.sourceClaudeVersion, targetClaudeVersion);
    const adapters = (0, version_adapters_js_1.getApplicableAdapters)(manifest.sourceClaudeVersion, targetClaudeVersion);
    const versionAdaptations = [];
    if (versionDiff === "source-newer") {
        warnings.push(`Export from newer Claude Code (${manifest.sourceClaudeVersion}) than target (${targetClaudeVersion}). Unknown entry types will be preserved.`);
    }
    // Step 2: Build path mappings
    const targetPlatform = (0, platform_js_1.detectPlatform)();
    const sourceUser = (0, platform_js_1.extractUserFromPath)(manifest.sourceProjectPath, manifest.sourcePlatform) ??
        "unknown";
    const targetUser = (0, platform_js_1.getCurrentUser)();
    const mappings = (0, rewriter_js_1.buildPathMappings)(manifest.sourcePlatform, targetPlatform, manifest.sourceProjectPath, targetProjectPath, manifest.sourceConfigDir, targetConfigDir, sourceUser, targetUser);
    // Step 3: Verify per-session integrity (before any rewriting)
    const integrityFailedSessions = new Set();
    for (const session of targetSessions) {
        const jsonlPath = (0, node_path_1.join)(exportPath, "sessions", `${session.sessionId}.jsonl`);
        if ((0, node_fs_1.existsSync)(jsonlPath)) {
            const content = (0, node_fs_1.readFileSync)(jsonlPath, "utf-8");
            if (!(0, manifest_js_1.verifyIntegrity)([content], session.integrityHash)) {
                integrityFailedSessions.add(session.sessionId);
                warnings.push(`integrity check failed for session "${session.slug}" (${session.sessionId}): JSONL content doesn't match manifest hash. Data may be corrupted.`);
            }
        }
    }
    // Generate new session IDs
    const sessionIdMap = new Map();
    for (const session of targetSessions) {
        sessionIdMap.set(session.sessionId, (0, node_crypto_1.randomUUID)());
    }
    const importedSessions = targetSessions.map((session) => ({
        originalId: session.sessionId,
        newId: sessionIdMap.get(session.sessionId),
        slug: session.slug,
        messageCount: session.messageCount,
    }));
    // For dry-run, return the report without writing anything
    if (dryRun) {
        let rewriteReport;
        const firstSession = targetSessions[0];
        const firstJsonlPath = (0, node_path_1.join)(exportPath, "sessions", `${firstSession.sessionId}.jsonl`);
        if ((0, node_fs_1.existsSync)(firstJsonlPath)) {
            const content = (0, node_fs_1.readFileSync)(firstJsonlPath, "utf-8");
            const { report } = (0, rewriter_js_1.rewriteJsonl)(content, mappings, sessionIdMap.get(firstSession.sessionId));
            rewriteReport = report;
        }
        return {
            success: true,
            command: "import",
            dryRun: true,
            importedSessions,
            warnings,
            resumable: true,
            rewriteReport,
            versionAdaptations: adapters.map((a) => a.description),
        };
    }
    // Step 4: Write session files
    const encodedTargetPath = (0, platform_js_1.encodeProjectPath)(targetProjectPath);
    const targetProjectDir = (0, node_path_1.join)(targetConfigDir, "projects", encodedTargetPath);
    (0, node_fs_1.mkdirSync)(targetProjectDir, { recursive: true });
    // Helper: remove only the files written by this import (targeted rollback)
    const rollbackImportedFiles = () => {
        for (const [, newId] of sessionIdMap) {
            // Remove new session JSONL file
            const jsonlFile = (0, node_path_1.join)(targetProjectDir, `${newId}.jsonl`);
            if ((0, node_fs_1.existsSync)(jsonlFile))
                (0, node_fs_1.rmSync)(jsonlFile, { force: true });
            // Remove new session subdirectory (subagents, tool-results)
            const sessionSubDir = (0, node_path_1.join)(targetProjectDir, newId);
            if ((0, node_fs_1.existsSync)(sessionSubDir))
                (0, node_fs_1.rmSync)(sessionSubDir, { recursive: true, force: true });
            // Remove new file-history directory
            const fhDir = (0, node_path_1.join)(targetConfigDir, "file-history", newId);
            if ((0, node_fs_1.existsSync)(fhDir))
                (0, node_fs_1.rmSync)(fhDir, { recursive: true, force: true });
        }
    };
    try {
        for (const session of targetSessions) {
            const newSessionId = sessionIdMap.get(session.sessionId);
            // Rewrite and write JSONL
            const jsonlPath = (0, node_path_1.join)(exportPath, "sessions", `${session.sessionId}.jsonl`);
            if ((0, node_fs_1.existsSync)(jsonlPath)) {
                const jsonlContent = (0, node_fs_1.readFileSync)(jsonlPath, "utf-8");
                // Apply version adapters
                let processedContent = jsonlContent;
                if (adapters.length > 0) {
                    const lines = jsonlContent.trim().split("\n").filter(Boolean);
                    const adaptedLines = lines.map((line) => {
                        try {
                            const entry = JSON.parse(line);
                            const { entry: adapted, applied } = (0, version_adapters_js_1.applyAdapters)(entry, adapters);
                            versionAdaptations.push(...applied);
                            return JSON.stringify(adapted);
                        }
                        catch {
                            return line;
                        }
                    });
                    processedContent = adaptedLines.join("\n") + "\n";
                }
                const { rewritten } = (0, rewriter_js_1.rewriteJsonl)(processedContent, mappings, newSessionId);
                (0, node_fs_1.writeFileSync)((0, node_path_1.join)(targetProjectDir, `${newSessionId}.jsonl`), rewritten);
            }
            // Copy subagents
            const subagentsDir = (0, node_path_1.join)(exportPath, "sessions", session.sessionId, "subagents");
            if ((0, node_fs_1.existsSync)(subagentsDir)) {
                const targetSubDir = (0, node_path_1.join)(targetProjectDir, newSessionId, "subagents");
                (0, node_fs_1.mkdirSync)(targetSubDir, { recursive: true });
                for (const file of (0, node_fs_1.readdirSync)(subagentsDir)) {
                    if (file.endsWith(".jsonl")) {
                        // Rewrite subagent JSONL too
                        const content = (0, node_fs_1.readFileSync)((0, node_path_1.join)(subagentsDir, file), "utf-8");
                        const { rewritten } = (0, rewriter_js_1.rewriteJsonl)(content, mappings, newSessionId);
                        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(targetSubDir, file), rewritten);
                    }
                    else {
                        (0, node_fs_1.copyFileSync)((0, node_path_1.join)(subagentsDir, file), (0, node_path_1.join)(targetSubDir, file));
                    }
                }
            }
            // Copy tool results
            const toolResultsDir = (0, node_path_1.join)(exportPath, "sessions", session.sessionId, "tool-results");
            if ((0, node_fs_1.existsSync)(toolResultsDir)) {
                const targetTrDir = (0, node_path_1.join)(targetProjectDir, newSessionId, "tool-results");
                (0, node_fs_1.mkdirSync)(targetTrDir, { recursive: true });
                for (const file of (0, node_fs_1.readdirSync)(toolResultsDir)) {
                    (0, node_fs_1.copyFileSync)((0, node_path_1.join)(toolResultsDir, file), (0, node_path_1.join)(targetTrDir, file));
                }
            }
            // Copy file history
            const fileHistoryDir = (0, node_path_1.join)(exportPath, "file-history", session.sessionId);
            if ((0, node_fs_1.existsSync)(fileHistoryDir)) {
                const targetFhDir = (0, node_path_1.join)(targetConfigDir, "file-history", newSessionId);
                (0, node_fs_1.mkdirSync)(targetFhDir, { recursive: true });
                for (const file of (0, node_fs_1.readdirSync)(fileHistoryDir)) {
                    (0, node_fs_1.copyFileSync)((0, node_path_1.join)(fileHistoryDir, file), (0, node_path_1.join)(targetFhDir, file));
                }
            }
        }
    }
    catch (writeErr) {
        // Mid-write failure: roll back only what this import created
        try {
            rollbackImportedFiles();
        }
        catch {
            /* best effort cleanup */
        }
        return {
            success: false,
            command: "import",
            error: `Import write failed: ${writeErr.message}`,
            details: "Partially written files have been cleaned up. No indexes were modified.",
            suggestion: "Check available disk space or file permissions and retry.",
        };
    }
    // Step 5: Merge memory files, tracking conflicts for user resolution
    const memoryConflicts = [];
    const memoryDir = (0, node_path_1.join)(exportPath, "memory");
    if ((0, node_fs_1.existsSync)(memoryDir)) {
        const targetMemDir = (0, node_path_1.join)(targetProjectDir, "memory");
        (0, node_fs_1.mkdirSync)(targetMemDir, { recursive: true });
        for (const file of (0, node_fs_1.readdirSync)(memoryDir)) {
            const targetFile = (0, node_path_1.join)(targetMemDir, file);
            if ((0, node_fs_1.existsSync)(targetFile)) {
                const existingContent = (0, node_fs_1.readFileSync)(targetFile, "utf-8");
                const newContent = (0, node_fs_1.readFileSync)((0, node_path_1.join)(memoryDir, file), "utf-8");
                if (existingContent !== newContent) {
                    const existingHash = (0, manifest_js_1.computeIntegrityHash)([existingContent]);
                    const incomingHash = (0, manifest_js_1.computeIntegrityHash)([newContent]);
                    memoryConflicts.push({ filename: file, existingHash, incomingHash });
                    warnings.push(`Memory file "${file}" exists with different content — kept existing version. Use memoryConflicts in result to resolve.`);
                }
                // Skip — keep existing (skill can overwrite if user chooses incoming)
            }
            else {
                (0, node_fs_1.copyFileSync)((0, node_path_1.join)(memoryDir, file), targetFile);
            }
        }
    }
    // Copy plans
    const plansDir = (0, node_path_1.join)(exportPath, "plans");
    if ((0, node_fs_1.existsSync)(plansDir)) {
        const targetPlansDir = (0, node_path_1.join)(targetConfigDir, "plans");
        (0, node_fs_1.mkdirSync)(targetPlansDir, { recursive: true });
        for (const file of (0, node_fs_1.readdirSync)(plansDir)) {
            const targetFile = (0, node_path_1.join)(targetPlansDir, file);
            if (!(0, node_fs_1.existsSync)(targetFile)) {
                (0, node_fs_1.copyFileSync)((0, node_path_1.join)(plansDir, file), targetFile);
            }
        }
    }
    // Step 6: Validate written files before registering in index.
    // Sessions that already failed the integrity check are known-corrupt; we
    // skip strict JSON validation for them so the import can still succeed with
    // a warning. We only hard-fail if a session that passed integrity check
    // produces unparseable output (indicating a rewrite pipeline bug).
    for (const session of targetSessions) {
        const newSessionId = sessionIdMap.get(session.sessionId);
        const writtenJsonlPath = (0, node_path_1.join)(targetProjectDir, `${newSessionId}.jsonl`);
        if (!(0, node_fs_1.existsSync)(writtenJsonlPath)) {
            // Session had no JSONL file to write; skip validation for this session
            continue;
        }
        // Skip strict validation for sessions with known integrity failures
        if (integrityFailedSessions.has(session.sessionId)) {
            continue;
        }
        try {
            const content = (0, node_fs_1.readFileSync)(writtenJsonlPath, "utf-8");
            const lines = content.trim().split("\n").filter(Boolean);
            // Verify each line is valid JSON
            for (const line of lines) {
                JSON.parse(line);
            }
        }
        catch (e) {
            // Rollback: clean up only files written by this import
            try {
                rollbackImportedFiles();
            }
            catch {
                /* best effort cleanup */
            }
            return {
                success: false,
                command: "import",
                error: `Import validation failed: ${e.message}`,
                details: "Written files have been cleaned up. No indexes were modified.",
                suggestion: "Check the export bundle for corruption, or try --no-register to import as read-only.",
            };
        }
    }
    // Step 7: Register in indexes (only after successful validation)
    if (!noRegister) {
        const historyPath = (0, node_path_1.join)(targetConfigDir, "history.jsonl");
        for (const session of targetSessions) {
            const newSessionId = sessionIdMap.get(session.sessionId);
            const historyEntry = {
                display: session.summary || session.slug,
                pastedContents: {},
                timestamp: Date.now(),
                project: targetProjectPath,
                sessionId: newSessionId,
            };
            (0, node_fs_1.appendFileSync)(historyPath, JSON.stringify(historyEntry) + "\n", "utf-8");
        }
    }
    return {
        success: true,
        command: "import",
        importedSessions,
        warnings,
        resumable: !noRegister,
        versionAdaptations: versionAdaptations.length > 0 ? versionAdaptations : undefined,
        memoryConflicts: memoryConflicts.length > 0 ? memoryConflicts : undefined,
    };
}
//# sourceMappingURL=importer.js.map