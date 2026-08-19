/**
 * age v1 (`age-encryption.org/v1`) encryption and decryption, implemented
 * in-process over `node:crypto`. THIS IS THE HIGHEST-STAKES FILE IN THIS
 * REPOSITORY. Read this header before changing anything below it.
 *
 * ---------------------------------------------------------------------------
 * Why in-process, and why this format
 * ---------------------------------------------------------------------------
 *
 * Encryption cannot degrade the way `zstd` and `git merge-file` are allowed to.
 * Those two have a fallback that satisfies the SAME property (a container that
 * still detects corruption; a merge mode that still never overwrites). The only
 * thing a missing encryptor can fall back to is plaintext, and plaintext is not
 * a lesser confidentiality — it is its absence, and it is invisible to everyone
 * except the machine that pushed. Hence the failure rule this module exists to
 * make keepable:
 *
 *   > If encryption is enabled and the encryptor is unavailable or fails, the
 *   > operation FAILS. No fallback, no warning-and-continue, no plaintext
 *   > bundle. On the read side, a bundle that cannot be decrypted aborts that
 *   > bundle and therefore the chain.
 *
 * A hard failure rule disqualifies an external binary, because the failure
 * lands on the least-controlled surface this plugin has: the SessionEnd
 * auto-push is detached, async, has no TTY and no user present. `node:crypto`
 * has every primitive age uses at the pinned Node floor, so there is nothing to
 * be absent, no subprocess and no TTY.
 *
 * The format is nevertheless age's, not ours, for one user-facing reason:
 * `age -d -i key.txt bundle.tar.gz.age` recovers a bundle with this plugin
 * uninstalled. Key loss and plugin loss must not be the same event as session
 * loss. The second reason is the one that decides how this file is TESTED, and
 * it is the more important of the two — see below.
 *
 * ---------------------------------------------------------------------------
 * The three SECURITY-CRITICAL blocks, and the one that is silent
 * ---------------------------------------------------------------------------
 *
 * Three blocks below carry a `SECURITY-CRITICAL` banner: the X25519 recipient
 * stanza (#1), the header MAC (#2), and the STREAM payload chunking (#3). Two
 * of them fail loudly if they are wrong — a bad stanza cannot be unwrapped, a
 * bad MAC does not verify. #3 is the dangerous one, because it can be wrong in
 * a way that produces a file which decrypts perfectly and is catastrophically
 * insecure.
 *
 * MEASURED, not asserted (spike, 2026-08-18): with the chunk counter frozen at
 * zero, encrypting AND decrypting through this module reproduces the plaintext
 * byte for byte, while every chunk in the file reuses one ChaCha20-Poly1305
 * nonce. A self-round-trip test is green. The file is broken beyond repair —
 * nonce reuse under a stream cipher leaks the XOR of the plaintexts and burns
 * the Poly1305 key. The real `age` binary rejects it instantly.
 *
 * THEREFORE: the differential test in `tests/crypto-age.test.ts` — encrypt
 * here, decrypt with the real `age` binary — is the load-bearing test for this
 * file, not a nice-to-have. A defect in a helper shared by both directions is
 * invisible to any test that only talks to itself. Two consequences for anyone
 * adding tests here:
 *
 *   1. Nonce reuse is only observable when the payload spans >= 2 CHUNKS. A
 *      single-chunk test misses it entirely. The >= 64 KiB cases are
 *      load-bearing, not thoroughness.
 *   2. `>` versus `>=` in the chunk hold-back is invisible at every size
 *      EXCEPT an exact multiple of 64 KiB. The exact-multiple cases are
 *      load-bearing too, and no randomly-sized payload ever hits them.
 *
 * `tests/crypto-age-mutations.test.ts` re-runs the spike's mutation matrix by
 * patching the BUILT module and confirming the real binary rejects each defect.
 * The mutation switches deliberately do not exist in this file: a shipped
 * `if (bug === "counter-frozen")` is a nonce-reuse switch sitting in `dist/`.
 *
 * ---------------------------------------------------------------------------
 * Facts that cost time to learn (verified against age 1.2.1 AND rage 0.12.1)
 * ---------------------------------------------------------------------------
 *
 * - The file key is 128-bit, not 256. The payload key is 256-bit.
 * - Base64 throughout is standard, UNPADDED and canonical. A "=" is a parse
 *   error, not something to strip.
 * - The header MAC covers the header up to and INCLUDING the `---` mark, and
 *   NOT the space that follows it.
 * - "MUST ignore any stanza that does not have X25519 as the first argument"
 *   is enforcement, not politeness: `rage` emits a `Gh-grease` stanza on every
 *   file it writes (deliberate anti-ossification, like TLS GREASE). A reader
 *   that assumes one stanza breaks on rage-produced files. Its 64-column
 *   wrapped body is also the only thing that exercises the "a stanza body ends
 *   at the first line shorter than 64 characters" rule, which an X25519-only
 *   implementation never otherwise reaches.
 * - Node has no raw X25519 key import, so the DER prefixes below are
 *   hand-built. That is fiddly, not dangerous — see `bech32.ts`'s header for
 *   why key handling fails loudly.
 *
 * ---------------------------------------------------------------------------
 * Deliberate non-features
 * ---------------------------------------------------------------------------
 *
 * - NO whole-buffer `encrypt(Buffer): Buffer` helper. Streaming is a hard
 *   constraint: both bundle paths are already pipelines, and 512 MB piped
 *   through BOTH transforms below peaked at 95.8 MB RSS (measured on this
 *   module, 2026-08-19; the spike measured 96.8 MB on its own). A convenience
 *   helper is how a whole-archive buffer gets reintroduced by someone who did
 *   not read this. Callers pipe.
 * - NO scrypt/passphrase recipient. That is separate security-critical code
 *   (work factor, params) and a separate decision, default off.
 * - NO armor, and no post-quantum X-Wing recipient.
 * - Nothing in this module runs at import time beyond constructing a handful of
 *   constant Buffers from hex/ASCII literals. No randomness, no filesystem, no
 *   environment, no subprocess. It is inert until called.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { bech32Decode, bech32Encode } from "./bech32.js";

// ---------------------------------------------------------------------------
// Constants from the spec (c2sp.org/age). Section names below refer to it.
// ---------------------------------------------------------------------------

/** §Payload: "The payload is split in chunks of 64 KiB". */
const CHUNK_SIZE = 65536;
/** ChaCha20-Poly1305 tag. */
const TAG_SIZE = 16;
const ENC_CHUNK_SIZE = CHUNK_SIZE + TAG_SIZE;
/** §File key: "Each file is encrypted with a 128-bit symmetric file key." */
const FILE_KEY_SIZE = 16;
/** §Payload: a random 16-byte nonce sits between the header and the first chunk. */
const PAYLOAD_NONCE_SIZE = 16;
/** An X25519 public key / ephemeral share. */
const X25519_KEY_SIZE = 32;
const VERSION_LINE = "age-encryption.org/v1";
const X25519_INFO = "age-encryption.org/v1/X25519";
const PAYLOAD_INFO = "payload";
const HEADER_INFO = "header";
const RECIPIENT_HRP = "age";
const IDENTITY_HRP = "AGE-SECRET-KEY-";
/** §Recipient stanza: the body is base64 wrapped at 64 columns. */
const STANZA_WRAP_COLUMNS = 64;
/** The end-of-header mark, as it appears in the byte stream. */
const HEADER_MARK = Buffer.from("\n--- ", "utf-8");
const LF = 0x0a;

