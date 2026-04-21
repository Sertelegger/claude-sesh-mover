"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readMachineId = readMachineId;
exports.loadOrCreateMachineId = loadOrCreateMachineId;
exports.setMachineName = setMachineName;
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
function machineIdPath() {
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude-sesh-mover", "machine-id.json");
}
function readMachineId() {
    const p = machineIdPath();
    if (!(0, node_fs_1.existsSync)(p))
        return null;
    try {
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(p, "utf-8"));
        if (!parsed.id || !parsed.name || !parsed.createdAt)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function loadOrCreateMachineId() {
    const existing = readMachineId();
    if (existing)
        return existing;
    const identity = {
        id: (0, node_crypto_1.randomUUID)(),
        name: (0, node_os_1.hostname)() || "unknown",
        createdAt: new Date().toISOString(),
    };
    const p = machineIdPath();
    (0, node_fs_1.mkdirSync)((0, node_path_1.join)((0, node_os_1.homedir)(), ".claude-sesh-mover"), { recursive: true });
    (0, node_fs_1.writeFileSync)(p, JSON.stringify(identity, null, 2) + "\n", "utf-8");
    return identity;
}
function setMachineName(name) {
    const identity = loadOrCreateMachineId();
    identity.name = name;
    (0, node_fs_1.writeFileSync)(machineIdPath(), JSON.stringify(identity, null, 2) + "\n", "utf-8");
    return identity;
}
//# sourceMappingURL=machine.js.map