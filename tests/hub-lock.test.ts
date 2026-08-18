import { describe, it, expect } from "vitest";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, utimesSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir, hostname } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { describeLockSteal } from "../src/hub/lock.js";
import {
  acquireProjectLock, LockBusyError, LOCK_STALE_MS, LOCK_LIVE_HOLDER_CEILING_MS,
  probeHolderLiveness, readLockStealRecord,
} from "../src/hub/lock.js";
import { encodeProjectPath } from "../src/platform.js";

/**
 * ISSUE #84 — the steal decision consults liveness, and a steal is disclosed.
 *
 * Until #84 `acquireProjectLock` decided on `ageMs > LOCK_STALE_MS` and nothing
 * else; the recorded pid was read only to decorate `LockBusyError`. The rule
 * these tests pin is:
 *
 *   provably dead holder   -> stolen at LOCK_STALE_MS
 *   live holder            -> kept until LOCK_LIVE_HOLDER_CEILING_MS, then stolen
 *   unidentifiable holder  -> treated as live (the conservative arm)
 *
 * Time is compressed by rewriting `acquiredAt` (or the file's mtime, for a lock
 * that carries no parseable timestamp). That is not a source seam: it is the
 * same field a real holder writes, and the holder object under test is
 * untouched by the edit.
 */

const PROJECT = "/some/project";

function lockFileFor(project = PROJECT): string {
  return join(homedir(), ".sesh-mover", "locks", `${encodeProjectPath(project)}.lock`);
}

/**
 * A pid that is genuinely absent from this machine's process table.
 *
 * Not a large literal: pid_max is 4194304 on a modern Linux, so "99999" is a
 * pid an ordinary desktop hands out, and a test whose whole claim is "this
 * holder is dead" must not depend on that being unoccupied. `spawnSync`
 * returns only after the child has exited AND been reaped, so its pid names
 * nothing at that point.
 */
function reapedPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (typeof pid !== "number") throw new Error("could not spawn a probe child");
  return pid;
}

/** A lock file as a live/dead holder would have left it, at a chosen age. */
function plantLock(opts: {
  pid?: number | null;
  host?: string | null;
  token?: string;
  ageMs: number;
  project?: string;
}): string {
  const file = lockFileFor(opts.project ?? PROJECT);
  mkdirSync(join(homedir(), ".sesh-mover", "locks"), { recursive: true });
  const record: Record<string, unknown> = {
    acquiredAt: new Date(Date.now() - opts.ageMs).toISOString(),
    token: opts.token ?? "planted",
  };
  if (opts.pid !== null) record.pid = opts.pid ?? process.pid;
  if (opts.host !== null) record.host = opts.host ?? hostname();
  writeFileSync(file, JSON.stringify(record));
  return file;
}

/** Backdate a file so the mtime fallback sees the age we want. */
function backdateMtime(file: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
}

/**
 * Run `fn` with stderr captured.
 *
 * A steal writes a disclosure line to stderr (that is half the point of #84),
 * so every steal in this file would otherwise scribble across the runner's
 * output — and one test needs to read that line anyway.
 */
function captureStderr<T>(fn: () => T): { value: T; err: string } {
  const original = process.stderr.write.bind(process.stderr);
  let err = "";
  (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown): boolean => {
    err += String(chunk);
    return true;
  }) as unknown;
  try {
    return { value: fn(), err };
  } finally {
    (process.stderr as unknown as { write: unknown }).write = original;
  }
}

function withHome(fn: () => void): void {
  const home = mkdtempSync(join(tmpdir(), "sesh-lock-home-"));
  const restore = overrideHome(home);
  try {
    fn();
  } finally {
    restore.restore();
    rmSync(home, { recursive: true, force: true });
  }
}