/**
 * Hard cap on how many bytes may be buffered while looking for the end of the
 * header. Not arbitrary: one X25519 stanza is exactly 98 bytes (`-> X25519 ` =
 * 10, share = 43, LF, body = 43, LF), so 64 KiB admits ~668 recipients — far
 * past any plausible number of machines on a hub — while bounding what a
 * hostile or truncated file can make this module hold in memory and re-scan.
 * Without it, a stream that never contains a mark is accumulated in full and
 * rescanned on every write.
 */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Distinguishable failure reasons. Callers get to tell "you are not a recipient
 * of this bundle" (a key-management problem, actionable: rekey, re-push) from
 * "chunk 3 failed authentication" (corruption or tampering, not actionable) —
 * without string-matching a message. The abort behaviour is the same for all of
 * them; only the diagnosis differs.
 */
export type AgeErrorCode =
  | "no-recipients"
  | "bad-key"
  | "malformed-header"
  | "unsupported-version"
  | "no-matching-identity"
  | "header-mac-mismatch"
  | "payload-authentication-failed"
  | "truncated";

export class AgeError extends Error {
  readonly code: AgeErrorCode;
  constructor(code: AgeErrorCode, message: string) {
    super(message);
    this.name = "AgeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Key encoding and derivation. Fiddly, NOT security-critical — a mistake here
// fails loudly and immediately (Node throws on malformed DER, or the shared
// secret disagrees and the recipient cannot unwrap). See `bech32.ts`.
// ---------------------------------------------------------------------------

/** ASN.1 DER prefixes for X25519. Node has no raw-key import for this curve. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function privateKeyFromRaw(raw: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function rawFromPublicKey(key: KeyObject): Buffer {
  return key.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
}

/** `age1...` -> 32 raw bytes. Throws `AgeError("bad-key")` on anything else. */
export function parseRecipient(s: string): Buffer {
  let hrp: string;
  let data: Uint8Array;
  try {
    ({ hrp, data } = bech32Decode(s.trim()));
  } catch (e) {
    throw new AgeError("bad-key", `not an age recipient: ${(e as Error).message}`);
  }
  if (hrp !== RECIPIENT_HRP) throw new AgeError("bad-key", `not an age recipient: hrp ${hrp}`);
  if (data.length !== X25519_KEY_SIZE) {
    throw new AgeError("bad-key", `recipient must be ${X25519_KEY_SIZE} bytes, got ${data.length}`);
  }
  return Buffer.from(data);
}

/** `AGE-SECRET-KEY-1...` -> 32 raw bytes. Throws `AgeError("bad-key")` otherwise. */
export function parseIdentity(s: string): Buffer {
  let hrp: string;
  let data: Uint8Array;
  try {
    ({ hrp, data } = bech32Decode(s.trim()));
  } catch (e) {
    throw new AgeError("bad-key", `not an age identity: ${(e as Error).message}`);
  }
  // `bech32Decode` lowercases the HRP; the literal is uppercase by convention.
  if (hrp !== IDENTITY_HRP.toLowerCase()) {
    throw new AgeError("bad-key", `not an age identity: hrp ${hrp}`);
  }
  if (data.length !== X25519_KEY_SIZE) {
    throw new AgeError("bad-key", `identity must be ${X25519_KEY_SIZE} bytes, got ${data.length}`);
  }
  return Buffer.from(data);
}

export function encodeRecipient(raw: Uint8Array): string {
  assertKeySize(raw, "recipient");
  return bech32Encode(RECIPIENT_HRP, raw);
}

export function encodeIdentity(raw: Uint8Array): string {
  assertKeySize(raw, "identity");
  return bech32Encode(IDENTITY_HRP, raw);
}

function assertKeySize(raw: Uint8Array, what: string): void {
  if (raw.length !== X25519_KEY_SIZE) {
    throw new AgeError("bad-key", `${what} must be ${X25519_KEY_SIZE} bytes, got ${raw.length}`);
  }
}

/** recipient = X25519(identity, basepoint) — §The X25519 recipient type. */
export function recipientFromIdentity(identityRaw: Uint8Array): Buffer {
  assertKeySize(identityRaw, "identity");
  return rawFromPublicKey(createPublicKey(privateKeyFromRaw(identityRaw)));
}

/**
 * Mint a fresh X25519 identity, in the two encodings the rest of the system
 * needs: the secret to store (mode 0600, never transported) and the public half
 * to publish.
 *
 * This lives here rather than at the eventual call site on purpose. Key
 * generation belongs next to key encoding, so that no other module ever has a
 * reason to call `randomBytes` and hand-roll the format — the only correct
 * source of an identity is one function.
 */
export function generateIdentity(): { identity: string; recipient: string } {
  const raw = randomBytes(X25519_KEY_SIZE);
  return { identity: encodeIdentity(raw), recipient: encodeRecipient(recipientFromIdentity(raw)) };
}

// ---------------------------------------------------------------------------
// Base64 and HKDF helpers.
// ---------------------------------------------------------------------------

/** §Conventions: standard base64, NO "=" padding. */
function b64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/=+$/, "");
}

