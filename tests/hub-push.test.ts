import { describe, it, expect } from "vitest";
import {
  mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, cpSync, existsSync, truncateSync,
  chmodSync, readdirSync, statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome, overridePath } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { readAllIndexes } from "../src/hub/index-file.js";
import { createFsBackend } from "../src/hub/backend.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { encodeProjectPath } from "../src/platform.js";
import { extractArchive } from "../src/archiver.js";
import { readSyncState } from "../src/sync-state.js";
import { WORKSPACE_MAX_BYTES } from "../src/payload/workspace.js";
import { acquireProjectLock } from "../src/hub/lock.js";
import { projectJsonFilePath } from "../src/paths.js";
import type { HubPushFailedResult, ProgressEvent } from "../src/types.js";

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

// Identity linking writes `.sesh-mover-project.json` under the real
// project directory (src/hub/identity.ts's writeLocalProjectId). The
// exporter/importer/migrator fixtures elsewhere in this suite get away with
// a purely virtual "/Users/testuser/Projects/testproject" projectPath
// because they never touch the real filesystem at that path — but hub
// identity does, and this sandbox can't write under a synthetic "/Users"
// root (no permission on "/"). So: create a REAL git-less directory and
// copy the fixture's session data into the config dir under ITS encoded
// name, then push using that real path. This is the same technique the
// brief spells out for the workspace-snapshot test, applied wherever a push
// actually needs to link project identity.
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

