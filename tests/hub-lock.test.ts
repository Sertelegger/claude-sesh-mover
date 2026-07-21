import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
      const dir = join(homedir(), ".claude-sesh-mover", "locks");
      mkdirSync(dir, { recursive: true });
      const lockFile = join(dir, `${encodeProjectPath("/some/project")}.lock`);
      writeFileSync(lockFile, JSON.stringify({ pid: 99999, acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString() }));
      const h2 = acquireProjectLock("/some/project");
      expect(h2.stoleStale).toBe(true);
      h2.release();
    } finally { restore.restore(); rmSync(home, { recursive: true, force: true }); }
  });
});
