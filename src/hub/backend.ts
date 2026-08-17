import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { finished } from "node:stream/promises";
import { assertHubRelPath } from "./layout.js";
import { HubIoTimeoutError, withHubIoTimeout } from "./io-timeout.js";

export interface HubWriteStream {
  stream: NodeJS.WritableStream;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface HubBackend {
  read(relPath: string): Promise<Buffer>;
  writeAtomic(relPath: string, data: Buffer | string): Promise<void>;
  list(relPrefix: string): Promise<string[]>;
  exists(relPath: string): Promise<boolean>;
  delete(relPath: string): Promise<void>;
  readStream(relPath: string): Promise<NodeJS.ReadableStream>;
  writeStreamAtomic(relPath: string): Promise<HubWriteStream>;
}

/**
 * The only backend in Slice 1: a hub that is an ordinary directory (a network
 * share or a synced folder).
 *
 * **Every call below is `node:fs/promises` under `withHubIoTimeout`, and both
 * halves are load-bearing (#71).** This file used to be `readFileSync` and
 * friends behind `async` signatures, which meant a hub that BLOCKS rather than
 * fails — a dead hard mount — stopped the whole event loop inside `hubPush`'s
 * critical section, so no timer, no signal handler and no deadline anywhere in
 * this codebase could end it. See `io-timeout.ts` for the three measurements
 * that shape this: the async path leaves the event loop free, an `AbortSignal`
 * does NOT interrupt a blocked `open()` (so the bound is a race, not a
 * cancellation), and a process that has abandoned one of these calls cannot
 * exit without a signal.
 *
 * **The line the bound is drawn on: one syscall, never an aggregate, never a
 * transfer.** `list` bounds each `readdir` rather than the recursive walk, and
 * the two stream methods bound the `open` and the commit `rename` while leaving
 * the pipeline itself entirely unbounded. A bundle archive is the only thing
 * that ever streams through here and it can legitimately be large and slow; a
 * share that is merely slow must keep working, which is the whole reason the
 * bound is not allowed to cover bytes.
 */
export function createFsBackend(rootDir: string): HubBackend {
  const abs = (relPath: string): string => {
    assertHubRelPath(relPath);
    return join(rootDir, ...relPath.split("/"));
  };

  return {
    async read(relPath) {
      return withHubIoTimeout("read", () => readFile(abs(relPath)));
    },

    async writeAtomic(relPath, data) {
      const target = abs(relPath);
      await withHubIoTimeout("mkdir", () => mkdir(dirname(target), { recursive: true }));
      const tmp = `${target}.tmp-${randomUUID()}`;
      // Bounded as one call because what it writes here is always small — every
      // bundle archive goes through writeStreamAtomic instead. hub.json,
      // project.json, machines/<id>.json and an index file are the callers.
      await withHubIoTimeout("write", () => writeFile(tmp, data));
      await withHubIoTimeout("rename", () => rename(tmp, target));
    },

    async list(relPrefix) {
      assertHubRelPath(relPrefix);
      const root = join(rootDir, ...relPrefix.split("/"));
      // One stat replaces the old existsSync+statSync pair: same three answers
      // (absent, present-but-not-a-directory, walk it) at one syscall instead of
      // two, which on a share is one fewer round trip per call.
      let rootStat;
      try {
        rootStat = await withHubIoTimeout("stat", () => stat(root));
      } catch (err) {
        // A timeout is NOT "absent". Reporting an unresponsive mount as an
        // empty listing would let a caller conclude the hub holds nothing.
        if (err instanceof HubIoTimeoutError) throw err;
        return [];
      }
      if (!rootStat.isDirectory()) return [relPrefix];

      const out: string[] = [];
      const walk = async (dir: string, rel: string): Promise<void> => {
        // Bounded per directory, not once for the whole walk: a hub with many
        // bundles is a legitimately long listing, and bounding the aggregate
        // would fail a large-but-healthy hub.
        const entries = await withHubIoTimeout("readdir", () =>
          readdir(dir, { withFileTypes: true })
        );
        for (const entry of entries) {
          const childRel = `${rel}/${entry.name}`;
          if (entry.isDirectory()) await walk(join(dir, entry.name), childRel);
          else if (entry.isFile() && !entry.name.includes(".tmp-")) out.push(childRel);
        }
      };
      await walk(root, relPrefix);
      return out;
    },

    async exists(relPath) {
      // RESOLVED OUTSIDE THE try, and it has to be: `abs` runs
      // `assertHubRelPath`, whose throw is the path-safety chokepoint every hub
      // id passes through. Inside the catch below it would be swallowed into a
      // plain `false`, turning "this bundle reference is not a safe
      // hub-relative path" into "that file isn't here" — the guard would still
      // refuse the fetch, but silently, and `pull-apply-workspace.ts` surfaces
      // that message as the warning explaining why a merge fell back.
      // (Measured: doing it the other way fails hub-pull's poisoned-generation
      // test, which is the guard for exactly this.)
      const target = abs(relPath);
      try {
        await withHubIoTimeout("stat", () => stat(target));
        return true;
      } catch (err) {
        // Same rule as list(), and it matters more here: `pull-select.ts` sweeps
        // every needed bundle with this call and answers `not-yet-synced` when
        // one is missing. Swallowing a timeout into `false` would turn a hung
        // mount into a confident "your sync client hasn't finished yet", which
        // sends the user to wait for a thing that is never going to happen.
        if (err instanceof HubIoTimeoutError) throw err;
        return false;
      }
    },

    async delete(relPath) {
      await withHubIoTimeout("delete", () => rm(abs(relPath), { force: true }));
    },

    async readStream(relPath) {
      // The open is bounded; the read of the bytes is not. `createReadStream`
      // would have opened lazily on the threadpool — non-blocking, but also
      // unbounded and with its failure surfacing at the pipeline rather than
      // here. The FileHandle closes itself when the stream ends (autoClose
      // defaults true), which is why nothing below tracks it.
      const handle = await withHubIoTimeout(
        "open",
        () => open(abs(relPath), "r"),
        (fh) => void fh.close().catch(() => {})
      );
      return handle.createReadStream();
    },

    async writeStreamAtomic(relPath) {
      const target = abs(relPath);
      await withHubIoTimeout("mkdir", () => mkdir(dirname(target), { recursive: true }));
      const tmp = `${target}.tmp-${randomUUID()}`;
      const handle = await withHubIoTimeout(
        "open",
        () => open(tmp, "w"),
        (fh) => void fh.close().catch(() => {})
      );
      const stream = handle.createWriteStream();
      // A stream error occurring before commit()/abort() is called would
      // otherwise be an unhandled 'error' event with zero listeners
      // attached, which crashes the process outright (same hazard as
      // rewriter.ts's rewriteJsonlStream). Latch it here immediately so
      // commit() can surface it as a rejection instead.
      let streamError: Error | null = null;
      stream.once("error", (err) => {
        streamError = err;
      });
      return {
        stream,
        async commit() {
          // On any failure, remove the temp file before rethrowing — a
          // caller that awaited commit() won't also call abort(), so this
          // is the only chance to avoid orphaning the temp.
          try {
            if (streamError) throw streamError;
            if (!stream.writableEnded) stream.end();
            await finished(stream);
            if (streamError) throw streamError;
            await withHubIoTimeout("rename", () => rename(tmp, target));
          } catch (err) {
            // Bounded and swallowed: this cleanup runs while `err` is already
            // on its way out, so it must not be able to hang the process or to
            // replace the real failure.
            await withHubIoTimeout("delete", () => rm(tmp, { force: true })).catch(() => {});
            throw err;
          }
        },
        async abort() {
          // WAIT FOR THE FD TO CLOSE BEFORE UNLINKING. `createWriteStream`
          // opens its fd asynchronously and `destroy()` on a still-pending open
          // is DEFERRED until that open completes — so a bare
          // `destroy(); rm(tmp)` pair unlinks a path the file has not
          // reached yet, and the open then creates it. Measured on Linux (not a
          // Windows-only EBUSY race, which is what this was filed as), 5/5
          // runs: the bundle directory reads empty the instant `abort()`
          // returns and holds a full-size `<name>.tmp-<uuid>` 100ms later.
          // Nothing ever reaps it — `list()` filters `.tmp-` out, so it is
          // invisible to `hub status`, to `reindex` and to the user, while
          // whatever syncs the hub replicates it to every machine.
          //
          // #71 narrowed that race rather than removing this: the fd is now
          // opened eagerly and awaited above, so by the time any caller can
          // reach abort() the file provably exists. The await stays because it
          // is the destroy/close ORDERING that the unlink depends on, which an
          // eager open does not settle.
          //
          // `finished` rejects with ERR_STREAM_PREMATURE_CLOSE on a destroyed
          // stream; here that is the expected path, not a failure.
          stream.destroy();
          await finished(stream).catch(() => {});
          // NOTHING IN abort() MAY THROW, and awaiting real I/O above is
          // precisely what makes that worth stating. Its callers run it from a
          // catch block (`hub/push.ts`: `await w.abort(); throw e;`), where a
          // rejection REPLACES the pipeline's real failure — and push's failure
          // is the payload of its own disclosure machinery, so `ENOSPC: no
          // space left on device` would be recorded in the durable auto-push
          // breadcrumb as an unlink error. An orphaned temp file is the lesser
          // of those two; `rm(force)` swallows ENOENT but not EPERM/EBUSY, and
          // on an unresponsive mount the unlink can now time out as well —
          // which is the same lesser evil and swallowed the same way.
          await withHubIoTimeout("delete", () => rm(tmp, { force: true })).catch(() => {
            /* best effort — see above; a stale temp beats a masked error */
          });
        },
      };
    },
  };
}
