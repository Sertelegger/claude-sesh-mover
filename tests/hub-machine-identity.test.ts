import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { overrideHome } from "./helpers/env.js";
import { hubInit, registerMachine } from "../src/hub/init.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { identityFilePath, readIdentityFile } from "../src/crypto/identity-file.js";
import { collectHubRecipients } from "../src/hub/encryption.js";
import { createFsBackend } from "../src/hub/backend.js";
import { PLUGIN_VERSION } from "../src/version.js";
import type { HubJson, HubMachineJson } from "../src/hub/layout.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readRecord(hub: string, id: string): HubMachineJson {
  return JSON.parse(readFileSync(join(hub, "machines", `${id}.json`), "utf-8")) as HubMachineJson;
}

/**
 * What a machine publishes about itself, and what `hub.json` records about the
 * hub.
 *
 * The load-bearing decision under test is that `registerMachine` publishes this
 * machine's public key on EVERY check-in, not only once encryption is enabled.
 * Gate it on `hub.encrypt` and enabling encryption on machine A produces bundles
 * readable only by A: B is absent from the recipient list until its own next
 * push, and A's bundles from that window stay unreadable to B afterwards,
 * because only A may re-wrap A's bundles. Publishing unconditionally is what
 * makes enabling encryption later a switch rather than a flag day.
 */
