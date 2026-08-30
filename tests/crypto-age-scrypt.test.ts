/**
 * The passphrase (scrypt) half of `src/crypto/age.ts` — block #4.
 *
 * WHY THE DIFFERENTIAL HALF IS THE POINT, again and for a new reason. Block #3
 * is dangerous because a defect round-trips silently; block #4 is dangerous
 * because a defect is *indistinguishable from a wrong passphrase*. Six of them
 * are (see `crypto-age-mutations.test.ts`'s scrypt matrix), so the failure
 * reaches a user as "my escrow passphrase doesn't work" — the least debuggable
 * message there is — at the one moment there is no other copy of the key. Only
 * a second implementation can tell those apart from a typo, and driving it
 * needs a pty, because `age` reads passphrases from `/dev/tty` only.
 *
 * The tests below are therefore in two groups: the ones that need no oracle
 * (parse rules, refusals, our own round trip — a CHARACTERIZATION of shape, not
 * evidence of correctness), and the differential ones, which are the evidence.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGE_SCRYPT_LOG_N,
  AGE_SCRYPT_MAX_LOG_N,
  AgeDecryptStream,
  AgeEncryptStream,
  encodeRecipient,
  generateIdentity,
  parseIdentity,
  parseRecipient,
  recipientFromIdentity,
} from "../src/crypto/age.js";
import {
  HAVE_PASSPHRASE_ORACLE,
  ORACLES,
  announcePassphraseOracleAvailability,
  oracleDecryptPassphrase,
  oracleDecryptWithEncryptedIdentity,
  oracleEncrypt,
  oracleEncryptPassphrase,
  payload,
  through,
} from "./helpers/age-oracle.js";

announcePassphraseOracleAvailability();

const CHUNK = 65536;
/**
 * Cheap work factor for the cases that are about SHAPE. N = 1024 derives in
 * about a millisecond; the real constant is exercised deliberately and by name
 * in "writes at age's own work factor", which is the test that pins it.
 */
const CHEAP = 10;
const PASS = "correct horse battery staple";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sesh-age-scrypt-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seal(plain: Buffer, passphrase: string, logN = CHEAP): Promise<Buffer> {
  return through(plain, new AgeEncryptStream({ passphrase: Buffer.from(passphrase), logN }));
}
function open(file: Buffer, passphrase: string): Promise<Buffer> {
  return through(file, new AgeDecryptStream({ passphrase: Buffer.from(passphrase) }));
}

describe("scrypt stanza — shape and refusals (no oracle needed)", () => {
  it("writes exactly one scrypt stanza and no X25519 one", async () => {
    const file = await seal(Buffer.from("hello"), PASS);
    const head = file.subarray(0, 200).toString("utf-8").split("\n");
    expect(head[0]).toBe("age-encryption.org/v1");
    expect(head[1]).toMatch(/^-> scrypt [A-Za-z0-9+/]{22} 10$/);
    expect(head[2]).toMatch(/^[A-Za-z0-9+/]{43}$/);
    expect(head[3]).toMatch(/^--- /);
    // The single-stanza rule, from the writer's side. A second stanza here is
    // the design the age spec forbids with a MUST.
    expect(file.toString("binary")).not.toContain("X25519");
  });

  it("round-trips through itself — a CHARACTERIZATION, not evidence", async () => {
    // Stated as such deliberately: every one of the six symmetric parameter
    // defects in the mutation matrix passes this test.
    for (const n of [0, 1, 100, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 2, CHUNK * 2 + 7]) {
      const plain = payload(n);
      expect((await open(await seal(plain, PASS), PASS)).equals(plain)).toBe(true);
    }
  });

  it("refuses an empty passphrase on the write side", () => {
    expect(() => new AgeEncryptStream({ passphrase: Buffer.alloc(0) })).toThrow(
      /empty passphrase/
    );
  });

  it("reports a wrong passphrase as `bad-passphrase`, distinctly", async () => {
    const file = await seal(Buffer.from("hello"), PASS);
    await expect(open(file, "not the passphrase")).rejects.toMatchObject({
      code: "bad-passphrase",
    });
  });

  it("refuses a work factor above the cap BEFORE deriving anything", async () => {
    // The cap is what stops a file claiming logN 30 from being a 1 TiB
    // allocation request. Editing the digit also breaks the header MAC, so the
    // fact that the reported error is the cap and not `header-mac-mismatch` is
    // the assertion: the cheap check runs first.
    const file = await seal(Buffer.from("hello"), PASS);
    const tampered = Buffer.from(
      file.toString("binary").replace(/^(-> scrypt \S+) 10$/m, "$1 23"),
      "binary"
    );
    await expect(open(tampered, PASS)).rejects.toMatchObject({
      code: "malformed-header",
      message: expect.stringContaining("too large"),
    });
    expect(AGE_SCRYPT_MAX_LOG_N).toBe(22);
  });

  it("refuses a non-canonical work factor encoding", async () => {
    const file = await seal(Buffer.from("hello"), PASS);
    const tampered = Buffer.from(
      file.toString("binary").replace(/^(-> scrypt \S+) 10$/m, "$1 010"),
      "binary"
    );
    await expect(open(tampered, PASS)).rejects.toMatchObject({
      code: "malformed-header",
      message: expect.stringContaining("encoding invalid"),
    });
  });

  it("refuses a header that mixes an scrypt stanza with any other", async () => {
    // THE rule this whole design turns on. A mixed file reads fine with `-i`
    // and is rejected with a passphrase, so it fails only during recovery —
    // measured against age 1.2.1 with a hand-built header. The check must fire
    // before the MAC, which is why a hand-spliced (and therefore MAC-invalid)
    // file is the right fixture.
    const file = await seal(Buffer.from("hello"), PASS);
    const { recipient } = generateIdentity();
    const fake = `-> X25519 ${encodeRecipient(parseRecipient(recipient)).slice(4, 47)}\n${"A".repeat(43)}\n`;
    const text = file.toString("binary");
    const at = text.indexOf("\n--- ");
    const mixed = Buffer.from(text.slice(0, at + 1) + fake + text.slice(at + 1), "binary");
    await expect(open(mixed, PASS)).rejects.toMatchObject({
      code: "malformed-header",
      message: expect.stringContaining("must be the only one"),
    });
  });

  it("an identity cannot open a passphrase file, and vice versa", async () => {
    const { identity, recipient } = generateIdentity();
    const scryptFile = await seal(Buffer.from("hello"), PASS);
    await expect(
      through(scryptFile, new AgeDecryptStream(parseIdentity(identity)))
    ).rejects.toMatchObject({ code: "no-matching-identity" });

    const keyFile = await through(
      Buffer.from("hello"),
      new AgeEncryptStream([parseRecipient(recipient)])
    );
    await expect(open(keyFile, PASS)).rejects.toMatchObject({
      code: "no-matching-identity",
      message: expect.stringContaining("not addressed to a passphrase"),
    });
  });
});

