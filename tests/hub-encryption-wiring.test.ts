/**
 * # Encryption at rest, wired into the bundle path (#91)
 *
 * `tests/crypto-age.test.ts` answers "does the crypto work" — against the real
 * `age` binary, because a defect in a helper shared by both directions
 * round-trips against itself perfectly. This file answers the separate question
 * "does the bundle path use it correctly", and the two are deliberately kept
 * apart.
 *
 * Four claims are load-bearing here, and each has a test whose failure would be
 * silent otherwise:
 *
 * 1. **A MIXED hub works.** Enabling encryption never rewrites an existing
 *    bundle, so plaintext and ciphertext live side by side forever and the
 *    reader must branch on the file SUFFIX. A reader that consulted local
 *    config or `hub.json` instead would pass every single-format test and
 *    strand exactly the migration case.
 * 2. **The three hash layers still verify across the round trip.** They are
 *    computed over PLAINTEXT during export and must be untouched by any of
 *    this.
 * 3. **A bundle we cannot decrypt is a TYPED refusal**, with a `suggestion`,
 *    not a throw — an uncaught throw out of the fetch stage costs the
 *    suggestion and every disclosure the chain already collected.
 * 4. **An un-keyed machine refuses the push**, and the override is a flag that
 *    the unattended auto-push can never take.
 */

import { describe, it, expect } from "vitest";
import {
  createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import {
  appendEntries, createRealProject, FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, plainEntries,
} from "./helpers/hub-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { hubPull } from "../src/hub/pull.js";
import { hubReindex } from "../src/hub/reindex.js";
import {
  hubEncrypt, isEncryptionCapableVersion, MIN_ENCRYPTION_PLUGIN_VERSION,
} from "../src/hub/encrypt.js";
import { collectHubRecipients, planBundleEncryption } from "../src/hub/encryption.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { createFsBackend } from "../src/hub/backend.js";
import { readAllIndexes } from "../src/hub/index-file.js";
import { isEncryptedBundleFile } from "../src/hub/layout.js";
import { extractArchive } from "../src/archiver.js";
import {
  computeIntegrityHashFromFile, computeLayerDigest, readManifest, verifySessionsDigest,
} from "../src/manifest.js";
import { AgeDecryptStream, generateIdentity, parseIdentity } from "../src/crypto/age.js";
import { HAVE_ORACLE, ORACLES, oracleDecrypt } from "./helpers/age-oracle.js";
import { identityFilePath } from "../src/crypto/identity-file.js";
import { readIdentityFile } from "../src/crypto/identity-file.js";
import { encodeProjectPath } from "../src/platform.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { readConfigOverrides } from "../src/config.js";
import { projectSeshMoverDir, userSeshMoverDir } from "../src/paths.js";
import { PLUGIN_VERSION } from "../src/version.js";
import type {
  ErrorResult, HubEncryptRefusedResult, HubEncryptResult, HubPullResult, HubPushResult,
} from "../src/types.js";

const CLAUDE_VERSION = "2.1.81";

/** A machine record planted directly on the hub — a peer this test never runs. */
function plantMachine(
  hub: string,
  id: string,
  over: Record<string, unknown> = {}
): void {
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

function readHubJson(hub: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(hub, "hub.json"), "utf-8")) as Record<string, unknown>;
}

/** Every bundle file on the hub, hub-relative, in push order. */
async function bundleFiles(hub: string, projectId: string): Promise<string[]> {
  const backend = createFsBackend(hub);
  const { indexes } = await readAllIndexes(backend, projectId);
  return indexes.flatMap((i) => Object.values(i.threads).flatMap((t) => t.bundles.map((b) => b.file)));
}

// ---------------------------------------------------------------------------
// The decision, on its own — no hub, no export, no archive
// ---------------------------------------------------------------------------

