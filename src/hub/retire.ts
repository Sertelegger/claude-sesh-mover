import { createFsBackend, type HubBackend } from "./backend.js";
import { acquireProjectLock, describeLockSteal, LockBusyError, type LockHandle } from "./lock.js";
import {
  readLocalProjectId, removeLocalProjectIdIfMatches,
} from "./identity.js";
import { hubUnreachableRefusal, probeHubReachable } from "./preflight.js";
import {
  projectDir, projectJsonPath, tombstoneDirPath, tombstonePath,
  type HubProjectJson, type HubTombstoneJson,
} from "./layout.js";
import {
  formatStamp, graceState, readTombstone, readTombstones,
  RETIREMENT_GRACE_HOURS, writeTombstone,
} from "./tombstone.js";
import { createMachineNameLookup } from "./whereis.js";
import { loadOrCreateMachineId } from "../machine.js";
import type {
  HubDeleteResult, HubLockBusyResult, HubRetireFailedResult, HubRetireResult,
  HubUnreachableResult,
} from "../types.js";

/**
 * Hub project retirement, in the two phases the owner's ruling on #43 settles:
 *
 *   1. **`hub retire`** writes a tombstone — an assertion, on a file this
 *      machine owns. Nothing is removed. A tombstoned project is refused for
 *      pull (`hub/pull-resolve.ts`).
 *   2. **`hub delete`** destroys the project's files on the hub, and only the
 *      machine that created the project may, and only once its own tombstone is
 *      older than `RETIREMENT_GRACE_MS`.
 *
 * ---------------------------------------------------------------------------
 * **TWO VERBS, NOT ONE VERB WITH A FLAG**, and the reason is the whole point of
 * the ruling. The two phases have opposite risk profiles: phase 1 is an
 * assertion this machine can retract in one command, phase 2 is irreversible
 * destruction of every machine's copy of a project. A single verb — even with a
 * `--delete` flag guarded by the grace window — puts them one keystroke and one
 * shell-history arrow-up apart, and the grace window exists precisely because
 * "the destructive step happened sooner than anyone meant it to" is the failure
 * being designed against. Separate verbs also let the safe one keep the
 * ordinary, guessable name.
 *
 * **Both phases are owner-only** (`HubProjectJson.createdByMachine`). The
 * slice-3 design also allowed *any* machine to retire an **empty** project, as
 * an escape hatch for the case where the creating machine is gone; that clause
 * did not survive being chained to a deletion, which the design itself flagged
 * ("if compaction reuses this assertion mechanism to actually delete bundles,
 * the empty clause must be re-examined — a wrong assertion that today hides a
 * list entry would then destroy data"). Its whole justification was that a wrong
 * assertion is free. Under the ruling a tombstone is the *authorization* for a
 * delete, so it is not free any more, and the hatch is gone. The orphan case #43
 * describes is unaffected: a push that failed after minting a hub project minted
 * it under THIS machine's id, so this machine is its owner and can retire it
 * with `--project-id`. The genuinely stranded case — the creating machine is
 * decommissioned — is a human `rm` on the hub directory, which is what it was
 * before this feature existed.
 *
 * **This module is the ONLY caller of `HubBackend.delete` in `src/`.** It had
 * none at all before #43 (the slice-4 spec: "physical removal belongs to
 * retirement and compaction"), and `tests/hub-retire.test.ts` asserts the call
 * sites so a second one cannot appear without a deliberate edit to that
 * allowlist. Every removal here goes through `deleteHubFile` below, so there is
 * one line in the codebase that removes a hub file.
 * ---------------------------------------------------------------------------
 */

export interface HubRetireOptions {
  projectPath: string;
  hubPath: string;
  /**
   * Retire a hub project by id rather than the one this directory is linked to.
   *
   * The orphan case is why it exists: a push that failed between minting the hub
   * project and writing the local link leaves a project on the hub that no
   * directory points at, so without this flag the machine that created it could
   * never name it. Ownership is still checked.
   */
  projectIdOverride?: string;
  /** Free text recorded on the tombstone and echoed to every machine's refusal. */
  reason?: string;
  /** Withdraw this machine's assertion instead of making one. */
  undo?: boolean;
}

