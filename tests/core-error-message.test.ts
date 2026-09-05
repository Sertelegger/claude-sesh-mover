import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #102: `(e as Error).message` on paths whose contract is that they do not
 * throw. The fix routes text extraction through `errors.ts`'s `errorMessage`;
 * these tests drive NON-Error rejection reasons through the highest-risk
 * converted sites and assert the surrounding contract survives.
 *
 * Why mocks, in a repo that prefers real files (see testing conventions): a
 * real filesystem throws real `Error`s and our own parsers throw `AgeError`s,
 * so no fixture on disk can make these catches receive `null` or a bare
 * string. The mock is the only way to earn this coverage, and it is a
 * pass-through except at the exact call a test poisons.
 *
 * Every guard here is mutation-proved: restoring the bare cast at the site
 * under test makes the corresponding test fail (counts recorded in the #102
 * branch report), so a green run is evidence rather than coincidence.
 */

const ctl = vi.hoisted(() => ({
  /** Make the mocked `readFileSync` throw `reason` for paths containing the needle. */
  readThrow: undefined as { pathIncludes: string; reason: unknown } | undefined,
  /** Make the mocked `copyFileSync` throw `reason` when src or dest contains the needle. */
  copyThrow: undefined as { pathIncludes: string; reason: unknown } | undefined,
  /** Make the mocked `writeFileSync` throw `reason` for paths containing the needle. */
  writeThrow: undefined as { pathIncludes: string; reason: unknown } | undefined,
  /** Make `parseIdentity` throw `reason` (identity-file's malformed arm). */
  parseIdentityThrow: undefined as { reason: unknown } | undefined,
  /** Make `captureCarry` reject with `reason` (capture.ts's containment `.catch`). */
  carryReject: undefined as { reason: unknown } | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const hit = (needle: string | undefined, ...paths: unknown[]): boolean =>
    needle !== undefined && paths.some((p) => String(p).includes(needle));
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (ctl.readThrow && hit(ctl.readThrow.pathIncludes, path)) throw ctl.readThrow.reason;
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
    copyFileSync: ((src: unknown, dest: unknown, ...rest: unknown[]) => {
      if (ctl.copyThrow && hit(ctl.copyThrow.pathIncludes, src, dest)) throw ctl.copyThrow.reason;
      return (actual.copyFileSync as (...a: unknown[]) => unknown)(src, dest, ...rest);
    }) as typeof actual.copyFileSync,
    writeFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (ctl.writeThrow && hit(ctl.writeThrow.pathIncludes, path)) throw ctl.writeThrow.reason;
      return (actual.writeFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.writeFileSync,
  };
});

vi.mock("../src/crypto/age.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/crypto/age.js")>();
  return {
    ...actual,
    parseIdentity: ((s: string) => {
      if (ctl.parseIdentityThrow) throw ctl.parseIdentityThrow.reason;
      return actual.parseIdentity(s);
    }) as typeof actual.parseIdentity,
  };
});

vi.mock("../src/payload/carry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/payload/carry.js")>();
  return {
    ...actual,
    captureCarry: (async (...args: Parameters<typeof actual.captureCarry>) => {
      if (ctl.carryReject) throw ctl.carryReject.reason;
      return actual.captureCarry(...args);
    }) as typeof actual.captureCarry,
  };
});

// Imported AFTER the mocks so the modules under test see them. The fs import
// is the mocked one on purpose: setup writes pass through untouched because
// every control starts (and is reset to) undefined.
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import { identityFilePath, loadOrCreateIdentity, readIdentityFile } from "../src/crypto/identity-file.js";
import { captureCarry } from "../src/payload/carry.js";
import { capturePayload } from "../src/payload/capture.js";

function gitRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sesh-errmsg-${name}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "tracked.txt"), "v1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

afterEach(() => {
  ctl.readThrow = undefined;
  ctl.copyThrow = undefined;
  ctl.writeThrow = undefined;
  ctl.parseIdentityThrow = undefined;
  ctl.carryReject = undefined;
});