/**
 * Padding is rejected rather than stripped. Node's decoder is lenient about
 * both padding and trailing garbage, so accepting a padded body would make two
 * distinct encodings of one key both valid — the canonicity requirement the
 * spec states and the same rule `bech32.ts` enforces on its own padding.
 */
function unb64(s: string): Buffer {
  if (s.includes("=")) throw new AgeError("malformed-header", "base64: padding is not allowed");
  return Buffer.from(s, "base64");
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf-8"), 32));
}

// ===========================================================================
// SECURITY-CRITICAL #1 — X25519 recipient stanza (wrap/unwrap the file key).
// ===========================================================================

/**
 * §The X25519 recipient type:
 *
 *   shared secret = X25519(ephemeral secret, recipient)
 *   salt          = ephemeral share || recipient
 *   info          = "age-encryption.org/v1/X25519"
 *   wrap key      = HKDF-SHA-256(ikm = shared secret, salt, info)
 *   body          = ChaCha20-Poly1305(key = wrap key, plaintext = file key)
 *
 * with an all-zero 12-byte nonce, which is safe here and ONLY here: the wrap key
 * is derived from a freshly generated ephemeral secret, so it is used for
 * exactly one encryption. That reasoning does not transfer to the payload — see
 * block #3.
 *
 * The all-zero shared-secret check is spec-mandated ("MUST check ... not all
 * zeroes") and rejects low-order points, which would otherwise make the wrap key
 * a constant that anyone can derive.
 */
