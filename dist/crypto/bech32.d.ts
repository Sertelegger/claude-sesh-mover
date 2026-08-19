/**
 * Bech32 (BIP173) — age's KEY ENCODING, and deliberately not part of the
 * security-critical surface.
 *
 * The distinction is worth stating because everything else in `src/crypto/` is
 * the opposite: a mistake HERE fails loudly and immediately. A wrong checksum
 * throws; a wrong bit regrouping produces a key of the wrong length, which
 * `parseRecipient`/`parseIdentity` reject; a subtly wrong key byte makes the
 * X25519 shared secret disagree, so the recipient simply cannot unwrap the file
 * key and decryption fails closed. There is no "works but is insecure" outcome
 * reachable from this file — which is exactly what is NOT true of `age.ts`'s
 * nonce construction, and why the two live in separate files.
 *
 * age's own deviation from BIP173: "Bech32 is as specified in BIP173, but
 * without length limits on the data part" — so the 90-character cap is not
 * implemented here, and must not be reintroduced. An age recipient is already
 * 62 characters and a hub with many machines concatenates none of them, but the
 * cap exists in BIP173 for QR codes and has nothing to do with this use.
 *
 * Only two HRPs are ever passed in (see `age.ts`):
 *   recipient: "age"             -> age1...
 *   identity:  "AGE-SECRET-KEY-" -> AGE-SECRET-KEY-1...
 *
 * The identity HRP is the awkward one: it contains "-" AND ends with one, and
 * it is UPPERCASE, so two ordinary-looking assumptions are both wrong. The
 * separator is the LAST "1" in the string, not the first (a leading-`1` scan
 * would split inside the HRP the moment the data part starts with `1`... which
 * it cannot, since `1` is not in the charset — but the rule is BIP173's and is
 * implemented as written rather than as currently-sufficient). And a bech32
 * string is all-lower or all-upper, never mixed, so the case of the data part
 * follows the case of the HRP it was asked to encode.
 */
export declare function bech32Encode(hrp: string, data: Uint8Array): string;
export declare function bech32Decode(s: string): {
    hrp: string;
    data: Uint8Array;
};
//# sourceMappingURL=bech32.d.ts.map