describe("machine record: published identity and version", () => {
  it("hub init publishes the public half, the version, and nothing secret", async () => {
    const home = tmp("sesh-mid-home-");
    const hub = tmp("sesh-mid-hub-");
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const machine = loadOrCreateMachineId();
      const record = readRecord(hub, machine.id);

      const local = readIdentityFile();
      expect(local.state).toBe("present");
      if (local.state !== "present") return;

      expect(record.ageRecipient).toBe(local.recipient);
      expect(record.pluginVersion).toBe(PLUGIN_VERSION);

      // The private half is never transported. Assert it against the RECORD's
      // raw bytes rather than its parsed fields, so a future field that
      // accidentally serialized the identity would fail here too.
      const raw = readFileSync(join(hub, "machines", `${machine.id}.json`), "utf-8");
      expect(raw).not.toContain("AGE-SECRET-KEY");
      expect(raw).not.toContain(local.identity);
    } finally {
      restore.restore();
      for (const d of [home, hub]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("a plain re-registration (what every push and pull does) publishes the key too", async () => {
    const home = tmp("sesh-mid-home2-");
    const hub = tmp("sesh-mid-hub2-");
    const restore = overrideHome(home);
    try {
      // No `hub init` — this is the bare call push/pull/reindex make. A machine
      // that has never encrypted anything mints a keypair here, which is the
      // point: the recipient list has to be complete BEFORE the first encrypted
      // push, not after it.
      expect(existsSync(identityFilePath())).toBe(false);
      const record = await registerMachine(hub);
      expect(existsSync(identityFilePath())).toBe(true);

      const local = readIdentityFile();
      expect(local.state).toBe("present");
      if (local.state !== "present") return;
      expect(record.ageRecipient).toBe(local.recipient);

      const set = await collectHubRecipients(createFsBackend(hub));
      expect(set.unkeyed).toEqual([]);
      expect(set.recipients.map((r) => r.recipient)).toEqual([local.recipient]);
    } finally {
      restore.restore();
      for (const d of [home, hub]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("an unreadable identity does not fail registration — a plaintext push still works", async () => {
    const home = tmp("sesh-mid-home3-");
    const hub = tmp("sesh-mid-hub3-");
    const restore = overrideHome(home);
    try {
      mkdirSync(join(home, ".sesh-mover"), { recursive: true });
      writeFileSync(identityFilePath(), "not a key\n", "utf-8");

      // A machine that has never enabled encryption must not lose the ability to
      // push because its key file is broken. The hard failure rule belongs at
      // the ENCRYPTING call site, where "no key" means "no confidentiality".
      const record = await registerMachine(hub);
      expect(record.ageRecipient).toBeUndefined();
      expect(record.pluginVersion).toBe(PLUGIN_VERSION);
      // And it did not mint over the damaged file.
      expect(readFileSync(identityFilePath(), "utf-8")).toBe("not a key\n");

      // The disclosure channel is the census, on whichever machine is about to
      // encrypt — not a silent absence.
      const set = await collectHubRecipients(createFsBackend(hub));
      expect(set.recipients).toEqual([]);
      expect(set.unkeyed.map((u) => u.reason)).toEqual(["no-key"]);
    } finally {
      restore.restore();
      for (const d of [home, hub]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("carries a previously published key forward rather than retracting it", async () => {
    const home = tmp("sesh-mid-home4-");
    const hub = tmp("sesh-mid-hub4-");
    const restore = overrideHome(home);
    try {
      const first = await registerMachine(hub);
      expect(first.ageRecipient).toBeDefined();

      // A transient read failure — a full disk, a permission blip, a dead mount
      // over $HOME. `writeAtomic` replaces the whole record, so the naive
      // version silently de-registers this machine as a recipient and the other
      // machines quietly stop encrypting to a key it still holds.
      rmSync(identityFilePath());
      mkdirSync(identityFilePath(), { recursive: true });

      const second = await registerMachine(hub);
      expect(second.ageRecipient).toBe(first.ageRecipient);
      expect(second.lastSeenAt >= first.lastSeenAt).toBe(true);

      const set = await collectHubRecipients(createFsBackend(hub));
      expect(set.unkeyed).toEqual([]);
      expect(set.recipients.map((r) => r.recipient)).toEqual([first.ageRecipient]);
    } finally {
      restore.restore();
      for (const d of [home, hub]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("hub.json: pluginVersion and encrypt", () => {
  it("hub init stamps both on the hub it CREATES", async () => {
    const home = tmp("sesh-hj-home-");
    const hub = tmp("sesh-hj-hub-");
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const hubJson = JSON.parse(readFileSync(join(hub, "hub.json"), "utf-8")) as HubJson;
      expect(hubJson.pluginVersion).toBe(PLUGIN_VERSION);
      // Written explicitly rather than left absent: hub.json is the file a user
      // opens to find out what their hub's policy is, and a policy you can only
      // discover by reading source is not one a user can check.
      expect(hubJson.encrypt).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, hub]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("JOINING an existing hub rewrites neither field", async () => {
    const home = tmp("sesh-hj-home2-");
    const hub = tmp("sesh-hj-hub2-");
    const restore = overrideHome(home);
    try {
      // A hub created by some other machine, on some other version, that has
      // since had encryption switched on. `hub.json` is the one hub file no
      // machine owns; rewriting a shared file to advertise a version would spend
      // the per-machine-ownership invariant for nothing — and here it would also
      // silently turn the user's encryption back off.
      mkdirSync(hub, { recursive: true });
      writeFileSync(
        join(hub, "hub.json"),
        JSON.stringify({
          schemaVersion: 1,
          hubId: "existing-hub",
          createdAt: "2026-01-01T00:00:00Z",
          pluginVersion: "0.8.0",
          encrypt: true,
        })
      );

      const joined = await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      expect(joined.success).toBe(true);
      if (!joined.success) return;
      expect(joined.created).toBe(false);

      const after = JSON.parse(readFileSync(join(hub, "hub.json"), "utf-8")) as HubJson;
      expect(after.pluginVersion).toBe("0.8.0");
      expect(after.encrypt).toBe(true);

      // The joining machine's own version goes on its own record instead — which
      // is the field that can actually answer "will any machine here push
      // plaintext", because it is refreshed on every push and pull.
      const machine = loadOrCreateMachineId();
      expect(readRecord(hub, machine.id).pluginVersion).toBe(PLUGIN_VERSION);
    } finally {
      restore.restore();
      for (const d of [home, hub]) rmSync(d, { recursive: true, force: true });
    }
  });
});