describe.skipIf(!HAVE_PASSPHRASE_ORACLE)("scrypt — differential against the real binary", () => {
  it("uses at least one external implementation and a pty to drive it", () => {
    // The vacuity check for the whole block: `it.each([])` registers zero tests,
    // so an empty oracle list would make this describe LOOK green.
    expect(ORACLES.length).toBeGreaterThan(0);
  });

  it("the harness is not vacuous: a wrong passphrase is REJECTED", () => {
    // The investigation's own first harness reported ACCEPTED for impossible
    // cases, because a shell captured a pipeline's status rather than the
    // child's. Every "rejected" assertion below is worthless without this.
    const plain = Buffer.from("vacuity");
    const inFile = join(dir, "vac.txt");
    const encFile = join(dir, "vac.age");
    writeFileSync(inFile, plain);
    for (const { name, bin } of ORACLES) {
      const enc = oracleEncryptPassphrase(bin, PASS, inFile, encFile);
      expect(enc.status, `${name} could not write a passphrase file`).toBe(0);
      const good = oracleDecryptPassphrase(bin, PASS, encFile, join(dir, "vac.good"));
      expect(good.status, `${name} rejected the CORRECT passphrase`).toBe(0);
      const bad = oracleDecryptPassphrase(bin, "wrong", encFile, join(dir, "vac.bad"));
      expect(bad.status, `${name} ACCEPTED a wrong passphrase`).not.toBe(0);
      // 99 is the runner's own timeout code; if that is what came back, the
      // "rejected" above says nothing about age.
      expect(bad.status, "the pty runner timed out rather than age refusing").not.toBe(99);
    }
  });

  it("age decrypts what we write, at every size that matters", async () => {
    // >= 2 chunks is load-bearing here for the SAME reason as block #3: nonce
    // reuse is unobservable in a single chunk, and the passphrase path shares
    // that block. An exact multiple of 64 KiB is the hold-back case.
    const sizes = [0, 1, 100, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 2, CHUNK * 2 + 7];
    for (const n of sizes) {
      const plain = payload(n);
      const encFile = join(dir, `ours-${n}.age`);
      writeFileSync(encFile, await seal(plain, PASS));
      for (const { name, bin } of ORACLES) {
        const outFile = join(dir, `ours-${n}.${name}.out`);
        const r = oracleDecryptPassphrase(bin, PASS, encFile, outFile);
        expect(r.status, `${name} rejected our ${n}-byte file: ${r.transcript}`).toBe(0);
        expect(readFileSync(outFile).equals(plain), `${name} produced different bytes`).toBe(true);
      }
    }
  });

  it("we decrypt what age writes", async () => {
    for (const { name, bin } of ORACLES) {
      for (const n of [0, 100, CHUNK * 2 + 7]) {
        const plain = payload(n);
        const inFile = join(dir, `theirs-${name}-${n}.txt`);
        const encFile = join(dir, `theirs-${name}-${n}.age`);
        writeFileSync(inFile, plain);
        const enc = oracleEncryptPassphrase(bin, PASS, inFile, encFile);
        expect(enc.status, `${name} could not encrypt: ${enc.transcript}`).toBe(0);
        expect((await open(readFileSync(encFile), PASS)).equals(plain)).toBe(true);
      }
    }
  });

  it("writes at age's own work factor, so our file is indistinguishable", async () => {
    // The one test that pays the real cost (~256 MiB, ~0.5 s per derivation),
    // and the only place the production constant is exercised end to end. It
    // pins two things at once: that we default to 18, and that 18 is what age
    // itself writes — so a future bump is a deliberate, visible change.
    expect(AGE_SCRYPT_LOG_N).toBe(18);
    const plain = Buffer.from("escrowed at the production work factor\n");
    const ours = join(dir, "prod.age");
    writeFileSync(
      ours,
      await through(plain, new AgeEncryptStream({ passphrase: Buffer.from(PASS) }))
    );
    expect(readFileSync(ours).subarray(0, 120).toString("utf-8")).toMatch(
      /^age-encryption\.org\/v1\n-> scrypt \S+ 18\n/
    );
    for (const { name, bin } of ORACLES) {
      const out = join(dir, `prod.${name}.out`);
      const r = oracleDecryptPassphrase(bin, PASS, ours, out);
      expect(r.status, `${name} rejected our logN-18 file: ${r.transcript}`).toBe(0);
      expect(readFileSync(out).equals(plain)).toBe(true);

      // And age itself writes 18 — measured rather than assumed, so "matching
      // age" stays a fact about age and not a comment about our own constant.
      const theirsIn = join(dir, `prod-in-${name}.txt`);
      const theirs = join(dir, `prod-${name}.age`);
      writeFileSync(theirsIn, plain);
      expect(oracleEncryptPassphrase(bin, PASS, theirsIn, theirs).status).toBe(0);
      expect(readFileSync(theirs).subarray(0, 120).toString("utf-8")).toMatch(
        /^age-encryption\.org\/v1\n-> scrypt \S+ 18\n/
      );
    }
  });

  it("THE ESCROW CLAIM: our passphrase file works as an age IDENTITY file", async () => {
    // This is the whole feature in one assertion. age documents a
    // passphrase-encrypted age file as usable via `-i`; if that stopped being
    // true, the escrow would still be written, still verify against itself, and
    // be useless at exactly the moment it is needed.
    const { identity, recipient } = generateIdentity();
    const identityFileContents =
      `# created: ${new Date().toISOString()}\n# public key: ${recipient}\n${identity}\n`;

    const escrow = join(dir, "identity-escrow.age");
    writeFileSync(
      escrow,
      await through(
        Buffer.from(identityFileContents, "utf-8"),
        new AgeEncryptStream({ passphrase: Buffer.from(PASS), logN: CHEAP })
      )
    );

    const secretIn = join(dir, "bundle.txt");
    const secretEnc = join(dir, "bundle.tar.gz.age");
    const bundle = payload(CHUNK + 11);
    writeFileSync(secretIn, bundle);
    for (const { name, bin } of ORACLES) {
      oracleEncrypt(bin, recipient, secretIn, secretEnc);
      const out = join(dir, `recovered-${name}.bin`);
      const r = oracleDecryptWithEncryptedIdentity(bin, PASS, escrow, secretEnc, out);
      expect(r.status, `${name} could not use our escrow as an identity: ${r.transcript}`).toBe(0);
      expect(readFileSync(out).equals(bundle)).toBe(true);
      rmSync(secretEnc, { force: true });
    }
  });

  it("age refuses a work factor above the cap too, with the same boundary", () => {
    // Our cap is only meaningful if it is age's. 22 accepted / 23 refused is
    // the boundary; only the refusal is exercised here, because logN 22 costs
    // 4 GiB and eight seconds and the acceptance adds nothing the smaller
    // factors have not already shown.
    const inFile = join(dir, "cap.txt");
    writeFileSync(inFile, "cap");
    for (const { name, bin } of ORACLES) {
      const encFile = join(dir, `cap-${name}.age`);
      expect(oracleEncryptPassphrase(bin, PASS, inFile, encFile).status).toBe(0);
      const text = readFileSync(encFile).toString("binary");
      writeFileSync(
        encFile,
        Buffer.from(text.replace(/^(-> scrypt \S+) 18$/m, "$1 23"), "binary")
      );
      const r = oracleDecryptPassphrase(bin, PASS, encFile, join(dir, `cap-${name}.out`));
      expect(r.status, `${name} accepted logN 23`).not.toBe(0);
      expect(r.transcript.toLowerCase()).toContain("work factor");
    }
  });
});

describe("the recipient derivation the escrow publishes", () => {
  it("is derived from the secret, never read from the comment", () => {
    // Guards the one thing the escrow's `recipient` field could get wrong: it
    // is what `status` compares against to say "this escrow is for a key this
    // machine no longer has".
    const { identity, recipient } = generateIdentity();
    expect(encodeRecipient(recipientFromIdentity(parseIdentity(identity)))).toBe(recipient);
  });
});
