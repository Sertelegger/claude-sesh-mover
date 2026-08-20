import { createFsBackend } from "./backend.js";
import { machinePath } from "./layout.js";
import { listMachineIds } from "./machines.js";
import { describeHubUnreachable, probeHubReachable } from "./preflight.js";
import { resolveHubPath } from "./init.js";
import { readLockStealRecord } from "./lock.js";
import { readMachineId } from "../machine.js";
import { computeEffectiveConfig } from "../config.js";
import { readLocalProjectId } from "./identity.js";
import { peekSyncState } from "../sync-state.js";
import { projectSeshMoverDir, userSeshMoverDir } from "../paths.js";
/**
 * How many machines this hub knows about (#28).
 *
 * **The enumeration rule itself now lives in `machines.ts`**, shared with the
 * recipient list (`encryption.ts`). It used to be private here, and the moment a
 * second reader needed the same question the private copy became the kind of
 * thing that ends up implemented twice: a hub where `hub status` says three
 * machines and the recipient list encrypts to two is a hub where one machine
 * silently cannot read anything. One rule, two callers.
 *
 * What stays here is what is specific to a COUNT for a status line: the ids are
 * neither read nor validated, because a machine record that is present but
 * corrupt is still a machine that joined, and nothing here turns a name into a
 * path (contrast `readMachineRecord`, which does and so checks).
 */
async function countKnownMachines(backend) {
    return (await listMachineIds(backend)).length;
}
/**
 * Report the hub's state; never refuse on it.
 *
 * **`hub status` deliberately does NOT return `hub-unreachable`** (#75's gate is
 * wired into push, pull and `hub reindex` instead). The argument is not that
 * status is unimportant — it is that the refusal would answer a different
 * question than the one asked. A user runs this command *to find out* whether
 * the hub is reachable; a `success: false` whose whole content is "the hub is
 * unreachable" would make the command fail in exactly the situation it exists
 * to describe, and would take `hubPath`, `machineRegistered`, `project.linked`
 * and `lastAutoPush` down with it — every one of which is still knowable, and
 * three of which are answers the user needs precisely *then*. `lastAutoPush` is
 * the sharpest: an unreachable hub is the commonest cause of a failed unattended
 * push, and this result is the only surviving record of one.
 *
 * What it takes from the gate is the CLASSIFICATION, not the refusal
 * (`probeHubReachable`). That is not tidiness either: `reachable` used to mean
 * "hub.json exists", so a `hub.json` carrying no `hubId` — what a sync client
 * mid-copy actually leaves behind — reported `reachable: true, hubId: undefined`
 * here while push and pull refused the same directory as `not-a-hub`. The two
 * now answer from one probe and cannot disagree.
 */
export async function hubStatus(opts) {
    const warnings = [];
    const config = computeEffectiveConfig(userSeshMoverDir(), projectSeshMoverDir(opts.cwd));
    const hubPath = resolveHubPath(config);
    if (!hubPath) {
        return {
            success: true,
            command: "hub-status",
            hubPath: null,
            reachable: false,
            // Not `no-directory`: nothing was probed, because no path was configured.
            // Telling a user who has never run `hub init` to check whether a share is
            // mounted is the wrong remedy for the right-sounding word.
            hubState: null,
            hubId: null,
            machineRegistered: false,
            machinesKnown: 0,
            project: { linked: false, projectId: null },
            warnings,
        };
    }
    const backend = createFsBackend(hubPath);
    const probe = await probeHubReachable(hubPath, backend);
    const reachable = probe.state === "ok";
    const hubId = probe.hub?.hubId ?? null;
    if (!reachable) {
        // The gate's own wording, verbatim, so the diagnosis a refused push gave
        // and the one `hub status` gives are the same sentence about the same
        // directory. Deliberately no "run hub init" here, which the message it
        // replaces said for BOTH states: for `no-directory` that advice would have
        // the user mint a brand-new hub at an unmounted mount point — a different
        // hubId, shadowing the real hub the moment it mounts.
        warnings.push(describeHubUnreachable(probe.state));
    }
    const identity = readMachineId();
    const machineRegistered = reachable && identity !== null && (await backend.exists(machinePath(identity.id)));
    const machinesKnown = reachable ? await countKnownMachines(backend) : 0;
    const local = readLocalProjectId(opts.cwd);
    // The auto-push breadcrumb (see SyncState.hub.lastAutoPush). peekSyncState,
    // not readSyncState: `hub status` is documented read-only, and readSyncState
    // renames a corrupt file aside — a write.
    const lastAutoPush = peekSyncState(opts.cwd).hub?.lastAutoPush;
    // The lock-steal record (#84). Read here because both parties to a steal are
    // badly placed to report it themselves: the thief's warning rides on whatever
    // verb it ran (a session-end push has closed stdout), and the victim no longer
    // holds the lock `recordAutoPushOutcome` re-takes, so its note is dropped in
    // exactly the case worth recording. Reading is a plain file read and holds no
    // lock, which keeps `status` read-only as documented.
    const lastLockSteal = readLockStealRecord(opts.cwd);
    if (lastLockSteal && lastLockSteal.kind !== "dead-holder") {
        warnings.push(`Another sesh-mover process took this project's lock at ${lastLockSteal.at} from a holder that was ${lastLockSteal.kind === "live-holder-past-ceiling" ? "still running" : "not identifiable"} (pid ${lastLockSteal.holderPid ?? "unknown"}), after it held the lock past the safety ceiling.` +
            (lastLockSteal.noticedByHolderAt
                ? ` That holder has since finished and noticed at ${lastLockSteal.noticedByHolderAt}.`
                : ` That holder has NOT been seen to finish, so it may still be writing this project's hub state.`));
    }
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
        hubState: probe.state,
        hubId,
        machineRegistered,
        machinesKnown,
        project: { linked: local !== null, projectId: local?.projectId ?? null },
        ...(lastAutoPush ? { lastAutoPush } : {}),
        ...(lastLockSteal ? { lastLockSteal } : {}),
        warnings,
    };
}
//# sourceMappingURL=status.js.map