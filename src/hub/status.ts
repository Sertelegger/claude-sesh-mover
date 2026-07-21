import { homedir } from "node:os";
import { join } from "node:path";
import { createFsBackend } from "./backend.js";
import { HUB_JSON, machinePath, type HubJson } from "./layout.js";
import { resolveHubPath } from "./init.js";
import { readMachineId } from "../machine.js";
import { computeEffectiveConfig } from "../config.js";
import { readLocalProjectId } from "./identity.js";
import type { HubStatusResult } from "../types.js";

export async function hubStatus(opts: { cwd: string }): Promise<HubStatusResult> {
  const warnings: string[] = [];
  const config = computeEffectiveConfig(
    join(homedir(), ".claude-sesh-mover"),
    join(opts.cwd, ".claude-sesh-mover")
  );
  const hubPath = resolveHubPath(config);

  if (!hubPath) {
    return {
      success: true,
      command: "hub-status",
      hubPath: null,
      reachable: false,
      hubId: null,
      machineRegistered: false,
      machinesKnown: 0,
      project: { linked: false, projectId: null },
      warnings,
    };
  }

  const backend = createFsBackend(hubPath);
  let hubId: string | null = null;
  let reachable = false;
  try {
    if (await backend.exists(HUB_JSON)) {
      hubId = (JSON.parse((await backend.read(HUB_JSON)).toString()) as HubJson).hubId;
      reachable = true;
    } else {
      warnings.push(`hub.path is set (${hubPath}) but hub.json is missing — run hub init.`);
    }
  } catch (e) {
    warnings.push(`hub not reachable: ${(e as Error).message}`);
  }

  const identity = readMachineId();
  const machineRegistered =
    reachable && identity !== null && (await backend.exists(machinePath(identity.id)));
  const machinesKnown = reachable ? (await backend.list("machines")).length : 0;

  const local = readLocalProjectId(opts.cwd);
  return {
    success: true,
    command: "hub-status",
    hubPath,
    reachable,
    hubId,
    machineRegistered,
    machinesKnown,
    project: { linked: local !== null, projectId: local?.projectId ?? null },
    warnings,
  };
}
