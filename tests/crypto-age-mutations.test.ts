/**
 * # Mutation matrix for the STREAM chunking — does the oracle actually bite?
 *
 * The spike that decided this format injected seven plausible defects into the
 * age implementation and confirmed the real binary rejected every one. That
 * matrix is the reason anyone should believe the differential test is worth its
 * runtime, so it is promoted rather than left on a branch. A promotion that
 * kept the code and dropped the matrix would be a downgrade wearing a tidy
 * diff.
 *
 * **How the defects are injected, and why not the obvious way.** The spike
 * threaded a `Bug` enum through the production functions. That cannot ship: a
 * live `if (bug === "counter-frozen")` is a nonce-reuse switch sitting in
 * `dist/`, in the most security-critical file in the repository, reachable by
 * anyone who passes the argument. So the switches do not exist in `src/`. This
 * file mutates the BUILT module textually instead — real mutation testing —
 * and runs each mutant in a child `node` process against the real binary.
 *
 * Three properties fall out of doing it that way:
 *
 * - The thing mutated is the code that ships, not a copy of it that can drift.
 * - Each replacement asserts it matched EXACTLY ONCE. If `age.ts` is refactored
 *   so an anchor no longer appears, this file fails loudly saying the matrix no
 *   longer describes the code — which is the correct signal, not a false green.
 * - A pristine-copy control runs first. Without it, a harness that silently
 *   failed to load any mutant would report full coverage: every "the oracle
 *   rejects this" assertion would pass for entirely the wrong reason.
 *
 * The `silent to a self-test` block at the bottom needs no binary and must
 * never be deleted: it is the demonstration that two of these defects round-
 * trip through this module perfectly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateIdentity } from "../src/crypto/age.js";
import {
  HAVE_ORACLE,
  HAVE_PASSPHRASE_ORACLE,
  ORACLES,
  announceOracleAvailability,
  announcePassphraseOracleAvailability,
  oracleDecrypt,
  oracleDecryptPassphrase,
  payload,
} from "./helpers/age-oracle.js";

const CHUNK = 65536;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILT = join(repoRoot, "dist", "crypto", "age.js");
const BUILT_BECH32 = join(repoRoot, "dist", "crypto", "bech32.js");
const SOURCE = join(repoRoot, "src", "crypto", "age.ts");

// Announced here as well as in crypto-age.test.ts: this file is meaningful on
// its own, and a run of it alone must not look like it covered the matrix.
announceOracleAvailability();
announcePassphraseOracleAvailability();

/**
 * The passphrase for the scrypt matrix. Fixed and in the clear on purpose: it
 * guards nothing, and a random one would make a failure unreproducible.
 */
const MUT_PASS = "matrix passphrase";
/**
 * Work factor for every scrypt mutant. Low deliberately — the matrix is about
 * PARAMETERS, and paying 256 MiB and half a second per case to learn the same
 * thing would make the honest-to-run cost of this file a reason to skip it.
 * The production constant is pinned end to end in `crypto-age-scrypt.test.ts`.
 */
const MUT_LOG_N = 10;

interface Mutation {
  /** Stable id, also the temp module name. */
  id: string;
  /** What a reviewer should picture going wrong. */
  label: string;
  find: string;
  replace: string;
  /**
   * The SMALLEST payload that makes the defect observable. These are not
   * arbitrary: nonce reuse needs >= 2 chunks, and the hold-back comparison is
   * invisible at every size except an exact multiple of 64 KiB.
   */
  size: number;
  /** True when the defect is present in a helper BOTH directions share. */
  silentToSelfTest: boolean;
}

