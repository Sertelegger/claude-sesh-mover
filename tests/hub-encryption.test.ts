import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsBackend } from "../src/hub/backend.js";
import { collectHubRecipients, resolveHubEncryption } from "../src/hub/encryption.js";
import { listMachineIds, readMachineRecord } from "../src/hub/machines.js";
import type { HubJson, HubMachineJson } from "../src/hub/layout.js";
import { generateIdentity } from "../src/crypto/age.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeMachine(hub: string, id: string, record: Partial<HubMachineJson>): void {
  const dir = join(hub, "machines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ id, name: id, platform: "linux", lastSeenAt: "2026-08-19T00:00:00Z", ...record }, null, 2)
  );
}

function hubJson(extra: Partial<HubJson> = {}): HubJson {
  return { schemaVersion: 1, hubId: "h", createdAt: "2026-08-19T00:00:00Z", ...extra };
}

/**
 * The recipient list is a CENSUS, not a filter.
 *
 * The obvious signature returns the recipients and drops the rest, and that has
 * a silent, permanent failure: encrypting to a list that omits a machine locks
 * that machine out of the bundle forever, the push succeeds, and the loss
 * surfaces on the OTHER machine as `no-matching-identity`, which reads like
 * corruption. A dropped recipient is indistinguishable at the call site from a
 * machine that never existed. So every branch below asserts BOTH halves: absent
 * from `recipients`, and present in `unkeyed` with the reason that names the
 * remedy.
 */
