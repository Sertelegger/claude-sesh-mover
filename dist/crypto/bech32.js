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
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
        const b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++)
            if ((b >> i) & 1)
                chk ^= GEN[i];
    }
    return chk;
}
function hrpExpand(hrp) {
    const out = [];
    for (let i = 0; i < hrp.length; i++)
        out.push(hrp.charCodeAt(i) >> 5);
    out.push(0);
    for (let i = 0; i < hrp.length; i++)
        out.push(hrp.charCodeAt(i) & 31);
    return out;
}
/**
 * Regroup bits: 8->5 to encode, 5->8 to decode.
 *
 * `pad` is the direction switch and it is not symmetric. Encoding pads the
 * final group with zero bits; decoding must REJECT a final group that carries
 * leftover bits or non-zero padding, because accepting it would make two
 * distinct strings decode to the same key — the canonicity rule age's
 * "canonical base64" requirement has in common with this.
 */
function convertBits(data, from, to, pad) {
    let acc = 0;
    let bits = 0;
    const out = [];
    const maxv = (1 << to) - 1;
    for (const value of data) {
        if (value < 0 || value >> from !== 0)
            throw new Error("bech32: value out of range");
        acc = (acc << from) | value;
        bits += from;
        while (bits >= to) {
            bits -= to;
            out.push((acc >> bits) & maxv);
        }
    }
    if (pad) {
        if (bits > 0)
            out.push((acc << (to - bits)) & maxv);
    }
    else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
        throw new Error("bech32: non-canonical padding");
    }
    return out;
}
export function bech32Encode(hrp, data) {
    const lower = hrp.toLowerCase();
    const words = convertBits([...data], 8, 5, true);
    const chk = polymod([...hrpExpand(lower), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
    const checksum = [];
    for (let i = 0; i < 6; i++)
        checksum.push((chk >> (5 * (5 - i))) & 31);
    const body = [...words, ...checksum].map((w) => CHARSET[w]).join("");
    // The checksum is computed over the lowercased HRP either way; only the
    // rendering follows the caller's case. Getting this backwards produces a
    // string the reference implementation rejects, which is the loud failure the
    // header promises.
    return hrp === lower ? `${hrp}1${body}` : `${hrp}1${body.toUpperCase()}`;
}
export function bech32Decode(s) {
    const hasUpper = /[A-Z]/.test(s);
    const hasLower = /[a-z]/.test(s);
    if (hasUpper && hasLower)
        throw new Error("bech32: mixed case");
    const norm = s.toLowerCase();
    // BIP173: the separator is the LAST "1". See the header — the identity HRP
    // makes this load-bearing rather than pedantic.
    const sep = norm.lastIndexOf("1");
    if (sep < 1 || sep + 7 > norm.length)
        throw new Error("bech32: bad separator position");
    const hrp = norm.slice(0, sep);
    const words = [];
    for (const ch of norm.slice(sep + 1)) {
        const idx = CHARSET.indexOf(ch);
        if (idx === -1)
            throw new Error(`bech32: invalid character ${ch}`);
        words.push(idx);
    }
    if (polymod([...hrpExpand(hrp), ...words]) !== 1)
        throw new Error("bech32: bad checksum");
    // The HRP comes back LOWERCASED, always. Callers compare against a
    // lowercased literal for that reason; comparing against "AGE-SECRET-KEY-"
    // here would never match.
    return { hrp, data: Uint8Array.from(convertBits(words.slice(0, -6), 5, 8, false)) };
}
//# sourceMappingURL=bech32.js.map