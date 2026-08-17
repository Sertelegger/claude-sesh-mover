import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync,
  existsSync, readdirSync, realpathSync, openSync, writeSync, closeSync, constants, cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { overrideHome, homeEnv, tmpEnv } from "./helpers/env.js";
import { cliPath } from "./helpers/run-cli.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";
import { LOCK_STALE_MS } from "../src/hub/lock.js";

/**
 * ISSUE #71 — reproduction, not a fix.
 *
 * The claim is a composition of three individually-correct facts: the SessionEnd
 * hook is spawned detached with `async: true` and no `timeout` (so Claude Code
 * cannot bound it), and `acquireProjectLock` steals a lock older than
 * `LOCK_STALE_MS` **without checking whether the holder is alive**. A push
 * wedged on an unreachable share therefore runs forever, the next session's push
 * steals its lock ten minutes later and wedges too, and nothing reaps any of
 * them.
 *
 * ## How the wedge is produced, and what it does and does not stand in for
 *
 * A `sleep` would not be evidence: a sleeping process is interruptible by
 * anything the event loop can service, and the whole question is what the
 * process can still do while it is stuck. So the blocker here is a **real
 * blocking filesystem call**: `hub.json` on the hub is a FIFO, and
 * `createFsBackend().read()` is `readFileSync`, whose `open(…, O_RDONLY)` on a
 * FIFO blocks in the kernel until a writer appears (`wchan: wait_for_partner`).
 * That is the same class of stall as a hard-mounted NFS/CIFS share or a FUSE
 * mount whose daemon died — a syscall that never returns — and it lands at
 * exactly the place a real push reaches it: `preflightHub`, INSIDE the project
 * lock (`hubPush` acquires the lock, then preflights).
 *
 * What the substitution does NOT prove:
 *   - It does not reproduce a network filesystem's own timeouts. A soft-mounted
 *     NFS share returns EIO after `retrans*timeo` and a push there fails rather
 *     than wedging; only a hard mount (the default) hangs indefinitely.
 *   - It does not prove the hang is *permanent* in the field, only that nothing
 *     in this codebase bounds it: no timer, signal or deadline in the push path
 *     can end a `readFileSync` (see the fourth test, which measures that).
 *   - It does not reproduce a share that DISAPPEARS (an unmounted path, a synced
 *     folder that never arrived). That case is already bounded and does not
 *     accrue anything: `probeHubReachable`'s `statSync` returns ENOENT
 *     immediately and the push refuses with `hub-unreachable`
 *     (`tests/hub-hooks.test.ts` pins it). The accrual needs a share that
 *     BLOCKS, not one that is absent — a materially narrower blast radius than
 *     the issue's "unreachable network share" wording suggests.
 *
 * ## Reaping
 *
 * Every child spawned here is registered in `spawned` and killed in an
 * `afterEach` that runs even when a test times out or throws mid-way. Each test
 * ALSO reaps gracefully first — writing to the FIFO releases every blocked
 * reader — so the normal path exercises the real exit and the `afterEach` is a
 * backstop. A test in this file that leaves a stuck `node` behind fails the
 * suite loudly rather than quietly polluting the runner.
 */

const isWindows = process.platform === "win32";

