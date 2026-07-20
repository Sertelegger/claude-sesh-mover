import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
const GENERIC_SLUGS = new Set(["new-session", "untitled", ""]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUMMARY_LENGTH = 100;
export function extractSummary(slug, entries) {
    // Try slug first
    if (slug && !GENERIC_SLUGS.has(slug) && !UUID_PATTERN.test(slug)) {
        return slug;
    }
    // Try first user message (string content)
    for (const entry of entries) {
        if (entry.type === "user") {
            const msg = entry.message;
            if (typeof msg.content === "string" && msg.content.trim()) {
                return truncate(msg.content.trim());
            }
        }
    }
    // Try first assistant text response
    for (const entry of entries) {
        if (entry.type === "assistant") {
            const msg = entry.message;
            if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    const b = block;
                    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
                        return truncate(b.text.trim());
                    }
                }
            }
        }
    }
    return "(no summary available)";
}
export function extractFirstExchanges(entries, maxEntries) {
    const result = [];
    for (const entry of entries) {
        if (entry.type === "user" || entry.type === "assistant") {
            result.push(entry);
            if (result.length >= maxEntries)
                break;
        }
    }
    return result;
}
function truncate(text) {
    if (text.length <= MAX_SUMMARY_LENGTH)
        return text;
    return text.slice(0, MAX_SUMMARY_LENGTH) + "...";
}
// Streaming twin of extractSummary: same precedence (slug → first user
// string-content message → first assistant text block → placeholder) with
// O(1) memory and early exit on the user-message match.
export async function extractSummaryFromFile(slug, jsonlPath) {
    if (slug && !GENERIC_SLUGS.has(slug) && !UUID_PATTERN.test(slug)) {
        return slug;
    }
    let firstAssistantText;
    const input = createReadStream(jsonlPath, { encoding: "utf-8" });
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            if (!line)
                continue;
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue;
            }
            const msg = entry.message;
            if (!msg)
                continue;
            if (entry.type === "user" && typeof msg.content === "string" && msg.content.trim()) {
                return truncate(msg.content.trim()); // user match wins — stop reading
            }
            if (entry.type === "assistant" && firstAssistantText === undefined && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    const b = block;
                    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
                        firstAssistantText = truncate(b.text.trim());
                        break;
                    }
                }
            }
        }
    }
    finally {
        rl.close();
        input.destroy();
    }
    return firstAssistantText ?? "(no summary available)";
}
//# sourceMappingURL=summary.js.map