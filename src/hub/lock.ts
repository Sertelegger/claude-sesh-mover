import { mkdirSync, openSync, closeSync, writeSync, rmSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { encodeProjectPath } from "../platform.js";
import { userSeshMoverDir } from "../paths.js";

export const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * On-disk lock file contents. `token` is minted fresh on every acquisition and
 * is what makes release() an ownership check rather than a blind unlink — see
 * release() for why that distinction is load-bearing.
 */
interface LockRecord {
  pid?: number;
  acquiredAt?: string;
  token?: string;
}

export class LockBusyError extends Error {
  readonly holderPid: number | null;
  readonly ageMs: number | null;
  constructor(holderPid: number | null, ageMs: number | null) {
    super(
      `another sesh-mover hub operation holds the project lock` +
        (holderPid ? ` (pid ${holderPid}${ageMs !== null ? `, ${Math.round(ageMs / 1000)}s old` : ""})` : "")
    );
    this.holderPid = holderPid;
    this.ageMs = ageMs;
  }
}

export interface LockHandle {
  release(): void;
  readonly stoleStale: boolean;
}

function lockPath(projectPath: string): string {
  return join(userSeshMoverDir(), "locks", `${encodeProjectPath(projectPath)}.lock`);
}

// Cross-platform advisory lock for hub operations on a given project. Uses
// exclusive-create ("wx") for atomicity: two processes racing to create the
// same lock file can never both succeed, unlike a check-then-write pair.
// Locks older than LOCK_STALE_MS are stolen — a crashed/killed process
// (SIGKILL, power loss) never runs its release(), so without a steal path a
// dead holder would wedge the project's hub operations forever.
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

  let stoleStale = false;
  let fd = tryAcquire();
  if (fd === null) {
    let holderPid: number | null = null;
    let ageMs: number | null = null;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as LockRecord;
      holderPid = parsed.pid ?? null;
      if (parsed.acquiredAt) ageMs = Date.now() - Date.parse(parsed.acquiredAt);
    } catch {
      try {
        ageMs = Date.now() - statSync(p).mtimeMs;
      } catch {
        /* vanished between the failed open and this read — treat as busy, not stale */
      }
    }
    if (ageMs !== null && ageMs > LOCK_STALE_MS) {
      rmSync(p, { force: true }); // stale — steal
      stoleStale = true;
      fd = tryAcquire();
    }
    if (fd === null) throw new LockBusyError(holderPid, ageMs);
  }

  // Per-acquisition identity. Not the pid: a pid is reused by the OS, and both
  // a steal and a plain re-acquire can happen inside one process (the test
  // suite does exactly that), so pid cannot distinguish "our lock" from "the
  // lock that replaced ours".
  const token = randomUUID();
  const record: LockRecord = { pid: process.pid, acquiredAt: new Date().toISOString(), token };
  writeSync(fd, JSON.stringify(record));
  closeSync(fd);

  return {
    stoleStale,
    release() {
      // Delete the lock file ONLY if it is still the one we created.
      //
      // An unconditional `rmSync` here is a blind unlink of whatever currently
      // sits at `p`. Once our lock has been stolen as stale (see above), that
      // file belongs to a DIFFERENT process: our release then frees a lock we
      // no longer hold, and a third process acquires while the real holder is
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
        // Gone already (the normal case after a steal), or unreadable. Either
        // way there is nothing of ours here to remove.
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
        // acquireProjectLock's staleness path already reaps an unparseable
        // lock through its statSync/mtime fallback after LOCK_STALE_MS, which
        // is the designated recovery for a lock with no identifiable owner.
        return;
      }
      if (holderToken !== token) return; // someone else's lock now
      // The read-then-unlink window narrows the race, it does not close it
      // (there is no portable compare-and-delete). It only opens for a lock we
      // have already let go stale, i.e. a release arriving 10+ minutes late.
      try {
        rmSync(p, { force: true });
      } catch {
        /* best effort: a failed unlink self-heals via the staleness steal */
      }
    },
  };
}
