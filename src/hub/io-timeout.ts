/**
 * A bound on every INDIVIDUAL filesystem syscall this plugin makes against the
 * hub, and the reason the hub backend is written against `node:fs/promises`
 * rather than the sync API (#71).
 *
 * ## What was actually wrong
 *
 * `createFsBackend` used `readFileSync`/`existsSync`/`readdirSync`. On a hub
 * that BLOCKS rather than fails — a hard-mounted NFS/CIFS share whose server is
 * gone, a FUSE mount whose daemon died — those never return, and because they
 * are synchronous they block the whole event loop. `hubPush` reaches the first
 * of them (`preflightHub`) INSIDE the project lock, so the wedged process held
 * that lock forever; ten minutes later `acquireProjectLock` stole it as stale
 * and the next SessionEnd auto-push wedged the same way. One live ~50 MB
 * process per staleness window, each holding an un-reaped staging directory,
 * and — once the share came back — several of them writing this machine's own
 * hub index concurrently, which is precisely what the per-machine-ownership
 * invariant relies on the lock to prevent.
 *
 * ## The three facts this module is built on, each MEASURED (Linux, Node 22.23.1)
 *
 * The reproduction is a FIFO at `hub.json`: `open(…, O_RDONLY)` on one blocks
 * in the kernel (`/proc/<pid>/wchan` = `wait_for_partner`) exactly like a dead
 * hard mount, and unlike a `sleep` it cannot be interrupted by anything the
 * event loop can service.
 *
 * 1. **An async fs call does NOT block the event loop.** libuv runs it on a
 *    threadpool thread, so only that thread is stuck. Measured: a `setTimeout`
 *    armed for 200 ms before a `fs.promises.readFile` of a never-opened FIFO
 *    fires at 201 ms while the read returns at 1184 ms. Against the OLD
 *    `readFileSync` backend the same timer fired only at 1053 ms — *after* the
 *    read — which is why a self-imposed deadline was impossible before this
 *    change and why the fix had to be the backend, not a watchdog.
 *
 * 2. **`AbortSignal` does NOT abort a blocked `open()`.** `fs.promises.readFile`
 *    documents signal support, but the signal is only checked between chunks
 *    and the call is stuck before the first one. Measured: abort fired at
 *    302 ms; the promise rejected with `ABORT_ERR` at 2487 ms — the instant the
 *    FIFO was released, i.e. exactly when it no longer mattered. **So the bound
 *    below is a RACE, not a cancellation.** `withHubIoTimeout` rejects on time;
 *    the syscall underneath is still running on its pool thread, and the only
 *    thing that ever ends it is the filesystem answering.
 *
 * 3. **A process holding an abandoned fs request cannot exit — not even with
 *    `process.exit()`.** The outstanding libuv request keeps the loop ref'd, and
 *    the exit path itself then blocks (main thread parked in `futex_wait_queue`,
 *    inferred to be libuv's threadpool join; no native stack tool was available
 *    to confirm the frame). Measured, 3/3 runs each and identical for the
 *    callback API, so it is the libuv request and not a pending JS promise:
 *
 *      | how we ask it to leave        | result                                |
 *      | ----------------------------- | ------------------------------------- |
 *      | let the script end naturally  | HANGS until the syscall returns       |
 *      | `process.exit(0)`             | HANGS ('exit' event fires, then stuck)|
 *      | `process.reallyExit(0)`       | HANGS                                 |
 *      | `process.kill(pid, SIGTERM)`  | exits immediately (status 143)        |
 *      | `process.kill(pid, SIGKILL)`  | exits immediately (status 137)        |
 *
 *    That is why `noteAbandonedHubIo` exists and why `cli.ts` escalates to a
 *    signal: without it this change would have removed the lock-holding and the
 *    staging leak but left the process itself accruing — renaming the orphan
 *    rather than stopping it.
 *
 * ## Why a fixed constant, and why it will not fail a slow-but-working share
 *
 * The bound applies to ONE syscall, never to an aggregate and never to a byte
 * transfer. `list()` bounds each `readdir` rather than the whole recursive walk;
 * `readStream`/`writeStreamAtomic` bound the `open` (and the `rename` at commit)
 * and leave the pipeline itself completely unbounded, so a multi-hundred-megabyte
 * bundle crossing a congested link is never failed for taking a long time — only
 * for a mount that has stopped answering at all. A single metadata syscall on a
 * healthy share is sub-millisecond locally and single-digit milliseconds over a
 * WAN; {@link HUB_IO_TIMEOUT_MS} is three to four orders of magnitude above that.
 *
 * It is also deliberately far below `LOCK_STALE_MS` (10 minutes), so a push that
 * times out can never itself become the stale holder another push steals from —
 * the failure mode this whole issue is about.
 *
 * Not a `config.json` setting, for two reasons rather than by omission. The
 * backend is constructed at eight call sites that are handed a hub path and no
 * config (`init`/`push`/`pull`/`reindex`/`status`/`whereis`), so threading one
 * through would be call-site churn for a knob whose right value is a property of
 * the MACHINE's mount, not of a project — and `config.json` is per-project as
 * well as per-user. The env override below covers the machine-wide case, which
 * is the one that exists.
 */

