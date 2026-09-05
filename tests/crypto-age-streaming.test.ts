/**
 * # The streaming constraint, pinned
 *
 * `src/crypto/age.ts`'s header lists a deliberate non-feature that, until this
 * file, nothing enforced: there is NO whole-buffer `encrypt(Buffer): Buffer`
 * helper, and never will be. Both bundle paths are pipelines, the largest
 * writer in this codebase is the detached SessionEnd auto-push, and a
 * convenience helper is exactly how a whole-archive buffer gets reintroduced
 * by someone who did not read that header. Before this file, that helper could
 * be exported tomorrow and every test stayed green (#96: "Streaming is not
 * pinned. ... nothing fails if a buffer helper appears later").
 *
 * Be precise about which pin this file actually is. It pins FOUR things:
 *
 *  1. The module's runtime EXPORT SURFACE, exactly and classified. Every
 *     export must be one of: a Transform subclass, the error class, a
 *     fixed-size key codec, an scrypt constant, or the test-only header
 *     parser. "Function that returns payload bytes" is not an available
 *     classification, so adding `encryptBuffer` means editing the table below
 *     and writing down which of those it pretends to be.
 *  2. That the three stream classes are REAL `node:stream` Transforms —
 *     `instanceof` against the imported base class, never a name check — with
 *     NO static member and NO new prototype member. Statics and instance
 *     methods are the two spellings of a whole-buffer helper that would not
 *     change the export surface at all.
 *  3. WHICH files in `src/` touch the stream classes, by source scan with an
 *     allowlist (the `hub-retire.test.ts` pattern). A new module that wraps a
 *     stream in `Buffer.concat` at least has to name itself here and say why.
 *  4. Incrementality, BEHAVIORALLY: sealed/opened bytes must come OUT of each
 *     Transform before `end()` goes in. This is the cheap half of the
 *     insidious version of the defect — a Transform that is still a Transform
 *     but accumulates internally and emits everything from `_flush`. That
 *     mutation changes only WHEN bytes are emitted, never which bytes.
 *     MEASURED during this file's mutation runs (2026-09-03): with the
 *     encryptor rewritten to accumulate-then-flush, `crypto-age.test.ts`'s
 *     always-on half passes in full — 25 tests, including every size-matrix
 *     round-trip opened by the strict, UNTOUCHED decryptor, so the mutated
 *     output is a valid, correctly chunked STREAM file (the differential half
 *     was skipped on the measuring machine for want of an `age` binary, and
 *     would accept the same bytes for the same reason). The emit-before-end
 *     assertions below were the only failure in the suite.
 *
 * And be equally precise about what a green run here does NOT mean:
 *
 *  - A whole-buffer wrapper INSIDE an allowlisted consumer (`hub/bundle-io.ts`,
 *    `hub/escrow.ts`) is invisible: the scan pins who touches the streams, not
 *    how. `bundle-io.ts`'s own header ("the streams go INTO the two transports'
 *    existing pipelines") is prose, not enforcement.
 *  - Internal RETENTION is invisible: a Transform that emits incrementally
 *    (passing test 4) while also keeping a private copy of everything it saw.
 *    Emit-before-end bounds when bytes leave, not what is held. Memory is
 *    deliberately NOT asserted — an RSS assertion under a garbage collector is
 *    a flake generator — so age.ts's "512 MB at ~96 MB RSS" stays what it is:
 *    a measured spike result, not a regression test.
 *  - `tests/helpers/age-oracle.ts`'s `through()` IS a whole-buffer helper, on
 *    purpose, for test payloads that must be compared byte for byte. The
 *    constraint is about `src/`; this file uses `through()` itself.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import * as age from "../src/crypto/age.js";
import { payload, through } from "./helpers/age-oracle.js";

const CHUNK = 65536;
const TAG = 16;
const ENC_CHUNK = CHUNK + TAG;
const ROOT = join(import.meta.dirname, "..");

let identityRaw: Buffer;
let recipientRaw: Buffer;
let identity2Raw: Buffer;
let recipient2Raw: Buffer;

beforeAll(() => {
  const a = age.generateIdentity();
  const b = age.generateIdentity();
  identityRaw = age.parseIdentity(a.identity);
  recipientRaw = age.parseRecipient(a.recipient);
  identity2Raw = age.parseIdentity(b.identity);
  recipient2Raw = age.parseRecipient(b.recipient);
});

// ---------------------------------------------------------------------------
// 1. The export surface, exactly and classified
// ---------------------------------------------------------------------------

type ExportKind =
  | "transform" // a class whose prototype chain includes node:stream Transform
  | "error-class" // AgeError
  | "key-codec" // functions over FIXED-SIZE key material, never payload bytes
  | "scrypt-constant" // small integer work-factor constants
  | "test-only-parser"; // the __...ForTests escape hatch

/**
 * Every runtime export, with the classification that makes it not a
 * whole-buffer hole. Type-only exports (`AgeErrorCode`, `AgePassphraseTarget`)
 * do not exist at runtime and deliberately do not appear.
 *
 * Adding an entry is meant to be cheap — that is the retire-test allowlist
 * pattern — but it is a security edit: read age.ts's header, "Deliberate
 * non-features", before classifying anything new. If the honest classification
 * would be "takes or returns payload bytes", the export must not exist.
 */
