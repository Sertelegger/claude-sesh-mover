/**
 * Self-check for the shared hub fixtures.
 *
 * A fixture that lies is worse than no fixture: a test built on
 * `writeCorruptBundle` passes just as green when the "corrupt" bundle is
 * actually fine and the code under test never refused anything. So each fixture
 * here is measured against the REAL verifier it is meant to trip
 * (`src/manifest.ts`) or the real resolver it is meant to feed
 * (`src/hub/threads.ts`), never against a restatement of its own construction.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend } from "../../src/hub/backend.js";
import { extractArchive } from "../../src/archiver.js";
import {
  computeIntegrityHashFromFile,
  readManifest,
  verifySessionsDigest,
} from "../../src/manifest.js";
import { resolveThreads } from "../../src/hub/threads.js";
import { getThreadId } from "../../src/sync-state.js";
import {
  currentThreadIndexes,
  emptySyncState,
  writeCorruptBundle,
  CORRUPT_BUNDLE_HEAD_UUID,
} from "./hub-fixtures.js";

/** Pull the bundle back off the hub and unpack it, the way hub/pull.ts does. */
async function fetchAndExtract(hubPath: string, file: string, into: string): Promise<void> {
  const backend = createFsBackend(hubPath);
  const tarPath = join(into, "in.tar.gz");
  mkdirSync(into, { recursive: true });
  writeFileSync(tarPath, await backend.read(file));
  await extractArchive(tarPath, into);
}

