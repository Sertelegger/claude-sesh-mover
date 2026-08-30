/**
 * `hub escrow` — the verb, its destination rules, and the two things it must
 * never do.
 *
 * The crypto is proved elsewhere (`crypto-age-scrypt.test.ts` against the real
 * binary). What is proved here is the part a differential test cannot reach:
 * that the escrow is off until asked for, that a destination which would copy
 * the key somewhere it must not go is REFUSED rather than warned about, and
 * that no serialized result ever carries the passphrase or the secret key.
 *
 * On the destination rules specifically — they are asserted through
 * `checkEscrowDestination`, not only through the verb, because each rule has to
 * be exercised on a real directory tree and paying a 256 MiB scrypt derivation
 * per rule to learn nothing about scrypt would be a reason to write fewer of
 * them.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeEnv, overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import { runCli } from "./helpers/run-cli.js";
import {
  checkEscrowDestination,
  escrowRecordPath,
  hubEscrow,
  type EscrowPassphraseInput,
} from "../src/hub/escrow.js";
import { AgeDecryptStream } from "../src/crypto/age.js";
import { identityFilePath, loadOrCreateIdentity } from "../src/crypto/identity-file.js";
import { HAVE_PTY, runUnderPty, through } from "./helpers/age-oracle.js";

const isPosix = process.platform !== "win32";

/** Cheap work factor: this file is about the verb, not about scrypt. */
const CHEAP = 10;
const PASS = "an escrow passphrase";
const given: EscrowPassphraseInput = { kind: "given", bytes: Buffer.from(PASS) };