function wrapFileKey(fileKey: Buffer, recipientRaw: Buffer): { share: Buffer; body: Buffer } {
  const ephemeralSecret = randomBytes(X25519_KEY_SIZE);
  const ephPriv = privateKeyFromRaw(ephemeralSecret);
  const share = rawFromPublicKey(createPublicKey(ephPriv));
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: publicKeyFromRaw(recipientRaw) });
  if (shared.every((b) => b === 0)) throw new AgeError("bad-key", "all-zero X25519 shared secret");
  const wrapKey = hkdf(shared, Buffer.concat([share, recipientRaw]), X25519_INFO);
  const c = createCipheriv("chacha20-poly1305", wrapKey, Buffer.alloc(12), {
    authTagLength: TAG_SIZE,
  });
  const body = Buffer.concat([c.update(fileKey), c.final(), c.getAuthTag()]);
  return { share, body };
}

/**
 * Returns null when this identity is simply not the stanza's recipient — the
 * ordinary case when a file is addressed to several machines and we are trying
 * each stanza in turn. Only a malformed key throws.
 *
 * The length check is spec-mandated and is a real mitigation, not tidiness:
 * "MUST check that the body length is exactly 32 bytes before attempting to
 * decrypt it, to mitigate partitioning oracle attacks."
 */