describe("planBundleEncryption (pure)", () => {
  const policy = (over = {}) => ({
    required: false, preferred: false, unappliedPreference: false, malformedSetting: false, ...over,
  });
  const keyed = (id: string) => ({
    machineId: id, name: id, recipient: generateIdentity().recipient,
  });

  it("an unsealed hub pushes plaintext and says nothing", () => {
    const plan = planBundleEncryption({
      policy: policy(),
      census: { recipients: [], unkeyed: [] },
      thisMachineId: "me",
      thisMachineRecipient: null,
      forceUnkeyed: false,
    });
    expect(plan.kind).toBe("plaintext");
    expect(plan.kind === "plaintext" && plan.warnings).toEqual([]);
  });

  it("an unapplied local preference is disclosed, never acted on", () => {
    const plan = planBundleEncryption({
      policy: policy({ preferred: true, unappliedPreference: true }),
      census: { recipients: [], unkeyed: [] },
      thisMachineId: "me",
      thisMachineRecipient: null,
      forceUnkeyed: false,
    });
    // NOT "encrypt": a machine that encrypted unilaterally would push bundles
    // the rest of the hub cannot read.
    expect(plan.kind).toBe("plaintext");
    expect(plan.kind === "plaintext" && plan.warnings.join(" ")).toMatch(/PLAINTEXT/);
  });

  it("refuses on an un-keyed machine, and --force-unkeyed proceeds while naming it", () => {
    const me = keyed("me");
    const census = {
      recipients: [me],
      unkeyed: [{ machineId: "laptop", name: "laptop", reason: "no-key" as const }],
    };
    const refused = planBundleEncryption({
      policy: policy({ required: true }), census, thisMachineId: "me",
      thisMachineRecipient: me.recipient, forceUnkeyed: false,
    });
    expect(refused.kind).toBe("refuse");
    expect(refused.kind === "refuse" && refused.refusal).toBe("unkeyed-machines");
    expect(refused.kind === "refuse" && refused.error).toMatch(/laptop/);

    const forced = planBundleEncryption({
      policy: policy({ required: true }), census, thisMachineId: "me",
      thisMachineRecipient: me.recipient, forceUnkeyed: true,
    });
    expect(forced.kind).toBe("encrypt");
    expect(forced.kind === "encrypt" && forced.recipients).toHaveLength(1);
    expect(forced.kind === "encrypt" && forced.warnings.join(" ")).toMatch(/laptop/);
  });

  it("refuses when THIS machine holds no key, and --force-unkeyed does not override it", () => {
    const census = {
      recipients: [keyed("other")],
      unkeyed: [{ machineId: "me", name: "me", reason: "no-key" as const }],
    };
    for (const forceUnkeyed of [false, true]) {
      const plan = planBundleEncryption({
        policy: policy({ required: true }), census, thisMachineId: "me",
        thisMachineRecipient: null, forceUnkeyed,
      });
      expect(plan.kind).toBe("refuse");
      // The discriminator, not `unkeyed.length`: the census is reported WHOLE,
      // so this refusal carries an entry and "empty means self" would be wrong.
      expect(plan.kind === "refuse" && plan.refusal).toBe("self-unkeyed");
      expect(plan.kind === "refuse" && plan.suggestion).toMatch(/identity\.age/);
    }
  });

  /**
   * THE ROSTER IS NOT THE SOURCE OF TRUTH FOR OUR OWN KEY, and this is the
   * measurement that says so. `registerMachine` carries a previously published
   * `ageRecipient` forward whenever the identity file cannot be read — correct
   * for every other machine, and it means the census can report THIS machine as
   * perfectly keyed while the key it names is one we no longer hold.
   *
   * A self-check that asked the census passes here, encrypts to a stanza nobody
   * on this machine can open, and fills the hub with bundles the machine that
   * wrote them can never read back. Nothing else in the system notices.
   */
  it("refuses when the hub lists a key for this machine that this machine does not hold", () => {
    const stalePublished = generateIdentity().recipient;
    const actuallyHeld = generateIdentity().recipient;
    for (const forceUnkeyed of [false, true]) {
      const plan = planBundleEncryption({
        policy: policy({ required: true }),
        // The roster looks HEALTHY: nothing is un-keyed, and this machine has a
        // recipient. It is simply the wrong one.
        census: {
          recipients: [{ machineId: "me", name: "me", recipient: stalePublished }],
          unkeyed: [],
        },
        thisMachineId: "me",
        thisMachineRecipient: actuallyHeld,
        forceUnkeyed,
      });
      expect(plan.kind).toBe("refuse");
      expect(plan.kind === "refuse" && plan.refusal).toBe("self-unkeyed");
      expect(plan.kind === "refuse" && plan.error).toMatch(/does not publish the key this machine actually holds/);
    }
  });

  it("refuses an empty recipient list whatever the flags say", () => {
    const me = keyed("me");
    // BOTH flag values, not just the override. With only `true` tested, moving
    // the guard behind `&& input.forceUnkeyed` survives: control then falls
    // through to `kind: "encrypt"` with an EMPTY recipient list, and the throw
    // lands mid-upload inside `bundleEncryptStream` where a typed refusal was
    // promised. That is the one route to `bundle-io.ts`'s "the throw is the
    // belt", and a belt is not a test.
    for (const forceUnkeyed of [false, true]) {
      const plan = planBundleEncryption({
        policy: policy({ required: true }),
        census: { recipients: [], unkeyed: [] },
        thisMachineId: "me",
        // A readable local key, so this is genuinely "the hub has no keys"
        // rather than "this machine has none" — the two are ordered
        // deliberately and each has its own refusal.
        thisMachineRecipient: me.recipient,
        forceUnkeyed,
      });
      expect(plan.kind).toBe("refuse");
      expect(plan.kind === "refuse" && plan.refusal).toBe("no-recipients");
      expect(plan.kind === "refuse" && plan.error).toMatch(/nobody to encrypt to/);
    }
  });

  it("a malformed hub.json setting encrypts and says so", () => {
    const me = keyed("me");
    const plan = planBundleEncryption({
      policy: policy({ required: true, malformedSetting: true }),
      census: { recipients: [me], unkeyed: [] },
      thisMachineId: "me",
      thisMachineRecipient: me.recipient,
      forceUnkeyed: false,
    });
    expect(plan.kind).toBe("encrypt");
    expect(plan.kind === "encrypt" && plan.warnings.join(" ")).toMatch(/neither true nor false/);
  });

  it("a refusal still carries the disclosures collected before it", () => {
    const me = keyed("me");
    // The malformed setting is WHY encryption was required at all, so a refusal
    // that reports the un-keyed machine and drops this note explains the symptom
    // and hides the cause. A refusal is not a reason to withhold what happened.
    const plan = planBundleEncryption({
      policy: policy({ required: true, malformedSetting: true }),
      census: {
        recipients: [me],
        unkeyed: [{ machineId: "laptop", name: "laptop", reason: "no-key" as const }],
      },
      thisMachineId: "me",
      thisMachineRecipient: me.recipient,
      forceUnkeyed: false,
    });
    expect(plan.kind).toBe("refuse");
    expect(plan.kind === "refuse" && plan.warnings.join(" ")).toMatch(/neither true nor false/);
  });
});

