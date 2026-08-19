/**
 * Bech32 — age's key encoding.
 *
 * These are deliberately separate from the age tests, because the module is
 * deliberately separate: nothing in `bech32.ts` can be wrong in a way that
 * produces a working-but-insecure file. Every defect reachable from here ends
 * in a throw, a wrong-length key, or a shared secret that disagrees so the file
 * key cannot be unwrapped. That is why this file needs no external oracle and
 * `crypto-age.test.ts` does.
 *
 * What IS worth pinning here is the pair of assumptions the age HRPs break:
 * the separator is the LAST "1" (the identity HRP contains "-" and ends with
 * one), and the case of the data part follows the case of the HRP.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { bech32Decode, bech32Encode } from "../src/crypto/bech32.js";

const RECIPIENT_HRP = "age";
const IDENTITY_HRP = "AGE-SECRET-KEY-";

describe("bech32", () => {
  it("round-trips 32-byte keys under both age HRPs", () => {
    for (let i = 0; i < 50; i++) {
      const raw = randomBytes(32);
      for (const hrp of [RECIPIENT_HRP, IDENTITY_HRP]) {
        const s = bech32Encode(hrp, raw);
        const { hrp: back, data } = bech32Decode(s);
        expect(back).toBe(hrp.toLowerCase());
        expect(Buffer.from(data).equals(raw)).toBe(true);
      }
    }
  });

  it("renders an uppercase HRP with an uppercase data part, and vice versa", () => {
    const raw = randomBytes(32);
    const recipient = bech32Encode(RECIPIENT_HRP, raw);
    const identity = bech32Encode(IDENTITY_HRP, raw);
    expect(recipient).toBe(recipient.toLowerCase());
    expect(recipient.startsWith("age1")).toBe(true);
    expect(identity).toBe(identity.toUpperCase());
    expect(identity.startsWith("AGE-SECRET-KEY-1")).toBe(true);
    // A bech32 string is all-lower or all-upper, never mixed.
    expect(() => bech32Decode(`AGE-SECRET-KEY-1${identity.slice(16).toLowerCase()}`)).toThrow(
      /mixed case/,
    );
  });

  it("splits on the LAST 1, which is the only rule that works for the identity HRP", () => {
    // "AGE-SECRET-KEY-" ends in a separator-looking character AND the whole HRP
    // is 15 characters before the "1" the encoder appends. A first-"1" split
    // would work here by accident (there is no "1" earlier), so the real check
    // is that the decoder reports the FULL hrp back, not a truncated one.
    const raw = randomBytes(32);
    const { hrp } = bech32Decode(bech32Encode(IDENTITY_HRP, raw));
    expect(hrp).toBe("age-secret-key-");
    // And an HRP that genuinely contains a "1" still round-trips.
    const odd = bech32Decode(bech32Encode("x1y", raw));
    expect(odd.hrp).toBe("x1y");
    expect(Buffer.from(odd.data).equals(raw)).toBe(true);
  });

  it("rejects a bad checksum, an invalid character, and a bad separator position", () => {
    const s = bech32Encode(RECIPIENT_HRP, randomBytes(32));
    // Flip one data character to another valid charset character.
    const idx = 10;
    const swapped = s[idx] === "q" ? "p" : "q";
    expect(() => bech32Decode(s.slice(0, idx) + swapped + s.slice(idx + 1))).toThrow(/bad checksum/);
    expect(() => bech32Decode(s.slice(0, idx) + "b" + s.slice(idx + 1))).toThrow(/invalid character/);
    expect(() => bech32Decode("1qqqqqq")).toThrow(/bad separator position/);
    expect(() => bech32Decode("age1qq")).toThrow(/bad separator position/);
  });

  /**
   * Canonicity: one key must have exactly ONE encoding. The check that
   * enforces it lives in the 5->8 direction, and it is unreachable by
   * tampering with a real string, because the checksum fails first. So the
   * test forges a valid checksum over word lists that no byte string could
   * have produced. `polymod` below is a checksum FORGER, not a second
   * implementation of anything the module relies on — if it were wrong, the
   * decoder would report a bad checksum and these tests would fail loudly.
   */
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

  function forge(hrp: string, words: number[]): string {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    const expand: number[] = [];
    for (const c of hrp) expand.push(c.charCodeAt(0) >> 5);
    expand.push(0);
    for (const c of hrp) expand.push(c.charCodeAt(0) & 31);
    let chk = 1;
    for (const v of [...expand, ...words, 0, 0, 0, 0, 0, 0]) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]!;
    }
    chk ^= 1;
    const cs: number[] = [];
    for (let i = 0; i < 6; i++) cs.push((chk >> (5 * (5 - i))) & 31);
    return `${hrp}1${[...words, ...cs].map((w) => CHARSET[w]!).join("")}`;
  }

  it("accepts a forged-but-canonical string, so the forger itself is sound", () => {
    // 40 words = 200 bits = exactly 25 bytes, no padding at all.
    const words = Array.from({ length: 40 }, (_, i) => i % 32);
    const { hrp, data } = bech32Decode(forge("age", words));
    expect(hrp).toBe("age");
    expect(data.length).toBe(25);
  });

  it("rejects non-zero padding bits, so one key has exactly one encoding", () => {
    // 52 words = 260 bits = 32 bytes + 4 leftover bits, which MUST be zero.
    // Word 51 (the last) carries them in its low 4 positions.
    const base = Array.from({ length: 52 }, (_, i) => (i * 7) % 32);
    base[51] = 0; // canonical: leftover bits clear
    expect(() => bech32Decode(forge("age", base))).not.toThrow();
    base[51] = 1; // one padding bit set
    expect(() => bech32Decode(forge("age", base))).toThrow(/non-canonical padding/);
  });

  it("rejects a data part carrying a whole extra byte's worth of leftover bits", () => {
    // 41 words = 205 bits = 25 bytes + 5 leftover, i.e. `bits >= from`. That is
    // a truncated encoding, not a shorter key, and must not decode.
    const words = Array.from({ length: 41 }, (_, i) => i % 32);
    expect(() => bech32Decode(forge("age", words))).toThrow(/non-canonical padding/);
  });

  it("encodes an empty data part without crashing (the degenerate HRP-only form)", () => {
    const s = bech32Encode("age", new Uint8Array(0));
    expect(bech32Decode(s).data.length).toBe(0);
  });
});