const SURFACE: Record<string, ExportKind> = {
  AgeEncryptStream: "transform",
  AgeDecryptStream: "transform",
  AgeRewrapStream: "transform",
  AgeError: "error-class",
  parseRecipient: "key-codec",
  parseIdentity: "key-codec",
  encodeRecipient: "key-codec",
  encodeIdentity: "key-codec",
  recipientFromIdentity: "key-codec",
  generateIdentity: "key-codec",
  AGE_SCRYPT_LOG_N: "scrypt-constant",
  AGE_SCRYPT_MAX_LOG_N: "scrypt-constant",
  __parseHeaderForTests: "test-only-parser",
};

describe("age.ts exports streams and key codecs, exactly", () => {
  it("exports exactly the classified surface — nothing appears unclassified", () => {
    expect(
      Object.keys(age).sort(),
      "The runtime export surface of src/crypto/age.ts changed. If the new " +
        "export takes or returns PAYLOAD bytes (a whole-buffer encrypt/decrypt " +
        "helper, however named), it is the exact thing age.ts's 'Deliberate " +
        "non-features' header forbids: callers pipe. Otherwise classify it in " +
        "SURFACE above and say why it is not a hole."
    ).toEqual(Object.keys(SURFACE).sort());
  });

  it("every export satisfies its claimed classification", () => {
    for (const [name, kind] of Object.entries(SURFACE)) {
      const v = (age as Record<string, unknown>)[name];
      switch (kind) {
        case "transform": {
          expect(typeof v, name).toBe("function");
          const proto = (v as { prototype?: unknown }).prototype;
          // The real base class from node:stream, not a name match: a class
          // merely CALLED ...Stream, or extending a local shim, fails here.
          expect(proto instanceof Transform, `${name} must extend node:stream Transform`).toBe(true);
          break;
        }
        case "error-class": {
          const proto = (v as { prototype?: unknown }).prototype;
          expect(proto instanceof Error, name).toBe(true);
          expect(proto instanceof Transform, name).toBe(false);
          break;
        }
        case "key-codec": {
          expect(typeof v, name).toBe("function");
          const proto = (v as { prototype?: unknown }).prototype;
          expect(proto instanceof Transform, `${name} claims to be a codec, is a stream`).toBe(false);
          break;
        }
        case "scrypt-constant": {
          expect(typeof v, name).toBe("number");
          // A work factor is a small exponent. 2^31 "constants" need not apply.
          expect(Number.isInteger(v) && (v as number) > 0 && (v as number) <= 30, name).toBe(true);
          break;
        }
        case "test-only-parser": {
          expect(typeof v, name).toBe("function");
          expect(name.startsWith("__") && name.endsWith("ForTests"), name).toBe(true);
          break;
        }
      }
    }
  });

  it("the key codecs traffic in fixed-size key material, not payloads", () => {
    // Behavioral, so "key-codec" above is a checked claim rather than a label:
    // every codec output is a bech32 string or exactly 32 key bytes.
    const { identity, recipient } = age.generateIdentity();
    expect(typeof identity).toBe("string");
    expect(typeof recipient).toBe("string");
    expect(age.parseIdentity(identity).length).toBe(32);
    expect(age.parseRecipient(recipient).length).toBe(32);
    expect(age.recipientFromIdentity(age.parseIdentity(identity)).length).toBe(32);
    expect(age.encodeIdentity(age.parseIdentity(identity))).toBe(identity);
    expect(age.encodeRecipient(age.parseRecipient(recipient))).toBe(recipient);
  });
});

