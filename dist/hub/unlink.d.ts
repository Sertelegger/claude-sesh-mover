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
export declare function hubUnlink(opts: HubUnlinkOptions): HubUnlinkResult | HubLockBusyResult | ErrorResult;
//# sourceMappingURL=unlink.d.ts.map