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
import { acquireProjectLock } from "../src/hub/lock.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { syncStatePath } from "../src/sync-state.js";
import { bundleDir } from "../src/hub/layout.js";
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
 * An UNTITLED session: a transcript with no `slug` on its first entry.
 *
 * That is the shape the index leak needed, and it is ordinary rather than
 * exotic. `discovery.ts` falls back to the session id for the slug, and
 * `extractSummaryFromFile` refuses a UUID slug, so the manifest summary for such
 * a session is an excerpt of the first user message — which is what the bundle
 * carries, and what a rebuild used to lift straight into a plaintext index file.
 */
const UNTITLED_ID = "770e8400-e29b-41d4-a716-446655440000";
const UNTITLED_SECRET = "SECRET help me reset my banking password";
function writeUntitledSession(configDir: string, projectPath: string): string {
  const jsonlPath = join(
    configDir, "projects", encodeProjectPath(projectPath), `${UNTITLED_ID}.jsonl`
  );
  writeFileSync(
    jsonlPath,
    [
      {
        uuid: "u-entry-1", timestamp: "2026-04-12T08:00:00Z", sessionId: UNTITLED_ID,
        cwd: projectPath, version: "2.1.81", gitBranch: "main", userType: "external",
        entrypoint: "cli", type: "user",
        message: { role: "user", content: UNTITLED_SECRET },
      },
      {
        uuid: "u-entry-2", parentUuid: "u-entry-1", timestamp: "2026-04-12T08:00:05Z",
        sessionId: UNTITLED_ID, cwd: projectPath, version: "2.1.81", type: "assistant",
        message: { model: "claude-opus-4-6", id: "msg_u", content: [{ type: "text", text: "Sure." }] },
      },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8"
  );
  return jsonlPath;
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
      // ...and the machine-readable half (#29). The two prose assertions above
      // are exactly what a reason code replaces: "wait for the other operation"
      // and "this project was never pushed" are two failures with nothing in
      // common, and regexing `error` was the only way to tell them apart.
      expect(result.reason).toBe("unlinked");
      expect(result.command).toBe("hub-reindex");
    } finally {
      restore.restore();
      rmSync(home, { recursive: true, force: true });
      rmSync(hub, { recursive: true, force: true });
    }
  });

  /**
   * The busy-lock refusal, and specifically the FIELDS it carries.
   *
   * `hub reindex` takes the same project lock push, pull and `hub unlink` take,
   * and `commands/hub-unlink.md` already names it as one of the operations that
   * can hold it — so this is a reachable branch, not a defensive one. It was the
   * only one of the four that answered with a bare `ErrorResult`: `LockBusyError`
   * carries `holderPid` and `ageMs`, its three siblings surface both, and this
   * arm discarded them. A caller deciding whether to wait needs exactly those
   * two, and cannot get them out of a prose string.
   */
  it("refuses with the shared lock-busy shape, holder fields intact, while another operation holds the lock", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const restore = overrideHome(home);
    let held: { release(): void } | null = null;
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      // Linked, but nothing pushed: the unlinked check runs BEFORE the lock, so
      // without a link this would refuse for the other reason entirely and the
      // lock branch would never be reached.
      writeLocalProjectId(projectPath, {
        projectId: "11111111-1111-4111-8111-111111111111",
        name: "realproj",
        createdAt: "2026-08-01T00:00:00Z",
        createdByMachine: "m1",
      });

      held = acquireProjectLock(projectPath);
      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.command).toBe("hub-reindex");
      expect(result.reason).toBe("lock-busy");
      // The two fields the old shape dropped on the floor.
      expect("holderPid" in result && result.holderPid).toBe(process.pid);
      expect("ageSeconds" in result && typeof result.ageSeconds).toBe("number");
      expect(result.error).toMatch(/lock/i);
    } finally {
      held?.release();
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The rebuild silently losing a bundle record — typed, because it is data
   * loss rather than advice.
   *
   * A bundle whose session has no thread mapping in this machine's sync-state
   * is dropped: the rebuilt index does not reference it, so no other machine
   * can see it. That was reported only inside a warning string, and
   * `skills/session-porter/SKILL.md` forbids branching on warning text — which
   * left no way to notice at all.
   */
  it("names dropped bundles in a typed field, not only in the warning prose", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const pushed = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(true);
      if (!pushed.success) return;

      // Lose the thread bookkeeping the way it is actually lost: the state file
      // is renamed aside when a plugin version doesn't recognize its schema, so
      // the bundle on the hub outlives the mapping that says which thread it is.
      rmSync(syncStatePath(projectPath), { force: true });

      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.droppedBundles).toHaveLength(1);
      expect(result.droppedBundles![0].sessionId).toBe(sessionId);
      expect(result.droppedBundles![0].file).toMatch(/\.tar\.gz$/);
      // The prose is still there — the field replaces the need to PARSE it, not
      // the warning itself.
      expect(result.warnings.some((w) => w.includes(sessionId))).toBe(true);
      // ...and the field is describing a real loss: the rebuilt index has no
      // threads at all now.
      expect(result.projects[0].threads).toBe(0);
      // Absent, not empty, when the other condition didn't happen.
      expect(result.unrecognizedBundleFiles).toBeUndefined();
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /** The sibling condition: a file in the bundle directory that isn't a bundle. */
  it("names an unparseable bundle file in a typed field", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const pushed = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(true);
      if (!pushed.success) return;

      const machine = loadOrCreateMachineId();
      // The shape a synced folder actually produces beside a real bundle.
      const stray = join(
        hub, bundleDir(pushed.projectId, machine.id), "notes (conflicted copy).tar.gz"
      );
      writeFileSync(stray, "not a bundle\n");

      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.unrecognizedBundleFiles).toHaveLength(1);
      expect(result.unrecognizedBundleFiles![0]).toContain("conflicted copy");
      expect(result.droppedBundles).toBeUndefined();
      // The real bundle beside it still rebuilt — one bad name is not a refusal.
      expect(result.projects[0].threads).toBe(1);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The third condition, and #72's reindex half: a bundle whose NAME parses but
   * whose manifest is not a sesh-mover manifest.
   *
   * Two things are asserted, because the fix has two halves that fail in
   * opposite directions. Without the manifest shape guard, `sessions: "abc"`
   * iterated three characters and reported three `droppedBundles` entries whose
   * `sessionId` is `undefined` — fabricated records in the field typed
   * specifically to disclose data loss. Without reindex's own try/catch, the
   * guard's throw would abort the whole rebuild, leaving the index lost, which
   * is the condition this command exists to end.
   */
  it("skips a bundle whose manifest is not ours instead of aborting the rebuild (#72)", async () => {
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
      const bundlesBefore = Object.values(original.threads)[0].bundles;
      expect(bundlesBefore).toHaveLength(2);
      const contFile = bundlesBefore[1].file;

      // Restamped by the real writer, so the digest is valid over the wrong
      // value — the manifest is internally consistent and simply not ours.
      await rewriteBundleManifest(hub, contFile, work, (m) => {
        (m as unknown as { sessions: unknown }).sessions = "abc";
      });

      await backend.delete(indexPath(first.projectId, machine.id));
      const result = await hubReindex({ configDir, projectPath, hubPath: hub });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.unrecognizedBundleFiles).toEqual([contFile]);
      // The fabrication: three `sessionId: undefined` records for a bundle that
      // declares no sessions at all.
      expect(result.droppedBundles).toBeUndefined();
      expect(result.warnings.some((w) => w.includes("no readable sesh-mover manifest"))).toBe(
        true
      );
      // The healthy bundle beside it still rebuilt, which is the half a plain
      // throw would have cost.
      expect(result.projects[0].bundlesScanned).toBe(2);
      const rebuilt = await readMachineIndex(backend, first.projectId, machine.id);
      if (!rebuilt) throw new Error("no index after reindex");
      expect(Object.values(rebuilt.threads)[0].bundles.map((b) => b.file)).toEqual([
        bundlesBefore[0].file,
      ]);
    } finally {
      restore.restore();
      for (const d of [home, hub, base, work]) rmSync(d, { recursive: true, force: true });
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
   * ...and it carries the SLUG forward, never a line of the conversation.
   *
   * The sibling test above proves the carry-forward happens; this one is about
   * what it carries. A vanished thread is rebuilt from its bundle MANIFEST,
   * which is the one place a real summary lives — up to 100 characters of the
   * first user message for an untitled session. That went into `index/<machine>.json`,
   * which is plaintext by design and readable by anything with access to the
   * shared hub directory. Worse, it stuck: the next ordinary push or pull read
   * the entry back as its own `priorIndex` and copied it forward, so nothing
   * self-healed.
   *
   * Asserted on the index file's BYTES, not just the field, because the entry is
   * spread wholesale (`{ ...entry }`) and a copy landing under some other key
   * would be the same disclosure.
   */
  it("carries the slug forward for a vanished thread, never the message excerpt", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-reindex-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-reindex-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-reindex-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      const untitledPath = writeUntitledSession(configDir, projectPath);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const pushed = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(true);
      if (!pushed.success) return;
      expect(pushed.pushedSessions).toHaveLength(2);

      // The untitled session is gone locally, so only the bundle manifest can
      // describe its thread — the `:165` path.
      rmSync(untitledPath, { force: true });

      const result = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(result.success).toBe(true);

      const backend = createFsBackend(hub);
      const machine = loadOrCreateMachineId();
      const rebuilt = await readMachineIndex(backend, pushed.projectId, machine.id);
      expect(rebuilt).not.toBeNull();
      if (!rebuilt) return;
      const vanished = Object.values(rebuilt.threads).find(
        (t) => t.localSessionId === UNTITLED_ID
      );
      expect(vanished).toBeDefined();
      expect(vanished!.slug).toBe(UNTITLED_ID);
      expect(vanished!.summary).toBe(UNTITLED_ID);
      const raw = readFileSync(join(hub, indexPath(pushed.projectId, machine.id)), "utf-8");
      expect(raw).not.toContain("SECRET");
      // The bundle itself still carries the excerpt in its manifest — that is a
      // separate decision (`export.noSummary`), and this test is about the index.
      expect(vanished!.bundles).toHaveLength(1);
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
      expect(refused.reason).toBe("unlinked");
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
