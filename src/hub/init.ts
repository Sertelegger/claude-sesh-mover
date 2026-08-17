import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createFsBackend } from "./backend.js";
import { withHubIoTimeout } from "./io-timeout.js";
import { HUB_JSON, machinePath, type HubJson, type HubMachineJson } from "./layout.js";
import { loadOrCreateMachineId } from "../machine.js";
import { detectPlatform } from "../platform.js";
import { readConfigOverrides, writeConfigOverrides, setConfigOverride } from "../config.js";
import type { ErrorResult, HubInitResult, SeshMoverConfig, StorageScope } from "../types.js";
import { projectSeshMoverDir, userSeshMoverDir } from "../paths.js";

export function resolveHubPath(config: SeshMoverConfig): string | null {
  return config.hub.path ? config.hub.path : null;
}

// Refresh this machine's registration file. Called by init and by every
// push/pull (cheap single-file write, owned solely by this machine).
export async function registerMachine(hubPath: string): Promise<HubMachineJson> {
  const backend = createFsBackend(hubPath);
  const identity = loadOrCreateMachineId();
  const record: HubMachineJson = {
    id: identity.id,
    name: identity.name,
    platform: detectPlatform(),
    lastSeenAt: new Date().toISOString(),
  };
  await backend.writeAtomic(machinePath(identity.id), JSON.stringify(record, null, 2) + "\n");
  return record;
}

export async function hubInit(opts: {
  hubPath: string;
  configScope: "user" | "project";
  cwd: string;
}): Promise<HubInitResult | ErrorResult> {
  const hubPath = resolve(opts.hubPath);
  try {
    // The ONE hub syscall in this codebase that does not go through
    // `HubBackend` — it has to, because it is what creates the directory the
    // backend is then pointed at. It gets the same bound for the same reason
    // (#71): on a hung mount a synchronous `mkdirSync` here blocked forever
    // before any backend existed to be non-blocking, which would have left a
    // hole in the fix exactly where `hub init` is most likely to be run (a
    // share the user is still setting up).
    await withHubIoTimeout("mkdir", () => mkdir(hubPath, { recursive: true }));
  } catch (e) {
    return {
      success: false,
      command: "hub-init",
      error: `Cannot create hub directory ${hubPath}: ${(e as Error).message}`,
      suggestion: "Check that the path is writable (network share mounted, sync folder present).",
    };
  }

  const backend = createFsBackend(hubPath);
  let created = false;
  let hub: HubJson;
  if (await backend.exists(HUB_JSON)) {
    try {
      hub = JSON.parse((await backend.read(HUB_JSON)).toString()) as HubJson;
      if (hub.schemaVersion !== 1 || !hub.hubId) throw new Error("unrecognized hub.json shape");
    } catch (e) {
      return {
        success: false,
        command: "hub-init",
        error: `Existing hub.json is not readable: ${(e as Error).message}`,
        suggestion: "Point --path at an empty directory or a valid sesh-mover hub.",
      };
    }
  } else {
    hub = { schemaVersion: 1, hubId: randomUUID(), createdAt: new Date().toISOString() };
    await backend.writeAtomic(HUB_JSON, JSON.stringify(hub, null, 2) + "\n");
    created = true;
  }

  await registerMachine(hubPath);

  const configDir =
    opts.configScope === "project"
      ? projectSeshMoverDir(opts.cwd)
      : userSeshMoverDir();
  // Overrides, not a defaults-backfilled config: `hub init --scope project`
  // writing every default into the project file would pin them over the user
  // scope for this project (the same defect the `configure --set` path had).
  writeConfigOverrides(
    configDir,
    setConfigOverride(readConfigOverrides(configDir), "hub.path", hubPath)
  );

  return {
    success: true,
    command: "hub-init",
    hubPath,
    hubId: hub.hubId,
    created,
    machineRegistered: true,
    configScope: opts.configScope as StorageScope,
  };
}