describe("hub escrow", () => {
  let home: string;
  /** Where an escrow may legitimately go. */
  let outside: string;
  /**
   * The directory the command is "running for". A SIBLING of `outside`, never
   * its parent — `--out` inside the invoking project is one of the refusals, so
   * a fixture that shares the two directories tests the refusal by accident and
   * nothing else.
   */
  let project: string;
  let restore: HomeOverrideHandle;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sesh-escrow-home-"));
    outside = mkdtempSync(join(tmpdir(), "sesh-escrow-out-"));
    project = mkdtempSync(join(tmpdir(), "sesh-escrow-proj-"));
    restore = overrideHome(home);
  });

  afterEach(() => {
    restore.restore();
    // Never leave key material behind, even a throwaway one.
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  function enable(outPath: string, passphrase: EscrowPassphraseInput = given) {
    return hubEscrow({
      action: "enable",
      outPath,
      passphrase,
      cwd: project,
      hubPath: null,
      logN: CHEAP,
    });
  }

  describe("default off", () => {
    it("reports not enabled, and touches nothing, on a fresh machine", async () => {
      const r = await hubEscrow({
        action: "status",
        passphrase: { kind: "not-requested" },
        cwd: project,
        hubPath: null,
      });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.enabled).toBe(false);
      expect(r.escrowPath).toBeNull();
      expect(r.recipient).toBeNull();
      // A user who never asks must never meet this: reading status must not
      // mint an identity, create ~/.sesh-mover, or write a record.
      expect(existsSync(join(home, ".sesh-mover"))).toBe(false);
    });

    it("refuses --disable when nothing is recorded", async () => {
      const r = await hubEscrow({
        action: "disable",
        passphrase: { kind: "not-requested" },
        cwd: project,
        hubPath: null,
      });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.reason).toBe("escrow-refused");
      expect(r.refusal).toBe("not-enabled");
    });
  });

  describe("the passphrase", () => {
    beforeEach(() => {
      loadOrCreateIdentity();
    });

    it("refuses to enable without --passphrase-stdin, and prints the shell recipe", async () => {
      const out = join(outside, "e.age");
      // Written with two DIRECT calls rather than through the `enable` helper
      // because the retry is the proof: the refusal claims "add the flag and
      // run it again", and a claim about a re-run has to be a re-run.
      const r = await hubEscrow({
        action: "enable",
        outPath: out,
        passphrase: { kind: "not-requested" },
        cwd: project,
        hubPath: null,
        logN: CHEAP,
      });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.refusal).toBe("passphrase");
      // The recipe is load-bearing: it is what keeps collection out of the
      // chat transcript, which the SessionEnd auto-push would upload.
      expect(r.suggestion).toContain("read -rs SESH_ESCROW");
      expect(r.suggestion).toContain("--passphrase-stdin");
      expect(existsSync(out)).toBe(false);

      const retried = await hubEscrow({
        action: "enable",
        outPath: out,
        passphrase: given,
        cwd: project,
        hubPath: null,
        logN: CHEAP,
      });
      expect(retried.success, "the advised retry did not reach the work").toBe(true);
      expect(existsSync(out)).toBe(true);
    });

    it("refuses --enable with no --out, and the same command with one added writes it", async () => {
      const first = await hubEscrow({
        action: "enable",
        passphrase: given,
        cwd: project,
        hubPath: null,
        logN: CHEAP,
      });
      expect(first.success).toBe(false);
      if (first.success) return;
      expect(first.refusal).toBe("no-out");

      const out = join(outside, "with-out.age");
      const second = await hubEscrow({
        action: "enable",
        outPath: out,
        passphrase: given,
        cwd: project,
        hubPath: null,
        logN: CHEAP,
      });
      expect(second.success, "the advised retry did not reach the work").toBe(true);
      expect(existsSync(out)).toBe(true);
    });

    it("refuses when stdin is a terminal rather than echoing the passphrase", async () => {
      const r = await enable(join(outside, "e.age"), { kind: "terminal" });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.refusal).toBe("passphrase");
      expect(r.error).toContain("terminal");
    });

    it("refuses an empty passphrase", async () => {
      const r = await enable(join(outside, "e.age"), { kind: "given", bytes: Buffer.alloc(0) });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.refusal).toBe("passphrase");
      expect(existsSync(join(outside, "e.age"))).toBe(false);
    });

    it("refuses a passphrase with an embedded line break", async () => {
      // It could never be typed back at age's prompt, which reads one line —
      // so the escrow would be unrecoverable by the only tool recovery has.
      const r = await enable(join(outside, "e.age"), {
        kind: "given",
        bytes: Buffer.from("two\nlines"),
      });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.refusal).toBe("passphrase");
      expect(r.error).toContain("line break");
    });
  });

  describe("enabling", () => {
    it("refuses when this machine has no identity yet", async () => {
      const r = await enable(join(outside, "e.age"));
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.refusal).toBe("no-identity");
      // And it did NOT mint one as a side effect: escrowing a key that has
      // never encrypted anything is not what the user asked for.
      expect(existsSync(identityFilePath())).toBe(false);
    });

    it("refuses when the identity file is present but unreadable", async () => {
      mkdirSync(join(home, ".sesh-mover"), { recursive: true });
      writeFileSync(identityFilePath(), "not an age identity\n");
      const r = await enable(join(outside, "e.age"));
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.refusal).toBe("no-identity");
      // Never overwritten: the old key may still be recoverable by hand.
      expect(readFileSync(identityFilePath(), "utf-8")).toBe("not an age identity\n");
    });

    it("writes an escrow that decrypts back to the identity file byte for byte", async () => {
      const key = loadOrCreateIdentity();
      expect(key.ok).toBe(true);
      const before = readFileSync(identityFilePath(), "utf-8");

      const out = join(outside, "escrow.age");
      const r = await enable(out);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.action).toBe("enabled");
      expect(r.enabled).toBe(true);
      expect(r.escrowPath).toBe(out);
      expect(r.recipient).toBe(key.ok ? key.recipient : null);
      expect(r.workFactorLogN).toBe(CHEAP);
      // The recovery steps carry the REAL paths and are `age` commands, not
      // sesh-mover ones: a recovery step that needs this plugin installed is a
      // recovery step that fails on the machine an escrow exists for.
      expect(r.recovery.join("\n")).toContain(`age -d -i ${out}`);
      expect(r.recovery.join("\n")).toContain(identityFilePath());
      expect(r.recovery.every((c) => c.startsWith("age "))).toBe(true);

      const back = await through(readFileSync(out), new AgeDecryptStream({ passphrase: Buffer.from(PASS) }));
      expect(back.toString("utf-8")).toBe(before);
    });

    it.skipIf(!isPosix)("writes the escrow 0600, like the file it copies", async () => {
      loadOrCreateIdentity();
      const out = join(outside, "escrow.age");
      await enable(out);
      expect(statSync(out).mode & 0o777).toBe(0o600);
    });

    it("states the un-revocable leak, the recovery-only rule and where backfill lives", async () => {
      loadOrCreateIdentity();
      const r = await enable(join(outside, "escrow.age"));
      expect(r.success).toBe(true);
      if (!r.success) return;
      const all = r.warnings.join("\n");
      // Each of these is a thing the owner said must not be softened.
      expect(all).toMatch(/past and future/);
      expect(all).toMatch(/cannot be revoked/i);
      expect(all).toMatch(/hub rekey/);
      expect(all).toMatch(/RECOVERY ONLY/);
      expect(all).toMatch(/per-machine revocation/);
    });

    it("warns about a short passphrase without refusing it", async () => {
      loadOrCreateIdentity();
      const r = await enable(join(outside, "escrow.age"), {
        kind: "given",
        bytes: Buffer.from("short"),
      });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.warnings.join("\n")).toMatch(/short/i);
    });

    it("never overwrites an existing file at --out", async () => {
      loadOrCreateIdentity();
      const out = join(outside, "escrow.age");
      writeFileSync(out, "something the user put there");
      const r = await enable(out);
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.unsafeOut?.rule).toBe("exists");
      expect(readFileSync(out, "utf-8")).toBe("something the user put there");
    });
  });

  describe("no secret ever reaches a result", () => {
    it("the serialized body carries neither the passphrase nor the private key", async () => {
      const key = loadOrCreateIdentity();
      expect(key.ok).toBe(true);
      if (!key.ok) return;
      const r = await enable(join(outside, "escrow.age"));
      const body = JSON.stringify(r);
      expect(body).not.toContain(PASS);
      expect(body).not.toContain("AGE-SECRET-KEY");
      expect(body).not.toContain(key.identity);
      // The PUBLIC half is fine and is the point of the field: it is already
      // published in this machine's hub record.
      expect(body).toContain(key.recipient);
    });

    it("a refusal body carries neither either", async () => {
      loadOrCreateIdentity();
      mkdirSync(join(outside, "repo", ".git"), { recursive: true });
      const r = await enable(join(outside, "repo", "escrow.age"));
      const body = JSON.stringify(r);
      expect(body).not.toContain(PASS);
      expect(body).not.toContain("AGE-SECRET-KEY");
    });
  });

  describe("status and disable", () => {
    it("reports a recorded escrow, and notices when it is for an old key", async () => {
      loadOrCreateIdentity();
      const out = join(outside, "escrow.age");
      await enable(out);

      const ok = await hubEscrow({
        action: "status",
        passphrase: { kind: "not-requested" },
        cwd: project,
        hubPath: null,
      });
      expect(ok.success).toBe(true);
      if (!ok.success) return;
      expect(ok.enabled).toBe(true);
      expect(ok.filePresent).toBe(true);
      expect(ok.fileLooksLikeEscrow).toBe(true);
      expect(ok.current).toBe(true);
      expect(ok.workFactorLogN).toBe(CHEAP);

      // Replace the identity: the escrow is now for a key this machine no
      // longer has, which is the one thing a user cannot see by looking.
      rmSync(identityFilePath());
      loadOrCreateIdentity();
      const stale = await hubEscrow({
        action: "status",
        passphrase: { kind: "not-requested" },
        cwd: project,
        hubPath: null,
      });
      expect(stale.success).toBe(true);
      if (!stale.success) return;
      expect(stale.current).toBe(false);
      expect(stale.warnings.join("\n")).toMatch(/no longer has/);
    });

    it("notices a missing escrow file and a file that is not one", async () => {
      loadOrCreateIdentity();
      const out = join(outside, "escrow.age");
      await enable(out);

      rmSync(out);
      const gone = await hubEscrow({
        action: "status",
        passphrase: { kind: "not-requested" },
        cwd: project,
        hubPath: null,
      });
      expect(gone.success && gone.filePresent).toBe(false);
      expect(gone.success && gone.warnings.join("\n")).toMatch(/not at that path/);

      writeFileSync(out, "definitely not an age file");
      const wrong = await hubEscrow({
        action: "status",
        passphrase: { kind: "not-requested" },
        cwd: project,
        hubPath: null,
      });
      expect(wrong.success).toBe(true);
      if (!wrong.success) return;
      expect(wrong.filePresent).toBe(true);
      expect(wrong.fileLooksLikeEscrow).toBe(false);
    });

    it("--disable forgets the record and deliberately leaves the file alone", async () => {
      loadOrCreateIdentity();
      const out = join(outside, "escrow.age");
      await enable(out);

      const r = await hubEscrow({
        action: "disable",
        passphrase: { kind: "not-requested" },
        cwd: project,
        hubPath: null,
      });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.enabled).toBe(false);
      expect(r.escrowPath).toBe(out);
      expect(existsSync(escrowRecordPath())).toBe(false);
      // The file is still there AND the result says so — deleting a file at a
      // path recorded once, which may not be the file we wrote, is not ours.
      expect(existsSync(out)).toBe(true);
      expect(r.filePresent).toBe(true);
      expect(r.warnings.join("\n")).toMatch(/did NOT delete/);
    });
  });

  describe("the --out safety rule", () => {
    it("accepts an ordinary directory, and always states what it cannot see", () => {
      const v = checkEscrowDestination(join(outside, "escrow.age"), {
        cwd: project,
        hubPath: null,
      });
      expect(v.ok).toBe(true);
    });

    it("every result discloses the limit, refusals included", async () => {
      loadOrCreateIdentity();
      const good = await enable(join(outside, "escrow.age"));
      const bad = await enable(join(outside, "nope", "escrow.age"));
      for (const r of [good, bad]) {
        // Stated on SUCCESSES too: a refusal that fires makes the check look
        // more capable than it is, which is when a user decides the next
        // destination must therefore be safe.
        expect(r.limits.join(" ")).toMatch(/CANNOT tell that your home directory/);
      }
    });

    it("refuses a destination inside the configured hub directory", () => {
      const hub = join(outside, "hub");
      mkdirSync(join(hub, "index"), { recursive: true });
      const v = checkEscrowDestination(join(hub, "index", "e.age"), {
        cwd: project,
        hubPath: hub,
      });
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.rule).toBe("inside-hub");
    });

    it("refuses a destination inside a sesh-mover project", () => {
      const proj = join(outside, "proj");
      mkdirSync(join(proj, "deep", "deeper"), { recursive: true });
      writeFileSync(join(proj, ".sesh-mover-project.json"), "{}");
      const v = checkEscrowDestination(join(proj, "deep", "deeper", "e.age"), {
        cwd: project,
        hubPath: null,
      });
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.rule).toBe("inside-project");
    });

    it("refuses a destination inside the project this command is running for", () => {
      const proj = join(outside, "plain-project");
      mkdirSync(proj, { recursive: true });
      const v = checkEscrowDestination(join(proj, "e.age"), { cwd: proj, hubPath: null });
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.rule).toBe("inside-project");
    });

    it("refuses a destination inside any git work tree", () => {
      const repo = join(outside, "dotfiles");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(repo, "keys"), { recursive: true });
      const v = checkEscrowDestination(join(repo, "keys", "e.age"), {
        cwd: project,
        hubPath: null,
      });
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.rule).toBe("inside-git-work-tree");
    });

    it("refuses a directory that LOOKS synced, by name and by marker file", () => {
      for (const name of ["Dropbox", "OneDrive - Contoso", "Nextcloud", "my drive"]) {
        const d = join(outside, name, "sub");
        mkdirSync(d, { recursive: true });
        const v = checkEscrowDestination(join(d, "e.age"), { cwd: project, hubPath: null });
        expect(v.ok, `${name} was accepted`).toBe(false);
        if (v.ok) continue;
        expect(v.rule).toBe("looks-synced");
      }
      const marked = join(outside, "unremarkable-name");
      mkdirSync(marked, { recursive: true });
      writeFileSync(join(marked, ".stfolder"), "");
      const v = checkEscrowDestination(join(marked, "e.age"), { cwd: project, hubPath: null });
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.rule).toBe("looks-synced");
    });

    it.skipIf(!isPosix)("resolves the parent directory, so a symlink cannot slip past", () => {
      // A lexical check would accept `~/looks-fine/e.age` while the bytes land
      // in a repository.
      //
      // THE FIXTURE IS THE TEST HERE, and the obvious one passes for the wrong
      // reason: a link pointing at the repo ROOT is caught even lexically,
      // because `existsSync(join(link, ".git"))` follows the link itself. Only
      // a link into a SUBDIRECTORY separates the two — walking up from the link
      // lexically never visits the repo root at all, so nothing but the
      // realpath finds the `.git`. Removing `realish` leaves this green with
      // the root-pointing fixture; measured.
      const repo = join(outside, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(repo, "keys"), { recursive: true });
      const link = join(outside, "looks-fine");
      symlinkSync(join(repo, "keys"), link);
      const v = checkEscrowDestination(join(link, "e.age"), {
        cwd: project,
        hubPath: null,
      });
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.rule).toBe("inside-git-work-tree");
    });

    it("refuses when the containing directory does not exist, rather than creating it", () => {
      const v = checkEscrowDestination(join(outside, "typo", "e.age"), {
        cwd: project,
        hubPath: null,
      });
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.rule).toBe("no-parent-directory");
      expect(existsSync(join(outside, "typo"))).toBe(false);
    });

    it("WARNS but does not refuse inside ~/.sesh-mover — not a leak, not recovery", () => {
      mkdirSync(join(home, ".sesh-mover"), { recursive: true });
      const v = checkEscrowDestination(join(home, ".sesh-mover", "e.age"), {
        cwd: project,
        hubPath: null,
      });
      // `.sesh-mover` under $HOME is the USER-scope directory, not a project.
      // Treating it as one would refuse the whole home directory.
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.warnings.join("\n")).toMatch(/beside the identity file/);
    });
  });

  /**
   * The CLI seam. Nothing above exercises `cli.ts`, and the whole point of this
   * verb is that ONE channel carries the passphrase — so the wiring that reads
   * stdin, and only stdin, needs its own coverage. These spawn `dist/cli.js`
   * (kept fresh by `pretest`), so a mutation in `src/` alone is invisible here.
   */
  describe("through the CLI", () => {
    function cli(args: string[], input?: string) {
      const r = runCli(["hub", "escrow", ...args, "--project-path", project], {
        env: homeEnv(home),
        ...(input === undefined ? {} : { input }),
      });
      return { ...r, body: JSON.parse(r.stdout) };
    }

    it("status is exit 0 and reports off, on a machine that never asked", () => {
      const r = cli([]);
      expect(r.status).toBe(0);
      expect(r.body).toMatchObject({ success: true, command: "hub-escrow", enabled: false });
    });

    it("--enable without --passphrase-stdin is a REFUSAL, exit 2", () => {
      const r = cli(["--enable", "--out", join(outside, "e.age")]);
      expect(r.status).toBe(2);
      expect(r.body).toMatchObject({ reason: "escrow-refused", refusal: "passphrase" });
    });

    it("--enable and --disable together is a bad invocation, exit 1", () => {
      const r = cli(["--enable", "--disable"]);
      expect(r.status).toBe(1);
      expect(r.body.success).toBe(false);
    });

    it("takes the passphrase from stdin, and strips exactly one trailing newline", () => {
      loadOrCreateIdentity();
      const a = join(outside, "a.age");
      const b = join(outside, "b.age");
      // `printf '%s'` sends no newline; `echo` sends one. Both must produce a
      // file the SAME typed passphrase opens, or the mismatch is discovered
      // during a recovery and never before.
      expect(cli(["--enable", "--passphrase-stdin", "--out", a], "pw for stdin").status).toBe(0);
      cli(["--disable"]);
      expect(cli(["--enable", "--passphrase-stdin", "--out", b], "pw for stdin\n").status).toBe(0);
      return Promise.all(
        [a, b].map(async (f) =>
          expect(
            (
              await through(readFileSync(f), new AgeDecryptStream({ passphrase: Buffer.from("pw for stdin") }))
            ).length
          ).toBeGreaterThan(0)
        )
      );
    });

    it("an unsafe --out is refused with the rule named, exit 2", () => {
      loadOrCreateIdentity();
      mkdirSync(join(outside, "repo", ".git"), { recursive: true });
      const r = cli(
        ["--enable", "--passphrase-stdin", "--out", join(outside, "repo", "e.age")],
        "a passphrase"
      );
      expect(r.status).toBe(2);
      expect(r.body.unsafeOut.rule).toBe("inside-git-work-tree");
      expect(existsSync(join(outside, "repo", "e.age"))).toBe(false);
    });

    it.skipIf(!HAVE_PTY)("refuses on a real terminal instead of echoing what is typed", () => {
      // The one branch a piped-stdin test structurally cannot reach: through
      // `runCli` stdin is always a pipe, so `process.stdin.isTTY` is false and
      // the refusal never fires. Handing the child an actual controlling
      // terminal is the only way to see it — and the failure this guards
      // against is not cosmetic: without it the CLI would sit reading a
      // terminal, echoing the passphrase into the user's scrollback.
      loadOrCreateIdentity();
      const r = runUnderPty(
        0,
        [
          process.execPath,
          join(import.meta.dirname, "..", "dist", "cli.js"),
          "hub",
          "escrow",
          "--enable",
          "--passphrase-stdin",
          "--out",
          join(outside, "tty.age"),
          "--project-path",
          project,
        ],
        ""
      );
      expect(r.status, "the CLI hung on a terminal instead of refusing").toBe(2);
      const body = JSON.parse(r.transcript.replace(/\r/g, ""));
      expect(body).toMatchObject({ reason: "escrow-refused", refusal: "passphrase" });
      expect(body.error).toContain("terminal");
      expect(existsSync(join(outside, "tty.age"))).toBe(false);
    });

    it("the passphrase never appears on stdout or stderr", () => {
      loadOrCreateIdentity();
      const secret = "a-very-distinctive-passphrase-9f3b";
      const r = runCli(
        ["hub", "escrow", "--enable", "--passphrase-stdin", "--out", join(outside, "e.age"), "--project-path", project],
        { env: homeEnv(home), input: secret }
      );
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
      expect(r.stdout).not.toContain("AGE-SECRET-KEY");
    });
  });

});