describe("identity-file three-valued read survives non-Error failures (#102)", () => {
  let home: string;
  let restore: HomeOverrideHandle;

  function withHome(): void {
    home = mkdtempSync(join(tmpdir(), "sesh-errmsg-home-"));
    restore = overrideHome(home);
    mkdirSync(join(home, ".sesh-mover"), { recursive: true });
  }

  afterEach(() => {
    restore?.restore();
  });

  it("a `throw null` from the byte read is a typed io-unreadable, not a throw", () => {
    // The contract under test: `readIdentityFile` NEVER throws — a caller
    // handed an exception instead of `{ state: "unreadable", cause: "io" }`
    // loses the io/malformed split the remedies depend on. Before the fix,
    // `(null as Error).message` was a TypeError out of the catch itself.
    withHome();
    writeFileSync(identityFilePath(), "AGE-SECRET-KEY-1FAKE\n", { mode: 0o600 });
    ctl.readThrow = { pathIncludes: "identity.age", reason: null };

    const r = readIdentityFile();
    expect(r).toEqual({ state: "unreadable", cause: "io", detail: "null" });
  });

  it("a real Error's message still arrives verbatim, empty string included", () => {
    withHome();
    writeFileSync(identityFilePath(), "AGE-SECRET-KEY-1FAKE\n", { mode: 0o600 });

    ctl.readThrow = { pathIncludes: "identity.age", reason: new Error("EACCES-shaped text") };
    let r = readIdentityFile();
    expect(r).toEqual({ state: "unreadable", cause: "io", detail: "EACCES-shaped text" });

    ctl.readThrow = { pathIncludes: "identity.age", reason: new Error("") };
    r = readIdentityFile();
    expect(r).toEqual({ state: "unreadable", cause: "io", detail: "" });
  });

  it("a messageless-object throw from parsing is malformed-unreadable with a string detail", () => {
    // The malformed arm: the file read fine and is not an age identity. A
    // reason with no string `message` used to put `undefined` where the type
    // says string; now it renders through `String()`.
    withHome();
    writeFileSync(identityFilePath(), "# comment\nAGE-SECRET-KEY-1FAKE\n", { mode: 0o600 });
    ctl.parseIdentityThrow = { reason: { code: "not-an-error" } };

    const r = readIdentityFile();
    expect(r.state).toBe("unreadable");
    if (r.state !== "unreadable") throw new Error("unreachable");
    expect(r.cause).toBe("malformed");
    expect(typeof r.detail).toBe("string");
  });

  it("loadOrCreateIdentity turns a bare-string write failure into a typed io result", () => {
    // A STRING reason deliberately, not null: the EEXIST discrimination above
    // this site still reads `.code` off the raw value, which a primitive
    // answers with `undefined` while `null` would throw before the extraction
    // is reached — that residual is reported on #102, not fixed here.
    withHome();
    ctl.writeThrow = { pathIncludes: "identity.age", reason: "ENOSPC-shaped bare string" };

    const r = loadOrCreateIdentity();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.cause).toBe("io");
    expect(r.detail).toBe("ENOSPC-shaped bare string");
  });
});

describe("carry capture survives non-Error failures where it promises to (#102)", () => {
  it("one uncopyable untracked file stays a diagnostic, even thrown as a bare string", async () => {
    // The site's own comment is the contract: one unreadable file must not
    // cost the whole push. A bare-string reason has no `.message`, so the old
    // `.slice()` on `undefined` was a TypeError that escalated the per-file
    // catch into the whole-capture `write-failed` arm.
    const repo = gitRepo("copyfail");
    writeFileSync(join(repo, "poison.txt"), "u1\n");
    writeFileSync(join(repo, "survives.txt"), "u2\n");
    const dest = join(mkdtempSync(join(tmpdir(), "sesh-errmsg-dest-")), "carry");
    const diagnostics: string[] = [];
    ctl.copyThrow = { pathIncludes: "poison.txt", reason: "copy refused, thrown as a bare string" };

    const cap = await captureCarry(repo, dest, { diagnostics });
    expect(cap.captured).toBe(true);
    if (!cap.captured) throw new Error("unreachable");
    expect(cap.meta.untrackedCount).toBe(1);
    expect(existsSync(join(dest, "untracked", "survives.txt"))).toBe(true);
    const diag = diagnostics.find((d) => d.includes("poison.txt"));
    expect(diag).toBeDefined();
    expect(diag).toContain("copy refused, thrown as a bare string");
  });

  it("a `throw null` from the metadata write is a typed write-failed, not a rejection", async () => {
    const repo = gitRepo("writefail");
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    const dest = join(mkdtempSync(join(tmpdir(), "sesh-errmsg-dest-")), "carry");
    ctl.writeThrow = { pathIncludes: "carry.json", reason: null };

    const cap = await captureCarry(repo, dest, {});
    expect(cap.captured).toBe(false);
    if (cap.captured) throw new Error("unreachable");
    expect(cap.reason).toBe("write-failed");
    expect(cap.detail).toBe("null");
  });
});

describe("capturePayload containment holds for a non-Error carry rejection (#102)", () => {
  it("a carry that rejects with null costs the carry, never the operation", async () => {
    // The `.catch` handler in capture.ts IS the containment its comment
    // promises ("no failure of the OPTIONAL half may cost the user the
    // session bundle"). Before the fix, the handler itself read `.message`
    // off the raw reason, so `null` threw from inside the last line of
    // defence and the whole capture rejected.
    const projectPath = mkdtempSync(join(tmpdir(), "sesh-errmsg-proj-"));
    const destDir = mkdtempSync(join(tmpdir(), "sesh-errmsg-stage-"));
    ctl.carryReject = { reason: null };

    const res = await capturePayload({
      projectPath,
      destDir,
      wantWorkspace: false,
      wantCarry: true,
      scan: { kind: "remotes", normalized: [], rawCount: 1 },
      scope: "hub",
    });
    expect(res.decision).toBe("none");
    expect(res.warnings.some((w) => w.includes("Uncommitted changes were not carried"))).toBe(true);
  });
});