const MUTATIONS: Mutation[] = [
  {
    id: "no-final-flag",
    label: "final-chunk flag never set",
    find: "nonce[11] = final ? 0x01 : 0x00;",
    replace: "nonce[11] = 0x00;",
    size: CHUNK + 1,
    silentToSelfTest: false,
  },
  {
    id: "final-flag-always",
    label: "final-chunk flag set on every chunk",
    find: "nonce[11] = final ? 0x01 : 0x00;",
    replace: "nonce[11] = 0x01;",
    size: CHUNK * 3,
    silentToSelfTest: false,
  },
  {
    id: "counter-frozen",
    label: "chunk counter never increments (NONCE REUSE)",
    find: "let v = counter;",
    replace: "let v = 0n;",
    size: CHUNK * 3,
    silentToSelfTest: true,
  },
  {
    id: "counter-le",
    label: "chunk counter written little-endian",
    find: "for (let i = 10; i >= 0; i--)",
    replace: "for (let i = 0; i <= 10; i++)",
    size: CHUNK * 3,
    silentToSelfTest: true,
  },
  {
    id: "trailing-empty-chunk",
    label: "hold-back uses >= so an exact multiple emits an empty final chunk",
    find: "while (this.pending.length > CHUNK_SIZE)",
    replace: "while (this.pending.length >= CHUNK_SIZE)",
    size: CHUNK * 2,
    silentToSelfTest: true,
  },
  {
    id: "hkdf-info-typo",
    label: 'payload HKDF info "payload " instead of "payload"',
    find: 'const PAYLOAD_INFO = "payload";',
    replace: 'const PAYLOAD_INFO = "payload ";',
    size: 100,
    silentToSelfTest: true,
  },
  {
    id: "mac-excludes-stanza",
    label: "header MAC computed over the version line only",
    find: "headerMac(fileKey, upToMark)",
    replace: 'headerMac(fileKey, VERSION_LINE + "\\n---")',
    size: 100,
    silentToSelfTest: false,
  },
];

/**
 * The child runner. Kept out of the vitest module graph on purpose: importing a
 * mutated module inside the test process means asking Vite to resolve a file
 * outside its root, and a plain `node` child is both simpler and a more honest
 * reproduction of how `dist/` is actually loaded.
 */
const RUNNER = `
import { readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const [mode, modPath, key, inFile, outFile, logN] = process.argv.slice(2);
// pathToFileURL, NOT the bare path. A dynamic ESM import of an absolute
// Windows path fails with ERR_UNSUPPORTED_ESM_URL_SCHEME because \`C:\` reads
// as a protocol; a POSIX \`/path\` happens to work, so the bug is invisible on
// Linux and macOS and fails every Windows run.
const m = await import(pathToFileURL(modPath).href);

async function through(data, t) {
  const out = [];
  // Awkward write sizes: the chunking hazard lives in the buffering seam.
  const src = new Readable({
    read() {
      const sizes = [1, 7, 65535, 3, 65536, 100000, 2, 65537];
      this._o ??= 0; this._i ??= 0;
      if (this._o >= data.length) return this.push(null);
      const n = Math.min(sizes[this._i++ % sizes.length], data.length - this._o);
      this.push(data.subarray(this._o, this._o + n));
      this._o += n;
    },
  });
  await pipeline(src, t, async function (s) { for await (const c of s) out.push(c); });
  return Buffer.concat(out);
}

const plain = readFileSync(inFile);
if (mode === "encrypt") {
  writeFileSync(outFile, await through(plain, new m.AgeEncryptStream([m.parseRecipient(key)])));
} else if (mode === "selftest") {
  const file = await through(plain, new m.AgeEncryptStream([m.parseRecipient(m.encodeRecipient(m.recipientFromIdentity(m.parseIdentity(key))))]));
  writeFileSync(outFile, await through(file, new m.AgeDecryptStream(m.parseIdentity(key))));
} else if (mode === "encrypt-scrypt") {
  // In the scrypt modes \`key\` is the PASSPHRASE and the work factor arrives in
  // a sixth argv slot. Not packed into one slot with a separator: a passphrase
  // is arbitrary bytes, and a separator a passphrase can contain is a harness
  // that mis-parses exactly the input it is meant to be careless about.
  writeFileSync(outFile, await through(plain, new m.AgeEncryptStream({ passphrase: Buffer.from(key), logN: Number(logN) })));
} else if (mode === "selftest-scrypt") {
  const file = await through(plain, new m.AgeEncryptStream({ passphrase: Buffer.from(key), logN: Number(logN) }));
  writeFileSync(outFile, await through(file, new m.AgeDecryptStream({ passphrase: Buffer.from(key) })));
} else {
  throw new Error("unknown mode " + mode);
}
`;

