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

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

// ---------------------------------------------------------------------------
// The PASSPHRASE oracle (crypto/age.ts block #4). Needs a pty; see below.
// ---------------------------------------------------------------------------

/**
 * `age` reads a passphrase from `/dev/tty` and from nowhere else — no
 * `AGE_PASSPHRASE`, and a piped stdin gets "standard input is not a terminal"
 * (measured, age 1.2.1). So the two `oracle*` functions above cannot drive it,
 * and the passphrase differential needs a real pty. `script(1)` is unavailable
 * in some sandboxes; Python's `pty` module is the portable POSIX answer, and
 * `tests/helpers/pty-run.py` is the whole of it.
 *
 * WINDOWS HAS NO PTY OF THIS KIND, so this half is POSIX-only by construction.
 * That is a real gap and is stated rather than hidden: on Windows the scrypt
 * shape is covered only by this repo's own round-trip, which is exactly the
 * test a symmetric parameter defect survives.
 */
const PYTHON = process.platform === "win32" ? null : which("python3");

const PTY_RUNNER = join(import.meta.dirname, "pty-run.py");

/**
 * A pty is available. Exported on its own because one caller needs a pty and
 * no oracle: `hub escrow` must REFUSE when stdin is a terminal rather than
 * echoing the passphrase, and the only way to hand a child a terminal is this.
 */
export const HAVE_PTY = PYTHON !== null;

/** Both halves present: an age implementation AND a way to answer its prompt. */
export const HAVE_PASSPHRASE_ORACLE = HAVE_ORACLE && PYTHON !== null;

/**
 * The same contract as `announceOracleAvailability`, for the same measured
 * reason (vitest swallows `console.error` even from module scope), and with one
 * extra case: the oracle binary is there and `python3` is not. That is the
 * silent-skip this repo has already been bitten by, so under
 * `SESH_MOVER_REQUIRE_AGE=1` it is a hard failure rather than a banner.
 */
export function announcePassphraseOracleAvailability(): void {
  if (HAVE_PASSPHRASE_ORACLE) return;
  const why =
    !HAVE_ORACLE
      ? "no age/rage binary"
      : process.platform === "win32"
        ? "Windows has no pty for this"
        : "python3 is missing";
  const message =
    "\n*** THE PASSPHRASE DIFFERENTIAL IS SKIPPED (" +
    why.padEnd(31) +
    ") ***\n" +
    "*** age reads passphrases from /dev/tty only, so this half needs a pty ***\n" +
    "*** driven by python3. Without it, SIX parameter defects in age.ts     ***\n" +
    "*** block #4 round-trip through our own code perfectly and nothing     ***\n" +
    "*** here would notice — they reach a user as 'my escrow passphrase     ***\n" +
    "*** doesn't work', during the recovery it exists for.                  ***\n" +
    "*** Set SESH_MOVER_REQUIRE_AGE=1 to make this a failure instead.       ***\n";
  if (process.env.SESH_MOVER_REQUIRE_AGE === "1" && process.platform !== "win32") {
    throw new Error(message);
  }
  process.stderr.write(message);
}

export interface PtyOracleRun {
  /** The CHILD's exit code — from `waitpid`, never a pipeline's. */
  status: number;
  /** The child's terminal output, prompts included. */
  transcript: string;
}

/**
 * Run `argv` with a controlling terminal, answering `prompts` prompts with
 * `input`. `prompts: 0` means "give it a tty and answer nothing", which is the
 * shape a refusal test wants.
 */
export function runUnderPty(prompts: number, argv: string[], passphrase: string): PtyOracleRun {
  const r = spawnSync(PYTHON!, [PTY_RUNNER, String(prompts), ...argv], {
    input: passphrase,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? -1, transcript: r.stderr ?? "" };
}

/**
 * `age -d -o outFile encFile`, answering one passphrase prompt.
 *
 * Returns the status rather than throwing, because every caller here is asking
 * "did the oracle accept this?" and a thrown exception makes "rejected" and
 * "the harness broke" the same observation — which is precisely how the
 * investigation's first harness reported ACCEPTED for impossible cases.
 */
export function oracleDecryptPassphrase(
  bin: string,
  passphrase: string,
  encFile: string,
  outFile: string
): PtyOracleRun {
  return runUnderPty(1, [bin, "-d", "-o", outFile, encFile], passphrase);
}

/** `age -e -p -o outFile inFile` — two prompts: the passphrase and its confirmation. */
export function oracleEncryptPassphrase(
  bin: string,
  passphrase: string,
  inFile: string,
  outFile: string
): PtyOracleRun {
  return runUnderPty(2, [bin, "-e", "-p", "-o", outFile, inFile], passphrase);
}

/**
 * `age -d -i identityFile encFile`, where `identityFile` is itself
 * passphrase-encrypted. This is THE escrow claim: age documents a
 * passphrase-encrypted age file as usable as an identity file, and this is the
 * call that proves our escrow is one.
 */
export function oracleDecryptWithEncryptedIdentity(
  bin: string,
  passphrase: string,
  identityFile: string,
  encFile: string,
  outFile: string
): PtyOracleRun {
  return runUnderPty(1, [bin, "-d", "-i", identityFile, "-o", outFile, encFile], passphrase);
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
