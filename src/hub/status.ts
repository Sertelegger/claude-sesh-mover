import { join } from "node:path";
import { createFsBackend, type HubBackend } from "./backend.js";
import { HUB_JSON, machinePath, type HubJson } from "./layout.js";
import { resolveHubPath } from "./init.js";
import { readMachineId } from "../machine.js";
import { computeEffectiveConfig } from "../config.js";
import { readLocalProjectId } from "./identity.js";
import { peekSyncState } from "../sync-state.js";
import { projectSeshMoverDir, userSeshMoverDir } from "../paths.js";
import type { HubStatusResult } from "../types.js";

/**
 * How many machines this hub knows about (#28) — `machines/<id>.json`, counted
 * the way `readAllIndexes` counts `index/<id>.json`, and for the identical
 * reason.
 *
 * `backend.list` walks RECURSIVELY and filters only `.tmp-` in a basename, so
 * `(await backend.list("machines")).length` was every file underneath
 * `machines/`. The hub is documented as a shared or synced directory, which
 * makes foreign entries the EXPECTED case rather than a hostile one: a
 * Syncthing `.stversions/` directory added one per RETAINED VERSION of a single
 * machine's record; a `.DS_Store`, a `Thumbs.db`, an editor swap file or a
 * `~syncthing~…tmp` each added one. The displayed count then said
 * more machines had joined the hub than ever had — silently, with no way for a
 * reader to tell.
 *
 * Immediate `.json` children only, deduped by the id the filename carries. The
 * dedupe is what a plain `.endsWith(".json")` filter would still get wrong on a
 * Dropbox conflict copy (`machines/<name>'s conflicted copy 2026-08-03/<id>.json`)
 * — that is nested, so the immediate-children rule already excludes it, and the
 * `seen` set is the belt for a future backend whose `list` is a flat prefix
 * listing over an object store with no real directories.
 *
 * Deliberately does NOT read or validate the files: this is a count for a
 * status line, and a machine record that is present but corrupt is still a
 * machine that joined. `isSafeSessionId` is not applied either — nothing here
 * turns the name into a path (contrast `readAllIndexes`, which does).
 */
async function countKnownMachines(backend: HubBackend): Promise<number> {
  const prefix = "machines/";
  const seen = new Set<string>();
  for (const file of await backend.list("machines")) {
    if (!file.startsWith(prefix)) continue;
    const name = file.slice(prefix.length);
    if (name.includes("/")) continue;
    if (!name.endsWith(".json")) continue;
    seen.add(name.slice(0, -".json".length));
  }
  return seen.size;
}

export async function hubStatus(opts: { cwd: string }): Promise<HubStatusResult> {
  const warnings: string[] = [];
  const config = computeEffectiveConfig(
    userSeshMoverDir(),
    projectSeshMoverDir(opts.cwd)
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
  const machinesKnown = reachable ? await countKnownMachines(backend) : 0;

  const local = readLocalProjectId(opts.cwd);

  // The auto-push breadcrumb (see SyncState.hub.lastAutoPush). peekSyncState,
  // not readSyncState: `hub status` is documented read-only, and readSyncState
  // renames a corrupt file aside — a write.
  const lastAutoPush = peekSyncState(opts.cwd).hub?.lastAutoPush;
  if (lastAutoPush && !lastAutoPush.ok) {
    warnings.push(
      `The last automatic push for this project (${lastAutoPush.at}) failed: ${lastAutoPush.notes[0] ?? "no detail recorded"}. Session-end pushes run detached and their output is not shown, so this is the only place it is reported.`
    );
  } else if (lastAutoPush && lastAutoPush.noteCount > 0) {
    // Surfaced as a warning, not just a field, because the notes it carries are
    // disclosures the user was promised in the push's own output and never got
    // (a `.env` that git tracks travels in the patch, and the auto-push says so
    // to a stderr nobody reads).
    warnings.push(
      `The last automatic push for this project (${lastAutoPush.at}) reported ${lastAutoPush.noteCount} warning(s) that session end could not show you: ${lastAutoPush.notes.join(" | ")}`
    );
  }

  return {
    success: true,
    command: "hub-status",
    hubPath,
    reachable,
    hubId,
    machineRegistered,
    machinesKnown,
    project: { linked: local !== null, projectId: local?.projectId ?? null },
    ...(lastAutoPush ? { lastAutoPush } : {}),
    warnings,
  };
}
