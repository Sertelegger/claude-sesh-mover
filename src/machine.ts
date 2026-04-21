import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineIdentity } from "./types.js";

function machineIdPath(): string {
  return join(homedir(), ".claude-sesh-mover", "machine-id.json");
}

export function readMachineId(): MachineIdentity | null {
  const p = machineIdPath();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as MachineIdentity;
    if (!parsed.id || !parsed.name || !parsed.createdAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadOrCreateMachineId(): MachineIdentity {
  const existing = readMachineId();
  if (existing) return existing;
  const identity: MachineIdentity = {
    id: randomUUID(),
    name: hostname() || "unknown",
    createdAt: new Date().toISOString(),
  };
  const p = machineIdPath();
  mkdirSync(join(homedir(), ".claude-sesh-mover"), { recursive: true });
  writeFileSync(p, JSON.stringify(identity, null, 2) + "\n", "utf-8");
  return identity;
}

export function setMachineName(name: string): MachineIdentity {
  const identity = loadOrCreateMachineId();
  identity.name = name;
  writeFileSync(machineIdPath(), JSON.stringify(identity, null, 2) + "\n", "utf-8");
  return identity;
}
