import type { Writable } from "node:stream";
/**
 * The write-side error latch every streaming writer in this codebase sits on.
 *
 * WHAT IT IS FOR. A `Writable` that fails — output directory missing, disk
 * full, EACCES — fails asynchronously and at most once, and a caller waiting
 * on the stream's own signals can lose that one event in three distinct ways:
 *
 * (1) With zero 'error' listeners the event is an "unhandled error event" and
 *     the process dies. The latch's `once("error")` listener is that listener.
 * (2) `once(stream, "drain")` only reacts to an 'error' that fires AFTER the
 *     wait begins. A stream that errored earlier — an open failure destroys
 *     the stream before the first backpressured write — never drains and
 *     never errors again, so the wait hangs forever. Latching the first
 *     'error' into a promise and racing it at every await point fixes this:
 *     a rejected promise stays rejected, so racing it after the fact wins
 *     instantly.
 * (3) The promise from (2) has no handler until the first race, which can be
 *     arbitrarily far off — the reader has to yield something first. If the
 *     output errors before that, Node sees an unhandled rejection. The no-op
 *     catch marks it handled at once; it does not consume the rejection,
 *     which the real race still receives.
 *
 * The protocol is three calls and one obligation. `write()` is the stream's
 * own (a `false` return means "`await drain()` before writing again"),
 * `finish()` ends the stream and waits for it, and both awaits race the
 * latch. The obligation is `destroy()` in the caller's `catch`: it is for
 * failures the STREAM did not raise — a read error, a thrown transform —
 * which the stream would otherwise never learn about, leaving an open fd and
 * a partial file that looks complete.
 *
 * WHAT IT CANNOT DO. It is a latch, not a supervisor.
 * - It carries the FIRST error only. Node's stream machinery emits 'error' at
 *   most once per stream, so nothing is lost on a real fs stream; a second
 *   'error' delivered by hand finds the listener already removed and is the
 *   emitter's own problem, exactly as it was before this helper existed.
 * - It bounds nothing. A stream that neither drains nor errors — a hung
 *   network mount — hangs the caller as before. The bound in this codebase
 *   is drawn on the syscall (`hub/io-timeout.ts`), not here.
 * - It cannot tell the caller a write was LOST. An error surfaces at the next
 *   await point, and bytes accepted by `write()` before that were buffered,
 *   not written; the callers here treat any rejection as "the output is
 *   garbage" and destroy it, which is the only sound reading.
 *
 * Four writers share it — `rewriteJsonlStream`, `buildContinuationStream`,
 * `copyFileWithHash`, `stripHeader` — and `tests/latched-write.test.ts` pins
 * the protocol ONCE. That is the reason it exists (#16): two of the four are
 * module-private, so before this they could not be pinned at all, and a green
 * suite said nothing about whether their latch latched.
 */
export interface LatchedWriteStream {
    /**
     * `stream.write` verbatim: `false` means the buffer is over its high-water
     * mark and the caller must `await drain()` before the next write. It returns
     * the stream's boolean rather than a promise on purpose, so a run that never
     * backpressures pays no microtask per chunk.
     */
    write(chunk: string | Uint8Array): boolean;
    /**
     * Resolves on 'drain'; rejects with the latched error — including one that
     * fired before this call, which is the case a bare `once(stream, "drain")`
     * hangs on.
     */
    drain(): Promise<void>;
    /** `end()`, then wait for 'finish' or for the latched error, whichever settles first. */
    finish(): Promise<void>;
    /**
     * Tear the stream down after a failure it did not raise itself. Safe on a
     * stream that has already errored or been destroyed.
     */
    destroy(): void;
}
export declare function latchedWriteStream(stream: Writable): LatchedWriteStream;
//# sourceMappingURL=latched-write.d.ts.map