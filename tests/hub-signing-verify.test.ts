/**
 * The pull side of #86: signature verification as the fetch stage's SIXTH
 * untrusted-input abort, between retrieval and unpack.
 *
 * Everything here drives `runFetchStage` directly, against a real fs backend
 * and real `.tar.gz` bundles stamped by the real manifest writer — the same
 * arrangement as tests/hub-pull-stages.test.ts, plus a real Ed25519 key. The
 * home directory is ALWAYS overridden: the pin store lives under
 * `~/.sesh-mover/`, and a test that reads or writes the runner's real pin file
 * is the Windows-only failure amplifier CLAUDE.md documents.
 *
 * Several assertions double as ordering proofs: an abort that fired before the
 * unpack leaves no extraction directory at all, which is what "node-tar never
 * parses bytes that failed attribution" looks like on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createFsBackend, type HubBackend } from "../src/hub/backend.js";
import { bundleDir, bundleFileName, type HubBundleRecord } from "../src/hub/layout.js";
import { runFetchStage } from "../src/hub/pull-fetch.js";
import { initApplyState } from "../src/hub/pull-apply-state.js";
import {
  SIGNATURE_DOMAIN,
  digestFile,
  signStatement,
  statementBytes,
  type BundleSignature,
  type BundleStatement,
} from "../src/hub/signature.js";
import { findPin, readPins, recordPin } from "../src/hub/pins.js";
import { publicKeyToBase64Url, signBytes } from "../src/crypto/signing-key.js";
import { createArchive } from "../src/archiver.js";
import { computeIntegrityHashFromFile, writeManifest } from "../src/manifest.js";
import type { ExportManifest } from "../src/types.js";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";

const HUB_ID = "hub-1";
const PROJECT_ID = "p1";
const MACHINE_ID = "m1";

interface TestKey {
  privateKey: KeyObject;
  /** base64url raw public key — the published/pinned form. */
  publicKey: string;
}

function mintKey(): TestKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: publicKeyToBase64Url(createPublicKey(privateKey)) };
}

