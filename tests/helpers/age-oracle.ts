/**
 * Shared plumbing for the age differential tests.
 *
 * The differential test — encrypt with our code, decrypt with the REAL `age`
 * binary — is the load-bearing test for `src/crypto/age.ts`, because a defect
 * in a helper shared by both directions round-trips against itself perfectly
 * (measured: a frozen chunk counter reproduces the plaintext byte for byte
 * while reusing one nonce across the whole file). A self-round-trip test proves
 * nothing about that. So the oracle's ABSENCE has to be loud: a silent skip
 * would let the suite look like it covered the most dangerous code in the
 * repository when it covered none of it.
 *
 * Two oracles are used when both are installed. `age` (Go) is the reference
 * implementation; `rage` (Rust) is independent, and agreement between the two
 * means we match the SPEC rather than one codebase's quirks. `rage` also emits
 * a `Gh-grease` stanza on every file it writes, which is the only readily
 * available exercise of the "ignore unrecognized stanzas" rule end to end.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Locate a binary, honouring an explicit override first: `AGE_BIN`,
 * `AGE_KEYGEN_BIN`, `RAGE_BIN`. The override exists because these are not
 * ordinary build tools — a developer may well have age unpacked somewhere that
 * is deliberately not on PATH.
 */
function which(bin: string): string | null {
  const fromEnv = process.env[`${bin.toUpperCase().replace(/-/g, "_")}_BIN`];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    if (process.platform === "win32") {
      return execFileSync("where", [bin], { encoding: "utf-8" }).split(/\r?\n/)[0]?.trim() || null;
    }
    return execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

export const AGE = which("age");
export const AGE_KEYGEN = which("age-keygen");
export const RAGE = which("rage");

/** Every age implementation available to act as an oracle on this machine. */
export const ORACLES: { name: string; bin: string }[] = [
  ...(AGE ? [{ name: "age", bin: AGE }] : []),
  ...(RAGE ? [{ name: "rage", bin: RAGE }] : []),
];

export const HAVE_ORACLE = ORACLES.length > 0;

/**
 * Announce the absence, and turn it into a hard failure when the environment
 * says the oracle must be there. `SESH_MOVER_REQUIRE_AGE=1` is for CI, where
 * "skipped" and "passed" print the same colour to a human skimming a log.
 *
 * MEASURED, and the reason this writes to the file descriptor rather than
 * calling `console.error`: vitest 4 intercepts `console` and, under the default
 * reporter, prints nothing for a passing or skipped file — from module scope
 * AND from inside a test body. A `console.error` banner here is swallowed
 * entirely, which is exactly the silent skip it exists to prevent.
 * `process.stderr.write` goes to the runner's own stderr and shows up.
 */
export function announceOracleAvailability(): void {
  if (HAVE_ORACLE) return;
  const message =
    "\n*** NO age/rage BINARY FOUND — the age differential tests AND the      ***\n" +
    "*** mutation matrix are SKIPPED, so nothing here has checked the ONE    ***\n" +
    "*** module a self-round-trip test cannot vouch for: nonce reuse in      ***\n" +
    "*** src/crypto/age.ts round-trips against itself perfectly.             ***\n" +
    "*** Install `age` (or `rage`), or set AGE_BIN=/path/to/age.             ***\n" +
    "*** Set SESH_MOVER_REQUIRE_AGE=1 to make this a failure instead.        ***\n";
  if (process.env.SESH_MOVER_REQUIRE_AGE === "1") throw new Error(message);
  process.stderr.write(message);
}

/** Decrypt with an external implementation, reading STDOUT rather than `-o`. */
export function oracleDecrypt(bin: string, keyFile: string, encFile: string): Buffer {
  // `rage -d -o FILE` does not create FILE when the plaintext is empty —
  // checked against rage's OWN empty-payload output, so it is a CLI behaviour
  // and not a disagreement about the format. Reading stdout makes the harness
  // answer the question it is actually asking.
  return execFileSync(bin, ["-d", "-i", keyFile, encFile], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function oracleEncrypt(bin: string, recipient: string, inFile: string, outFile: string): void {
  execFileSync(bin, ["-e", "-r", recipient, "-o", outFile, inFile], { stdio: ["ignore", "pipe", "pipe"] });
}

/** Deterministic filler, so a failure is reproducible rather than a one-off. */
export function payload(n: number): Buffer {
  const b = Buffer.alloc(n);
  let x = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    b[i] = x & 0xff;
  }
  return b;
}

/**
 * Feed data through a Transform in AWKWARD write sizes.
 *
 * A real pipeline never hands a Transform a tidy 64 KiB, and the chunking bugs
 * live in the buffering seam, not in the AEAD call — a test that writes one big
 * buffer exercises the arithmetic but not the state machine. The sizes below
 * deliberately straddle the chunk boundary from both sides.
 */
export function awkwardWrites(data: Buffer): Readable {
  const sizes = [1, 7, 65535, 3, 65536, 100000, 2, 65537];
  let off = 0;
  let i = 0;
  return new Readable({
    read() {
      if (off >= data.length) return this.push(null);
      const n = Math.min(sizes[i++ % sizes.length]!, data.length - off);
      this.push(data.subarray(off, off + n));
      off += n;
    },
  });
}

/** Run `data` through `t` in awkward writes and collect everything it emits. */
export async function through(data: Buffer, t: Transform): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(awkwardWrites(data), t, async function (src) {
    for await (const c of src) out.push(c as Buffer);
  });
  return Buffer.concat(out);
}
