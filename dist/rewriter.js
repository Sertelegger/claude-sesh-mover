"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPathMappings = buildPathMappings;
exports.rewriteEntry = rewriteEntry;
exports.rewriteJsonl = rewriteJsonl;
const platform_js_1 = require("./platform.js");
function buildPathMappings(sourcePlatform, targetPlatform, sourceProjectPath, targetProjectPath, sourceConfigDir, targetConfigDir, sourceUser, targetUser) {
    const mappings = [];
    // Project path mapping (most specific first)
    if (sourceProjectPath !== targetProjectPath) {
        mappings.push({
            from: sourceProjectPath,
            to: targetProjectPath,
            description: `Project path: ${sourceProjectPath} -> ${targetProjectPath}`,
        });
    }
    // Config dir mapping
    if (sourceConfigDir !== targetConfigDir) {
        mappings.push({
            from: sourceConfigDir,
            to: targetConfigDir,
            description: `Config dir: ${sourceConfigDir} -> ${targetConfigDir}`,
        });
    }
    // Home dir mapping — cross-platform or same-platform different user
    if (!(0, platform_js_1.samePlatformFamily)(sourcePlatform, targetPlatform)) {
        const sourceHome = getHomePath(sourcePlatform, sourceUser);
        const targetHome = getHomePath(targetPlatform, targetUser);
        if (sourceHome !== targetHome) {
            mappings.push({
                from: sourceHome,
                to: targetHome,
                description: `Home dir: ${sourceHome} -> ${targetHome}`,
            });
        }
    }
    else if (sourceUser !== targetUser) {
        // Same platform family, different user
        const sourceHome = getHomePath(sourcePlatform, sourceUser);
        const targetHome = getHomePath(targetPlatform, targetUser);
        if (sourceHome !== targetHome) {
            mappings.push({
                from: sourceHome,
                to: targetHome,
                description: `User home: ${sourceHome} -> ${targetHome}`,
            });
        }
    }
    // Sort longest-from first to prevent prefix collisions
    mappings.sort((a, b) => b.from.length - a.from.length);
    return mappings;
}
function getHomePath(platform, user) {
    if (platform === "win32")
        return `C:\\Users\\${user}`;
    if (platform === "darwin")
        return `/Users/${user}`;
    return `/home/${user}`;
}
function rewriteEntry(entry, mappings, newSessionId) {
    const result = structuredClone(entry);
    // Rewrite sessionId
    if (newSessionId) {
        result.sessionId = newSessionId;
    }
    // Rewrite cwd (always)
    if (typeof result.cwd === "string") {
        result.cwd = applyMappings(result.cwd, mappings);
    }
    // Rewrite tool_result content and toolUseResult for user entries
    if (result.type === "user" && result.message) {
        const msg = result.message;
        if (Array.isArray(msg.content)) {
            msg.content = msg.content.map((item) => {
                if (item.type === "tool_result" && typeof item.content === "string") {
                    return { ...item, content: applyMappings(item.content, mappings) };
                }
                return item;
            });
        }
        // Do NOT rewrite plain string user message content
        // Rewrite toolUseResult stdout/stderr
        if (result.toolUseResult) {
            const tr = result.toolUseResult;
            if (typeof tr.stdout === "string") {
                tr.stdout = applyMappings(tr.stdout, mappings);
            }
            if (typeof tr.stderr === "string") {
                tr.stderr = applyMappings(tr.stderr, mappings);
            }
        }
    }
    // Rewrite file-history-snapshot trackedFileBackups keys
    if (result.type === "file-history-snapshot" && result.snapshot) {
        const snapshot = result.snapshot;
        if (snapshot.trackedFileBackups) {
            const backups = snapshot.trackedFileBackups;
            const newBackups = {};
            for (const [key, value] of Object.entries(backups)) {
                const newKey = applyMappings(key, mappings);
                newBackups[newKey] = value;
            }
            snapshot.trackedFileBackups = newBackups;
        }
    }
    return result;
}
function rewriteJsonl(jsonlContent, mappings, newSessionId) {
    const lines = jsonlContent.trim().split("\n").filter(Boolean);
    let entriesRewritten = 0;
    let fieldsRewritten = 0;
    const warnings = [];
    const rewrittenLines = lines.map((line) => {
        try {
            const entry = JSON.parse(line);
            const original = JSON.stringify(entry);
            const rewritten = rewriteEntry(entry, mappings, newSessionId);
            const rewrittenStr = JSON.stringify(rewritten);
            if (rewrittenStr !== original) {
                entriesRewritten++;
                // Count changed top-level fields (nested changes are attributed to their parent key)
                for (const key of Object.keys(entry)) {
                    if (JSON.stringify(entry[key]) !==
                        JSON.stringify(rewritten[key])) {
                        fieldsRewritten++;
                    }
                }
            }
            return rewrittenStr;
        }
        catch (e) {
            warnings.push(`Failed to parse JSONL line: ${e.message}`);
            return line; // preserve unparseable lines
        }
    });
    return {
        rewritten: rewrittenLines.join("\n") + "\n",
        report: {
            mappings,
            entriesRewritten,
            fieldsRewritten,
            warnings,
        },
    };
}
function applyMappings(input, mappings) {
    let result = input;
    for (const mapping of mappings) {
        // Use replaceAll to avoid infinite loop when mapping.to contains mapping.from
        result = result.replaceAll(mapping.from, mapping.to);
    }
    return result;
}
//# sourceMappingURL=rewriter.js.map