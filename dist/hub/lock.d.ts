import type { LockHolderLiveness, LockStealRecord } from "../types.js";
export type { LockHolderLiveness, LockStealRecord };
/**
 * How old a lock has to be before a holder we can PROVE is gone loses it.
 *
 * This is no longer the whole steal decision (#84) — it is the threshold for a
 * holder whose recorded pid does not exist on this machine any more. A holder
 * that is still running, or one we cannot identify, is held to
 * `LOCK_LIVE_HOLDER_CEILING_MS` instead.
 */
export declare const LOCK_STALE_MS: number;
/**
 * ---------------------------------------------------------------------------
 * THE HARD CEILING (#84): how long a lock survives when its holder is still
 * alive, or cannot be identified at all.
 *
 * A liveness probe on its own is not a fix, it is a trade. Refusing to steal
 * from a live holder turns one stuck process into a **silent permanent
 * outage** for that project — every push, pull, retire and unlink refuses
 * forever and nothing in the product ever clears it. So the probe buys safety
 * only up to here; past here the lock is taken regardless.
 *
 * **Failure directions, and the one this errs toward.** Stealing too early
 * costs CORRECTNESS: the victim keeps running (the lock is taken once and
 * never re-checked), and a stolen-from push has been measured running to
 * completion and rewriting `index/<machineId>.json` — the per-machine-owned
 * file this lock is the only same-machine defence for. That damage is silent
 * and it is to hub state. Refusing too long costs AVAILABILITY: hub operations
 * for one project decline. That cost is **visible** — a `lock-busy` refusal
 * naming the holder's pid, its age, and (now) that it is still running — and
 * it is recoverable by a human in one step (kill the pid, or `hub unlink
 * --force`, which exists precisely so the disarm path does not depend on the
 * thing being disarmed). A visible, recoverable delay beats a silent,
 * unrecoverable overwrite, so this errs LONG.
 *
 * **Why six times, and not more.** The case that survives #71 is a push that
 * legitimately outruns the staleness window — a large bundle over a
 * slow-but-working share, deliberately unbounded because bounding throughput
 * would fail exactly the shares this plugin exists to support. An hour is far
 * past any such push on a share that is actually working, and still short
 * enough that a genuinely stuck holder clears inside one working session
 * rather than needing the user to go pid-hunting. Expressed as a multiple so
 * the relationship to `LOCK_STALE_MS` is structural rather than coincidental:
 * whatever the staleness window becomes, the ceiling stays well above it.
 * ---------------------------------------------------------------------------
 */
export declare const LOCK_LIVE_HOLDER_CEILING_MS: number;
export declare class LockBusyError extends Error {
    readonly holderPid: number | null;
    readonly ageMs: number | null;
    /** What the liveness probe said about `holderPid` — see `probeHolderLiveness`. */
    readonly holderLiveness: LockHolderLiveness;
    /**
     * How much longer this lock is protected before it becomes stealable, or
     * null when its age could not be established at all (in which case nothing
     * will ever steal it and only a manual removal clears it).
     */
    readonly stealEligibleInMs: number | null;
    constructor(holderPid: number | null, ageMs: number | null, holderLiveness?: LockHolderLiveness, stealEligibleInMs?: number | null);
}
export interface LockHandle {
    release(): void;
    readonly stoleStale: boolean;
    /**
     * The full classification of the steal this acquisition performed, or null
     * when it took an unheld lock. `stoleStale` stays the boolean every caller
     * already branches on; this is the detail behind it, and it is what
     * `<lock>.steal.json` records.
     */
    readonly steal: LockStealRecord | null;
}
/**
 * Is the process that recorded this lock still on this machine?
 *
 * `process.kill(pid, 0)` sends no signal; it asks the kernel whether the pid
 * resolves. One syscall, non-blocking, no child process — which matters
 * because this runs on the SessionEnd hook path, where the whole budget is
 * 1.5s.
 *
 * **Every ambiguous answer is "unknown", and "unknown" is treated as alive.**
 * The asymmetry is the point: a wrong "alive" costs a delay bounded by
 * `LOCK_LIVE_HOLDER_CEILING_MS`, a wrong "dead" is an immediate steal from a
 * working process. So:
 *
 * - a hostname that is absent or not ours => unknown (see `LockRecord.host`;
 *   this also covers every lock written by a version before #84, which
 *   self-heals within one lock lifetime);
 * - a pid that is not a positive integer => unknown. **`pid <= 0` is a safety
 *   guard, not tidiness**: `process.kill(0, 0)` addresses the caller's whole
 *   process GROUP and would answer "alive" for a lock record carrying 0;
 * - `EPERM` => alive (the process exists, it is simply not ours to signal);
 * - `ESRCH` => dead, the only answer that unlocks the fast steal;
 * - anything else => unknown.
 *
 * **Pid reuse is a real thing and it lands on the safe side.** A recycled pid
 * makes a dead holder look alive, which only delays the steal to the ceiling;
 * it cannot make a live holder look dead, because that requires the pid to be
 * genuinely absent from the process table. The one residual is a holder in a
 * different pid namespace that shares this home directory (a container), where
 * a live pid can read as absent — that is exactly today's unconditional steal
 * at `LOCK_STALE_MS`, so it is a pre-existing hazard this change narrows
 * rather than one it introduces, and the hostname check catches the ordinary
 * shape of it.
 */
export declare function probeHolderLiveness(pid: number | null | undefined, host: string | null | undefined): LockHolderLiveness;
/**
 * The last steal recorded for a project, or null.
 *
 * Exported so a reporting verb can surface it: the steal record is the ONE
 * durable trace of a steal that does not depend on holding the lock, which is
 * what makes it the right channel here. `recordAutoPushOutcome` (cli.ts) —
 * the only reader an unattended session-end push has — writes its breadcrumb
 * by RE-TAKING this lock and gives up silently when it is busy, so a victim's
 * breadcrumb is dropped in precisely the case it is wanted: the thief is
 * holding the lock when the victim finishes.
 */
export declare function readLockStealRecord(projectPath: string): LockStealRecord | null;
export declare function acquireProjectLock(projectPath: string): LockHandle;
/**
 * The steal warning, phrased from the arm that actually fired (#84).
 *
 * The single sentence this replaced said "likely crashed or was killed" for
 * every steal. That is true of `dead-holder` and a LIE of the two ceiling arms,
 * which fire precisely when the holder was still running or could not be shown
 * to be gone — and it is the dangerous direction of wrong, because it tells a
 * user nothing is in progress at the moment something probably is.
 */
export declare function describeLockSteal(steal: LockStealRecord | null, verb: string): string;
//# sourceMappingURL=lock.d.ts.map