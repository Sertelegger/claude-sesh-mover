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
export declare function createFsBackend(rootDir: string): HubBackend;
//# sourceMappingURL=backend.d.ts.map