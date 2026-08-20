/**
 * # `hub rekey` (#91)
 *
 * Encryption at rest addresses a bundle once, when it is written. This verb is
 * the answer to the state that leaves behind — a machine that joined afterwards
 * and can read nothing older than itself — and the tests here are shaped by
 * what it deliberately is NOT:
 *
 * 1. **It grants, it never recovers.** A re-wrap unwraps the file key first, so
 *    a machine that lost or rotated its key cannot re-address its own past
 *    bundles either. That is a separate residual from the one below and it has
 *    its own test.
 * 2. **A decommissioned machine can never re-wrap its bundles**, so its history
 *    stays unreadable to anyone who joined after it left. There is no authority
 *    to invent here, and the test for it demonstrates the dead end rather than
 *    asserting a message about it.
 * 3. **An un-keyed peer is a disclosure, not a refusal** — the one place this
 *    verb decides differently from `hub push` over the same census, because a
 *    rekey is idempotent and re-runnable while a push writes its bundle once.
 *
 * The crypto is pinned separately, in `tests/crypto-age.test.ts`, against the
 * real `age` binary: a header we rebuild is a header no self-test can vouch
 * for. This file answers the other question — does the hub path use it
 * correctly, over the right files, in the right order, and what does a partial
 * run leave behind.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { appendEntries, createRealProject, FIXTURE_SESSION_ID } from "./helpers/hub-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { hubPull } from "../src/hub/pull.js";
import { hubReindex } from "../src/hub/reindex.js";
import { hubRekey } from "../src/hub/rekey.js";
import { hubEncrypt } from "../src/hub/encrypt.js";
import { checkSelfIsRecipient } from "../src/hub/encryption.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { createFsBackend } from "../src/hub/backend.js";
import { bundleDir } from "../src/hub/layout.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { acquireProjectLock } from "../src/hub/lock.js";
import { identityFilePath } from "../src/crypto/identity-file.js";
import { generateIdentity } from "../src/crypto/age.js";
import { encodeProjectPath } from "../src/platform.js";
import { PLUGIN_VERSION } from "../src/version.js";
import type {
  ErrorResult, HubPushResult, HubRekeyRefusedResult, HubRekeyResult,
} from "../src/types.js";

const CLAUDE_VERSION = "2.1.81";

/** A machine record planted directly on the hub — a peer this test never runs. */
function plantMachine(hub: string, id: string, over: Record<string, unknown> = {}): void {
  mkdirSync(join(hub, "machines"), { recursive: true });
  writeFileSync(
    join(hub, "machines", `${id}.json`),
    JSON.stringify(
      {
        id,
        name: `planted-${id.slice(0, 4)}`,
        platform: "linux",
        lastSeenAt: "2026-08-19T00:00:00.000Z",
        pluginVersion: PLUGIN_VERSION,
        ...over,
      },
      null,
      2
    ) + "\n"
  );
}

function sessionJsonlPath(configDir: string, projectPath: string): string {
  return join(configDir, "projects", encodeProjectPath(projectPath), `${FIXTURE_SESSION_ID}.jsonl`);
}

/** Two more entries on the fixture transcript, so the next push is a continuation. */
function extendSession(configDir: string, projectPath: string, n: number): void {
  appendEntries(sessionJsonlPath(configDir, projectPath), [
    {
      uuid: `rk-${n}-a`,
      parentUuid: n === 1 ? "entry-3" : `rk-${n - 1}-b`,
      timestamp: `2026-08-19T0${n}:00:00Z`,
      sessionId: FIXTURE_SESSION_ID,
      cwd: projectPath,
      version: CLAUDE_VERSION,
      type: "user",
      message: { role: "user", content: `round ${n}` },
    },
    {
      uuid: `rk-${n}-b`,
      parentUuid: `rk-${n}-a`,
      timestamp: `2026-08-19T0${n}:00:05Z`,
      sessionId: FIXTURE_SESSION_ID,
      cwd: projectPath,
      version: CLAUDE_VERSION,
      type: "assistant",
      message: { model: "claude-opus-4-6", id: `msg-rk-${n}`, content: [{ type: "text", text: "ok" }] },
    },
  ]);
}

