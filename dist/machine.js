import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
function machineIdPath() {
    return join(homedir(), ".claude-sesh-mover", "machine-id.json");
}
export function readMachineId() {
    const p = machineIdPath();
    if (!existsSync(p))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(p, "utf-8"));
        if (!parsed.id || !parsed.name || !parsed.createdAt)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
export function loadOrCreateMachineId() {
    const existing = readMachineId();
    if (existing)
        return existing;
    const identity = {
        id: randomUUID(),
        name: hostname() || "unknown",
        createdAt: new Date().toISOString(),
    };
    const p = machineIdPath();
    mkdirSync(join(homedir(), ".claude-sesh-mover"), { recursive: true });
    writeFileSync(p, JSON.stringify(identity, null, 2) + "\n", "utf-8");
    return identity;
}
export function setMachineName(name) {
    const identity = loadOrCreateMachineId();
    identity.name = name;
    writeFileSync(machineIdPath(), JSON.stringify(identity, null, 2) + "\n", "utf-8");
    return identity;
}
//# sourceMappingURL=machine.js.map