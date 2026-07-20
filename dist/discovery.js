import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodeProjectPath } from "./platform.js";
import { readFirstJsonlLine, readLastJsonlLine, countJsonlLines, } from "./jsonl.js";
export function discoverSessions(configDir, projectPath) {
    const encoded = encodeProjectPath(projectPath);
    const projectDir = join(configDir, "projects", encoded);
    if (!existsSync(projectDir)) {
        return [];
    }
    const sessions = [];
    const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
        const sessionId = file.replace(".jsonl", "");
        const jsonlPath = join(projectDir, file);
        const session = parseSessionJsonl(jsonlPath, sessionId, projectPath, encoded, configDir);
        if (session) {
            sessions.push(session);
        }
    }
    return sessions.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
}
export function discoverSessionById(configDir, sessionId) {
    const projectsDir = join(configDir, "projects");
    if (!existsSync(projectsDir))
        return null;
    const projectDirs = readdirSync(projectsDir);
    for (const encoded of projectDirs) {
        const jsonlPath = join(projectsDir, encoded, `${sessionId}.jsonl`);
        if (existsSync(jsonlPath)) {
            // Read actual project path from JSONL (encoding is lossy, cannot decode)
            const projectPath = readProjectPathFromJsonl(jsonlPath) ?? encoded;
            const session = parseSessionJsonl(jsonlPath, sessionId, projectPath, encoded, configDir);
            return session;
        }
    }
    return null;
}
export function listAllProjects(configDir) {
    const projectsDir = join(configDir, "projects");
    if (!existsSync(projectsDir))
        return [];
    const dirs = readdirSync(projectsDir);
    const projects = [];
    for (const encoded of dirs) {
        const dirPath = join(projectsDir, encoded);
        if (!statSync(dirPath).isDirectory())
            continue;
        const jsonlFiles = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
        if (jsonlFiles.length > 0) {
            // Read actual project path from first session's JSONL (lossy encoding, cannot decode)
            const firstJsonl = join(dirPath, jsonlFiles[0]);
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
    const firstLine = readFirstJsonlLine(jsonlPath);
    if (!firstLine)
        return null;
    try {
        return JSON.parse(firstLine).cwd ?? null;
    }
    catch {
        return null;
    }
}
function parseSessionJsonl(jsonlPath, sessionId, projectPath, encodedProjectDir, configDir) {
    try {
        const firstLine = readFirstJsonlLine(jsonlPath);
        if (!firstLine)
            return null;
        let firstEntry;
        try {
            firstEntry = JSON.parse(firstLine);
        }
        catch {
            return null;
        }
        const lastLine = readLastJsonlLine(jsonlPath);
        let lastEntry = firstEntry;
        if (lastLine) {
            try {
                lastEntry = JSON.parse(lastLine);
            }
            catch {
                /* keep firstEntry as fallback */
            }
        }
        const messageCount = countJsonlLines(jsonlPath);
        if (messageCount === 0)
            return null;
        // Check for subagents
        const sessionSubDir = join(configDir, "projects", encodedProjectDir, sessionId, "subagents");
        const hasSubagents = existsSync(sessionSubDir) && readdirSync(sessionSubDir).length > 0;
        // Check for tool results
        const toolResultsDir = join(configDir, "projects", encodedProjectDir, sessionId, "tool-results");
        const hasToolResults = existsSync(toolResultsDir) && readdirSync(toolResultsDir).length > 0;
        // Check for file history
        const fileHistoryDir = join(configDir, "file-history", sessionId);
        const hasFileHistory = existsSync(fileHistoryDir) && readdirSync(fileHistoryDir).length > 0;
        return {
            sessionId,
            projectPath,
            encodedProjectDir,
            jsonlPath,
            slug: firstEntry.slug || sessionId,
            createdAt: firstEntry.timestamp,
            lastActiveAt: lastEntry.timestamp,
            messageCount,
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