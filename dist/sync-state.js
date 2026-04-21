"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncStatePath = syncStatePath;
exports.readSyncState = readSyncState;
exports.writeSyncState = writeSyncState;
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const platform_js_1 = require("./platform.js");
function syncStatePath(projectPath) {
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude-sesh-mover", "sync-state", `${(0, platform_js_1.encodeProjectPath)(projectPath)}.json`);
}
function defaultState(projectPath) {
    return {
        projectPath,
        schemaVersion: 1,
        peers: {},
        lineage: {},
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
//# sourceMappingURL=sync-state.js.map