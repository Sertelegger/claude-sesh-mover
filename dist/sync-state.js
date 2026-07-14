"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncStatePath = syncStatePath;
exports.readSyncState = readSyncState;
exports.writeSyncState = writeSyncState;
exports.recordSentFromBundle = recordSentFromBundle;
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const platform_js_1 = require("./platform.js");
const manifest_js_1 = require("./manifest.js");
const jsonl_js_1 = require("./jsonl.js");
function syncStatePath(projectPath) {
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude-sesh-mover", "sync-state", `${(0, platform_js_1.encodeProjectPath)(projectPath)}.json`);
}
function defaultState(projectPath) {
    return {
        projectPath,
        schemaVersion: 1,
        peers: {},
        lineage: {},
        imported: {},
    };
}
function readSyncState(projectPath) {
    const p = syncStatePath(projectPath);
    if (!(0, node_fs_1.existsSync)(p))
        return defaultState(projectPath);
    let raw;
    try {
        raw = (0, node_fs_1.readFileSync)(p, "utf-8");
    }
    catch {
        return defaultState(projectPath);
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed.schemaVersion !== 1 ||
            parsed.peers === null ||
            typeof parsed.peers !== "object" ||
            parsed.lineage === null ||
            typeof parsed.lineage !== "object") {
            throw new Error("schema mismatch");
        }
        parsed.imported = parsed.imported ?? {};
        return parsed;
    }
    catch {
        const aside = `${p}.corrupt.${Date.now()}`;
        try {
            (0, node_fs_1.renameSync)(p, aside);
        }
        catch {
            /* best effort */
        }
        return defaultState(projectPath);
    }
}
function writeSyncState(state) {
    const p = syncStatePath(state.projectPath);
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(p), { recursive: true });
    const tmp = `${p}.tmp`;
    (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
    (0, node_fs_1.renameSync)(tmp, p);
}
function recordSentFromBundle(projectPath, peer, bundleDir) {
    const state = readSyncState(projectPath);
    if (!state.peers[peer.id]) {
        state.peers[peer.id] = {
            name: peer.name ?? peer.id,
            lastSentAt: null,
            lastReceivedAt: null,
            sent: {},
            received: {},
        };
    }
    const p = state.peers[peer.id];
    p.lastSentAt = new Date().toISOString();
    if (peer.name)
        p.name = peer.name;
    const manifest = (0, manifest_js_1.readManifest)(bundleDir);
    for (const s of manifest.sessions) {
        const localSessionId = s.type === "continuation" && s.continuation
            ? s.continuation.continuesLocalSessionId
            : s.sessionId;
        // Head uuid comes from the BUNDLE's snapshot, never the live JSONL:
        // entries appended mid-export stay "unsent" and ship next sync.
        const headUuid = (0, jsonl_js_1.readLastEntryUuid)((0, node_path_1.join)(bundleDir, "sessions", `${s.sessionId}.jsonl`)) ?? "";
        p.sent[localSessionId] = {
            headEntryUuid: headUuid,
            messageCount: s.messageCount,
            sentAsType: s.type === "continuation" ? "continuation" : "full",
            sentAsSessionId: s.sessionId,
        };
    }
    writeSyncState(state);
}
//# sourceMappingURL=sync-state.js.map