// ---------------------------------------------------------------------------
// 2. The classes: real Transforms, no static side door, no new methods
// ---------------------------------------------------------------------------

describe("the stream classes have no non-stream surface", () => {
  it("instances are Transforms that implement the stream contract", () => {
    const enc = new age.AgeEncryptStream([recipientRaw]);
    const dec = new age.AgeDecryptStream(identityRaw);
    const rw = new age.AgeRewrapStream(identityRaw, [recipient2Raw]);
    for (const s of [enc, dec, rw]) {
      expect(s).toBeInstanceOf(Transform);
      s.destroy();
    }
  });

  it("no class carries a static member — the export-set pin cannot see one", () => {
    // `AgeEncryptStream.encryptBuffer = ...` changes nothing in test 1 and is
    // the second most plausible spelling of the forbidden helper.
    for (const C of [age.AgeEncryptStream, age.AgeDecryptStream, age.AgeRewrapStream]) {
      expect(Object.getOwnPropertyNames(C).sort(), C.name).toEqual(["length", "name", "prototype"]);
    }
  });

  it("no class grows a prototype member — the third spelling of the helper", () => {
    // Private TS methods are runtime prototype properties, so they are listed
    // too. A renamed private helper is a one-line edit here; that is the
    // point — the diff lands in front of a reviewer holding this comment.
    const PROTO: Record<string, string[]> = {
      AgeEncryptStream: ["_flush", "_transform", "constructor", "emitHeaderOnce"],
      AgeDecryptStream: ["_flush", "_transform", "constructor", "tryHeader"],
      AgeRewrapStream: ["_flush", "_transform", "constructor", "previousRecipientStanzas", "tryHeader"],
    };
    for (const C of [age.AgeEncryptStream, age.AgeDecryptStream, age.AgeRewrapStream]) {
      expect(
        Object.getOwnPropertyNames(C.prototype).sort(),
        `${C.name}: a new prototype member. If it hands back accumulated ` +
          "payload bytes, it is the whole-buffer helper this file refuses; " +
          "if it is a renamed private helper, update PROTO."
      ).toEqual(PROTO[C.name]!.sort());
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Who touches the streams (source scan, hub-retire.test.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Every file in `src/` that names a stream class outside a comment. This does
 * NOT police how a consumer uses the stream (see the header); it forces a NEW
 * consumer — the natural home of a `Buffer.concat(chunks)` wrapper — through
 * an allowlist edit with a stated reason.
 */
const ALLOWED_STREAM_TOUCHERS: Record<string, string> = {
  "src/crypto/age.ts": "the definition site",
  "src/hub/bundle-io.ts":
    "the one plaintext/ciphertext boundary — streams go INTO the transports' existing pipelines",
  "src/hub/escrow.ts":
    "passphrase-wraps identity.age through the same Transforms; small file, still piped",
};

describe("stream consumers are enumerated", () => {
  function srcFiles(dir: string, prefix = "src"): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) out.push(...srcFiles(join(dir, e.name), rel));
      else if (e.name.endsWith(".ts")) out.push(rel);
    }
    return out;
  }

  function touchesStreams(file: string): boolean {
    return readFileSync(join(ROOT, file), "utf-8")
      .split("\n")
      .some((raw) => {
        const t = raw.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
        return /\bAge(Encrypt|Decrypt|Rewrap)Stream\b/.test(t);
      });
  }

  it("keeps every file naming a stream class in the allowlist", () => {
    const offenders = srcFiles(join(ROOT, "src")).filter(
      (f) => touchesStreams(f) && !(f in ALLOWED_STREAM_TOUCHERS)
    );
    expect(
      offenders,
      "A new consumer of the age streams. If it collects a stream's output " +
        "into one Buffer, it has reintroduced the whole-archive buffer that " +
        "age.ts's header forbids — pipe instead (see hub/bundle-io.ts). " +
        "Otherwise add it to ALLOWED_STREAM_TOUCHERS with the reason."
    ).toEqual([]);

    // ...and the allowlist may not rot: an entry that no longer touches a
    // stream (or no longer exists) is an entry nobody would notice going stale.
    const stale = Object.keys(ALLOWED_STREAM_TOUCHERS).filter(
      (f) => !existsSync(join(ROOT, f)) || !touchesStreams(f)
    );
    expect(stale).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Incrementality: bytes come OUT before end() goes in
// ---------------------------------------------------------------------------

/**
 * Collect a Transform's output while keeping the write side open. The math
 * below leans on two facts from age.ts: the hold-back keeps at most ONE chunk
 * (`> CHUNK_SIZE` / `> ENC_CHUNK_SIZE`), and a one-recipient header plus the
 * payload nonce is far smaller than a chunk — so "collected >= 3 chunks' worth"
 * can only be satisfied by 3 sealed/opened chunks actually having been emitted.
 */
function sink(t: Transform): { bytes: () => number; all: () => Buffer; done: Promise<void> } {
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    t.on("end", resolve);
    t.on("error", reject);
  });
  t.on("data", (c: Buffer) => chunks.push(c));
  return {
    bytes: () => chunks.reduce((n, b) => n + b.length, 0),
    all: () => Buffer.concat(chunks),
    done,
  };
}

const settle = async (): Promise<void> => {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
};

describe("the transforms are incremental, not accumulate-then-flush", () => {
  it("the encryptor emits sealed chunks before the input ends", async () => {
    const plain = payload(3 * CHUNK + 7);
    const enc = new age.AgeEncryptStream([recipientRaw]);
    const out = sink(enc);

    enc.write(plain);
    await settle();
    // 3 full chunks in means >= 3 sealed chunks out; only the 7-byte tail may
    // wait for the final-chunk decision. An accumulate-in-_flush encryptor
    // produces a BYTE-IDENTICAL file — every round-trip and the differential
    // suite stay green — and fails exactly here, with 0 bytes emitted.
    expect(out.bytes()).toBeGreaterThanOrEqual(3 * ENC_CHUNK);

    enc.end();
    await out.done;
    // Harness sanity only — proves the bytes counted above were the real file,
    // vouches for nothing else (see crypto-age.test.ts on self-round-trips).
    const round = await through(out.all(), new age.AgeDecryptStream(identityRaw));
    expect(round.equals(plain)).toBe(true);
  });

  it("the decryptor emits plaintext before the file ends", async () => {
    const plain = payload(3 * CHUNK + 7);
    const file = await through(plain, new age.AgeEncryptStream([recipientRaw]));
    const dec = new age.AgeDecryptStream(identityRaw);
    const out = sink(dec);

    dec.write(file.subarray(0, file.length - 1));
    await settle();
    // Everything but the last byte is in, so chunks 0..2 are decidable-as-
    // non-final and must be open; only the partial final chunk is held.
    expect(out.bytes()).toBeGreaterThanOrEqual(3 * CHUNK);

    dec.end(file.subarray(file.length - 1));
    await out.done;
    expect(out.all().equals(plain)).toBe(true);
  });

  it("the rewrapper copies payload through before the file ends", async () => {
    const plain = payload(3 * CHUNK + 7);
    const file = await through(plain, new age.AgeEncryptStream([recipientRaw]));
    const rw = new age.AgeRewrapStream(identityRaw, [recipient2Raw]);
    const out = sink(rw);

    rw.write(file.subarray(0, file.length - 1));
    await settle();
    // The rewrapper holds nothing back after the header (no nonce to decide),
    // so at least the three full payload chunks' worth must already be out.
    expect(out.bytes()).toBeGreaterThanOrEqual(3 * ENC_CHUNK);

    rw.end(file.subarray(file.length - 1));
    await out.done;
    const round = await through(out.all(), new age.AgeDecryptStream(identity2Raw));
    expect(round.equals(plain)).toBe(true);
  });
});