describe("isEncryptionCapableVersion", () => {
  it("treats an absent or unparseable version as too old", () => {
    expect(isEncryptionCapableVersion(undefined)).toBe(false);
    expect(isEncryptionCapableVersion("")).toBe(false);
    expect(isEncryptionCapableVersion("nightly")).toBe(false);
    // Explicitly, rather than through compareVersions' NaN arithmetic: a gate
    // whose safe direction depends on how `NaN >= 0` evaluates is unreadable.
    expect(isEncryptionCapableVersion("0.10.0-rc1")).toBe(false);
  });

  it("accepts the floor and anything above it, rejects below", () => {
    expect(isEncryptionCapableVersion(MIN_ENCRYPTION_PLUGIN_VERSION)).toBe(true);
    expect(isEncryptionCapableVersion("0.9.0")).toBe(false);
    expect(isEncryptionCapableVersion("0.9.99")).toBe(false);
    expect(isEncryptionCapableVersion("1.0.0")).toBe(true);
    // The running build implements encryption, so the floor may never rise
    // above it — that combination would make the feature unreachable.
    expect(isEncryptionCapableVersion(PLUGIN_VERSION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hub encrypt
// ---------------------------------------------------------------------------

describe("hub encrypt", () => {
  it("reports without writing, then --enable seals the hub, preserves unknown fields, and says what enabling does NOT do", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      // A field this version knows nothing about. `hub.json` is the one hub file
      // no machine owns, so an enable must patch it in place rather than
      // rebuilding it from `HubJson` and dropping whatever a newer plugin wrote.
      const planted = readHubJson(hub);
      planted.somethingNewerWrote = { keep: "me" };
      writeFileSync(join(hub, "hub.json"), JSON.stringify(planted, null, 2) + "\n");

      // Wipe the roster, so the recipient assertion below can only pass if THIS
      // verb registers before it reads. `hub init` registered a moment ago, so
      // without this the assertion would be satisfied by that earlier write and
      // would prove nothing about `hubEncrypt`.
      rmSync(join(hub, "machines"), { recursive: true, force: true });

      const read = (await hubEncrypt({ hubPath: hub, cwd: home })) as HubEncryptResult;
      expect(read.success).toBe(true);
      expect(read.enabled).toBe(false);
      expect(read.changed).toBe(false);
      // The LOCAL preference, not a copy of the hub's setting. It was
      // initialised from `enabled` and never consulted config at all, which made
      // a security-facing field report the wrong subject entirely.
      expect(read.preference).toBe(false);
      const claiming = (await hubEncrypt({
        hubPath: hub, cwd: home, preference: true,
      })) as HubEncryptResult;
      expect(claiming.enabled).toBe(false);
      expect(claiming.preference).toBe(true);
      expect(readHubJson(hub).encrypt).toBe(false);
      expect(read.recipients).toHaveLength(1);

      const enabled = (await hubEncrypt({ hubPath: hub, enable: true, cwd: home })) as HubEncryptResult;
      expect(enabled.success).toBe(true);
      expect(enabled.enabled).toBe(true);
      expect(enabled.changed).toBe(true);
      expect(readHubJson(hub).encrypt).toBe(true);
      expect(readHubJson(hub).somethingNewerWrote).toEqual({ keep: "me" });
      // The statement a user will otherwise assume the opposite of.
      expect(enabled.warnings.join(" ")).toMatch(/GOING FORWARD/);
      expect(enabled.warnings.join(" ")).toMatch(/readable by anyone with read access/);
      // And the claim that must not be overstated: group, not sender.
      expect(enabled.warnings.join(" ")).toMatch(/the group, not the sender/);
      // This machine is a recipient of what comes next without needing a push
      // first — `hubEncrypt` registers before it reads the roster.
      // The VALUE, not just the count. `.map(...).toHaveLength(1)` is invariant
      // under the map, so it passes even if `machineId` is filled with the age
      // public key — which would publish a recipient in a field callers treat as
      // an identifier.
      expect(enabled.recipients).toEqual([
        { machineId: loadOrCreateMachineId().id, name: expect.any(String) },
      ]);
      // And the local PREFERENCE is written through, read back off disk rather
      // than taken from the result (which could report it without storing it).
      expect(readConfigOverrides(userSeshMoverDir())).toMatchObject({
        hub: { encrypt: true },
      });

      // A second --enable is a no-op that must not re-announce anything: the
      // forward-only statement is about a transition, and repeating it on every
      // invocation is how a load-bearing warning becomes noise people skip.
      const again = (await hubEncrypt({ hubPath: hub, enable: true, cwd: home })) as HubEncryptResult;
      expect(again.success).toBe(true);
      expect(again.enabled).toBe(true);
      expect(again.changed).toBe(false);
      expect(again.warnings.join(" ")).not.toMatch(/GOING FORWARD/);
    } finally {
      restore.restore();
      for (const d of [home, hub]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * `preference` moves only when the write LANDS.
   *
   * Setting it before the call and leaving it set is the shape that looks
   * harmless and is not: the hub write has already succeeded, so this command
   * correctly reports success, and a `preference: true` beside it claims a local
   * record that does not exist. A later `configure --show` then disagrees with
   * the result the user was just shown, on a security-facing field.
   */
  it("does not claim the local preference was recorded when the config write fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const proj = mkdtempSync(join(tmpdir(), "sesh-enc-proj-"));
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      // A FILE where `<project>/.sesh-mover/` needs to be a directory, so the
      // preference write fails while everything else succeeds.
      writeFileSync(join(proj, ".sesh-mover"), "");

      const out = (await hubEncrypt({
        hubPath: hub, enable: true, configScope: "project", cwd: proj, preference: false,
      })) as HubEncryptResult;

      // The hub-wide switch is the authority and it DID land — this is not a
      // failure of the command.
      expect(out.success).toBe(true);
      expect(out.enabled).toBe(true);
      expect(out.changed).toBe(true);
      expect(readHubJson(hub).encrypt).toBe(true);
      // ...but the local preference did not, and the result says so rather than
      // reporting the value it intended to write.
      expect(out.preference).toBe(false);
      expect(out.warnings.join(" ")).toMatch(/local hub.encrypt preference could not be recorded/);
    } finally {
      restore.restore();
      for (const d of [home, hub, proj]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("--scope project records the preference under the project it was given, not the cwd", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const proj = mkdtempSync(join(tmpdir(), "sesh-enc-proj-"));
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const enabled = (await hubEncrypt({
        hubPath: hub, enable: true, configScope: "project", cwd: proj,
      })) as HubEncryptResult;
      expect(enabled.success).toBe(true);
      // Under the project it was handed. Writing it under `process.cwd()`
      // instead records the preference in a scope the next command reads a
      // different file for — silently, and only when both --project-path and
      // --scope project are given.
      expect(readConfigOverrides(projectSeshMoverDir(proj))).toMatchObject({
        hub: { encrypt: true },
      });
      expect(readConfigOverrides(userSeshMoverDir())).not.toMatchObject({
        hub: { encrypt: true },
      });
    } finally {
      restore.restore();
      for (const d of [home, hub, proj]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * ONE READER FOR THE SWITCH, and this is the case where two would disagree.
   *
   * `resolveHubEncryption` resolves a malformed `encrypt` toward encryption,
   * because a hand-edited `"true"` read as `false` is the silent confidentiality
   * loss the field exists to prevent. A `hub encrypt` that read
   * `hubRaw.encrypt === true` for itself would then answer `enabled: false` —
   * the verb a user runs to ASK would be the one thing on the hub that
   * disagreed with every push.
   */
  it("reports a malformed hub.json setting the same way a push reads it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const planted = readHubJson(hub);
      planted.encrypt = "true"; // a string, from a hand edit
      writeFileSync(join(hub, "hub.json"), JSON.stringify(planted, null, 2) + "\n");

      const read = (await hubEncrypt({ hubPath: hub, cwd: home })) as HubEncryptResult;
      expect(read.success).toBe(true);
      expect(read.enabled).toBe(true);
      expect(read.warnings.join(" ")).toMatch(/neither true nor false/);

      // And the push agrees, which is the property being pinned: the two read
      // the field through the same function.
      const pushed = (await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, noWorkspace: true,
        claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.success).toBe(true);
      expect(pushed.bundleEncrypted).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("--enable refuses while a registered machine is on a version that predates encryption, and names it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      plantMachine(hub, "11111111-1111-4111-8111-111111111111", {
        name: "old-desktop",
        pluginVersion: "0.9.0",
        ageRecipient: generateIdentity().recipient,
      });
      // A record with no version at all — the common real case, since the field
      // postdates most hubs.
      plantMachine(hub, "22222222-2222-4222-8222-222222222222", {
        name: "ancient",
        pluginVersion: undefined,
        ageRecipient: generateIdentity().recipient,
      });
      // A peer on a CURRENT version. Without it the roster scan's "skip the
      // capable ones" step is never exercised, so a scan that reported every
      // registered machine as stale would pass unnoticed.
      plantMachine(hub, "55555555-5555-4555-8555-555555555555", {
        name: "up-to-date-peer",
        ageRecipient: generateIdentity().recipient,
      });

      const refused = (await hubEncrypt({
        hubPath: hub, enable: true, cwd: home,
      })) as HubEncryptRefusedResult;
      expect(refused.success).toBe(false);
      expect(refused.reason).toBe("stale-machines");
      expect(refused.error).toMatch(/old-desktop/);
      expect(refused.error).toMatch(/ancient/);
      expect(refused.error).not.toMatch(/up-to-date-peer/);
      expect(refused.staleMachines).toHaveLength(2);
      // Both shapes of "too old", and the second one is the common real case:
      // the field postdates most hubs, so a machine that has not checked in
      // since it was added records nothing at all.
      expect(refused.staleMachines.map((m) => m.pluginVersion)).toContain("0.9.0");
      expect(refused.staleMachines.map((m) => m.pluginVersion)).toContain(null);
      // Refused means NOTHING changed.
      expect(readHubJson(hub).encrypt).toBe(false);

      // The remedy the refusal names, applied: the stale records are gone.
      rmSync(join(hub, "machines", "11111111-1111-4111-8111-111111111111.json"));
      rmSync(join(hub, "machines", "22222222-2222-4222-8222-222222222222.json"));
      // The capable peer stays — the remedy is about the stale records only.
      const enabled = (await hubEncrypt({ hubPath: hub, enable: true, cwd: home })) as HubEncryptResult;
      expect(enabled.success).toBe(true);
      expect(readHubJson(hub).encrypt).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub]) rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

describe("hub push into a sealed hub", () => {
  it("refuses to push into a sealed hub when a registered machine publishes no key, and --force-unkeyed uploads anyway", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      // Current plugin version, so the enable gate passes — but no published
      // key, which is the fact the push has to act on.
      plantMachine(hub, "33333333-3333-4333-8333-333333333333", { name: "keyless" });
      const sealed = (await hubEncrypt({ hubPath: hub, enable: true, cwd: home })) as HubEncryptResult;
      expect(sealed.success).toBe(true);
      expect(sealed.unkeyedMachines.map((m) => m.machineId)).toEqual([
        "33333333-3333-4333-8333-333333333333",
      ]);

      const pushOpts = {
        configDir, projectPath, hubPath: hub, createProject: true,
        noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      };
      const refused = await hubPush(pushOpts);
      expect(refused.success).toBe(false);
      expect("reason" in refused && refused.reason).toBe("encryption-refused");
      expect("refusal" in refused && refused.refusal).toBe("unkeyed-machines");
      expect("error" in refused && refused.error).toMatch(/keyless/);
      expect("unkeyedMachines" in refused && refused.unkeyedMachines.map((m) => m.reason)).toEqual([
        "no-key",
      ]);
      // Refused BEFORE anything happened: no hub project, no bundle, and above
      // all NO LOCAL LINK — which is the consent gate that arms the default-on
      // SessionEnd auto-push, so it is asserted directly rather than inferred
      // from the hub being empty.
      expect(readdirSync(hub).includes("projects")).toBe(false);
      expect(existsSync(join(projectPath, ".sesh-mover-project.json"))).toBe(false);

      const forced = (await hubPush({ ...pushOpts, forceUnkeyed: true })) as HubPushResult;
      expect(forced.success).toBe(true);
      expect(forced.bundleEncrypted).toBe(true);
      expect(forced.warnings.join(" ")).toMatch(/--force-unkeyed/);
      expect(forced.warnings.join(" ")).toMatch(/keyless/);
      const files = await bundleFiles(hub, forced.projectId);
      expect(files).toHaveLength(1);
      expect(isEncryptedBundleFile(files[0])).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * THE LIVE HOLE, and the fixture that actually reaches it.
   *
   * The sibling test below breaks the identity file BEFORE this machine ever
   * registers, so the hub simply has no key for it and the census reports it as
   * `unkeyed`. That steps around the real hazard: `registerMachine` deliberately
   * CARRIES FORWARD a previously published `ageRecipient` whenever the identity
   * file cannot be read this run — right for every other machine, since a
   * transient read failure must not de-register us as a recipient — which means
   * that after ONE good registration the roster keeps saying we are keyed long
   * after the key is gone.
   *
   * So a self-check that asked the census passes here, encrypts to a stanza
   * nobody on this machine can open, and reports `success: true,
   * bundleEncrypted: true`. Measured: that is exactly what it did before the
   * check was made positive and local.
   */
  it("refuses when the key is lost AFTER registration, even though the hub still lists one for this machine", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir, "projA");
      // A good key, published by a real registration.
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      await hubEncrypt({ hubPath: hub, enable: true, cwd: home });
      const record = JSON.parse(
        readFileSync(join(hub, "machines", `${loadOrCreateMachineId().id}.json`), "utf-8")
      ) as { ageRecipient?: string };
      expect(record.ageRecipient).toMatch(/^age1/);

      // ...and now it is gone. The roster is untouched and still says otherwise.
      writeFileSync(join(home, ".sesh-mover", "identity.age"), "# no key line\n");

      const pushOpts = {
        configDir, projectPath, hubPath: hub, createProject: true,
        noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      };
      for (const forceUnkeyed of [false, true]) {
        const result = await hubPush({ ...pushOpts, forceUnkeyed });
        expect(result.success).toBe(false);
        expect("reason" in result && result.reason).toBe("encryption-refused");
        expect("refusal" in result && result.refusal).toBe("self-unkeyed");
        // The roster genuinely still lists this machine as a recipient — which
        // is why a census-based check passes and this one must not.
        expect(
          (await collectHubRecipients(createFsBackend(hub))).recipients.map((r) => r.machineId)
        ).toContain(loadOrCreateMachineId().id);
        expect(existsSync(join(projectPath, ".sesh-mover-project.json"))).toBe(false);
      }
      expect(readdirSync(hub).includes("projects")).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("refuses when THIS machine publishes no key, and --force-unkeyed does not rescue it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir, "projA");
      // Break this machine's identity BEFORE it ever registers, so there is no
      // previously published recipient for `registerMachine` to carry forward.
      mkdirSync(join(home, ".sesh-mover"), { recursive: true });
      writeFileSync(join(home, ".sesh-mover", "identity.age"), "not-a-key\n");

      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      // Someone else can be encrypted to, so this is not the empty-list case.
      plantMachine(hub, "44444444-4444-4444-8444-444444444444", {
        name: "peer", ageRecipient: generateIdentity().recipient,
      });
      await hubEncrypt({ hubPath: hub, enable: true, cwd: home });

      const pushOpts = {
        configDir, projectPath, hubPath: hub, createProject: true,
        noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      };
      for (const forceUnkeyed of [false, true]) {
        const result = await hubPush({ ...pushOpts, forceUnkeyed });
        expect(result.success).toBe(false);
        expect(existsSync(join(projectPath, ".sesh-mover-project.json"))).toBe(false);
        expect("reason" in result && result.reason).toBe("encryption-refused");
        expect("refusal" in result && result.refusal).toBe("self-unkeyed");
        // The census is reported WHOLE, so this refusal is NOT distinguishable
        // by an empty `unkeyedMachines` — which is exactly why `refusal` exists.
        expect("unkeyedMachines" in result && result.unkeyedMachines.length).toBeGreaterThan(0);
        expect("suggestion" in result && result.suggestion).toMatch(/not overridable/);
      }
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The PREFERENCE half of the feature, end to end.
   *
   * `hub.encrypt` in config is not the switch, and the only thing a push does
   * with it is disclose the gap: this machine wants encryption and the hub does
   * not require it. That disclosure is the entire behaviour of the key, so
   * without a test the whole preference path — config → `hubPush` option →
   * `resolveHubEncryption` → warning — can be severed and nothing notices.
   */
  it("an unsealed hub still pushes plaintext when this machine prefers encryption, and says so", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const pushed = (await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, noWorkspace: true,
        claudeVersion: CLAUDE_VERSION,
        // What `cli.ts` passes from `config.hub.encrypt`.
        encryptPreference: true,
      })) as HubPushResult;
      expect(pushed.success).toBe(true);
      // NOT encrypted. A machine that encrypted unilaterally would push bundles
      // the rest of the hub cannot read, so the preference is disclosed and
      // never acted on.
      expect(pushed.bundleEncrypted).toBe(false);
      const [file] = await bundleFiles(hub, pushed.projectId);
      expect(isEncryptedBundleFile(file)).toBe(false);
      expect(pushed.warnings.join(" ")).toMatch(/prefers encryption at rest but this hub is not sealed/);
      expect(pushed.warnings.join(" ")).toMatch(/hub encrypt --enable/);

      // And with the preference off, the same push says nothing at all about it.
      appendEntries(
        sessionJsonlPath(configDir, projectPath),
        plainEntries(FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, projectPath)
      );
      const quiet = (await hubPush({
        configDir, projectPath, hubPath: hub, noWorkspace: true,
        claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(quiet.success).toBe(true);
      expect(quiet.warnings.join(" ")).not.toMatch(/prefers encryption at rest/);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * `hub reindex` REFUSES rather than skipping a bundle it cannot open, and the
   * distinction is the whole character of a repair tool: an index rebuilt
   * without this machine's own encrypted bundles references none of its work,
   * publishes that to every other machine, and reports success. The comment in
   * `reindex.ts` argues exactly this; swapping its `throw` for a `continue` is
   * the defect it argues against, and nothing else in the suite sees it.
   */
  it("hub reindex refuses outright when it cannot open one of this machine's own bundles", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      await hubEncrypt({ hubPath: hub, enable: true, cwd: home });
      const pushed = (await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true, noWorkspace: true,
        claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.bundleEncrypted).toBe(true);

      // Key loss: a fresh identity cannot open what the old one sealed.
      writeFileSync(
        join(home, ".sesh-mover", "identity.age"),
        `${generateIdentity().identity}\n`,
        { mode: 0o600 }
      );
      const backend = createFsBackend(hub);
      const indexRel = `projects/${pushed.projectId}/index/${loadOrCreateMachineId().id}.json`;
      await backend.delete(indexRel);

      await expect(
        hubReindex({ configDir, projectPath, hubPath: hub })
      ).rejects.toThrow(/no identity matched any recipient stanza/);
      // And it wrote nothing: a partial index that omits this machine's own
      // bundles is worse than the missing one it was asked to rebuild.
      expect(await backend.exists(indexRel)).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("all three hash layers still verify after an encrypt/decrypt round trip", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    const work = mkdtempSync(join(tmpdir(), "sesh-enc-work-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      await hubEncrypt({ hubPath: hub, enable: true, cwd: home });

      const pushed = (await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true,
        noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.success).toBe(true);
      expect(pushed.bundleEncrypted).toBe(true);

      const [file] = await bundleFiles(hub, pushed.projectId);
      expect(isEncryptedBundleFile(file)).toBe(true);

      // Decrypt with this machine's own identity, by hand rather than through
      // the pull, so what is verified below is the ARCHIVE the push wrote and
      // not something a later stage re-derived.
      const key = readIdentityFile();
      expect(key.state).toBe("present");
      if (key.state !== "present") return;
      const tar = join(work, "bundle.tar.gz");
      await pipeline(
        await createFsBackend(hub).readStream(file),
        new AgeDecryptStream(parseIdentity(key.identity)),
        createWriteStream(tar)
      );
      const dir = join(work, "extracted");
      mkdirSync(dir, { recursive: true });
      await extractArchive(tar, dir);

      const manifest = readManifest(dir);
      // Layer 3: the whole session inventory.
      expect(verifySessionsDigest(manifest)).toBeNull();
      expect(manifest.sessions.length).toBeGreaterThan(0);
      for (const s of manifest.sessions) {
        // Layer 1: the transcript itself.
        expect(await computeIntegrityHashFromFile(join(dir, "sessions", `${s.sessionId}.jsonl`))).toBe(
          s.integrityHash
        );
        // Layer 2: one aggregate per auxiliary layer. The fixture carries all
        // three, so an empty `layerDigests` here would make this vacuous.
        expect(Object.keys(s.layerDigests ?? {}).length).toBeGreaterThan(0);
        for (const [layer, digest] of Object.entries(s.layerDigests ?? {})) {
          const layerDir =
            layer === "file-history"
              ? join(dir, "file-history", s.sessionId)
              : join(dir, "sessions", s.sessionId, layer);
          expect(await computeLayerDigest(layerDir)).toBe(digest);
        }
      }
    } finally {
      restore.restore();
      for (const d of [home, hub, base, work]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("hub reindex rebuilds an index across a mixed bundle list", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });

      const first = (await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true,
        noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(first.bundleEncrypted).toBe(false);

      await hubEncrypt({ hubPath: hub, enable: true, cwd: home });
      appendEntries(
        sessionJsonlPath(configDir, projectPath),
        plainEntries(FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, projectPath)
      );
      const second = (await hubPush({
        configDir, projectPath, hubPath: hub, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(second.bundleEncrypted).toBe(true);

      // Throw the index away, exactly as the repair tool's premise assumes.
      const backend = createFsBackend(hub);
      const { indexes } = await readAllIndexes(backend, first.projectId);
      for (const i of indexes) {
        await backend.delete(`projects/${first.projectId}/index/${i.machineId}.json`);
      }

      const rebuilt = await hubReindex({ configDir, projectPath, hubPath: hub });
      expect(rebuilt.success).toBe(true);
      // BOTH spellings parsed: a `BUNDLE_FILE_RE` that recognised only
      // `.tar.gz` would silently drop half this machine's history from the very
      // index it is repairing, and would report no error at all.
      const files = await bundleFiles(hub, first.projectId);
      expect(files.filter((f) => isEncryptedBundleFile(f))).toHaveLength(1);
      expect(files.filter((f) => !isEncryptedBundleFile(f))).toHaveLength(1);
    } finally {
      restore.restore();
      for (const d of [home, hub, base]) rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The escape hatch, against the real binary
// ---------------------------------------------------------------------------

/**
 * The reason the wire format is age's rather than ours is a promise made to the
 * user: **a bundle is recoverable with this plugin uninstalled.** `age -d -i
 * ~/.sesh-mover/identity.age <bundle>.tar.gz.age` has to work.
 *
 * `tests/crypto-age.test.ts` proves the STREAM is age-compatible. It does not
 * prove this, because it never involves the identity FILE this plugin writes or
 * a bundle a push actually produced — the two ends of the promise. A defect in
 * either (a key file only this plugin can parse, a bundle encrypted to the wrong
 * public half) round-trips through our own code perfectly and breaks the escape
 * hatch silently. So this is differential, and it skips loudly with the rest.
 */
describe.skipIf(!HAVE_ORACLE)("the standard-tool escape hatch", () => {
  // ONE `it`, iterating the oracles inside, rather than `it.each(ORACLES)`.
  // With no oracle installed `it.each([])` registers ZERO tests, so the suite
  // total simply does not move and the absence is invisible in the count — the
  // exact silent skip `announceOracleAvailability` exists to prevent. This shape
  // registers one test that reports as SKIPPED.
  it("every installed age implementation decrypts a pushed bundle using the identity file as written", async () => {
    expect(ORACLES.length).toBeGreaterThan(0);
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    const work = mkdtempSync(join(tmpdir(), "sesh-enc-work-"));
    const restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectPath = createRealProject(base, configDir, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      await hubEncrypt({ hubPath: hub, enable: true, cwd: home });
      const pushed = (await hubPush({
        configDir, projectPath, hubPath: hub, createProject: true,
        noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.bundleEncrypted).toBe(true);

      const [file] = await bundleFiles(hub, pushed.projectId);
      // The identity file EXACTLY as this plugin wrote it — comment lines and
      // all — handed to the standard binary with no massaging. That is the
      // promise; anything else would be testing a different file.
      const keyFile = identityFilePath();
      for (const { name, bin } of ORACLES) {
        const plain = oracleDecrypt(bin, keyFile, join(hub, ...file.split("/")));
        expect([plain[0], plain[1]], `${name}: not a gzip archive`).toEqual([0x1f, 0x8b]);

        const tar = join(work, `recovered-${name}.tar.gz`);
        writeFileSync(tar, plain);
        const dir = join(work, `recovered-${name}`);
        mkdirSync(dir, { recursive: true });
        await extractArchive(tar, dir);
        const manifest = readManifest(dir);
        expect(verifySessionsDigest(manifest)).toBeNull();
        expect(manifest.sessions.length).toBeGreaterThan(0);
        for (const s of manifest.sessions) {
          expect(
            await computeIntegrityHashFromFile(join(dir, "sessions", `${s.sessionId}.jsonl`))
          ).toBe(s.integrityHash);
        }
      }
    } finally {
      restore.restore();
      for (const d of [home, hub, base, work]) rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// pull — the migration story
// ---------------------------------------------------------------------------

describe("hub pull from a mixed hub", () => {
  it("pulls a thread whose first bundle is plaintext and whose second is encrypted, choosing by suffix", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-enc-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-enc-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      // 1. A pushes PLAINTEXT, before the hub is sealed.
      const first = (await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(first.success).toBe(true);
      expect(first.bundleEncrypted).toBe(false);

      // 2. B joins the hub — registration alone, no pull. This is what puts B's
      //    public key on the hub, and it has to happen BEFORE A's encrypted
      //    push: a bundle is encrypted once and never re-wrapped, so a machine
      //    absent from the recipient list at write time is locked out forever.
      restore.restore();
      restore = overrideHome(homeB);
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeB });

      // 3. A seals the hub and pushes a CONTINUATION of the same thread.
      restore.restore();
      restore = overrideHome(homeA);
      const sealed = (await hubEncrypt({ hubPath: hub, enable: true, cwd: homeA })) as HubEncryptResult;
      expect(sealed.success).toBe(true);
      expect(sealed.recipients).toHaveLength(2);
      expect(sealed.unkeyedMachines).toEqual([]);

      appendEntries(
        sessionJsonlPath(configDirA, projectA),
        plainEntries(FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, projectA)
      );
      const second = (await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(second.success).toBe(true);
      expect(second.bundleEncrypted).toBe(true);

      // The hub is genuinely MIXED, and the two files differ only in suffix.
      const files = await bundleFiles(hub, first.projectId);
      expect(files).toHaveLength(2);
      expect(files.filter(isEncryptedBundleFile)).toHaveLength(1);
      expect(files.filter((f) => !isEncryptedBundleFile(f))).toHaveLength(1);
      // And the encrypted one really is ciphertext, not a renamed tarball: age
      // files begin with the v1 header line, gzip with 0x1f 0x8b.
      const enc = readFileSync(join(hub, ...files.filter(isEncryptedBundleFile)[0].split("/")));
      expect(enc.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
      const plain = readFileSync(join(hub, ...files.filter((f) => !isEncryptedBundleFile(f))[0].split("/")));
      expect([plain[0], plain[1]]).toEqual([0x1f, 0x8b]);

      // 4. B pulls the WHOLE chain in one go. Both bundles, one suffix each.
      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), "sesh-enc-projB-"));
      writeLocalProjectId(projectB, {
        projectId: first.projectId,
        name: "projA",
        createdAt: new Date().toISOString(),
        createdByMachine: "machine-a",
      });

      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;
      // One session out of the plaintext full bundle...
      expect(p.importedSessions).toHaveLength(1);
      // ...extended by the encrypted continuation, spliced onto it rather than
      // landing as a second session.
      expect(p.appended ?? []).toHaveLength(1);

      const projectFiles = readdirSync(
        join(configDirB, "projects", encodeProjectPath(projectB))
      ).filter((f) => f.endsWith(".jsonl"));
      expect(projectFiles).toHaveLength(1);
      const lines = readFileSync(
        join(configDirB, "projects", encodeProjectPath(projectB), projectFiles[0]),
        "utf-8"
      )
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { uuid?: string });
      expect(lines.map((l) => l.uuid)).toEqual([
        "entry-1", "entry-2", "entry-3", "b-entry-4", "b-entry-5",
      ]);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("distinguishes 'this machine has no usable key' from 'this machine is not a recipient'", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-enc-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-enc-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      // B joins first, so it IS a recipient — which is what makes the two
      // diagnoses distinguishable at all. Break its key file afterwards.
      restore.restore();
      restore = overrideHome(homeB);
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeB });

      restore.restore();
      restore = overrideHome(homeA);
      await hubEncrypt({ hubPath: hub, enable: true, cwd: homeA });
      const pushed = (await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.bundleEncrypted).toBe(true);

      restore.restore();
      restore = overrideHome(homeB);
      // The key file is unreadable, not missing from the recipient list. The
      // key may be perfectly intact behind a permission problem, so the remedy
      // is local — and it is a different remedy from "you were never addressed".
      writeFileSync(join(homeB, ".sesh-mover", "identity.age"), "# comment only\n");
      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), "sesh-enc-projB-"));
      writeLocalProjectId(projectB, {
        projectId: pushed.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });

      const pull = (await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      })) as ErrorResult;
      expect(pull.success).toBe(false);
      expect(pull.error).toMatch(/identity\.age is unreadable \(malformed\)/);
      expect(pull.suggestion).toMatch(/different situation from not being one of its recipients/);
      // And NOT the other diagnosis, whose remedy lives on another machine.
      expect(pull.suggestion ?? "").not.toMatch(/never re-wrapped in place/);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("a flipped byte inside the ciphertext is caught by the AEAD, not mistaken for a transfer fault", async () => {
    const home = mkdtempSync(join(tmpdir(), "sesh-enc-home-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-enc-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(home);
    try {
      const { configDir } = createFixtureTree(base);
      const projectA = createRealProject(base, configDir, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      restore.restore();
      restore = overrideHome(homeB);
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeB });
      restore.restore();
      restore = overrideHome(home);
      await hubEncrypt({ hubPath: hub, enable: true, cwd: home });
      const pushed = (await hubPush({
        configDir, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;

      // Flip one byte well past the header, i.e. inside the STREAM payload.
      // gzip's CRC32 is what makes a damaged plaintext bundle loud; here the
      // per-chunk AEAD tag is, and it is strictly stronger — it cannot be
      // recomputed by whoever flipped the byte.
      const [file] = await bundleFiles(hub, pushed.projectId);
      const abs = join(hub, ...file.split("/"));
      const bytes = readFileSync(abs);
      const at = bytes.length - 40;
      bytes[at] = bytes[at] ^ 0xff;
      writeFileSync(abs, bytes);

      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), "sesh-enc-projB-"));
      writeLocalProjectId(projectB, {
        projectId: pushed.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });
      const pull = (await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      })) as ErrorResult;
      expect(pull.success).toBe(false);
      // The underlying diagnosis is kept WHOLE on `error` — it is the
      // discriminator INSIDE the kind (which of the age refusals fired), and the
      // suggestion only names the remedies for the kind.
      expect(pull.error).toMatch(/could not be decrypted on this machine/);
      expect(pull.error).toMatch(/chunk \d+ failed authentication/);
      expect(pull.suggestion).toMatch(/authentication failed/);
      // Not a key problem and not a share that went away — the two whose
      // remedies would send the user somewhere useless.
      expect(pull.suggestion ?? "").not.toMatch(/not one of this bundle's recipients/);
      expect(pull.suggestion ?? "").not.toMatch(/share went away mid-pull/);
    } finally {
      restore.restore();
      for (const d of [home, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });

  /**
   * THE THIRD READER, and the one whose failure is silent by design.
   *
   * `bundle-io.ts` names three callers that must branch on the suffix: the pull's
   * fetch stage, `hub reindex`, and the MERGE-ANCESTOR fetch. The first two fail
   * loudly if they get it wrong. This one does not: `fetchAncestorWorkspace`
   * degrades to `{dir: null}` plus a warning and the merge falls back to
   * no-ancestor mode, which never overwrites anything — so reaching for
   * `resolveHubEncryption` there, the exact mistake the module was written to
   * prevent, yields a worse-but-not-wrong merge and a warning nobody reads.
   *
   * The discriminator is `taken`: it means "incoming changed, local did not",
   * which is a claim only an ancestor can support. Without one, a file that
   * differs on both sides is a both-added case and lands in `sidecars` instead.
   */
  it("decrypts the merge ancestor, so a 3-way workspace merge still works on a sealed hub", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-enc-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-enc-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      writeFileSync(join(projectA, "a.txt"), "original a\n");
      writeFileSync(join(projectA, "b.txt"), "original b\n");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });

      // B joins BEFORE anything is encrypted, so it is a recipient.
      restore.restore();
      restore = overrideHome(homeB);
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeB });
      restore.restore();
      restore = overrideHome(homeA);
      await hubEncrypt({ hubPath: hub, enable: true, cwd: homeA });

      // Generation 1 — an ENCRYPTED bundle carrying a workspace payload. This is
      // the bundle the merge below has to fetch and decrypt as its ancestor.
      const pushOptsA = {
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        claudeVersion: CLAUDE_VERSION,
      };
      const first = (await hubPush({ ...pushOptsA, createProject: true })) as HubPushResult;
      expect(first.success).toBe(true);
      expect(first.bundleEncrypted).toBe(true);
      expect(first.hasWorkspace).toBe(true);

      // B takes generation 1 into an empty directory and records it.
      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), "sesh-enc-projB-"));
      writeLocalProjectId(projectB, {
        projectId: first.projectId, name: "projA",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });
      const pull1 = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(pull1.success).toBe(true);
      expect(readFileSync(join(projectB, "a.txt"), "utf-8")).toBe("original a\n");

      // Generation 2 on A: a.txt only.
      restore.restore();
      restore = overrideHome(homeA);
      writeFileSync(join(projectA, "a.txt"), "changed by A\n");
      appendEntries(
        sessionJsonlPath(configDirA, projectA),
        plainEntries(FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, projectA)
      );
      const second = (await hubPush(pushOptsA)) as HubPushResult;
      expect(second.success).toBe(true);
      expect(second.bundleEncrypted).toBe(true);
      expect(second.hasWorkspace).toBe(true);

      // B changes a DIFFERENT file, then pulls. Generation 1 is common to both
      // trees, and it is on the hub as ciphertext.
      restore.restore();
      restore = overrideHome(homeB);
      writeFileSync(join(projectB, "b.txt"), "changed by B\n");
      const pull2 = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(pull2.success).toBe(true);
      if (!pull2.success) return;
      const p = pull2 as HubPullResult;

      // A real 3-way merge against a decrypted ancestor.
      expect(p.workspaceMerge).toBeDefined();
      expect(p.workspaceMerge?.taken ?? []).toContain("a.txt");
      expect(p.workspaceMerge?.kept ?? []).toContain("b.txt");
      expect(p.workspaceMerge?.sidecars ?? []).toEqual([]);
      // And it never fell back: that warning is the ONLY trace an undecryptable
      // ancestor leaves, which is why this assertion is here and not merely the
      // merge rows above.
      expect((p.warnings ?? []).join(" ")).not.toMatch(/could not be read back/);
      expect(readFileSync(join(projectB, "a.txt"), "utf-8")).toBe("changed by A\n");
      expect(readFileSync(join(projectB, "b.txt"), "utf-8")).toBe("changed by B\n");
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("a bundle this machine is not a recipient of is a typed refusal with a suggestion, not a throw", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-enc-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-enc-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-enc-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-enc-fix-"));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      await hubEncrypt({ hubPath: hub, enable: true, cwd: homeA });

      // B is NOT on the hub yet, so it is not in the recipient list — which is
      // the whole point: the bundle is written once and never re-wrapped.
      const pushed = (await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      })) as HubPushResult;
      expect(pushed.bundleEncrypted).toBe(true);

      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), "sesh-enc-projB-"));
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeB });
      writeLocalProjectId(projectB, {
        projectId: pushed.projectId,
        name: "projA",
        createdAt: new Date().toISOString(),
        createdByMachine: "machine-a",
      });

      // RESOLVES rather than throws — that is the assertion. An uncaught throw
      // here would leave `hubPull` for the CLI's outer catch, which builds its
      // ErrorResult from the exception alone: no `suggestion`, the exit code of
      // a crash, and every disclosure already collected discarded.
      const pull = (await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      })) as ErrorResult;
      expect(pull.success).toBe(false);
      expect(pull.error).toMatch(/could not be decrypted on this machine/);
      expect(pull.suggestion).toBeTruthy();
      // The diagnosis a user can act on: not a recipient, distinct from having
      // no key at all, and permanent for this bundle.
      expect(pull.error).toMatch(/no identity matched any recipient stanza/);
      expect(pull.suggestion).toMatch(/never re-wrapped in place/);
      // Nothing landed: B's project folder was never even created, because the
      // abort is taken before the first session is imported.
      expect(existsSync(join(configDirB, "projects", encodeProjectPath(projectB)))).toBe(false);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    }
  });
});
