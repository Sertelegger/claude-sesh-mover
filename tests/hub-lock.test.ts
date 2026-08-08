import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { acquireProjectLock, LockBusyError, LOCK_STALE_MS } from "../src/hub/lock.js";
import { encodeProjectPath } from "../src/platform.js";

describe("project lock", () => {
  it("acquire/release; second acquire while held throws LockBusyError", () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-lock-home-"));
    const restore = overrideHome(home);
    try {
      const h = acquireProjectLock("/some/project");
      expect(h.stoleStale).toBe(false);
      expect(() => acquireProjectLock("/some/project")).toThrow(LockBusyError);
      h.release();
      const h2 = acquireProjectLock("/some/project");
      h2.release();
    } finally { restore.restore(); rmSync(home, { recursive: true, force: true }); }
  });

  it("steals a stale lock and reports it", () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-lock-home-"));
    const restore = overrideHome(home);
    try {
      const h = acquireProjectLock("/some/project");
      h.release();
      // Recreate a lock file with an ancient timestamp. Path computed via
      // encodeProjectPath (not hardcoded) so this stays correct if the
      // encoding scheme ever changes.
      const dir = join(homedir(), ".sesh-mover", "locks");
      mkdirSync(dir, { recursive: true });
      const lockFile = join(dir, `${encodeProjectPath("/some/project")}.lock`);
      writeFileSync(lockFile, JSON.stringify({ pid: 99999, acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString() }));
      const h2 = acquireProjectLock("/some/project");
      expect(h2.stoleStale).toBe(true);
      h2.release();
    } finally { restore.restore(); rmSync(home, { recursive: true, force: true }); }
  });

  // Regression: release() used to be an unconditional `rmSync(p, {force:true})`
  // — a blind unlink of whatever sat at the lock path, not of OUR lock. So once
  // A's lock had been stolen as stale, A's eventual release() deleted B's lock
  // and handed the project to a third process while B was mid-write. What B is
  // mid-way through is a 3-way merge into the working tree, a `git apply`, and
  // transcript splices, and the SessionEnd hook takes this lock unattended.
  it("release() after its lock was stolen leaves the thief's lock intact", () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-lock-home-"));
    const restore = overrideHome(home);
    try {
      const lockFile = join(
        homedir(), ".sesh-mover", "locks", `${encodeProjectPath("/some/project")}.lock`
      );

      const a = acquireProjectLock("/some/project");
      expect(a.stoleStale).toBe(false);

      // Age A's lock past the staleness threshold WITHOUT disturbing anything
      // else about it — same pid, same owner token. Rewriting the file rather
      // than recreating it is the whole point: this is A's real lock, so a
      // release() that only looks at the path cannot tell it has been stolen.
      const aRecord = JSON.parse(readFileSync(lockFile, "utf-8")) as Record<string, unknown>;
      writeFileSync(lockFile, JSON.stringify({
        ...aRecord,
        acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 1).toISOString(),
      }));

      // B steals it and is now the legitimate holder.
      const b = acquireProjectLock("/some/project");
      expect(b.stoleStale).toBe(true);
      const bRecord = readFileSync(lockFile, "utf-8");

      // A finally unwinds. Its release must be a no-op: the lock at that path
      // is B's now.
      a.release();

      expect(existsSync(lockFile), "A's release deleted B's lock file").toBe(true);
      expect(readFileSync(lockFile, "utf-8"), "A's release rewrote/replaced B's lock").toBe(bRecord);
      // The consequence that actually hurts: with B's lock gone, a third
      // process acquires while B is mid-write.
      expect(() => acquireProjectLock("/some/project")).toThrow(LockBusyError);

      // And B's own release still works.
      b.release();
      expect(existsSync(lockFile)).toBe(false);
      acquireProjectLock("/some/project").release();
    } finally { restore.restore(); rmSync(home, { recursive: true, force: true }); }
  });

  it("release() never throws on a missing, unparseable or double-released lock", () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-lock-home-"));
    const restore = overrideHome(home);
    try {
      const lockFile = join(
        homedir(), ".sesh-mover", "locks", `${encodeProjectPath("/some/project")}.lock`
      );

      // Vanished under us (a `rm -rf ~/.sesh-mover`, or another tool).
      const gone = acquireProjectLock("/some/project");
      rmSync(lockFile, { force: true });
      expect(() => gone.release()).not.toThrow();

      // Double release.
      const twice = acquireProjectLock("/some/project");
      twice.release();
      expect(() => twice.release()).not.toThrow();

      // Unparseable. release() runs from `finally` blocks, so it must not
      // throw — and it must NOT delete either: a file we cannot parse is
      // either a live holder's torn write ("wx" create and the JSON write are
      // two syscalls) or a foreign file, and neither is proof it is ours.
      const torn = acquireProjectLock("/some/project");
      writeFileSync(lockFile, "{not json");
      expect(() => torn.release()).not.toThrow();
      expect(existsSync(lockFile), "release() deleted a lock it could not prove was its own").toBe(true);
      expect(readFileSync(lockFile, "utf-8")).toBe("{not json");
    } finally { restore.restore(); rmSync(home, { recursive: true, force: true }); }
  });
});