let dir: string;
let identity: string;
let recipient: string;
let keyFile: string;
let runner: string;
let built: string;

beforeAll(() => {
  if (!existsSync(BUILT)) {
    throw new Error(
      `${BUILT} is missing. The mutation matrix mutates the BUILT module; run \`npm run build\` ` +
        "(`npm test` does it via `pretest`).",
    );
  }
  if (statSync(SOURCE).mtimeMs > statSync(BUILT).mtimeMs) {
    throw new Error(
      "dist/crypto/age.js is older than src/crypto/age.ts — the mutation matrix would be " +
        "testing stale code and reporting it as current. Run `npm run build`.",
    );
  }
  built = readFileSync(BUILT, "utf-8");
  dir = mkdtempSync(join(tmpdir(), "sesh-age-mut-"));
  // Outside the repo there is no package.json, so Node would read `.js` as
  // CommonJS and the ESM copy would fail to load.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "bech32.js"), readFileSync(BUILT_BECH32));
  runner = join(dir, "runner.mjs");
  writeFileSync(runner, RUNNER);
  ({ identity, recipient } = generateIdentity());
  keyFile = join(dir, "key.txt");
  writeFileSync(keyFile, `${identity}\n`, { mode: 0o600 });
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Write a copy of the built module with `m` applied (or verbatim for null). */
function materialize(m: Mutation | null): string {
  const name = m ? `age-${m.id}.js` : "age-pristine.js";
  let text = built;
  if (m) {
    const hits = text.split(m.find).length - 1;
    expect(
      hits,
      `mutation "${m.id}" no longer matches dist/crypto/age.js — the matrix has gone stale ` +
        `against the code it claims to describe. Anchor: ${m.find}`,
    ).toBe(1);
    text = text.replace(m.find, m.replace);
    expect(text).not.toBe(built);
  }
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

function runMutant(
  mode: "encrypt" | "selftest" | "encrypt-scrypt" | "selftest-scrypt",
  mod: string,
  key: string,
  plain: Buffer,
  tag: string,
  logN?: number
): Buffer {
  const inFile = join(dir, `${tag}.in`);
  const outFile = join(dir, `${tag}.out`);
  writeFileSync(inFile, plain);
  execFileSync(
    process.execPath,
    [runner, mode, mod, key, inFile, outFile, ...(logN === undefined ? [] : [String(logN)])],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  return readFileSync(outFile);
}

describe.skipIf(!HAVE_ORACLE)("mutation matrix against a real age implementation", () => {
  it("control: an unmutated copy, loaded the same way, IS accepted", () => {
    // The vacuity check. If the harness were broken, every rejection assertion
    // below would pass for the wrong reason and the matrix would be worthless.
    const mod = materialize(null);
    const plain = payload(CHUNK * 2 + 7);
    const out = join(dir, "control.age");
    writeFileSync(out, runMutant("encrypt", mod, recipient, plain, "control"));
    for (const { bin } of ORACLES) {
      expect(oracleDecrypt(bin, keyFile, out).equals(plain)).toBe(true);
    }
  });

  for (const m of MUTATIONS) {
    it(`rejected by every oracle: ${m.label}`, () => {
      const mod = materialize(m);
      const plain = payload(m.size);
      const out = join(dir, `${m.id}.age`);
      writeFileSync(out, runMutant("encrypt", mod, recipient, plain, m.id));
      for (const { name, bin } of ORACLES) {
        let rejected = false;
        try {
          oracleDecrypt(bin, keyFile, out);
        } catch {
          rejected = true;
        }
        expect(rejected, `${name} ACCEPTED a file built with the "${m.id}" defect`).toBe(true);
      }
    });
  }
});

/**
 * No binary required, and this is the part that must never be deleted.
 *
 * A defect in a helper that BOTH directions use round-trips against itself
 * perfectly. `counter-frozen` is the one that matters: the plaintext comes back
 * byte for byte while every chunk in the file reuses one ChaCha20-Poly1305
 * nonce — which leaks the XOR of the plaintexts and burns the Poly1305 key.
 * This is a characterisation test. If it ever starts failing, someone has
 * changed the shape of the module; it is NOT a bug to "fix" by making the
 * self-test notice, because a self-test structurally cannot.
 */
describe("defects that are silent to a self-test", () => {
  for (const m of MUTATIONS.filter((x) => x.silentToSelfTest)) {
    it(`round-trips through itself despite: ${m.label}`, () => {
      const mod = materialize(m);
      const plain = payload(m.size);
      const back = runMutant("selftest", mod, identity, plain, `self-${m.id}`);
      expect(
        back.equals(plain),
        `"${m.id}" was expected to be invisible to a self-round-trip; if this now fails, the ` +
          "module changed shape, not that the defect became detectable without an oracle.",
      ).toBe(true);
    });
  }
});

/**
 * The scrypt PARAMETER matrix (block #4).
 *
 * A different kind of danger from the STREAM matrix above, and the difference
 * decides how loud a failure is. A STREAM defect produces a file that decrypts
 * and is insecure. A PARAMETER defect produces a file that does not decrypt —
 * and **six of the nine below are indistinguishable from a wrong passphrase**,
 * so the bug reaches a user as "my escrow passphrase doesn't work", at the one
 * moment there is no other copy of the key. Nothing in this repository can tell
 * those two apart. The real binary can, and that is the whole argument for
 * paying a pty to drive it.
 *
 * Every entry is a wrong ANSWER to a question the file itself does not record:
 * the label, the salt prefixing, r, p, and the N actually used are all implicit
 * agreements between writer and reader, so getting one wrong breaks both
 * directions identically and leaves a self-round-trip green.
 */
const SCRYPT_MUTATIONS: Mutation[] = [
  {
    id: "scrypt-label-typo",
    label: 'scrypt salt label "…/scrypT" instead of "…/scrypt" (one character)',
    find: 'const SCRYPT_LABEL = Buffer.from("age-encryption.org/v1/scrypt", "utf-8");',
    replace: 'const SCRYPT_LABEL = Buffer.from("age-encryption.org/v1/scrypT", "utf-8");',
    size: 100,
    silentToSelfTest: true,
  },
  {
    id: "scrypt-salt-unprefixed",
    label: "scrypt salt used raw, without the spec's label prefix",
    find: "Buffer.concat([SCRYPT_LABEL, salt])",
    replace: "salt",
    size: 100,
    silentToSelfTest: true,
  },
  {
    id: "scrypt-r-4",
    label: "scrypt block size r = 4 instead of 8",
    find: "const SCRYPT_R = 8;",
    replace: "const SCRYPT_R = 4;",
    size: 100,
    silentToSelfTest: true,
  },
  {
    id: "scrypt-p-2",
    label: "scrypt parallelisation p = 2 instead of 1",
    find: "const SCRYPT_P = 1;",
    replace: "const SCRYPT_P = 2;",
    size: 100,
    silentToSelfTest: true,
  },
  {
    id: "scrypt-n-off-by-one",
    label: "N derived as 2^(logN-1) while the stanza still claims logN",
    find: "const n = 2 ** logN;",
    replace: "const n = 2 ** (logN - 1);",
    size: 100,
    silentToSelfTest: true,
  },
  {
    id: "scrypt-salt-8-bytes",
    label: "8-byte scrypt salt instead of the spec's 16",
    find: "const SCRYPT_SALT_SIZE = 16;",
    replace: "const SCRYPT_SALT_SIZE = 8;",
    size: 100,
    silentToSelfTest: true,
  },
  {
    id: "scrypt-nonzero-nonce",
    label: "non-zero nonce on the stanza body AEAD",
    find:
      'const wrapKey = scryptWrapKey(passphrase, salt, logN);\n' +
      '    const c = createCipheriv("chacha20-poly1305", wrapKey, Buffer.alloc(12), {',
    replace:
      'const wrapKey = scryptWrapKey(passphrase, salt, logN);\n' +
      '    const c = createCipheriv("chacha20-poly1305", wrapKey, Buffer.alloc(12, 1), {',
    size: 100,
    silentToSelfTest: false,
  },
  {
    id: "scrypt-logn-leading-zero",
    label: 'work factor written with a leading zero ("010")',
    find: "b64(salt), String(logN)], body)",
    replace: 'b64(salt), "0" + String(logN)], body)',
    size: 100,
    silentToSelfTest: false,
  },
  {
    id: "scrypt-stanza-label-case",
    label: 'stanza labelled "Scrypt" instead of "scrypt"',
    find: 'stanzaText(["scrypt", b64(salt)',
    replace: 'stanzaText(["Scrypt", b64(salt)',
    size: 100,
    silentToSelfTest: false,
  },
];

describe.skipIf(!HAVE_PASSPHRASE_ORACLE)("scrypt parameter matrix against a real age implementation", () => {
  it("control: an unmutated passphrase file IS accepted", () => {
    // The vacuity check for this half, and it is not a formality: the pty
    // harness this block depends on reported ACCEPTED for impossible cases on
    // its first run, because a shell captured a pipeline's exit status rather
    // than the child's. If that regressed, every rejection below would pass for
    // the wrong reason and this control is the only thing that would notice.
    const mod = materialize(null);
    const plain = payload(100);
    const out = join(dir, "scrypt-control.age");
    writeFileSync(out, runMutant("encrypt-scrypt", mod, MUT_PASS, plain, "scrypt-control", MUT_LOG_N));
    for (const { name, bin } of ORACLES) {
      const dst = join(dir, `scrypt-control.${name}.out`);
      const r = oracleDecryptPassphrase(bin, MUT_PASS, out, dst);
      expect(r.status, `${name} rejected a PRISTINE passphrase file: ${r.transcript}`).toBe(0);
      expect(readFileSync(dst).equals(plain)).toBe(true);
    }
  });

  for (const m of SCRYPT_MUTATIONS) {
    it(`rejected by every oracle: ${m.label}`, () => {
      const mod = materialize(m);
      const plain = payload(m.size);
      const out = join(dir, `${m.id}.age`);
      writeFileSync(out, runMutant("encrypt-scrypt", mod, MUT_PASS, plain, m.id, MUT_LOG_N));
      for (const { name, bin } of ORACLES) {
        const r = oracleDecryptPassphrase(bin, MUT_PASS, out, join(dir, `${m.id}.${name}.out`));
        expect(r.status, `${name} ACCEPTED a file built with the "${m.id}" defect`).not.toBe(0);
        // 99 is the pty runner's own timeout. A rejection that is really a hung
        // harness says nothing about age.
        expect(r.status, `the pty runner timed out on "${m.id}" rather than age refusing`).not.toBe(99);
      }
    });
  }
});

/**
 * The scrypt half of "silent to a self-test", and the number is the point:
 * SIX of these round-trip through this module perfectly. Each one is a wrong
 * answer that both directions give, so writer and reader agree and the file is
 * simply unreadable by everyone else — which arrives as a wrong passphrase.
 */
describe("scrypt defects that are silent to a self-test", () => {
  const silent = SCRYPT_MUTATIONS.filter((x) => x.silentToSelfTest);

  it("there are six of them, which is the claim the matrix rests on", () => {
    expect(silent.map((m) => m.id)).toEqual([
      "scrypt-label-typo",
      "scrypt-salt-unprefixed",
      "scrypt-r-4",
      "scrypt-p-2",
      "scrypt-n-off-by-one",
      "scrypt-salt-8-bytes",
    ]);
  });

  for (const m of silent) {
    it(`round-trips through itself despite: ${m.label}`, () => {
      const mod = materialize(m);
      const plain = payload(m.size);
      const back = runMutant("selftest-scrypt", mod, MUT_PASS, plain, `self-${m.id}`, MUT_LOG_N);
      expect(
        back.equals(plain),
        `"${m.id}" was expected to be invisible to a self-round-trip; if this now fails, the ` +
          "module changed shape, not that the defect became detectable without an oracle.",
      ).toBe(true);
    });
  }
});