describe("project lock", () => {
  it("acquire/release; second acquire while held throws LockBusyError", () => {
    withHome(() => {
      const h = acquireProjectLock(PROJECT);
      expect(h.stoleStale).toBe(false);
      expect(h.steal).toBeNull();
      expect(() => acquireProjectLock(PROJECT)).toThrow(LockBusyError);
      h.release();
      const h2 = acquireProjectLock(PROJECT);
      h2.release();
    });
  });

  it("steals a stale lock from a holder that is provably gone, and reports it", () => {
    withHome(() => {
      // A crashed or SIGKILLed holder never runs its release(). This is the
      // arm the steal path exists for, and the only one that still fires at
      // LOCK_STALE_MS.
      plantLock({ pid: reapedPid(), ageMs: LOCK_STALE_MS + 1_000 });
      const { value: h2 } = captureStderr(() => acquireProjectLock(PROJECT));
      expect(h2.stoleStale).toBe(true);
      expect(h2.steal?.kind).toBe("dead-holder");
      expect(h2.steal?.holderLiveness).toBe("dead");
      h2.release();
    });
  });

  it("does NOT steal from a dead holder before LOCK_STALE_MS", () => {
    withHome(() => {
      // CHARACTERIZATION, not a regression test: this passes against the
      // pre-#84 code too, because that code refused everything under
      // LOCK_STALE_MS as well. It is here because #84 is the change that could
      // plausibly have widened it — a liveness probe is an obvious excuse to
      // steal a dead holder's lock the instant it is seen, and that would make
      // every crash-recovery window shorter for everybody. Mutation-checked:
      // dropping the floor for a dead holder kills it.
      plantLock({ pid: reapedPid(), ageMs: LOCK_STALE_MS - 5_000 });
      expect(() => acquireProjectLock(PROJECT)).toThrow(LockBusyError);
    });
  });

  it("does NOT steal from a live holder past LOCK_STALE_MS, and says why", () => {
    withHome(() => {
      // THE FIX, stated as one assertion. Before #84 this lock was taken and
      // the still-running holder went on writing hub state underneath the
      // thief. `process.pid` is the holder here because its liveness is not in
      // question.
      plantLock({ pid: process.pid, ageMs: LOCK_STALE_MS + 60_000 });
      let caught: LockBusyError | null = null;
      try {
        acquireProjectLock(PROJECT);
      } catch (e) {
        caught = e as LockBusyError;
      }
      expect(caught).toBeInstanceOf(LockBusyError);
      expect(caught?.holderPid).toBe(process.pid);
      expect(caught?.holderLiveness).toBe("alive");
      // The refusal is the disclosure on this side: `hub unlink`, `hub
      // reindex`, `hub retire` and `hub delete` copy this message verbatim
      // into their lock-busy result's `error`, and it now answers the question
      // an 11-minute-old lock raises.
      expect(caught?.message).toContain("still running");
      // Bounded, not forever: the ceiling is what keeps a stuck holder from
      // becoming a silent permanent outage, and the refusal names the wait.
      expect(caught?.stealEligibleInMs).toBeGreaterThan(0);
      expect(caught?.stealEligibleInMs).toBeLessThanOrEqual(
        LOCK_LIVE_HOLDER_CEILING_MS - LOCK_STALE_MS
      );
      expect(caught?.message).toMatch(/becomes stealable in \d+s/);
    });
  });

  it("DOES steal from a live holder once it passes the ceiling", () => {
    withHome(() => {
      // The other half of the trade. A liveness probe alone converts a stuck
      // holder into a project that can never push again; past the ceiling the
      // lock is taken from a demonstrably live process on purpose.
      plantLock({ pid: process.pid, ageMs: LOCK_LIVE_HOLDER_CEILING_MS + 1_000 });
      const { value: h, err } = captureStderr(() => acquireProjectLock(PROJECT));
      expect(h.stoleStale).toBe(true);
      expect(h.steal?.kind).toBe("live-holder-past-ceiling");
      expect(h.steal?.holderLiveness).toBe("alive");
      expect(h.steal?.holderPid).toBe(process.pid);
      // A steal from something still running is the dangerous one, so it says
      // so rather than reusing the "likely crashed" wording.
      expect(err).toContain("STILL RUNNING");
      h.release();
    });
  });

  it("treats an unidentifiable holder as live: a torn lock survives LOCK_STALE_MS and is reaped at the ceiling", () => {
    withHome(() => {
      // THE TORN-LOCK PATH, stated. The "wx" create and the JSON write are two
      // syscalls, so a reader can catch a LIVE holder at zero bytes — measured
      // at roughly 1 run in 8 during #71's reproduction. That path has no pid
      // to probe, and an unknown is not evidence of an absent holder, so it
      // gets the conservative arm rather than the fast one.
      const file = lockFileFor();
      mkdirSync(join(homedir(), ".sesh-mover", "locks"), { recursive: true });
      writeFileSync(file, ""); // exactly what a torn write leaves
      backdateMtime(file, LOCK_STALE_MS + 60_000);
      expect(() => acquireProjectLock(PROJECT)).toThrow(LockBusyError);

      // It is still bounded — an abandoned torn lock does not wedge the
      // project forever, it just waits longer than a lock that named its
      // owner.
      backdateMtime(file, LOCK_LIVE_HOLDER_CEILING_MS + 1_000);
      const { value: h } = captureStderr(() => acquireProjectLock(PROJECT));
      expect(h.stoleStale).toBe(true);
      expect(h.steal?.kind).toBe("unidentified-holder-past-ceiling");
      expect(h.steal?.holderPid).toBeNull();
      h.release();
    });
  });

  it("treats a lock from another host — or from before this field existed — as unidentifiable", () => {
    withHome(() => {
      // The probe is only meaningful if the pid is in THIS machine's process
      // table. `~/.sesh-mover` is per-machine state by design (it also holds
      // machine-id.json), but a roaming home would break that silently, and a
      // lock written by a version before #84 carries no host at all. Both
      // degrade to the conservative arm instead of letting one machine call
      // another machine's live pid dead.
      plantLock({ pid: process.pid, host: "some-other-machine", ageMs: LOCK_STALE_MS + 60_000 });
      expect(() => acquireProjectLock(PROJECT)).toThrow(LockBusyError);

      plantLock({ pid: reapedPid(), host: null, ageMs: LOCK_STALE_MS + 60_000 });
      expect(() => acquireProjectLock(PROJECT)).toThrow(LockBusyError);
    });
  });

  it("never probes pid 0: it addresses the process GROUP, not a holder", () => {
    withHome(() => {
      // `process.kill(0, 0)` signals the caller's own process group and
      // succeeds, so a record carrying 0 would read as "alive" for a reason
      // that has nothing to do with the holder — and a record carrying -1
      // would address every process the user can signal. Both are `unknown`.
      expect(probeHolderLiveness(0, hostname())).toBe("unknown");
      expect(probeHolderLiveness(-1, hostname())).toBe("unknown");
      expect(probeHolderLiveness(1.5, hostname())).toBe("unknown");
      expect(probeHolderLiveness(null, hostname())).toBe("unknown");
      expect(probeHolderLiveness(process.pid, hostname())).toBe("alive");
      expect(probeHolderLiveness(process.pid, "not-this-host")).toBe("unknown");
      expect(probeHolderLiveness(reapedPid(), hostname())).toBe("dead");
      // EPERM — the process exists, it is simply not ours to signal — must
      // read ALIVE, never as absent. This is the direction that matters: a
      // permission error is evidence the holder EXISTS, and mapping it to
      // "dead" would steal a live holder's lock.
      //
      // POSIX only, and the reason is not squeamishness about platforms. pid 1
      // is init and is guaranteed present-but-unsignalable to a non-root user;
      // **Windows has no pid 1 at all**, so `process.kill(1, 0)` throws ESRCH
      // there and the call correctly answers "dead" — asserting "alive" was
      // asserting a POSIX fact on a platform where it is false.
      //
      // Windows has no portable stand-in worth pinning (the System process's
      // pid is an implementation detail), so the EPERM→alive mapping is
      // genuinely unexercised there. It is a one-line branch shared by every
      // platform, and every OTHER arm above runs on all three.
      if (process.platform !== "win32") {
        // Under a root runner the probe succeeds outright and this degrades to
        // a characterization of the same answer.
        expect(probeHolderLiveness(1, hostname())).toBe("alive");
      }
    });
  });

  it("falls back to mtime when a lock's own timestamp is unusable", () => {
    withHome(() => {
      // Regression: `Date.parse` of garbage is NaN, `Date.now() - NaN` is NaN,
      // and NaN loses every comparison — so a lock whose `acquiredAt` did not
      // parse was never stolen by anything and wedged the project
      // permanently. The mtime fallback the torn path uses is the age of the
      // file that actually exists.
      const file = lockFileFor();
      mkdirSync(join(homedir(), ".sesh-mover", "locks"), { recursive: true });
      writeFileSync(file, JSON.stringify({ pid: reapedPid(), host: hostname(), acquiredAt: "whenever", token: "t" }));
      backdateMtime(file, LOCK_STALE_MS + 1_000);
      const { value: h } = captureStderr(() => acquireProjectLock(PROJECT));
      expect(h.stoleStale).toBe(true);
      expect(h.steal?.kind).toBe("dead-holder");
      h.release();
    });
  });

  // Regression: release() used to be an unconditional `rmSync(p, {force:true})`
  // — a blind unlink of whatever sat at the lock path, not of OUR lock. So once
  // A's lock had been stolen, A's eventual release() deleted B's lock and
  // handed the project to a third process while B was mid-write. What B is
  // mid-way through is a 3-way merge into the working tree, a `git apply`, and
  // transcript splices, and the SessionEnd hook takes this lock unattended.
  it("release() after its lock was stolen leaves the thief's lock intact, and discloses the loss", () => {
    withHome(() => {
      const lockFile = lockFileFor();

      const a = acquireProjectLock(PROJECT);
      expect(a.stoleStale).toBe(false);

      // Age A's lock past the CEILING without disturbing anything else about
      // it — same pid, same host, same owner token. Rewriting the file rather
      // than recreating it is the whole point: this is A's real lock, so a
      // release() that only looks at the path cannot tell it has been stolen.
      // The ceiling rather than LOCK_STALE_MS because A is this process, and
      // after #84 a live holder keeps its lock until then.
      const aRecord = JSON.parse(readFileSync(lockFile, "utf-8")) as Record<string, unknown>;
      const aToken = aRecord.token as string;
      writeFileSync(lockFile, JSON.stringify({
        ...aRecord,
        acquiredAt: new Date(Date.now() - LOCK_LIVE_HOLDER_CEILING_MS - 1).toISOString(),
      }));

      // B steals it and is now the legitimate holder.
      const { value: b } = captureStderr(() => acquireProjectLock(PROJECT));
      expect(b.stoleStale).toBe(true);
      const bRecord = readFileSync(lockFile, "utf-8");

      // THE DISCLOSURE, thief side: a durable record beside the lock, written
      // without needing the lock — which is the whole reason it is a file.
      const stolen = readLockStealRecord(PROJECT);
      expect(stolen?.kind).toBe("live-holder-past-ceiling");
      expect(stolen?.holderToken).toBe(aToken);
      expect(stolen?.stolenByPid).toBe(process.pid);
      expect(stolen?.noticedByHolderAt).toBeUndefined();

      // A finally unwinds. Its release must be a no-op: the lock at that path
      // is B's now.
      const { err } = captureStderr(() => a.release());

      expect(existsSync(lockFile), "A's release deleted B's lock file").toBe(true);
      expect(readFileSync(lockFile, "utf-8"), "A's release rewrote/replaced B's lock").toBe(bRecord);
      // The consequence that actually hurts: with B's lock gone, a third
      // process acquires while B is mid-write.
      expect(() => acquireProjectLock(PROJECT)).toThrow(LockBusyError);

      // THE DISCLOSURE, victim side. Before #84 this was the silent half: the
      // victim's own release() is a token-mismatch no-op, and the breadcrumb
      // it would otherwise leave (`recordAutoPushOutcome`) is written by
      // re-taking the very lock the thief still holds, so it is dropped in
      // exactly the stolen case.
      expect(err).toContain("lost the project lock");
      expect(readLockStealRecord(PROJECT)?.noticedByHolderAt).toBeTruthy();

      // Idempotent: a second release neither re-stamps nor re-announces.
      const stamped = readLockStealRecord(PROJECT)?.noticedByHolderAt;
      const { err: again } = captureStderr(() => a.release());
      expect(again).toBe("");
      expect(readLockStealRecord(PROJECT)?.noticedByHolderAt).toBe(stamped);

      // And B's own release still works.
      b.release();
      expect(existsSync(lockFile)).toBe(false);
      acquireProjectLock(PROJECT).release();
    });
  });

  it("the victim finds out even when the thief has already finished", () => {
    withHome(() => {
      // The likelier ordering, and the one that used to leave no trace at all:
      // the thief takes the lock, completes, and releases before the victim
      // unwinds. From the victim's release() the lock file is simply GONE —
      // indistinguishable from `rm -rf ~/.sesh-mover` unless something durable
      // survived the thief. The steal record is that something, and it is
      // matched on the victim's own token so an older steal cannot be
      // mistaken for this one.
      const lockFile = lockFileFor();
      const a = acquireProjectLock(PROJECT);
      const aRecord = JSON.parse(readFileSync(lockFile, "utf-8")) as Record<string, unknown>;
      writeFileSync(lockFile, JSON.stringify({
        ...aRecord,
        acquiredAt: new Date(Date.now() - LOCK_LIVE_HOLDER_CEILING_MS - 1).toISOString(),
      }));
      const { value: b } = captureStderr(() => acquireProjectLock(PROJECT));
      expect(b.stoleStale).toBe(true);
      b.release();
      expect(existsSync(lockFile)).toBe(false);

      const { err } = captureStderr(() => a.release());
      expect(err).toContain("lost the project lock");
      expect(readLockStealRecord(PROJECT)?.noticedByHolderAt).toBeTruthy();
    });
  });

  it("a lock that simply vanished is not reported as a steal", () => {
    withHome(() => {
      // `rm -rf ~/.sesh-mover` (or another tool) is not a steal, and inventing
      // one would be worse than saying nothing. No record => no claim.
      const a = acquireProjectLock(PROJECT);
      rmSync(lockFileFor(), { force: true });
      const { err } = captureStderr(() => a.release());
      expect(err).toBe("");
      expect(readLockStealRecord(PROJECT)).toBeNull();

      // Nor is an OLDER steal, of somebody else's acquisition, re-reported as
      // this one's. The record survives the lock it describes, so the token is
      // what ties it to a holder — a path check would claim every subsequent
      // vanished lock for the same project.
      const previous = {
        at: "2020-01-01T00:00:00.000Z", kind: "dead-holder", holderPid: 4242,
        holderHost: hostname(), holderToken: "somebody-else", holderLiveness: "dead",
        holderAgeSeconds: 900, stolenByPid: 4243,
      };
      writeFileSync(`${lockFileFor()}.steal.json`, JSON.stringify(previous));
      const b = acquireProjectLock(PROJECT);
      rmSync(lockFileFor(), { force: true });
      const { err: quiet } = captureStderr(() => b.release());
      expect(quiet).toBe("");
      expect(readLockStealRecord(PROJECT)?.noticedByHolderAt).toBeUndefined();
    });
  });

  it("release() never throws on a missing, unparseable or double-released lock", () => {
    withHome(() => {
      const lockFile = lockFileFor();

      // Vanished under us (a `rm -rf ~/.sesh-mover`, or another tool).
      const gone = acquireProjectLock(PROJECT);
      rmSync(lockFile, { force: true });
      expect(() => gone.release()).not.toThrow();

      // Double release.
      const twice = acquireProjectLock(PROJECT);
      twice.release();
      expect(() => twice.release()).not.toThrow();

      // Unparseable. release() runs from `finally` blocks, so it must not
      // throw — and it must NOT delete either: a file we cannot parse is
      // either a live holder's torn write ("wx" create and the JSON write are
      // two syscalls) or a foreign file, and neither is proof it is ours.
      const torn = acquireProjectLock(PROJECT);
      writeFileSync(lockFile, "{not json");
      expect(() => torn.release()).not.toThrow();
      expect(existsSync(lockFile), "release() deleted a lock it could not prove was its own").toBe(true);
      expect(readFileSync(lockFile, "utf-8")).toBe("{not json");
    });
  });

  describe("the steal warning (#84)", () => {
    /**
     * The sentence this replaced said "likely crashed or was killed" for EVERY
     * steal. That is true of `dead-holder` and false of both ceiling arms,
     * which fire precisely when the holder was still running or could not be
     * shown to be gone — and it is the dangerous direction of wrong, because it
     * tells a user nothing is in progress at the moment something probably is.
     *
     * Asserted as a NEGATIVE on the two ceiling arms rather than as an exact
     * string: what must never happen is the crash claim, and pinning the whole
     * sentence would make a reword look like a regression.
     */
    it("never claims the holder crashed when the ceiling is what fired", () => {
      const live = describeLockSteal(
        {
          at: "2026-01-01T00:00:00.000Z",
          kind: "live-holder-past-ceiling",
          holderPid: 4242, holderHost: hostname(), holderToken: "t",
          holderLiveness: "alive", holderAgeSeconds: 3700, stolenByPid: 7,
        },
        "push"
      );
      expect(live).not.toMatch(/crashed|was killed/i);
      expect(live).toMatch(/still running/i);
      expect(live).toContain("4242");
      // The victim is not stopped and not told — the fact a user needs most.
      expect(live).toMatch(/not been told|NOT stopped/i);

      const unknown = describeLockSteal(
        {
          at: "2026-01-01T00:00:00.000Z",
          kind: "unidentified-holder-past-ceiling",
          holderPid: null, holderHost: null, holderToken: null,
          holderLiveness: "unknown", holderAgeSeconds: 3700, stolenByPid: 7,
        },
        "pull"
      );
      expect(unknown).not.toMatch(/crashed|was killed/i);
      expect(unknown).toMatch(/could not identify/i);

      // ...and the benign arm still says the benign thing.
      const dead = describeLockSteal(
        {
          at: "2026-01-01T00:00:00.000Z",
          kind: "dead-holder",
          holderPid: 999999, holderHost: hostname(), holderToken: "t",
          holderLiveness: "dead", holderAgeSeconds: 700, stolenByPid: 7,
        },
        "unlink"
      );
      expect(dead).toMatch(/holder is gone/i);
      expect(dead).toContain("unlink");
    });
  });
});
