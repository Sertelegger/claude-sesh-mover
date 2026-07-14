"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rewriteString = rewriteString;
exports.buildPathMappings = buildPathMappings;
exports.rewriteEntry = rewriteEntry;
exports.rewriteJsonl = rewriteJsonl;
const platform_js_1 = require("./platform.js");
// Characters that terminate a path token embedded in free text.
const UNIX_TOKEN = /(?:\/[A-Za-z0-9._@+~-]+)+\/?/g;
const WIN_TOKEN = /[A-Za-z]:\\[^\s"'`)\]}>,;]*/g;
const TAIL = /[^\s"'`)\]}>,;:]*/;
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalizeSeparators(tail, targetPlatform) {
    return targetPlatform === "win32"
        ? tail.replace(/\//g, "\\")
        : tail.replace(/\\/g, "/");
}
function rewriteString(input, ctx) {
    const crossFamily = !(0, platform_js_1.samePlatformFamily)(ctx.sourcePlatform, ctx.targetPlatform);
    let result = input;
    // Stage 1: exact mappings (project path, config dir, home), longest first.
    // Cross-family, the tail after the replacement gets its separators
    // normalized up to a token boundary; same-family tails are left alone.
    for (const mapping of ctx.mappings) {
        const re = new RegExp(escapeRegex(mapping.from) + "(" + TAIL.source + ")", "g");
        result = result.replace(re, (_m, tail) => mapping.to + (crossFamily ? normalizeSeparators(tail, ctx.targetPlatform) : tail));
    }
    // Stage 2 (cross-family only): translate remaining path-like tokens through
    // the platform engine (/mnt/<drive>, /tmp, /home, /Users, drive letters).
    if (crossFamily) {
        const tokenRe = ctx.sourcePlatform === "win32" ? WIN_TOKEN : UNIX_TOKEN;
        result = result.replace(tokenRe, (token) => (0, platform_js_1.translatePath)(token, ctx.sourcePlatform, ctx.targetPlatform, {
            sourceUser: ctx.sourceUser,
            targetUser: ctx.targetUser,
        }));
    }
    return result;
}
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
function rewriteEntry(entry, ctx, newSessionId) {
    const result = structuredClone(entry);
    // Rewrite sessionId
    if (newSessionId) {
        result.sessionId = newSessionId;
    }
    // Rewrite cwd (always)
    if (typeof result.cwd === "string") {
        result.cwd = rewriteString(result.cwd, ctx);
    }
    // Rewrite tool_result content and toolUseResult for user entries
    if (result.type === "user" && result.message) {
        const msg = result.message;
        if (Array.isArray(msg.content)) {
            msg.content = msg.content.map((item) => {
                if (item.type === "tool_result" && typeof item.content === "string") {
                    return { ...item, content: rewriteString(item.content, ctx) };
                }
                if (item.type === "tool_result" && Array.isArray(item.content)) {
                    return {
                        ...item,
                        content: item.content.map((block) => block?.type === "text" && typeof block.text === "string"
                            ? { ...block, text: rewriteString(block.text, ctx) }
                            : block),
                    };
                }
                return item;
            });
        }
        // Do NOT rewrite plain string user message content
        // Rewrite toolUseResult stdout/stderr
        if (result.toolUseResult) {
            const tr = result.toolUseResult;
            if (typeof tr.stdout === "string") {
                tr.stdout = rewriteString(tr.stdout, ctx);
            }
            if (typeof tr.stderr === "string") {
                tr.stderr = rewriteString(tr.stderr, ctx);
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
                const newKey = rewriteString(key, ctx);
                newBackups[newKey] = value;
            }
            snapshot.trackedFileBackups = newBackups;
        }
    }
    return result;
}
function rewriteJsonl(jsonlContent, ctx, newSessionId) {
    const lines = jsonlContent.trim().split("\n").filter(Boolean);
    let entriesRewritten = 0;
    let fieldsRewritten = 0;
    const warnings = [];
    const rewrittenLines = lines.map((line) => {
        try {
            const entry = JSON.parse(line);
            const original = JSON.stringify(entry);
            const rewritten = rewriteEntry(entry, ctx, newSessionId);
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
            mappings: ctx.mappings,
            entriesRewritten,
            fieldsRewritten,
            warnings,
        },
    };
}
//# sourceMappingURL=rewriter.js.map