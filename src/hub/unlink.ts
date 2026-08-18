import { lstatSync, readFileSync, rmSync } from "node:fs";
import { acquireProjectLock, describeLockSteal, LockBusyError, type LockHandle } from "./lock.js";
import { projectJsonFilePath } from "../paths.js";
import type { ErrorResult, HubLockBusyResult, HubUnlinkResult } from "../types.js";

export interface HubUnlinkOptions {
  projectPath: string;
  /**
   * Skip the project lock.
   *
   * Not a convenience. A wedged push holds that lock for up to `LOCK_STALE_MS`
   * (10 minutes) — and a push wedged on an unreachable share is precisely the
   * situation a user reaches for this command in. Disarming an automation must
   * not be blocked by the thing being disarmed, so there has to be a way past
   * the lock; the result says what was given up for it.
   */
  force?: boolean;
}

/**
 * Remove this directory's hub link — the disarm path for the hub's automation.
 *
 * Deliberately the narrowest operation in this module, and every narrowing is
 * load-bearing:
 *
 * - **It removes exactly one file**, `<projectPath>/.sesh-mover-project.json`.
 *   That file's existence IS the consent gate (`evaluateHookGate` reads it and
 *   nothing else), so removing it makes both Claude Code hooks inert here. The
 *   `.sesh-mover/` directory beside it, `.sesh-mover-include`,
 *   `.sesh-mover-ignore` and the project directory itself are the user's and
 *   are not touched. In particular there is no `rmdir` of the parent: since
 *   0.8.0 the link is a ROOT DOTFILE, so its parent is the user's project
 *   directory (a `rmdirSync` there deleted an otherwise-empty project — see
 *   `rollbackLocalLink` in push.ts).
 * - **It writes nothing to the hub, and constructs no `HubBackend` at all.**
 *   Not "writes nothing today": there is no hub handle in this file to
 *   accidentally write through. The hub project, its bundles and every
 *   machine's index are exactly as they were, which is also what keeps a
 *   future tombstone design (a hub-side "this machine has left" record, written
 *   with `writeAtomic`) open rather than pre-empted by a half-measure here.
 * - **It needs no configured hub and no Claude config dir.** Every other hub
 *   verb bails with "No hub configured"; making the DISARM path depend on the
 *   thing being disarmed is backwards — a user whose network share is
 *   unmounted, or who has already removed `hub.path`, must still be able to
 *   turn the auto-push off.
 * - **It leaves local sync bookkeeping alone.** Clearing it would make a
 *   re-link to the same hub project re-upload every session. The `projectId` is
 *   returned instead, so a re-link is one `--project-id` away and the
 *   bookkeeping stays true. The known gap is warned about, not solved: the peer
 *   ledger is keyed by hub id rather than project id, so a re-link to a
 *   DIFFERENT project on the SAME hub leaves it claiming the hub holds sessions
 *   it does not.
 * - **It is per-directory.** Unlinking this project does not disarm a throwaway
 *   directory that a `pull --target-path` planted a link into; each one holds
 *   its own gate.
 *
 * The link file is stat'ed directly rather than read through
 * `readLocalProjectId`, which returns `null` for a file it cannot parse: a
 * corrupt link is inert as a gate but is still a file sitting in the user's
 * repository, and "not linked" would be the wrong answer to give about it.
 * Removing it is the right one.
 *
 * Synchronous by construction — there is no I/O here that could be anything
 * else once the hub is out of the picture.
 */
