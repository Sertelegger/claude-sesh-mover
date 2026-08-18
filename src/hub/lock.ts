import {
  mkdirSync, openSync, closeSync, writeSync, rmSync, readFileSync, statSync, renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { encodeProjectPath } from "../platform.js";
import { userSeshMoverDir } from "../paths.js";
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
export const LOCK_STALE_MS = 10 * 60 * 1000;

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
export const LOCK_LIVE_HOLDER_CEILING_MS = 6 * LOCK_STALE_MS;

/**
 * On-disk lock file contents. `token` is minted fresh on every acquisition and
 * is what makes release() an ownership check rather than a blind unlink — see
 * release() for why that distinction is load-bearing.
 *
 * `host` exists for one reason (#84): the liveness probe is only meaningful if
 * the recorded pid belongs to THIS machine's process table. It normally does —
 * the locks directory is under `~/.sesh-mover`, which is per-machine state (it
 * also holds `machine-id.json`, on which the hub's whole per-machine-ownership
 * invariant rests). Recording the hostname turns that from an assumption into
 * a check, so a roaming/shared home directory degrades to "unknown holder"
 * (the conservative arm) instead of letting one machine declare another
 * machine's live pid dead and steal from it at once.
 */
interface LockRecord {
  pid?: number;
  host?: string;
  acquiredAt?: string;
  token?: string;
}

export class LockBusyError extends Error {
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
  constructor(
    holderPid: number | null,
    ageMs: number | null,
    holderLiveness: LockHolderLiveness = "unknown",
    stealEligibleInMs: number | null = null
  ) {
    // The message is not decoration: `hub unlink`, `hub reindex`, `hub retire`
    // and `hub delete` all copy it verbatim into their `lock-busy` refusal's
    // `error` field, which is what a human reads while deciding whether to
    // wait or to force past it. Under #84 "still running" is the answer to the
    // question that refusal now raises — why a 20-minute-old lock was not
    // simply taken.
    super(
      `another sesh-mover hub operation holds the project lock` +
        (holderPid ? ` (pid ${holderPid}${ageMs !== null ? `, ${Math.round(ageMs / 1000)}s old` : ""})` : "") +
        (holderLiveness === "alive"
          ? ` — that process is still running, so the lock was not taken from it` +
            (stealEligibleInMs !== null
              ? ` (it becomes stealable in ${Math.ceil(stealEligibleInMs / 1000)}s)`
              : "")
          : "")
    );
    this.holderPid = holderPid;
    this.ageMs = ageMs;
    this.holderLiveness = holderLiveness;
    this.stealEligibleInMs = stealEligibleInMs;
  }
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

function lockPath(projectPath: string): string {
  return join(userSeshMoverDir(), "locks", `${encodeProjectPath(projectPath)}.lock`);
}

/** Where a steal is written down. Beside the lock, never inside it: the lock file is deleted by the steal. */
function stealRecordPath(lock: string): string {
  return `${lock}.steal.json`;
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
export function probeHolderLiveness(
  pid: number | null | undefined,
  host: string | null | undefined
): LockHolderLiveness {
  if (typeof host !== "string" || host.length === 0 || host !== hostname()) return "unknown";
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive"; // exists, owned by someone else
    return "unknown";
  }
}

/** Best-effort stderr disclosure. A lock diagnostic must never be able to fail an operation. */
function disclose(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* stderr closed or broken — the durable record beside the lock survives it */
  }
}

/**
 * Write the steal record beside the lock, atomically.
 *
 * Atomic because both sides write it — the thief at steal time, the victim
 * when it finds out — and a reader that catches a partial write learns
 * nothing. Best effort in every direction: a read-only home must cost a
 * disclosure, never an operation.
 */
function writeStealRecord(lock: string, record: LockStealRecord): void {
  const target = stealRecordPath(lock);
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing left to try */
    }
  }
}

function readStealRecord(lock: string): LockStealRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(stealRecordPath(lock), "utf-8")) as LockStealRecord;
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

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
export function readLockStealRecord(projectPath: string): LockStealRecord | null {
  return readStealRecord(lockPath(projectPath));
}