function unwrapFileKey(share: Buffer, body: Buffer, identityRaw: Buffer): Buffer | null {
  if (share.length !== X25519_KEY_SIZE || body.length !== FILE_KEY_SIZE + TAG_SIZE) return null;
  const idPriv = privateKeyFromRaw(identityRaw);
  const recipientRaw = rawFromPublicKey(createPublicKey(idPriv));
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: idPriv, publicKey: publicKeyFromRaw(share) });
  } catch {
    // A share that is not a well-formed point is a stanza we are not the
    // recipient of, as far as this loop is concerned.
    return null;
  }
  if (shared.every((b) => b === 0)) throw new AgeError("bad-key", "all-zero X25519 shared secret");
  const wrapKey = hkdf(shared, Buffer.concat([share, recipientRaw]), X25519_INFO);
  const d = createDecipheriv("chacha20-poly1305", wrapKey, Buffer.alloc(12), {
    authTagLength: TAG_SIZE,
  });
  d.setAuthTag(body.subarray(FILE_KEY_SIZE));
  try {
    return Buffer.concat([d.update(body.subarray(0, FILE_KEY_SIZE)), d.final()]);
  } catch {
    return null;
  }
}

// ===========================================================================
// SECURITY-CRITICAL #2 — header assembly and the header MAC.
// ===========================================================================

/**
 * MAC = HMAC-SHA-256 over the whole header up to and INCLUDING the `---` mark,
 * EXCLUDING the space that follows it.
 *
 *   HMAC key = HKDF-SHA-256(ikm = file key, salt = empty, info = "header")
 *
 * The mark-but-not-the-space boundary is the detail most likely to be "tidied"
 * by someone who assumes the MAC covers whole lines. It does not, and getting
 * it wrong makes every file we write unreadable by every other implementation —
 * loudly, which is the one mercy here.
 */
function headerMac(fileKey: Buffer, headerUpToMark: string): Buffer {
  const macKey = hkdf(fileKey, Buffer.alloc(0), HEADER_INFO);
  return createHmac("sha256", macKey).update(headerUpToMark, "utf-8").digest();
}

function buildHeader(fileKey: Buffer, recipients: readonly Buffer[]): Buffer {
  let stanzas = "";
  for (const r of recipients) {
    const { share, body } = wrapFileKey(fileKey, r);
    // §Recipient stanza: the body is base64 wrapped at 64 columns and MUST end
    // with a line SHORTER than 64 characters — so a body whose length is an
    // exact multiple of 64 needs a trailing EMPTY line.
    //
    // An X25519 body is the 16-byte file key plus a 16-byte tag = 32 bytes = 43
    // base64 characters, so it is always one short line and the wrap loop below
    // always takes the trivial path. It is written in the general form anyway,
    // because the READ side must handle the general case (see the GREASE note
    // in the file header) and a writer that hardcodes "one 43-character line"
    // is a writer nobody can add a stanza type to.
    const encoded = b64(body);
    const lines: string[] = [];
    for (let i = 0; i < encoded.length; i += STANZA_WRAP_COLUMNS) {
      lines.push(encoded.slice(i, i + STANZA_WRAP_COLUMNS));
    }
    if (lines.length === 0 || lines[lines.length - 1]!.length === STANZA_WRAP_COLUMNS) {
      lines.push("");
    }
    stanzas += `-> X25519 ${b64(share)}\n${lines.join("\n")}\n`;
  }
  const upToMark = `${VERSION_LINE}\n${stanzas}---`;
  return Buffer.from(`${upToMark} ${b64(headerMac(fileKey, upToMark))}\n`, "utf-8");
}

interface ParsedHeader {
  stanzas: { args: string[]; body: Buffer }[];
  upToMark: string;
  mac: Buffer;
  /** Offset of the payload nonce, relative to the start of the buffer parsed. */
  payloadOffset: number;
}

/**
 * Parses a buffer that is known to contain the complete header (the caller
 * locates the mark first, so this never sees payload bytes — which is what
 * keeps the `toString` below bounded by `MAX_HEADER_BYTES` rather than by the
 * size of the file).
 *
 * `\n--- ` is unambiguous as a terminator despite being searched for as raw
 * bytes: a stanza's first line always starts with `-> `, and a stanza body is
 * canonical base64, whose alphabet contains no `-`.
 */