function hubBytes(hub: string, file: string): Buffer {
  return readFileSync(join(hub, ...file.split("/")));
}

/**
 * This machine's own bundle files on the hub, hub-relative and sorted — which
 * is push order, since `bundleFileName` leads with a sortable timestamp.
 * Reads the DIRECTORY rather than an index, for the same reason `hub rekey`
 * does: the files are the fact, and an index is a projection of them.
 */
async function ownBundleFiles(hub: string, projectId: string): Promise<string[]> {
  const backend = createFsBackend(hub);
  return (await backend.list(bundleDir(projectId, loadOrCreateMachineId().id))).sort();
}

interface Sandbox {
  homeA: string;
  hub: string;
  base: string;
  configDirA: string;
  projectA: string;
  restore: { restore(): void };
  dirs: string[];
}

/** One machine (A), a hub it created, and a real project with the fixture session. */
function sandbox(tag: string): Sandbox {
  const homeA = mkdtempSync(join(tmpdir(), `sesh-rekey-${tag}-homeA-`));
  const hub = mkdtempSync(join(tmpdir(), `sesh-rekey-${tag}-hub-`));
  const base = mkdtempSync(join(tmpdir(), `sesh-rekey-${tag}-fix-`));
  const restore = overrideHome(homeA);
  const { configDir: configDirA } = createFixtureTree(base);
  const projectA = createRealProject(base, configDirA, `proj-${tag}`);
  return { homeA, hub, base, configDirA, projectA, restore, dirs: [homeA, hub, base] };
}

function teardown(s: Sandbox, extra: string[] = []): void {
  s.restore.restore();
  for (const d of [...s.dirs, ...extra]) rmSync(d, { recursive: true, force: true });
}

