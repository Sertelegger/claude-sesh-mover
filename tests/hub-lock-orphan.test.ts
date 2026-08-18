import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
  existsSync, readdirSync, realpathSync, openSync, writeSync, closeSync, constants, cpSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { overrideHome, homeEnv, tmpEnv } from "./helpers/env.js";
import { cliPath } from "./helpers/run-cli.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";
import { LOCK_STALE_MS } from "../src/hub/lock.js";

/**
 * ISSUE #71 — THE FIX, on the reproduction that used to pin the defect.
 *
 * ## What this file used to assert, and why every one of those assertions is inverted
 *
 * It was written as a reproduction. It pinned that a `hub push` reaching a hub
 * whose filesystem BLOCKS never returns: `createFsBackend().read()` was
 * `readFileSync`, so `preflightHub` — which `hubPush` runs INSIDE the project
 * lock — parked the process in the kernel forever. Its four tests measured, in
 * order: that the lock was then stolen from a live holder, that the stolen-from
 * push went on to write hub state with no lock at all, that one such live
 * lock-holding process accrued per `LOCK_STALE_MS` window without bound, and —
 * the feasibility question for the alternative remedy — that **no timer could
 * fire while the read was blocked**, because a sync read blocks the whole event
 * loop rather than one threadpool thread.
 *
 * The fix took the cause rather than the symptom: `hub/backend.ts` is now
 * `node:fs/promises` with a per-syscall bound (`hub/io-timeout.ts`), and
 * `preflight.ts`'s root `statSync` went the same way. So the wedge still
 * happens — a FIFO open still blocks a pool thread, and nothing in userspace can
 * cancel it (measured: an `AbortSignal` does not interrupt a blocked `open()`;
 * it rejects only when the filesystem finally answers) — but it no longer
 * reaches the event loop, the lock, or the next session.
 *
 * The reproduction machinery below is UNCHANGED, deliberately: same FIFO at
 * `hub.json`, same real SessionEnd hook endpoint, same reaping. Only the
 * expectations moved, and they moved to the opposite side:
 *
 *   | was pinned as the defect                    | is pinned now                          |
 *   | ------------------------------------------- | -------------------------------------- |
 *   | the push holds the lock forever             | it refuses and releases the lock       |
 *   | its staging dir is never reaped             | its `finally` runs and removes it      |
 *   | one live orphan per staleness window        | zero survivors after N session ends    |
 *   | no timer fires while the read is blocked    | the timer fires ON TIME, mid-read      |
 *
 * ## The one thing that did not invert here — and has since inverted too (#84)
 *
 * This file used to carry a fifth test asserting a RESIDUAL: that
 * `acquireProjectLock` still stole from a holder it could see was alive,
 * because the decision was `ageMs > LOCK_STALE_MS` and the recorded pid was
 * read only to decorate `LockBusyError`. #71 removed that mechanism's TRIGGER,
 * not the mechanism, and the residual was kept under test so the issue would
 * not be read as fully closed.
 *
 * #84 closed it, so that test is now the opposite of what it was — a second
 * round of reversals in a file already built out of them, and documented as
 * one rather than deleted:
 *
 *   | was pinned as the residual                  | is pinned now                          |
 *   | ------------------------------------------- | -------------------------------------- |
 *   | a live holder's lock is taken at 10 minutes | it is refused, and the refusal says so |
 *   | the recorded pid is never consulted         | a provably gone holder loses it at once |
 *   | the steal is silent on both sides           | thief and victim both leave a record    |
 *
 * The trade #84 had to make is why the last test asserts BOTH directions: a
 * liveness probe alone would turn one stuck holder into a silent permanent
 * outage for the project, so a live holder is protected only up to
 * `LOCK_LIVE_HOLDER_CEILING_MS` and is then stolen from deliberately.
 *
 * ## Two properties of the wedge that shape every test below
 *
 * **The bound is a race, not a cancellation.** After the timeout the FIFO open
 * is still outstanding on a libuv threadpool thread. That request keeps the loop
 * ref'd, and — measured, 3/3 runs, and identically for the callback API — the
 * process then cannot exit: not naturally, not via `process.exit(0)`, not via
 * `process.reallyExit(0)`. Only a signal ends it. `cli.ts`'s
 * `leaveEvenIfHubIoWedged` is that signal, which is why the children here exit
 * on SIGKILL rather than with code 0, and why `expectGone` asserts on liveness
 * rather than on an exit code.
 *
 * **`SESH_MOVER_HUB_IO_TIMEOUT_MS` is what makes this file fast.** The shipped
 * bound is 30s; these tests set it to a second or so. That env var is the
 * product's own documented override, not a test seam — a hub read is bounded
 * here by the same code path a user gets.
 *
 * ## Reaping
 *
 * Every child spawned here is registered in `spawned` and killed in an
 * `afterEach` that runs even when a test times out or throws mid-way. A test in
 * this file that leaves a stuck `node` behind fails the suite loudly rather than
 * quietly polluting the runner — and since the whole claim of this file is now
 * "these processes stop existing", that backstop is also the assertion.
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

/**
 * The hub-read bound the spawned CLI runs under.
 *
 * Comfortably longer than the fixture's local work (so nothing here fails for
 * being slow) and far shorter than the 15s `waitFor` budget, so a test that
 * waits for the refusal is waiting on the product, not on the clock.
 */