function parseHeader(header: Buffer): ParsedHeader {
  const text = header.toString("binary");
  const markIdx = text.indexOf("\n--- ");
  if (markIdx === -1) throw new AgeError("malformed-header", "no header MAC line");
  const macLineEnd = text.indexOf("\n", markIdx + 1);
  if (macLineEnd === -1) throw new AgeError("malformed-header", "truncated header MAC line");
  const upToMark = text.slice(0, markIdx + 1) + "---";
  const mac = unb64(text.slice(markIdx + HEADER_MARK.length, macLineEnd));
  const lines = text.slice(0, markIdx).split("\n");
  if (lines[0] !== VERSION_LINE) {
    throw new AgeError("unsupported-version", `unsupported version: ${lines[0]}`);
  }
  const stanzas: { args: string[]; body: Buffer }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("-> ")) throw new AgeError("malformed-header", `expected a stanza at line ${i}`);
    const args = line.slice(3).split(" ");
    const bodyLines: string[] = [];
    // §: a stanza body ends at the first line SHORTER than 64 columns. This is
    // how an unknown stanza of arbitrary length is skipped without
    // understanding it — see the GREASE note in the file header.
    while (i + 1 < lines.length) {
      const b = lines[++i]!;
      bodyLines.push(b);
      if (b.length < STANZA_WRAP_COLUMNS) break;
    }
    stanzas.push({ args, body: unb64(bodyLines.join("")) });
  }
  return { stanzas, upToMark, mac, payloadOffset: macLineEnd + 1 };
}

// ===========================================================================
// SECURITY-CRITICAL #3 — STREAM payload chunking. THE SILENT ONE.
//
// A defect in this block can produce a file that round-trips through this
// module byte for byte and is catastrophically insecure. See the file header:
// the differential test against the real `age` binary is what covers it, and
// only payloads spanning >= 2 chunks can observe nonce reuse at all.
// ===========================================================================

/**
 * §Payload: a 12-byte nonce whose "first 11 bytes are a big endian chunk
 * counter starting at zero and incrementing by one for each subsequent chunk;
 * the last byte is 0x01 for the final chunk and 0x00 for all preceding ones."
 *
 * Every byte of this function is load-bearing. Big endian, 11 bytes, counter
 * strictly increasing, flag in byte 11. A frozen counter reuses one nonce
 * across the whole file; a little-endian counter is merely incompatible; a
 * missing or always-set final flag defeats the truncation guarantee that is the
 * entire point of STREAM. None of those four is visible to a self-test.
 */