describe("hub rekey", () => {
  it("re-addresses this machine's bundles so a machine that joined later can read them, and the original still can", async () => {
    const s = sandbox("join");
    const homeB = mkdtempSync(join(tmpdir(), "sesh-rekey-join-homeB-"));
    const projectB = mkdtempSync(join(tmpdir(), "sesh-rekey-join-projB-"));
    let restore = s.restore;
    try {
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: s.homeA });
      await hubEncrypt({ hubPath: s.hub, enable: true, cwd: s.homeA });
      // A pushes while it is the only machine on the hub: the bundle AND the
      // workspace artifact are addressed to A alone.
      const pushed = (await hubPush({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
        createProject: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.success).toBe(true);
      expect(pushed.bundleEncrypted).toBe(true);
      expect(pushed.hasWorkspace).toBe(true);

      // B joins AFTER. This is the state with no remedy before this verb.
      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: homeB });
      writeLocalProjectId(projectB, {
        projectId: pushed.projectId,
        name: "proj-join",
        createdAt: new Date().toISOString(),
        createdByMachine: "machine-a",
      });
      const blocked = (await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: s.hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      })) as ErrorResult;
      expect(blocked.success).toBe(false);
      expect(blocked.error).toMatch(/no identity matched any recipient stanza/);

      // A re-addresses its own files.
      restore.restore();
      restore = overrideHome(s.homeA);
      const rekeyed = (await hubRekey({ projectPath: s.projectA, hubPath: s.hub })) as HubRekeyResult;
      expect(rekeyed.success).toBe(true);
      expect(rekeyed.recipients).toHaveLength(2);
      expect(rekeyed.failed).toEqual([]);
      expect(rekeyed.skipped).toEqual([]);
      expect(rekeyed.narrowed).toEqual([]);
      // BOTH payload kinds, because they are two different hub files since #91
      // and a rekey that swept only `bundles/` would leave every merge ancestor
      // unreadable — a failure that degrades silently to keep-local.
      expect(rekeyed.rewrapped.some((f) => f.includes("/bundles/"))).toBe(true);
      expect(rekeyed.rewrapped.some((f) => f.includes("/workspaces/"))).toBe(true);
      // ORDER IS THE FAILURE CONTRACT: bundles before workspaces (a bundle a
      // puller cannot open aborts its whole chain; an artifact it cannot open
      // degrades to keep-local), and oldest first within each group (a pull
      // walks a chain from its base).
      const firstWs = rekeyed.rewrapped.findIndex((f) => f.includes("/workspaces/"));
      expect(rekeyed.rewrapped.slice(0, firstWs).every((f) => f.includes("/bundles/"))).toBe(true);
      expect(rekeyed.rewrapped.slice(firstWs).every((f) => f.includes("/workspaces/"))).toBe(true);

      // (1) The new machine can now read it.
      restore.restore();
      restore = overrideHome(homeB);
      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: s.hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(pull.success, JSON.stringify(pull)).toBe(true);
      expect(existsSync(join(configDirB, "projects", encodeProjectPath(projectB)))).toBe(true);

      // (2) ...AND the machine that wrote it still can. This is the half a
      // rekey that dropped its own recipient would break in bulk and silently:
      // reindex fetches and decrypts every one of A's own bundles.
      restore.restore();
      restore = overrideHome(s.homeA);
      const re = await hubReindex({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
      });
      expect(re.success, JSON.stringify(re)).toBe(true);

      // (3) Idempotent: running it again is running it once. That is the
      // property the un-keyed-peer decision below rests on.
      const again = (await hubRekey({ projectPath: s.projectA, hubPath: s.hub })) as HubRekeyResult;
      expect(again.success).toBe(true);
      expect(again.rewrapped).toEqual(rekeyed.rewrapped);
      expect(again.failed).toEqual([]);
      const re2 = await hubReindex({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
      });
      expect(re2.success).toBe(true);
    } finally {
      restore.restore();
      teardown(s, [homeB, projectB]);
    }
  });

  it("refuses, and writes nothing, when this machine cannot read its own identity key", async () => {
    const s = sandbox("selfkey");
    try {
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: s.homeA });
      await hubEncrypt({ hubPath: s.hub, enable: true, cwd: s.homeA });
      const pushed = (await hubPush({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.bundleEncrypted).toBe(true);
      const file = (await ownBundleFiles(s.hub, pushed.projectId))[0]!;
      const before = hubBytes(s.hub, file);

      // The key is gone but the hub's record for this machine still publishes
      // it — `registerMachine` carries a published recipient forward when the
      // file cannot be read. A self-check that asked the ROSTER would pass here
      // and address every file to a key this machine does not hold.
      writeFileSync(identityFilePath(), "# nothing usable in here\n", { mode: 0o600 });

      const refused = (await hubRekey({
        projectPath: s.projectA, hubPath: s.hub,
      })) as HubRekeyRefusedResult;
      expect(refused.success).toBe(false);
      expect(refused.reason).toBe("encryption-refused");
      expect(refused.refusal).toBe("self-unkeyed");
      expect(refused.suggestion).toMatch(/identity\.age/);
      // Nothing was touched — the refusal is taken before the first file.
      expect(hubBytes(s.hub, file).equals(before)).toBe(true);
    } finally {
      teardown(s);
    }
  });

  it("cannot recover this machine's own bundles once its key is replaced", async () => {
    // THE SECOND RESIDUAL, and the one most likely to be misread as a bug: a
    // re-wrap has to unwrap the file key first, so "rekey" is not a recovery
    // verb for the machine that lost the key. Nothing anywhere is.
    const s = sandbox("rotate");
    try {
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: s.homeA });
      await hubEncrypt({ hubPath: s.hub, enable: true, cwd: s.homeA });
      const pushed = (await hubPush({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      const file = (await ownBundleFiles(s.hub, pushed.projectId))[0]!;
      const before = hubBytes(s.hub, file);

      // A fresh, perfectly valid identity — the shape of a restored-from-
      // elsewhere or regenerated key file. The roster is refreshed with it by
      // the rekey's own `registerMachine`, so the self-check passes and the
      // failure lands where it belongs: on the file.
      writeFileSync(identityFilePath(), `${generateIdentity().identity}\n`, { mode: 0o600 });

      const out = (await hubRekey({ projectPath: s.projectA, hubPath: s.hub })) as HubRekeyResult;
      expect(out.success).toBe(true);
      expect(out.rewrapped).toEqual([]);
      expect(out.failed).toHaveLength(1);
      expect(out.failed[0]!.reason).toBe("no-matching-identity");
      expect(out.warnings.join(" ")).toMatch(/could not be opened by it/);
      // Untouched, so the bundle stays exactly as readable as it was — to
      // whoever else was a recipient.
      expect(hubBytes(s.hub, file).equals(before)).toBe(true);
    } finally {
      teardown(s);
    }
  });

  it("leaves a machine that never pushed with no way to reach a decommissioned machine's history", async () => {
    // THE RESIDUAL, DEMONSTRATED. A wrote the bundles and is gone; B joined
    // afterwards. B has every verb this plugin offers and none of them reaches
    // A's files, because only A held a key that opens them and only A may write
    // them. This test exists so that "name it, do not invent an authority to
    // work around it" is executable rather than a comment.
    const s = sandbox("gone");
    const homeB = mkdtempSync(join(tmpdir(), "sesh-rekey-gone-homeB-"));
    const projectB = mkdtempSync(join(tmpdir(), "sesh-rekey-gone-projB-"));
    let restore = s.restore;
    try {
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: s.homeA });
      await hubEncrypt({ hubPath: s.hub, enable: true, cwd: s.homeA });
      const pushed = (await hubPush({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      const file = (await ownBundleFiles(s.hub, pushed.projectId))[0]!;
      const before = hubBytes(s.hub, file);

      // A is decommissioned: its home, machine id and identity file are gone.
      // Its record stays on the hub — nothing in this codebase deletes one —
      // which is exactly the state a user finds.
      restore.restore();
      rmSync(s.homeA, { recursive: true, force: true });
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: homeB });
      writeLocalProjectId(projectB, {
        projectId: pushed.projectId,
        name: "proj-gone",
        createdAt: new Date().toISOString(),
        createdByMachine: "machine-a",
      });

      const blocked = (await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: s.hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      })) as ErrorResult;
      expect(blocked.success).toBe(false);
      expect(blocked.error).toMatch(/no identity matched any recipient stanza/);

      // B's own rekey is well-formed and useless: it re-addresses B's bundles,
      // and B has none. It does not, and must not, touch A's.
      const out = (await hubRekey({ projectPath: projectB, hubPath: s.hub })) as HubRekeyResult;
      expect(out.success).toBe(true);
      expect(out.scanned).toBe(0);
      expect(out.rewrapped).toEqual([]);
      expect(hubBytes(s.hub, file).equals(before)).toBe(true);

      // And the pull is still refused afterwards. The dead end is the point.
      const still = (await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: s.hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      })) as ErrorResult;
      expect(still.success).toBe(false);
      expect(still.error).toMatch(/no identity matched any recipient stanza/);
      // The suggestion names where the remedy lives, and that it is not here.
      expect(still.suggestion).toMatch(/Only the machine that wrote a bundle can re-address it/);
    } finally {
      restore.restore();
      teardown(s, [homeB, projectB]);
    }
  });

  it("discloses an un-keyed peer instead of refusing over it, unlike a push", async () => {
    // THE ONE PLACE THIS VERB DECIDES DIFFERENTLY FROM `hub push` over the same
    // census. A push writes its bundle once, so a machine left out of that one
    // recipient list is left out permanently and the push refuses. A rekey is
    // idempotent: the machine left out of THIS one is picked up by the next,
    // so refusing would block a strictly widening operation to prevent a loss
    // that does not happen.
    const s = sandbox("unkeyed");
    try {
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: s.homeA });
      await hubEncrypt({ hubPath: s.hub, enable: true, cwd: s.homeA });
      const pushed = (await hubPush({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.bundleEncrypted).toBe(true);

      plantMachine(s.hub, "keyless-peer-1", { ageRecipient: undefined });

      const out = (await hubRekey({ projectPath: s.projectA, hubPath: s.hub })) as HubRekeyResult;
      expect(out.success).toBe(true);
      expect(out.rewrapped).toHaveLength(1);
      expect(out.unkeyedMachines.map((m) => m.machineId)).toContain("keyless-peer-1");
      expect(out.warnings.join(" ")).toMatch(/keyless-peer-1/);
      // The disclosure has to say the thing that makes proceeding defensible.
      expect(out.warnings.join(" ")).toMatch(/idempotent/);
    } finally {
      teardown(s);
    }
  });

  it("reports a re-wrap that NARROWED the readership", async () => {
    // A rekey addresses a file to the roster as it stands, and the roster can
    // shrink — deleting a machines/<id>.json is the documented remedy for a
    // decommissioned machine blocking pushes. Which machines were dropped is
    // not recoverable (a stanza carries an ephemeral share, never a public
    // key), so the count is the whole of what can be said, and saying nothing
    // was the alternative.
    const s = sandbox("narrow");
    try {
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: s.homeA });
      plantMachine(s.hub, "peer-with-a-key", { ageRecipient: generateIdentity().recipient });
      await hubEncrypt({ hubPath: s.hub, enable: true, cwd: s.homeA });
      const pushed = (await hubPush({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.bundleEncrypted).toBe(true);
      const file = (await ownBundleFiles(s.hub, pushed.projectId))[0]!;

      rmSync(join(s.hub, "machines", "peer-with-a-key.json"), { force: true });

      const out = (await hubRekey({ projectPath: s.projectA, hubPath: s.hub })) as HubRekeyResult;
      expect(out.success).toBe(true);
      expect(out.rewrapped).toEqual([file]);
      expect(out.narrowed).toEqual([{ file, before: 2, after: 1 }]);
      expect(out.warnings.join(" ")).toMatch(/FEWER machines/);
    } finally {
      teardown(s);
    }
  });

  it("keeps going past a bundle it cannot open, and leaves that bundle exactly as it was", async () => {
    // PARTIAL FAILURE. Three bundles, the middle one damaged on the hub. The
    // contract is per file: each is replaced atomically or not at all, so a run
    // that trips in the middle leaves every file readable by someone — and
    // stopping at the first failure would abandon later bundles that are fine,
    // which is the opposite of what a repair verb is for.
    const s = sandbox("partial");
    try {
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: s.homeA });
      await hubEncrypt({ hubPath: s.hub, enable: true, cwd: s.homeA });
      const first = (await hubPush({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(first.success, JSON.stringify(first)).toBe(true);
      for (const n of [1, 2]) {
        extendSession(s.configDirA, s.projectA, n);
        const next = (await hubPush({
          configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
          noWorkspace: true, claudeVersion: CLAUDE_VERSION,
        })) as HubPushResult;
        expect(next.success, JSON.stringify(next)).toBe(true);
        expect(next.upToDate).toBe(false);
      }
      const files = await ownBundleFiles(s.hub, first.projectId);
      expect(files).toHaveLength(3);

      // Damage the MIDDLE bundle's header MAC line — one byte, in place, so the
      // file is the right length and only its authentication is wrong. That is
      // `ciphertext-rejected`, which is a different kind from "not addressed to
      // me", and the run must not confuse them.
      const middle = files[1]!;
      const path = join(s.hub, ...middle.split("/"));
      const bytes = readFileSync(path);
      const macAt = bytes.indexOf(Buffer.from("\n--- ", "utf-8")) + 6;
      bytes[macAt] = bytes[macAt] === 0x61 ? 0x62 : 0x61;
      writeFileSync(path, bytes);
      const damaged = readFileSync(path);

      const out = (await hubRekey({ projectPath: s.projectA, hubPath: s.hub })) as HubRekeyResult;
      expect(out.success).toBe(true);
      expect(out.scanned).toBe(3);
      // The two healthy ones on EITHER side of the failure, so this cannot pass
      // by stopping early.
      expect(out.rewrapped.sort()).toEqual(files.filter((f) => f !== middle).sort());
      expect(out.failed).toHaveLength(1);
      expect(out.failed[0]!.file).toBe(middle);
      expect(out.failed[0]!.reason).toBe("ciphertext-rejected");
      // ATOMIC: not half a header, not a truncated file — byte for byte what it
      // was before the attempt.
      expect(readFileSync(path).equals(damaged)).toBe(true);
      // And nothing was left behind for the hub's own listing to trip over.
      expect(out.warnings.join(" ")).toMatch(/atomically or not at all/);
    } finally {
      teardown(s);
    }
  });

  it("leaves plaintext bundles alone, and says so", async () => {
    // A hub that was never sealed. Nothing here can make these ciphertext: that
    // renames the file (every index records the name) and has to delete the
    // original, which belongs to the verbs that own removal.
    const s = sandbox("plain");
    try {
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: s.homeA });
      const pushed = (await hubPush({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.bundleEncrypted).toBe(false);
      const plainFile = (await ownBundleFiles(s.hub, pushed.projectId))[0]!;
      const before = hubBytes(s.hub, plainFile);

      const out = (await hubRekey({ projectPath: s.projectA, hubPath: s.hub })) as HubRekeyResult;
      expect(out.success).toBe(true);
      expect(out.rewrapped).toEqual([]);
      expect(out.skipped).toEqual([{ file: plainFile, reason: "plaintext" }]);
      expect(out.warnings.join(" ")).toMatch(/PLAINTEXT/);
      expect(hubBytes(s.hub, plainFile).equals(before)).toBe(true);
    } finally {
      teardown(s);
    }
  });

  it("refuses an unlinked project, and rekeys once a push with --create-project has linked it", async () => {
    const s = sandbox("unlinked");
    try {
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: s.homeA });
      await hubEncrypt({ hubPath: s.hub, enable: true, cwd: s.homeA });

      const refused = (await hubRekey({
        projectPath: s.projectA, hubPath: s.hub,
      })) as HubRekeyRefusedResult;
      expect(refused.success).toBe(false);
      expect(refused.reason).toBe("unlinked");
      expect(refused.suggestion).toMatch(/--create-project/);

      await hubPush({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      });
      const out = (await hubRekey({ projectPath: s.projectA, hubPath: s.hub })) as HubRekeyResult;
      expect(out.success).toBe(true);
      expect(out.rewrapped).toHaveLength(1);
    } finally {
      teardown(s);
    }
  });

  it("refuses while the project lock is held", async () => {
    const s = sandbox("lock");
    try {
      await hubInit({ hubPath: s.hub, configScope: "user", cwd: s.homeA });
      await hubPush({
        configDir: s.configDirA, projectPath: s.projectA, hubPath: s.hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      });
      const held = acquireProjectLock(s.projectA);
      try {
        const busy = await hubRekey({ projectPath: s.projectA, hubPath: s.hub });
        expect(busy.success).toBe(false);
        expect("reason" in busy && busy.reason).toBe("lock-busy");
      } finally {
        held.release();
      }
    } finally {
      teardown(s);
    }
  });
});