const IO_TIMEOUT_MS = 1_000;

interface Spawned {
  proc: ChildProcess;
  pid: number;
  stdout: string;
  stderr: string;
  exit: Promise<number | null>;
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
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

/**
 * Run `fn` with this process's stderr captured.
 *
 * A steal writes a disclosure line there (#84) — half of what the last test in
 * this file asserts — and without this it would also scribble across the
 * runner's own output.
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
    signal: null,
    exit: new Promise<number | null>((resolve) => {
      proc.on("close", (code, signal) => {
        rec.exited = true;
        rec.code = code;
        rec.signal = signal;
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
 * The whole point of the fix, as one assertion: this process ENDED on its own.
 *
 * Not `code === 0`. The process is holding an abandoned FIFO open on a pool
 * thread, and in that state the runtime will not let it return an exit code at
 * all — `process.exit(0)` blocks (measured). `cli.ts` escalates to a self-signal
 * precisely so that something happens instead of nothing, so SIGKILL here is the
 * SUCCESS path and is asserted as such rather than tolerated.
 */
async function expectGone(child: Spawned, label: string): Promise<void> {
  await Promise.race([child.exit, sleep(15_000)]);
  expect(child.exited, `${label}: still running — stderr=${JSON.stringify(child.stderr)}`).toBe(true);
  expect(isAlive(child.pid), `${label}: pid survived`).toBe(false);
  // Either the ordinary exit or the wedged-process escalation; never neither.
  expect(
    child.code === 0 || child.signal === "SIGKILL",
    `${label}: unexpected exit (code=${child.code} signal=${child.signal}) stderr=${JSON.stringify(child.stderr)}`
  ).toBe(true);
}

/**
 * Release every reader blocked on `fifo`, handing them `contents` (empty =>
 * they read zero bytes).
 *
 * O_NONBLOCK matters: a plain `open(…, "w")` on a FIFO blocks until a READER
 * arrives, so if the wedged child had already died this helper would hang the
 * test runner instead of the child. Non-blocking, it fails with ENXIO instead —
 * which after the fix is the ORDINARY outcome, since the children no longer
 * survive long enough to be waiting.
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

describe.skipIf(!canMkfifo)("issue #71: a hub that blocks no longer wedges the auto-push", () => {
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
    writeFileSync(
      join(home, ".sesh-mover", "config.json"),
      JSON.stringify({ hub: { path: hubDir } }, null, 2) + "\n"
    );

    // TMPDIR is redirected so the push's `mkdtemp` staging dirs are countable:
    // one per push, and they are only removed by a `finally` the process has to
    // survive to run — which, after the fix, it does.
    childEnv = {
      ...homeEnv(home),
      ...tmpEnv(tmpRoot),
      CLAUDE_CONFIG_DIR: configDir,
      SESH_MOVER_HUB_IO_TIMEOUT_MS: String(IO_TIMEOUT_MS),
    };
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

  const staging = (): string[] =>
    readdirSync(tmpRoot).filter((n) => n.startsWith("sesh-hub-push-"));

  const payload = (): string => JSON.stringify({ cwd: project, session_id: sessionId });

  it("refuses a blocking hub read, releases the project lock, and the process ends", async () => {
    // THE INVERSION of the first two tests this file used to carry. The wedge
    // still happens in the kernel — `hub.json` is a FIFO and its `open` blocks
    // in `wait_for_partner` exactly as before — but it is now reached by an
    // ASYNC read under `withHubIoTimeout`, so the push declines instead of
    // parking inside its own critical section.
    linkProject();
    wedgeHub();

    const child = spawnHook(childEnv, payload());

    // It really did block on the FIFO, on a threadpool thread, while its main
    // thread stayed in the event loop. Without this the test could pass against
    // a hub that was simply never read.
    if (existsSync("/proc")) {
      await waitFor(
        "the push to block on the FIFO open",
        () => {
          try {
            return readdirSync(`/proc/${child.pid}/task`).some((t) =>
              readFileSync(`/proc/${child.pid}/task/${t}/wchan`, "utf-8").includes("wait_for_partner")
            );
          } catch {
            return false; // raced with exit, or /proc unreadable
          }
        },
        child
      );
    }

    await expectGone(child, "the wedged push");

    // THE FINDING, inverted. Every one of these was false before the fix.
    //
    // 1. No lock is left behind. The push took it, hit the bound, and released
    //    it in `hubPush`'s outer `finally` — so the next session's push has
    //    nothing to steal, which is what ends the accrual at its source.
    expect(existsSync(lockFile), "a lock file survived the refused push").toBe(false);
    // 2. The staging directory is reaped. It is removed only by that same
    //    `finally`, so this is independent evidence that the push RETURNED
    //    rather than being killed somewhere in the middle of its body.
    expect(staging(), "the refused push left a staging directory").toEqual([]);
    // 3. Nothing was written to the hub. `registerMachine` writes
    //    `machines/<id>.json` after the preflight, and the preflight is what
    //    declined — so the FIFO is still the only thing here.
    expect(readdirSync(hubDir)).toEqual(["hub.json"]);
    // 4. The hook contract survives the new exit path: stdout stays empty even
    //    though the process is now torn down by a signal.
    expect(child.stdout).toBe("");
    // 5. And it said why, on its one available channel. This is the typed
    //    refusal, with the THIRD reachability state — not `no-directory` (the
    //    directory is plainly there) and not `not-a-hub` (nothing was read, so
    //    nothing is known about its contents).
    expect(child.stderr).toContain("hub-unreachable");
    expect(child.stderr).toContain("unresponsive");
  }, 40_000);

  it("an interactive push emits the typed refusal on stdout and still ends", async () => {
    // The hook endpoint and the ordinary CLI leave through DIFFERENT code:
    // `hub hook-session-end` escalates from its `finally` and writes nothing to
    // stdout, while `push` goes through `output()`, which writes the whole
    // result first. Both are wedged; only one of them was covered above, and a
    // user watching a hung terminal is the case the other one is about.
    linkProject();
    wedgeHub();

    const proc = spawn("node", [cliPath(), "push", "--project-path", project], {
      env: { ...process.env, ...childEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rec: Spawned = {
      proc, pid: proc.pid as number, stdout: "", stderr: "", exited: false, code: null, signal: null,
      exit: new Promise<number | null>((resolve) => {
        proc.on("close", (code, signal) => { rec.exited = true; rec.code = code; rec.signal = signal; resolve(code); });
      }),
    };
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (d: string) => { rec.stdout += d; });
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (d: string) => { rec.stderr += d; });
    spawned.push(rec);

    await expectGone(rec, "the interactive push");

    // The ENTIRE result survived the signal, asserted by parsing so that a
    // truncation fails here rather than passing a substring check.
    //
    // CHARACTERIZATION, NOT A GUARD, for the flush barrier specifically: this
    // still passes with `leaveEvenIfHubIoWedged`'s barrier removed (mutation
    // tested). A `hub-unreachable` refusal is a few hundred bytes and fits in
    // the pipe buffer, so it survives an immediate SIGKILL anyway; the barrier
    // only bites above ~64 KB (measured — see the doc on that function). What
    // this test DOES pin is that the process ends at all, which the same
    // mutation exercise shows it does not without the escalation.
    const result = JSON.parse(rec.stdout) as {
      success: boolean; command: string; reason: string; hubState: string; suggestion: string;
    };
    expect(result.success).toBe(false);
    expect(result.command).toBe("push");
    expect(result.reason).toBe("hub-unreachable");
    expect(result.hubState).toBe("unresponsive");
    // The refusal withholds the hub's absolute path, the same as its two
    // siblings (#75) — a new arm must not be the one that leaks it.
    expect(result.suggestion).not.toContain(hubDir);
    expect(existsSync(lockFile)).toBe(false);
    expect(staging()).toEqual([]);
  }, 40_000);

  it("does not accrue: N session ends against a blocking hub leave zero survivors", async () => {
    // THE INVERSION of "accrues one more live, lock-holding push per staleness
    // window, unbounded". Same shape as that loop — one hook per session end —
    // but with no `backdateLock` step, because there is no longer a sitting
    // holder for the next push to have to wait out or steal from.
    linkProject();
    wedgeHub();

    const rounds = 3;
    const children: Spawned[] = [];
    for (let i = 0; i < rounds; i++) {
      const child = spawnHook(childEnv, payload());
      children.push(child);
      await expectGone(child, `push #${i + 1}`);
      // Checked every round rather than once at the end: an accrual that
      // started and then self-corrected would still be an accrual.
      expect(children.filter((c) => isAlive(c.pid)).length, `after round ${i + 1}`).toBe(0);
      expect(existsSync(lockFile), `a lock survived round ${i + 1}`).toBe(false);
      expect(staging(), `a staging dir survived round ${i + 1}`).toEqual([]);
    }

    // MEASURED: 3 session ends -> 0 live processes, 0 held locks, 0 leaked temp
    // trees. Before the fix the same loop produced 3 of each, none of which
    // anything in the product ever reduced.
    expect(children.filter((c) => c.exited).length).toBe(rounds);
    // None of them ever reached the point of stealing: `stoleStale` is reported
    // as a push warning, and no push here had a predecessor to steal from.
    for (const c of children) expect(c.stderr).not.toContain("Stole a stale project lock");

    // Nobody is left waiting on the FIFO. Before the fix this returned true —
    // the share coming back was the only thing that could end those processes.
    expect(unblockFifo(fifo), "a reader was still blocked on the hub FIFO").toBe(false);
  }, 60_000);

  it("CAN now be bounded from inside: a timer fires on time while the hub read is blocked", async () => {
    // THE INVERSION of "cannot be bounded from inside: no timer fires while the
    // hub read is blocked", and the measurement the whole fix rests on.
    //
    // Before: `HubBackend`'s fs implementation was `readFileSync`, so a blocked
    // hub read blocked the whole event loop and a `setTimeout` armed before it
    // fired only AFTER the read returned — measured at 1053ms for a 200ms
    // deadline, i.e. exactly when it was no longer needed. That is why a
    // self-imposed deadline was impossible and why the remedy had to be the
    // backend rather than a watchdog.
    //
    // After: libuv runs the open on a threadpool thread, the loop stays free,
    // and the timer fires on schedule with the read still outstanding.
    //
    // Written against the BUILT backend, so this measures our own read path
    // rather than a synthetic `fs.promises.readFile`.
    wedgeHub();
    const script = join(tempDir, "watchdog.mjs");
    const backendUrl = pathToFileURL(join(cliPath(), "..", "hub", "backend.js")).href;
    writeFileSync(
      script,
      `import { createFsBackend } from ${JSON.stringify(backendUrl)};\n` +
        `const t0 = Date.now();\n` +
        `setTimeout(() => console.log("DEADLINE " + (Date.now() - t0)), 200);\n` +
        `console.log("ARMED");\n` +
        `try {\n` +
        `  await createFsBackend(${JSON.stringify(hubDir)}).read("hub.json");\n` +
        `  console.log("READ_RETURNED " + (Date.now() - t0));\n` +
        `} catch (e) {\n` +
        `  console.log("READ_REJECTED " + (Date.now() - t0) + " " + e.name);\n` +
        `}\n`
    );

    const proc = spawn("node", [script], {
      stdio: ["ignore", "pipe", "pipe"],
      // The bound applies to this script too — it is reading through the same
      // backend — so give it one long enough that the 200ms deadline below is
      // unambiguously measuring the event loop and not the timeout.
      env: { ...process.env, SESH_MOVER_HUB_IO_TIMEOUT_MS: "5000" },
    });
    const rec: Spawned = {
      proc, pid: proc.pid as number, stdout: "", stderr: "", exited: false, code: null, signal: null,
      exit: new Promise<number | null>((resolve) => {
        proc.on("close", (code, signal) => { rec.exited = true; rec.code = code; rec.signal = signal; resolve(code); });
      }),
    };
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (d: string) => { rec.stdout += d; });
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (d: string) => { rec.stderr += d; });
    spawned.push(rec);

    await waitFor("the watchdog to arm", () => rec.stdout.includes("ARMED"), rec);
    // The deadline fires WHILE the read is still outstanding — the assertion
    // that used to be its exact opposite.
    await waitFor("the 200ms deadline to fire mid-read", () => rec.stdout.includes("DEADLINE"), rec);
    expect(rec.stdout).not.toContain("READ_RETURNED");
    expect(rec.stdout).not.toContain("READ_REJECTED");
    expect(rec.exited).toBe(false);

    const fired = Number(/DEADLINE (\d+)/.exec(rec.stdout)?.[1]);
    expect(Number.isFinite(fired)).toBe(true);
    // Generous upper bound — this is a loaded CI box, not a latency benchmark.
    // The claim is "on schedule, not blocked behind a 5s syscall", and the old
    // behaviour would land at 5000+ here rather than anywhere near 200.
    expect(fired).toBeGreaterThanOrEqual(190);
    expect(fired).toBeLessThan(3_000);

    // Reap gracefully: releasing the reader lets the read complete and the
    // script exit on its own, which also demonstrates the non-abandoned path.
    expect(unblockFifo(fifo, '{"hubId":"x"}')).toBe(true);
    expect(await rec.exit).toBe(0);
    expect(rec.stdout).toContain("READ_RETURNED");
  }, 30_000);

  it("consults liveness before stealing the project lock, and discloses the steal (#84)", async () => {
    // THE THIRD INVERSION. This test used to assert the residual verbatim:
    // that a lock was taken at `LOCK_STALE_MS` from a holder whose pid sat in
    // the file being deleted and was trivially checkable. #84 made the steal
    // consult that pid, so every assertion below is the reverse of the one it
    // replaces — with the ceiling as the deliberate exception, because a probe
    // with no ceiling converts a stuck holder into a project that can never
    // push again.
    //
    // No FIFO needed. Two of the three holders here are this very process,
    // whose liveness is not in question, and the third is a real child this
    // test kills — which is the actual shape of the case the steal path exists
    // for (a crashed or SIGKILLed process never runs its release()).
    const restore = overrideHome(home);
    try {
      const { acquireProjectLock, LOCK_LIVE_HOLDER_CEILING_MS, readLockStealRecord } =
        await import("../src/hub/lock.js");
      const holder = acquireProjectLock(project);
      expect(holder.stoleStale).toBe(false);
      const held = JSON.parse(readFileSync(lockFile, "utf-8")) as { pid?: number; token?: string };
      expect(held.pid).toBe(process.pid);
      expect(isAlive(held.pid as number)).toBe(true);

      const backdate = (ageMs: number): void => {
        writeFileSync(
          lockFile,
          JSON.stringify({ ...held, acquiredAt: new Date(Date.now() - ageMs).toISOString() })
        );
      };

      // 1. Ten minutes pass (compressed by rewriting the timestamp — no source
      //    seam needed, and the holder is untouched). WAS: stolen. IS: refused,
      //    and the refusal names the reason, which is what `hub unlink` / `hub
      //    reindex` / `hub retire` copy into their lock-busy `error`.
      backdate(LOCK_STALE_MS + 1_000);
      let busy: Error | null = null;
      try {
        acquireProjectLock(project);
      } catch (e) {
        busy = e as Error;
      }
      expect(busy, "a live holder was stolen from at LOCK_STALE_MS").toBeInstanceOf(Error);
      expect(busy?.message).toContain(`pid ${process.pid}`);
      expect(busy?.message).toContain("still running");
      expect(existsSync(lockFile), "the refused acquire removed the holder's lock").toBe(true);

      // 2. An hour passes. The ceiling fires and the live holder loses the lock
      //    anyway — the availability half of the trade, asserted so a future
      //    "never steal from a live holder" cannot land unnoticed.
      backdate(LOCK_LIVE_HOLDER_CEILING_MS + 1_000);
      const thief = captureStderr(() => acquireProjectLock(project));
      try {
        expect(thief.value.stoleStale).toBe(true);
        expect(thief.value.steal?.kind).toBe("live-holder-past-ceiling");
        expect(thief.value.steal?.holderPid).toBe(process.pid);
        expect(isAlive(held.pid as number), "the pid the steal now consults").toBe(true);
        // THE DISCLOSURE, thief side: durable, beside the lock, and written
        // without needing the lock — the one channel a victim can also use.
        const record = readLockStealRecord(project);
        expect(record?.holderToken).toBe(held.token);
        expect(record?.noticedByHolderAt).toBeUndefined();

        // WAS: "the victim is not told — its own release() is a no-op, so it
        // cannot even discover the loss by releasing." IS: the release is
        // still a no-op on the thief's lock (that part must never change), but
        // it now stamps the record and says so.
        const victim = captureStderr(() => holder.release());
        expect(existsSync(lockFile), "the victim's release freed the thief's lock").toBe(true);
        expect(victim.err).toContain("lost the project lock");
        expect(readLockStealRecord(project)?.noticedByHolderAt).toBeTruthy();
      } finally {
        thief.value.release();
      }

      // 3. A holder that is genuinely gone still loses its lock at
      //    LOCK_STALE_MS, immediately — the property the ceiling must not cost.
      //    A real child, killed, rather than a pid literal: pid_max is in the
      //    millions, so a made-up number is not reliably absent.
      const doomed = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      const doomedRec: Spawned = {
        proc: doomed, pid: doomed.pid as number, stdout: "", stderr: "",
        exited: false, code: null, signal: null,
        exit: new Promise<number | null>((resolve) => {
          doomed.on("close", (code, signal) => {
            doomedRec.exited = true; doomedRec.code = code; doomedRec.signal = signal; resolve(code);
          });
        }),
      };
      spawned.push(doomedRec);
      doomed.kill("SIGKILL");
      await doomedRec.exit;
      expect(isAlive(doomedRec.pid)).toBe(false);

      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: doomedRec.pid,
          host: hostname(),
          token: "crashed",
          acquiredAt: new Date(Date.now() - LOCK_STALE_MS - 1_000).toISOString(),
        })
      );
      const reaper = captureStderr(() => acquireProjectLock(project));
      expect(reaper.value.stoleStale).toBe(true);
      expect(reaper.value.steal?.kind).toBe("dead-holder");
      reaper.value.release();
    } finally {
      restore.restore();
    }
  }, 30_000);
});
