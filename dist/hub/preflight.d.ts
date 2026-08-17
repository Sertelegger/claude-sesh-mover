import type { HubBackend } from "./backend.js";
import { type HubJson } from "./layout.js";
import type { HubNoSuchProjectResult, HubUnreachableResult } from "../types.js";
/**
 * Everything `hub push` and `hub pull` must settle about the HUB before either
 * of them touches anything — the local project, the hub, or their own
 * bookkeeping.
 *
 * **It lives in a hub module rather than in `cli.ts`, and that is the point
 * (#75).** `src/index.ts` deliberately exposes `hubPush`/`hubPull`, so a gate
 * in the CLI fixes the CLI and leaves the programmatic entry point behaving
 * differently from it: an unreachable hub threw a raw `ENOENT` (naming the
 * hub's absolute path) out of both, and a `--project-id` naming no hub project
 * was refused for CLI callers only. Two callers, one answer.
 *
 * It lives in a module of ITS OWN for the reason `fs-probe.ts` does: `push.ts`
 * and `pull-resolve.ts` are the two callers and neither may depend on the
 * other. One home is also what stops the two verbs drifting apart on what
 * "reachable" means.
 *
 * **It writes nothing.** Every call here is a read: `statSync` on the hub root,
 * one `hub.json` read, and — only when `--project-id` was passed — one
 * `project.json` read plus, on failure, one `projects/` listing for the pick
 * list. That is what lets both callers run it before the work rather than in
 * the middle of it, which is the ordering half of both refusals.
 */
export type HubPreflight = {
    kind: "ok";
    hub: HubJson;
} | {
    kind: "refuse";
    result: HubUnreachableResult | HubNoSuchProjectResult;
};
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
export declare function preflightHub(input: {
    command: "push" | "pull";
    hubPath: string;
    backend: HubBackend;
    projectIdOverride?: string;
}): Promise<HubPreflight>;
//# sourceMappingURL=preflight.d.ts.map