export interface HubDeleteOptions {
  projectPath: string;
  hubPath: string;
  projectIdOverride?: string;
}

export type HubRetireOutcome =
  | HubRetireResult | HubRetireFailedResult | HubLockBusyResult | HubUnreachableResult;
export type HubDeleteOutcome =
  | HubDeleteResult | HubRetireFailedResult | HubLockBusyResult | HubUnreachableResult;

/**
 * The one place `HubBackend.delete` is called.
 *
 * A named funnel rather than three call sites, so "physical removal happens
 * here and nowhere else" is a property of the code and not of a convention. It
 * swallows nothing: the caller records every failure into `HubDeleteResult.failed`.
 */
async function deleteHubFile(backend: HubBackend, relPath: string): Promise<void> {
  await backend.delete(relPath);
}

/**
 * The order `hub delete` removes a project's files in — fixed, never whatever
 * `list` happened to return, because it is what decides how an INTERRUPTED
 * delete leaves the hub. A network share disappearing mid-run is the ordinary
 * way to find out.
 *
 *   1. **`project.json` first.** It is what `listHubProjects` reads, so the
 *      instant it is gone the project can no longer be offered as a
 *      `linkCandidate` or resolved through `--project-id`, whatever else
 *      survives. A half-deleted project must not be linkable.
 *   2. **Bundles and indexes next** — the bulk, and the part with nothing
 *      depending on its order.
 *   3. **Tombstones LAST.** A run that dies half way leaves the tombstone
 *      standing, which keeps the pull gate up on every machine that has it AND
 *      keeps this delete authorized — the grace window has already elapsed, so
 *      re-running the command simply finishes the job. Deleting the tombstone
 *      first would strand a half-deleted project that could only be re-deleted
 *      by retiring it again and waiting out a second window.
 *
 * Pure, and exported, so the ordering can be asserted without arranging a
 * failure mid-delete.
 */
export function orderForDeletion(projectId: string, files: string[]): string[] {
  const projectJson = projectJsonPath(projectId);
  const tombPrefix = `${tombstoneDirPath(projectId)}/`;
  return [
    ...files.filter((f) => f === projectJson),
    ...files.filter((f) => f !== projectJson && !f.startsWith(tombPrefix)),
    ...files.filter((f) => f !== projectJson && f.startsWith(tombPrefix)),
  ];
}

function lockBusyRefusal(
  command: "hub-retire" | "hub-delete",
  e: LockBusyError
): HubLockBusyResult {
  return {
    success: false,
    command,
    reason: "lock-busy",
    holderPid: e.holderPid,
    ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
    error: e.message,
    // NO LOCK OVERRIDE ON THESE TWO VERBS, deliberately — `hub unlink` has one
    // because it is the disarm path for a wedged push and must not depend on
    // the thing being disarmed. Retirement has the opposite relationship to a
    // concurrent operation: what it could be racing is a push writing new
    // bundles into the very project it is about to declare dead (or delete), so
    // waiting is the answer and skipping the wait is not offered.
    suggestion:
      "Another sesh-mover hub operation is running for this project — wait for it to finish and try again.",
  };
}

/**
 * Everything both verbs must settle before they do their own work: which project,
 * is the hub there, is this machine the owner.
 *
 * Ordered the way `hubReindex` orders its own gate, and for its reasons: the
 * LOCAL identity fact first (it cannot be the wrong diagnosis — it is a read of a
 * file in the user's own directory), then reachability, then the lock, then the
 * hub reads. The lock is released by the caller's `finally`; a preamble that took
 * a lock its caller had to remember to release is how one gets left held.
 */
interface Preamble {
  projectId: string;
  backend: HubBackend;
  machineId: string;
  project: HubProjectJson;
  lock: LockHandle;
  warnings: string[];
}

/**
 * The refusals BOTH verbs can produce — deliberately not `HubRetireOutcome`,
 * which carries each verb's own success shape and would let a `hub delete`
 * return a `hub-retire` result.
 */
