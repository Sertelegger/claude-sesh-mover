/**
 * # `errorMessage` at the sites whose contract a throw would break (#102)
 *
 * The #102 sweep replaced every `(e as Error).message` in `src/hub/` with
 * `errorMessage(e)` (src/errors.ts). The helper is a pure extractor — it
 * decides nothing — so what needs pinning is not the helper (its shapes are
 * unit-proved via `classifyBundleFailure` in tests/hub-bundle-io.test.ts) but
 * the two CONTRACT shapes the ~25 converted sites take, each proved here at
 * its highest-risk instance:
 *
 * 1. **Typed abort, never an uncaught throw** — `pull-fetch.ts`, the module
 *    documented as five `stageAbort`s. With the bare cast, a `null` rejection
 *    out of the unpack became a TypeError thrown from inside the catch: exit 1
 *    through the CLI's outer catch, no `suggestion`, and every disclosure from
 *    bundles already applied and recorded dropped.
 * 2. **Keep going past the file it cannot handle** — `retire.ts`'s deletion
 *    loop, whose entire point is recording a failed file into `failed` and
 *    continuing. With the bare cast, one `null` rejection aborted the whole
 *    `hubDelete` mid-loop with nothing reported and the lock's `finally` as
 *    the only cleanup.
 *
 * Every other converted site is one of these two shapes (a warning pushed
 * mid-operation is shape 2 in miniature); `pull-apply-sessions.ts`'s three are
 * deliberately not driven here because their catch sites (`copyLayerDirs`, a
 * `history.jsonl` append) are private and reachable only through a full
 * append/adopt pipeline — the guard they rely on is the same one line proved
 * twice below.
 *
 * **The non-Error rejections are injected via module mocks, flagged as such**
 * (per this repo's mocks-when-it-earns-coverage rule): no real filesystem or
 * tar path rejects with `null` — node:fs and node-tar throw real Errors — so
 * the hostile shape is only producible by injection, which is exactly why the
 * bare cast survived every real-file test that ever ran against these sites.
 * Everything else in each arrangement is real: a real hub directory, a real
 * bundle stamped by the real manifest writer, the real fs backend (the mock
 * delegates to it except for the one poisoned call).
 *
 * Mutation-proved 2026-09-05 (see the report accompanying the change):
 * reverting pull-fetch.ts's unpack site to the bare cast fails the `null`
 * test here with the resurrected TypeError while the two real-Error tests
 * stay green (they guard the other property — verbatim messages, empty string
 * included); reverting retire.ts's loop site fails the hubDelete test the
 * same way. Restoring each returns this file to green. A green suite is not
 * evidence a guard guards — both were watched failing first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import { runFetchStage } from "../src/hub/pull-fetch.js";
import { initApplyState } from "../src/hub/pull-apply-state.js";
import { createFsBackend, type HubBackend } from "../src/hub/backend.js";
import {
  bundleDir, bundleFileName, indexPath, projectJsonPath, tombstonePath,
  type HubBundleRecord,
} from "../src/hub/layout.js";
import { hubInit } from "../src/hub/init.js";
import { hubRetire, hubDelete } from "../src/hub/retire.js";
import { RETIREMENT_GRACE_MS } from "../src/hub/tombstone.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { createArchive } from "../src/archiver.js";
import { computeIntegrityHashFromFile, writeManifest } from "../src/manifest.js";
import type { ExportManifest, HubDeleteResult } from "../src/types.js";

/**
 * The two poison taps, hoisted for the mocks below. Inactive by default, so
 * every call this file does not deliberately poison runs the real code —
 * including `hubInit`'s own backend and the real `createArchive` that builds
 * the fixture bundle.
 */
const poison = vi.hoisted(() => ({
  /** When set (`{ reason }`), `extractArchive` rejects with exactly that reason. */
  extract: null as { reason: unknown } | null,
  /** When set, `backend.delete` of exactly `path` rejects with `reason`. */
  del: null as { path: string; reason: unknown } | null,
}));

vi.mock("../src/archiver.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/archiver.js")>();
  return {
    ...real,
    extractArchive: (tarPath: string, destDir: string) =>
      poison.extract ? Promise.reject(poison.extract.reason) : real.extractArchive(tarPath, destDir),
  };
});

vi.mock("../src/hub/backend.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/hub/backend.js")>();
  return {
    ...real,
    createFsBackend: (hubPath: string): HubBackend => {
      const b = real.createFsBackend(hubPath);
      return {
        ...b,
        delete: (relPath: string) =>
          poison.del && relPath === poison.del.path
            ? Promise.reject(poison.del.reason)
            : b.delete(relPath),
      };
    },
  };
});