// Cross-platform advisory lock for hub operations on a given project. Uses
// exclusive-create ("wx") for atomicity: two processes racing to create the
// same lock file can never both succeed, unlike a check-then-write pair.
//
// THE STEAL DECISION (#84) is a liveness probe plus a hard ceiling, never an
// age alone:
//
//   holder is provably GONE (pid absent on this machine)  -> steal at LOCK_STALE_MS
//   holder is STILL RUNNING                               -> steal at LOCK_LIVE_HOLDER_CEILING_MS
//   holder is UNIDENTIFIABLE (torn write, no pid, no host)-> steal at LOCK_LIVE_HOLDER_CEILING_MS
//
// A steal path has to exist at all because a crashed or SIGKILLed process
// never runs its release(), and without one a dead holder would wedge the
// project's hub operations forever. What it must NOT do is take the lock from
// a holder that is demonstrably alive and still working — until #84 that is
// exactly what it did: the decision was `ageMs > LOCK_STALE_MS` and nothing
// else, and the record's pid was read only to decorate `LockBusyError`.
//
// #71 removed that mechanism's TRIGGER, not the mechanism. The trigger was a
// hub read that blocked in the kernel forever (`hub/backend.ts` was
// `readFileSync`), which parked a push inside its own critical section for as
// long as the mount stayed dead. The backend is now bounded
// (`hub/io-timeout.ts`), so a push can no longer sit in the lock indefinitely
// through THAT route — but any push that legitimately outruns the window
// still could: a large bundle crossing a slow-but-working share, deliberately
// not bounded because bounding throughput would fail exactly the shares this
// plugin exists to support. Measured on the reproduction, a stolen-from push
// ran to completion and rewrote `index/<machineId>.json` with no lock at all.
//
// THE TORN-LOCK PATH is stated rather than incidental. The "wx" create and the
// JSON write are two syscalls, so a reader can catch a live holder at zero
// bytes — measured at roughly 1 run in 8. That path falls back to the file's
// mtime for an age and has NO pid to probe, and this module answers an
// unidentifiable holder the same way `tombstone.ts` answers an unparseable
// `retiredAt`: an unknown is not evidence of absence, so it gets the
// conservative arm — the full ceiling, not `LOCK_STALE_MS`. It costs an
// abandoned torn lock a longer wait (bounded, self-healing, disclosed) and it
// buys never taking a lock from a holder we simply failed to identify. Note
// what a torn lock at ten minutes actually implies: our own writer covers that
// window in microseconds, so a lock still unparseable that much later was
// abandoned mid-create or was never ours — which is also why the extra wait is
// paid by nobody who is working.
//
// A STEAL IS DISCLOSED, on both sides and without needing the lock:
// `<lock>.steal.json` beside the lock (see `readLockStealRecord`), a stderr
// line from the thief, and — when the victim eventually unwinds and finds its
// lock replaced — a second stderr line and a `noticedByHolderAt` stamp on that
// same record. Callers additionally surface `stoleStale` as a warning, which
// for a session-end push reaches `hub status` via `lastAutoPush`; the victim
// has no such channel, which is why the file exists.
export function acquireProjectLock(projectPath: string): LockHandle {
  const p = lockPath(projectPath);
  mkdirSync(join(userSeshMoverDir(), "locks"), { recursive: true });

  const tryAcquire = (): number | null => {
    try {
      return openSync(p, "wx"); // atomic create-if-absent
    } catch {
      return null;
    }
  };

  let steal: LockStealRecord | null = null;
  let fd = tryAcquire();
  if (fd === null) {
    let holderPid: number | null = null;
    let holderHost: string | null = null;
    let holderToken: string | null = null;
    let ageMs: number | null = null;
    let readable = false;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as LockRecord;
      readable = parsed !== null && typeof parsed === "object";
      if (readable) {
        holderPid = typeof parsed.pid === "number" ? parsed.pid : null;
        holderHost = typeof parsed.host === "string" ? parsed.host : null;
        holderToken = typeof parsed.token === "string" ? parsed.token : null;
        if (parsed.acquiredAt) ageMs = Date.now() - Date.parse(parsed.acquiredAt);
      }
    } catch {
      /* torn write or foreign file — the mtime fallback below is the only age there is */
    }
    // A record with no `acquiredAt`, or one whose timestamp does not parse,
    // yields NaN here — which loses every comparison below, so before #84 such
    // a lock was never stolen by anything and wedged the project permanently.
    // mtime is the same fallback the torn path uses and is the age of the file
    // that actually exists.
    if (ageMs === null || !Number.isFinite(ageMs)) {
      try {
        ageMs = Date.now() - statSync(p).mtimeMs;
      } catch {
        ageMs = null; // vanished between the failed open and this read — busy, not stale
      }
    }

    const liveness = readable ? probeHolderLiveness(holderPid, holderHost) : "unknown";
    const threshold = liveness === "dead" ? LOCK_STALE_MS : LOCK_LIVE_HOLDER_CEILING_MS;
    if (ageMs !== null && ageMs > threshold) {
      rmSync(p, { force: true }); // steal
      steal = {
        at: new Date().toISOString(),
        kind:
          liveness === "dead"
            ? "dead-holder"
            : liveness === "alive"
              ? "live-holder-past-ceiling"
              : "unidentified-holder-past-ceiling",
        holderPid,
        holderHost,
        holderToken,
        holderLiveness: liveness,
        holderAgeSeconds: Math.round(ageMs / 1000),
        stolenByPid: process.pid,
      };
      fd = tryAcquire();
      if (fd === null) {
        // Another process beat us to the freed path. We removed a lock and
        // hold nothing, so there is no steal of ours to record.
        steal = null;
      } else {
        writeStealRecord(p, steal);
        disclose(
          `sesh-mover: took the project lock for ${projectPath} from ` +
            `${steal.holderPid === null ? "an unidentified holder" : `pid ${steal.holderPid}`}` +
            ` (${steal.holderLiveness}, ${steal.holderAgeSeconds}s old). Recorded in ${stealRecordPath(p)}.` +
            (steal.holderLiveness === "alive"
              ? " That process was STILL RUNNING and is not told; if it is a sesh-mover push or pull," +
                " it can write hub state for this project concurrently with this operation."
              : "")
        );
      }
    }
    if (fd === null) {
      throw new LockBusyError(
        holderPid,
        ageMs,
        liveness,
        ageMs === null ? null : Math.max(0, threshold - ageMs)
      );
    }
  }

  // Per-acquisition identity. Not the pid: a pid is reused by the OS, and both
  // a steal and a plain re-acquire can happen inside one process (the test
  // suite does exactly that), so pid cannot distinguish "our lock" from "the
  // lock that replaced ours".
  const token = randomUUID();
  const record: LockRecord = {
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    token,
  };
  writeSync(fd, JSON.stringify(record));
  closeSync(fd);

  /**
   * We are the victim: the lock at `p` is not ours any more. Stamp the thief's
   * record so both halves of the overlap live in one file, and say so once.
   *
   * Keyed on the token, so it fires for the steal of OUR acquisition and never
   * for an older one, and is idempotent across a double release. Silent when
   * there is no record — a lock can also go missing to `rm -rf ~/.sesh-mover`,
   * and inventing a steal for that would be worse than saying nothing.
   */
  const noticeSteal = (): void => {
    try {
      const rec = readStealRecord(p);
      if (rec === null || rec.holderToken !== token || rec.noticedByHolderAt) return;
      writeStealRecord(p, { ...rec, noticedByHolderAt: new Date().toISOString() });
      disclose(
        `sesh-mover: this process (pid ${process.pid}) lost the project lock for ${projectPath}` +
          ` to pid ${rec.stolenByPid} at ${rec.at} (${rec.kind}) — the work it just finished ran` +
          ` without the lock it acquired. Recorded in ${stealRecordPath(p)}.`
      );
    } catch {
      /* disclosure is best effort; release() must not throw */
    }
  };

  return {
    stoleStale: steal !== null,
    steal,
    release() {
      // Delete the lock file ONLY if it is still the one we created.
      //
      // An unconditional `rmSync` here is a blind unlink of whatever currently
      // sits at `p`. Once our lock has been stolen (see above), that file
      // belongs to a DIFFERENT process: our release then frees a lock we no
      // longer hold, and a third process acquires while the real holder is
      // mid-write. What that holder is mid-way through is not bookkeeping — a
      // 3-way merge into the user's working tree (hub/merge.ts), a `git apply`
      // into a real repository (hub/carry.ts) and transcript splices
      // (hub/append.ts) — and the SessionEnd hook takes this lock unattended.
      //
      // The token is per-acquisition, so it also makes a double release and a
      // release-after-steal-then-someone-else-re-acquired into no-ops.
      //
      // Every branch below ends in "leave the file alone" and NONE of them
      // rethrows: release() runs from `finally` blocks, where a throw would
      // replace the caller's real error with a lock-cleanup error.
      let raw: string;
      try {
        raw = readFileSync(p, "utf-8");
      } catch {
        // Gone already, or unreadable. Either way there is nothing of ours
        // here to remove — but "gone" is also what a completed steal looks
        // like from here (the thief took it and has since released), so this
        // is one of the two places the victim can find out.
        noticeSteal();
        return;
      }
      let holderToken: unknown;
      try {
        holderToken = (JSON.parse(raw) as LockRecord).token;
      } catch {
        // Unparseable => NOT ours to delete. We only ever write valid JSON
        // carrying a token, so a file we cannot parse is one of: another
        // process's torn write (the "wx" create and the JSON write are two
        // separate syscalls, so a reader can legitimately catch a LIVE holder
        // at zero bytes), or a foreign file someone dropped into the locks
        // directory. Neither is evidence that the lock is ours, and removing
        // it would free a lock we do not hold — precisely the bug this token
        // exists to prevent. Leaving it costs nothing permanent:
        // acquireProjectLock's steal path reaps an unidentifiable lock through
        // its statSync/mtime fallback once it passes
        // LOCK_LIVE_HOLDER_CEILING_MS, which is the designated recovery for a
        // lock with no identifiable owner.
        noticeSteal();
        return;
      }
      if (holderToken !== token) {
        noticeSteal(); // someone else's lock now
        return;
      }
      // The read-then-unlink window narrows the race, it does not close it
      // (there is no portable compare-and-delete). It only opens for a lock we
      // have already let go stealable, i.e. a release arriving after the
      // holder's own window has expired.
      try {
        rmSync(p, { force: true });
      } catch {
        /* best effort: a failed unlink self-heals via the steal path */
      }
    },
  };
}