type PreambleRefusal = HubRetireFailedResult | HubLockBusyResult | HubUnreachableResult;

type PreambleOutcome =
  | { kind: "ok"; value: Preamble }
  | { kind: "refuse"; result: PreambleRefusal };

async function preamble(
  command: "hub-retire" | "hub-delete",
  opts: { projectPath: string; hubPath: string; projectIdOverride?: string }
): Promise<PreambleOutcome> {
  const linked = readLocalProjectId(opts.projectPath);
  const projectId = opts.projectIdOverride ?? linked?.projectId;
  if (!projectId) {
    return {
      kind: "refuse",
      result: {
        success: false,
        command,
        reason: "unlinked",
        error: "This directory is linked to no hub project, so there is nothing here to retire.",
        suggestion:
          "Run this from the project's own directory, or name the hub project with --project-id <id> — `sesh-mover hub status` and `sesh-mover whereis` report the id. " +
          "Only the machine that created a project can retire or delete it.",
      },
    };
  }

  const backend = createFsBackend(opts.hubPath);
  const probe = await probeHubReachable(opts.hubPath, backend);
  if (probe.state !== "ok") return { kind: "refuse", result: hubUnreachableRefusal(command, probe.state) };

  let lock: LockHandle;
  try {
    lock = acquireProjectLock(opts.projectPath);
  } catch (e) {
    if (e instanceof LockBusyError) return { kind: "refuse", result: lockBusyRefusal(command, e) };
    throw e;
  }

  const warnings: string[] = [];
  if (lock.stoleStale) {
    warnings.push(
      describeLockSteal(lock.steal, "operation")
    );
  }

  // THE LOCK IS RELEASED ON EVERY PATH OUT OF HERE EXCEPT `kind: "ok"`, which
  // hands it to the caller's `finally`. Splitting ownership across that boundary
  // is how a lock outlives its operation, so the split is made exactly once and
  // in one place: below, on the outcome.
  const outcome = await (async (): Promise<PreambleOutcome> => {
    let project: HubProjectJson;
    try {
      project = JSON.parse((await backend.read(projectJsonPath(projectId))).toString()) as HubProjectJson;
      if (project === null || typeof project !== "object" || typeof project.createdByMachine !== "string") {
        throw new Error("malformed project.json");
      }
    } catch {
      return {
        kind: "refuse",
        result: {
          success: false,
          command,
          reason: "project-gone",
          projectId,
          error: "The hub has no readable record of this project — it has already been deleted, or it never reached this machine.",
          suggestion:
            "If the hub is a synced folder, the project record may simply not have landed here yet; check `sesh-mover hub status` and try again once it has. If the project really is gone, `sesh-mover hub unlink` removes this directory's stale link and disarms its session-end auto-push.",
        },
      };
    }

    const machineId = loadOrCreateMachineId().id;
    if (project.createdByMachine !== machineId) {
      const ownerName = await createMachineNameLookup(backend)(project.createdByMachine);
      return {
        kind: "refuse",
        result: {
          success: false,
          command,
          reason: "not-owner",
          projectId,
          ownerMachineId: project.createdByMachine,
          ownerMachineName: ownerName,
          // Both interpolated values come off the hub, so both are QUOTED —
          // the same rule `readMachineIndex` states: `JSON.stringify` escapes
          // the control characters that make a terminal render a lie.
          error: `This machine did not create hub project ${JSON.stringify(project.name)} — ${JSON.stringify(ownerName ?? project.createdByMachine)} did, and retiring or deleting it is that machine's to do.`,
          suggestion:
            "Run the same command on the machine that created the project. If that machine is gone for good, a project can only be removed by deleting `projects/<id>/` from the hub directory by hand — deliberately, because a machine that cannot see the whole hub must not be able to destroy another machine's work.",
        },
      };
    }

    return { kind: "ok", value: { projectId, backend, machineId, project, lock, warnings } };
  })().catch((e: unknown) => {
    lock.release();
    throw e;
  });
  if (outcome.kind === "refuse") lock.release();
  return outcome;
}

