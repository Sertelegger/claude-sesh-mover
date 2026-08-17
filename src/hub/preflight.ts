import { stat } from "node:fs/promises";
import type { HubBackend } from "./backend.js";
import { HubIoTimeoutError, withHubIoTimeout } from "./io-timeout.js";
import { listHubProjects, readHubProjectAsLocal } from "./identity.js";
import { HUB_JSON, type HubJson } from "./layout.js";
import type {
  HubNoSuchProjectResult, HubReachabilityState, HubUnreachableResult,
} from "../types.js";

/**
 * Everything `hub push` and `hub pull` must settle about the HUB before either
 * of them touches anything — the local project, the hub, or their own
 * bookkeeping — plus the reachability half on its own, for the three other verbs
 * that ask the same question and do something different with the answer.
 *
 * Five verbs, three behaviours, one classification (`probeHubReachable`):
 * push/pull run the whole gate; `hub reindex` takes the refusal only
 * (`hubUnreachableRefusal`) because it has no `--project-id`; `hub status` and
 * `whereis` are READS and report the state in their normal `success: true`
 * results instead of declining — a `hub status` that refused because the hub is
 * unreachable would be refusing to answer the question it was asked. `hub
 * unlink` is absent on purpose: it is the disarm path for a default-on
 * automation, so it must not depend on the thing being disarmed, and it
 * constructs no backend at all.
 *
 * **It lives in a hub module rather than in `cli.ts`, and that is the point
 * (#75).** `src/index.ts` deliberately exposes `hubPush`/`hubPull`, so a gate
 * in the CLI fixes the CLI and leaves the programmatic entry point behaving
 * differently from it: an unreachable hub threw a raw `ENOENT` (naming the
 * hub's absolute path) out of both, and a `--project-id` naming no hub project
 * was refused for CLI callers only. Two callers, one answer.
 *
 * It lives in a module of ITS OWN for the reason `fs-probe.ts` does: no caller
 * may depend on another (`push.ts`, `pull-resolve.ts`, `reindex.ts`, `status.ts`
 * and `whereis.ts` are all peers). One home is also what stops the verbs
 * drifting apart on what "reachable" means — which they had already done:
 * `status.ts` kept a private rule ("hub.json exists"), so it called a `hub.json`
 * carrying no `hubId` reachable while push refused the same directory.
 *
 * **It writes nothing.** Every call here is a read: `statSync` on the hub root,
 * one `hub.json` read, and — only when `--project-id` was passed — one
 * `project.json` read plus, on failure, one `projects/` listing for the pick
 * list. That is what lets every caller run it before the work rather than in
 * the middle of it, which is the ordering half of both refusals — and what lets
 * the two read-only verbs call it at all.
 */
export type HubPreflight =
  | { kind: "ok"; hub: HubJson }
  | { kind: "refuse"; result: HubUnreachableResult | HubNoSuchProjectResult };

/**
 * The probe's answer. `hub` is non-null exactly when `state` is `"ok"`, which is
 * what lets a caller use the parsed record without re-reading it (see
 * `preflightHub`'s note on why a second read would put the throw back).
 */
export type HubReachability =
  | { state: "ok"; hub: HubJson }
  | { state: Exclude<HubReachabilityState, "ok">; hub: null };

/**
 * Can this machine see a sesh-mover hub at the configured path at all?
 *
 * Three failing states, and they are told apart because their remedies differ:
 * the directory is not there (`no-directory` — an unmounted share, a synced
 * folder that has not appeared here, a path that was never right); the directory
 * is there but carries no usable `hub.json` (`not-a-hub` — a first sync still in
 * flight, or a path naming some other directory entirely); or a call against it
 * did not come back at all (`unresponsive` — #71, a hard mount whose server is
 * gone, a dead FUSE daemon). The third is not a shade of the other two: the path
 * is right and the share IS mounted, so both of their remedies are wrong, and it
 * is the only one that costs `HUB_IO_TIMEOUT_MS` of wall clock to reach.
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
 * Writes nothing, and both calls are bounded in BOTH senses: one `stat` and one
 * small read, each of them under `withHubIoTimeout` so that "bounded" means a
 * wall-clock bound and not merely a small number of syscalls. Before #71 it was
 * only the latter — `statSync` plus a `readFileSync` backend — which is exactly
 * how a push came to sit inside its own project lock forever.
 */