/**
 * The steal warning, phrased from the arm that actually fired (#84).
 *
 * The single sentence this replaced said "likely crashed or was killed" for
 * every steal. That is true of `dead-holder` and a LIE of the two ceiling arms,
 * which fire precisely when the holder was still running or could not be shown
 * to be gone — and it is the dangerous direction of wrong, because it tells a
 * user nothing is in progress at the moment something probably is.
 */
export function describeLockSteal(steal: LockStealRecord | null, verb: string): string {
  const tail = `verify no other push/pull is genuinely in progress for this project.`;
  if (steal === null || steal.kind === "dead-holder") {
    return `Stole a stale project lock left by a previous sesh-mover hub operation (the holder is gone \u2014 it crashed, was killed, or never released) \u2014 the ${verb} proceeded. ${tail}`;
  }
  const who =
    steal.kind === "live-holder-past-ceiling"
      ? `a holder that is STILL RUNNING (pid ${steal.holderPid ?? "unknown"})`
      : `a holder this machine could not identify (no readable pid, or a lock written by another machine)`;
  return (
    `Stole the project lock from ${who} after it held it past the safety ceiling \u2014 the ${verb} proceeded, ` +
    `and that operation was NOT stopped and has not been told. Both are now writing this project's hub state. ` +
    `See <lock>.steal.json for the record. ${tail}`
  );
}
