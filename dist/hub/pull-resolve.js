import { linkToHubProject, resolveProjectIdentity } from "./identity.js";
import { registerMachine } from "./init.js";
import { readAllIndexes } from "./index-file.js";
import { preflightHub } from "./preflight.js";
import { resolveThreads } from "./threads.js";
import { findRetirement, retiredPullRefusal } from "./tombstone.js";
import { readMachineId } from "../machine.js";
/**
 * The pull's first stage: settle which hub project this directory IS, announce
 * this machine to the hub, and read what every machine's index says about the
 * project's threads.
 *
 * **Almost nothing here is caught.** `resolveProjectIdentity`, `registerMachine`
 * and `readAllIndexes` all escape to `cli.ts`, which turns them into an
 * `ErrorResult`; a `try`/`catch` around them in this module would convert a
 * mistyped hub path into a confident, wrong answer.
 *
 * The two exceptions are the preflight's, and they are caught THERE rather than
 * here (#75): an unreachable hub and a `--project-id` naming no hub project
 * were the two realistic throws in this stage — the first out of the `hub.json`
 * read, the second out of `linkToHubProject` — and both are now typed refusals
 * decided before this stage touches anything. That is also why the `hub.json`
 * read no longer happens in this file: the preflight hands the parsed record
 * over, and a second read here would leave the `ENOENT` exactly where it was.
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
    // FIRST, before the identity resolution below writes a link and before
    // `registerMachine` writes this machine's record: is there a hub here at all,
    // and does `--project-id` name a project on it? Both refusals are only worth
    // anything if nothing has happened yet.
    const pre = await preflightHub({
        command: "pull", hubPath, backend, projectIdOverride,
    });
    if (pre.kind === "refuse")
        return { kind: "return", result: pre.result };
    // WHICH project this is, settled WITHOUT writing anything. `linkToHubProject`
    // used to run here; it now runs below, after the retirement gate, on the rule
    // this file's preflight note already states — a refusal must not happen after
    // side effects. Linking a directory to a project that is being retired (and
    // thereby arming its session-end auto-push for it) is exactly such a side
    // effect.
    let local = null;
    let linkTo = null;
    if (projectIdOverride) {
        linkTo = { projectId: projectIdOverride };
    }
    else {
        const resolution = await resolveProjectIdentity(backend, projectPath);
        if (resolution.kind === "linked") {
            local = resolution.local;
        }
        else if (resolution.kind === "match") {
            linkTo = {
                projectId: resolution.hubProject.projectId,
                note: `Linked to hub project ${resolution.hubProject.name} via git remote ${resolution.matchedRemote}.`,
            };
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
    const projectId = local?.projectId ?? linkTo.projectId;
    // ---------------------------------------------------------------------
    // THE RETIREMENT GATE (#43) — one `list` on a healthy hub, and the reason it
    // is HERE rather than in `preflightHub`: the preflight runs before the project
    // is identified, and a tombstone is per project.
    //
    // It is a NEW-START gate and nothing more. It cannot stop a pull that is
    // already running, and it cannot fire on a machine the tombstone has not
    // reached yet — see `RETIREMENT_GRACE_MS` in tombstone.ts, which is the other
    // half of the safety and the one that actually closes those windows.
    // ---------------------------------------------------------------------
    if (!input.ignoreRetirement) {
        const tombstone = await findRetirement(backend, projectId);
        if (tombstone) {
            return {
                kind: "return",
                result: await retiredPullRefusal({
                    backend,
                    projectId,
                    tombstone,
                    // `readMachineId`, never `loadOrCreateMachineId`: this stage must not
                    // MINT an identity (see the note on the prologue below), and the id is
                    // used for one thing here — deciding whether the tombstone is ours,
                    // which an absent id answers with "no". By the time a pull reaches
                    // this line `hubPull`'s prologue has minted one anyway.
                    thisMachineId: readMachineId()?.id ?? "",
                    nowMs: input.opNowMs,
                }),
            };
        }
    }
    if (linkTo) {
        local = await linkToHubProject(backend, projectPath, linkTo.projectId);
        if (linkTo.note)
            reasons.push(linkTo.note);
    }
    // Exactly one of the two branches above set `local`, and the third returned.
    // The narrowing is stated rather than asserted with `!` so that a future
    // fourth branch that forgets to link fails here instead of downstream.
    if (local === null)
        throw new Error("hub pull: project identity resolved to no link");
    await registerMachine(hubPath);
    // Read once by the preflight above, reused both for the hub-peer bookkeeping
    // downstream (recognizing pulled content as already-known-to-the-hub) and for
    // this thread's mapping write at the end of the pull.
    const hub = pre.hub;
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