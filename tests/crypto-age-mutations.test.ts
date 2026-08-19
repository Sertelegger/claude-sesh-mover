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
  ORACLES,
  announceOracleAvailability,
  oracleDecrypt,
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

const [mode, modPath, key, inFile, outFile] = process.argv.slice(2);
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

function runMutant(mode: "encrypt" | "selftest", mod: string, key: string, plain: Buffer, tag: string): Buffer {
  const inFile = join(dir, `${tag}.in`);
  const outFile = join(dir, `${tag}.out`);
  writeFileSync(inFile, plain);
  execFileSync(process.execPath, [runner, mode, mod, key, inFile, outFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
