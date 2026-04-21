"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportSession = exportSession;
exports.exportAllSessions = exportAllSessions;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const manifest_js_1 = require("./manifest.js");
const discovery_js_1 = require("./discovery.js");
const platform_js_1 = require("./platform.js");
const summary_js_1 = require("./summary.js");
const continuation_js_1 = require("./continuation.js");
const diff_js_1 = require("./diff.js");
async function exportSession(options) {
    const { configDir, projectPath, sessionId, outputDir, name, excludeLayers, claudeVersion, collisionCheck, summaryOverrides, incremental, } = options;
    const exportPath = (0, node_path_1.join)(outputDir, name);
    // Collision check
    if (collisionCheck && (0, node_fs_1.existsSync)(exportPath)) {
        return {
            success: true,
            command: "export",
            exportPath,
            sessions: [],
            warnings: [],
            archivePath: null,
            collision: true,
            existingPath: exportPath,
        };
    }
    // Find the session
    const sessions = (0, discovery_js_1.discoverSessions)(configDir, projectPath);
    const target = sessionId
        ? sessions.find((s) => s.sessionId === sessionId)
        : sessions[0];
    if (!target) {
        return {
            success: false,
            command: "export",
            error: sessionId
                ? `Session ${sessionId} not found`
                : "No sessions found for this project",
        };
    }
    return exportSessions([target], configDir, projectPath, exportPath, excludeLayers, claudeVersion, "current", summaryOverrides, incremental);
}
async function exportAllSessions(options) {
    const { configDir, projectPath, outputDir, name, excludeLayers, claudeVersion, summaryOverrides, incremental, } = options;
    const sessions = (0, discovery_js_1.discoverSessions)(configDir, projectPath);
    if (sessions.length === 0) {
        return {
            success: false,
            command: "export",
            error: "No sessions found for this project",
        };
    }
    const exportPath = (0, node_path_1.join)(outputDir, name);
    return exportSessions(sessions, configDir, projectPath, exportPath, excludeLayers, claudeVersion, "all", summaryOverrides, incremental);
}
async function exportSessions(sessions, configDir, projectPath, exportPath, excludeLayers, claudeVersion, scope, summaryOverrides, incremental) {
    const includedLayers = getAllLayers().filter((l) => !excludeLayers.includes(l));
    const warnings = [];
    (0, node_fs_1.mkdirSync)((0, node_path_1.join)(exportPath, "sessions"), { recursive: true });
    const sessionManifests = [];
    const jsonlBySession = new Map();
    for (const session of sessions) {
        jsonlBySession.set(session.sessionId, (0, node_fs_1.readFileSync)(session.jsonlPath, "utf-8"));
    }
    let toFull = sessions;
    let toContinuation = [];
    if (incremental) {
        const plan = (0, diff_js_1.computeIncrementalPlan)(sessions, incremental.peerSent, (session) => {
            const raw = jsonlBySession.get(session.sessionId) ?? "";
            return raw
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                try {
                    return { uuid: JSON.parse(line).uuid };
                }
                catch {
                    return { uuid: "" };
                }
            });
        });
        warnings.push(...plan.warnings);
        toFull = plan.full;
        toContinuation = plan.continuation;
    }
    for (const session of toFull) {
        const jsonlContent = jsonlBySession.get(session.sessionId);
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(exportPath, "sessions", `${session.sessionId}.jsonl`), jsonlContent);
        if (includedLayers.includes("subagents")) {
            const subagentsDir = (0, node_path_1.join)(configDir, "projects", session.encodedProjectDir, session.sessionId, "subagents");
            if ((0, node_fs_1.existsSync)(subagentsDir)) {
                const targetSubDir = (0, node_path_1.join)(exportPath, "sessions", session.sessionId, "subagents");
                (0, node_fs_1.mkdirSync)(targetSubDir, { recursive: true });
                for (const file of (0, node_fs_1.readdirSync)(subagentsDir)) {
                    (0, node_fs_1.copyFileSync)((0, node_path_1.join)(subagentsDir, file), (0, node_path_1.join)(targetSubDir, file));
                }
            }
        }
        if (includedLayers.includes("tool-results")) {
            const toolResultsDir = (0, node_path_1.join)(configDir, "projects", session.encodedProjectDir, session.sessionId, "tool-results");
            if ((0, node_fs_1.existsSync)(toolResultsDir)) {
                const targetTrDir = (0, node_path_1.join)(exportPath, "sessions", session.sessionId, "tool-results");
                (0, node_fs_1.mkdirSync)(targetTrDir, { recursive: true });
                for (const file of (0, node_fs_1.readdirSync)(toolResultsDir)) {
                    (0, node_fs_1.copyFileSync)((0, node_path_1.join)(toolResultsDir, file), (0, node_path_1.join)(targetTrDir, file));
                }
            }
        }
        if (includedLayers.includes("file-history")) {
            const fileHistoryDir = (0, node_path_1.join)(configDir, "file-history", session.sessionId);
            if ((0, node_fs_1.existsSync)(fileHistoryDir)) {
                const targetFhDir = (0, node_path_1.join)(exportPath, "file-history", session.sessionId);
                (0, node_fs_1.mkdirSync)(targetFhDir, { recursive: true });
                for (const file of (0, node_fs_1.readdirSync)(fileHistoryDir)) {
                    (0, node_fs_1.copyFileSync)((0, node_path_1.join)(fileHistoryDir, file), (0, node_path_1.join)(targetFhDir, file));
                }
            }
        }
        const entries = jsonlContent
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter(Boolean);
        const summary = summaryOverrides?.[session.sessionId] ??
            (0, summary_js_1.extractSummary)(session.slug, entries);
        const sessionHash = (0, manifest_js_1.computeIntegrityHash)([jsonlContent]);
        sessionManifests.push({
            sessionId: session.sessionId,
            slug: session.slug,
            summary,
            createdAt: session.createdAt,
            lastActiveAt: session.lastActiveAt,
            messageCount: session.messageCount,
            gitBranch: session.gitBranch,
            entrypoint: session.entrypoint,
            integrityHash: sessionHash,
            type: incremental ? "full" : undefined,
        });
    }
    for (const item of toContinuation) {
        const originalJsonl = jsonlBySession.get(item.session.sessionId);
        const newSessionId = (0, node_crypto_1.randomUUID)();
        const prevLocal = incremental?.peerSent[item.session.sessionId]?.sentAsSessionId;
        const continuationJsonl = (0, continuation_js_1.buildContinuationJsonl)({
            originalJsonl,
            fromEntryIndex: item.fromEntryIndex,
            newSessionId,
            sourceSessionId: item.session.sessionId,
            sourceMachineId: incremental.sourceMachineId,
            sourceMachineName: incremental.sourceMachineName,
            previousLocalSessionId: prevLocal,
            targetProjectPath: projectPath,
            claudeVersion,
        });
        (0, node_fs_1.writeFileSync)((0, node_path_1.join)(exportPath, "sessions", `${newSessionId}.jsonl`), continuationJsonl);
        const sessionHash = (0, manifest_js_1.computeIntegrityHash)([continuationJsonl]);
        const newEntryCount = continuationJsonl.trim().split("\n").filter(Boolean).length;
        sessionManifests.push({
            sessionId: newSessionId,
            slug: item.session.slug,
            summary: `continuation of ${item.session.slug}`,
            createdAt: new Date().toISOString(),
            lastActiveAt: item.session.lastActiveAt,
            messageCount: newEntryCount,
            gitBranch: item.session.gitBranch,
            entrypoint: item.session.entrypoint,
            integrityHash: sessionHash,
            type: "continuation",
            continuation: {
                continuesLocalSessionId: item.session.sessionId,
                continuesPeerSessionId: incremental?.peerSent[item.session.sessionId]?.sentAsSessionId,
                fromEntryIndex: item.fromEntryIndex,
                fromEntryUuid: item.fromEntryUuid,
            },
        });
    }
    if (!incremental) {
        if (includedLayers.includes("memory") && sessions.length > 0) {
            const encoded = sessions[0].encodedProjectDir;
            const memoryDir = (0, node_path_1.join)(configDir, "projects", encoded, "memory");
            if ((0, node_fs_1.existsSync)(memoryDir)) {
                const targetMemDir = (0, node_path_1.join)(exportPath, "memory");
                (0, node_fs_1.mkdirSync)(targetMemDir, { recursive: true });
                for (const file of (0, node_fs_1.readdirSync)(memoryDir)) {
                    (0, node_fs_1.copyFileSync)((0, node_path_1.join)(memoryDir, file), (0, node_path_1.join)(targetMemDir, file));
                }
            }
        }
        if (includedLayers.includes("plans")) {
            const plansDir = (0, node_path_1.join)(configDir, "plans");
            if ((0, node_fs_1.existsSync)(plansDir)) {
                const planFiles = (0, node_fs_1.readdirSync)(plansDir).filter((f) => f.endsWith(".md"));
                if (planFiles.length > 0) {
                    const targetPlansDir = (0, node_path_1.join)(exportPath, "plans");
                    (0, node_fs_1.mkdirSync)(targetPlansDir, { recursive: true });
                    for (const file of planFiles) {
                        (0, node_fs_1.copyFileSync)((0, node_path_1.join)(plansDir, file), (0, node_path_1.join)(targetPlansDir, file));
                    }
                }
            }
        }
    }
    const manifest = {
        version: 1,
        plugin: "sesh-mover",
        exportedAt: new Date().toISOString(),
        sourcePlatform: (0, platform_js_1.detectPlatform)(),
        sourceProjectPath: projectPath,
        sourceConfigDir: configDir,
        sourceClaudeVersion: claudeVersion,
        sessionScope: scope,
        includedLayers,
        sessions: sessionManifests,
        sourceMachineId: incremental?.sourceMachineId,
        sourceMachineName: incremental?.sourceMachineName,
        incremental: incremental ? true : undefined,
        baseline: incremental?.targetMachineId
            ? {
                targetMachineId: incremental.targetMachineId,
                targetMachineName: incremental.targetMachineName,
                lastSyncAt: incremental.lastSyncAt,
                referenceExport: incremental.referenceExport,
            }
            : undefined,
    };
    (0, manifest_js_1.writeManifest)(exportPath, manifest);
    for (const layer of excludeLayers) {
        warnings.push(`${layer} excluded by user request`);
    }
    return {
        success: true,
        command: "export",
        exportPath,
        sessions: sessionManifests.map((s) => ({
            originalId: s.sessionId,
            slug: s.slug,
            summary: s.summary,
            messageCount: s.messageCount,
            exportedLayers: includedLayers,
        })),
        warnings,
        archivePath: null,
        collision: false,
    };
}
function getAllLayers() {
    return [
        "jsonl",
        "subagents",
        "file-history",
        "tool-results",
        "memory",
        "plans",
    ];
}
//# sourceMappingURL=exporter.js.map