function streamNonce(counter: bigint, final: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  if (counter >= 1n << 88n) throw new AgeError("truncated", "STREAM counter overflow");
  let v = counter;
  for (let i = 10; i >= 0; i--) {
    nonce[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  nonce[11] = final ? 0x01 : 0x00;
  return nonce;
}

function sealChunk(payloadKey: Buffer, counter: bigint, final: boolean, plain: Buffer): Buffer {
  const c = createCipheriv("chacha20-poly1305", payloadKey, streamNonce(counter, final), {
    authTagLength: TAG_SIZE,
  });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

/** Returns null on authentication failure; the caller decides how loud that is. */
function openChunk(payloadKey: Buffer, counter: bigint, final: boolean, enc: Buffer): Buffer | null {
  if (enc.length < TAG_SIZE) return null;
  const d = createDecipheriv("chacha20-poly1305", payloadKey, streamNonce(counter, final), {
    authTagLength: TAG_SIZE,
  });
  d.setAuthTag(enc.subarray(enc.length - TAG_SIZE));
  try {
    return Buffer.concat([d.update(enc.subarray(0, enc.length - TAG_SIZE)), d.final()]);
  } catch {
    return null;
  }
}

/**
 * Streaming encryptor. Pipe into it; it emits a complete age v1 file.
 *
 *   const enc = new AgeEncryptStream(recipients);
 *   await pipeline(source, enc, destination);
 *
 * THE LOAD-BEARING SUBTLETY: a chunk may only be emitted once we KNOW it is not
 * the last one, because the final-chunk flag is part of its nonce and cannot be
 * revised after the bytes have left. Hence the hold-back is `> CHUNK_SIZE`, not
 * `>=`. With `>=`, a payload that is an exact multiple of 64 KiB emits its last
 * full chunk as non-final and then an EMPTY final chunk, which the spec forbids
 * ("MUST NOT be empty unless the whole payload is empty") and which the real
 * binary rejects. That difference is invisible at every other size.
 *
 * Note on key material: the file key is not zeroed after derivation. In a
 * garbage-collected runtime that would be theatre — V8 may already have copied
 * the buffer — and pretending otherwise is worse than saying so here.
 */
export class AgeEncryptStream extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private counter = 0n;
  private headerWritten = false;
  private readonly payloadKey: Buffer;
  private readonly header: Buffer;
  private readonly payloadNonce: Buffer;

  /**
   * @param recipients raw 32-byte X25519 public keys (see `parseRecipient`).
   *   An empty list is refused: an age file with no recipient stanzas is
   *   readable by nobody, and the failure rule this module serves is worth
   *   nothing if "encrypted to no one" is a silent success.
   */
  constructor(recipients: readonly Uint8Array[]) {
    super();
    if (recipients.length === 0) {
      throw new AgeError("no-recipients", "refusing to encrypt to an empty recipient list");
    }
    const raw = recipients.map((r) => {
      assertKeySize(r, "recipient");
      return Buffer.from(r);
    });
    const fileKey = randomBytes(FILE_KEY_SIZE);
    this.header = buildHeader(fileKey, raw);
    this.payloadNonce = randomBytes(PAYLOAD_NONCE_SIZE);
    this.payloadKey = hkdf(fileKey, this.payloadNonce, PAYLOAD_INFO);
  }

  private emitHeaderOnce(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;
    this.push(this.header);
    this.push(this.payloadNonce);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.emitHeaderOnce();
      this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
      while (this.pending.length > CHUNK_SIZE) {
        const plain = this.pending.subarray(0, CHUNK_SIZE);
        this.pending = this.pending.subarray(CHUNK_SIZE);
        this.push(sealChunk(this.payloadKey, this.counter, false, plain));
        this.counter++;
      }
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      // An empty source still produces one final chunk (a bare 16-byte tag),
      // which is the single case where an empty chunk is legal.
      this.emitHeaderOnce();
      this.push(sealChunk(this.payloadKey, this.counter, true, this.pending));
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }
}

/**
 * Streaming decryptor. Mirrors the encryptor's hazard: an encrypted chunk may
 * only be opened as non-final once we know more ciphertext follows, so the
 * hold-back is `> ENC_CHUNK_SIZE`.
 *
 * Reaching end of file without authenticating a FINAL chunk is an error, not a
 * clean end — that is the STREAM truncation guarantee, and it is the reason a
 * hub bundle cut short in transit cannot be mistaken for a shorter bundle.
 */
export class AgeDecryptStream extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private counter = 0n;
  private payloadKey: Buffer | null = null;
  private headerDone = false;
  /** How far the mark search has already looked; keeps the scan linear. */
  private scannedTo = 0;
  private readonly identityRaw: Buffer;

  /** @param identity a raw 32-byte X25519 secret key (see `parseIdentity`). */
  constructor(identity: Uint8Array) {
    super();
    assertKeySize(identity, "identity");
    this.identityRaw = Buffer.from(identity);
  }

  /** Returns false while the header is still incomplete. Throws if it is wrong. */
  private tryHeader(): boolean {
    if (this.headerDone) return true;
    // Search raw bytes rather than converting to a string: until the mark is
    // found we do not know where the header ends, and stringifying the whole
    // buffer on every write is quadratic in the size of the file.
    const markIdx = this.pending.indexOf(HEADER_MARK, this.scannedTo);
    if (markIdx === -1) {
      this.scannedTo = Math.max(0, this.pending.length - (HEADER_MARK.length - 1));
      if (this.pending.length > MAX_HEADER_BYTES) {
        throw new AgeError("malformed-header", "no age header found within the header size limit");
      }
      return false;
    }
    const macLineEnd = this.pending.indexOf(LF, markIdx + 1);
    if (macLineEnd === -1) {
      if (this.pending.length > MAX_HEADER_BYTES) {
        throw new AgeError("malformed-header", "header MAC line exceeds the header size limit");
      }
      return false;
    }
    // The payload nonce follows the header immediately and is needed to derive
    // the payload key, so the header is not "done" until it has arrived too.
    if (this.pending.length < macLineEnd + 1 + PAYLOAD_NONCE_SIZE) return false;

    const parsed = parseHeader(this.pending.subarray(0, macLineEnd + 1));
    let fileKey: Buffer | null = null;
    for (const s of parsed.stanzas) {
      // §: "MUST ignore any stanza that does not have X25519 as the first
      // argument". Enforcement, not politeness — rage emits a GREASE stanza on
      // every file. See the file header.
      if (s.args[0] !== "X25519" || s.args.length !== 2) continue;
      let share: Buffer;
      try {
        share = unb64(s.args[1]!);
      } catch {
        continue;
      }
      const k = unwrapFileKey(share, s.body, this.identityRaw);
      if (k) {
        fileKey = k;
        break;
      }
    }
    if (!fileKey) {
      throw new AgeError("no-matching-identity", "no identity matched any recipient stanza");
    }
    const expected = headerMac(fileKey, parsed.upToMark);
    if (parsed.mac.length !== expected.length || !timingSafeEqual(parsed.mac, expected)) {
      throw new AgeError("header-mac-mismatch", "header MAC mismatch");
    }
    const nonce = this.pending.subarray(parsed.payloadOffset, parsed.payloadOffset + PAYLOAD_NONCE_SIZE);
    this.payloadKey = hkdf(fileKey, nonce, PAYLOAD_INFO);
    this.pending = this.pending.subarray(parsed.payloadOffset + PAYLOAD_NONCE_SIZE);
    this.headerDone = true;
    return true;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
      if (!this.tryHeader()) return cb();
      while (this.pending.length > ENC_CHUNK_SIZE) {
        const enc = this.pending.subarray(0, ENC_CHUNK_SIZE);
        this.pending = this.pending.subarray(ENC_CHUNK_SIZE);
        const plain = openChunk(this.payloadKey!, this.counter, false, enc);
        if (!plain) {
          return cb(
            new AgeError("payload-authentication-failed", `chunk ${this.counter} failed authentication`),
          );
        }
        if (plain.length > 0) this.push(plain);
        this.counter++;
      }
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      if (!this.headerDone) return cb(new AgeError("truncated", "truncated header"));
      // §: "Streaming decryption MUST signal an error if the end of file is
      // reached without successfully decrypting a final chunk."
      const plain = openChunk(this.payloadKey!, this.counter, true, this.pending);
      if (!plain) {
        return cb(
          new AgeError(
            "payload-authentication-failed",
            `final chunk ${this.counter} failed authentication`,
          ),
        );
      }
      if (plain.length > 0) this.push(plain);
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }
}

/**
 * Test-only. `parseHeader` is a pure function over bytes and is the only place
 * the stanza grammar is implemented, so exposing it is what lets the
 * "MUST ignore unrecognized stanzas" rule be tested WITHOUT a `rage` binary
 * present — a hand-written header with a GREASE stanza cannot otherwise be fed
 * to the decryptor, because the header MAC covers the stanzas and the test does
 * not hold the file key.
 *
 * Exposed rather than widening the real surface: nothing in production calls
 * this name, and it parses only — it verifies nothing and decrypts nothing.
 */
export { parseHeader as __parseHeaderForTests };