describe("hub push", () => {
  it("first push creates project, bundle, index; repeat push is up-to-date", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const first = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      if (!first.success) return;
      expect(first.pushedSessions).toHaveLength(1);
      expect(first.pushedSessions[0].type).toBe("full");
      expect(first.upToDate).toBe(false);

      const backend = createFsBackend(hub);
      const machine = loadOrCreateMachineId();
      const { indexes } = await readAllIndexes(backend, first.projectId);
      expect(indexes).toHaveLength(1);
      const thread = Object.values(indexes[0].threads)[0];
      expect(thread.bundles).toHaveLength(1);
      expect(await backend.exists(thread.bundles[0].file)).toBe(true);
      expect(indexes[0].machineId).toBe(machine.id);

      const second = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        claudeVersion: "2.1.81",
      });
      expect(second.success && second.success === true ? second.upToDate : false).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The index-record half of #35's anchor (spec §0b). A continuation record's
   * `anchorEntryUuid` must equal the `headEntryUuid` of the bundle it continues
   * — that equality is the ONLY thing a cross-machine chain walk can link on,
   * and `fromEntryUuid` cannot serve: it is the anchor's child in the
   * transcript, so a head-keyed map over it finds zero links on any real hub.
   *
   * Asserted on the record as it lands on the hub, not on the manifest, because
   * the record is what another machine reads.
   */
  it("a continuation record's anchor IS the previous bundle's head; a full record's is null", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
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

      // Carry on in the same session, then push the delta.
      const jsonlPath = join(
        configDir, "projects", encodeProjectPath(projectPath), `${sessionId}.jsonl`
      );
      const head = readFileSync(jsonlPath, "utf-8").split("\n").filter((l) => l !== "");
      const anchorUuid = (JSON.parse(head[head.length - 1]) as { uuid: string }).uuid;
      writeFileSync(
        jsonlPath,
        readFileSync(jsonlPath, "utf-8") +
          [
            {
              uuid: "x-entry-4", parentUuid: anchorUuid, timestamp: "2026-04-11T09:00:00Z",
              sessionId, cwd: projectPath, version: "2.1.81", type: "user",
              message: { role: "user", content: "one more thing" },
            },
            {
              uuid: "x-entry-5", parentUuid: "x-entry-4", timestamp: "2026-04-11T09:00:05Z",
              sessionId, cwd: projectPath, version: "2.1.81", type: "assistant",
              message: {
                model: "claude-opus-4-6", id: "msg_x",
                content: [{ type: "text", text: "Done." }],
              },
            },
          ].map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf-8"
      );

      const second = await hubPush({ configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81" });
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect(second.pushedSessions[0].type).toBe("continuation");

      const { indexes } = await readAllIndexes(createFsBackend(hub), first.projectId);
      const bundles = Object.values(indexes[0].threads)[0].bundles;
      expect(bundles.map((b) => b.type)).toEqual(["full", "continuation"]);

      // The link.
      expect(bundles[0].headEntryUuid).toBe(anchorUuid);
      expect(bundles[1].anchorEntryUuid).toBe(bundles[0].headEntryUuid);

      // A full bundle has no anchor, and says so EXPLICITLY — `null` present,
      // not the key missing. The missing key means "written before assembly
      // existed", which is a different fact and must stay distinguishable.
      expect(bundles[0].anchorEntryUuid).toBeNull();
      expect("anchorEntryUuid" in bundles[0]).toBe(true);
      expect("anchorEntryUuid" in bundles[1]).toBe(true);

      // fromEntryUuid keeps its own meaning: the first entry SHIPPED, one past
      // the anchor. Never equal, so the two fields cannot be conflated.
      expect(bundles[1].fromEntryUuid).toBe("x-entry-4");
      expect(bundles[1].fromEntryUuid).not.toBe(bundles[1].anchorEntryUuid);

      // And it survives the JSON round trip through the real index file, which
      // is where an `undefined` would silently disappear.
      const raw = JSON.parse(
        readFileSync(
          join(hub, "projects", first.projectId, "index", `${loadOrCreateMachineId().id}.json`),
          "utf-8"
        )
      ) as { threads: Record<string, { bundles: Array<Record<string, unknown>> }> };
      const rawBundles = Object.values(raw.threads)[0].bundles;
      expect(rawBundles[0].anchorEntryUuid).toBeNull();
      expect(rawBundles[1].anchorEntryUuid).toBe(anchorUuid);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * `--full` — the recovery escape hatch (Slice 3.5 §2.3/§3.7).
   *
   * **The point is the OUTCOME, not the ledger.** A hub that has lost the
   * ability to serve what it holds (bundles deleted by compaction; later,
   * bundles encrypted to a key that is gone) still has this machine recording
   * "the hub has you up to entry X", so the next push ships a delta anchored on
   * a base nobody can read — an unreconstructable thread for every other
   * machine. So the assertion that matters is that the same transcript, in the
   * same state, ships as a CONTINUATION carrying only the new entries without
   * the flag and as a FULL bundle carrying the whole history with it. Asserting
   * on `peers[hub].sent` alone would only pin the mechanism.
   *
   * Both directions are run here rather than split across two tests, because
   * "it shipped full" means nothing without the control that says it would
   * otherwise not have.
   */
  it("--full ships a whole bundle where the same state would otherwise ship a continuation", async () => {
    /** Push, extend the transcript, push again — with or without `--full`. */
    async function scenario(full: boolean): Promise<{
      secondType: string;
      shippedUuids: string[];
      fullResend: { forgottenSessions: number; forgottenMemoryDigest: boolean } | undefined;
      ledgerAfter: string | undefined;
    }> {
      const home = mkdtempSync(join(tmpdir(), "sesh-push-full-home-"));
      const hub = mkdtempSync(join(tmpdir(), "sesh-push-full-hub-"));
      const base = mkdtempSync(join(tmpdir(), "sesh-push-full-fix-"));
      const restore = overrideHome(home);
      try {
        const { configDir, sessionId } = createFixtureTree(base);
        const projectPath = createRealProject(base, configDir);
        await hubInit({ hubPath: hub, configScope: "user", cwd: home });

        const first = await hubPush({
          configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
        });
        if (!first.success) throw new Error(`first push failed: ${JSON.stringify(first)}`);

        const jsonlPath = join(
          configDir, "projects", encodeProjectPath(projectPath), `${sessionId}.jsonl`
        );
        const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter((l) => l !== "");
        const anchorUuid = (JSON.parse(lines[lines.length - 1]) as { uuid: string }).uuid;
        writeFileSync(
          jsonlPath,
          readFileSync(jsonlPath, "utf-8") +
            [
              {
                uuid: "x-entry-4", parentUuid: anchorUuid, timestamp: "2026-04-11T09:00:00Z",
                sessionId, cwd: projectPath, version: "2.1.81", type: "user",
                message: { role: "user", content: "one more thing" },
              },
              {
                uuid: "x-entry-5", parentUuid: "x-entry-4", timestamp: "2026-04-11T09:00:05Z",
                sessionId, cwd: projectPath, version: "2.1.81", type: "assistant",
                message: {
                  model: "claude-opus-4-6", id: "msg_x",
                  content: [{ type: "text", text: "Done." }],
                },
              },
            ].map((e) => JSON.stringify(e)).join("\n") + "\n",
          "utf-8"
        );

        const second = await hubPush({
          configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81", full,
        });
        if (!second.success) throw new Error(`second push failed: ${JSON.stringify(second)}`);

        // Read the bundle as it landed on the hub — what another machine sees.
        const backend = createFsBackend(hub);
        const { indexes } = await readAllIndexes(backend, first.projectId);
        const bundles = Object.values(indexes[0].threads)[0].bundles;
        expect(bundles).toHaveLength(2);
        const archiveTmp = join(base, "second.tar.gz");
        writeFileSync(archiveTmp, await backend.read(bundles[1].file));
        const extractDir = join(base, "second-extracted");
        mkdirSync(extractDir, { recursive: true });
        await extractArchive(archiveTmp, extractDir);
        const shipped = readFileSync(
          join(extractDir, "sessions", `${bundles[1].sessionIdInBundle}.jsonl`), "utf-8"
        );
        const shippedUuids = shipped
          .split("\n").filter((l) => l !== "")
          .map((l) => (JSON.parse(l) as { uuid?: string }).uuid)
          .filter((u): u is string => typeof u === "string");

        return {
          secondType: bundles[1].type,
          shippedUuids,
          fullResend: second.fullResend,
          ledgerAfter: readSyncState(projectPath).peers[
            `hub:${JSON.parse(readFileSync(join(hub, "hub.json"), "utf-8")).hubId}`
          ]?.sent[sessionId]?.headEntryUuid,
        };
      } finally {
        restore.restore();
        for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
      }
    }

    // Control: the ordinary push. A delta, carrying ONLY what came after the
    // hub's recorded head — the original three entries are not in it.
    const ordinary = await scenario(false);
    expect(ordinary.secondType).toBe("continuation");
    expect(ordinary.shippedUuids).toContain("x-entry-4");
    expect(ordinary.shippedUuids).toContain("x-entry-5");
    expect(ordinary.shippedUuids).not.toContain("entry-1");
    expect(ordinary.shippedUuids).not.toContain("entry-3");
    expect(ordinary.fullResend).toBeUndefined();

    // `--full`: the same state, the whole transcript, as a bundle that stands
    // on its own — which is the property key-loss recovery needs, since there
    // is no readable base for a delta to anchor on.
    const recovered = await scenario(true);
    expect(recovered.secondType).toBe("full");
    for (const u of ["entry-1", "entry-2", "entry-3", "x-entry-4", "x-entry-5"]) {
      expect(recovered.shippedUuids).toContain(u);
    }
    expect(recovered.fullResend?.forgottenSessions).toBe(1);

    // And the forget does not leave the ledger cleared: it is restamped from
    // the bundle that actually landed, so the NEXT push is incremental again.
    expect(recovered.ledgerAfter).toBe("x-entry-5");
    expect(ordinary.ledgerAfter).toBe("x-entry-5");
  });

  /**
   * The forget is applied to the push's IN-MEMORY state and never written, so a
   * `--full` push that dies before its bundle reaches the hub leaves the ledger
   * exactly as it found it. That is the conservative direction: the retry is
   * still a deliberate `--full` push, rather than a cleared ledger sitting
   * there waiting for whatever push happens next — which, with the default-on
   * SessionEnd auto-push, is an unattended full re-upload nobody asked for.
   *
   * Failed here by throwing from the progress callback during the export, which
   * is after the forget and before any hub write.
   */
  it("a --full push that fails before its bundle lands leaves the ledger on disk intact", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-fullfail-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-fullfail-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fullfail-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const first = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);

      const hubId = (JSON.parse(readFileSync(join(hub, "hub.json"), "utf-8")) as { hubId: string }).hubId;
      const before = readSyncState(projectPath).peers[`hub:${hubId}`].sent[sessionId];
      expect(before.headEntryUuid).toBe("entry-3");

      let threw = false;
      try {
        await hubPush({
          configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81", full: true,
          onProgress: (ev: ProgressEvent) => {
            if (ev.phase === "export-copy") throw new Error("boom");
          },
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      const after = readSyncState(projectPath).peers[`hub:${hubId}`].sent[sessionId];
      expect(after).toEqual(before);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * Linking IS the consent gate for the default-on automation: once
   * `.sesh-mover-project.json` exists, `evaluateHookGate` lets the
   * SessionEnd auto-push run, and for a git-less project that push uploads the
   * WHOLE working tree without reading .gitignore. So a push that FAILED must
   * not leave the project linked.
   *
   * Measured before this fix: `push --create-project` in a directory with no
   * sessions returned `{"success":false,"command":"export","error":"No sessions
   * found for this project"}` — the exporter's own result — while project.json
   * and the hub project had already been written. commands/push.md says report
   * and stop, so nothing disclosed the link, and the next session end uploaded
   * the tree, `.env` included.
   */
  it("a push that fails in the exporter leaves the project unlinked and says `push`", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-nolink-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-nolink-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-nolink-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      // A real directory with a `.env` in it and NO sessions in the config dir
      // — the shape a user lands in by running /sesh-mover:push from a fresh
      // scratch project.
      const sessionless = join(base, "sessionless");
      mkdirSync(sessionless, { recursive: true });
      writeFileSync(join(sessionless, ".env"), "DB_PASSWORD=hunter2\n");

      const r = await hubPush({
        configDir, projectPath: sessionless, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(r.success).toBe(false);
      if (r.success) return;
      // M1: every result is keyed by the command the user ran.
      expect(r.command).toBe("push");
      expect("error" in r && r.error).toContain("No sessions found");

      // Nothing local was linked...
      expect(existsSync(join(sessionless, ".sesh-mover-project.json"))).toBe(false);
      // ...and no hub project was minted for it either.
      expect(existsSync(join(hub, "projects"))).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("unlinked project with no candidates and no --create-project returns unlinked", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      // Identity resolution here is read-only (no --create-project, no
      // existing link) so the virtual fixture project path is fine — no
      // filesystem write is ever attempted against it.
      const r = await hubPush({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        hubPath: hub,
        claudeVersion: "2.1.81",
      });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect((r as { reason?: string }).reason).toBe("unlinked");
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The `unlinked` refusal advertises `--create-project` as the way forward, so
   * the retry it advises has to actually reach the push. That only holds
   * because the refusal happens BEFORE anything is written — no local link, no
   * hub project, no bundle — which is what makes the second call a clean first
   * push rather than a resume of a half-linked state. Asserting the advice
   * string alone would not catch a refusal that had already minted something.
   */
  it("refuses an unlinked project, and --create-project then links and pushes it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-relink-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-relink-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-relink-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      // A REAL directory (git-less, so no remote candidates) — the second call
      // links it for real, which writes `.sesh-mover-project.json` to disk.
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const args = {
        configDir,
        projectPath,
        hubPath: hub,
        claudeVersion: "2.1.81",
      } as const;

      const refused = await hubPush({ ...args });
      expect(refused.success).toBe(false);
      if (refused.success) return;
      expect(refused.command).toBe("push");
      expect((refused as { reason?: string }).reason).toBe("unlinked");
      // The advice itself: the flag the retry below actually passes.
      expect((refused as { suggestion?: string }).suggestion).toContain("--create-project");
      expect((refused as { linkCandidates?: unknown[] }).linkCandidates).toEqual([]);

      // The refusal wrote NOTHING — that is why the retry is a clean first push.
      expect(existsSync(projectJsonFilePath(projectPath))).toBe(false);
      expect(existsSync(join(hub, "projects"))).toBe(false);

      // Same invocation, plus the flag the refusal named.
      const retried = await hubPush({ ...args, createProject: true });
      expect(retried.success).toBe(true);
      if (!retried.success) return;
      expect(retried.pushedSessions).toHaveLength(1);
      expect(retried.pushedSessions[0].type).toBe("full");
      expect(retried.upToDate).toBe(false);

      // And it really linked + published, rather than merely reporting success.
      expect(existsSync(projectJsonFilePath(projectPath))).toBe(true);
      expect(
        (JSON.parse(readFileSync(projectJsonFilePath(projectPath), "utf-8")) as {
          projectId: string;
        }).projectId
      ).toBe(retried.projectId);
      const { indexes } = await readAllIndexes(createFsBackend(hub), retried.projectId);
      expect(indexes).toHaveLength(1);
      const bundles = Object.values(indexes[0].threads)[0].bundles;
      expect(bundles).toHaveLength(1);
      expect(await createFsBackend(hub).exists(bundles[0].file)).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("multi-session-id push bundles exactly the requested subset", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      const realEncoded = encodeProjectPath(projectPath);
      const idB = "660e8400-e29b-41d4-a716-446655440001";
      const idC = "660e8400-e29b-41d4-a716-446655440002";
      for (const [id, slug] of [
        [idB, "session-b"],
        [idC, "session-c"],
      ] as const) {
        writeFileSync(
          join(configDir, "projects", realEncoded, `${id}.jsonl`),
          JSON.stringify({
            uuid: `${slug}-e1`,
            timestamp: "2026-07-20T00:00:00Z",
            sessionId: id,
            cwd: projectPath,
            version: "2.1.81",
            slug,
            type: "user",
            message: { role: "user", content: `hello from ${slug}` },
          }) + "\n"
        );
      }
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const result = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        sessionIds: [sessionId, idB],
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.pushedSessions.map((s) => s.sessionId).sort()).toEqual(
        [sessionId, idB].sort()
      );

      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, result.projectId);
      const bundleFile = Object.values(indexes[0].threads).flatMap((t) => t.bundles)[0].file;
      const archiveTmp = join(base, "subset-bundle.tar.gz");
      writeFileSync(archiveTmp, await backend.read(bundleFile));
      const extractDir = join(base, "subset-extracted");
      mkdirSync(extractDir, { recursive: true });
      await extractArchive(archiveTmp, extractDir);

      const manifest = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf-8"));
      expect(manifest.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(
        [sessionId, idB].sort()
      );
      expect(existsSync(join(extractDir, "sessions", `${idC}.jsonl`))).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("empty sessionIds array behaves like undefined — pushes all, mints all threads", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      // [] is programmatically distinct from omitted but must behave
      // identically: not "mint zero threads yet export everything" (the bug
      // this guards against — see src/hub/push.ts's sessionIds normalization).
      const result = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        sessionIds: [],
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.pushedSessions.map((s) => s.sessionId)).toEqual([sessionId]);

      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, result.projectId);
      expect(indexes).toHaveLength(1);
      const threads = Object.values(indexes[0].threads);
      // One thread minted (for the one session), matching the pushed set —
      // not zero threads with a fully-exported bundle underneath.
      expect(threads).toHaveLength(1);
      expect(threads[0].bundles).toHaveLength(1);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("workspace snapshot included for non-git projects; manifest records it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const result = await hubPush({
        configDir,
        projectPath,
        hubPath: hub,
        createProject: true,
        claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.hasWorkspace).toBe(true);

      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, result.projectId);
      const thread = Object.values(indexes[0].threads)[0];
      const bundleFile = thread.bundles[0].file;

      const archiveTmp = join(base, "bundle.tar.gz");
      writeFileSync(archiveTmp, await backend.read(bundleFile));
      const extractDir = join(base, "extracted");
      mkdirSync(extractDir, { recursive: true });
      await extractArchive(archiveTmp, extractDir);

      const manifest = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf-8"));
      expect(manifest.workspace).toBeDefined();
      expect(manifest.workspace.fileCount).toBeGreaterThanOrEqual(1);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("hub push — git-diff carry", () => {
  function gitCommit(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  /** A real git project with a remote, one commit, and the fixture's sessions. */
  function makeCommittedGitProject(base: string, configDir: string): string {
    const projectPath = createRealProject(base, configDir);
    gitCommit(projectPath, ["init", "-q"]);
    gitCommit(projectPath, ["config", "user.email", "t@example.com"]);
    gitCommit(projectPath, ["config", "user.name", "Test"]);
    gitCommit(projectPath, ["remote", "add", "origin", "https://github.com/User/Repo.git"]);
    gitCommit(projectPath, ["add", "-A"]);
    gitCommit(projectPath, ["commit", "-q", "-m", "init"]);
    return projectPath;
  }

  async function pushAndExtract(
    prepare: (projectPath: string) => void,
    pushOverrides: Partial<Parameters<typeof hubPush>[0]> = {}
  ): Promise<{ result: Awaited<ReturnType<typeof hubPush>>; extractDir: string; cleanup: () => void }> {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    const cleanup = (): void => {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    };
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = makeCommittedGitProject(base, configDir);
      prepare(projectPath);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true,
        claudeVersion: "2.1.81", ...pushOverrides,
      });
      const extractDir = join(base, "extracted");
      if (result.success && "bundleId" in result && result.bundleId) {
        const backend = createFsBackend(hub);
        const { indexes } = await readAllIndexes(backend, result.projectId);
        const bundleFile = Object.values(indexes[0].threads)[0].bundles[0].file;
        const archiveTmp = join(base, "bundle.tar.gz");
        writeFileSync(archiveTmp, await backend.read(bundleFile));
        mkdirSync(extractDir, { recursive: true });
        await extractArchive(archiveTmp, extractDir);
      }
      return { result, extractDir, cleanup };
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  it("a dirty git project's bundle carries the patch, and the manifest records the base commit", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract((p) => {
      writeFileSync(join(p, "README.md"), "edited, uncommitted\n");
      writeFileSync(join(p, "scratch.txt"), "new work\n");
      // Names that survive git only because of `-z`; they then have to survive
      // the tar round trip too, which is where the payload actually travels.
      writeFileSync(join(p, "café note.txt"), "unicode\n");
    });
    try {
      expect(result.success).toBe(true);
      if (!result.success || !("carry" in result) || !result.carry) throw new Error("no carry");
      expect(result.hasWorkspace).toBe(false); // git remote: carry, not snapshot
      const manifest = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf-8"));
      expect(manifest.carry.baseCommit).toBe(result.carry.baseCommit);
      expect(manifest.carry.baseCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(readFileSync(join(extractDir, "carry", "changes.patch"), "utf-8")).toContain("README.md");
      expect(readFileSync(join(extractDir, "carry", "untracked", "scratch.txt"), "utf-8")).toBe("new work\n");
      // Every hub-linked project has an untracked .sesh-mover-project.json
      // by the time carry runs — identity linking writes it earlier in this very
      // push. Nothing about it is gitignored, so only the NEVER floor keeps the
      // plugin's own state (and the file that decides what the NEXT push ships)
      // out of the bundle.
      expect(existsSync(join(extractDir, "carry", "untracked", ".sesh-mover"))).toBe(false);
      expect(result.carry.untrackedCount).toBe(2);
      expect(readFileSync(join(extractDir, "carry", "untracked", "café note.txt"), "utf-8")).toBe("unicode\n");
    } finally {
      cleanup();
    }
  });

  it("carries nothing, and says nothing, for a clean git project", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract(() => {});
    try {
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect("carry" in result && result.carry).toBeFalsy();
      expect(existsSync(join(extractDir, "carry"))).toBe(false);
      expect(result.warnings.some((w) => w.includes("carr"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("--no-carry leaves uncommitted work at home", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract(
      (p) => { writeFileSync(join(p, "scratch.txt"), "new work\n"); },
      { noCarry: true }
    );
    try {
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect("carry" in result && result.carry).toBeFalsy();
      expect(existsSync(join(extractDir, "carry"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("names the gitignored files the include list sent to the hub, in the warnings", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract((p) => {
      writeFileSync(join(p, ".gitignore"), "docs/\nsecret.env\n");
      mkdirSync(join(p, "docs"), { recursive: true });
      writeFileSync(join(p, "docs", "spec.md"), "# spec\n");
      writeFileSync(join(p, "secret.env"), "TOKEN=1\n");
      mkdirSync(join(p, ".sesh-mover"), { recursive: true });
      writeFileSync(join(p, ".sesh-mover-include"), "docs/\n");
    });
    try {
      expect(result.success).toBe(true);
      if (!result.success || !("carry" in result) || !result.carry) throw new Error("no carry");
      expect(result.carry.reIncluded).toEqual(["docs/spec.md"]);
      expect(result.warnings.some((w) => w.includes("docs/spec.md") && w.includes("sesh-mover-include"))).toBe(true);
      expect(existsSync(join(extractDir, "carry", "untracked", "docs", "spec.md"))).toBe(true);
      expect(existsSync(join(extractDir, "carry", "untracked", "secret.env"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("names the gitignored files git TRACKS separately, with the remedy that actually works", async () => {
    const { result, extractDir, cleanup } = await pushAndExtract((p) => {
      // Committed first, gitignored after — the common shape, and the one the
      // "gitignored files never travel" wording used to hide. The include list never
      // touched it, so "remove the include-list line" is not the remedy.
      writeFileSync(join(p, ".env"), "DB_PASSWORD=old\n");
      execFileSync("git", ["add", ".env"], { cwd: p, stdio: "ignore" });
      execFileSync("git", ["commit", "-q", "-m", "oops"], { cwd: p, stdio: "ignore" });
      writeFileSync(join(p, ".gitignore"), ".env\n");
      execFileSync("git", ["add", ".gitignore"], { cwd: p, stdio: "ignore" });
      execFileSync("git", ["commit", "-q", "-m", "ignore it"], { cwd: p, stdio: "ignore" });
      writeFileSync(join(p, ".env"), "DB_PASSWORD=hunter2_NEW\n");
    });
    try {
      expect(result.success).toBe(true);
      if (!result.success || !("carry" in result) || !result.carry) throw new Error("no carry");
      expect(result.carry.trackedIgnored).toEqual([".env"]);
      expect(result.carry.reIncludedCount).toBe(0);
      const warning = result.warnings.find((w) => w.includes(".env"));
      expect(warning).toBeDefined();
      expect(warning).toContain("git rm --cached");
      expect(warning).not.toContain("sesh-mover-include");
      // And it really is on the hub, in the bundle that just left the machine.
      expect(readFileSync(join(extractDir, "carry", "changes.patch"), "utf-8"))
        .toContain("+DB_PASSWORD=hunter2_NEW");
    } finally {
      cleanup();
    }
  });

  it("warns, without failing the push, when the carry busts the budget", async () => {
    // An explicit small budget rather than 6 MB against the default: since the
    // default is 50 MB, materializing enough bytes to bust it would cost every
    // run of this suite 50 MB of I/O to exercise one comparison. This is also
    // the path a user's `hub.carryMaxMb` takes to get here.
    const { result, extractDir, cleanup } = await pushAndExtract(
      (p) => {
        writeFileSync(join(p, "huge.bin"), "x".repeat(256 * 1024));
      },
      { budgets: { carryMaxBytes: 64 * 1024, workspaceMaxBytes: 50 * 1024 * 1024, warnings: [] } }
    );
    try {
      expect(result.success).toBe(true);
      if (!result.success) return;
      // The sessions still push — the bundle is the point of the operation.
      expect(result.pushedSessions.length).toBeGreaterThan(0);
      expect("carry" in result && result.carry).toBeFalsy();
      expect(existsSync(join(extractDir, "carry"))).toBe(false);
      const warning = result.warnings.find((w) => w.includes("not carried"));
      expect(warning).toBeDefined();
      expect(warning).toContain("huge.bin");
      // The remedy has to be honest: this push already recorded its sessions as
      // sent, so an immediate re-push is "nothing to push" and the fixed carry
      // rides the NEXT push that has session content.
      expect(warning).toContain("next push");
    } finally {
      cleanup();
    }
  });

  // The whole-branch review's Critical 2. Which payload a push builds is decided
  // by asking git for this project's remotes, and "I could not ask" used to be
  // indistinguishable from "there are none" — the answer that uploads the entire
  // working tree, .gitignore not consulted, from an unattended hook.
  describe("payload routing when git's answer is not a plain yes/no", () => {
    it("a remote sesh-mover cannot canonicalize takes the CARRY path, not a whole-tree snapshot", async () => {
      const { result, extractDir, cleanup } = await pushAndExtract((p) => {
        // An ordinary self-hosted server: no dot in the host, so
        // normalizeGitRemote returns null and the project used to reclassify
        // as remote-less.
        gitCommit(p, ["remote", "set-url", "origin", "git@gitserver:team/repo.git"]);
        writeFileSync(join(p, ".gitignore"), ".env\n");
        writeFileSync(join(p, ".env"), "DB_PASSWORD=hunter2\n");
        writeFileSync(join(p, "README.md"), "edited, uncommitted\n");
      });
      try {
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.hasWorkspace).toBe(false);
        expect(existsSync(join(extractDir, "workspace"))).toBe(false);
        expect("carry" in result && result.carry).toBeTruthy();
        // The secret .gitignore is there to protect never leaves the machine.
        expect(existsSync(join(extractDir, "carry", "untracked", ".env"))).toBe(false);
        expect(readFileSync(join(extractDir, "carry", "changes.patch"), "utf-8")).not.toContain(
          "hunter2"
        );
      } finally {
        cleanup();
      }
    });

    it("git that cannot be run inside a repository builds NEITHER payload and says so", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
      const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
      const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
      const restore = overrideHome(home);
      const emptyBin = mkdtempSync(join(tmpdir(), "sesh-push-nobin-"));
      try {
        const { configDir } = createFixtureTree(base);
        const projectPath = makeCommittedGitProject(base, configDir);
        writeFileSync(join(projectPath, ".gitignore"), ".env\n");
        writeFileSync(join(projectPath, ".env"), "DB_PASSWORD=hunter2\n");
        await hubInit({ hubPath: hub, configScope: "user", cwd: home });

        // The SessionEnd hook's actual hazard: a detached process with a PATH
        // that has no git on it, in a project that very much has a remote.
        const path = overridePath(emptyBin);
        let result;
        try {
          result = await hubPush({
            configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
          });
        } finally {
          path.restore();
        }
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.hasWorkspace).toBe(false);
        expect("carry" in result && result.carry).toBeFalsy();
        expect(result.warnings.join(" ")).toMatch(/could not be established/);

        // ...and the bundle proves it: sessions only.
        const backend = createFsBackend(hub);
        const { indexes } = await readAllIndexes(backend, result.projectId);
        const bundleFile = Object.values(indexes[0].threads)[0].bundles[0].file;
        const archiveTmp = join(base, "bundle.tar.gz");
        writeFileSync(archiveTmp, await backend.read(bundleFile));
        const extractDir = join(base, "extracted-nogit");
        mkdirSync(extractDir, { recursive: true });
        await extractArchive(archiveTmp, extractDir);
        expect(existsSync(join(extractDir, "workspace"))).toBe(false);
        expect(existsSync(join(extractDir, "carry"))).toBe(false);
        expect(existsSync(join(extractDir, "sessions"))).toBe(true);
      } finally {
        restore.restore();
        for (const d of [home, hub, base, emptyBin]) rmSync(d, { recursive: true, force: true });
      }
    });

    it("a genuinely git-less project still gets its workspace snapshot with no git on PATH", async () => {
      // The false-positive control for the refusal above: the case the snapshot
      // exists for must not become collateral damage.
      const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
      const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
      const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
      const restore = overrideHome(home);
      const emptyBin = mkdtempSync(join(tmpdir(), "sesh-push-nobin2-"));
      try {
        const { configDir } = createFixtureTree(base);
        const projectPath = createRealProject(base, configDir);
        await hubInit({ hubPath: hub, configScope: "user", cwd: home });
        const path = overridePath(emptyBin);
        let result;
        try {
          result = await hubPush({
            configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
          });
        } finally {
          path.restore();
        }
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.hasWorkspace).toBe(true);
        expect(result.warnings.join(" ")).not.toMatch(/could not be established/);
      } finally {
        restore.restore();
        for (const d of [home, hub, base, emptyBin]) rmSync(d, { recursive: true, force: true });
      }
    });
  });
});

describe("hub push — ignoredNotCarried discovery aid", () => {
  // A git project's payload ships tracked/untracked-but-not-ignored files only
  // (Task 10 builds it); .gitignore is also where .env lives, so an ignored
  // path never travels unless the include list names it. This field is how a user
  // finds out the mechanism exists — it names what stayed behind.
  function makeGitProject(base: string, configDir: string, ignoreBody: string): string {
    const projectPath = createRealProject(base, configDir);
    execFileSync("git", ["init", "-q"], { cwd: projectPath, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/User/Repo.git"], {
      cwd: projectPath, stdio: "ignore",
    });
    writeFileSync(join(projectPath, ".gitignore"), ignoreBody);
    return projectPath;
  }

  async function pushIgnoreFixture(
    ignoreBody: string,
    prepare: (projectPath: string) => void,
    pushOverrides: Partial<Parameters<typeof hubPush>[0]> = {}
  ): Promise<string[] | undefined> {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = makeGitProject(base, configDir, ignoreBody);
      prepare(projectPath);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true,
        claudeVersion: "2.1.81", ...pushOverrides,
      });
      expect(result.success).toBe(true);
      if (!result.success) return undefined;
      expect(result.hasWorkspace).toBe(false); // git remote present: no snapshot
      return result.ignoredNotCarried;
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  }

  it("reports top-level ignored paths not carried when the include list is absent", async () => {
    const reported = await pushIgnoreFixture("docs/\nnode_modules/\nsecret.env\n", (p) => {
      mkdirSync(join(p, "docs", "specs"), { recursive: true });
      mkdirSync(join(p, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(p, "docs", "specs", "design.md"), "spec\n");
      writeFileSync(join(p, "node_modules", "pkg", "index.js"), "dep\n");
      writeFileSync(join(p, "secret.env"), "TOKEN=1\n");
    });
    expect(reported).toBeDefined();
    expect(reported).toContain("docs/");
    expect(reported).toContain("node_modules/");
    expect(reported).toContain("secret.env");
  });

  it("omits ignoredNotCarried once an include list exists", async () => {
    const reported = await pushIgnoreFixture("docs/\n", (p) => {
      mkdirSync(join(p, "docs"), { recursive: true });
      writeFileSync(join(p, "docs", "design.md"), "spec\n");
      // Present but empty of patterns: the user has already met the mechanism,
      // so the discovery aid has done its job and must stop nagging.
      mkdirSync(join(p, ".sesh-mover"), { recursive: true });
      writeFileSync(join(p, ".sesh-mover-include"), "# nothing yet\n");
    });
    expect(reported).toBeUndefined();
  });

  it("stays silent for the auto-push hook (quiet)", async () => {
    const reported = await pushIgnoreFixture("docs/\n", (p) => {
      mkdirSync(join(p, "docs"), { recursive: true });
      writeFileSync(join(p, "docs", "design.md"), "spec\n");
    }, { quiet: true });
    expect(reported).toBeUndefined();
  });

  it("caps the report at 10 paths and never names plugin or VCS internals", async () => {
    const reported = await pushIgnoreFixture(
      Array.from({ length: 14 }, (_, i) => `ig${i}/`).join("\n") + "\n.sesh-mover/\n",
      (p) => {
        for (let i = 0; i < 14; i++) {
          mkdirSync(join(p, `ig${i}`), { recursive: true });
          writeFileSync(join(p, `ig${i}`, "f.txt"), "x\n");
        }
      }
    );
    expect(reported).toHaveLength(10);
    expect(reported!.some((p) => p.startsWith(".sesh-mover"))).toBe(false);
  });

  it("an over-budget workspace pushes the sessions, declares no payload, and records NO generation", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      // Sparse where the filesystem supports it: statSync reports the full size
      // without the test writing 51 MB of zeros.
      const huge = join(projectPath, "huge.bin");
      writeFileSync(huge, "");
      truncateSync(huge, WORKSPACE_MAX_BYTES + 1024 * 1024);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.pushedSessions.length).toBeGreaterThan(0); // sessions still travel
      expect(result.hasWorkspace).toBe(false);
      expect(result.warnings.some((w) => w.includes("snapshot budget"))).toBe(true);

      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, result.projectId);
      const bundleFile = Object.values(indexes[0].threads)[0].bundles[0].file;
      const archiveTmp = join(base, "bundle.tar.gz");
      writeFileSync(archiveTmp, await backend.read(bundleFile));
      const extractDir = join(base, "extracted");
      mkdirSync(extractDir, { recursive: true });
      await extractArchive(archiveTmp, extractDir);
      const manifest = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf-8"));
      expect(manifest.workspace).toBeUndefined();
      expect(existsSync(join(extractDir, "workspace"))).toBe(false);

      // The load-bearing half: recording a generation the hub never received
      // makes the next 3-way merge read the whole un-sent tree as "deleted
      // here" (design §5.2, Task 8's ancestor rule).
      const state = readSyncState(projectPath);
      expect(state.hub?.lastWorkspace).toBeUndefined();
      expect(state.hub?.workspaceGenerations ?? []).toEqual([]);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });


  it("is absent for a project with no git remote (its files travel as a workspace snapshot)", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.hasWorkspace).toBe(true);
      expect(result.ignoredNotCarried).toBeUndefined();
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});

/**
 * The other half of "a failed push must not leave the project linked".
 *
 * Deferring the identity write past the export only covers failures UP TO that
 * point. Everything after it — the archive, the bundle upload, the index write,
 * an unreadable file the workspace snapshot trips over — used to surface as a
 * bare thrown Error with `.sesh-mover-project.json` sitting in the project
 * directory, which is precisely what arms the default-on SessionEnd auto-push:
 * the next session end then uploads the whole working tree of a push the user
 * watched fail.
 *
 * Reproduced before that fix, twice, exactly as these tests inject it:
 * `ENOTDIR` when the bundle's parent directory path on the hub is already a
 * FILE, and `EACCES` inside the workspace snapshot. Both threw; both left
 * project.json behind.
 *
 * The local link is now committed at only two points, both of them AFTER this
 * push has delivered something: the up-to-date early return, and the moment the
 * bundle lands on the hub. So the two shapes above no longer write a link at
 * all — the strongest possible version of the guarantee — and the tests below
 * split accordingly: a failure BEFORE the bundle lands must leave nothing, a
 * failure AFTER it must roll the link back, and either way the result says
 * which in FIELDS (`linked`, `linkRolledBack`, `orphanHubProjectId`,
 * `orphanBundle`) rather than only in prose. The fields are what the unattended
 * SessionEnd push records; `recordAutoPushOutcome` never reads `details`.
 *
 * The hub half is NOT closed here and cannot be: nothing in src/ deletes a hub
 * file, so a `--create-project` push that fails afterwards leaves a hub project
 * nothing can remove. That one is reported instead — with the flag that links
 * to it rather than minting a second.
 */
describe("hub push — a failure after the identity is resolved", () => {
  const PROJECT_ID = "11111111-2222-3333-4444-555555555555";

  /** A hub project some other machine created, ready to be linked to. */
  function seedHubProject(hub: string, projectId = PROJECT_ID): string {
    mkdirSync(join(hub, "projects", projectId), { recursive: true });
    writeFileSync(
      join(hub, "projects", projectId, "project.json"),
      JSON.stringify({
        schemaVersion: 1, projectId, name: "seeded", matchers: { gitRemotes: [] },
        createdAt: "2026-07-01T00:00:00.000Z", createdByMachine: "some-other-machine",
      }, null, 2) + "\n"
    );
    return projectId;
  }

  /**
   * Make the bundle undeliverable: `writeStreamAtomic` mkdir's the bundle
   * directory, and a FILE already sitting at that path is an ENOTDIR the push
   * cannot route around. Chosen over a permission bit because it behaves the
   * same on every platform and says nothing about the user running the suite.
   */
  function blockBundleDir(hub: string, projectId = PROJECT_ID): void {
    writeFileSync(join(hub, "projects", projectId, "bundles"), "not a directory\n");
  }

  /**
   * The same trick one step later: the bundle uploads fine and the INDEX write
   * behind it fails. This is the only injectable failure that lands past the
   * link commit, so it is the arrangement every rollback assertion in this
   * block is built on.
   *
   * **It is an `EEXIST`, not an `ENOTDIR`** — MEASURED, and the difference from
   * `blockBundleDir` above is structural rather than incidental. `writeAtomic`
   * mkdirs `dirname(relPath)`, so for `index/<machineId>.json` the blocked path
   * IS the directory being created and POSIX `mkdir` on an existing name
   * answers `EEXIST: file already exists, mkdir '<hub>/projects/<id>/index'`;
   * for `bundles/<machineId>/<file>` the blocked name is a PARENT COMPONENT of
   * it, which is the only shape that answers `ENOTDIR`. That is why the two
   * assertions in this block read `/EEXIST|ENOTDIR/` while `blockBundleDir`'s
   * reads `/ENOTDIR|not a directory/`.
   */
  function blockIndexDir(hub: string, projectId = PROJECT_ID): void {
    writeFileSync(join(hub, "projects", projectId, "index"), "not a directory\n");
  }

  const linkPath = (projectPath: string): string =>
    join(projectPath, ".sesh-mover-project.json");

  /**
   * Narrow to the structured failure, asserting the discriminator on the way —
   * so a cast can never quietly pass over a result that lost its shape.
   */
  function asFailed(r: Awaited<ReturnType<typeof hubPush>>): HubPushFailedResult {
    expect(r.success).toBe(false);
    expect("reason" in r && r.reason).toBe("failed-after-link");
    return r as HubPushFailedResult;
  }

  it("writes no link at all when the failure lands before the bundle does", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-rb-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-rb-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-rb-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);
      blockBundleDir(hub);
      expect(existsSync(linkPath(projectPath))).toBe(false);

      const r = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });

      // Typed refusal, not a thrown Error: the one thing the user has to be
      // told — whether this project is linked now — is not in an exception,
      // and a throw would also skip `recordAutoPushOutcome` entirely, so an
      // unattended push's failure would leave no trace anywhere.
      const f = asFailed(r);
      expect(f.command).toBe("push");
      expect(f.error).toMatch(/ENOTDIR|not a directory/);
      expect(f.details).toMatch(/NOT linked/);

      // The consent gate was never opened: the bundle never landed, so the
      // link was never written and there was nothing to roll back. This is
      // stronger than the write-then-remove it replaced — an interrupted
      // process (SIGKILL between the two) cannot leave a link behind either.
      expect(f.linked).toBe(false);
      expect(f.linkRolledBack).toBe(false);
      expect(f.orphanBundle).toBe(false);
      expect(f.orphanHubProjectId).toBeNull();
      expect(f.projectId).toBe(PROJECT_ID);
      expect(existsSync(linkPath(projectPath))).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("removes only the link it wrote, leaving the user's own files beside it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-rb2-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-rb2-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-rb2-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      // The user's own files, written long before this push. All four are
      // siblings of the link file (0.8.0 root dotfiles), which is exactly why
      // the rollback may only ever name ONE path.
      mkdirSync(join(projectPath, ".sesh-mover"), { recursive: true });
      writeFileSync(join(projectPath, ".sesh-mover", "config.json"), "{}\n");
      writeFileSync(join(projectPath, ".sesh-mover-ignore"), "build/\n");
      writeFileSync(join(projectPath, ".sesh-mover-include"), "docs/\n");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);
      // Past the bundle upload, so a link really is written and really is
      // rolled back — the pre-bundle shape above never writes one.
      blockIndexDir(hub);

      const r = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      const f = asFailed(r);
      expect(f.linked).toBe(false);
      expect(f.linkRolledBack).toBe(true);
      expect(existsSync(linkPath(projectPath))).toBe(false);
      expect(readFileSync(join(projectPath, ".sesh-mover-ignore"), "utf-8")).toBe("build/\n");
      expect(readFileSync(join(projectPath, ".sesh-mover-include"), "utf-8")).toBe("docs/\n");
      expect(readFileSync(join(projectPath, ".sesh-mover", "config.json"), "utf-8")).toBe("{}\n");
      expect(existsSync(join(projectPath, "README.md"))).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * THE REGRESSION THIS BLOCK FAILED TO CATCH.
   *
   * The rollback used to `rmdirSync(dirname(link))` after removing the link,
   * and that was safe on the day it was written: the link lived at
   * `<project>/.claude-sesh-mover/project.json`, so the parent was a directory
   * the plugin owned. Since 0.8.0 the link is the root dotfile
   * `<project>/.sesh-mover-project.json` and the parent is THE USER'S PROJECT
   * DIRECTORY. `rmdirSync` succeeds on an empty directory, so a failed push
   * into a directory holding nothing else deleted the directory it was asked to
   * push — reachable from `push --project-path <empty-dir>`, since push never
   * requires the directory to exist and the link write mkdir's it.
   *
   * The assertion that should have caught it was vacuous: it checked that a
   * `.sesh-mover` directory the fixture never created was absent. This one
   * fails against the old code.
   */
  it("never removes the project directory itself, even when the link was its only file", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-rmdir-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-rmdir-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-rmdir-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      // Deliberately NOT createRealProject: that plants a README.md, which
      // would keep the directory non-empty and make the rmdir fail on its own.
      const projectPath = join(base, "emptyproj");
      mkdirSync(projectPath, { recursive: true });
      cpSync(
        join(configDir, "projects", FIXTURE_ENCODED),
        join(configDir, "projects", encodeProjectPath(projectPath)),
        { recursive: true }
      );
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);
      blockIndexDir(hub);

      const r = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      const f = asFailed(r);
      // The link was written (the bundle landed) and rolled back...
      expect(f.linkRolledBack).toBe(true);
      expect(existsSync(linkPath(projectPath))).toBe(false);
      // ...and the now-empty directory it lived in is still there.
      expect(existsSync(projectPath)).toBe(true);
      expect(statSync(projectPath).isDirectory()).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("a link that pre-dates the push survives the failure, and the result says so", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-keep-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-keep-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-keep-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);
      // Linked before this push ever ran — committed to the repo, in the real
      // flow. A failure of OURS is not licence to delete it.
      mkdirSync(join(projectPath, ".sesh-mover"), { recursive: true });
      const preExisting = JSON.stringify({
        projectId: PROJECT_ID, name: "seeded",
        createdAt: "2026-07-01T00:00:00.000Z", createdByMachine: "some-other-machine",
      }, null, 2) + "\n";
      writeFileSync(linkPath(projectPath), preExisting);
      blockBundleDir(hub);

      const r = await hubPush({ configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81" });
      const f = asFailed(r);
      expect(f.command).toBe("push");
      expect(f.details).toMatch(/already linked/);
      expect(f.details).toMatch(/stays linked/);
      // The disclosure that matters: this directory is linked RIGHT NOW, so
      // the SessionEnd auto-push is armed for it and will run again unattended.
      // Nothing was rolled back, because nothing here was ours to undo.
      expect(f.linked).toBe(true);
      expect(f.linkRolledBack).toBe(false);
      expect(f.projectId).toBe(PROJECT_ID);
      expect(readFileSync(linkPath(projectPath), "utf-8")).toBe(preExisting);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("names the hub project a failed --create-project left behind, and how to link to it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-orph-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-orph-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-orph-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      // `--create-project` mints a hub project id nobody can predict, so the
      // fault has to sit outside the hub: an unreadable file the workspace
      // snapshot's copy pass trips over (EACCES), which is the second shape the
      // reviewer reproduced. Mode bits say nothing when the suite runs as root.
      const locked = join(projectPath, "locked.txt");
      writeFileSync(locked, "nope\n");
      chmodSync(locked, 0o000);
      let enforced = false;
      try { readFileSync(locked); } catch { enforced = true; }
      if (!enforced) { chmodSync(locked, 0o644); return; }

      let r;
      try {
        r = await hubPush({
          configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
        });
      } finally {
        chmodSync(locked, 0o644); // so the temp tree can be cleaned up
      }

      const f = asFailed(r);
      expect(f.command).toBe("push");
      expect(f.error).toMatch(/EACCES|permission denied/);
      expect(existsSync(linkPath(projectPath))).toBe(false);

      // The half that cannot be rolled back: the hub project exists and nothing
      // removes it. It has to be named, with the flag that links to that one
      // rather than minting a second on the next attempt.
      const orphans = readdirSync(join(hub, "projects"));
      expect(orphans).toHaveLength(1);
      expect(f.suggestion).toContain(`--project-id ${orphans[0]}`);
      expect(f.details).toMatch(/NOT linked/);
      // As a field, not just as prose: this is the one thing a caller has to be
      // able to act on, and the id is unguessable. It is recorded the instant
      // the HUB file lands — a throw between that write and the local one used
      // to leave nothing recorded at all, so the orphan went unmentioned.
      expect(f.orphanHubProjectId).toBe(orphans[0]);
      expect(f.projectId).toBe(orphans[0]);
      expect(f.linked).toBe(false);
      expect(f.linkRolledBack).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("discloses a bundle that reached the hub before the index write failed", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-idx-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-idx-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-idx-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);
      // Bundle upload fine; the index write behind it is the EEXIST (see
      // `blockIndexDir` for why it is that and not an ENOTDIR). The bundle is
      // atomic, so it really is on the hub when this throws.
      blockIndexDir(hub);

      const r = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      const f = asFailed(r);
      expect(existsSync(linkPath(projectPath))).toBe(false);
      expect(f.details).toMatch(/did reach the hub/);
      expect(f.orphanBundle).toBe(true);
      // This is the one window where a link IS written before the failure, so
      // it is also the only place the rollback itself is exercised.
      expect(f.linked).toBe(false);
      expect(f.linkRolledBack).toBe(true);
      // ...and it is really there, unreferenced by any index.
      expect(
        readdirSync(join(hub, "projects", PROJECT_ID, "bundles"), { recursive: true }).length
      ).toBeGreaterThan(0);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("the up-to-date no-op push still links the project", async () => {
    // The deliberate exception the deferral must not swallow, and the reason
    // `commitLocalLink` has TWO call sites: this push has nothing to send, so
    // it never reaches the bundle upload the other call site sits behind, yet
    // it is a successful push whose projectId is part of the result. A user who
    // lost the committed .sesh-mover-project.json gets it back from a no-op
    // push, and deferring past this point would take that away.
    const home = mkdtempSync(join(tmpdir(), "sesh-push-utd-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-utd-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-utd-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);

      const first = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      // Unlink it again — project.json is a committed file a user can lose, and
      // the re-link on an otherwise no-op push is what puts it back.
      rmSync(linkPath(projectPath), { force: true });

      const second = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect(second.upToDate).toBe(true);
      expect(existsSync(linkPath(projectPath))).toBe(true);
      expect(JSON.parse(readFileSync(linkPath(projectPath), "utf-8")).projectId).toBe(PROJECT_ID);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * A rollback the push REFUSES to perform, and the only shape that reports
   * `linked: true` after a link this push wrote.
   *
   * `rollbackLocalLink` re-reads the file before removing it: it is ours to
   * delete only while it still names the project id we wrote. Anything else
   * means something changed it underneath us — a concurrent pull, another push,
   * the user — and a link someone else put there is not collateral for our
   * failure. The user must then be told the truth, which is the uncomfortable
   * one: this directory IS linked and the SessionEnd auto-push IS armed.
   *
   * Arranged with the caller's own progress callback because that is the only
   * hook this module offers between the link write and a failure: on the
   * up-to-date path the link is committed immediately before the final progress
   * event, so a callback that rewrites the file and then throws reproduces the
   * concurrent-modification race deterministically, with no mocks and no
   * timing. It doubles as coverage that a throwing caller callback cannot leave
   * the link state undisclosed.
   */
  it("refuses to remove a link that now names a different project, and says the project IS linked", async () => {
    const OTHER_ID = "99999999-8888-7777-6666-555555555555";
    const home = mkdtempSync(join(tmpdir(), "sesh-push-refuse-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-refuse-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-refuse-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      seedHubProject(hub);

      const first = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      rmSync(linkPath(projectPath), { force: true }); // so the next push re-links

      const stolen = JSON.stringify({
        projectId: OTHER_ID, name: "someone else's link",
        createdAt: "2026-07-02T00:00:00.000Z", createdByMachine: "another-machine",
      }, null, 2) + "\n";
      const r = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
        onProgress: (ev) => {
          // The final hub-push event: emitted on the up-to-date path AFTER the
          // link has been committed. Earlier events (percent 0, and the
          // exporter's own phases) must not trigger this.
          if (ev.phase !== "hub-push" || ev.percent !== 100) return;
          expect(JSON.parse(readFileSync(linkPath(projectPath), "utf-8")).projectId).toBe(PROJECT_ID);
          writeFileSync(linkPath(projectPath), stolen);
          throw new Error("simulated failure after the link was committed");
        },
      });

      const f = asFailed(r);
      expect(f.error).toMatch(/simulated failure/);
      expect(f.linked).toBe(true);
      expect(f.linkRolledBack).toBe(false);
      expect(f.details).toMatch(/could NOT be removed/);
      expect(f.details).toMatch(/different hub project/);
      // The remedy has to be reachable without a shell incantation now that
      // there is a verb for it.
      expect(f.details).toMatch(/hub unlink/);
      // Untouched: the file the push found is the file the push left.
      expect(readFileSync(linkPath(projectPath), "utf-8")).toBe(stolen);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * #74/#78's paired-event contract, applied to push — nested HERE, inside the
   * failure fixtures, because the hole was exactly the failing exits: three of
   * them emitted `{percent: 0}` and never the matching `100`, so a consumer
   * that renders on the first event and closes on the terminal one waited
   * forever. `blockIndexDir` and the seam test above are the arrangements those
   * exits need; duplicating them below would be a second copy of a fixture.
   */
  describe("--progress events", () => {
    function recorder(): { events: ProgressEvent[]; onProgress: (ev: ProgressEvent) => void } {
      const events: ProgressEvent[] = [];
      return { events, onProgress: (ev) => events.push(ev) };
    }

    const pushPhase = (events: ProgressEvent[]): Array<number | undefined> =>
      events.filter((e) => e.phase === "hub-push").map((e) => e.percent);

    /**
     * THE bug, in the shape push actually has it: the failure is reported as a
     * typed `failedAfterLink` result, so nothing ever threw and nothing ever
     * closed the pair either.
     */
    it("still emits the terminal event when the push fails after the link is committed", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-push-prog-fail-home-"));
      const hub = mkdtempSync(join(tmpdir(), "sesh-push-prog-fail-hub-"));
      const base = mkdtempSync(join(tmpdir(), "sesh-push-prog-fail-fix-"));
      const restore = overrideHome(home);
      const { events, onProgress } = recorder();
      try {
        const { configDir } = createFixtureTree(base);
        const projectPath = createRealProject(base, configDir);
        await hubInit({ hubPath: hub, configScope: "user", cwd: home });
        seedHubProject(hub);
        blockIndexDir(hub);

        const r = await hubPush({
          configDir, projectPath, hubPath: hub,
          projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81", onProgress,
        });

        // Precondition: this really is the failing exit and not some refusal.
        const f = asFailed(r);
        expect(f.error).toMatch(/EEXIST|ENOTDIR/);
        expect(pushPhase(events)[0]).toBe(0);
        expect(events.at(-1)).toEqual({ phase: "hub-push", percent: 100 });
      } finally {
        restore.restore();
        for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
      }
    });

    /**
     * The opening event moved above the preflight, so the two refusals that
     * stop a push before it does anything are inside the pair rather than
     * silent. Exactly two events, because nothing between them ran.
     */
    it("emits a matched pair on a refusal that happens before anything is sent", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-push-prog-pre-home-"));
      const base = mkdtempSync(join(tmpdir(), "sesh-push-prog-pre-fix-"));
      const restore = overrideHome(home);
      const { events, onProgress } = recorder();
      try {
        const { configDir } = createFixtureTree(base);
        const projectPath = createRealProject(base, configDir);

        const r = await hubPush({
          configDir, projectPath, hubPath: join(base, "not-mounted"),
          claudeVersion: "2.1.81", onProgress,
        });

        expect(r.success).toBe(false);
        expect("reason" in r && r.reason).toBe("hub-unreachable");
        expect(events).toEqual([
          { phase: "hub-push", percent: 0 },
          { phase: "hub-push", percent: 100 },
        ]);
      } finally {
        restore.restore();
        for (const d of [home, base]) rmSync(d, { recursive: true, force: true });
      }
    });

    /**
     * The other half of the contract, and a decision rather than an oversight:
     * the ONE exit above the lock emits nothing, so a consumer gets either no
     * events at all or a matched pair — never an opening event with no close.
     */
    it("emits nothing at all when the project lock is already held", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-push-prog-lock-home-"));
      const hub = mkdtempSync(join(tmpdir(), "sesh-push-prog-lock-hub-"));
      const base = mkdtempSync(join(tmpdir(), "sesh-push-prog-lock-fix-"));
      const restore = overrideHome(home);
      const { events, onProgress } = recorder();
      try {
        const { configDir } = createFixtureTree(base);
        const projectPath = createRealProject(base, configDir);
        await hubInit({ hubPath: hub, configScope: "user", cwd: home });
        seedHubProject(hub);
        const held = acquireProjectLock(projectPath);
        try {
          const r = await hubPush({
            configDir, projectPath, hubPath: hub,
            projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81", onProgress,
          });

          expect(r.success).toBe(false);
          expect("reason" in r && r.reason).toBe("lock-busy");
          expect(events).toEqual([]);
        } finally {
          held.release();
        }
      } finally {
        restore.restore();
        for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
      }
    });

    /**
     * The one case push swallows, and the reason it does not simply copy
     * `hubPull`'s blanket `catch`.
     *
     * A throwing callback at the terminal event IS a push failure here — that
     * is the seam the link-rollback test above depends on, and it is consistent
     * with every other progress emission in this function, all of which can
     * already fail a push. But a callback that throws while a real failure is
     * already propagating must not REPLACE it: `failedAfterLink` would then
     * report the consumer's message as the cause of a push that actually died
     * of the blocked index write (an `EEXIST` — see `blockIndexDir`), and the
     * remedy the user needs would be gone.
     */
    it("does not let a throwing terminal callback replace a failure already in flight", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-push-prog-throw-home-"));
      const hub = mkdtempSync(join(tmpdir(), "sesh-push-prog-throw-hub-"));
      const base = mkdtempSync(join(tmpdir(), "sesh-push-prog-throw-fix-"));
      const restore = overrideHome(home);
      let calls = 0;
      try {
        const { configDir } = createFixtureTree(base);
        const projectPath = createRealProject(base, configDir);
        await hubInit({ hubPath: hub, configScope: "user", cwd: home });
        seedHubProject(hub);
        blockIndexDir(hub);

        const r = await hubPush({
          configDir, projectPath, hubPath: hub,
          projectIdOverride: PROJECT_ID, claudeVersion: "2.1.81",
          onProgress: (ev) => {
            calls++;
            if (ev.phase === "hub-push" && ev.percent === 100) throw new Error("consumer blew up");
          },
        });

        expect(calls).toBeGreaterThan(0);
        const f = asFailed(r);
        expect(f.error).toMatch(/EEXIST|ENOTDIR/);
        expect(f.error).not.toMatch(/consumer blew up/);
        // ...and the disclosure is still the real one: the bundle reached the
        // hub, the link this push wrote was rolled back.
        expect(f.orphanBundle).toBe(true);
        expect(f.linkRolledBack).toBe(true);
      } finally {
        restore.restore();
        for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
      }
    });
  });

  // --- #53: memory on the hub path -------------------------------------
  //
  // Every assertion here is on the EXTRACTED ARCHIVE, never on the manifest
  // alone. The whole defect was a manifest that described a bundle it did not
  // match, so a test that trusts the manifest is the test that missed it.

  /** Fetch the Nth bundle this project has on the hub and extract it. */
  async function extractNthBundle(
    hub: string,
    projectId: string,
    base: string,
    tag: string,
    n: number
  ): Promise<string> {
    const backend = createFsBackend(hub);
    const { indexes } = await readAllIndexes(backend, projectId);
    const bundles = Object.values(indexes[0].threads).flatMap((t) => t.bundles);
    const archiveTmp = join(base, `${tag}.tar.gz`);
    writeFileSync(archiveTmp, await backend.read(bundles[n].file));
    const dir = join(base, `${tag}-extracted`);
    mkdirSync(dir, { recursive: true });
    await extractArchive(archiveTmp, dir);
    return dir;
  }

  /**
   * The layers a bundle ACTUALLY carries, re-derived from the extracted tree.
   * Independent of the manifest on purpose — a mirror of the same helper in
   * tests/exporter.test.ts, which asserts the same invariant on the plain
   * export path.
   */
  function layersOnDisk(dir: string): string[] {
    const found = new Set<string>();
    const sessionsDir = join(dir, "sessions");
    if (existsSync(sessionsDir)) {
      for (const name of readdirSync(sessionsDir)) {
        const p = join(sessionsDir, name);
        if (statSync(p).isFile()) {
          if (name.endsWith(".jsonl")) found.add("jsonl");
          continue;
        }
        if (existsSync(join(p, "subagents"))) found.add("subagents");
        if (existsSync(join(p, "tool-results"))) found.add("tool-results");
      }
    }
    const fileHistory = join(dir, "file-history");
    if (existsSync(fileHistory) && readdirSync(fileHistory).length > 0) found.add("file-history");
    if (existsSync(join(dir, "memory"))) found.add("memory");
    if (existsSync(join(dir, "plans"))) found.add("plans");
    return ["jsonl", "subagents", "file-history", "tool-results", "memory", "plans"].filter((l) =>
      found.has(l)
    );
  }

  /** Append two entries to a session so the next push has something to send. */
  function carryOn(configDir: string, projectPath: string, sessionId: string, tag: string): void {
    const jsonlPath = join(
      configDir, "projects", encodeProjectPath(projectPath), `${sessionId}.jsonl`
    );
    const existing = readFileSync(jsonlPath, "utf-8");
    const lines = existing.split("\n").filter((l) => l !== "");
    const anchorUuid = (JSON.parse(lines[lines.length - 1]) as { uuid: string }).uuid;
    writeFileSync(
      jsonlPath,
      existing +
        [
          {
            uuid: `${tag}-1`, parentUuid: anchorUuid, timestamp: "2026-04-11T09:00:00Z",
            sessionId, cwd: projectPath, version: "2.1.81", type: "user",
            message: { role: "user", content: "more" },
          },
          {
            uuid: `${tag}-2`, parentUuid: `${tag}-1`, timestamp: "2026-04-11T09:00:05Z",
            sessionId, cwd: projectPath, version: "2.1.81", type: "assistant",
            message: {
              model: "claude-opus-4-6", id: `msg_${tag}`,
              content: [{ type: "text", text: "ok" }],
            },
          },
        ].map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8"
    );
  }

  it("a pushed bundle really carries memory/, and its manifest declares exactly what it carries", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const push = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(push.success).toBe(true);
      if (!push.success) return;

      const dir = await extractNthBundle(hub, push.projectId, base, "mem", 0);

      // THE regression. Before #53 this directory did not exist in any bundle
      // any hub has ever held, on any push, ever — because hub push always
      // passes a truthy `incremental` and both whole-file layers sat behind
      // `if (!incremental)`.
      expect(existsSync(join(dir, "memory"))).toBe(true);
      expect(readFileSync(join(dir, "memory", "MEMORY.md"), "utf-8")).toBe(
        "- [Test memory](test_memory.md) — remembering test patterns\n"
      );
      expect(readFileSync(join(dir, "memory", "test_memory.md"), "utf-8")).toContain(
        "Use vitest for testing."
      );

      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
      const onDisk = layersOnDisk(dir);
      expect(onDisk).toContain("memory");
      // plans is the deliberate other half: config-global with no project
      // filter, so it stays off the hub until it is scoped — and is no longer
      // advertised. It used to be declared by every hub bundle ever written.
      expect(onDisk).not.toContain("plans");
      expect(manifest.includedLayers).toEqual(onDisk);
      expect(manifest.memoryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

      // The ledger the next push reads back, credited only now that the bundle
      // is genuinely on the hub.
      const hubPeer = Object.entries(readSyncState(projectPath).peers).find(([id]) =>
        id.startsWith("hub:")
      )![1];
      expect(hubPeer.memoryDigest).toBe(manifest.memoryDigest);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("memory re-ships only when it changed: unchanged is skipped, changed travels again", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      const memoryDir = join(configDir, "projects", encodeProjectPath(projectPath), "memory");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const first = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      if (!first.success) return;
      const firstDir = await extractNthBundle(hub, first.projectId, base, "arm-1", 0);
      expect(layersOnDisk(firstDir)).toContain("memory");
      const firstDigest = JSON.parse(
        readFileSync(join(firstDir, "manifest.json"), "utf-8")
      ).memoryDigest as string;

      // ARM A — memory untouched. New session content, so there IS a bundle;
      // it just carries no second copy of a directory the hub already holds.
      carryOn(configDir, projectPath, sessionId, "same");
      const second = await hubPush({
        configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81",
      });
      expect(second.success).toBe(true);
      if (!second.success) return;
      const secondDir = await extractNthBundle(hub, first.projectId, base, "arm-2", 1);
      expect(existsSync(join(secondDir, "memory"))).toBe(false);
      const secondManifest = JSON.parse(readFileSync(join(secondDir, "manifest.json"), "utf-8"));
      expect(secondManifest.includedLayers).toEqual(layersOnDisk(secondDir));
      expect(secondManifest.includedLayers).not.toContain("memory");
      expect(secondManifest.memoryDigest).toBeUndefined();
      // A skip must not disturb the ledger — the hub still holds what it held.
      const afterSkip = Object.entries(readSyncState(projectPath).peers).find(([id]) =>
        id.startsWith("hub:")
      )![1];
      expect(afterSkip.memoryDigest).toBe(firstDigest);

      // ARM B — memory changed. It travels again, with its new content.
      writeFileSync(join(memoryDir, "MEMORY.md"),
        "- [Test memory](test_memory.md) — remembering test patterns\n" +
        "- [Second memory](second.md) — learned on this machine\n");
      writeFileSync(join(memoryDir, "second.md"), "Prefer real temp dirs.\n");
      carryOn(configDir, projectPath, sessionId, "changed");
      const third = await hubPush({
        configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81",
      });
      expect(third.success).toBe(true);
      if (!third.success) return;
      const thirdDir = await extractNthBundle(hub, first.projectId, base, "arm-3", 2);
      expect(existsSync(join(thirdDir, "memory"))).toBe(true);
      expect(readFileSync(join(thirdDir, "memory", "second.md"), "utf-8")).toBe(
        "Prefer real temp dirs.\n"
      );
      const thirdManifest = JSON.parse(readFileSync(join(thirdDir, "manifest.json"), "utf-8"));
      expect(thirdManifest.includedLayers).toEqual(layersOnDisk(thirdDir));
      expect(thirdManifest.includedLayers).toContain("memory");
      expect(thirdManifest.memoryDigest).not.toBe(firstDigest);
      const afterChange = Object.entries(readSyncState(projectPath).peers).find(([id]) =>
        id.startsWith("hub:")
      )![1];
      expect(afterChange.memoryDigest).toBe(thirdManifest.memoryDigest);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// What a hub bundle and a hub index say about the CONVERSATION.
//
// Both halves of #65. A bundle manifest and an index file are the two things a
// push uploads that are not the transcript itself, and both used to carry a
// line of the conversation that nothing asked them to.
// ---------------------------------------------------------------------------

/**
 * An UNTITLED session: a transcript whose first entry has no `slug`.
 *
 * Not exotic — `discovery.ts` falls back to the session id, and
 * `extractSummaryFromFile` refuses a UUID slug, so the manifest summary for such
 * a session is an excerpt of the first user message rather than a title. That is
 * what makes this fixture, and not the suite's ordinary `test-session` one, able
 * to tell a slug and a summary apart at all.
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

/** Extend a session in place so the next push has something to ship. */
function appendToSession(
  configDir: string, projectPath: string, sessionId: string, tag: string
): void {
  const jsonlPath = join(
    configDir, "projects", encodeProjectPath(projectPath), `${sessionId}.jsonl`
  );
  const existing = readFileSync(jsonlPath, "utf-8");
  const lines = existing.split("\n").filter((l) => l !== "");
  const anchorUuid = (JSON.parse(lines[lines.length - 1]) as { uuid: string }).uuid;
  writeFileSync(
    jsonlPath,
    existing +
      [
        {
          uuid: `${tag}-1`, parentUuid: anchorUuid, timestamp: "2026-04-11T09:00:00Z",
          sessionId, cwd: projectPath, version: "2.1.81", type: "user",
          message: { role: "user", content: "more" },
        },
        {
          uuid: `${tag}-2`, parentUuid: `${tag}-1`, timestamp: "2026-04-11T09:00:05Z",
          sessionId, cwd: projectPath, version: "2.1.81", type: "assistant",
          message: {
            model: "claude-opus-4-6", id: `msg_${tag}`,
            content: [{ type: "text", text: "ok" }],
          },
        },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8"
  );
}

/** Fetch the first bundle this project has on the hub and extract it. */
async function extractFirstBundle(
  hub: string, projectId: string, base: string, tag: string
): Promise<string> {
  const backend = createFsBackend(hub);
  const { indexes } = await readAllIndexes(backend, projectId);
  const bundles = Object.values(indexes[0].threads).flatMap((t) => t.bundles);
  const archiveTmp = join(base, `${tag}.tar.gz`);
  writeFileSync(archiveTmp, await backend.read(bundles[0].file));
  const dir = join(base, `${tag}-extracted`);
  mkdirSync(dir, { recursive: true });
  await extractArchive(archiveTmp, dir);
  return dir;
}

describe("hub push — export.noSummary", () => {
  /**
   * `--no-summary` / `export.noSummary` is documented as FUNCTIONAL, not
   * cosmetic: it skips parsing the transcript for a summary at all, so no
   * conversation text reaches the manifest. `hub push` dropped it on the floor,
   * and the hub is the transport where it matters most — the manifest is
   * uploaded to a shared directory by a default-on, unattended SessionEnd
   * auto-push that has no channel to disclose what it just sent.
   *
   * Through a real `hubPush` and the archive it actually uploaded, never a unit
   * call on the exporter: the defect was entirely in the wiring between them.
   */
  it("set: the uploaded bundle's manifest carries the slug, not a line of the conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      writeUntitledSession(configDir, projectPath);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const pushed = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true,
        noSummary: true, claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(true);
      if (!pushed.success) return;

      const dir = await extractFirstBundle(hub, pushed.projectId, base, "nosummary");
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as {
        sessions: Array<{ sessionId: string; slug: string; summary: string }>;
      };
      const untitled = manifest.sessions.find((s) => s.sessionId === UNTITLED_ID);
      expect(untitled).toBeDefined();
      expect(untitled!.summary).toBe(UNTITLED_ID);
      expect(untitled!.summary).toBe(untitled!.slug);
      // Asserted over the whole manifest, not just the one field: the promise is
      // that no conversation text reaches it, and there are other string fields.
      expect(readFileSync(join(dir, "manifest.json"), "utf-8")).not.toContain("SECRET");

      // ...and the setting is about the MANIFEST. The transcript is the payload
      // the user asked to sync, and it travels in full either way.
      expect(
        readFileSync(join(dir, "sessions", `${UNTITLED_ID}.jsonl`), "utf-8")
      ).toContain(UNTITLED_SECRET);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The control arm, and the reason the test above is not vacuous: without the
   * setting the excerpt really is in the manifest, so the assertion above is
   * measuring the setting rather than a fixture that never had a summary.
   *
   * It also pins the default. `noSummary` is opt-in; a change that made
   * slug-only the default would silently retire a documented setting, and this
   * fails when it does.
   */
  it("unset: the manifest carries the excerpt, which is what the setting turns off", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      writeUntitledSession(configDir, projectPath);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const pushed = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(true);
      if (!pushed.success) return;

      const dir = await extractFirstBundle(hub, pushed.projectId, base, "summary");
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as {
        sessions: Array<{ sessionId: string; summary: string }>;
      };
      const untitled = manifest.sessions.find((s) => s.sessionId === UNTITLED_ID);
      expect(untitled!.summary).toBe(UNTITLED_SECRET);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("hub push — an index poisoned by an older version", () => {
  /**
   * The stickiness half of #65, end to end.
   *
   * A thread whose local session has vanished is carried forward from the prior
   * index, and `hub reindex` used to reconstruct that entry's `summary` from the
   * bundle manifest — an excerpt. Nothing self-healed afterwards: every later
   * ordinary push read the poisoned entry back as its own `priorIndex` and
   * copied it forward verbatim, so the excerpt outlived the fix that stopped
   * producing it.
   *
   * The poisoned index here is hand-written rather than produced by
   * `hub reindex`, because reindex no longer produces one — this is the
   * "existing hub data" case, an index left behind by a version that did.
   *
   * SCOPE, and it is structural: this scrubs THIS machine's own index file.
   * Per-machine ownership means a machine never writes another's, so every
   * machine that has pushed has to run one push/pull/reindex of its own.
   */
  it("scrubs the poisoned entry on the next ordinary push, keeping its bundle history", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir, sessionId } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      const untitledPath = writeUntitledSession(configDir, projectPath);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const first = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      if (!first.success) return;
      expect(first.pushedSessions).toHaveLength(2);

      // The untitled session is gone locally: its thread now survives only
      // through the prior index, which is the door under test.
      rmSync(untitledPath, { force: true });

      const machine = loadOrCreateMachineId();
      const indexFile = join(hub, "projects", first.projectId, "index", `${machine.id}.json`);
      const poisoned = JSON.parse(readFileSync(indexFile, "utf-8")) as {
        threads: Record<string, { localSessionId: string; slug: string; summary: string; bundles: unknown[] }>;
      };
      const [poisonedThreadId, poisonedEntry] = Object.entries(poisoned.threads).find(
        ([, t]) => t.localSessionId === UNTITLED_ID
      )!;
      poisonedEntry.summary = UNTITLED_SECRET;
      writeFileSync(indexFile, JSON.stringify(poisoned, null, 2) + "\n", "utf-8");
      const bundlesBefore = poisonedEntry.bundles.length;
      expect(bundlesBefore).toBeGreaterThan(0);

      // An ORDINARY push — nothing about it is aimed at the index; it just has
      // new session content to ship, which is the whole point.
      appendToSession(configDir, projectPath, sessionId, "more");
      const second = await hubPush({
        configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81",
      });
      expect(second.success).toBe(true);
      if (!second.success) return;

      const after = JSON.parse(readFileSync(indexFile, "utf-8")) as {
        threads: Record<string, { slug: string; summary: string; bundles: unknown[] }>;
      };
      const scrubbed = after.threads[poisonedThreadId];
      expect(scrubbed).toBeDefined();
      expect(scrubbed.summary).toBe(scrubbed.slug);
      expect(scrubbed.summary).toBe(UNTITLED_ID);
      // A scrub, not a drop: the vanished thread and its history are still there
      // for another machine to pull.
      expect(scrubbed.bundles).toHaveLength(bundlesBefore);
      // On the BYTES, because the entry is carried forward with a spread — a
      // copy landing under any other key is the same disclosure.
      expect(readFileSync(indexFile, "utf-8")).not.toContain("SECRET");
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});

/**
 * #75 — the two things a push must settle about the HUB before it does
 * anything, now decided in `src/hub/preflight.ts` where a library caller of
 * `hubPush` meets them too (they were CLI-only, or an uncaught throw).
 *
 * Every assertion here is about ORDER as much as shape. `hubPush` registers
 * this machine on the hub, mints thread ids into local sync-state and runs a
 * full incremental export before it ever resolved the identity, so a refusal
 * that arrives late is barely a refusal at all.
 */
describe("hub push — the hub preflight", () => {
  const MISSING_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  const syncStatePath = (home: string, projectPath: string): string =>
    join(home, ".sesh-mover", "sync-state", `${encodeProjectPath(projectPath)}.json`);

  it("refuses an unknown --project-id before any write, and --create-project then pushes", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-pre-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-pre-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-pre-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const refused = await hubPush({
        configDir, projectPath, hubPath: hub,
        projectIdOverride: MISSING_ID, claudeVersion: "2.1.81",
      });

      expect(refused.success).toBe(false);
      expect("reason" in refused && refused.reason).toBe("no-such-project");
      expect("requestedProjectId" in refused && refused.requestedProjectId).toBe(MISSING_ID);
      // An empty hub has nothing to offer, and the suggestion says so by
      // naming the flag that mints one instead.
      expect("linkCandidates" in refused && refused.linkCandidates).toEqual([]);
      expect("suggestion" in refused && refused.suggestion).toContain("--create-project");
      // The refusal reflects the id the user typed and nothing about where the
      // hub is: the ENOENT it replaces carried the hub's absolute path.
      expect(JSON.stringify(refused)).not.toContain(hub);
      // NOTHING happened. The sync-state file is the sharpest of these — push
      // mints a thread id into it before it resolves the identity — and the
      // machine record is the one that used to be written by `registerMachine`
      // regardless.
      expect(existsSync(syncStatePath(home, projectPath))).toBe(false);
      expect(existsSync(projectJsonFilePath(projectPath))).toBe(false);
      expect(existsSync(join(hub, "projects"))).toBe(false);

      // ...so the advised re-run reaches the work, which is what makes the
      // suggestion true rather than merely plausible.
      const retry = await hubPush({
        configDir, projectPath, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });

      expect(retry.success).toBe(true);
      if (!retry.success) return;
      expect(retry.pushedSessions.length).toBeGreaterThan(0);
      expect(existsSync(projectJsonFilePath(projectPath))).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("refuses an unreachable hub without creating anything at that path", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-gone-home-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-gone-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      // Never created: an unmounted share or a synced folder that has not
      // appeared on this machine looks exactly like this.
      const gone = join(base, "not-mounted");

      const r = await hubPush({
        configDir, projectPath, hubPath: gone, claudeVersion: "2.1.81",
      });

      expect(r.success).toBe(false);
      expect("reason" in r && r.reason).toBe("hub-unreachable");
      expect("hubState" in r && r.hubState).toBe("no-directory");
      expect(JSON.stringify(r)).not.toContain(gone);
      // THE sharp one: `registerMachine` writes `machines/<id>.json` through
      // `writeAtomic`, which mkdir -p's its way there — so a push at a mistyped
      // path used to materialise a half-built "hub" at it, which every later
      // command would then treat as real.
      expect(existsSync(gone)).toBe(false);
      expect(existsSync(syncStatePath(home, projectPath))).toBe(false);
      expect(existsSync(projectJsonFilePath(projectPath))).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("refuses a directory that is not a hub, distinctly from one that is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-nothub-home-"));
    const notAHub = mkdtempSync(join(tmpdir(), "sesh-push-nothub-dir-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-nothub-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      // A real directory with real contents and no hub.json — someone's
      // Documents folder, or a synced hub whose first sync is still in flight.
      writeFileSync(join(notAHub, "notes.txt"), "not a hub\n");

      const r = await hubPush({
        configDir, projectPath, hubPath: notAHub, claudeVersion: "2.1.81",
      });

      expect(r.success).toBe(false);
      expect("reason" in r && r.reason).toBe("hub-unreachable");
      expect("hubState" in r && r.hubState).toBe("not-a-hub");
      // Read-only: the directory the user pointed at is untouched.
      expect(readdirSync(notAHub)).toEqual(["notes.txt"]);
      expect(existsSync(projectJsonFilePath(projectPath))).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, notAHub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * A hub.json that is present but unusable is the SAME refusal as an absent
   * one, deliberately: from the caller's side "this machine cannot tell which
   * hub that is" is one fact with one remedy, and a truncated file is what a
   * sync client mid-copy actually produces.
   */
  it("treats an unusable hub.json as not-a-hub rather than throwing", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-push-badjson-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-push-badjson-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-push-badjson-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      writeFileSync(join(hub, "hub.json"), '{"schemaVersion": 1, "hubId"');

      const r = await hubPush({
        configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81",
      });

      expect(r.success).toBe(false);
      expect("reason" in r && r.reason).toBe("hub-unreachable");
      expect("hubState" in r && r.hubState).toBe("not-a-hub");
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});