export async function hubRetire(opts: HubRetireOptions): Promise<HubRetireOutcome> {
  const pre = await preamble("hub-retire", opts);
  if (pre.kind === "refuse") return pre.result;
  const { projectId, backend, machineId, lock, warnings } = pre.value;

  try {
    const existing = await readTombstone(backend, projectId, machineId);

    if (opts.undo) {
      // Retraction is asymmetric by construction: this removes THIS machine's
      // assertion and can touch no other machine's, which is the same
      // per-machine ownership rule the index files keep.
      if (existing) await deleteHubFile(backend, tombstonePath(projectId, machineId));
      const others = (await readTombstones(backend, projectId)).filter((t) => t.machineId !== machineId);
      if (others.length > 0) {
        warnings.push(
          `${others.length} other machine(s) still assert that this project is retired, so pulls will keep being refused. Only the machine that wrote an assertion can withdraw it.`
        );
      }
      warnings.push(
        "Nothing was deleted by the retirement, so nothing has to be restored: a tombstone hides a project from new pulls and removes no bytes."
      );
      return {
        success: true,
        command: "hub-retire",
        projectId,
        retired: false,
        wasRetired: existing !== null,
        retiredAt: null,
        deleteEligibleAt: null,
        reason: null,
        warnings,
      };
    }

    // RE-ASSERTING KEEPS THE ORIGINAL TIMESTAMP. Running `hub retire` twice
    // must not restart the grace clock — the delete is waiting on the age of the
    // assertion other machines have had a chance to see, and that assertion is
    // the first one. (A retire → undo → retire cycle DOES restart it, correctly:
    // the withdrawal means machines may have stopped seeing it.)
    const retiredAt = existing?.retiredAt ?? new Date().toISOString();
    const tombstone: HubTombstoneJson = {
      schemaVersion: 1,
      projectId,
      machineId,
      retiredAt,
      reason: opts.reason ?? existing?.reason ?? null,
    };
    await writeTombstone(backend, tombstone);
    const grace = graceState(retiredAt, Date.now());

    if (existing) {
      warnings.push(
        `This project was already retired from this machine at ${formatStamp(retiredAt)}; that timestamp is kept, so the delete grace window is not restarted by re-running this.`
      );
    }
    warnings.push(
      "Nothing was deleted. Every bundle, index and workspace copy is exactly where it was — a tombstone is an assertion, not a removal. " +
        "It can be withdrawn later, from this machine only, by a `sesh-mover hub retire --undo` run."
    );
    warnings.push(
      "Other machines stop being able to pull this project only once the tombstone reaches them. On a synced hub that is not immediate, which is the reason `sesh-mover hub delete` refuses until the assertion is " +
        `${RETIREMENT_GRACE_HOURS}h old${grace.eligibleAt ? ` (from ${formatStamp(grace.eligibleAt)})` : ""}.`
    );
    warnings.push(
      "Pushes are NOT blocked by retirement: a machine still linked to this project keeps uploading to it, including through the unattended session-end auto-push. Run `sesh-mover hub unlink` in this directory (and on the other machines) if you want that to stop."
    );

    return {
      success: true,
      command: "hub-retire",
      projectId,
      retired: true,
      wasRetired: existing !== null,
      retiredAt,
      deleteEligibleAt: grace.eligibleAt,
      reason: tombstone.reason,
      warnings,
    };
  } finally {
    lock.release();
  }
}

