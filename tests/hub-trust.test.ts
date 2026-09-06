/**
 * # The pin store and `hub trust` (#86)
 *
 * These test the half of signing that carries the security property. A
 * signature verified against a key the hub published detects exactly one
 * adversary — a tamperer who declines to re-sign — because anyone who can write
 * a bundle can also rewrite `machines/<id>.json` and publish a key of their own.
 * The pin is what makes a key change loud, and `hub trust` is what makes a
 * FIRST key independent of the hub.
 *
 * So the tests below are written against the ways the mechanism could be
 * decorative rather than real:
 *
 * - a differing key silently re-pinned (then substitution is simply trusted),
 * - a confirmation accepted without the fingerprint actually matching (then the
 *   ceremony is the user typing yes to whatever the hub said),
 * - a pin shared across hubs (then trusting a machine on one hub trusts it on
 *   another, which is not what anyone confirmed).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import { findPin, readPins, recordPin } from "../src/hub/pins.js";
import { keyFingerprint, publicKeyToBase64Url } from "../src/crypto/signing-key.js";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { hubTrust } from "../src/hub/trust.js";
import { hubInit } from "../src/hub/init.js";
import { loadOrCreateMachineId } from "../src/machine.js";

const NOW = "2026-09-06T00:00:00.000Z";

function freshKey(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return publicKeyToBase64Url(createPublicKey(privateKey));
}

describe("pin store", () => {
  let home: string;
  let restore: HomeOverrideHandle;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sm-pins-"));
    restore = overrideHome(home);
  });
  afterEach(() => {
    restore.restore();
    rmSync(home, { recursive: true, force: true });
  });

  it("pins a key on first use and is idempotent for the same key", () => {
    const k = freshKey();
    expect(recordPin({ hubId: "h", machineId: "m", publicKey: k, origin: "tofu", nowIso: NOW }).kind).toBe("pinned");
    expect(recordPin({ hubId: "h", machineId: "m", publicKey: k, origin: "tofu", nowIso: NOW }).kind).toBe("unchanged");
  });

  it("REFUSES to re-pin a different key on first-use, and writes nothing", () => {
    // The load-bearing refusal. A silent re-pin makes the whole mechanism
    // decorative: an attacker who substitutes a key on the hub would simply be
    // trusted on the next pull, and the pin would have detected nothing.
    const a = freshKey();
    const b = freshKey();
    recordPin({ hubId: "h", machineId: "m", publicKey: a, origin: "tofu", nowIso: NOW });
    const out = recordPin({ hubId: "h", machineId: "m", publicKey: b, origin: "tofu", nowIso: NOW });

    expect(out.kind).toBe("conflict");
    if (out.kind !== "conflict") return;
    expect(out.pinned.publicKey).toBe(a);
    expect(out.found).toBe(b);
    // Nothing written is the half that matters: reporting a conflict while
    // storing the new key would be the same defect with a better error message.
    expect(findPin(readPins(), "h", "m")?.publicKey).toBe(a);
  });

  it("upgrades tofu to confirmed for the same key without changing the fact", () => {
    const k = freshKey();
    recordPin({ hubId: "h", machineId: "m", publicKey: k, origin: "tofu", nowIso: NOW });
    const out = recordPin({ hubId: "h", machineId: "m", publicKey: k, origin: "confirmed", nowIso: NOW });
    expect(out.kind).toBe("pinned");
    expect(findPin(readPins(), "h", "m")?.origin).toBe("confirmed");
  });

  it("lets a CONFIRMED pin replace a conflicting one, and leaves a trail", () => {
    // A machine that legitimately re-minted needs a way back, and it must not
    // look identical to an attack in the record afterwards.
    const a = freshKey();
    const b = freshKey();
    recordPin({ hubId: "h", machineId: "m", publicKey: a, origin: "tofu", nowIso: NOW });
    const out = recordPin({ hubId: "h", machineId: "m", publicKey: b, origin: "confirmed", nowIso: NOW });
    expect(out.kind).toBe("pinned");
    if (out.kind !== "pinned") return;
    expect(out.pin.previousKey).toBe(a);
    expect(out.pin.replacedAt).toBe(NOW);
  });

  it("keys pins per hub, so trusting a machine on one hub is not trusting it on another", () => {
    const a = freshKey();
    const b = freshKey();
    recordPin({ hubId: "hub-1", machineId: "m", publicKey: a, origin: "confirmed", nowIso: NOW });
    // Same machine id, different hub, different key — not a conflict, because
    // they are two separate trust decisions about two separate deployments.
    expect(recordPin({ hubId: "hub-2", machineId: "m", publicKey: b, origin: "tofu", nowIso: NOW }).kind).toBe("pinned");
    expect(findPin(readPins(), "hub-1", "m")?.publicKey).toBe(a);
    expect(findPin(readPins(), "hub-2", "m")?.publicKey).toBe(b);
  });

  it("treats an unreadable store as empty rather than failing", () => {
    // Deliberate weakening, stated in the module: refusing every pull until a
    // local file is repaired turns a local problem into total loss of function,
    // and an attacker who can delete the pin file can equally edit it.
    mkdirSync(join(home, ".sesh-mover"), { recursive: true });
    writeFileSync(join(home, ".sesh-mover", "key-pins.json"), "{ this is not json");
    expect(readPins().pins).toEqual([]);
  });
});

describe("hub trust", () => {
  let root: string;
  let home: HomeOverrideHandle;
  let hubDir: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "sm-trust-"));
    mkdirSync(join(root, "home"), { recursive: true });
    home = overrideHome(join(root, "home"));
    hubDir = join(root, "hub");
    mkdirSync(hubDir, { recursive: true });
    await hubInit({ hubPath: hubDir, configScope: "user", cwd: join(root, "home") });
  });
  afterEach(() => {
    home.restore();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists this machine and never asks it to trust itself", async () => {
    const out = await hubTrust({ projectPath: root, hubPath: hubDir });
    expect(out.success).toBe(true);
    if (!out.success || !("machines" in out)) return;
    const me = loadOrCreateMachineId();
    const self = out.machines.find((m) => m.machineId === me.id);
    // A machine holds its own private key, so a pin on itself would be
    // self-referential — there is nothing to trust.
    expect(self?.pinned).toBeNull();
  });

  it("refuses to confirm without a fingerprint, and says why", async () => {
    const me = loadOrCreateMachineId();
    const out = await hubTrust({ projectPath: root, hubPath: hubDir, machineId: me.id });
    expect(out.success).toBe(false);
    if (out.success) return;
    expect("refusal" in out && out.refusal).toBe("fingerprint-mismatch");
    // The suggestion must send the user to the OTHER machine, over a channel
    // that is not the hub. Reading the fingerprint off the hub and typing it
    // back is TOFU with extra steps.
    expect("suggestion" in out && out.suggestion).toMatch(/not this hub|other machine|ON MACHINE/i);
  });

  it("refuses a fingerprint that does not match the published key", async () => {
    const me = loadOrCreateMachineId();
    const out = await hubTrust({
      projectPath: root, hubPath: hubDir, machineId: me.id,
      fingerprint: "DEAD-BEEF-DEAD-BEEF-DEAD",
    });
    expect(out.success).toBe(false);
    if (out.success) return;
    expect("refusal" in out && out.refusal).toBe("fingerprint-mismatch");
  });

  it("confirms when the fingerprint matches, and the pin becomes confirmed", async () => {
    const me = loadOrCreateMachineId();
    const listed = await hubTrust({ projectPath: root, hubPath: hubDir });
    if (!listed.success || !("machines" in listed)) throw new Error("listing failed");
    const self = listed.machines.find((m) => m.machineId === me.id);
    if (!self?.fingerprint) throw new Error("this machine published no signing key — premise gone");

    const out = await hubTrust({
      projectPath: root, hubPath: hubDir, machineId: me.id, fingerprint: self.fingerprint, nowIso: NOW,
    });
    expect(out.success).toBe(true);
    if (!out.success || !("confirmed" in out)) return;
    expect(out.confirmed?.machineId).toBe(me.id);
  });

  it("accepts a fingerprint however the user spaced or cased it", async () => {
    // A person retypes what they read off another screen. Rejecting it over
    // punctuation would push them toward copy-pasting through the hub, which is
    // exactly the channel the comparison must not use.
    const me = loadOrCreateMachineId();
    const listed = await hubTrust({ projectPath: root, hubPath: hubDir });
    if (!listed.success || !("machines" in listed)) throw new Error("listing failed");
    const fp = listed.machines.find((m) => m.machineId === me.id)?.fingerprint;
    if (!fp) throw new Error("no key published — premise gone");

    const mangled = fp.toLowerCase().replace(/-/g, " ");
    const out = await hubTrust({
      projectPath: root, hubPath: hubDir, machineId: me.id, fingerprint: mangled, nowIso: NOW,
    });
    expect(out.success).toBe(true);
  });

  it("refuses an unknown machine rather than guessing", async () => {
    const out = await hubTrust({ projectPath: root, hubPath: hubDir, machineId: "no-such-machine", fingerprint: "AAAA" });
    expect(out.success).toBe(false);
    if (out.success) return;
    expect("refusal" in out && out.refusal).toBe("no-such-machine");
  });
});

describe("keyFingerprint", () => {
  it("is grouped, stable, and differs between keys", () => {
    const a = freshKey();
    const b = freshKey();
    expect(keyFingerprint(a)).toBe(keyFingerprint(a));
    expect(keyFingerprint(a)).not.toBe(keyFingerprint(b));
    // Grouped because an unbroken run is where a human comparison fails —
    // people check the first few characters and the last few and skip the
    // middle.
    expect(keyFingerprint(a)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4})+$/);
  });
});