export async function probeHubReachable(
  hubPath: string,
  backend: HubBackend
): Promise<HubReachability> {
  let rootIsDir = false;
  try {
    // `stat`, not `statSync` (#71). This is the FIRST hub syscall a push makes,
    // and `hubPush` makes it inside the project lock — so as a blocking call it
    // was the exact place a dead hard mount wedged the process forever while
    // holding that lock. Bounded, and async so that the bound can fire at all.
    rootIsDir = (await withHubIoTimeout("stat", () => stat(hubPath))).isDirectory();
  } catch (err) {
    // A TIMEOUT IS NOT AN ABSENCE, and must not be swallowed into the arm below
    // (#71): a hung mount is present, is very likely a real hub, and telling its
    // user to "check that it is mounted" is a confident wrong diagnosis of the
    // one state whose remedy is neither mounting nor editing config.
    if (err instanceof HubIoTimeoutError) return { state: "unresponsive", hub: null };
    // Any other error reads as "cannot see it": a missing path, a dead mount
    // point, a permission failure. All three want the same answer.
    rootIsDir = false;
  }
  if (!rootIsDir) return { state: "no-directory", hub: null };

  let hub: HubJson | null = null;
  try {
    hub = JSON.parse((await backend.read(HUB_JSON)).toString()) as HubJson;
  } catch (err) {
    // Same rule, same reason: a `hub.json` that never came back is not a
    // `hub.json` that says the wrong thing.
    if (err instanceof HubIoTimeoutError) return { state: "unresponsive", hub: null };
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
export function describeHubUnreachable(
  state: Exclude<HubReachabilityState, "ok">
): string {
  if (state === "no-directory") {
    return "hub.path names a directory this machine cannot see. If the hub is a network share, check that it is mounted; if it is a synced folder, it may not have reached this machine yet.";
  }
  if (state === "unresponsive") {
    return "The configured hub directory is mounted but is not answering — a single filesystem call against it timed out. This is a stuck mount rather than a wrong path, so checking hub.path will not help: a hard-mounted network share whose server has gone away, or a sync/FUSE daemon that has died, both look exactly like this. Reconnect or force-unmount the filesystem, then retry.";
  }
  return "The configured hub directory is readable but carries no usable hub.json, so this machine cannot tell which hub it is. If the hub is a synced folder its first sync may still be in flight; otherwise hub.path is set to a directory that is not a sesh-mover hub.";
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
export function hubUnreachableRefusal(
  command: HubUnreachableResult["command"],
  state: Exclude<HubReachabilityState, "ok">
): HubUnreachableResult {
  return {
    success: false,
    command,
    reason: "hub-unreachable",
    hubState: state,
    suggestion:
      describeHubUnreachable(state) +
      // `unresponsive` shares the weaker clause with `not-a-hub` deliberately:
      // a timed-out syscall is a read that was ATTEMPTED and never answered, so
      // "nothing was read" would be a claim about a call whose outcome this
      // process does not and cannot know. "Nothing was written" is true for all
      // three — the probe writes nothing at all.
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

  const probe = await probeHubReachable(hubPath, backend);
  if (probe.state !== "ok") {
    return { kind: "refuse", result: hubUnreachableRefusal(command, probe.state) };
  }

  const badId = await checkProjectId(command, backend, projectIdOverride);
  if (badId) return { kind: "refuse", result: badId };

  return { kind: "ok", hub: probe.hub };
}
