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
import { Transform, type TransformCallback } from "node:stream";
/**
 * Distinguishable failure reasons. Callers get to tell "you are not a recipient
 * of this bundle" (a key-management problem, actionable: rekey, re-push) from
 * "chunk 3 failed authentication" (corruption or tampering, not actionable) —
 * without string-matching a message. The abort behaviour is the same for all of
 * them; only the diagnosis differs.
 */
export type AgeErrorCode = "no-recipients" | "bad-key" | "malformed-header" | "unsupported-version" | "no-matching-identity" | "header-mac-mismatch" | "payload-authentication-failed" | "truncated";
export declare class AgeError extends Error {
    readonly code: AgeErrorCode;
    constructor(code: AgeErrorCode, message: string);
}
/** `age1...` -> 32 raw bytes. Throws `AgeError("bad-key")` on anything else. */
export declare function parseRecipient(s: string): Buffer;
/** `AGE-SECRET-KEY-1...` -> 32 raw bytes. Throws `AgeError("bad-key")` otherwise. */
export declare function parseIdentity(s: string): Buffer;
export declare function encodeRecipient(raw: Uint8Array): string;
export declare function encodeIdentity(raw: Uint8Array): string;
/** recipient = X25519(identity, basepoint) — §The X25519 recipient type. */
export declare function recipientFromIdentity(identityRaw: Uint8Array): Buffer;
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
export declare function generateIdentity(): {
    identity: string;
    recipient: string;
};
interface ParsedHeader {
    stanzas: {
        args: string[];
        body: Buffer;
    }[];
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
declare function parseHeader(header: Buffer): ParsedHeader;
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
export declare class AgeEncryptStream extends Transform {
    private pending;
    private counter;
    private headerWritten;
    private readonly payloadKey;
    private readonly header;
    private readonly payloadNonce;
    /**
     * @param recipients raw 32-byte X25519 public keys (see `parseRecipient`).
     *   An empty list is refused: an age file with no recipient stanzas is
     *   readable by nobody, and the failure rule this module serves is worth
     *   nothing if "encrypted to no one" is a silent success.
     */
    constructor(recipients: readonly Uint8Array[]);
    private emitHeaderOnce;
    _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void;
    _flush(cb: TransformCallback): void;
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
export declare class AgeDecryptStream extends Transform {
    private pending;
    private counter;
    private payloadKey;
    private headerDone;
    /** How far the mark search has already looked; keeps the scan linear. */
    private scannedTo;
    private readonly identityRaw;
    /** @param identity a raw 32-byte X25519 secret key (see `parseIdentity`). */
    constructor(identity: Uint8Array);
    /** Returns false while the header is still incomplete. Throws if it is wrong. */
    private tryHeader;
    _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void;
    _flush(cb: TransformCallback): void;
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
//# sourceMappingURL=age.d.ts.map