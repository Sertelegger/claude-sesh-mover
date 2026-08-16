import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { hubReindex } from "../src/hub/reindex.js";
import { readMachineIndex } from "../src/hub/index-file.js";
import { createFsBackend } from "../src/hub/backend.js";
import { createArchive, extractArchive } from "../src/archiver.js";
import { readManifest, writeManifest } from "../src/manifest.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { encodeProjectPath } from "../src/platform.js";
import { indexPath, type HubIndexJson } from "../src/hub/layout.js";

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

// Same real-directory technique hub-push.test.ts uses: identity linking
// writes `.sesh-mover-project.json` under the real project directory,
// which this sandbox can't do against a virtual "/Users/..." root.
function createRealProject(base: string, configDir: string): string {
  const realProj = join(base, "realproj");
  mkdirSync(realProj, { recursive: true });
  writeFileSync(join(realProj, "README.md"), "hello\n");
  const realEncoded = encodeProjectPath(realProj);
  cpSync(join(configDir, "projects", FIXTURE_ENCODED), join(configDir, "projects", realEncoded), {
    recursive: true,
  });
  return realProj;
}

// Strip the one field a rebuild is expected to differ on (the rebuild runs
// at a different wall-clock moment than the original push).
function withoutUpdatedAt(index: HubIndexJson): Omit<HubIndexJson, "updatedAt"> {
  const { updatedAt: _updatedAt, ...rest } = index;
  return rest;
}

/** Extend a session in place, so the next push ships a continuation. */
function continueSession(jsonlPath: string, sessionId: string, projectPath: string): string {
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter((l) => l !== "");
  const anchorUuid = (JSON.parse(lines[lines.length - 1]) as { uuid: string }).uuid;
  const added = [
    {
      uuid: "x-entry-4", parentUuid: anchorUuid, timestamp: "2026-04-11T09:00:00Z",
      sessionId, cwd: projectPath, version: "2.1.81", type: "user",
      message: { role: "user", content: "one more thing" },
    },
    {
      uuid: "x-entry-5", parentUuid: "x-entry-4", timestamp: "2026-04-11T09:00:05Z",
      sessionId, cwd: projectPath, version: "2.1.81", type: "assistant",
      message: { model: "claude-opus-4-6", id: "msg_x", content: [{ type: "text", text: "Done." }] },
    },
  ];
  writeFileSync(
    jsonlPath,
    readFileSync(jsonlPath, "utf-8") + added.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8"
  );
  return anchorUuid;
}

/**
 * Rewrite a bundle already on the hub through `mutate`, restamping the manifest
 * with the REAL writer so the result is indistinguishable from a bundle that was
 * always shaped that way (`writeManifest` recomputes `sessionsDigest`, which is
 * the point: a hand-edited digest would fail verification for the wrong reason).
 */
async function rewriteBundleManifest(
  hub: string,
  file: string,
  work: string,
  mutate: (m: ReturnType<typeof readManifest>) => void
): Promise<void> {
  const backend = createFsBackend(hub);
  const staging = join(work, "bundle");
  mkdirSync(staging, { recursive: true });
  const tarIn = join(work, "in.tar.gz");
  writeFileSync(tarIn, await backend.read(file));
  await extractArchive(tarIn, staging);

  const manifest = readManifest(staging);
  mutate(manifest);
  writeManifest(staging, manifest);

  const tarOut = join(work, "out.tar.gz");
  await createArchive(staging, tarOut, "gzip");
  await backend.writeAtomic(file, readFileSync(tarOut));
}

