import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createFsBackend } from "./backend.js";
import { HUB_JSON, machinePath } from "./layout.js";
import { loadOrCreateMachineId } from "../machine.js";
import { detectPlatform } from "../platform.js";
import { readConfig, writeConfig, setConfigValue } from "../config.js";
export function resolveHubPath(config) {
    return config.hub.path ? config.hub.path : null;
}
// Refresh this machine's registration file. Called by init and by every
// push/pull (cheap single-file write, owned solely by this machine).
export async function registerMachine(hubPath) {
    const backend = createFsBackend(hubPath);
    const identity = loadOrCreateMachineId();
    const record = {
        id: identity.id,
        name: identity.name,
        platform: detectPlatform(),
        lastSeenAt: new Date().toISOString(),
    };
    await backend.writeAtomic(machinePath(identity.id), JSON.stringify(record, null, 2) + "\n");
    return record;
}
export async function hubInit(opts) {
    const hubPath = resolve(opts.hubPath);
    try {
        mkdirSync(hubPath, { recursive: true });
    }
    catch (e) {
        return {
            success: false,
            command: "hub-init",
            error: `Cannot create hub directory ${hubPath}: ${e.message}`,
            suggestion: "Check that the path is writable (network share mounted, sync folder present).",
        };
    }
    const backend = createFsBackend(hubPath);
    let created = false;
    let hub;
    if (await backend.exists(HUB_JSON)) {
        try {
            hub = JSON.parse((await backend.read(HUB_JSON)).toString());
            if (hub.schemaVersion !== 1 || !hub.hubId)
                throw new Error("unrecognized hub.json shape");
        }
        catch (e) {
            return {
                success: false,
                command: "hub-init",
                error: `Existing hub.json is not readable: ${e.message}`,
                suggestion: "Point --path at an empty directory or a valid sesh-mover hub.",
            };
        }
    }
    else {
        hub = { schemaVersion: 1, hubId: randomUUID(), createdAt: new Date().toISOString() };
        await backend.writeAtomic(HUB_JSON, JSON.stringify(hub, null, 2) + "\n");
        created = true;
    }
    await registerMachine(hubPath);
    const configDir = opts.configScope === "project"
        ? join(opts.cwd, ".claude-sesh-mover")
        : join(homedir(), ".claude-sesh-mover");
    const config = setConfigValue(readConfig(configDir), "hub.path", hubPath);
    writeConfig(configDir, config);
    return {
        success: true,
        command: "hub-init",
        hubPath,
        hubId: hub.hubId,
        created,
        machineRegistered: true,
        configScope: opts.configScope,
    };
}
//# sourceMappingURL=init.js.map