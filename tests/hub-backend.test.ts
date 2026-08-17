import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once, type EventEmitter } from "node:events";
import { createFsBackend, type HubBackend } from "../src/hub/backend.js";

// Contract suite: any HubBackend implementation must pass these.
// Exported so a future HttpBackend test file can import and run the same
// assertions (`import { backendContract } from "./hub-backend.test.js"`).
export function backendContract(makeBackend: () => { backend: HubBackend; root: string }) {
  let backend: HubBackend;
  let root: string;

  beforeEach(() => {
    ({ backend, root } = makeBackend());
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writeAtomic + read round-trips and creates parent dirs", async () => {
    await backend.writeAtomic("projects/p1/project.json", '{"a":1}');
    expect((await backend.read("projects/p1/project.json")).toString()).toBe('{"a":1}');
  });

  it("writeAtomic leaves no temp files behind", async () => {
    await backend.writeAtomic("machines/m1.json", "{}");
    const files = readdirSync(join(root, "machines"));
    expect(files).toEqual(["m1.json"]);
  });

  it("exists and delete behave; delete of missing is a no-op", async () => {
    expect(await backend.exists("x/y.json")).toBe(false);
    await backend.writeAtomic("x/y.json", "{}");
    expect(await backend.exists("x/y.json")).toBe(true);
    await backend.delete("x/y.json");
    await backend.delete("x/y.json"); // no throw
    expect(await backend.exists("x/y.json")).toBe(false);
  });

  it("list returns relative file paths recursively with / separators; [] for missing prefix", async () => {
    await backend.writeAtomic("projects/p1/index/m1.json", "{}");
    await backend.writeAtomic("projects/p1/index/m2.json", "{}");
    await backend.writeAtomic("projects/p1/bundles/m1/b1.tar.gz", "x");
    expect((await backend.list("projects/p1/index")).sort()).toEqual([
      "projects/p1/index/m1.json",
      "projects/p1/index/m2.json",
    ]);
    expect(await backend.list("projects/nope")).toEqual([]);
  });

  it("read of a missing file rejects with a not-found error", async () => {
    await expect(backend.read("missing.json")).rejects.toThrow();
  });

  it("stream write commit + stream read round-trips large content", async () => {
    const big = "line\n".repeat(200_000); // ~1MB
    const w = await backend.writeStreamAtomic("projects/p1/bundles/m1/big.tar.gz");
    w.stream.write(big);
    (w.stream as NodeJS.WritableStream & { end(): void }).end();
    await w.commit();
    const r = await backend.readStream("projects/p1/bundles/m1/big.tar.gz");
    let bytes = 0;
    for await (const chunk of r as AsyncIterable<Buffer>) bytes += chunk.length;
    expect(bytes).toBe(Buffer.byteLength(big));
  });

  it("aborted stream write leaves nothing behind", async () => {
    const w = await backend.writeStreamAtomic("projects/p1/bundles/m1/junk.tar.gz");
    w.stream.write("partial");
    await w.abort();
    expect(await backend.exists("projects/p1/bundles/m1/junk.tar.gz")).toBe(false);
    expect(existsSync(join(root, "projects/p1/bundles/m1"))
      ? readdirSync(join(root, "projects/p1/bundles/m1")).length : 0).toBe(0);
  });

  it("aborted stream write leaves nothing behind AFTER the fd has closed", async () => {
    // The test above asserts SYNCHRONOUSLY, inside the window the defect lives
    // in, and passed 10/10 while the defect was live. `createWriteStream` opens
    // its fd asynchronously and `destroy()` on a pending open is deferred until
    // the open completes — so `destroy(); rmSync(tmp)` unlinked a path the file
    // had not reached, and the open then created it. Measured on Linux (this is
    // not the Windows-only EBUSY race it was filed as), 5/5 runs: empty on
    // return, a full-size `.tmp-<uuid>` 100ms later — invisible to `list()`,
    // which filters `.tmp-`, and replicated to every machine by whatever syncs
    // the hub.
    //
    // Waiting on "close" rather than a timer is what makes this deterministic:
    // close is emitted after the deferred open has created the file, so an
    // implementation that unlinks too early is caught every run rather than
    // most runs. With the fix, abort() has already awaited it.
    const w = await backend.writeStreamAtomic("projects/p1/bundles/m1/orphan.tar.gz");
    w.stream.write("partial");
    const closed = once(w.stream as unknown as EventEmitter, "close");
    await w.abort();
    await closed;
    const dir = join(root, "projects/p1/bundles/m1");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("abort() never rejects, so it cannot mask the failure that triggered it", async () => {
    // Its callers run it from a catch block (`hub/push.ts`: `await w.abort();
    // throw e;`), where `abort()` rejecting REPLACES the pipeline's real error
    // — and push's error is the payload of its own disclosure machinery, so an
    // `ENOSPC` would be recorded in the durable auto-push breadcrumb as an
    // unlink error. Aborting twice exercises the second unlink against a path
    // that is already gone.
    const w = await backend.writeStreamAtomic("projects/p1/bundles/m1/twice.tar.gz");
    w.stream.write("partial");
    await expect(w.abort()).resolves.toBeUndefined();
    await expect(w.abort()).resolves.toBeUndefined();
  });

  it("failed stream commit rejects and cleans up its temp file", async () => {
    const w = await backend.writeStreamAtomic("projects/p1/bundles/m1/fail.tar.gz");
    w.stream.write("partial");
    // Simulate a mid-write failure (disk full, connection lost) before commit.
    (w.stream as unknown as { destroy(err: Error): void }).destroy(new Error("simulated failure"));
    await new Promise((resolve) => setImmediate(resolve)); // let the error event latch
    await expect(w.commit()).rejects.toThrow(/simulated failure/);
    expect(await backend.exists("projects/p1/bundles/m1/fail.tar.gz")).toBe(false);
    expect(existsSync(join(root, "projects/p1/bundles/m1"))
      ? readdirSync(join(root, "projects/p1/bundles/m1")).length : 0).toBe(0);
  });

  it("list hides an in-flight temp file and nothing else", async () => {
    // Untested in either direction until now, and both directions matter.
    // KEEPING the filter: `hub reindex` warns about every bundle file it cannot
    // account for and `hub status` counts `machines/` with no filtering at all,
    // so a concurrent push's in-flight temp becomes a warning and a wrong count
    // the moment this stops hiding one. NOT WIDENING it: the filter is a
    // substring test on the basename, so anything it over-matches is a real
    // bundle that silently stops existing for every reader.
    const dir = join(root, "projects/p1/bundles/m1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-08-16T00-00-00Z-b1.tar.gz.tmp-${randomUUID()}`), "x");
    writeFileSync(join(dir, "2026-08-16T00-00-00Z-b1.tar.gz"), "x");
    expect(await backend.list("projects/p1/bundles/m1")).toEqual([
      "projects/p1/bundles/m1/2026-08-16T00-00-00Z-b1.tar.gz",
    ]);
  });

  it("rejects unsafe relative paths on every method", async () => {
    for (const p of ["/abs", "a/../b", "a\\b", ""]) {
      await expect(backend.read(p)).rejects.toThrow(/hub-relative/i);
      await expect(backend.writeAtomic(p, "x")).rejects.toThrow(/hub-relative/i);
      await expect(backend.exists(p)).rejects.toThrow(/hub-relative/i);
      await expect(backend.list(p)).rejects.toThrow(/hub-relative/i);
      await expect(backend.delete(p)).rejects.toThrow(/hub-relative/i);
      await expect(backend.readStream(p)).rejects.toThrow(/hub-relative/i);
      await expect(backend.writeStreamAtomic(p)).rejects.toThrow(/hub-relative/i);
    }
  });
}

describe("FsBackend contract", () => {
  backendContract(() => {
    const root = mkdtempSync(join(tmpdir(), "sesh-hub-backend-"));
    return { backend: createFsBackend(root), root };
  });

  it("writeAtomic is temp+rename (atomic replace of existing content)", async () => {
    const root = mkdtempSync(join(tmpdir(), "sesh-hub-backend-"));
    try {
      const backend = createFsBackend(root);
      await backend.writeAtomic("f.json", "old");
      await backend.writeAtomic("f.json", "new");
      expect(readFileSync(join(root, "f.json"), "utf-8")).toBe("new");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
