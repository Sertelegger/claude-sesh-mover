import { statSync } from "node:fs";
import type { HubBackend } from "./backend.js";
import { listHubProjects, readHubProjectAsLocal } from "./identity.js";
import { HUB_JSON, type HubJson } from "./layout.js";
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
export type HubPreflight =
  | { kind: "ok"; hub: HubJson }
  | { kind: "refuse"; result: HubUnreachableResult | HubNoSuchProjectResult };

/**
 * Can this machine see a sesh-mover hub at the configured path at all?
 *
 * Two states, and they are told apart because their remedies differ: the
 * directory is not there (`no-directory` — an unmounted share, a synced folder
 * that has not appeared here, a path that was never right) versus the directory
 * is there but carries no usable `hub.json` (`not-a-hub` — a first sync still in
 * flight, or a path naming some other directory entirely).
 *
 * `hub.json` is validated only as far as push and pull actually use it: it must
 * parse and carry a non-empty `hubId`, which is the id both verbs key their
 * peer ledgers and thread mappings by. Deliberately NOT `schemaVersion === 1`,
 * which `hubInit` does check — that check is about ADOPTING a directory as this
 * machine's hub, and refusing to read a hub a newer sesh-mover wrote is a
 * different (and harsher) decision than the one this gate is making.
 */
function checkHubReachable(
  command: "push" | "pull",
  hubPath: string,
  hub: HubJson | null,
  rootIsDir: boolean
): HubUnreachableResult | null {
  if (!rootIsDir) {
    return {
      success: false,
      command,
      reason: "hub-unreachable",
      hubState: "no-directory",
      // No path in any of this: the refusal is emitted as JSON on stdout and
      // often rendered, and the ENOENT it replaces volunteered the hub's
      // absolute path for no benefit (#75). `hub status` is where a user asks
      // WHICH path is configured.
      suggestion:
        "hub.path names a directory this machine cannot see. If the hub is a network share, check that it is mounted; if it is a synced folder, it may not have reached this machine yet. Nothing was read from or written to the hub.",
    };
  }
  if (hub === null || typeof hub.hubId !== "string" || hub.hubId.length === 0) {
    return {
      success: false,
      command,
      reason: "hub-unreachable",
      hubState: "not-a-hub",
      suggestion:
        "The configured hub directory is readable but carries no usable hub.json, so this machine cannot tell which hub it is. If the hub is a synced folder its first sync may still be in flight; otherwise hub.path is set to a directory that is not a sesh-mover hub. Nothing was written.",
    };
  }
  return null;
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
async function checkProjectId(
  command: "push" | "pull",
  backend: HubBackend,
  projectId: string | undefined
): Promise<HubNoSuchProjectResult | null> {
  if (!projectId) return null;
  try {
    await readHubProjectAsLocal(backend, projectId);
    return null;
  } catch {
    // Deliberately one arm for both throw flavours: from the caller's side
    // "that id is not a project on this hub" is the same fact and the same
    // remedy, and reflecting WHICH failure it was would mean reflecting the
    // hub's absolute path (the ENOENT message) back out.
    let linkCandidates: HubNoSuchProjectResult["linkCandidates"] = [];
    try {
      linkCandidates = (await listHubProjects(backend)).map((p) => ({
        projectId: p.projectId,
        name: p.name,
        gitRemotes: p.matchers.gitRemotes,
      }));
    } catch {
      // An unlistable projects/ yields no pick list. The refusal still stands —
      // an empty array, never a missing field.
    }
    return {
      success: false,
      command,
      reason: "no-such-project",
      requestedProjectId: projectId,
      linkCandidates,
      suggestion:
        linkCandidates.length > 0
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
export async function preflightHub(input: {
  command: "push" | "pull";
  hubPath: string;
  backend: HubBackend;
  projectIdOverride?: string;
}): Promise<HubPreflight> {
  const { command, hubPath, backend, projectIdOverride } = input;

  let rootIsDir = false;
  try {
    rootIsDir = statSync(hubPath).isDirectory();
  } catch {
    // Any error reads as "cannot see it": a missing path, a dead mount point, a
    // permission failure. All three want the same answer from the caller.
    rootIsDir = false;
  }
  let hub: HubJson | null = null;
  if (rootIsDir) {
    try {
      hub = JSON.parse((await backend.read(HUB_JSON)).toString()) as HubJson;
    } catch {
      hub = null;
    }
  }
  const unreachable = checkHubReachable(command, hubPath, hub, rootIsDir);
  if (unreachable) return { kind: "refuse", result: unreachable };

  const badId = await checkProjectId(command, backend, projectIdOverride);
  if (badId) return { kind: "refuse", result: badId };

  return { kind: "ok", hub: hub as HubJson };
}
