"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportSession = exportSession;
exports.exportAllSessions = exportAllSessions;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const node_events_1 = require("node:events");
const promises_1 = require("node:stream/promises");
const manifest_js_1 = require("./manifest.js");
const discovery_js_1 = require("./discovery.js");
const platform_js_1 = require("./platform.js");
const summary_js_1 = require("./summary.js");
const continuation_js_1 = require("./continuation.js");
const diff_js_1 = require("./diff.js");
const jsonl_js_1 = require("./jsonl.js");
function copyDirIfExists(srcDir, destDir) {
    if (!(0, node_fs_1.existsSync)(srcDir))
        return;
    (0, node_fs_1.mkdirSync)(destDir, { recursive: true });
    for (const file of (0, node_fs_1.readdirSync)(srcDir)) {
        (0, node_fs_1.copyFileSync)((0, node_path_1.join)(srcDir, file), (0, node_path_1.join)(destDir, file));
    }
}
// Stream copy with a sha256 tee: the copy and the manifest hash in one pass,
// O(chunk) memory. onBytes reports cumulative bytes for progress.
async function copyFileWithHash(src, dest, onBytes) {
    const hash = (0, node_crypto_1.createHash)("sha256");
    const input = (0, node_fs_1.createReadStream)(src);
    const output = (0, node_fs_1.createWriteStream)(dest);
    let bytes = 0;
    // Same error-latch hardening as rewriter.ts's rewriteJsonlStream and
    // continuation.ts's buildContinuationStream: without racing a latched
    // 'error' promise at both await points, a write failure (bad dest dir,
    // disk full, EACCES) either crashes the process (unhandled 'error' event)
    // or hangs forever (once(output, "drain") missing an 'error' that fired
    // before the wait began).
    const outputErrored = new Promise((_, reject) => output.once("error", reject));
    outputErrored.catch(() => { });
    try {
        for await (const chunk of input) {
            const buf = chunk;
            hash.update(buf);
            bytes += buf.length;
            if (!output.write(buf)) {
                await Promise.race([(0, node_events_1.once)(output, "drain"), outputErrored]);
            }
            onBytes?.(bytes);
        }
        output.end();
        await Promise.race([(0, promises_1.finished)(output), outputErrored]);
    }
    catch (e) {
        output.destroy();
        throw e;
    }
    finally {
        input.destroy();
    }
    return `sha256:${hash.digest("hex")}`;
}
async function exportSession(options) {
    const { configDir, projectPath, sessionId, outputDir, name, excludeLayers, claudeVersion, collisionCheck, summaryOverrides, incremental, noSummary, } = options;
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
    return exportSessions([target], configDir, projectPath, exportPath, excludeLayers, claudeVersion, "current", summaryOverrides, noSummary, incremental);
}
async function exportAllSessions(options) {
    const { configDir, projectPath, outputDir, name, excludeLayers, claudeVersion, summaryOverrides, incremental, noSummary, } = options;
    const sessions = (0, discovery_js_1.discoverSessions)(configDir, projectPath);
    if (sessions.length === 0) {
        return {
            success: false,
            command: "export",
            error: "No sessions found for this project",
        };
    }
    const exportPath = (0, node_path_1.join)(outputDir, name);
    return exportSessions(sessions, configDir, projectPath, exportPath, excludeLayers, claudeVersion, "all", summaryOverrides, noSummary, incremental);
}
async function exportSessions(sessions, configDir, projectPath, exportPath, excludeLayers, claudeVersion, scope, summaryOverrides, noSummary, incremental) {
    const includedLayers = getAllLayers().filter((l) => !excludeLayers.includes(l));
    const warnings = [];
    (0, node_fs_1.mkdirSync)((0, node_path_1.join)(exportPath, "sessions"), { recursive: true });
    const sessionManifests = [];
    let toFull = sessions;
    let toContinuation = [];
    if (incremental) {
        const uuidsBySession = new Map();
        for (const session of sessions) {
            uuidsBySession.set(session.sessionId, await (0, jsonl_js_1.readEntryUuids)(session.jsonlPath));
        }
        const plan = (0, diff_js_1.computeIncrementalPlan)(sessions, incremental.peerSent, (session) => uuidsBySession.get(session.sessionId));
        warnings.push(...plan.warnings);
        toFull = plan.full;
        toContinuation = plan.continuation;
    }
    for (const session of toFull) {
        const destJsonl = (0, node_path_1.join)(exportPath, "sessions", `${session.sessionId}.jsonl`);
        // copyFileWithHash returns "sha256:<hex>" — used directly as the manifest hash
        const sessionHash = await copyFileWithHash(session.jsonlPath, destJsonl);
        const sessionBase = (0, node_path_1.join)(configDir, "projects", session.encodedProjectDir, session.sessionId);
        if (includedLayers.includes("subagents")) {
            copyDirIfExists((0, node_path_1.join)(sessionBase, "subagents"), (0, node_path_1.join)(exportPath, "sessions", session.sessionId, "subagents"));
        }
        if (includedLayers.includes("tool-results")) {
            copyDirIfExists((0, node_path_1.join)(sessionBase, "tool-results"), (0, node_path_1.join)(exportPath, "sessions", session.sessionId, "tool-results"));
        }
        if (includedLayers.includes("file-history")) {
            copyDirIfExists((0, node_path_1.join)(configDir, "file-history", session.sessionId), (0, node_path_1.join)(exportPath, "file-history", session.sessionId));
        }
        const summary = noSummary
            ? session.slug
            : summaryOverrides?.[session.sessionId] ??
                (await (0, summary_js_1.extractSummaryFromFile)(session.slug, session.jsonlPath));
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
        const newSessionId = (0, node_crypto_1.randomUUID)();
        const prevLocal = incremental?.peerSent[item.session.sessionId]?.sentAsSessionId;
        const contDest = (0, node_path_1.join)(exportPath, "sessions", `${newSessionId}.jsonl`);
        const { entryCount, integrityHash } = await (0, continuation_js_1.buildContinuationStream)({
            sourceJsonlPath: item.session.jsonlPath,
            outputPath: contDest,
            fromEntryIndex: item.fromEntryIndex,
            fromEntryUuid: item.fromEntryUuid,
            newSessionId,
            sourceSessionId: item.session.sessionId,
            sourceMachineId: incremental.sourceMachineId,
            sourceMachineName: incremental.sourceMachineName,
            previousLocalSessionId: prevLocal,
            targetProjectPath: projectPath,
            claudeVersion,
        });
        const contBase = (0, node_path_1.join)(configDir, "projects", item.session.encodedProjectDir, item.session.sessionId);
        if (includedLayers.includes("subagents")) {
            copyDirIfExists((0, node_path_1.join)(contBase, "subagents"), (0, node_path_1.join)(exportPath, "sessions", newSessionId, "subagents"));
        }
        if (includedLayers.includes("tool-results")) {
            copyDirIfExists((0, node_path_1.join)(contBase, "tool-results"), (0, node_path_1.join)(exportPath, "sessions", newSessionId, "tool-results"));
        }
        if (includedLayers.includes("file-history")) {
            copyDirIfExists((0, node_path_1.join)(configDir, "file-history", item.session.sessionId), (0, node_path_1.join)(exportPath, "file-history", newSessionId));
        }
        sessionManifests.push({
            sessionId: newSessionId,
            slug: item.session.slug,
            summary: `continuation of ${item.session.slug}`,
            createdAt: new Date().toISOString(),
            lastActiveAt: item.session.lastActiveAt,
            messageCount: entryCount,
            gitBranch: item.session.gitBranch,
            entrypoint: item.session.entrypoint,
            integrityHash,
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
            copyDirIfExists(memoryDir, (0, node_path_1.join)(exportPath, "memory"));
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