describe("writeCorruptBundle", () => {
  it("lands a real archive on the hub that extracts and parses", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-fx-hub-"));
    const work = mkdtempSync(join(tmpdir(), "sesh-fx-work-"));
    try {
      const backend = createFsBackend(hub);
      const record = await writeCorruptBundle(backend, "p1");

      expect(record.file).toMatch(/^projects\/p1\/bundles\/m1\/.*\.tar\.gz$/);
      expect(await backend.exists(record.file)).toBe(true);

      // Structurally sound: gzip CRC intact, tar entries safe, strip:1 puts the
      // bundle tree directly under the extract dir.
      const out = join(work, "extract");
      await expect(fetchAndExtract(hub, record.file, out)).resolves.toBeUndefined();
      expect(existsSync(join(out, "manifest.json"))).toBe(true);

      const manifest = readManifest(out);
      expect(manifest.plugin).toBe("sesh-mover");
      expect(manifest.sessions).toHaveLength(1);
      expect(manifest.sessions[0].sessionId).toBe(record.sessionIdInBundle);
      expect(record.headEntryUuid).toBe(CORRUPT_BUNDLE_HEAD_UUID);

      // The bundle declares a session and actually contains it — the OTHER
      // failure hub/pull.ts checks for right after extraction, which this
      // fixture must not be confused with.
      const jsonlPath = join(out, "sessions", `${record.sessionIdInBundle}.jsonl`);
      expect(existsSync(jsonlPath)).toBe(true);

      // Every line still parses: the damage is in the hashes, not the syntax.
      const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter((l) => l !== "");
      expect(lines).toHaveLength(manifest.sessions[0].messageCount);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      expect((JSON.parse(lines[lines.length - 1]) as { uuid: string }).uuid).toBe(
        CORRUPT_BUNDLE_HEAD_UUID
      );
    } finally {
      for (const d of [hub, work]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("fails the manifest's own sessions digest", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-fx-hub-"));
    const work = mkdtempSync(join(tmpdir(), "sesh-fx-work-"));
    try {
      const backend = createFsBackend(hub);
      const record = await writeCorruptBundle(backend, "p1");
      const out = join(work, "extract");
      await fetchAndExtract(hub, record.file, out);

      // The real check hub/pull.ts runs on every fetched bundle.
      const problem = verifySessionsDigest(readManifest(out));
      expect(problem).not.toBeNull();
      expect(problem).toMatch(/digest/i);
    } finally {
      for (const d of [hub, work]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("fails the per-session content hash: the transcript is not what the manifest declares", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-fx-hub-"));
    const work = mkdtempSync(join(tmpdir(), "sesh-fx-work-"));
    try {
      const backend = createFsBackend(hub);
      const record = await writeCorruptBundle(backend, "p1");
      const out = join(work, "extract");
      await fetchAndExtract(hub, record.file, out);

      const declared = readManifest(out).sessions[0].integrityHash;
      const actual = await computeIntegrityHashFromFile(
        join(out, "sessions", `${record.sessionIdInBundle}.jsonl`)
      );
      expect(declared).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(actual).not.toBe(declared);
    } finally {
      for (const d of [hub, work]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("honours its overrides so two corrupt bundles can coexist on one hub", async () => {
    const hub = mkdtempSync(join(tmpdir(), "sesh-fx-hub-"));
    try {
      const backend = createFsBackend(hub);
      const a = await writeCorruptBundle(backend, "p1");
      const b = await writeCorruptBundle(backend, "p1", {
        machineId: "m2",
        bundleId: "corrupt-two",
        sessionId: "11111111-2222-3333-4444-555555555555",
        pushedAt: "2026-07-22T00:00:00.000Z",
      });

      expect(b.file).not.toBe(a.file);
      expect(b.file).toContain("/bundles/m2/");
      expect(b.file).toContain("corrupt-two");
      // ':' is illegal in a Windows filename — bundleFileName sanitizes it.
      expect(b.file).not.toContain(":");
      expect(await backend.exists(a.file)).toBe(true);
      expect(await backend.exists(b.file)).toBe(true);
      expect(b.sessionIdInBundle).toBe("11111111-2222-3333-4444-555555555555");
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  });
});

describe("currentThreadIndexes", () => {
  it("resolves to threads whose latest copy is m1's own — every thread current there", () => {
    const indexes = currentThreadIndexes();
    expect(indexes).toHaveLength(1);
    expect(indexes[0].machineId).toBe("m1");

    const resolved = resolveThreads(indexes);
    expect(resolved.map((t) => t.threadId).sort()).toEqual(["t1", "t2"]);
    for (const t of resolved) {
      // hub/pull.ts's `isCurrent`, restated against the real resolver.
      const local = t.copies.find((c) => c.machineId === "m1");
      expect(local).toBeDefined();
      expect(local?.headEntryUuid).toBe(t.latest.headEntryUuid);
      // No other machine lists bundles, so no `alternateSource` exists either.
      expect(t.copies.filter((c) => c.machineId !== "m1")).toHaveLength(0);
      expect(t.latest.bundles.length).toBeGreaterThan(0);
      expect(t.latest.bundles.every((b) => b.type === "full")).toBe(true);
    }
  });

  it("takes overrides for machine, project and thread ids", () => {
    const indexes = currentThreadIndexes({
      machineId: "laptop",
      projectId: "proj-9",
      threadIds: ["only-thread"],
    });
    expect(indexes[0].machineId).toBe("laptop");
    expect(indexes[0].projectId).toBe("proj-9");
    expect(Object.keys(indexes[0].threads)).toEqual(["only-thread"]);
    expect(indexes[0].threads["only-thread"].bundles[0].file).toContain("/bundles/laptop/");
  });
});

describe("emptySyncState", () => {
  it("is a valid v1 state that maps no session to any thread", () => {
    const state = emptySyncState();
    expect(state.schemaVersion).toBe(1);
    expect(state.hub).toBeUndefined();
    expect(state.peers).toEqual({});
    expect(state.lineage).toEqual({});
    expect(state.imported).toEqual({});
    expect(getThreadId(state, "local-t1")).toBeNull();
    expect(state.projectPath).toBe("/x");
    expect(emptySyncState("/tmp/other").projectPath).toBe("/tmp/other");
  });
});
