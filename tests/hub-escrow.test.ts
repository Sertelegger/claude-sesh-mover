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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { homeEnv, overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import { cliPath, runCli } from "./helpers/run-cli.js";
import { errorMessage } from "../src/errors.js";
import {
  canonicalPath,
  checkEscrowDestination,
  escrowEnableRecipes,
  escrowRecordPath,
  homeDirs,
  hubEscrow,
  type EscrowPassphraseInput,
} from "../src/hub/escrow.js";
import { AgeDecryptStream } from "../src/crypto/age.js";
import { identityFilePath, loadOrCreateIdentity } from "../src/crypto/identity-file.js";
import {
  HAVE_PASSPHRASE_ORACLE, HAVE_PTY, ORACLES, oracleDecryptPassphrase, runUnderPty, through,
} from "./helpers/age-oracle.js";
import { spawnSync } from "node:child_process";

const isPosix = process.platform !== "win32";

/**
 * The shells the POSIX line claims, by absolute path because the line runs with
 * a PATH holding nothing but `node`. bash is required for the shell tests to run
 * at all; zsh joins them wherever it is installed, since the line says "bash or
 * zsh" and `read` differs between the two in exactly the flags it depends on.
 */
const POSIX_SHELLS = isPosix
  ? ["bash", "zsh"].flatMap((name) => {
      const found = [`/bin/${name}`, `/usr/bin/${name}`].find((p) => existsSync(p));
      return found ? [found] : [];
    })
  : [];
const BASH = POSIX_SHELLS.find((p) => p.endsWith("/bash")) ?? null;

/**
 * Every enable line in a doc, split into the ones spelled in full and counts of
 * every place one STARTS. A copy that drops `IFS=` or `-r`, loses the subshell,
 * or goes back to a bare `sesh-mover` stops matching the strict pattern but
 * still starts like one, so the numbers disagree.
 *
 * Two independent start counts, because each misses what the other catches: a
 * `read` of `SESH_ESCROW` with ANY flags or none (including `-p 'prompt'`,
 * whose quoted argument would otherwise end the match), and every pipe into an
 * enable, which is the one thing a recipe cannot do without whatever it reads
 * the passphrase into and whichever shell it is for. The pipe count stops at a
 * backtick so it cannot join two inline-code spans of prose into a line.
 *
 * A third, because a copy can feed the enable with no pipe at all — a
 * here-string, a `<` redirect — and then neither start count nor the pipe count
 * sees it: every place an EXECUTABLE (`node <path>` or a bare `sesh-mover`)
 * runs the enable with `--passphrase-stdin`. Prose that names the flags has no
 * executable in front of them, so it is not counted.
 */
function docEnableLines(text: string): {
  posix: string[];
  powershell: string[];
  posixStarts: number;
  powershellStarts: number;
  pipedEnables: number;
  invokedEnables: number;
} {
  return {
    posix: [...text.matchAll(/\( IFS= read -rs SESH_ESCROW && printf '%s' "\$SESH_ESCROW" \| node "[^"\n]+" hub escrow --enable --passphrase-stdin --out <path> \)/g)].map((m) => m[0]),
    powershell: [...text.matchAll(/& \{ \$p = Read-Host -Prompt 'Escrow passphrase' -AsSecureString; [^`\n]* hub escrow --enable --passphrase-stdin --out <path> \}/g)].map((m) => m[0]),
    posixStarts: [...text.matchAll(/\bread(?:\s+-[A-Za-z]+(?:\s+(?:'[^'\n]*'|"[^"\n]*"))?)*\s+SESH_ESCROW\b/g)].length,
    powershellStarts: [...text.matchAll(/Read-Host -Prompt 'Escrow passphrase'/g)].length,
    pipedEnables: [...text.matchAll(/\|[^|\n`]*\bhub escrow --enable --passphrase-stdin/g)].length,
    invokedEnables: [...text.matchAll(/(?:\bsesh-mover|\bnode\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s`]+))\s+hub escrow --enable --passphrase-stdin/g)].length,
  };
}

/** Cheap work factor: this file is about the verb, not about scrypt. */
const CHEAP = 10;
const PASS = "an escrow passphrase";
const given: EscrowPassphraseInput = { kind: "given", bytes: Buffer.from(PASS) };

/**
 * The copies test below is only as good as `docEnableLines`' idea of where an
 * enable line STARTS: a copy it does not count as a start is a copy it never
 * asks to be spelled in full. So the counter is pinned on its own, against the
 * spellings a hand-edited doc actually drifts into — a `read` with no flags, one
 * whose flags are split or take a prompt argument, a different variable name,
 * and a PowerShell line that dropped `-Prompt` — each beside one correct line,
 * so the only thing that can make the verdict "complete" is the counter
 * missing the stray.
 */
describe("docEnableLines", () => {
  const FULL_POSIX =
    `( IFS= read -rs SESH_ESCROW && printf '%s' "$SESH_ESCROW" | node "/p/dist/cli.js" hub escrow --enable --passphrase-stdin --out <path> )`;
  const complete = (text: string) => {
    const f = docEnableLines(text);
    return (
      f.posix.length === f.posixStarts &&
      f.powershell.length === f.powershellStarts &&
      f.posix.length + f.powershell.length === f.pipedEnables &&
      f.posix.length + f.powershell.length === f.invokedEnables
    );
  };

  it("counts a line spelled in full as complete", () => {
    expect(complete(FULL_POSIX)).toBe(true);
    expect(complete(escrowEnableRecipes("/p/dist/cli.js").powershell.replace("node '/p/dist/cli.js'", 'node "/p/dist/cli.js"'))).toBe(true);
  });

  it.each([
    ["a flagless read with a bare sesh-mover", `read SESH_ESCROW && printf '%s' "$SESH_ESCROW" | sesh-mover hub escrow --enable --passphrase-stdin --out <path>`],
    ["split flags", `IFS= read -r -s SESH_ESCROW && printf '%s' "$SESH_ESCROW" | sesh-mover hub escrow --enable --passphrase-stdin --out <path>`],
    ["a prompt argument", `IFS= read -rsp 'Passphrase: ' SESH_ESCROW && printf '%s' "$SESH_ESCROW" | sesh-mover hub escrow --enable --passphrase-stdin --out <path>`],
    ["another variable", `read -rs PASS && printf '%s' "$PASS" | sesh-mover hub escrow --enable --passphrase-stdin --out <path>`],
    ["a PowerShell line without -Prompt", `& { $p = Read-Host 'Escrow passphrase' -AsSecureString; [System.Net.NetworkCredential]::new('', $p).Password | sesh-mover hub escrow --enable --passphrase-stdin --out <path> }`],
    // No `read`, no `Read-Host` and no pipe, so none of the three start counts
    // above sees them — yet each one runs the enable with the passphrase coming
    // from somewhere the recipe does not control.
    ["a here-string with no pipe", `node "/p/dist/cli.js" hub escrow --enable --passphrase-stdin --out <path> <<< "$PASS"`],
    ["a bare sesh-mover fed from a file", `sesh-mover hub escrow --enable --passphrase-stdin --out <path> < passphrase.txt`],
  ])("does not call a doc complete when it also holds %s", (_label, stray) => {
    expect(complete(`${FULL_POSIX}\n\n${stray}\n`)).toBe(false);
  });

  it("does not count prose that names the flags as a line", () => {
    expect(
      complete(
        `${FULL_POSIX}\nDo not drop \`IFS=\` or \`-r\`: without them \`read\` strips edge spaces, and the parentheses keep a \`SESH_ESCROW\` variable from outliving the line. \`hub escrow --enable --passphrase-stdin --out <path>\`, run from your own shell.`
      )
    ).toBe(true);
  });
});

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

  /**
   * REALPATH'd, on every side.
   *
   * `checkEscrowDestination` resolves the parent directory before it decides
   * anything — deliberately, since a symlink named `~/safe` pointing into a
   * repository would otherwise pass every check lexically — and it reports the
   * resolved path, which is the one the bytes actually land at. On macOS
   * `mkdtempSync(tmpdir())` hands back `/var/folders/…`, a symlink to
   * `/private/var/folders/…`, so a fixture that keeps the lexical spelling
   * compares the two spellings of the same directory and fails on macOS alone.
   *
   * Through the PRODUCT'S OWN canonicalizer, not a local `realpathSync`. Two
   * platforms rewrite these paths and they need different calls: macOS resolves
   * a symlink, Windows expands an 8.3 short name, and only `.native` does the
   * second. A fixture with its own copy of that rule got `RUNNER~1` where the
   * product got `runneradmin` — the same class of disagreement twice over.
   */
  function scratch(prefix: string): string {
    return canonicalPath(mkdtempSync(join(tmpdir(), prefix)));
  }

  beforeEach(() => {
    home = scratch("sesh-escrow-home-");
    outside = scratch("sesh-escrow-out-");
    project = scratch("sesh-escrow-proj-");
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
      // chat transcript, which the SessionEnd auto-push would upload. Both
      // shells get one (#134), and neither names a bare `sesh-mover`, which no
      // documented install puts on PATH.
      expect(r.suggestion).toContain("IFS= read -rs SESH_ESCROW");
      expect(r.suggestion).toContain("Read-Host -Prompt 'Escrow passphrase' -AsSecureString");
      expect(r.suggestion).toContain("--passphrase-stdin");
      expect(r.suggestion).not.toMatch(/\|\s*sesh-mover /);
      // The path in both lines is this install's, so on native Windows it is a
      // drive-letter path that a WSL shell's Linux `node` cannot open: WSL is
      // offered only for a Claude Code running inside it, and native Windows
      // is sent to the PowerShell line.
      expect(r.suggestion).toContain("WSL only if Claude Code itself runs inside WSL");
      expect(r.suggestion).toContain("PowerShell (the one to use on native Windows)");
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
      // The way to get one is a slash command, not a bare `sesh-mover` that no
      // documented install puts on PATH (#134).
      expect(r.suggestion).toContain("/sesh-mover:hub-init");
      expect(r.suggestion).not.toMatch(/`sesh-mover /);
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

    /**
     * The end-to-end effect of this — a user-scope store in an ancestor no
     * longer reading as a project — can only be staged on Windows, where the
     * temp root is under the profile, and staging it anywhere would mean
     * writing `.sesh-mover` into the real home, which is the pollution that
     * caused the failure in the first place. So what is pinned here is the
     * property the fix rests on: the exemption consults BOTH spellings of
     * home, and under an override they genuinely differ. Drop the
     * `userInfo()` arm and this fails; the Windows job proves the consequence.
     */
    it("exempts both spellings of home, which an override makes differ", () => {
      const dirs = homeDirs();
      // `home` is this fixture's override, which is what homedir() now reports.
      expect(dirs).toContain(home);
      // And the OS's own answer, which no environment variable moved.
      expect(dirs).toContain(canonicalPath(userInfo().homedir));
      expect(canonicalPath(userInfo().homedir)).not.toBe(home);
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
      // The detail names the offending directory, so a rule that fires from an
      // ancestor the fixture never chose says WHICH one rather than just which
      // rule — the difference between diagnosing a platform-only failure and
      // guessing at it.
      expect(v.rule, v.detail).toBe("inside-git-work-tree");
    });

    it("refuses a directory that LOOKS synced, by name and by marker file", () => {
      for (const name of ["Dropbox", "OneDrive - Contoso", "Nextcloud", "my drive"]) {
        const d = join(outside, name, "sub");
        mkdirSync(d, { recursive: true });
        const v = checkEscrowDestination(join(d, "e.age"), { cwd: project, hubPath: null });
        expect(v.ok, `${name} was accepted`).toBe(false);
        if (v.ok) continue;
        expect(v.rule, v.detail).toBe("looks-synced");
      }
      const marked = join(outside, "unremarkable-name");
      mkdirSync(marked, { recursive: true });
      writeFileSync(join(marked, ".stfolder"), "");
      const v = checkEscrowDestination(join(marked, "e.age"), { cwd: project, hubPath: null });
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.rule, v.detail).toBe("looks-synced");
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

    /**
     * Both docs answer EVERY `refusal: "passphrase"` the same way: re-print,
     * verbatim, the two lines its `suggestion` carries. They have to — the
     * alternative is the model retyping them from memory, which is how a bare
     * `sesh-mover` or a `read` without `IFS=` reaches a user, and a line that
     * fails in the user's shell is what sends them back to typing the
     * passphrase into the chat. That instruction is only true if all FOUR causes
     * carry both lines, and the empty-passphrase and line-break refusals used to
     * carry neither.
     *
     * So each cause is produced the way a user produces it — through the CLI,
     * the terminal one on a real pty, since a piped stdin can never reach it —
     * and its suggestion must hold both lines for the `cli.js` that ran. No
     * identity exists here, deliberately: every passphrase refusal fires before
     * the identity is read.
     */
    const PASSPHRASE_CAUSES: Array<{ cause: string; args: string[]; input?: string; pty?: true; error: string }> = [
      { cause: "no --passphrase-stdin", args: [], error: "--passphrase-stdin" },
      { cause: "stdin is a terminal", args: ["--passphrase-stdin"], pty: true, error: "terminal" },
      { cause: "an empty passphrase", args: ["--passphrase-stdin"], input: "", error: "empty" },
      { cause: "a line break inside the passphrase", args: ["--passphrase-stdin"], input: "two\nlines\n", error: "line break" },
    ];
    for (const c of PASSPHRASE_CAUSES) {
      it.skipIf(c.pty === true && !HAVE_PTY)(`the passphrase refusal for ${c.cause} carries both enable lines for the cli.js that ran`, () => {
        const out = join(outside, "e.age");
        const args = ["--enable", ...c.args, "--out", out];
        const ran = c.pty
          ? (() => {
              const r = runUnderPty(0, [process.execPath, cliPath(), "hub", "escrow", ...args, "--project-path", project], "");
              return { status: r.status, body: JSON.parse(r.transcript.replace(/\r/g, "")) };
            })()
          : cli(args, c.input);
        expect(ran.status).toBe(2);
        expect(ran.body).toMatchObject({ success: false, reason: "escrow-refused", refusal: "passphrase" });
        expect(ran.body.error, "a different refusal than the one this row is for").toContain(c.error);
        const printed = (ran.body.suggestion as string).split("\n").map((l) => l.trim());
        const want = escrowEnableRecipes(realpathSync(cliPath()));
        expect(printed, `${c.cause}: no bash/zsh line for the cli.js that ran`).toContain(want.posix);
        expect(printed, `${c.cause}: no PowerShell line for the cli.js that ran`).toContain(want.powershell);
        expect(existsSync(out)).toBe(false);
        expect(existsSync(identityFilePath()), "a passphrase refusal minted an identity").toBe(false);
      });
    }

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

    /**
     * Windows PowerShell 5.1 can prepend a UTF-8 byte-order mark when it pipes
     * text to a native command — measured on the windows-latest runner, where
     * the recipe's pipe sent `efbbbf` ahead of the CRLF. Left in, the escrow
     * would open only with an invisible character the user never typed, found
     * out at recovery; and a BOM with nothing after it would slip past the
     * empty-passphrase refusal, writing an escrow any reader can open.
     */
    it("drops a leading UTF-8 byte-order mark, so a PowerShell pipe produces the key the user typed", async () => {
      loadOrCreateIdentity();
      const f = join(outside, "bom.age");
      expect(cli(["--enable", "--passphrase-stdin", "--out", f], "\uFEFFpw for stdin\r\n").status).toBe(0);
      const opened = await through(readFileSync(f), new AgeDecryptStream({ passphrase: Buffer.from("pw for stdin") }));
      expect(opened.length).toBeGreaterThan(0);
    });

    it("a byte-order mark and a line ending with nothing between them is an empty passphrase, refused", () => {
      loadOrCreateIdentity();
      const f = join(outside, "bom-only.age");
      const r = cli(["--enable", "--passphrase-stdin", "--out", f], "\uFEFF\r\n");
      expect(r.status).toBe(2);
      expect(r.body).toMatchObject({ reason: "escrow-refused", refusal: "passphrase" });
      expect(existsSync(f)).toBe(false);
    });

    /**
     * #134. The line a refusal prints is the one thing a user is told to type,
     * and until this nothing ran it: the retry-works proof called `hubEscrow()`
     * in-process, so the printed line could name an executable no install puts
     * on PATH (it did: a bare `sesh-mover`) and still pass. So this runs what a
     * user runs, in the shell the line is for: first the refused invocation,
     * then the recipe it printed, with only `<path>` filled in.
     *
     * PATH holds `node` and NOTHING else — a PATH that happened to contain an
     * `npm i -g` or `npm link` of this package would pass a bare `sesh-mover`
     * too, which is exactly the install nobody documents.
     *
     * The passphrase has an edge space at each end and a backslash, because the
     * recipe's `read` otherwise rewrites both before anything sees them — IFS
     * trimming and backslash escapes — and the escrow would then open only for
     * a passphrase the user never typed. `age` at its own prompt keeps them.
     * bash, not `sh`: dash has no `read -s`, which is why the line says bash
     * or zsh.
     */
    /**
     * Runs `line` the way a user's shell would, with PATH holding only `node`,
     * and reports what the shell itself still held afterwards. The recipe runs
     * in the user's INTERACTIVE shell, so a passphrase it left in a shell
     * variable would sit there for the rest of that session — in `set` output,
     * in any later `env`-style dump — which is why the line is a subshell.
     */
    function runAsPrinted(shell: string, bin: string, line: string, input: string) {
      const ran = spawnSync(shell, ["-c", `${line}\nrc=$?\nprintf '\\n--after:%s:[%s]' "$rc" "\${SESH_ESCROW-unset}"`], {
        input, encoding: "utf-8", cwd: project, env: { ...homeEnv(home), PATH: bin },
      });
      const at = ran.stdout.lastIndexOf("\n--after:");
      const trailer = /^\n--after:(\d+):\[(.*)\]$/s.exec(ran.stdout.slice(at));
      return {
        stderr: ran.stderr,
        status: trailer ? Number(trailer[1]) : null,
        leftBehind: trailer ? trailer[2] : null,
        stdout: at >= 0 ? ran.stdout.slice(0, at) : ran.stdout,
      };
    }

    /** A bin directory holding `node` and nothing else, under `outside` so afterEach removes it. */
    function nodeOnlyBin(): string {
      const bin = join(outside, "bin");
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "node"));
      return bin;
    }

    /**
     * The passphrase has an edge space at each end and a backslash, because the
     * recipe's `read` otherwise rewrites both before anything sees them — IFS
     * trimming and backslash escapes — and the escrow would then open only for a
     * passphrase the user never typed. `age` at its own prompt keeps them.
     */
    const EDGED = "  an edged pass\\phrase  ";

    async function expectOpensWith(out: string, passphrase: string, label: string): Promise<void> {
      const identity = readFileSync(identityFilePath(), "utf-8");
      const opened = await through(readFileSync(out), new AgeDecryptStream({ passphrase: Buffer.from(passphrase) }));
      expect(opened.toString("utf-8"), `${label}: the escrow does not open with the passphrase as typed`).toBe(identity);
      // And through the tool recovery actually uses, typing it at age's own prompt.
      if (HAVE_PASSPHRASE_ORACLE) {
        const recovered = `${out}.recovered`;
        const run = oracleDecryptPassphrase(ORACLES[0].bin, passphrase, out, recovered);
        expect(run.status, `${label}: ${run.transcript}`).toBe(0);
        expect(readFileSync(recovered, "utf-8"), label).toBe(identity);
      }
    }

    it.skipIf(!BASH)("the printed shell line enables the escrow exactly as printed, with only node on PATH", async () => {
      loadOrCreateIdentity();
      const bin = nodeOnlyBin();
      const cliEntry = join(import.meta.dirname, "..", "dist", "cli.js");
      for (const shell of POSIX_SHELLS) {
        const inShell = (line: string, input: string) => runAsPrinted(shell, bin, line, input);
        const out = join(outside, `${shell.split("/").pop()}.age`);

        const refused = inShell(`node '${cliEntry}' hub escrow --enable --out '${out}'`, "");
        expect(refused.status, `${shell}: ${refused.stderr}`).toBe(2);
        const body = JSON.parse(refused.stdout);
        expect(body.refusal).toBe("passphrase");
        const recipe = (body.suggestion as string)
          .split("\n").map((l) => l.trim()).find((l) => l.includes("SESH_ESCROW"));
        expect(recipe, "the refusal printed no shell line").toBeDefined();
        expect(recipe).toContain("--enable --passphrase-stdin --out <path>");

        const ran = inShell(recipe!.replace("<path>", `'${out}'`), `${EDGED}\n`);
        expect(ran.status, `${shell}: the printed line failed: ${ran.stderr}`).toBe(0);
        expect(JSON.parse(ran.stdout)).toMatchObject({ success: true, action: "enabled" });
        expect(ran.leftBehind, `${shell}: the printed line left the passphrase in the user's shell`).toBe("unset");
        await expectOpensWith(out, EDGED, shell);
      }
    });

    /**
     * #134's first-met copies. The line a user sees first is not the CLI's — it
     * is step 1 of `commands/hub-escrow.md`, which the model prints verbatim
     * after Claude Code has replaced `${CLAUDE_PLUGIN_ROOT}` in it, and its
     * hand-copied twins in the README and the skill doc. Nothing ran those
     * until this, so a copy could drop `IFS=` or go back to a bare
     * `sesh-mover` with the suite green.
     *
     * Two checks, doing different jobs. Every copy must equal
     * `escrowEnableRecipes` apart from how the path is spelled (a template
     * there, the path of the cli.js that ran here), so the executed CLI line
     * vouches for them all. And the command doc's line is run itself, with
     * the plugin root substituted the way Claude Code substitutes it — a plain
     * textual replace — because the double-quoted spelling it uses is not the
     * CLI's single-quoted one and nothing else executes it.
     */
    it.skipIf(!BASH)("the command doc's enable line runs as printed once the plugin root is filled in, and every doc copy matches the CLI's", async () => {
      const root = join(import.meta.dirname, "..");
      const spellPath = (line: string) =>
        line.replace(/node "(?:\$\{CLAUDE_PLUGIN_ROOT\}|<plugin dir>)\/dist\/cli\.js"/, "node <CLI>");
      const cliLines = escrowEnableRecipes("/CLI");
      const expected = {
        posix: cliLines.posix.replace("node '/CLI'", "node <CLI>"),
        powershell: cliLines.powershell.replace("node '/CLI'", "node <CLI>"),
      };
      // The skill doc carries NO copy, on purpose: it tells the model to copy
      // both lines verbatim from `/sesh-mover:hub-escrow` or from the CLI's own
      // refusal, so there is nothing in it that could drift from either.
      const copies: Array<[string, { posix: number; powershell: number }]> = [
        ["commands/hub-escrow.md", { posix: 1, powershell: 1 }],
        ["README.md", { posix: 1, powershell: 1 }],
        ["skills/session-porter/SKILL.md", { posix: 0, powershell: 0 }],
      ];
      for (const [file, want] of copies) {
        const found = docEnableLines(readFileSync(join(root, file), "utf-8"));
        expect(found.posix.length, `${file}: an enable line is not spelled in full`).toBe(found.posixStarts);
        expect(found.powershell.length, `${file}: a PowerShell enable line is not spelled in full`).toBe(found.powershellStarts);
        expect(found.posix.length + found.powershell.length, `${file}: something is piped into an enable that is not a line spelled in full`).toBe(found.pipedEnables);
        expect(found.posix.length + found.powershell.length, `${file}: an enable is run with --passphrase-stdin outside a line spelled in full`).toBe(found.invokedEnables);
        expect({ posix: found.posix.length, powershell: found.powershell.length }, file).toEqual(want);
        for (const line of found.posix) expect(spellPath(line), file).toBe(expected.posix);
        for (const line of found.powershell) expect(spellPath(line), file).toBe(expected.powershell);
      }

      loadOrCreateIdentity();
      const bin = nodeOnlyBin();
      const [docLine] = docEnableLines(readFileSync(join(root, "commands", "hub-escrow.md"), "utf-8")).posix;
      const asPrinted = docLine.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => root);
      for (const shell of POSIX_SHELLS) {
        const out = join(outside, `doc-${shell.split("/").pop()}.age`);
        const ran = runAsPrinted(shell, bin, asPrinted.replace("<path>", `'${out}'`), `${EDGED}\n`);
        expect(ran.status, `${shell}: the command doc's line failed: ${ran.stderr}`).toBe(0);
        expect(JSON.parse(ran.stdout)).toMatchObject({ success: true, action: "enabled" });
        expect(ran.leftBehind, `${shell}: the doc's line left the passphrase in the user's shell`).toBe("unset");
        await expectOpensWith(out, EDGED, `${shell} (doc line)`);
      }
    });

    /**
     * N2 of #134's re-review. When `${CLAUDE_PLUGIN_ROOT}` reaches the model
     * unexpanded, step 1 of `commands/hub-escrow.md` used to fall back to
     * `printf '%s\n' "${CLAUDE_PLUGIN_ROOT}"` in the Bash tool — which, with the
     * variable unset there too, exits 0 and prints an EMPTY line, and the model
     * then handed the user `node "/dist/cli.js" …`: a line that fails with
     * "Cannot find module", the exact nudge toward pasting the passphrase into
     * the chat instead. It is also SKILL.md's only source for the two lines,
     * since the skill doc carries no copy of them.
     *
     * The replacement is the enable REFUSAL, and this pins each property the
     * docs claim for it against the docs' own spelling of the run:
     * - one run, spelled identically in both docs, with no `--passphrase-stdin`,
     *   so the CLI never reads stdin;
     * - it refuses before the identity check and before `--out` is looked at,
     *   so it works on a machine that has never registered and leaves the home
     *   directory exactly as empty as it found it;
     * - its `suggestion` carries BOTH lines, byte-equal to `escrowEnableRecipes`
     *   for the cli.js that actually ran;
     * - with the variable unset it fails LOUDLY — non-zero, nothing on stdout —
     *   so there is no line to print, which is the branch the docs tell the
     *   model to report instead.
     */
    it.skipIf(!BASH)("the doc fallback for an unfilled plugin root is the enable refusal, and an unset root yields no line at all", () => {
      const root = join(import.meta.dirname, "..");
      const fallback = /`(node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" hub escrow --enable[^`]*)`/g;
      const runs = ["commands/hub-escrow.md", "skills/session-porter/SKILL.md"].map((file) => {
        const found = [...readFileSync(join(root, file), "utf-8").matchAll(fallback)].map((m) => m[1]);
        expect(found, `${file}: no single enable-refusal run to take the two lines from`).toHaveLength(1);
        return found[0];
      });
      expect(runs[1], "the skill doc and the command doc prescribe different runs").toBe(runs[0]);
      const [run] = runs;
      expect(run, "the fallback run would read a passphrase").not.toContain("--passphrase-stdin");

      const bin = nodeOnlyBin();
      const inBash = (env: Record<string, string>) =>
        spawnSync(BASH!, ["-c", run], {
          input: "a passphrase the fallback must never read\n",
          encoding: "utf-8",
          cwd: project,
          env: { ...homeEnv(home), PATH: bin, ...env },
        });

      const ran = inBash({ CLAUDE_PLUGIN_ROOT: root });
      expect(ran.status, ran.stderr).toBe(2);
      const body = JSON.parse(ran.stdout);
      expect(body).toMatchObject({ success: false, reason: "escrow-refused", refusal: "passphrase" });
      const printed = (body.suggestion as string).split("\n").map((l) => l.trim());
      const want = escrowEnableRecipes(realpathSync(join(root, "dist", "cli.js")));
      expect(printed, "the refusal did not print the bash/zsh line for the cli.js that ran").toContain(want.posix);
      expect(printed, "the refusal did not print the PowerShell line for the cli.js that ran").toContain(want.powershell);
      expect(readdirSync(home), "the fallback run wrote something").toEqual([]);

      const unset = inBash({});
      expect(unset.status, "an unset plugin root did not fail").not.toBe(0);
      expect(unset.stdout, "an unset plugin root still produced output to take a line from").toBe("");
    });

    it.skipIf(!BASH)("quotes the cli path in both lines so nothing in it is expanded", () => {
      // A plugin cache path is under the user's home, and a home can hold any
      // of these. An unescaped quote would split the argument; `$`, `"` and a
      // backtick would be expanded by the shell before node ever saw the path.
      const weird = "/tmp/it's a \"dir\" $HOME/`id`/cli.js";
      const { posix, powershell } = escrowEnableRecipes(weird);
      const quoted = posix.slice(posix.indexOf("| node ") + "| node ".length, posix.lastIndexOf(" hub escrow"));
      expect(spawnSync(BASH!, ["-c", `printf '%s' ${quoted}`], { encoding: "utf-8" }).stdout).toBe(weird);
      // PowerShell's single-quoted string escapes a quote by doubling it, and
      // expands nothing else.
      expect(powershell).toContain(`| node '/tmp/it''s a "dir" $HOME/\`id\`/cli.js' hub escrow`);
    });

    /**
     * #134's second half: the PowerShell line. WINDOWS-ONLY, and its proof lives
     * on the Windows runner — this repo's Linux machines have no PowerShell, so
     * it has never been observed passing here. `Read-Host` is replaced by a
     * function of the same name (functions outrank cmdlets), so everything else
     * on the printed line runs as printed: the `$OutputEncoding` it sets is what
     * stops Windows PowerShell 5.1 sending a non-ASCII passphrase as `?`, which
     * is why the passphrase here is not ASCII, and the CRLF PowerShell appends
     * is what the CLI's one-trailing-newline strip has to absorb.
     */
    it.runIf(process.platform === "win32")("the printed PowerShell line enables the escrow exactly as printed, non-ASCII included", async () => {
      loadOrCreateIdentity();
      const shells = ["powershell.exe", "pwsh.exe"].filter(
        (s) => spawnSync(s, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0
      );
      expect(shells.length, "no PowerShell on this Windows machine").toBeGreaterThan(0);
      const refused = cli(["--enable", "--out", join(outside, "unused.age")]);
      const recipe = (refused.body.suggestion as string)
        .split("\n").map((l) => l.trim()).find((l) => l.startsWith("& {"));
      expect(recipe, "the refusal printed no PowerShell line").toBeDefined();
      const passphrase = "pässwörd mit Ünïcode";
      for (const shell of shells) {
        const out = join(outside, `${shell}.age`);
        // The Read-Host stub builds its SecureString with no module at all.
        // ConvertTo-SecureString lives in Microsoft.PowerShell.Security, and a
        // powershell.exe (5.1) started from a pwsh step — which is how Actions
        // runs `npm test` — inherits PowerShell 7's PSModulePath and can fail to
        // load it: the stub then returned $null, the recipe piped an empty line,
        // and the test was measuring the harness instead of the recipe.
        const script =
          "function Read-Host { param([string]$Prompt, [switch]$AsSecureString) " +
          `$s = [System.Security.SecureString]::new(); foreach ($c in '${passphrase}'.ToCharArray()) { $s.AppendChar($c) }; $s }\n` +
          `${recipe!.replace("<path>", `'${out}'`)}\nexit $LASTEXITCODE\n`;
        const ran = spawnSync(
          shell,
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
          { encoding: "utf-8", cwd: project, env: { ...process.env, ...homeEnv(home) } }
        );
        expect(ran.status, `${shell}: ${ran.stderr}${ran.stdout}`).toBe(0);
        // Diagnostic, not a second assertion: the exact bytes this shell hands
        // a native command when it pipes the passphrase the way the recipe
        // does — same Read-Host stub, same $OutputEncoding line, same pipe,
        // into a byte dumper instead of the CLI. The passphrase is a fixture,
        // so printing its bytes leaks nothing; they are what tells a shell that
        // transcodes apart from one that does not.
        const probe =
          "function Read-Host { param([string]$Prompt, [switch]$AsSecureString) " +
          `$s = [System.Security.SecureString]::new(); foreach ($c in '${passphrase}'.ToCharArray()) { $s.AppendChar($c) }; $s }\n` +
          "& { $p = Read-Host -Prompt 'x' -AsSecureString; $OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
          "[System.Net.NetworkCredential]::new('', $p).Password | node -e \"let b=[];process.stdin.on('data',d=>b.push(d)).on('end',()=>process.stdout.write(Buffer.concat(b).toString('hex')))\" }\n";
        const probed = spawnSync(
          shell,
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")],
          { encoding: "utf-8", cwd: project, env: { ...process.env, ...homeEnv(home) } }
        );
        const sent = probed.stdout.trim();
        const want = Buffer.from(passphrase, "utf-8").toString("hex");
        let opened: Buffer;
        try {
          opened = await through(readFileSync(out), new AgeDecryptStream({ passphrase: Buffer.from(passphrase, "utf-8") }));
        } catch (e) {
          throw new Error(
            `${shell}: the escrow does not open with the passphrase as typed (${errorMessage(e)}). ` +
              `UTF-8 of the passphrase is ${want} (+0d0a); this shell's pipe sent ${sent || "<nothing>"}. ` +
              `Recipe stderr: ${ran.stderr.trim() || "<none>"}. Probe stderr: ${probed.stderr.trim() || "<none>"}`
          );
        }
        expect(opened.toString("utf-8"), `${shell}: the escrow does not open with the passphrase as typed`).toBe(
          readFileSync(identityFilePath(), "utf-8")
        );
        cli(["--disable"]);
      }
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