/** A FIFO is the blocker; skip the whole file where mkfifo doesn't exist. */
const canMkfifo = ((): boolean => {
  if (isWindows) return false;
  const probe = mkdtempSync(join(tmpdir(), "sesh-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(probe, "f")], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const MACHINE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

interface Spawned {
  proc: ChildProcess;
  pid: number;
  stdout: string;
  stderr: string;
  exit: Promise<number | null>;
  exited: boolean;
  code: number | null;
}

const spawned: Spawned[] = [];

/** Is a pid still a live process? (EPERM also means "alive, not ours".) */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  watch?: Spawned,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // The child we are waiting on died: it is never going to satisfy the
    // predicate, so fail with its output rather than burning the timeout.
    if (watch?.exited) {
      throw new Error(
        `${label}: the child exited early (code ${watch.code}) — stdout=${JSON.stringify(watch.stdout)} stderr=${JSON.stringify(watch.stderr)}`
      );
    }
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Spawn the real SessionEnd hook endpoint, exactly as hooks/hooks.json does. */
function spawnHook(env: Record<string, string>, payload: string): Spawned {
  const proc = spawn("node", [cliPath(), "hub", "hook-session-end"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rec: Spawned = {
    proc,
    pid: proc.pid as number,
    stdout: "",
    stderr: "",
    exited: false,
    code: null,
    exit: new Promise<number | null>((resolve) => {
      proc.on("close", (code) => {
        rec.exited = true;
        rec.code = code;
        resolve(code);
      });
    }),
  };
  proc.stdout.setEncoding("utf-8");
  proc.stdout.on("data", (d: string) => { rec.stdout += d; });
  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (d: string) => { rec.stderr += d; });
  proc.stdin.end(payload);
  spawned.push(rec);
  return rec;
}

/**
 * Release every reader blocked on `fifo`, handing them `contents` (empty =>
 * they read zero bytes).
 *
 * O_NONBLOCK matters: a plain `open(…, "w")` on a FIFO blocks until a READER
 * arrives, so if the wedged child had already died this helper would hang the
 * test runner instead of the child. Non-blocking, it fails with ENXIO instead.
 */
function unblockFifo(fifo: string, contents = ""): boolean {
  let fd: number;
  try {
    fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch {
    return false; // no reader waiting
  }
  try {
    if (contents) writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Temp trees are removed HERE rather than in the suite's own `afterEach`, and
 * strictly after the children are dead. Vitest runs `afterEach` hooks in
 * reverse registration order, so a suite-level cleanup would run FIRST — and a
 * test that ended with a child still alive (a failure, a timeout) would then
 * delete the tree out from under a process that is still writing into it,
 * leaving exactly the kind of debris this file is supposed to prove absent.
 */
const tempTrees: string[] = [];

afterEach(async () => {
  const survivors: number[] = [];
  for (const s of spawned) {
    if (s.exited) continue;
    try {
      s.proc.kill("SIGKILL");
    } catch { /* already gone */ }
    await Promise.race([s.exit, sleep(5000)]);
    if (isAlive(s.pid)) survivors.push(s.pid);
  }
  spawned.length = 0;
  for (const dir of tempTrees.splice(0)) rmSync(dir, { recursive: true, force: true });
  // A wedged `node` surviving a test is exactly the failure mode this file is
  // about; it must never be something the suite leaves behind.
  expect(survivors, "hook children survived the test").toEqual([]);
});

describe.skipIf(!canMkfifo)("issue #71: a wedged auto-push and the unconditional stale-lock steal", () => {
  let tempDir: string;
  let home: string;
  let base: string;
  let hubDir: string;
  let tmpRoot: string;
  let configDir: string;
  let sessionId: string;
  let project: string;
  let childEnv: Record<string, string>;
  let lockFile: string;
  let fifo: string;

  beforeEach(() => {
    // realpath up front: sync-state and the lock are keyed by the ENCODED
    // project path, and a child process always resolves its own cwd.
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "sesh-orphan-")));
    tempTrees.push(tempDir); // removed by the module-level afterEach, after the reap
    home = join(tempDir, "home");
    base = join(tempDir, "base");
    hubDir = join(tempDir, "hub");
    tmpRoot = join(tempDir, "childtmp");
    for (const d of [home, base, hubDir, tmpRoot]) mkdirSync(d, { recursive: true });

    const fixture = createFixtureTree(base);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
    project = join(base, "proj");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "README.md"), "hello\n");
    cpSync(
      join(configDir, "projects", FIXTURE_ENCODED),
      join(configDir, "projects", encodeProjectPath(project)),
      { recursive: true }
    );

    // Pin the machine identity so the test and the spawned CLI agree on which
    // per-machine index file is "this machine's".
    mkdirSync(join(home, ".sesh-mover"), { recursive: true });
    writeFileSync(
      join(home, ".sesh-mover", "machine-id.json"),
      JSON.stringify({ id: MACHINE_ID, name: "my-laptop", createdAt: "2026-07-21T00:00:00Z" }) + "\n"
    );
    mkdirSync(join(home, ".sesh-mover"), { recursive: true });
    writeFileSync(
      join(home, ".sesh-mover", "config.json"),
      JSON.stringify({ hub: { path: hubDir } }, null, 2) + "\n"
    );

    // TMPDIR is redirected so the push's `mkdtemp` staging dirs are countable:
    // one per wedged process, and they are only removed by a `finally` the
    // process has to survive to run.
    childEnv = { ...homeEnv(home), ...tmpEnv(tmpRoot), CLAUDE_CONFIG_DIR: configDir };
    lockFile = join(home, ".sesh-mover", "locks", `${encodeProjectPath(project)}.lock`);
    fifo = join(hubDir, "hub.json");
  });

  function linkProject(projectId = "11111111-1111-4111-8111-111111111111"): void {
    writeFileSync(
      join(project, ".sesh-mover-project.json"),
      JSON.stringify({ projectId, name: "proj", createdAt: "2026-07-21T00:00:00Z", createdByMachine: MACHINE_ID }) + "\n"
    );
  }

  /** `hub.json` as a FIFO: the hub directory is there, the read never returns. */
  function wedgeHub(): void {
    execFileSync("mkfifo", [fifo]);
  }

  function readLock(): { pid?: number; acquiredAt?: string; token?: string } {
    return JSON.parse(readFileSync(lockFile, "utf-8"));
  }

  /**
   * Same read, but tolerant — for POLLING predicates only.
   *
   * `acquireProjectLock`'s exclusive create and its JSON write are two
   * syscalls, so a reader can legitimately catch a live holder at zero bytes
   * (`lock.ts`'s release() documents the same window). A predicate that parses
   * strictly turns that into a flaky test; every ASSERTION below still uses the
   * strict read, which by then is guaranteed to have a parseable record because
   * the predicate only returned once it saw one.
   */
  function peekLock(): { pid?: number } {
    try {
      return readLock();
    } catch {
      return {};
    }
  }

  /** Age the CURRENT lock past LOCK_STALE_MS without disturbing its owner. */
  function backdateLock(): void {
    const record = readLock();
    writeFileSync(
      lockFile,
      JSON.stringify({ ...record, acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 1_000).toISOString() })
    );
  }

  const payload = (): string => JSON.stringify({ cwd: project, session_id: sessionId });

  it("steals the project lock from a holder it can see is alive", async () => {
    // FACT 3 of the issue, measured. The steal decision is `ageMs >
    // LOCK_STALE_MS` and nothing else: the record's `pid` is read, but only to
    // decorate `LockBusyError`. Nothing consults it before the `rmSync`.
    linkProject();
    wedgeHub();

    const child = spawnHook(childEnv, payload());
    await waitFor(
      "the wedged push to take the project lock",
      () => existsSync(lockFile) && peekLock().pid === child.pid,
      child
    );

    // It is really the child's lock, and the child is really alive...
    const held = readLock();
    expect(held.pid).toBe(child.pid);
    expect(isAlive(child.pid)).toBe(true);
    expect(child.exited).toBe(false);
    // ...and really stuck INSIDE the critical section, before the first hub
    // write (`registerMachine` writes `machines/<id>.json` after the
    // preflight). The only thing on the hub is the FIFO it is blocked on.
    expect(readdirSync(hubDir)).toEqual(["hub.json"]);

    // On Linux this is directly observable rather than inferred: the child's
    // `/proc/<pid>/wchan` reads `wait_for_partner` (blocked in the FIFO open),
    // it has one `sesh-hub-push-*` staging dir under its TMPDIR, and it holds
    // no descriptor on the lock file — `acquireProjectLock` writes and closes.
    // Measured cost of one such orphan: ~67 MB RSS, 7 threads, 21 fds.
    if (existsSync(`/proc/${child.pid}/wchan`)) {
      expect(readFileSync(`/proc/${child.pid}/wchan`, "utf-8")).toContain("wait_for_partner");
      // Polled, not read once: `mkdtemp` runs just AFTER the lock is written,
      // so the lock file appearing does not yet imply the staging dir exists.
      await waitFor(
        "the wedged push to create its staging dir",
        () => readdirSync(tmpRoot).filter((n) => n.startsWith("sesh-hub-push-")).length === 1,
        child
      );
    }

    // Ten minutes pass (compressed by rewriting the timestamp — no source seam
    // needed, and the holder is untouched).
    backdateLock();

    const restore = overrideHome(home);
    let thief;
    try {
      const { acquireProjectLock } = await import("../src/hub/lock.js");
      thief = acquireProjectLock(project);
      // THE FINDING: stolen, from a holder whose pid is recorded in the file
      // being deleted and is trivially checkable.
      expect(thief.stoleStale).toBe(true);
      expect(isAlive(held.pid as number), "the pid the steal ignored").toBe(true);
      // The victim is neither signalled nor told: it still exists, still runs,
      // and the lock file now names the thief.
      expect(child.exited).toBe(false);
      expect(readLock().pid).toBe(process.pid);
    } finally {
      // Reap gracefully: releasing every blocked reader with a zero-byte read
      // makes `hub.json` unparseable, so the push refuses with `not-a-hub` and
      // exits 0 through its normal path. No assertions in here — a failing
      // expectation in a `finally` would replace the real failure above it.
      unblockFifo(fifo);
      thief?.release();
      restore.restore();
    }
    expect(await child.exit).toBe(0);
    expect(child.stdout).toBe(""); // the hook contract holds even here
    expect(isAlive(child.pid)).toBe(false);
  }, 30_000);

  it("lets the stolen-from push write hub state while another party holds the lock", async () => {
    // Stealing is only harmful if the victim keeps going. It does: the lock is
    // taken ONCE, at the top of hubPush, and never re-checked — so after the
    // steal the victim runs the entire push (bundle upload, the machine's own
    // index file, sync-state) with no mutual exclusion at all. Here the thief
    // is the test process holding the lock for the whole of that; in the field
    // it is the next session's auto-push doing its own writes.
    const restore0 = overrideHome(home);
    let projectId: string;
    try {
      const { hubInit } = await import("../src/hub/init.js");
      expect((await hubInit({ hubPath: hubDir, configScope: "user", cwd: home })).success).toBe(true);
      const { createFsBackend } = await import("../src/hub/backend.js");
      const { createHubProject } = await import("../src/hub/identity.js");
      // Links the project locally too, which is what arms the auto-push.
      projectId = (await createHubProject(createFsBackend(hubDir), project, MACHINE_ID)).projectId;
    } finally {
      restore0.restore();
    }
    // hubInit rewrote the user config; put the hub path back under our own key
    // set (it also writes `hub.path`, so re-assert rather than assume).
    writeFileSync(
      join(home, ".sesh-mover", "config.json"),
      JSON.stringify({ hub: { path: hubDir } }, null, 2) + "\n"
    );

    // Swap the real hub.json for a FIFO. Keep the bytes: this is a share that
    // HANGS, not one that lost its contents, so the push must complete normally
    // once it unblocks.
    const realHubJson = readFileSync(fifo, "utf-8");
    const parked = join(tempDir, "hub.json.parked");
    rmSync(fifo);
    execFileSync("mkfifo", [fifo]);

    const child = spawnHook(childEnv, payload());
    await waitFor(
      "the wedged push to take the project lock",
      () => existsSync(lockFile) && peekLock().pid === child.pid,
      child
    );
    expect(readLock().pid).toBe(child.pid);
    const bundles = join(hubDir, "projects", projectId, "bundles", MACHINE_ID);
    expect(existsSync(bundles)).toBe(false); // nothing uploaded yet

    backdateLock();
    const restore = overrideHome(home);
    let thief;
    try {
      const { acquireProjectLock } = await import("../src/hub/lock.js");
      thief = acquireProjectLock(project);
      expect(thief.stoleStale).toBe(true);
      const thiefRecord = readFileSync(lockFile, "utf-8");

      // The share comes back WHILE the thief holds the lock. Renaming the FIFO
      // aside first is not cosmetic: the victim is blocked on the inode, so the
      // path is free for the real file and every later read gets it.
      renameSync(fifo, parked);
      writeFileSync(fifo, realHubJson);
      expect(unblockFifo(parked, realHubJson)).toBe(true);

      expect(await child.exit).toBe(0);
      expect(child.stdout).toBe("");
      expect(child.stderr).toBe(""); // it SUCCEEDED — no diagnostic

      // THE BLAST RADIUS: every one of these writes happened after the victim's
      // lock was taken away, while a different process held it.
      const uploaded = readdirSync(bundles);
      expect(uploaded.length, "the victim uploaded a bundle with no lock").toBe(1);
      expect(
        existsSync(join(hubDir, "projects", projectId, "index", `${MACHINE_ID}.json`)),
        "the victim rewrote this machine's own index file with no lock"
      ).toBe(true);
      // Per-machine ownership is what makes concurrent hub access safe WITHOUT
      // a distributed lock, and the same-machine lock is its only enforcement:
      // two processes on one machine writing `index/<machineId>.json` is
      // precisely what it exists to prevent.

      // And the victim never noticed. Its own release() is a no-op (token
      // mismatch), so the thief's lock is intact — the victim simply had no
      // lock for the whole second half of its push.
      expect(readFileSync(lockFile, "utf-8")).toBe(thiefRecord);

      // The one trace it could have left is dropped PRECISELY here.
      // `recordAutoPushOutcome` (cli.ts) re-takes the same project lock after
      // the push returns and "gives up silently on a busy lock" — which, after
      // a steal, it always is. So the `hub status` breadcrumb is missing in the
      // single case where a user most needs it. (That a successful auto-push
      // normally DOES record one is pinned by tests/hub-hooks.test.ts, so this
      // is an absence caused by the steal, not by pushes never recording.)
      const { peekSyncState } = await import("../src/sync-state.js");
      expect(peekSyncState(project).hub).toBeDefined();
      expect(peekSyncState(project).hub?.lastAutoPush).toBeUndefined();
    } finally {
      thief?.release();
      restore.restore();
    }
  }, 30_000);

  it("accrues one more live, lock-holding push per staleness window, unbounded", async () => {
    // The accrual claim itself. Each round is one LOCK_STALE_MS window: the
    // sitting holder is aged, the next session's auto-push steals from it, and
    // the previous one keeps running. Nothing anywhere reduces the count.
    linkProject();
    wedgeHub();

    const rounds = 3;
    const children: Spawned[] = [];
    for (let i = 0; i < rounds; i++) {
      if (i > 0) {
        // CONTROL, once: inside the window the lock does its job. A session
        // ending while the wedged push is still "fresh" declines with
        // `lock-busy` and exits — so the accrual is not "one orphan per session
        // end", it is one per staleness window, and the steal is what produces
        // it. Without this the loop below could pass for the wrong reason.
        if (i === 1) {
          const declined = spawnHook(childEnv, payload());
          expect(await declined.exit).toBe(0);
          expect(declined.stdout).toBe("");
          expect(declined.stderr).toBe("");
          expect(readLock().pid).toBe(children[0]!.pid); // untouched
          expect(children[0]!.exited).toBe(false);
        }
        backdateLock(); // ...ten minutes later
      }
      const child = spawnHook(childEnv, payload());
      children.push(child);
      await waitFor(
        `push #${i + 1} to take the lock`,
        () => existsSync(lockFile) && peekLock().pid === child.pid,
        child
      );
      // Every earlier push is still alive, still inside the critical section.
      for (const earlier of children) expect(earlier.exited).toBe(false);
    }

    // MEASURED: 3 windows -> 3 live processes, all of which acquired the
    // project lock for the same project and none of which released it.
    expect(children.filter((c) => isAlive(c.pid)).length).toBe(rounds);
    expect(children.filter((c) => c.exited).length).toBe(0);
    // Each also holds an un-reaped push staging directory. On the graceful path
    // below a `finally` removes it; a SIGKILL (the only way to end a wedged
    // process) does not run that `finally`, so each orphan also leaks a temp
    // tree — which for a wedge later in the push holds a full bundle copy.
    const staging = (): string[] =>
      readdirSync(tmpRoot).filter((n) => n.startsWith("sesh-hub-push-"));
    // Polled: `mkdtemp` runs just after the lock write, so the newest push may
    // not have created its staging dir at the instant it took the lock.
    await waitFor(`${rounds} staging dirs`, () => staging().length === rounds);

    // Nothing in the product ends any of them: no timeout on the hook (by
    // design — a `timeout` here raises Claude Code's SHARED SessionEnd budget),
    // no deadline in the push, no reaper on the lock. The share coming back is
    // the only thing that does.
    expect(unblockFifo(fifo)).toBe(true);
    for (const c of children) expect(await c.exit).toBe(0);
    expect(children.every((c) => !isAlive(c.pid))).toBe(true);
    expect(staging(), "the graceful exit cleans up its staging dir").toEqual([]);
  }, 45_000);

  it("cannot be bounded from inside: no timer fires while the hub read is blocked", async () => {
    // Feasibility evidence for the issue's second remedy ("a self-imposed
    // deadline in `hub hook-session-end`"). It cannot be a timer: `HubBackend`'s
    // fs implementation is `readFileSync`, so a blocked hub read blocks the
    // whole event loop, not just a threadpool thread. A `setTimeout` watchdog
    // armed before the read does not fire until the read returns — i.e. exactly
    // when it is no longer needed. A working deadline needs either an async fs
    // path or an out-of-process watchdog.
    wedgeHub();
    // Written against the BUILT backend, so this measures our own read path
    // rather than a synthetic `readFileSync`.
    const script = join(tempDir, "watchdog.mjs");
    const backendUrl = pathToFileURL(join(cliPath(), "..", "hub", "backend.js")).href;
    writeFileSync(
      script,
      `import { createFsBackend } from ${JSON.stringify(backendUrl)};\n` +
        `const t0 = Date.now();\n` +
        `setTimeout(() => console.log("DEADLINE " + (Date.now() - t0)), 200);\n` +
        `console.log("ARMED");\n` +
        `await createFsBackend(${JSON.stringify(hubDir)}).read("hub.json");\n` +
        `console.log("READ_RETURNED " + (Date.now() - t0));\n`
    );

    const proc = spawn("node", [script], { stdio: ["ignore", "pipe", "pipe"] });
    const rec: Spawned = {
      proc, pid: proc.pid as number, stdout: "", stderr: "", exited: false, code: null,
      exit: new Promise<number | null>((resolve) => {
        proc.on("close", (code) => { rec.exited = true; rec.code = code; resolve(code); });
      }),
    };
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (d: string) => { rec.stdout += d; });
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (d: string) => { rec.stderr += d; });
    spawned.push(rec);

    await waitFor("the watchdog to arm", () => rec.stdout.includes("ARMED"), rec);
    await sleep(1000); // five times the 200ms deadline
    expect(rec.exited, rec.stderr).toBe(false);
    expect(rec.stdout).not.toContain("DEADLINE");

    expect(unblockFifo(fifo, '{"hubId":"x"}')).toBe(true);
    expect(await rec.exit).toBe(0);
    // It fires only once the read returns — an order that makes it useless as a
    // bound on the read.
    const fired = Number(/DEADLINE (\d+)/.exec(rec.stdout)?.[1]);
    const returned = Number(/READ_RETURNED (\d+)/.exec(rec.stdout)?.[1]);
    expect(Number.isFinite(fired)).toBe(true);
    expect(fired).toBeGreaterThan(900);
    expect(fired).toBeGreaterThanOrEqual(returned);
  }, 30_000);
});