describe("hub pull signature verification (#86)", () => {
  let root: string;
  let hubDir: string;
  let tempRoot: string;
  let fakeHome: string;
  let backend: HubBackend;
  let home: HomeOverrideHandle;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sm-sigverify-"));
    hubDir = join(root, "hub");
    tempRoot = join(root, "temp");
    fakeHome = join(root, "home");
    mkdirSync(hubDir, { recursive: true });
    mkdirSync(tempRoot, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    backend = createFsBackend(hubDir);
    // The pin store is ~/.sesh-mover/key-pins.json. Overridden BEFORE any
    // stage or pin call, restored after — both variables, or the override
    // silently no-ops on Windows (see helpers/env.ts).
    home = overrideHome(fakeHome);
  });

  afterEach(() => {
    home.restore();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A real, intact bundle on the hub — a `.tar.gz` the stage's five other
   * guards all pass — plus the sha256 of the exact bytes uploaded, which is
   * what a truthful statement's `bundleDigest` must carry.
   */
  async function writeSignableBundle(
    over: { bundleId?: string; reuseArchiveBytes?: Buffer; sessionIdInBundle?: string } = {}
  ): Promise<{ record: HubBundleRecord; digest: string; archiveBytes: Buffer }> {
    const bundleId = over.bundleId ?? "b0";
    const pushedAt = "2026-09-01T00:00:00.000Z";

    let archiveBytes: Buffer;
    let sessionId: string;
    if (over.reuseArchiveBytes) {
      // Byte-identical content under a second record — the replay arrangement
      // the context binding exists to stop, where the digest alone would pass.
      archiveBytes = over.reuseArchiveBytes;
      sessionId = over.sessionIdInBundle ?? "sess-shared";
    } else {
      sessionId = `sess-${bundleId}`;
      const staging = mkdtempSync(join(root, "staging-"));
      const bundleStaging = join(staging, "bundle");
      mkdirSync(join(bundleStaging, "sessions"), { recursive: true });
      const jsonlPath = join(bundleStaging, "sessions", `${sessionId}.jsonl`);
      const entry = {
        sessionId, cwd: "/x", version: "2.1.81", gitBranch: "main", slug: "sig-verify",
        uuid: `${bundleId}-1`, parentUuid: null, timestamp: "2026-09-01T10:00:00.000Z",
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
        projectId: PROJECT_ID,
        sourceMachineId: MACHINE_ID,
        sessions: [
          {
            sessionId,
            slug: "sig-verify",
            summary: "a signable bundle",
            createdAt: "2026-09-01T10:00:00.000Z",
            lastActiveAt: "2026-09-01T10:00:00.000Z",
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
      archiveBytes = readFileSync(archivePath);
      rmSync(staging, { recursive: true, force: true });
    }

    const file = `${bundleDir(PROJECT_ID, MACHINE_ID)}/${bundleFileName(pushedAt, bundleId)}`;
    await backend.writeAtomic(file, archiveBytes);

    const digestStaging = join(root, `digest-${bundleId}.tar.gz`);
    writeFileSync(digestStaging, archiveBytes);
    const digest = await digestFile(digestStaging);
    rmSync(digestStaging);

    const record: HubBundleRecord = {
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
    return { record, digest, archiveBytes };
  }

  function statementFor(record: HubBundleRecord, digest: string): BundleStatement {
    return {
      domain: SIGNATURE_DOMAIN,
      hubId: HUB_ID,
      projectId: PROJECT_ID,
      machineId: MACHINE_ID,
      bundleId: record.bundleId,
      pushedAt: record.pushedAt,
      bundleFile: record.file,
      bundleDigest: digest,
    };
  }

  /** `HubBundleRecord` grows `signature` from the push side in this slice. */
  function withSignature(record: HubBundleRecord, sig: unknown): HubBundleRecord {
    return { ...record, signature: sig as BundleSignature } as HubBundleRecord;
  }

  async function run(record: HubBundleRecord) {
    const st = initApplyState({ needed: [record] });
    return runFetchStage({
      backend, record, machineId: MACHINE_ID, hubId: HUB_ID, projectId: PROJECT_ID,
      bundleIndex: 0, chainLength: 1, tempRoot, state: st,
    });
  }

  it("verifies a validly signed bundle, applies it, and pins the key on first use", async () => {
    const key = mintKey();
    const { record, digest } = await writeSignableBundle();
    const signed = withSignature(record, signStatement(key.privateKey, statementFor(record, digest), key.publicKey));

    const out = await run(signed);

    expect(out.status).toBe("applied");
    expect(out.value?.manifest.sessions[0].sessionId).toBe(record.sessionIdInBundle);
    // Trust on first use, recorded in the overridden home's pin store.
    const pin = findPin(readPins(), HUB_ID, MACHINE_ID);
    expect(pin).not.toBeNull();
    expect(pin?.publicKey).toBe(key.publicKey);
    expect(pin?.origin).toBe("tofu");
    // The TOFU is disclosed, and the disclosure names the upgrade path.
    expect(out.reasons.some((r) => r.includes("pinned on first use"))).toBe(true);
    expect(out.reasons.some((r) => r.includes("hub trust"))).toBe(true);
  });

  it("stays quiet on a later pull of the same signed machine — no re-TOFU, no warning", async () => {
    const key = mintKey();
    const { record, digest } = await writeSignableBundle();
    const signed = withSignature(record, signStatement(key.privateKey, statementFor(record, digest), key.publicKey));

    await run(signed);
    const again = await run(signed);

    expect(again.status).toBe("applied");
    // The pin already matches, so nothing is written and nothing is said —
    // a disclosure repeated every pull stops being read.
    expect(again.reasons).toEqual([]);
    expect(findPin(readPins(), HUB_ID, MACHINE_ID)?.publicKey).toBe(key.publicKey);
  });

  it("aborts a tampered archive with digest-mismatch wording, before any unpack", async () => {
    const key = mintKey();
    const { record, digest } = await writeSignableBundle();
    const signed = withSignature(record, signStatement(key.privateKey, statementFor(record, digest), key.publicKey));
    // The statement stays valid and in place; the ARCHIVE changes after signing.
    const bytes = Buffer.from(await backend.read(record.file));
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await backend.writeAtomic(record.file, bytes);

    const out = await run(signed);

    expect(out.status).toBe("aborted");
    expect(out.value).toBeNull();
    expect(out.terminal).toMatchObject({ success: false, command: "pull" });
    expect(out.terminal?.error).toContain("is not the archive its signature vouches for");
    expect(out.terminal?.error).toContain(record.file);
    expect(out.terminal?.suggestion).toContain("Nothing from this bundle was applied.");
    expect(out.terminal?.suggestion).toContain("will not be refetched");
    // The ordering proof: the abort fired BEFORE the unpack, so no extraction
    // directory was even created — node-tar never parsed a failed byte.
    expect(existsSync(join(tempRoot, record.bundleId))).toBe(false);
    // And a bundle that fails its own statement never installs a pin: TOFU
    // happens strictly after the digest matched.
    expect(findPin(readPins(), HUB_ID, MACHINE_ID)).toBeNull();
  });

  it("aborts a statement lifted from another bundle as a context mismatch", async () => {
    const key = mintKey();
    // Two records, BYTE-IDENTICAL archives: the digest check alone cannot tell
    // them apart, so only the context binding stands between a validly signed
    // statement and the wrong hub slot. This is the replay the binding is for.
    const a = await writeSignableBundle({ bundleId: "b-a" });
    const b = await writeSignableBundle({
      bundleId: "b-b",
      reuseArchiveBytes: a.archiveBytes,
      sessionIdInBundle: a.record.sessionIdInBundle,
    });
    const liftedFromA = signStatement(key.privateKey, statementFor(a.record, a.digest), key.publicKey);

    const out = await run(withSignature(b.record, liftedFromA));

    expect(out.status).toBe("aborted");
    expect(out.terminal?.error).toContain("valid signature for a DIFFERENT location");
    // The first mismatching field in the verifier's order, with both values —
    // what the user needs to see where the statement really belongs.
    expect(out.terminal?.error).toContain("bundleId");
    expect(out.terminal?.error).toContain("b-a");
    expect(out.terminal?.error).toContain("b-b");
    expect(out.terminal?.suggestion).toContain("deliberate tampering");
    expect(out.terminal?.suggestion).toContain("Nothing from this bundle was applied.");
    // Nothing unpacked, nothing pinned.
    expect(existsSync(join(tempRoot, b.record.bundleId))).toBe(false);
    expect(findPin(readPins(), HUB_ID, MACHINE_ID)).toBeNull();
  });

  it("aborts a signature under a key that differs from the pin, and names hub trust", async () => {
    const pinned = mintKey();
    const current = mintKey();
    expect(
      recordPin({ hubId: HUB_ID, machineId: MACHINE_ID, publicKey: pinned.publicKey, origin: "tofu", nowIso: "2026-09-01T00:00:00.000Z" }).kind
    ).toBe("pinned");
    const { record, digest } = await writeSignableBundle();
    const signed = withSignature(record, signStatement(current.privateKey, statementFor(record, digest), current.publicKey));

    const out = await run(signed);

    expect(out.status).toBe("aborted");
    expect(out.terminal?.error).toContain(`not the one pinned for machine ${MACHINE_ID}`);
    // The remedy is a human confirming out of band — never anything automatic.
    expect(out.terminal?.suggestion).toContain("sesh-mover hub trust");
    expect(out.terminal?.suggestion).toContain("NOT necessarily an attack");
    expect(out.terminal?.suggestion).toContain("Nothing from this bundle was applied.");
    expect(existsSync(join(tempRoot, record.bundleId))).toBe(false);
    // The pin the user holds is untouched by the refusal.
    expect(findPin(readPins(), HUB_ID, MACHINE_ID)?.publicKey).toBe(pinned.publicKey);
  });

  it("applies an unsigned bundle from a machine with no pin exactly as before", async () => {
    const { record } = await writeSignableBundle();

    const out = await run(record);

    expect(out.status).toBe("applied");
    expect(out.reasons).toEqual([]);
    expect(out.value?.extractDir).toBe(join(tempRoot, record.bundleId));
    expect(existsSync(join(tempRoot, record.bundleId, "manifest.json"))).toBe(true);
    // An unsigned bundle mints no trust: nothing lands in the pin store.
    expect(findPin(readPins(), HUB_ID, MACHINE_ID)).toBeNull();
  });

  it("warns — but applies — an unsigned bundle from a machine whose key is pinned", async () => {
    const key = mintKey();
    expect(
      recordPin({ hubId: HUB_ID, machineId: MACHINE_ID, publicKey: key.publicKey, origin: "tofu", nowIso: "2026-09-01T00:00:00.000Z" }).kind
    ).toBe("pinned");
    const { record } = await writeSignableBundle();

    const out = await run(record);

    // A downgrade is a warning, not a refusal: the push side legitimately
    // falls back to unsigned when its key is unreadable.
    expect(out.status).toBe("applied");
    expect(out.value).not.toBeNull();
    expect(out.reasons.length).toBe(1);
    expect(out.reasons[0]).toContain("unsigned");
    expect(out.reasons[0]).toContain("downgrade");
    expect(out.reasons[0]).toContain(MACHINE_ID);
  });

  it("aborts, rather than throwing, on corrupted signature bytes — and accuses nobody", async () => {
    const key = mintKey();
    const { record, digest } = await writeSignableBundle();
    const sig = signStatement(key.privateKey, statementFor(record, digest), key.publicKey);
    const corrupted: BundleSignature = { ...sig, signature: sig.signature.slice(0, -4) + "AAAA" };

    const out = await run(withSignature(record, corrupted));

    expect(out.status).toBe("aborted");
    expect(out.terminal?.error).toContain("does not verify");
    expect(out.terminal?.suggestion).toContain("accuses nobody");
    expect(out.terminal?.suggestion).toContain("Nothing from this bundle was applied.");
    expect(existsSync(join(tempRoot, record.bundleId))).toBe(false);
    expect(findPin(readPins(), HUB_ID, MACHINE_ID)).toBeNull();
  });

  /**
   * The never-throw contract, exercised where it is sharpest: a statement of
   * `null` signed SELF-CONSISTENTLY verifies its own bytes and then trips the
   * verifier's context walk — the one throw `verifyBytes`'s own guarantees
   * cannot absorb. An uncaught throw here would leave hubPull through the
   * CLI's outer catch: exit 1, suggestion gone, prior disclosures dropped.
   */
  it.each([
    ["a validly signed null statement", (key: TestKey): unknown => ({
      statement: null,
      signature: signBytes(key.privateKey, statementBytes(null as never)),
      publicKey: key.publicKey,
    })],
    ["a signature field that is a bare string", (): unknown => "garbage"],
  ])("aborts, rather than throwing, on %s", async (_label, make) => {
    const key = mintKey();
    const { record } = await writeSignableBundle();

    const out = await run(withSignature(record, make(key)));

    expect(out.status).toBe("aborted");
    expect(out.terminal).toMatchObject({ success: false, command: "pull" });
    expect(out.terminal?.suggestion).toContain("Nothing from this bundle was applied.");
    expect(existsSync(join(tempRoot, record.bundleId))).toBe(false);
  });
});
