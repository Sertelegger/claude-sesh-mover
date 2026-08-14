import type { HubBackend } from "./backend.js";
import { HUB_JSON, type HubJson } from "./layout.js";
import { linkToHubProject, resolveProjectIdentity, type LocalProjectId } from "./identity.js";
import { registerMachine } from "./init.js";
import { readAllIndexes } from "./index-file.js";
import { resolveThreads, type ResolvedThread } from "./threads.js";
import type { HubUnlinkedResult } from "../types.js";

export interface ResolveStageInput {
  backend: HubBackend;
  /**
   * `hubPull`'s `opts.projectPath` — deliberately NOT the effective/target
   * path. In the bootstrap case (the project doesn't exist locally yet and
   * --target-path names a fresh destination for the workspace) that
   * destination must stay genuinely nonexistent until the workspace-unpack
   * step runs; if linking wrote .sesh-mover under it first, the "project path
   * doesn't exist locally" gate on the workspace flow would never fire.
   */
  projectPath: string;
  /** `registerMachine` builds its own backend from the path, not from `backend`. */
  hubPath: string;
  projectIdOverride?: string;
}

export interface ResolveStageValue {
  local: LocalProjectId;
  /** The hub record itself — its `hubId` keys the thread and workspace bookkeeping. */
  hub: HubJson;
  /** `hub:<hubId>`, the peer id the hub's own receipt ledger is kept under. */
  hubPeerId: string;
  resolved: ResolvedThread[];
}

/**
 * Not a `StageOutcome`, on purpose.
 *
 * `stageRefuse` carries `value: null` and nothing but `reasons: string[]`,
 * while the unlinked escape carries STRUCTURED data — `linkCandidates`, the
 * hub projects `/sesh-mover:pull`'s skill layer offers the user to link to.
 * Routing it through a refusal destroys them, which is a user-visible
 * regression rather than a cosmetic one. So the escape hands back the finished
 * `HubUnlinkedResult` for `hubPull` to return verbatim.
 *
 * A second reason to keep `refused` out of this stage: once it meant
 * "unlinked", any later `try`/`catch` wrapped around the body would silently
 * relabel every throw below as one.
 */
export type ResolveStageOutcome =
  | { kind: "proceed"; value: ResolveStageValue; reasons: string[] }
  | { kind: "return"; result: HubUnlinkedResult };

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
export async function runResolveStage(
  input: ResolveStageInput
): Promise<ResolveStageOutcome> {
  const { backend, projectPath, hubPath, projectIdOverride } = input;
  // One list, pushed to in source order: the git-remote link message is
  // emitted BEFORE readAllIndexes runs, and the caller spreads the whole list
  // in one go where its own `warnings.push(...indexWarnings)` used to sit.
  const reasons: string[] = [];

  let local: LocalProjectId;
  if (projectIdOverride) {
    local = await linkToHubProject(backend, projectPath, projectIdOverride);
  } else {
    const resolution = await resolveProjectIdentity(backend, projectPath);
    if (resolution.kind === "linked") {
      local = resolution.local;
    } else if (resolution.kind === "match") {
      local = await linkToHubProject(backend, projectPath, resolution.hubProject.projectId);
      reasons.push(`Linked to hub project ${resolution.hubProject.name} via git remote ${resolution.matchedRemote}.`);
    } else {
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
  const hub = JSON.parse((await backend.read(HUB_JSON)).toString()) as HubJson;
  const hubPeerId = `hub:${hub.hubId}`;

  const { indexes, warnings: indexWarnings } = await readAllIndexes(backend, local.projectId);
  reasons.push(...indexWarnings);
  // Folded in rather than returning `indexes`: that array has exactly one read
  // site, so handing it back would strand a one-line pure call in the caller
  // and drag a HubIndexJson import back into pull.ts.
  const resolved = resolveThreads(indexes);

  return { kind: "proceed", value: { local, hub, hubPeerId, resolved }, reasons };
}