afterEach(() => {
  poison.extract = null;
  poison.del = null;
});

// ---------------------------------------------------------------------------
// Shape 1: pull-fetch.ts — the typed-abort contract survives a null rejection.
// ---------------------------------------------------------------------------

describe("runFetchStage aborts, never throws, whatever the unpack rejected with", () => {
  const MACHINE_ID = "machine-a";
  let root: string;
  let hubDir: string;
  let tempRoot: string;
  let backend: HubBackend;

  /** An intact bundle on the hub, stamped by the real manifest writer. */
  async function writeHealthyBundle(): Promise<HubBundleRecord> {
    const bundleId = "b0";
    const sessionId = `sess-${bundleId}`;
    const pushedAt = "2026-08-01T00:00:00.000Z";
    const staging = mkdtempSync(join(root, "staging-"));
    const bundleStaging = join(staging, "bundle");
    mkdirSync(join(bundleStaging, "sessions"), { recursive: true });
    const jsonlPath = join(bundleStaging, "sessions", `${sessionId}.jsonl`);
    const entry = {
      sessionId, cwd: "/x", version: "2.1.81", gitBranch: "main", slug: "guard",
      uuid: `${bundleId}-1`, parentUuid: null, timestamp: "2026-08-01T10:00:00.000Z",
      type: "user", message: { role: "user", content: "hello" },
    };
    writeFileSync(jsonlPath, JSON.stringify(entry) + "\n", "utf-8");
    const manifest: ExportManifest = {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: pushedAt,
      sourcePlatform: "linux",
      sourceProjectPath: "/x",
      sourceConfigDir: "/x/.claude",
      sourceClaudeVersion: "2.1.81",
      sessionScope: "current",
      includedLayers: ["jsonl"],
      projectId: "p1",
      sourceMachineId: MACHINE_ID,
      sessions: [
        {
          sessionId,
          slug: "guard",
          summary: "an intact bundle",
          createdAt: "2026-08-01T10:00:00.000Z",
          lastActiveAt: "2026-08-01T10:00:00.000Z",
          messageCount: 1,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash: await computeIntegrityHashFromFile(jsonlPath),
          type: "full",
        },
      ],
    };
    writeManifest(bundleStaging, manifest);
    const archivePath = join(staging, "bundle.tar.gz");
    await createArchive(bundleStaging, archivePath, "gzip");
    const file = `${bundleDir("p1", MACHINE_ID)}/${bundleFileName(pushedAt, bundleId)}`;
    await backend.writeAtomic(file, readFileSync(archivePath));
    rmSync(staging, { recursive: true, force: true });
    return {
      bundleId,
      file,
      type: "full",
      sessionIdInBundle: sessionId,
      fromEntryUuid: null,
      headEntryUuid: `${bundleId}-1`,
      messageCount: 1,
      pushedAt,
      hasWorkspace: false,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sm-errmsg-fetch-"));
    hubDir = join(root, "hub");
    tempRoot = join(root, "temp");
    mkdirSync(hubDir, { recursive: true });
    mkdirSync(tempRoot, { recursive: true });
    backend = createFsBackend(hubDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the typed abort when the extraction rejects with null", async () => {
    const record = await writeHealthyBundle();
    const st = initApplyState({ needed: [record] });
    poison.extract = { reason: null };

    // Under the bare cast this line REJECTED with the resurrected TypeError:
    // `runFetchStage` left `hubPull` as a throw, exit 1, no suggestion.
    const out = await runFetchStage({
      backend, record, machineId: MACHINE_ID, bundleIndex: 0,
      chainLength: 1, tempRoot, state: st,
    });

    expect(out.status).toBe("aborted");
    expect(out.value).toBeNull();
    expect(out.terminal).toMatchObject({ success: false, command: "pull" });
    expect(out.terminal?.error).toBe(
      `Bundle ${record.bundleId} could not be unpacked (${record.file}): null`
    );
    // The suggestion is exactly what an uncaught throw used to drop.
    expect(out.terminal?.suggestion).toContain("Nothing from this bundle was applied.");
  });

  it("keeps a real Error's message verbatim in the abort", async () => {
    const record = await writeHealthyBundle();
    const st = initApplyState({ needed: [record] });
    poison.extract = { reason: new Error("zlib: incorrect header check") };

    const out = await runFetchStage({
      backend, record, machineId: MACHINE_ID, bundleIndex: 0,
      chainLength: 1, tempRoot, state: st,
    });

    expect(out.status).toBe("aborted");
    expect(out.terminal?.error).toBe(
      `Bundle ${record.bundleId} could not be unpacked (${record.file}): zlib: incorrect header check`
    );
  });

  it("keeps an EMPTY Error message verbatim — not String(e), which would say 'Error'", async () => {
    // Discriminates `errorMessage` from the tempting `e?.message || String(e)`:
    // `""` is falsy, and `String(new Error(""))` is "Error", which is not what
    // the failing code said.
    const record = await writeHealthyBundle();
    const st = initApplyState({ needed: [record] });
    poison.extract = { reason: new Error("") };

    const out = await runFetchStage({
      backend, record, machineId: MACHINE_ID, bundleIndex: 0,
      chainLength: 1, tempRoot, state: st,
    });

    expect(out.status).toBe("aborted");
    expect(out.terminal?.error).toBe(
      `Bundle ${record.bundleId} could not be unpacked (${record.file}): `
    );
  });
});

// ---------------------------------------------------------------------------
// Shape 2: retire.ts — the keep-going loop survives a null rejection.
// ---------------------------------------------------------------------------

describe("hubDelete records a null-rejecting file into `failed` and keeps deleting", () => {
  const PROJECT_ID = "hub-project-102";
  let root: string;
  let home: HomeOverrideHandle;
  let hubDir: string;
  let projectPath: string;
  let meId: string;
  let bundleRel: string;

  function writeHubFile(rel: string, body: unknown): void {
    const p = join(hubDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf-8");
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "sm-errmsg-retire-"));
    mkdirSync(join(root, "home"), { recursive: true });
    home = overrideHome(join(root, "home"));
    hubDir = join(root, "hub");
    projectPath = join(root, "proj");
    mkdirSync(projectPath, { recursive: true });
    await hubInit({ hubPath: hubDir, configScope: "user", cwd: join(root, "home") });
    meId = loadOrCreateMachineId().id;
    writeHubFile(projectJsonPath(PROJECT_ID), {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      name: "atlas",
      matchers: { gitRemotes: [] },
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByMachine: meId,
    });
    writeHubFile(indexPath(PROJECT_ID, meId), {
      schemaVersion: 1,
      agent: "claude-code",
      projectId: PROJECT_ID,
      machineId: meId,
      updatedAt: "2026-08-01T00:00:00.000Z",
      projectPath,
      threads: {},
    });
    bundleRel = `${bundleDir(PROJECT_ID, meId)}/${bundleFileName("2026-08-01T00:00:00.000Z", "b1")}`;
    const bundleAbs = join(hubDir, bundleRel);
    mkdirSync(dirname(bundleAbs), { recursive: true });
    writeFileSync(bundleAbs, "not-a-real-archive");
    writeLocalProjectId(projectPath, {
      projectId: PROJECT_ID,
      name: "atlas",
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByMachine: meId,
    });
  });

  afterEach(() => {
    home.restore();
    rmSync(root, { recursive: true, force: true });
  });

  it("finishes the delete, reporting the poisoned file rather than throwing out of the loop", async () => {
    const retired = await hubRetire({ projectPath, hubPath: hubDir });
    expect(retired.success).toBe(true);
    // Age the tombstone past the grace window so the delete is authorized.
    const tombRel = tombstonePath(PROJECT_ID, meId);
    const tomb = JSON.parse(readFileSync(join(hubDir, tombRel), "utf-8")) as Record<string, unknown>;
    tomb.retiredAt = new Date(Date.now() - RETIREMENT_GRACE_MS - 3_600_000).toISOString();
    writeHubFile(tombRel, tomb);

    poison.del = { path: bundleRel, reason: null };

    // Under the bare cast this REJECTED with the TypeError: the loop whose
    // entire point is continuing past a file it cannot delete stopped at the
    // first one, with nothing recorded in `failed` and nothing after it removed.
    const out = await hubDelete({ projectPath, hubPath: hubDir });

    expect(out.success).toBe(true);
    const res = out as HubDeleteResult;
    expect(res.failed).toEqual([{ path: bundleRel, error: "null" }]);
    // The loop went on past the poisoned file: everything else is gone —
    // project.json (deleted FIRST, before the poisoned bundle), the index and
    // the tombstone (deleted LAST, after it).
    expect(res.deletedFiles).toBe(3);
    expect(existsSync(join(hubDir, projectJsonPath(PROJECT_ID)))).toBe(false);
    expect(existsSync(join(hubDir, indexPath(PROJECT_ID, meId)))).toBe(false);
    expect(existsSync(join(hubDir, tombRel))).toBe(false);
    // The one it could not delete is still there, exactly as `failed` says.
    expect(existsSync(join(hubDir, bundleRel))).toBe(true);
  });
});
