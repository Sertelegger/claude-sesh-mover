import { describe, it, expect } from "vitest";
import {
  mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { readAllIndexes } from "../src/hub/index-file.js";
import { createFsBackend } from "../src/hub/backend.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { encodeProjectPath } from "../src/platform.js";
import { digestFile, verifyStatement, SIGNATURE_DOMAIN } from "../src/hub/signature.js";
import { signingKeyPath } from "../src/crypto/signing-key.js";
import type { HubBundleRecord, HubJson, HubMachineJson } from "../src/hub/layout.js";

/**
 * The push side of #86: a real push signs a statement over the plaintext
 * archives and stamps it on every index record it mints; an unreadable signing
 * key WARNS AND PUSHES UNSIGNED (owner ruling) rather than failing — including
 * for the unattended SessionEnd auto-push, which is the caller that would
 * otherwise refuse at every session end over a transient file problem.
 *
 * Verification here goes through `verifyStatement` — the same function the
 * pull side uses — rather than re-implementing the checks, so what these tests
 * pin is the round trip the verifier will actually run, not this file's
 * opinion of it. Mutation-proved (see the task record): `bundleFile: hubFile +
 * ".moved"` in push.ts fails the context assertions here, and turning the
 * unreadable-key warning into a throw fails the unsigned-push test.
 */

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

// Same technique as tests/hub-push.test.ts's createRealProject, for the same
// reason stated there: identity linking writes into the real project directory,
// so the push needs a real (git-less) path with the fixture sessions copied
// under its encoded name.
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

function readHubJson(hub: string): HubJson {
  return JSON.parse(readFileSync(join(hub, "hub.json"), "utf-8")) as HubJson;
}

function readMachineRecord(hub: string, id: string): HubMachineJson {
  return JSON.parse(readFileSync(join(hub, "machines", `${id}.json`), "utf-8")) as HubMachineJson;
}

/** Hub-relative path → real path, without assuming POSIX separators locally. */
function hubLocalPath(hub: string, relPath: string): string {
  return join(hub, ...relPath.split("/"));
}

async function firstRecord(hub: string, projectId: string): Promise<HubBundleRecord> {
  const { indexes } = await readAllIndexes(createFsBackend(hub), projectId);
  expect(indexes).toHaveLength(1);
  const threads = Object.values(indexes[0].threads);
  expect(threads.length).toBeGreaterThan(0);
  expect(threads[0].bundles).toHaveLength(1);
  return threads[0].bundles[0];
}

describe("hub push — bundle signing (#86)", () => {
  it("a pushed record carries a signature whose statement matches the record's own context", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-sign-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-sign-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-sign-fix-"));
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
      expect(result.warnings.join("\n")).not.toContain("UNSIGNED");

      const record = await firstRecord(hub, result.projectId);
      expect(record.signature).toBeDefined();
      const sig = record.signature!;

      // The statement describes the record it rides on — the exact comparison
      // the verifier makes, so a bundleFile that drifts from record.file is a
      // self-inflicted verification failure and this is the test that sees it.
      expect(sig.statement.domain).toBe(SIGNATURE_DOMAIN);
      expect(sig.statement.bundleFile).toBe(record.file);
      expect(sig.statement.bundleId).toBe(record.bundleId);
      expect(sig.statement.pushedAt).toBe(record.pushedAt);
      expect(sig.statement.projectId).toBe(result.projectId);

      const machine = loadOrCreateMachineId();
      expect(sig.statement.machineId).toBe(machine.id);
      expect(sig.statement.hubId).toBe(readHubJson(hub).hubId);

      // The digest is of the uploaded bytes on this (unsealed) hub — i.e. the
      // PLAINTEXT archive. On a sealed hub the two would differ, which is the
      // point of digesting before the encrypt stream.
      expect(sig.statement.bundleDigest).toBe(await digestFile(hubLocalPath(hub, record.file)));

      // The signature verifies through the verifier's own code path, against
      // the context the record supplies.
      const verdict = verifyStatement({
        signature: sig,
        context: {
          hubId: readHubJson(hub).hubId,
          projectId: result.projectId,
          machineId: machine.id,
          bundleId: record.bundleId,
          bundleFile: record.file,
        },
        pinnedKey: null,
      });
      expect(verdict).toEqual({ ok: true });

      // The key the statement was signed with is the one registerMachine
      // published — what a first-contact pin will record.
      expect(readMachineRecord(hub, machine.id).signingPublicKey).toBe(sig.publicKey);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("a push with a workspace artifact signs the artifact's digest too", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-sign-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-sign-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-sign-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      // A git-less project takes the workspace snapshot by default.
      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.hasWorkspace).toBe(true);

      const record = await firstRecord(hub, result.projectId);
      const st = record.signature!.statement;
      // Present together — and the digest is of the artifact file the hub
      // actually holds, which is a SEPARATE file from the bundle since #91.
      expect(st.workspaceFile).toBeDefined();
      expect(st.workspaceFile).not.toBe(st.bundleFile);
      expect(st.workspaceDigest).toBe(await digestFile(hubLocalPath(hub, st.workspaceFile!)));
      expect(st.workspaceDigest).not.toBe(st.bundleDigest);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("a workspace-less push signs a statement with BOTH workspace fields absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-sign-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-sign-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-sign-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
        noWorkspace: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.hasWorkspace).toBe(false);

      const record = await firstRecord(hub, result.projectId);
      const sig = record.signature!;
      // Absent, not empty — `canonicalize` drops undefined, so this shape and
      // the with-workspace shape sign different bytes (signature.ts).
      expect("workspaceFile" in sig.statement).toBe(false);
      expect("workspaceDigest" in sig.statement).toBe(false);
      expect(
        verifyStatement({
          signature: sig,
          context: {
            hubId: readHubJson(hub).hubId,
            projectId: result.projectId,
            machineId: loadOrCreateMachineId().id,
            bundleId: record.bundleId,
            bundleFile: record.file,
          },
          pinnedKey: null,
        })
      ).toEqual({ ok: true });
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("an unreadable signing key warns and pushes UNSIGNED — it never fails the push", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-sign-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-sign-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-sign-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);

      // A directory at the key's name: `readFileSync` fails on every platform,
      // so `loadOrCreateSigningKey` answers unreadable/io — and per the
      // never-clobber rule it must NOT mint over it.
      mkdirSync(signingKeyPath(), { recursive: true });

      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const result = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });

      // The owner ruling, executable: success, not a refusal and not a throw.
      expect(result.success).toBe(true);
      if (!result.success) return;

      // The warning says what happened and what it costs (the downgrade a
      // peer that has seen this machine sign will report).
      const warned = result.warnings.filter((w) => w.includes("pushed UNSIGNED"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("signing key");
      expect(warned[0]).toContain("downgrade");

      // Genuinely unsigned: no signature key on the record at all — "absent
      // means pre-signing" is about the key, so an explicit undefined would
      // be a different (wrong) statement.
      const record = await firstRecord(hub, result.projectId);
      expect("signature" in record).toBe(false);

      // And nothing was published for peers to pin: no prior record existed,
      // so there was nothing to carry forward.
      const machine = loadOrCreateMachineId();
      expect(readMachineRecord(hub, machine.id).signingPublicKey).toBeUndefined();
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("a published signing key is carried forward, not retracted, when the file breaks later", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-sign-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-sign-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-sign-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir);
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const first = await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, claudeVersion: "2.1.81",
      });
      expect(first.success).toBe(true);
      if (!first.success) return;

      const machine = loadOrCreateMachineId();
      const published = readMachineRecord(hub, machine.id).signingPublicKey;
      expect(published).toBeDefined();

      // The key file breaks between pushes — registerMachine's whole-file
      // rewrite must preserve the published key rather than silently
      // retracting the thing peers pinned.
      rmSync(signingKeyPath(), { recursive: true, force: true });
      mkdirSync(signingKeyPath(), { recursive: true });

      const second = await hubPush({
        configDir, projectPath, hubPath: hub, claudeVersion: "2.1.81",
      });
      expect(second.success).toBe(true);
      if (!second.success) return;
      // Up to date: nothing uploaded, so nothing went up unsigned and the
      // unsigned-push warning would be a false statement here.
      expect(second.upToDate).toBe(true);
      expect(second.warnings.join("\n")).not.toContain("UNSIGNED");

      expect(readMachineRecord(hub, machine.id).signingPublicKey).toBe(published);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});
