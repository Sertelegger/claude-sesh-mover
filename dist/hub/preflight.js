import { statSync } from "node:fs";
import { listHubProjects, readHubProjectAsLocal } from "./identity.js";
import { HUB_JSON } from "./layout.js";
/**
 * Can this machine see a sesh-mover hub at the configured path at all?
 *
 * Two failing states, and they are told apart because their remedies differ: the
 * directory is not there (`no-directory` — an unmounted share, a synced folder
 * that has not appeared here, a path that was never right) versus the directory
 * is there but carries no usable `hub.json` (`not-a-hub` — a first sync still in
 * flight, or a path naming some other directory entirely).
 *
 * `hub.json` is validated only as far as the verbs actually use it: it must
 * parse and carry a non-empty `hubId`, which is the id push and pull key their
 * peer ledgers and thread mappings by. Deliberately NOT `schemaVersion === 1`,
 * which `hubInit` does check — that check is about ADOPTING a directory as this
 * machine's hub, and refusing to read a hub a newer sesh-mover wrote is a
 * different (and harsher) decision than the one this gate is making.
 *
 * **Exported because the diagnostic verbs need the ANSWER without the refusal.**
 * `hub status` and `whereis` report this state inside a `success: true` result
 * rather than declining on it (they are reads; the user ran `hub status`
 * precisely to find out), so what they must share with push/pull/reindex is the
 * classification, not the `HubUnreachableResult`. Before this was one function,
 * `hub status` had its own rule — `hub.json` merely EXISTS — and so called a
 * `hub.json` with no `hubId` reachable while push refused it as `not-a-hub`.
 *
 * Writes nothing, and both calls are bounded: one `statSync`, one small read.
 */
export async function probeHubReachable(hubPath, backend) {
    let rootIsDir = false;
    try {
        rootIsDir = statSync(hubPath).isDirectory();
    }
    catch {
        // Any error reads as "cannot see it": a missing path, a dead mount point, a
        // permission failure. All three want the same answer from the caller.
        rootIsDir = false;
    }
    if (!rootIsDir)
        return { state: "no-directory", hub: null };
    let hub = null;
    try {
        hub = JSON.parse((await backend.read(HUB_JSON)).toString());
    }
    catch {
        hub = null;
    }
    if (hub === null || typeof hub.hubId !== "string" || hub.hubId.length === 0) {
        return { state: "not-a-hub", hub: null };
    }
    return { state: "ok", hub };
}
/**
 * What is wrong and what to do about it, for one unreachable state — the half
 * that is true no matter which verb asked.
 *
 * Split out from the refusal because `hub status` and `whereis` surface exactly
 * this as a warning while making no claim about writes, and the refusals append
 * their own "nothing happened" clause. One wording, so a user who runs `hub
 * status` after a refused push is not given a second, differently-worded
 * diagnosis of the same directory.
 *
 * **No path in any of it.** The refusal is emitted as JSON on stdout and often
 * rendered, and the ENOENT it replaces volunteered the hub's absolute path for
 * no benefit (#75). `hub status` is where a user asks WHICH path is configured,
 * and it answers with the `hubPath` FIELD rather than by interpolating it here.
 */
export function describeHubUnreachable(state) {
    return state === "no-directory"
        ? "hub.path names a directory this machine cannot see. If the hub is a network share, check that it is mounted; if it is a synced folder, it may not have reached this machine yet."
        : "The configured hub directory is readable but carries no usable hub.json, so this machine cannot tell which hub it is. If the hub is a synced folder its first sync may still be in flight; otherwise hub.path is set to a directory that is not a sesh-mover hub.";
}
/**
 * The typed refusal, for the verbs that were about to write: push, pull, and
 * `hub reindex`.
 *
 * `hub reindex` belongs here for the reason push does rather than by analogy —
 * `registerMachine` is its third statement, and `writeAtomic` mkdir -p's its
 * way to `machines/<id>.json`, so a reindex at an unmounted mount point
 * MATERIALIZED a half-built "hub" at that path and then rebuilt an index into
 * it. Every later command would have treated that directory as real.
 */
