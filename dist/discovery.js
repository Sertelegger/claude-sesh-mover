"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverSessions = discoverSessions;
exports.discoverSessionById = discoverSessionById;
exports.listAllProjects = listAllProjects;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const platform_js_1 = require("./platform.js");
function discoverSessions(configDir, projectPath) {
    const encoded = (0, platform_js_1.encodeProjectPath)(projectPath);
    const projectDir = (0, node_path_1.join)(configDir, "projects", encoded);
    if (!(0, node_fs_1.existsSync)(projectDir)) {
        return [];
    }
    const sessions = [];
    const files = (0, node_fs_1.readdirSync)(projectDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
        const sessionId = file.replace(".jsonl", "");
        const jsonlPath = (0, node_path_1.join)(projectDir, file);
        const session = parseSessionJsonl(jsonlPath, sessionId, projectPath, encoded, configDir);
        if (session) {
            sessions.push(session);
        }
    }
    return sessions.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
}
function discoverSessionById(configDir, sessionId) {
    const projectsDir = (0, node_path_1.join)(configDir, "projects");
    if (!(0, node_fs_1.existsSync)(projectsDir))
        return null;
    const projectDirs = (0, node_fs_1.readdirSync)(projectsDir);
    for (const encoded of projectDirs) {
        const jsonlPath = (0, node_path_1.join)(projectsDir, encoded, `${sessionId}.jsonl`);
        if ((0, node_fs_1.existsSync)(jsonlPath)) {
            // Read actual project path from JSONL (encoding is lossy, cannot decode)
            const projectPath = readProjectPathFromJsonl(jsonlPath) ?? encoded;
            const session = parseSessionJsonl(jsonlPath, sessionId, projectPath, encoded, configDir);
            return session;
        }
    }
    return null;
}
function listAllProjects(configDir) {
    const projectsDir = (0, node_path_1.join)(configDir, "projects");
    if (!(0, node_fs_1.existsSync)(projectsDir))
        return [];
    const dirs = (0, node_fs_1.readdirSync)(projectsDir);
    const projects = [];
    for (const encoded of dirs) {
        const dirPath = (0, node_path_1.join)(projectsDir, encoded);
        if (!(0, node_fs_1.statSync)(dirPath).isDirectory())
            continue;
        const jsonlFiles = (0, node_fs_1.readdirSync)(dirPath).filter((f) => f.endsWith(".jsonl"));
        if (jsonlFiles.length > 0) {
            // Read actual project path from first session's JSONL (lossy encoding, cannot decode)
            const firstJsonl = (0, node_path_1.join)(dirPath, jsonlFiles[0]);
            const projectPath = readProjectPathFromJsonl(firstJsonl) ?? encoded;
            projects.push({
                projectPath,
                encodedDir: encoded,
                sessionCount: jsonlFiles.length,
            });
        }
    }
    return projects;
}
/**
 * Read the actual project path from a JSONL file by finding the first entry with a cwd field.
 * This is necessary because the directory encoding (/ -> -) is lossy for hyphenated paths.
 */
function readProjectPathFromJsonl(jsonlPath) {
    try {
        const fd = (0, node_fs_1.openSync)(jsonlPath, 'r');
        const buf = Buffer.alloc(4096); // first 4KB should contain the first line
        let bytesRead;
        try {
            bytesRead = (0, node_fs_1.readSync)(fd, buf, 0, 4096, 0);
        }
        finally {
            (0, node_fs_1.closeSync)(fd);
        }
        const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
        if (!firstLine)
            return null;
        const entry = JSON.parse(firstLine);
        return entry.cwd ?? null;
    }
    catch {
        return null;
    }
}
function parseSessionJsonl(jsonlPath, sessionId, projectPath, encodedProjectDir, configDir) {
    try {
        // Performance note: reads entire file. For very large sessions (100MB+),
        // consider streaming approach that reads first line, counts newlines, reads last line.
        const raw = (0, node_fs_1.readFileSync)(jsonlPath, "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean);
        if (lines.length === 0)
            return null;
        const entries = lines.map((line) => JSON.parse(line));
        const firstEntry = entries[0];
        const lastEntry = entries[entries.length - 1];
        // Check for subagents
        const sessionSubDir = (0, node_path_1.join)(configDir, "projects", encodedProjectDir, sessionId, "subagents");
        const hasSubagents = (0, node_fs_1.existsSync)(sessionSubDir) && (0, node_fs_1.readdirSync)(sessionSubDir).length > 0;
        // Check for tool results
        const toolResultsDir = (0, node_path_1.join)(configDir, "projects", encodedProjectDir, sessionId, "tool-results");
        const hasToolResults = (0, node_fs_1.existsSync)(toolResultsDir) && (0, node_fs_1.readdirSync)(toolResultsDir).length > 0;
        // Check for file history
        const fileHistoryDir = (0, node_path_1.join)(configDir, "file-history", sessionId);
        const hasFileHistory = (0, node_fs_1.existsSync)(fileHistoryDir) && (0, node_fs_1.readdirSync)(fileHistoryDir).length > 0;
        return {
            sessionId,
            projectPath,
            encodedProjectDir,
            jsonlPath,
            slug: firstEntry.slug || sessionId,
            createdAt: firstEntry.timestamp,
            lastActiveAt: lastEntry.timestamp,
            messageCount: entries.length,
            gitBranch: firstEntry.gitBranch || "unknown",
            entrypoint: firstEntry.entrypoint || "cli",
            hasSubagents,
            hasToolResults,
            hasFileHistory,
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=discovery.js.map