/**
 * The per-syscall bound. See the module doc for why this number is safe.
 *
 * Stated as a documented constant with its rationale, the same way
 * `LOCK_STALE_MS` is.
 */
export const HUB_IO_TIMEOUT_MS = 30_000;

/**
 * Machine-wide escape hatch, read fresh on every call rather than cached so a
 * test (and a user debugging a genuinely slow share) can change it without
 * re-importing the module.
 *
 * A missing, unparseable or non-positive value falls back to the constant: this
 * is a safety bound, so a typo must not be able to disable it — and `0` in
 * particular must not mean "no timeout", because that is exactly the state this
 * issue was filed about.
 */
export function hubIoTimeoutMs(): number {
  const raw = process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS;
  if (raw === undefined || raw === "") return HUB_IO_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : HUB_IO_TIMEOUT_MS;
}

/**
 * One hub syscall did not answer within the bound.
 *
 * **Carries no path**, deliberately and for the reason `HubUnreachableResult`
 * carries none (#75): this message reaches a user through an `ErrorResult` on a
 * failure path that does not go through the typed refusal, and the hub's
 * absolute path is not something to volunteer there. `op` is the operation kind
 * only (`"read"`, `"stat"`, `"open"`, …), never the target.
 */
export class HubIoTimeoutError extends Error {
  readonly op: string;
  readonly timeoutMs: number;
  constructor(op: string, timeoutMs: number) {
    super(
      `the hub did not answer a ${op} within ${timeoutMs}ms — the configured hub.path looks like a mount that has stopped responding`
    );
    this.name = "HubIoTimeoutError";
    this.op = op;
    this.timeoutMs = timeoutMs;
  }
}

let abandonedOps = 0;

/**
 * Has this process abandoned a hub syscall that is still running?
 *
 * Read by `cli.ts` at its exit boundary and nowhere else. It is one-way on
 * purpose: fact 3 above is irreversible for the life of the process — the
 * syscall may still return, but by then we have already stopped waiting for it
 * and are no longer able to tell whether libuv's teardown will block.
 */
export function hubIoAbandoned(): boolean {
  return abandonedOps > 0;
}

/**
 * Run one hub syscall under the bound.
 *
 * `dispose` is not optional politeness: on the timeout branch the underlying
 * call is still running and may still SUCCEED later (a mount that comes back),
 * handing us a resource nobody is holding — an open `FileHandle` being the case
 * that matters. It is also where the abandoned promise's eventual settlement is
 * swallowed, without which a rejection arriving minutes after we stopped
 * awaiting it would take the process down as an unhandled rejection.
 */
export async function withHubIoTimeout<T>(
  op: string,
  run: () => Promise<T>,
  dispose?: (value: T) => void
): Promise<T> {
  const timeoutMs = hubIoTimeoutMs();
  const inFlight = run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HubIoTimeoutError(op, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([inFlight, bound]);
  } catch (err) {
    if (err instanceof HubIoTimeoutError) {
      abandonedOps += 1;
      inFlight.then(
        (value) => {
          try {
            dispose?.(value);
          } catch {
            /* the caller has long since been told this failed */
          }
        },
        () => {
          /* it eventually failed too; we already reported the timeout */
        }
      );
    }
    throw err;
  } finally {
    // Both branches: a resolved race must not leave a ref'd timer holding the
    // loop open for the rest of the bound.
    if (timer) clearTimeout(timer);
  }
}
