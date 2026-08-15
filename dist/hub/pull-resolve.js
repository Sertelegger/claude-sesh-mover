import { HUB_JSON } from "./layout.js";
import { linkToHubProject, resolveProjectIdentity } from "./identity.js";
import { registerMachine } from "./init.js";
import { readAllIndexes } from "./index-file.js";
import { resolveThreads } from "./threads.js";
/**
 * The pull's first stage: settle which hub project this directory IS, announce
 * this machine to the hub, and read what every machine's index says about the
 * project's threads.
 *
 * **Nothing here is caught.** `linkToHubProject` (an unsafe `--project-id`, a
 * missing or corrupt project.json), `resolveProjectIdentity`, `registerMachine`,
 * the `HUB_JSON` read + parse (the realistic one: the configured hub path is not
 * a hub) and `readAllIndexes` all escape to `cli.ts`, which turns them into an
 * `ErrorResult`. A `try`/`catch` in this module would convert a mistyped hub
 * path into a confident, wrong answer.
 *
 * The project lock is the caller's: `hubPull` acquires it before calling this
 * and releases it in its own `finally`. This stage neither acquires, releases
 * nor inspects it — splitting ownership of a resource across that boundary is
 * how a wedged lock outlives its operation.
 *
 * `loadOrCreateMachineId()` likewise stays in `hubPull`'s prologue: it MINTS
 * the machine id when absent, and the unlinked escape below returns before
 * `registerMachine`, so that prologue call is the only reason an unlinked pull
 * gets one at all.
 */
export async function runResolveStage(input) {
    const { backend, projectPath, hubPath, projectIdOverride } = input;
    // One list, pushed to in source order: the git-remote link message is
    // emitted BEFORE readAllIndexes runs, and the caller spreads the whole list
    // in one go where its own `warnings.push(...indexWarnings)` used to sit.
    const reasons = [];
    let local;
    if (projectIdOverride) {
        local = await linkToHubProject(backend, projectPath, projectIdOverride);
    }
    else {
        const resolution = await resolveProjectIdentity(backend, projectPath);
        if (resolution.kind === "linked") {
            local = resolution.local;
        }
        else if (resolution.kind === "match") {
            local = await linkToHubProject(backend, projectPath, resolution.hubProject.projectId);
            reasons.push(`Linked to hub project ${resolution.hubProject.name} via git remote ${resolution.matchedRemote}.`);
        }
        else {
            // No `reasons` on this variant: HubUnlinkedResult declares no warnings
            // field, and this path discards the ones already collected too.
            return {
                kind: "return",
                result: {
                    success: false, command: "pull", reason: "unlinked",
                    linkCandidates: resolution.candidates,
                    suggestion: "Pass --project-id <id> to link to an existing hub project.",
                },
            };
        }
    }
    await registerMachine(hubPath);
    // Read once, reused both for the hub-peer bookkeeping downstream (recognizing
    // pulled content as already-known-to-the-hub) and for this thread's
    // mapping write at the end of the pull.
    const hub = JSON.parse((await backend.read(HUB_JSON)).toString());
    const hubPeerId = `hub:${hub.hubId}`;
    const { indexes, warnings: indexWarnings } = await readAllIndexes(backend, local.projectId);
    reasons.push(...indexWarnings);
    // Folded in rather than returning `indexes`: that array has exactly one read
    // site, so handing it back would strand a one-line pure call in the caller
    // and drag a HubIndexJson import back into pull.ts.
    const resolved = resolveThreads(indexes);
    return { kind: "proceed", value: { local, hub, hubPeerId, resolved }, reasons };
}
//# sourceMappingURL=pull-resolve.js.map