export function hubUnlink(
  opts: HubUnlinkOptions
): HubUnlinkResult | HubLockBusyResult | ErrorResult {
  const path = projectJsonFilePath(opts.projectPath);
  const warnings: string[] = [];

  let lock: LockHandle | null = null;
  if (opts.force) {
    warnings.push(
      "The project lock was skipped (--force), so a sesh-mover hub operation that is genuinely still running for this project could write the link file again when it finishes — check with `sesh-mover hub status` afterwards if a push or pull may have been in flight."
    );
  } else {
    try {
      lock = acquireProjectLock(opts.projectPath);
    } catch (e) {
      if (e instanceof LockBusyError) {
        // The same structured refusal push and pull give, so a caller can tell
        // "wait and retry" apart from "this failed" without reading prose —
        // and here the distinction carries a second remedy (`--force`) that a
        // generic error branch would never offer.
        return {
          success: false,
          command: "hub-unlink",
          reason: "lock-busy",
          holderPid: e.holderPid,
          ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
          error: e.message,
          suggestion:
            "Another sesh-mover hub operation is running for this project — wait for it and try again, or pass --force to unlink without waiting for it (a push that is still running could then re-create the link when it finishes).",
        };
      }
      throw e;
    }
    if (lock.stoleStale) {
      warnings.push(
        describeLockSteal(lock.steal, "unlink")
      );
    }
  }

  try {
    // lstat, not exists: a dangling symlink at this path is not a working link
    // (nothing reads through it) but it is still an entry to clear away, and
    // `existsSync` follows symlinks and would report it absent.
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      // Nothing here — the idempotent case, and the common one for a user
      // making sure. Not an error: the requested state is the state.
      return {
        success: true,
        command: "hub-unlink",
        wasLinked: false,
        projectId: null,
        removedPath: null,
        automationDisarmed: true,
        warnings,
      };
    }
    if (stat.isDirectory()) {
      // Never ours to remove recursively, and nothing this plugin writes could
      // have produced it.
      return {
        success: false,
        command: "hub-unlink",
        error: `${path} is a directory, not this project's hub link file — refusing to remove it.`,
        suggestion:
          "Inspect that path by hand. Nothing sesh-mover writes creates a directory there, so this was not made by the plugin.",
      };
    }

    // Read the id BEFORE removing it: it is what makes a re-link cheap, and it
    // is unrecoverable once the file is gone.
    let projectId: string | null = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      const id =
        parsed !== null && typeof parsed === "object"
          ? (parsed as { projectId?: unknown }).projectId
          : undefined;
      if (typeof id === "string" && id) projectId = id;
    } catch {
      /* handled below — a link we cannot read is still a link we must remove */
    }
    if (!projectId) {
      warnings.push(
        "The link file could not be read as a hub identity (corrupt, empty, or not JSON), so the hub project id it named could not be reported. It was removed anyway: a file no reader understands is still a file sitting in this project."
      );
    }

    try {
      rmSync(path, { force: true });
    } catch (e) {
      return {
        success: false,
        command: "hub-unlink",
        error: `Could not remove this project's hub link (${path}): ${(e as Error).message}`,
        suggestion:
          "Check the permissions on that file and on the project directory, then try again — while the file is there, this project stays linked and the session-end auto-push stays armed for it.",
      };
    }
    // Verified, not assumed: this result's whole job is to say the gate is
    // closed, and a delete that silently did not happen is exactly the claim
    // that must not be made.
    let stillThere = true;
    try {
      lstatSync(path);
    } catch {
      stillThere = false;
    }
    if (stillThere) {
      return {
        success: false,
        command: "hub-unlink",
        error: `This project's hub link (${path}) is still present after the removal, so this project is STILL linked and the session-end auto-push is still armed for it.`,
        suggestion: "Remove that file by hand, then run `sesh-mover hub status` to confirm.",
      };
    }

    warnings.push(
      "This project's local sync bookkeeping was kept, so nothing has to be re-uploaded if you link this directory to the same hub project again."
    );
    if (projectId) {
      warnings.push(`Re-link with a later push passing --project-id ${projectId}. Linking this directory to a DIFFERENT hub project on the same hub instead would leave that kept bookkeeping claiming the hub already holds sessions it does not, and the next push would send only the difference.`);
    }
    warnings.push(
      "Unlinking applies to this directory only. Any other directory holding a .sesh-mover-project.json — a scratch directory a pull unpacked a workspace into, for instance — is still linked and still armed, and has to be unlinked on its own."
    );
    warnings.push(
      "Sessions this project already pushed stay on the hub, and no other machine is affected: unlinking removes one local file and writes nothing to the hub."
    );

    return {
      success: true,
      command: "hub-unlink",
      wasLinked: true,
      projectId,
      removedPath: path,
      automationDisarmed: true,
      warnings,
    };
  } finally {
    lock?.release();
  }
}