export function hubUnreachableRefusal(command, state) {
    return {
        success: false,
        command,
        reason: "hub-unreachable",
        hubState: state,
        suggestion: describeHubUnreachable(state) +
            (state === "no-directory"
                ? " Nothing was read from or written to the hub."
                : " Nothing was written."),
    };
}
/**
 * Validate `--project-id` against the hub BEFORE the verb runs (#29, moved
 * inward by #75).
 *
 * Returns `null` when the flag was not passed or names a hub project that
 * exists; otherwise the typed refusal to emit instead of running the verb.
 *
 * Both verbs funnel the flag into `readHubProjectAsLocal`, which throws two
 * different ways — `assertSafeHubId` for a path-unsafe id, a raw `ENOENT` for a
 * well-formed one the hub doesn't have — and both used to escape as an untyped
 * `error` string (the ENOENT one carrying the hub's absolute path). Worse on
 * push: it decides identity early but *resolves* it only after
 * `registerMachine` (a hub write), after minting a thread into local sync-state
 * and after a full incremental export — so a typo'd id failed with residue on
 * the hub and no typed result to say so. A validation failure must not happen
 * after side effects, and this gate is before all of them.
 *
 * This is a READ of `projects/<id>/project.json` and nothing else: it writes
 * nothing, links nothing, and does not weaken push's deferred-link consent gate
 * (that rationale is about the link WRITE, not about reading the project).
 */
async function checkProjectId(command, backend, projectId) {
    if (!projectId)
        return null;
    try {
        await readHubProjectAsLocal(backend, projectId);
        return null;
    }
    catch {
        // Deliberately one arm for both throw flavours: from the caller's side
        // "that id is not a project on this hub" is the same fact and the same
        // remedy, and reflecting WHICH failure it was would mean reflecting the
        // hub's absolute path (the ENOENT message) back out.
        let linkCandidates = [];
        try {
            linkCandidates = (await listHubProjects(backend)).map((p) => ({
                projectId: p.projectId,
                name: p.name,
                gitRemotes: p.matchers.gitRemotes,
            }));
        }
        catch {
            // An unlistable projects/ yields no pick list. The refusal still stands —
            // an empty array, never a missing field.
        }
        return {
            success: false,
            command,
            reason: "no-such-project",
            requestedProjectId: projectId,
            linkCandidates,
            suggestion: linkCandidates.length > 0
                ? `No hub project with that id. Pick one of the ${linkCandidates.length} project(s) in linkCandidates and pass its projectId to --project-id` +
                    (command === "push" ? ", or pass --create-project to mint a new one." : ".")
                : `No hub project with that id, and this hub lists no projects to pick from` +
                    (command === "push" ? " — pass --create-project to mint one." : " — push from the machine that has this project first."),
        };
    }
}
/**
 * The whole gate, in the order the two checks have to run in.
 *
 * **Reachability first, and it is not a style choice.** On an unreachable hub
 * EVERY read fails, the `--project-id` read included, so answering
 * `no-such-project` there would be a confident wrong diagnosis sending the user
 * to fix an id that is fine. The CLI-level version of this gate stood down in
 * that case (it could say nothing better); with both checks in one place the
 * order settles it instead.
 *
 * The parsed `hub.json` is handed BACK rather than re-read by the callers: it
 * is the read that used to throw the `ENOENT` this refusal replaces, so leaving
 * a second copy of it downstream would leave the throw exactly where it was.
 */
export async function preflightHub(input) {
    const { command, hubPath, backend, projectIdOverride } = input;
    const probe = await probeHubReachable(hubPath, backend);
    if (probe.state !== "ok") {
        return { kind: "refuse", result: hubUnreachableRefusal(command, probe.state) };
    }
    const badId = await checkProjectId(command, backend, projectIdOverride);
    if (badId)
        return { kind: "refuse", result: badId };
    return { kind: "ok", hub: probe.hub };
}
//# sourceMappingURL=preflight.js.map