describe("hub reindex", () => {
  it("rebuilds a deleted index to match the original push, modulo updatedAt", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const pushed = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(true);
      if (!pushed.success) return;

      const backend = createFsBackend(hub);
      const machine = loadOrCreateMachineId();
      const original = await readMachineIndex(backend, pushed.projectId, machine.id);
      expect(original).not.toBeNull();
      if (!original) return;

      // Blow away the index file entirely — the scenario reindex exists for.
      const { indexPath } = await import("../src/hub/layout.js");
      await backend.delete(indexPath(pushed.projectId, machine.id));
      expect(await readMachineIndex(backend, pushed.projectId, machine.id)).toBeNull();

      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.projects).toEqual([
        { projectId: pushed.projectId, threads: 1, bundlesScanned: 1 },
      ]);
      expect(result.warnings).toEqual([]);

      const rebuilt = await readMachineIndex(backend, pushed.projectId, machine.id);
      expect(rebuilt).not.toBeNull();
      if (!rebuilt) return;
      expect(withoutUpdatedAt(rebuilt)).toEqual(withoutUpdatedAt(original));
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The "derivable indexes" invariant, extended to the LINK (spec §0b). Reindex
   * rebuilds bundle records from the bundles' own manifests, so it recovers
   * `anchorEntryUuid` for free — a rebuild does not silently unlink a hub.
   */
  it("recovers a continuation's anchor from the bundle manifest, so a rebuild keeps the chain", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const first = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      if (!first.success) return;

      const jsonlPath = join(
        configDir, "projects", encodeProjectPath(projectPath), `${sessionId}.jsonl`
      );
      const anchorUuid = continueSession(jsonlPath, sessionId, projectPath);
      const second = await hubPush({ configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81" });
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect(second.pushedSessions[0].type).toBe("continuation");

      const backend = createFsBackend(hub);
      const machine = loadOrCreateMachineId();
      const original = await readMachineIndex(backend, first.projectId, machine.id);
      expect(original).not.toBeNull();
      if (!original) return;
      expect(Object.values(original.threads)[0].bundles[1].anchorEntryUuid).toBe(anchorUuid);

      await backend.delete(indexPath(first.projectId, machine.id));
      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.warnings).toEqual([]);

      const rebuilt = await readMachineIndex(backend, first.projectId, machine.id);
      expect(rebuilt).not.toBeNull();
      if (!rebuilt) return;
      // Byte-for-byte the same index, links included — the invariant's own test.
      expect(withoutUpdatedAt(rebuilt)).toEqual(withoutUpdatedAt(original));
      const bundles = Object.values(rebuilt.threads)[0].bundles;
      expect(bundles.map((b) => b.type)).toEqual(["full", "continuation"]);
      expect(bundles[1].anchorEntryUuid).toBe(bundles[0].headEntryUuid);
      expect(bundles[0].anchorEntryUuid).toBeNull();
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The other half, and the one that decides whether the field could be a
   * redefinition of `fromEntryUuid` rather than an addition: reindex CANNOT
   * recover an anchor the manifest never carried. A bundle pushed before chain
   * assembly existed rebuilds with the key absent — "unknown", not "root" and
   * not "gap". Inventing a value here (say, copying `fromEntryUuid`, which is
   * right there in the same block) is what would manufacture a chain that looks
   * assembled and is not.
   */
  it("cannot invent an anchor a pre-assembly manifest never carried, and leaves the key absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const work = mkdtempSync(join(tmpdir(), "sesh-reindex-work-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const first = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      if (!first.success) return;
      const jsonlPath = join(
        configDir, "projects", encodeProjectPath(projectPath), `${sessionId}.jsonl`
      );
      continueSession(jsonlPath, sessionId, projectPath);
      const second = await hubPush({ configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81" });
      expect(second.success).toBe(true);
      if (!second.success) return;

      const backend = createFsBackend(hub);
      const machine = loadOrCreateMachineId();
      const original = await readMachineIndex(backend, first.projectId, machine.id);
      if (!original) throw new Error("no index after push");
      const contFile = Object.values(original.threads)[0].bundles[1].file;

      // Age the bundle: strip the anchor from its manifest, exactly as a
      // pre-0.9 exporter would have written it.
      let sawAnchor = false;
      await rewriteBundleManifest(hub, contFile, work, (m) => {
        for (const s of m.sessions) {
          if (s.continuation?.anchorEntryUuid !== undefined) sawAnchor = true;
          delete s.continuation?.anchorEntryUuid;
        }
      });
      expect(sawAnchor).toBe(true); // the mutation is real, not a no-op

      await backend.delete(indexPath(first.projectId, machine.id));
      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const rebuilt = await readMachineIndex(backend, first.projectId, machine.id);
      if (!rebuilt) throw new Error("no index after reindex");
      const bundles = Object.values(rebuilt.threads)[0].bundles;
      expect(bundles).toHaveLength(2);

      // The full bundle is unaffected — its anchor is null because there is no
      // anchor, which reindex derives from the manifest carrying no
      // continuation block at all.
      expect(bundles[0].anchorEntryUuid).toBeNull();
      // The aged continuation is UNLINKABLE, and says so by absence.
      expect("anchorEntryUuid" in bundles[1]).toBe(false);
      // ...and specifically was NOT healed from fromEntryUuid, which is still
      // sitting in the same manifest block.
      expect(bundles[1].fromEntryUuid).toBe("x-entry-4");
    } finally {
      restore.restore();
      for (const d of [home, hub, base, work]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("unlinked project returns an error suggesting push first", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      // Never linked (no push/--create-project ever ran against it) — the
      // path need not even exist; readLocalProjectId is a plain existsSync
      // check, same as hub-push's own unlinked test.
      const result = await hubReindex({
        configDir: join(home, ".claude"),
        projectPath: "/Users/testuser/Projects/testproject",
        hubPath: hub,
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/not linked/i);
      expect(result.suggestion).toMatch(/push/i);
    } finally {
      restore.restore();
      rmSync(home, { recursive: true, force: true });
      rmSync(hub, { recursive: true, force: true });
    }
  });

  it("carries forward a thread whose local session was deleted after being pushed", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const pushed = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(true);
      if (!pushed.success) return;

      const backend = createFsBackend(hub);
      const machine = loadOrCreateMachineId();
      const original = await readMachineIndex(backend, pushed.projectId, machine.id);
      expect(original).not.toBeNull();
      if (!original) return;
      const [threadId, originalEntry] = Object.entries(original.threads)[0];
      expect(originalEntry.localSessionId).toBe(sessionId);

      // The session that was just pushed no longer exists locally — the
      // realistic "moved on, deleted the old session" scenario a repair
      // reindex must survive.
      const realEncoded = encodeProjectPath(projectPath);
      rmSync(join(configDir, "projects", realEncoded, `${sessionId}.jsonl`), { force: true });

      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(true);
      if (!result.success) return;
      // Still one thread even though zero sessions are live locally now.
      expect(result.projects).toEqual([
        { projectId: pushed.projectId, threads: 1, bundlesScanned: 1 },
      ]);

      const rebuilt = await readMachineIndex(backend, pushed.projectId, machine.id);
      expect(rebuilt).not.toBeNull();
      if (!rebuilt) return;
      expect(rebuilt.threads[threadId]).toBeDefined();
      expect(rebuilt.threads[threadId].localSessionId).toBe(sessionId);
      expect(rebuilt.threads[threadId].bundles).toHaveLength(1);
      expect(rebuilt.threads[threadId].bundles[0].sessionIdInBundle).toBe(
        originalEntry.bundles[0].sessionIdInBundle
      );
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The executable half of reindex.ts's "Run push (with --create-project or
   * --project-id) to link and publish this project to the hub first." — the
   * sibling test above proves the refusal happens; this one proves the advice
   * is followable.
   *
   * The unlinked check is the very first thing `hubReindex` does: it returns
   * before the project lock, before the temp dir, before `registerMachine` and
   * before any hub read, so nothing is recorded and nothing is foreclosed. The
   * remedy names a DIFFERENT command (push), which is what makes it reachable
   * at all — and once that push has linked and published the project, the
   * identical reindex invocation rebuilds the index.
   *
   * Unlike the sibling refusal test this needs a REAL project directory, since
   * linking writes `.sesh-mover-project.json` under the project root.
   */
  it("refuses an unlinked project, and reindex works once push has linked it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      // Never linked — no push has run against this project yet.
      const refused = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(refused.success).toBe(false);
      if (refused.success) return;
      expect(refused.error).toMatch(/not linked/i);
      expect(refused.suggestion).toContain("--create-project");

      // Follow the advice: the flag belongs to push, not to reindex.
      const pushed = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(true);
      if (!pushed.success) return;

      // Drop the index the push wrote, so the re-run below has something to
      // rebuild and "succeeded" cannot mean "found the file already there".
      const backend = createFsBackend(hub);
      const machine = loadOrCreateMachineId();
      await backend.delete(indexPath(pushed.projectId, machine.id));
      expect(await readMachineIndex(backend, pushed.projectId, machine.id)).toBeNull();

      // The identical reindex invocation, now that the link exists.
      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.projects).toEqual([
        { projectId: pushed.projectId, threads: 1, bundlesScanned: 1 },
      ]);
      expect(result.warnings).toEqual([]);

      const rebuilt = await readMachineIndex(backend, pushed.projectId, machine.id);
      expect(rebuilt).not.toBeNull();
      if (!rebuilt) return;
      expect(rebuilt.projectId).toBe(pushed.projectId);
      expect(Object.keys(rebuilt.threads)).toHaveLength(1);
      expect(Object.values(rebuilt.threads)[0].bundles).toHaveLength(1);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});
