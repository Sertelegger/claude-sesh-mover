import { describe, it, expect } from "vitest";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Writable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { latchedWriteStream } from "../src/latched-write.js";

// A broken latch does not fail loudly — it HANGS (guard 2 in the module
// header), and vitest would report that as a 20s timeout with no hint of which
// await stuck. Bounding each await turns the hang into a named failure in 2s.
// The bound is generous relative to the microtask-scale waits under test; if it
// ever fires on a healthy helper, something other than the helper is wrong.
const HANG_MS = 2_000;
async function bounded<T>(label: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} hung for ${HANG_MS}ms`)), HANG_MS);
  });
  try {
    return await Promise.race([p, hung]);
  } finally {
    clearTimeout(timer);
  }
}

/** Past the microtask queue, the nextTick queue and one round of I/O callbacks. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A Writable whose `_write` never completes, so nothing can EVER drain and the
 * latch is the only way out of a pending `drain()`. Not a filesystem mock —
 * the stream contract itself is what the latch is about, and a real fs stream
 * cannot be told to stall on demand.
 */
class StuckWritable extends Writable {
  constructor(highWaterMark: number) {
    super({ highWaterMark });
  }
  override _write(_chunk: unknown, _encoding: BufferEncoding, _callback: (error?: Error | null) => void): void {
    // never called back
  }
}

/** A real fs stream whose open fails; waits until the 'error' has actually fired. */
async function failedOpen(dir: string) {
  const stream = createWriteStream(join(dir, "no-such-subdir", "out.txt"));
  const latched = latchedWriteStream(stream);
  // A plain listener, not events.once(): that helper rejects on the very
  // 'error' this waits to get past.
  await new Promise<void>((resolve) => stream.once("close", resolve));
  expect(stream.destroyed).toBe(true);
  return { stream, latched };
}

describe("latchedWriteStream", () => {
  // Guard (2), and the production shape of it: the open fails before the
  // caller has written anything, the first write() reports false because the
  // stream is destroyed, and the caller awaits a drain that can never come.
  // Mutation this catches: dropping the latch (a bare once(stream, "drain")).
  it("surfaces an error that fired before the first await — an open failure — instead of hanging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sesh-latch-"));
    try {
      const { latched } = await failedOpen(dir);
      expect(latched.write("x")).toBe(false);
      await expect(bounded("drain()", latched.drain())).rejects.toThrow(/ENOENT/);
      await expect(bounded("finish()", latched.finish())).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Guard (3). The early error is latched into a promise nobody has raced yet;
  // without the handled-marking Node reports it as an unhandled rejection, and
  // with a handled-marking that CONSUMES it the later race would hang. Both
  // halves are asserted. Mutation this catches: dropping `errored.catch(() => {})`,
  // or replacing it with a catch that resolves.
  it("neither leaks an early error as an unhandled rejection nor consumes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sesh-latch-"));
    const unhandled: unknown[] = [];
    const spy = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", spy);
    try {
      const { latched } = await failedOpen(dir);
      // Node emits unhandledRejection after the tick in which the rejection
      // went unhandled; two macrotasks is well past that.
      await settle();
      await settle();
      expect(unhandled).toEqual([]);
      await expect(bounded("drain()", latched.drain())).rejects.toThrow(/ENOENT/);
    } finally {
      process.off("unhandledRejection", spy);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Mid-stream, between two await points: a write was accepted, then the
  // stream died (ENOSPC, EIO), then the next write reports false. That drain
  // is waiting on a destroyed stream — guard (2) again, but reached from a
  // healthy start rather than a failed open. Real fs stream; the death is
  // injected with destroy(), which is what the fs layer does on a write error.
  it("rejects the next drain() with an error that fired between two writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sesh-latch-"));
    try {
      const stream = createWriteStream(join(dir, "out.txt"));
      const latched = latchedWriteStream(stream);
      expect(latched.write("accepted\n")).toBe(true);
      const boom = new Error("ENOSPC: simulated mid-stream failure");
      stream.destroy(boom);
      await settle();
      expect(latched.write("never lands\n")).toBe(false);
      await expect(bounded("drain()", latched.drain())).rejects.toBe(boom);
      await expect(bounded("finish()", latched.finish())).rejects.toBe(boom);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Mid-stream, DURING a pending drain: the error must reject the wait that is
  // already in flight, with the stream's error and not a substitute. Mutation
  // this catches: a drain() that swallows the rejection, or resolves on it.
  it("rejects a drain() already in flight when the stream errors under it", async () => {
    const stream = new StuckWritable(1);
    const latched = latchedWriteStream(stream);
    expect(latched.write("more than one byte")).toBe(false);
    const pending = bounded("drain()", latched.drain());
    const boom = new Error("EIO: simulated failure under a pending drain");
    stream.destroy(boom);
    await expect(pending).rejects.toBe(boom);
  });

  // The latch is a promise, and a promise settles once — so the FIRST error is
  // the one every later await sees. A variable that is overwritten on each
  // 'error' would report the last, which for a real failure is the less
  // informative follow-on (the ENOENT, not the EACCES that caused it).
  // Mutation this catches: a last-writer-wins latch.
  it("carries the FIRST error, not the last", async () => {
    const stream = new StuckWritable(1024);
    const latched = latchedWriteStream(stream);
    const first = new Error("first");
    const second = new Error("second");
    // Node's own machinery emits 'error' at most once per stream, so the
    // second is delivered by hand — with an absorbing listener, because the
    // latch's once() listener is gone after the first and a listener-less
    // emit throws at the emit site rather than reaching any latch.
    stream.on("error", () => {});
    stream.destroy(first);
    await settle();
    stream.emit("error", second);
    await settle();
    expect(latched.write("x")).toBe(false);
    await expect(bounded("drain()", latched.drain())).rejects.toBe(first);
    await expect(bounded("finish()", latched.finish())).rejects.toBe(first);
  });

  // The healthy path, with backpressure forced on every write: drain() is a
  // real wait that resolves, finish() actually ends the stream, and the bytes
  // are on disk in order. Mutation this catches: a finish() that forgets
  // end() (hangs), or a drain() that resolves before the buffer emptied
  // (bytes would still land, but drains would not equal writes).
  it("drains and finishes a healthy stream, and the bytes land in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sesh-latch-"));
    try {
      const path = join(dir, "out.txt");
      const stream = createWriteStream(path, { highWaterMark: 1 });
      const latched = latchedWriteStream(stream);
      const chunks = ["alpha\n", "beta\n", "gamma\n"];
      let drains = 0;
      for (const chunk of chunks) {
        if (!latched.write(chunk)) {
          drains++;
          await bounded("drain()", latched.drain());
        }
      }
      await bounded("finish()", latched.finish());
      // hwm 1: every multi-byte write is over the mark, so every write drained.
      expect(drains).toBe(chunks.length);
      expect(stream.writableFinished).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe(chunks.join(""));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The caller's obligation: after a failure the stream did not raise, the
  // caller destroys it so the fd is released. Pins that destroy() reaches the
  // stream and is safe to call on one that has already died.
  it("destroy() closes the stream and is safe on an already-errored one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sesh-latch-"));
    try {
      const stream = createWriteStream(join(dir, "out.txt"));
      const latched = latchedWriteStream(stream);
      const closed = new Promise<void>((resolve) => stream.once("close", resolve));
      latched.destroy();
      await bounded("close", closed);
      expect(stream.destroyed).toBe(true);

      const { latched: errored } = await failedOpen(dir);
      expect(() => errored.destroy()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