describe("collectHubRecipients", () => {
  it("returns every machine publishing a usable key, in a deterministic order", async () => {
    const hub = tmp("sesh-recip-");
    try {
      const a = generateIdentity();
      const b = generateIdentity();
      writeMachine(hub, "bbb", { name: "laptop", ageRecipient: b.recipient });
      writeMachine(hub, "aaa", { name: "desktop", ageRecipient: a.recipient });

      const set = await collectHubRecipients(createFsBackend(hub));
      expect(set.unkeyed).toEqual([]);
      // Sorted by id: this becomes stanza order in an age header, and a test
      // that pinned readdir order would be pinning nothing.
      expect(set.recipients).toEqual([
        { machineId: "aaa", name: "desktop", recipient: a.recipient },
        { machineId: "bbb", name: "laptop", recipient: b.recipient },
      ]);
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  });

  it("reports a machine with NO published key rather than dropping it", async () => {
    const hub = tmp("sesh-recip-nokey-");
    try {
      const a = generateIdentity();
      writeMachine(hub, "aaa", { name: "desktop", ageRecipient: a.recipient });
      // A machine on a version predating the field, or one whose identity file
      // was unreadable when it last checked in. Permanently possible.
      writeMachine(hub, "old", { name: "server" });

      const set = await collectHubRecipients(createFsBackend(hub));
      expect(set.recipients.map((r) => r.machineId)).toEqual(["aaa"]);
      expect(set.unkeyed).toEqual([{ machineId: "old", name: "server", reason: "no-key" }]);
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  });

  it("distinguishes a key that does not parse from one that is absent", async () => {
    const hub = tmp("sesh-recip-badkey-");
    try {
      writeMachine(hub, "bad", { name: "hand-edited", ageRecipient: "age1-not-a-real-key" });
      writeMachine(hub, "emp", { name: "empty-string", ageRecipient: "" });

      const set = await collectHubRecipients(createFsBackend(hub));
      expect(set.recipients).toEqual([]);
      expect(set.unkeyed).toEqual([
        // Re-parsed rather than trusted: caught here it is one named machine,
        // reaching the encryptor it aborts the whole push.
        { machineId: "bad", name: "hand-edited", reason: "bad-key" },
        { machineId: "emp", name: "empty-string", reason: "no-key" },
      ]);
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  });

  it("reports an unparseable machine record rather than dropping it", async () => {
    const hub = tmp("sesh-recip-corrupt-");
    try {
      mkdirSync(join(hub, "machines"), { recursive: true });
      writeFileSync(join(hub, "machines", "trunc.json"), '{"id":"trunc","name":');

      const set = await collectHubRecipients(createFsBackend(hub));
      expect(set.recipients).toEqual([]);
      expect(set.unkeyed).toEqual([
        { machineId: "trunc", name: null, reason: "unreadable-record" },
      ]);
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  });

  it("reports a path-unsafe record name without ever opening it", async () => {
    const hub = tmp("sesh-recip-unsafe-");
    try {
      // `..json` has the stem "..", which `isSafeSessionId` rejects — it cannot
      // be turned into a hub-relative path without becoming a traversal. The
      // only safe handling is to decline to open it AND to say so, rather than
      // let it vanish into the same bucket as a record that was read and found
      // corrupt.
      mkdirSync(join(hub, "machines"), { recursive: true });
      writeFileSync(join(hub, "machines", "...json"), "{}");

      const set = await collectHubRecipients(createFsBackend(hub));
      expect(set.recipients).toEqual([]);
      expect(set.unkeyed).toEqual([{ machineId: "..", name: null, reason: "unsafe-id" }]);
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  });

  it("ignores sync litter under machines/ instead of calling each piece a keyless machine", async () => {
    const hub = tmp("sesh-recip-litter-");
    try {
      const a = generateIdentity();
      writeMachine(hub, "aaa", { name: "desktop", ageRecipient: a.recipient });

      // The same shapes `hub status`'s count had to learn to ignore (#28). Here
      // the cost of getting it wrong is worse than a wrong number: each would
      // become a phantom "machine with no key" that a push must refuse over.
      const machines = join(hub, "machines");
      writeFileSync(join(machines, ".DS_Store"), "\0\0");
      writeFileSync(join(machines, "Thumbs.db"), "x");
      writeFileSync(join(machines, "~syncthing~aaa.tmp"), "{}");
      writeFileSync(join(machines, "README"), "put machine records here\n");
      mkdirSync(join(machines, ".stversions"), { recursive: true });
      writeFileSync(join(machines, ".stversions", "aaa~20260101.json"), "{}");
      mkdirSync(join(machines, "desktop's conflicted copy 2026-08-03"), { recursive: true });
      writeFileSync(join(machines, "desktop's conflicted copy 2026-08-03", "aaa.json"), "{}");

      const set = await collectHubRecipients(createFsBackend(hub));
      expect(set.recipients.map((r) => r.machineId)).toEqual(["aaa"]);
      expect(set.unkeyed).toEqual([]);
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  });

  it("is empty, not thrown, on a hub with no machines directory at all", async () => {
    const hub = tmp("sesh-recip-empty-");
    try {
      expect(await collectHubRecipients(createFsBackend(hub))).toEqual({
        recipients: [],
        unkeyed: [],
      });
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  });
});

describe("machines roster", () => {
  it("listMachineIds sorts, whatever order the backend lists in", async () => {
    // Against a real directory this assertion is vacuous: `readdir` on ext4
    // returns hash order, which for two ids happened to already be sorted, so
    // deleting the `.sort()` left the disk-backed test green. The order is not
    // cosmetic — it becomes stanza order in an age header — so it is pinned
    // against a backend that lists in the worst order instead.
    const listed = [
      "machines/mmm.json",
      "machines/zzz.json",
      "machines/aaa.json",
      "machines/zzz.json",
    ];
    const stub = {
      list: async (prefix: string) => (prefix === "machines" ? listed : []),
    } as unknown as Parameters<typeof listMachineIds>[0];
    expect(await listMachineIds(stub)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("listMachineIds dedupes and sorts; readMachineRecord tells absent from unsafe", async () => {
    const hub = tmp("sesh-roster-");
    try {
      writeMachine(hub, "zzz", {});
      writeMachine(hub, "aaa", {});
      const backend = createFsBackend(hub);
      expect(await listMachineIds(backend)).toEqual(["aaa", "zzz"]);

      expect(await readMachineRecord(backend, "aaa")).toMatchObject({ ok: true });
      expect(await readMachineRecord(backend, "nope")).toEqual({ ok: false, problem: "absent" });
      // Never turned into a path — the check is before the read.
      expect(await readMachineRecord(backend, "../evil")).toEqual({
        ok: false,
        problem: "unsafe-id",
      });
    } finally {
      rmSync(hub, { recursive: true, force: true });
    }
  });
});

/**
 * `hub.json` is authoritative; the config key is a preference.
 *
 * The ruling exists because a local-only flag has a silent failure: one machine
 * that never set it keeps pushing plaintext into a hub the user believes is
 * sealed, and nothing anywhere says so.
 */
describe("resolveHubEncryption", () => {
  it("is off for every hub written before the field existed", () => {
    expect(resolveHubEncryption(hubJson(), false)).toEqual({
      required: false,
      preferred: false,
      unappliedPreference: false,
      malformedSetting: false,
    });
  });

  it("is decided by hub.json, in both directions", () => {
    expect(resolveHubEncryption(hubJson({ encrypt: true }), false).required).toBe(true);
    expect(resolveHubEncryption(hubJson({ encrypt: false }), true).required).toBe(false);
  });

  it("a local preference alone does not enable it, and says so", () => {
    // A machine that encrypted unilaterally would push bundles the rest of the
    // hub cannot read. The preference is a disclosure, not an enable.
    const policy = resolveHubEncryption(hubJson({ encrypt: false }), true);
    expect(policy.required).toBe(false);
    expect(policy.preferred).toBe(true);
    expect(policy.unappliedPreference).toBe(true);
  });

  it("a preference that the hub already honours is not an unapplied one", () => {
    expect(resolveHubEncryption(hubJson({ encrypt: true }), true).unappliedPreference).toBe(false);
  });

  it("a malformed value resolves TOWARD encryption, and is flagged", () => {
    // `encrypt: "true"` from a hand edit, read as false, is a silent
    // confidentiality loss of exactly the kind this field exists to prevent.
    // Read as true it is at worst a surprise on bundles the user holds keys to.
    for (const bad of ["true", "false", 1, 0, null, {}, []]) {
      const policy = resolveHubEncryption(
        hubJson({ encrypt: bad as unknown as boolean }),
        false
      );
      expect(policy.malformedSetting).toBe(true);
      expect(policy.required).toBe(true);
    }
  });
});
