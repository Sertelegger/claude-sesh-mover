import { createFsBackend } from "./backend.js";
import { HUB_JSON, machinePath } from "./layout.js";
import { resolveHubPath } from "./init.js";
import { readMachineId } from "../machine.js";
import { computeEffectiveConfig } from "../config.js";
import { readLocalProjectId } from "./identity.js";
import { peekSyncState } from "../sync-state.js";
import { projectSeshMoverDir, userDirWarnings, userSeshMoverDir } from "../paths.js";
export async function hubStatus(opts) {
    const warnings = [];
    // The one-time `~/.claude-sesh-mover` -> `~/.sesh-mover` move, or the reason
    // it did not happen. Surfaced here and on push because those are the two
    // commands a hub user runs; the resolution itself is memoized, so this is a
    // field read rather than a second filesystem probe.
    warnings.push(...userDirWarnings());
    const config = computeEffectiveConfig(userSeshMoverDir(), projectSeshMoverDir(opts.cwd));
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
    let hubId = null;
    let reachable = false;
    try {
        if (await backend.exists(HUB_JSON)) {
            hubId = JSON.parse((await backend.read(HUB_JSON)).toString()).hubId;
            reachable = true;
        }
        else {
            warnings.push(`hub.path is set (${hubPath}) but hub.json is missing — run hub init.`);
        }
    }
    catch (e) {
        warnings.push(`hub not reachable: ${e.message}`);
    }
    const identity = readMachineId();
    const machineRegistered = reachable && identity !== null && (await backend.exists(machinePath(identity.id)));
    const machinesKnown = reachable ? (await backend.list("machines")).length : 0;
    const local = readLocalProjectId(opts.cwd);
    // The auto-push breadcrumb (see SyncState.hub.lastAutoPush). peekSyncState,
    // not readSyncState: `hub status` is documented read-only, and readSyncState
    // renames a corrupt file aside — a write.
    const lastAutoPush = peekSyncState(opts.cwd).hub?.lastAutoPush;
    if (lastAutoPush && !lastAutoPush.ok) {
        warnings.push(`The last automatic push for this project (${lastAutoPush.at}) failed: ${lastAutoPush.notes[0] ?? "no detail recorded"}. Session-end pushes run detached and their output is not shown, so this is the only place it is reported.`);
    }
    else if (lastAutoPush && lastAutoPush.noteCount > 0) {
        // Surfaced as a warning, not just a field, because the notes it carries are
        // disclosures the user was promised in the push's own output and never got
        // (a `.env` that git tracks travels in the patch, and the auto-push says so
        // to a stderr nobody reads).
        warnings.push(`The last automatic push for this project (${lastAutoPush.at}) reported ${lastAutoPush.noteCount} warning(s) that session end could not show you: ${lastAutoPush.notes.join(" | ")}`);
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
//# sourceMappingURL=status.js.map