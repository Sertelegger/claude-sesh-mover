/**
 * # age v1, and the differential test that is the point of this file
 *
 * `src/crypto/age.ts` is the one module in this repository where a green
 * self-round-trip test means nothing. MEASURED (spike, 2026-08-18): freezing
 * the STREAM chunk counter at zero makes this module encrypt AND decrypt back
 * to the plaintext byte for byte, while every chunk in the file reuses one
 * ChaCha20-Poly1305 nonce. That is catastrophic and completely invisible to a
 * test that only talks to itself. The real `age` binary rejects it instantly.
 *
 * So this file is in two halves, and they are not equally strong:
 *
 * - **Always-on**: shape, refusals, boundaries, and the header grammar. These
 *   pin the things that fail loudly. They cannot vouch for wire compatibility
 *   or for nonce discipline, and they are labelled so no one mistakes them for
 *   coverage of block #3.
 * - **Differential** (skipped, LOUDLY, when no `age`/`rage` is installed):
 *   encrypt here, decrypt there, and back. Run against every implementation
 *   present — `age` (Go, reference) and `rage` (Rust, independent). Two
 *   implementations agreeing means we match the SPEC, not one codebase.
 *
 * Two size rules are load-bearing and must survive any edit to the size list:
 *   1. Nonce reuse is only observable at >= 2 CHUNKS. Keep the >= 64 KiB cases.
 *   2. `>` vs `>=` in the chunk hold-back is invisible at every size except an
 *      EXACT MULTIPLE of 64 KiB. Keep 65536 and 131072. No randomly-sized
 *      payload ever hits them.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgeDecryptStream,
  AgeEncryptStream,
  AgeError,
  encodeIdentity,
  encodeRecipient,
  generateIdentity,
  parseIdentity,
  parseRecipient,
  recipientFromIdentity,
  __parseHeaderForTests as parseHeader,
} from "../src/crypto/age.js";
import {
  AGE_KEYGEN,
  HAVE_ORACLE,
  ORACLES,
  announceOracleAvailability,
  awkwardWrites,
  oracleDecrypt,
  oracleEncrypt,
  payload,
  through,
} from "./helpers/age-oracle.js";

const CHUNK = 65536;

announceOracleAvailability();

let dir: string;
let identityStr: string;
let recipientStr: string;
let identityRaw: Buffer;
let recipientRaw: Buffer;
let keyFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sesh-age-"));
  // Deliberately OUR key, not `age-keygen`'s. The spike only ever consumed
  // age-keygen output, so it never proved that an identity WE mint is one the
  // real binary can use — which is what the eventual `~/.sesh-mover/identity.age`
  // will be.
  ({ identity: identityStr, recipient: recipientStr } = generateIdentity());
  identityRaw = parseIdentity(identityStr);
  recipientRaw = parseRecipient(recipientStr);
  keyFile = join(dir, "key.txt");
  writeFileSync(keyFile, `${identityStr}\n`, { mode: 0o600 });
});

afterAll(() => {
  // Key material never outlives the run, and never lives in the repo.
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function encrypt(data: Buffer, recipients: Uint8Array[] = [recipientRaw]): Promise<Buffer> {
  return through(data, new AgeEncryptStream(recipients));
}

function decrypt(file: Buffer, identity: Uint8Array = identityRaw): Promise<Buffer> {
  return through(file, new AgeDecryptStream(identity));
}

async function ageErrorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AgeError);
    return (e as AgeError).code;
  }
  throw new Error("expected the operation to fail, but it resolved");
}

const sizes: [string, number][] = [
  ["empty", 0],
  ["1 byte", 1],
  ["100 bytes", 100],
  ["one byte under a chunk", CHUNK - 1],
  ["exactly one chunk", CHUNK],
  ["one byte over a chunk", CHUNK + 1],
  ["exactly two chunks", CHUNK * 2],
  ["one byte over two chunks", CHUNK * 2 + 1],
  ["three chunks and a bit", CHUNK * 3 + 12345],
  ["5 MiB (80 chunks)", 5 * 1024 * 1024],
];

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

describe("age keys", () => {
  it("derives the recipient from the identity, and the two encodings agree", () => {
    const { identity, recipient } = generateIdentity();
    const raw = parseIdentity(identity);
    expect(raw.length).toBe(32);
    expect(encodeRecipient(recipientFromIdentity(raw))).toBe(recipient);
    expect(parseRecipient(recipient).equals(recipientFromIdentity(raw))).toBe(true);
    expect(encodeIdentity(raw)).toBe(identity);
  });

  it("refuses the wrong HRP, the wrong length, and a corrupted key", () => {
    const { identity, recipient } = generateIdentity();
    expect(() => parseRecipient(identity)).toThrow(AgeError);
    expect(() => parseIdentity(recipient)).toThrow(AgeError);
    expect(() => encodeRecipient(randomBytes(31))).toThrow(/32 bytes, got 31/);
    expect(() => encodeIdentity(randomBytes(33))).toThrow(/32 bytes, got 33/);
    expect(() => parseRecipient(`${recipient.slice(0, -1)}q`)).toThrow(AgeError);
    expect(() => new AgeDecryptStream(randomBytes(31))).toThrow(/identity must be 32 bytes/);
  });

  it("tolerates surrounding whitespace, since a key file ends in a newline", () => {
    const { identity, recipient } = generateIdentity();
    expect(parseIdentity(`  ${identity}\n`).equals(parseIdentity(identity))).toBe(true);
    expect(parseRecipient(`${recipient}\n`).equals(parseRecipient(recipient))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shape and refusals — the half that fails loudly
// ---------------------------------------------------------------------------

describe("age file shape and refusals", () => {
  it("refuses an empty recipient list rather than sealing to nobody", () => {
    // "Encrypted to no one" is a file that pushes successfully and is
    // unreadable forever. Silence here would defeat the whole failure rule.
    expect(() => new AgeEncryptStream([])).toThrow(AgeError);
    expect(() => new AgeEncryptStream([])).toThrow(/empty recipient list/);
  });

  it("writes a header the spec's own grammar accepts, and one final chunk for an empty payload", async () => {
    const file = await encrypt(Buffer.alloc(0));
    const text = file.toString("binary");
    expect(text.startsWith("age-encryption.org/v1\n-> X25519 ")).toBe(true);

    const markIdx = text.indexOf("\n--- ");
    const headerLen = text.indexOf("\n", markIdx + 1) + 1;
    // Header, then a 16-byte payload nonce, then the sole (empty) final chunk,
    // which is 16 bytes of tag and nothing else. An empty final chunk is legal
    // exactly and only when the whole payload is empty.
    expect(file.length).toBe(headerLen + 16 + 16);

    // An X25519 stanza body is the 16-byte file key plus a 16-byte tag = 32
    // bytes = 43 unpadded base64 characters. It is therefore ALWAYS one line
    // shorter than the 64-column wrap, and the trailing-empty-line branch of
    // the writer is never taken by our own stanzas — which is precisely why
    // the reader's version of that rule is tested against a hand-written
    // GREASE stanza below instead of against our own output.
    const headerLines = text.slice(0, markIdx).split("\n");
    expect(headerLines.length).toBe(3);
    expect(headerLines[1]!.startsWith("-> X25519 ")).toBe(true);
    expect(headerLines[1]!.slice("-> X25519 ".length).length).toBe(43);
    expect(headerLines[2]!.length).toBe(43);
    // Unpadded base64 throughout the HEADER. Scoped to the header on purpose:
    // the rest of the file is the payload nonce and a Poly1305 tag, i.e. random
    // bytes, roughly one in eight of which happens to contain a 0x3d.
    expect(text.slice(0, headerLen).includes("=")).toBe(false);
  });

  it("round-trips through itself at every boundary size (NOT proof of correctness)", async () => {
    // This is the test the file header warns about: a defect in a helper shared
    // by both directions passes it perfectly. It is here to catch coarse
    // breakage, and `crypto-age-mutations.test.ts` is here to prove it cannot
    // catch the fine kind.
    for (const [, n] of sizes) {
      const plain = payload(n);
      const back = await decrypt(await encrypt(plain));
      expect(back.length).toBe(n);
      expect(createHash("sha256").update(back).digest("hex")).toBe(
        createHash("sha256").update(plain).digest("hex"),
      );
    }
  });

  it("addresses a file to several recipients and lets each one open it", async () => {
    const second = generateIdentity();
    const plain = payload(CHUNK + 9);
    const file = await encrypt(plain, [recipientRaw, parseRecipient(second.recipient)]);
    expect((await decrypt(file)).equals(plain)).toBe(true);
    expect((await decrypt(file, parseIdentity(second.identity))).equals(plain)).toBe(true);
  });

  it("reports a stranger's file as no-matching-identity, not as corruption", async () => {
    const stranger = generateIdentity();
    const file = await encrypt(payload(100), [parseRecipient(stranger.recipient)]);
    expect(await ageErrorCode(decrypt(file))).toBe("no-matching-identity");
  });

  it("rejects a bit flip in the payload, in the header, and in the MAC", async () => {
    const file = await encrypt(payload(CHUNK * 2 + 5));

    const flippedPayload = Buffer.from(file);
    flippedPayload[flippedPayload.length - 20] ^= 0x01;
    expect(await ageErrorCode(decrypt(flippedPayload))).toBe("payload-authentication-failed");

    // A flipped stanza byte breaks the unwrap before the MAC is ever checked.
    const text = file.toString("binary");
    const stanzaByte = text.indexOf("-> X25519 ") + 15;
    const flippedStanza = Buffer.from(file);
    flippedStanza[stanzaByte] ^= 0x01;
    expect(["no-matching-identity", "malformed-header"]).toContain(
      await ageErrorCode(decrypt(flippedStanza)),
    );

    // A flipped MAC byte survives the unwrap and must die at the MAC check.
    const macByte = text.indexOf("\n--- ") + 6;
    const flippedMac = Buffer.from(file);
    flippedMac[macByte] = flippedMac[macByte] === 0x61 ? 0x62 : 0x61;
    expect(await ageErrorCode(decrypt(flippedMac))).toBe("header-mac-mismatch");
  });

  it("rejects truncation of the final chunk — the STREAM guarantee", async () => {
    // The whole point of the final-chunk flag: a bundle cut short in transit
    // must not be mistaken for a shorter bundle.
    const file = await encrypt(payload(CHUNK * 2 + 5));
    expect(await ageErrorCode(decrypt(file.subarray(0, file.length - CHUNK / 2)))).toBe(
      "payload-authentication-failed",
    );
    // Dropping the whole trailing chunk leaves a byte-aligned prefix, which is
    // the case a length-only check would wave through.
    expect(await ageErrorCode(decrypt(file.subarray(0, file.length - (5 + 16))))).toBe(
      "payload-authentication-failed",
    );
  });

  it("rejects a truncated header rather than treating it as a short file", async () => {
    const file = await encrypt(payload(100));
    const cut = file.toString("binary").indexOf("\n--- ") + 3;
    expect(await ageErrorCode(decrypt(file.subarray(0, cut)))).toBe("truncated");
  });

  it("bounds how much it will buffer looking for a header it will never find", async () => {
    // Without the cap, a stream with no `\n--- ` is accumulated in full and
    // rescanned on every write. The read side handles hub-supplied bytes, so
    // "hostile or truncated input" is the normal case, not the exotic one.
    const junk = Buffer.alloc(200 * 1024, 0x41);
    expect(await ageErrorCode(decrypt(junk))).toBe("malformed-header");
  });

  it("rejects a file whose version line is not age v1", async () => {
    const file = await encrypt(payload(10));
    const forged = Buffer.concat([
      Buffer.from("age-encryption.org/v2\n", "utf-8"),
      file.subarray(file.toString("binary").indexOf("\n") + 1),
    ]);
    expect(await ageErrorCode(decrypt(forged))).toBe("unsupported-version");
  });
});

// ---------------------------------------------------------------------------
// The stanza grammar, including the rule `rage` exists to break
// ---------------------------------------------------------------------------

describe("stanza grammar", () => {
  /**
   * "MUST ignore any stanza that does not have X25519 as the first argument"
   * is ENFORCEMENT, not politeness: `rage` emits a `Gh-grease` stanza on every
   * file it writes (deliberate anti-ossification, like TLS GREASE), so a reader
   * that assumes one stanza breaks on rage-produced files in the field.
   *
   * The end-to-end version of this needs `rage` installed. This one does not,
   * because the header MAC covers the stanzas and a test cannot splice a GREASE
   * stanza into a real file without the file key — so it is asserted at the
   * parse level, which is the only place the grammar is implemented.
   */
  it("parses a GREASE stanza with a 64-column-wrapped body and keeps the X25519 one", () => {
    const grease = ["A".repeat(64), "B".repeat(64), "C".repeat(10)];
    const x25519Body = "D".repeat(64);
    const header =
      "age-encryption.org/v1\n" +
      `-> Gh-grease pQO2 mv aTaXpMLHy60Jp5aSMOFwuGN\n${grease.join("\n")}\n` +
      `-> X25519 ${"E".repeat(43)}\n${x25519Body}\n\n` +
      "--- abcdef\n";
    const parsed = parseHeader(Buffer.from(header, "utf-8"));

    expect(parsed.stanzas.length).toBe(2);
    expect(parsed.stanzas[0]!.args).toEqual(["Gh-grease", "pQO2", "mv", "aTaXpMLHy60Jp5aSMOFwuGN"]);
    // The body ran to the first line SHORTER than 64 characters and stopped
    // there — that is the only rule by which an unknown stanza of unknown
    // length can be skipped without understanding it.
    expect(parsed.stanzas[0]!.body.equals(Buffer.from(grease.join(""), "base64"))).toBe(true);
    expect(parsed.stanzas[1]!.args[0]).toBe("X25519");
    expect(parsed.stanzas[1]!.body.equals(Buffer.from(x25519Body, "base64"))).toBe(true);
    // The MAC covers the header up to and INCLUDING the mark, and NOT the space
    // after it. Tidying that boundary makes every file we write unreadable.
    expect(parsed.upToMark.endsWith("\n---")).toBe(true);
    expect(parsed.upToMark.endsWith("--- ")).toBe(false);
    expect(parsed.payloadOffset).toBe(header.length);
  });

  it("refuses padded base64 rather than stripping it", () => {
    const header =
      "age-encryption.org/v1\n" + `-> X25519 ${"E".repeat(43)}\nQUJD=\n` + "--- abcdef\n";
    expect(() => parseHeader(Buffer.from(header, "utf-8"))).toThrow(/padding is not allowed/);
  });

  it("refuses a header line that is not a stanza", () => {
    const header = "age-encryption.org/v1\nnonsense\n--- abcdef\n";
    expect(() => parseHeader(Buffer.from(header, "utf-8"))).toThrow(/expected a stanza/);
  });
});