export async function hubDelete(opts: HubDeleteOptions): Promise<HubDeleteOutcome> {
  const pre = await preamble("hub-delete", opts);
  if (pre.kind === "refuse") return pre.result;
  const { projectId, backend, machineId, lock, warnings } = pre.value;

  try {
    const tombstone = await readTombstone(backend, projectId, machineId);
    if (!tombstone) {
      return {
        success: false,
        command: "hub-delete",
        reason: "not-retired",
        projectId,
        error: "This project has not been retired from this machine, so there is nothing to delete yet.",
        suggestion:
          `Run \`sesh-mover hub retire\` first and leave it for ${RETIREMENT_GRACE_HOURS}h. That wait is not a formality: retiring makes other machines refuse to START a pull, and the wait is what gives the assertion time to reach them on a synced hub — a machine that has not seen it yet will pull happily.`,
      };
    }

    const grace = graceState(tombstone.retiredAt, Date.now());
    if (!grace.eligible) {
      // NOT class 3. See REASON_EXIT_CODE in src/types.ts: this is a deliberate
      // multi-day hold, not a "try again in a moment".
      return {
        success: false,
        command: "hub-delete",
        reason: "grace-period",
        projectId,
        retiredAt: tombstone.retiredAt,
        deleteEligibleAt: grace.eligibleAt,
        remainingSeconds: grace.remainingMs === null ? null : Math.ceil(grace.remainingMs / 1000),
        error:
          grace.eligibleAt === null
            ? `This project's tombstone carries an unreadable timestamp (${JSON.stringify(tombstone.retiredAt)}), so how long it has existed cannot be established.`
            : `This project was retired at ${formatStamp(tombstone.retiredAt)}, less than ${RETIREMENT_GRACE_HOURS}h ago. Deleting it now could pull the bundles out from under a machine that has not seen the retirement yet.`,
        suggestion:
          grace.eligibleAt === null
            ? "Write a fresh assertion with `sesh-mover hub retire --undo` followed by `sesh-mover hub retire`, then wait out the grace window before a later delete."
            : `Wait until ${formatStamp(grace.eligibleAt)} and run this again. The window is sized against how long a synced hub takes to reach a machine that is switched off, not against how long a pull takes; shortening it is what this whole two-step exists to prevent.`,
      };
    }

    const ordered = orderForDeletion(projectId, await backend.list(projectDir(projectId)));

    let deletedFiles = 0;
    const failed: Array<{ path: string; error: string }> = [];
    for (const relPath of ordered) {
      try {
        await deleteHubFile(backend, relPath);
        deletedFiles++;
      } catch (e) {
        failed.push({ path: relPath, error: (e as Error).message });
      }
    }

    // The local link is removed too, and it is not tidiness: the file is the
    // consent gate for the session-end auto-push (`hub/hooks.ts`), so leaving it
    // pointing at a project that no longer exists means the very next session end
    // uploads bundles into `projects/<deleted id>/` — recreating the directory
    // with no `project.json`, i.e. bytes no `listHubProjects` will ever surface
    // again. Guarded by the same re-read `hub push`'s rollback uses: only removed
    // while it still names the project just deleted.
    const link = removeLocalProjectIdIfMatches(opts.projectPath, projectId);
    if (!link.removed) {
      warnings.push(
        `This directory's hub link could not be removed${link.detail ? ` (${link.detail})` : ""}, so the session-end auto-push is still armed here and would re-create the deleted project on the hub. Run \`sesh-mover hub unlink\` in this directory.`
      );
    }
    if (failed.length > 0) {
      warnings.push(
        `${failed.length} file(s) under projects/${projectId}/ could not be removed and are listed in \`failed\`. The project is unlinkable either way — its project.json is gone — but nothing will mention those files again; remove them by hand if the hub directory's size matters.`
      );
    }
    warnings.push(
      "Empty directories may remain under projects/<id>/ — the hub backend removes files, never directories. They hold nothing and no command reads them."
    );
    warnings.push(
      "Every OTHER machine that linked this project still holds its own `.sesh-mover-project.json`, and a push from one of them will recreate this project directory on the hub with no project record — undiscoverable, but not harmless. Run `sesh-mover hub unlink` on those machines."
    );
    warnings.push(
      "This machine's local sync bookkeeping was left alone, so it still records what it once sent to this hub. If you later link this directory to a NEW hub project, the next push may ship only a delta of those sessions; a fresh `push` from a machine with no such record is the reliable way to re-seed one."
    );
    warnings.push(
      "Local sessions were not touched. Deleting a hub project removes the shared copies only — every transcript this machine holds is still in its Claude config directory."
    );

    return {
      success: true,
      command: "hub-delete",
      projectId,
      deletedFiles,
      failed,
      localLinkRemoved: link.removed,
      warnings,
    };
  } finally {
    lock.release();
  }
}