describe("checkSelfIsRecipient (pure)", () => {
  const keyed = (id: string, recipient: string) => ({ machineId: id, name: id, recipient });

  it("refuses when the roster does not publish the key this machine holds", () => {
    // The arm that cannot be reached end to end, because `hub rekey` and
    // `hub push` both call `registerMachine` immediately before reading the
    // roster — which is exactly why it is a belt: it fires when that write did
    // not land (a share that lost it, a sync conflict, a hand-edited record),
    // and without it every file the rekey touched would become unreadable to
    // the machine that wrote it, in bulk.
    const mine = generateIdentity();
    const theirs = generateIdentity();
    const out = checkSelfIsRecipient({
      census: { recipients: [keyed("me", theirs.recipient)], unkeyed: [] },
      thisMachineId: "me",
      thisMachineRecipient: mine.recipient,
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal).toBe("self-unkeyed");
    expect(!out.ok && out.error).toMatch(/does not publish the key this machine actually holds/);
  });

  it("accepts when this machine's own key is in the set, and returns the set whole", () => {
    const mine = generateIdentity();
    const peer = generateIdentity();
    const out = checkSelfIsRecipient({
      census: {
        recipients: [keyed("me", mine.recipient), keyed("peer", peer.recipient)],
        unkeyed: [{ machineId: "old", name: null, reason: "no-key" }],
      },
      thisMachineId: "me",
      thisMachineRecipient: mine.recipient,
    });
    expect(out.ok).toBe(true);
    // Un-keyed machines are NOT a refusal at this level — that decision belongs
    // to the caller, and the two callers make it differently.
    expect(out.ok && out.recipients).toEqual([mine.recipient, peer.recipient]);
  });

  it("refuses an empty recipient set rather than addressing a file to nobody", () => {
    const mine = generateIdentity();
    const out = checkSelfIsRecipient({
      census: { recipients: [], unkeyed: [] },
      thisMachineId: "me",
      thisMachineRecipient: mine.recipient,
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal).toBe("no-recipients");
  });
});