// ---------------------------------------------------------------------------
// The differential half — the load-bearing one
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_ORACLE)("differential against a real age implementation", () => {
  it("uses at least one external implementation", () => {
    expect(ORACLES.length).toBeGreaterThan(0);
  });

  it.skipIf(!AGE_KEYGEN)("agrees with `age-keygen` on the identity -> recipient derivation", () => {
    const gen = execFileSync(AGE_KEYGEN!, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    const idLine = gen.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-"))!;
    const pub = gen.match(/public key: (age1[a-z0-9]+)/)![1]!;
    expect(encodeRecipient(recipientFromIdentity(parseIdentity(idLine)))).toBe(pub);
  });

  for (const { name, bin } of ORACLES) {
    describe(name, () => {
      it("accepts an identity file WE minted", async () => {
        // The spike only ever consumed age-keygen output, so this direction was
        // untested: our bech32 writer, the uppercase HRP, and the trailing-"-"
        // in it, all read back by the reference implementation.
        const file = join(dir, `${name}-ourkey.age`);
        writeFileSync(file, await encrypt(payload(10)));
        expect(oracleDecrypt(bin, keyFile, file).equals(payload(10))).toBe(true);
      });

      for (const [label, n] of sizes) {
        it(`we encrypt, ${name} decrypts: ${label} (${n} bytes)`, async () => {
          const plain = payload(n);
          const encFile = join(dir, `${name}-ours-${n}.age`);
          writeFileSync(encFile, await encrypt(plain));
          const got = oracleDecrypt(bin, keyFile, encFile);
          expect(got.length).toBe(plain.length);
          expect(createHash("sha256").update(got).digest("hex")).toBe(
            createHash("sha256").update(plain).digest("hex"),
          );
        });

        it(`${name} encrypts, we decrypt: ${label} (${n} bytes)`, async () => {
          const plain = payload(n);
          const inFile = join(dir, `${name}-in-${n}.bin`);
          const encFile = join(dir, `${name}-theirs-${n}.age`);
          writeFileSync(inFile, plain);
          oracleEncrypt(bin, recipientStr, inFile, encFile);
          const got = await decrypt(readFileSync(encFile));
          expect(got.length).toBe(plain.length);
          expect(createHash("sha256").update(got).digest("hex")).toBe(
            createHash("sha256").update(plain).digest("hex"),
          );
        });
      }

      it(`${name} opens a file addressed to two recipients`, async () => {
        const second = generateIdentity();
        const key2 = join(dir, `${name}-key2.txt`);
        writeFileSync(key2, `${second.identity}\n`, { mode: 0o600 });
        const plain = payload(CHUNK + 9);
        const encFile = join(dir, `${name}-multi.age`);
        writeFileSync(encFile, await encrypt(plain, [recipientRaw, parseRecipient(second.recipient)]));
        for (const k of [keyFile, key2]) {
          expect(oracleDecrypt(bin, k, encFile).equals(plain)).toBe(true);
        }
      });

      it(`${name} rejects a bit flip in a file we wrote`, async () => {
        const file = await encrypt(payload(CHUNK * 2 + 5));
        file[file.length - 20] ^= 0x01;
        const p = join(dir, `${name}-flipped.age`);
        writeFileSync(p, file);
        expect(() => oracleDecrypt(bin, keyFile, p)).toThrow();
      });

      it(`${name} rejects truncation of the final chunk`, async () => {
        const file = await encrypt(payload(CHUNK * 2 + 5));
        const p = join(dir, `${name}-trunc.age`);
        writeFileSync(p, file.subarray(0, file.length - CHUNK / 2));
        expect(() => oracleDecrypt(bin, keyFile, p)).toThrow();
      });
    });
  }
});

// A stream that emits nothing at all still has to produce a valid file, and it
// is the one input `awkwardWrites` cannot deliver (it pushes null immediately).
it("encrypts a source that never writes", async () => {
  const out: Buffer[] = [];
  const enc = new AgeEncryptStream([recipientRaw]);
  const empty = awkwardWrites(Buffer.alloc(0));
  await new Promise<void>((resolve, reject) => {
    enc.on("data", (c: Buffer) => out.push(c));
    enc.on("end", resolve);
    enc.on("error", reject);
    empty.pipe(enc);
  });
  expect((await decrypt(Buffer.concat(out))).length).toBe(0);
});
