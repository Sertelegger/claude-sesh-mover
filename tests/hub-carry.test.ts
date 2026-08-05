import { describe, it, expect } from "vitest";
import {
  appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome, overridePath } from "./helpers/env.js";
import { applyCarry, captureCarry, CARRY_MAX_BYTES, type CarryMeta } from "../src/hub/carry.js";

/** A throwaway repo with one commit and a remote. NEVER run git against the checkout. */
function gitRepo(name = "carry"): string {
  const dir = mkdtempSync(join(tmpdir(), `sesh-${name}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["remote", "add", "origin", "https://example.com/x/y.git"]);
  writeFileSync(join(dir, "tracked.txt"), "v1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

function tempDest(): string {
  return join(mkdtempSync(join(tmpdir(), "sesh-dest-")), "carry");
}

/** Every file under `root`, as "/"-joined relative paths, sorted. */
function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, childRel));
    else out.push(childRel);
  }
  return out.sort();
}

function writeHubRules(repo: string, file: "hubinclude" | "hubignore", body: string): void {
  mkdirSync(join(repo, ".claude-sesh-mover"), { recursive: true });
  writeFileSync(join(repo, ".claude-sesh-mover", file), body);
}

/** A clean clone-ish copy of `repo` at the same HEAD, for `git apply` round-trips. */
function cleanTwin(repo: string): string {
  const twin = mkdtempSync(join(tmpdir(), "sesh-twin-"));
  cpSync(repo, twin, { recursive: true });
  git(twin, ["reset", "-q", "--hard", "HEAD"]);
  git(twin, ["clean", "-qfdx"]);
  return twin;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

describe("captureCarry", () => {
  it("declines on a clean tree with no hubinclude matches", async () => {
    const repo = gitRepo();
    const dest = tempDest();
    try {
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(false);
      if (!r.captured) expect(r.reason).toBe("clean");
      // Nothing is created for a declined capture: a `carry/` directory with no
      // manifest entry would ship files the puller has no metadata for.
      expect(existsSync(dest)).toBe(false);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("captures modified tracked files, untracked files, and the base commit", async () => {
    const repo = gitRepo();
    const dest = tempDest();
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      writeFileSync(join(repo, "new.txt"), "brand new\n");
      const head = git(repo, ["rev-parse", "HEAD"]).trim();
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      expect(r.meta.baseCommit).toBe(head);
      expect(r.meta.untrackedCount).toBe(1);
      expect(r.meta.detached).toBe(false);
      expect(r.meta.inProgress).toBe(null);
      expect(r.meta.repoPrefix).toBe("");
      expect(readFileSync(join(dest, "changes.patch"), "utf-8")).toContain("tracked.txt");
      expect(readFileSync(join(dest, "untracked", "new.txt"), "utf-8")).toBe("brand new\n");
      const meta = JSON.parse(readFileSync(join(dest, "carry.json"), "utf-8"));
      expect(meta.branch).toBeTruthy();
      expect(meta.patchBytes).toBe(readFileSync(join(dest, "changes.patch")).length);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("carries a gitignored path listed in hubinclude — and NOT one that isn't", async () => {
    const repo = gitRepo();
    const dest = tempDest();
    try {
      writeFileSync(join(repo, ".gitignore"), "docs/\nsecrets.env\n");
      mkdirSync(join(repo, "docs", "superpowers"), { recursive: true });
      writeFileSync(join(repo, "docs", "superpowers", "spec.md"), "# spec\n");
      writeFileSync(join(repo, "secrets.env"), "TOKEN=shh\n");
      writeHubRules(repo, "hubinclude", "docs/superpowers/\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "ignore"]);

      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      expect(existsSync(join(dest, "untracked", "docs", "superpowers", "spec.md"))).toBe(true);
      expect(existsSync(join(dest, "untracked", "secrets.env"))).toBe(false); // secrets stay put
      if (!r.captured) return;
      // Re-included paths are named in the result: shipping a deliberately
      // gitignored file to a shared directory must be visible, not inferred.
      expect(r.meta.reIncludedCount).toBe(1);
      expect(r.meta.reIncluded).toEqual(["docs/superpowers/spec.md"]);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("captures on a clean tree when hubinclude alone matches files", async () => {
    const repo = gitRepo();
    const dest = tempDest();
    try {
      writeFileSync(join(repo, ".gitignore"), "docs/\n");
      mkdirSync(join(repo, "docs"), { recursive: true });
      writeFileSync(join(repo, "docs", "spec.md"), "# spec\n");
      writeHubRules(repo, "hubinclude", "docs/\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "clean but included"]);
      expect(git(repo, ["status", "--porcelain"])).toBe("");

      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      expect(r.meta.patchBytes).toBe(0);
      expect(r.meta.untrackedCount).toBe(1);
      // Always present, even at zero bytes, so the layout never varies.
      expect(existsSync(join(dest, "changes.patch"))).toBe(true);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("declines with too-large when the payload exceeds the budget", async () => {
    const repo = gitRepo();
    const dest = tempDest();
    try {
      writeFileSync(join(repo, "big.txt"), "x".repeat(CARRY_MAX_BYTES + 1024));
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(false);
      if (!r.captured) {
        expect(r.reason).toBe("too-large");
        expect(r.detail).toMatch(/big\.txt/); // names the offender, per design §6.0
      }
      expect(existsSync(dest)).toBe(false);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("declines with too-large when the patch alone busts the budget", async () => {
    const repo = gitRepo();
    const dest = tempDest();
    try {
      writeFileSync(join(repo, "tracked.txt"), "y".repeat(4096) + "\n");
      const r = await captureCarry(repo, dest, { maxBytes: 512 });
      expect(r.captured).toBe(false);
      if (!r.captured) {
        expect(r.reason).toBe("too-large");
        expect(r.detail).toMatch(/diff/i);
      }
      expect(existsSync(dest)).toBe(false);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("counts files as well as bytes, so a tree of empty files cannot slip the budget", async () => {
    const repo = gitRepo("carrytiny");
    const dest = tempDest();
    try {
      mkdirSync(join(repo, "generated"), { recursive: true });
      for (let i = 0; i < 40; i++) writeFileSync(join(repo, "generated", `f${i}.txt`), "");
      // Zero bytes of content: a byte-only budget measures this payload at 0
      // and lets 40 (or 200,000) files through.
      const r = await captureCarry(repo, dest, { maxBytes: 4096 });
      expect(r.captured).toBe(false);
      if (!r.captured) {
        expect(r.reason).toBe("too-large");
        expect(r.detail).toMatch(/40 file/);
        // The file COUNT is the cause here, and it is stated. What must NOT be
        // stated is a "largest:" list, which degenerates to three arbitrary
        // names measuring nothing (`generated/f1.txt 0 bytes, …`) and reads as
        // if those files were the problem.
        expect(r.detail).not.toContain("largest:");
        expect(r.detail).not.toMatch(/f\d+\.txt/);
      }
    } finally {
      cleanup(repo, dest);
    }
  });

  it("reports write-failed and removes what it wrote when the payload cannot be stored", async () => {
    const repo = gitRepo("carrywrite");
    const dest = tempDest();
    try {
      writeFileSync(join(repo, "new.txt"), "work\n");
      // A directory where carry.json belongs: the copies land, the metadata
      // write then fails, and a payload with no metadata must not survive.
      mkdirSync(join(dest, "carry.json"), { recursive: true });
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(false);
      if (!r.captured) expect(r.reason).toBe("write-failed");
      expect(existsSync(join(dest, "untracked"))).toBe(false);
      expect(existsSync(join(dest, "changes.patch"))).toBe(false);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("declines with not-git outside a repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "sesh-plain-"));
    const dest = tempDest();
    try {
      const r = await captureCarry(plain, dest);
      expect(r.captured).toBe(false);
      if (!r.captured) expect(r.reason).toBe("not-git");
    } finally {
      cleanup(plain, dest);
    }
  });

  it("declines with no-commits — not not-git — in a repo with an unborn HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sesh-unborn-"));
    const dest = tempDest();
    try {
      git(dir, ["init", "-q"]);
      git(dir, ["remote", "add", "origin", "https://example.com/x/y.git"]);
      writeFileSync(join(dir, "a.txt"), "hello\n");
      const r = await captureCarry(dir, dest);
      expect(r.captured).toBe(false);
      // `git rev-parse HEAD` fails identically here and outside a repo, so the
      // obvious implementation reports "not-git" for a real repo that simply
      // has no commit yet — and push stays silent about it.
      if (!r.captured) expect(r.reason).toBe("no-commits");
      // push surfaces `detail` verbatim in a warning, so it must not be git's
      // own words — "fatal: Needed a single revision" is not actionable.
      if (!r.captured) {
        expect(r.detail).toBe("this repository has no commits yet");
        expect(r.detail).not.toMatch(/fatal|revision/i);
      }
    } finally {
      cleanup(dir, dest);
    }
  });
});

describe("captureCarry — patch fidelity", () => {
  it("captures a byte-exact patch that git apply accepts (binary + non-UTF-8 text)", async () => {
    const repo = gitRepo("carrybytes");
    const dest = tempDest();
    let twin = "";
    try {
      writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 255]));
      // Valid file, invalid UTF-8, no NUL — so git treats it as TEXT and puts
      // the raw 0xE9 byte straight into the patch body.
      writeFileSync(join(repo, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "binary + latin1"]);
      twin = cleanTwin(repo);

      const newBin = Buffer.from([0, 1, 2, 3, 254, 9]);
      const newLatin = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0xe9, 0x0a]);
      writeFileSync(join(repo, "bin.dat"), newBin);
      writeFileSync(join(repo, "latin.txt"), newLatin);

      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      const patch = readFileSync(join(dest, "changes.patch"));
      expect(patch.length).toBe(r.meta.patchBytes);
      // A utf-8 decode/encode round trip mangles the 0xE9 byte into U+FFFD and
      // git then refuses the patch outright — so this is the assertion that
      // pins Buffer-based capture.
      expect(Buffer.from(patch.toString("utf-8"), "utf-8").equals(patch)).toBe(false);
      expect(patch.includes(Buffer.from("GIT binary patch"))).toBe(true);

      cpSync(join(dest, "changes.patch"), join(twin, "c.patch"));
      const check = spawnSync("git", ["apply", "--check", "c.patch"], { cwd: twin, encoding: "utf-8" });
      expect(check.status).toBe(0);
      expect(spawnSync("git", ["apply", "c.patch"], { cwd: twin }).status).toBe(0);
      expect(readFileSync(join(twin, "bin.dat")).equals(newBin)).toBe(true);
      expect(readFileSync(join(twin, "latin.txt")).equals(newLatin)).toBe(true);
    } finally {
      cleanup(repo, dest, twin);
    }
  });

  it("produces an appliable patch under a hostile diff configuration", async () => {
    const repo = gitRepo("carryhostilecfg");
    const dest = tempDest();
    let twin = "";
    const stub = join(repo, "fakediff.sh");
    const savedExternal = process.env.GIT_EXTERNAL_DIFF;
    const savedDiffOpts = process.env.GIT_DIFF_OPTS;
    const before = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
    const after = "l1\nl2\nl3\nl4\nlower case edit\nl6\nl7\nl8\nl9\n";
    try {
      writeFileSync(stub, "#!/bin/sh\necho 'I AM NOT A PATCH'\n", { mode: 0o755 });
      // Ways an ordinary developer's own git config rewrites what `git diff`
      // prints. Two of them (external diff, textconv) replace the CONTENT; one
      // (diff.context) makes the result unappliable; the rest garble the
      // headers. Nine lines so `-U3` and `-U0` are distinguishable at all.
      writeFileSync(join(repo, ".gitattributes"), "*.txt diff=upper\n");
      writeFileSync(join(repo, "tracked.txt"), before);
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "attrs"]);
      git(repo, ["config", "diff.upper.textconv", "tr a-z A-Z <"]);
      git(repo, ["config", "color.diff", "always"]);
      git(repo, ["config", "diff.noprefix", "true"]);
      git(repo, ["config", "diff.mnemonicPrefix", "true"]);
      // `git apply --check` REFUSES a zero-context hunk ("while searching
      // for:"), and only --unidiff-zero recovers it — which the apply side
      // must not be forced into.
      git(repo, ["config", "diff.context", "0"]);
      if (process.platform !== "win32") git(repo, ["config", "diff.external", stub]);
      twin = cleanTwin(repo);
      writeFileSync(join(repo, "tracked.txt"), after);
      if (process.platform !== "win32") process.env.GIT_EXTERNAL_DIFF = stub;
      // Documented to take precedence over -U, so no flag can answer it: the
      // fix is removing it from the child's environment.
      process.env.GIT_DIFF_OPTS = "-u0";

      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      const patch = readFileSync(join(dest, "changes.patch"));
      expect(patch.toString("utf-8").startsWith("diff --git a/tracked.txt b/tracked.txt")).toBe(true);
      expect(patch.includes(0x1b)).toBe(false);                       // no ANSI
      expect(patch.toString("utf-8")).toContain("+lower case edit");  // not uppercased by textconv
      // Three context lines each side, not `@@ -5 +5 @@`.
      expect(patch.toString("utf-8")).toContain("@@ -2,7 +2,7 @@");
      cpSync(join(dest, "changes.patch"), join(twin, "c.patch"));
      const check = spawnSync("git", ["apply", "--check", "c.patch"], { cwd: twin, encoding: "utf-8" });
      expect(check.stderr.trim()).toBe("");
      expect(check.status).toBe(0);
      expect(spawnSync("git", ["apply", "c.patch"], { cwd: twin }).status).toBe(0);
      expect(readFileSync(join(twin, "tracked.txt"), "utf-8")).toBe(after);
    } finally {
      if (savedExternal === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = savedExternal;
      if (savedDiffOpts === undefined) delete process.env.GIT_DIFF_OPTS;
      else process.env.GIT_DIFF_OPTS = savedDiffOpts;
      cleanup(repo, dest, twin);
    }
  });

  it("keeps a submodule pointer change in the patch under diff.submodule / diff.ignoreSubmodules", async () => {
    // `diff.submodule = log` is widely recommended and renders the pointer move
    // as prose with NO `diff --git` header: on a mixed patch `git apply --check`
    // passes and the change is silently dropped. `diff.ignoreSubmodules = all`
    // deletes it outright, so a submodule-only change captures as "clean".
    const inner = gitRepo("carrysubinner");
    const repo = gitRepo("carrysubouter");
    const dest = tempDest();
    try {
      writeFileSync(join(inner, "tracked.txt"), "v2\n");
      git(inner, ["add", "-A"]);
      git(inner, ["commit", "-q", "-m", "second"]);
      // Local-path submodules need the protocol allowlist on modern git.
      git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub"]);
      git(repo, ["commit", "-q", "-m", "add submodule"]);
      git(repo, ["config", "diff.submodule", "log"]);
      git(repo, ["config", "diff.ignoreSubmodules", "all"]);
      git(join(repo, "sub"), ["checkout", "-q", "HEAD~1"]);

      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      const patch = readFileSync(join(dest, "changes.patch"), "utf-8");
      expect(patch).toContain("diff --git a/sub b/sub");
      expect(patch).toContain("-Subproject commit");
      expect(patch).not.toContain("Submodule sub "); // the `log` prose form
    } finally {
      cleanup(inner, repo, dest);
    }
  });

  it("ignores an ambient git environment that would defeat its own flags", async () => {
    // Two variables that no flag can answer. GIT_LITERAL_PATHSPECS turns off
    // pathspec magic, so the NEVER floor's `:(exclude,…)` args read as literal
    // filenames and stop excluding anything. GIT_DIR overrides repository
    // discovery outright, so `cwd` stops deciding which repo is diffed. Both
    // arrive for free in anything launched from a git hook or `rebase --exec`.
    const repo = gitRepo("carryenvA");
    const other = gitRepo("carryenvB");
    const dest = tempDest();
    const saved = {
      lit: process.env.GIT_LITERAL_PATHSPECS,
      dir: process.env.GIT_DIR,
      idx: process.env.GIT_INDEX_FILE,
    };
    try {
      mkdirSync(join(repo, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(repo, ".claude-sesh-mover", "config.json"), '{"hub":{"path":"/orig"}}\n');
      git(repo, ["add", "-A", "-f"]);
      git(repo, ["commit", "-q", "-m", "track plugin state"]);
      writeFileSync(join(repo, ".claude-sesh-mover", "config.json"), '{"hub":{"path":"/EVIL"}}\n');
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      const ownHead = git(repo, ["rev-parse", "HEAD"]).trim();

      // Phase 1 — pathspec magic off. The floor's `:(exclude,…)` arguments read
      // as literal filenames, matching nothing, so the exclusion silently stops
      // working. Nothing in the argv can detect that.
      process.env.GIT_LITERAL_PATHSPECS = "1";
      const r1 = await captureCarry(repo, dest);
      expect(r1.captured).toBe(true);
      if (!r1.captured) return;
      const patch1 = readFileSync(join(dest, "changes.patch"), "utf-8");
      expect(patch1).toContain("diff --git a/tracked.txt b/tracked.txt");
      expect(patch1).not.toContain(".claude-sesh-mover");
      expect(patch1).not.toContain("EVIL");
      delete process.env.GIT_LITERAL_PATHSPECS;
      rmSync(dest, { recursive: true, force: true });

      // Phase 2 — repository redirection. With GIT_DIR set and no
      // GIT_WORK_TREE, git reads ANOTHER repository's history while still
      // walking this project's files, so the patch looks plausible and the
      // recorded base commit is the giveaway: a carry taken against a commit
      // the peer's repo has never heard of cannot apply anywhere.
      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_INDEX_FILE = join(other, ".git", "index");
      const r2 = await captureCarry(repo, dest);
      expect(r2.captured).toBe(true);
      if (!r2.captured) return;
      expect(r2.meta.baseCommit).toBe(ownHead);
      expect(r2.meta.baseCommit).not.toBe(git(other, ["rev-parse", "HEAD"]).trim());
    } finally {
      for (const [k, v] of [
        ["GIT_LITERAL_PATHSPECS", saved.lit], ["GIT_DIR", saved.dir], ["GIT_INDEX_FILE", saved.idx],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      cleanup(repo, other, dest);
    }
  });

  it("carries filenames with spaces and non-ASCII characters", async () => {
    const repo = gitRepo("carrynames");
    const dest = tempDest();
    try {
      writeFileSync(join(repo, " leading.txt"), "a\n");
      writeFileSync(join(repo, "café.txt"), "b\n");
      writeFileSync(join(repo, "trailing .txt"), "c\n");
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      // Without `-z` git C-quotes and octal-escapes these, and the quoted
      // spelling never lstats — so they vanish from the payload silently.
      expect(r.meta.untrackedCount).toBe(3);
      expect(listFiles(join(dest, "untracked"))).toEqual(
        [" leading.txt", "café.txt", "trailing .txt"].sort()
      );
    } finally {
      cleanup(repo, dest);
    }
  });

  it("scopes the patch to the project subdirectory of a larger repo", async () => {
    const repo = gitRepo("carrymono");
    const dest = tempDest();
    try {
      mkdirSync(join(repo, "packages", "app"), { recursive: true });
      mkdirSync(join(repo, "packages", "other"), { recursive: true });
      writeFileSync(join(repo, "packages", "app", "a.txt"), "a1\n");
      writeFileSync(join(repo, "packages", "other", "o.txt"), "o1\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "mono"]);
      writeFileSync(join(repo, "packages", "app", "a.txt"), "a2\n");
      writeFileSync(join(repo, "packages", "other", "o.txt"), "o2\n");
      writeFileSync(join(repo, "packages", "app", "new.txt"), "new\n");
      writeFileSync(join(repo, "packages", "other", "newo.txt"), "newo\n");

      const r = await captureCarry(join(repo, "packages", "app"), dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      expect(r.meta.repoPrefix).toBe("packages/app/");
      const patch = readFileSync(join(dest, "changes.patch"), "utf-8");
      // Project-relative, and the sibling package is out of scope entirely —
      // otherwise the patch and the untracked list (which git already scopes to
      // the cwd) describe two different trees and neither applies.
      expect(patch).toContain("a/a.txt");
      expect(patch).not.toContain("packages/");
      expect(listFiles(join(dest, "untracked"))).toEqual(["new.txt"]);
    } finally {
      cleanup(repo, dest);
    }
  });
});

describe("captureCarry — what must never travel", () => {
  it("never carries plugin state, even when it is untracked and not ignored", async () => {
    const repo = gitRepo("carryplugin");
    const dest = tempDest();
    try {
      mkdirSync(join(repo, ".claude-sesh-mover"), { recursive: true });
      // The project-scope config can redirect hub.path, and hubinclude decides
      // what the NEXT push ships: a payload able to plant either is the
      // exfiltration primitive Task 9 closed on the workspace path.
      writeFileSync(join(repo, ".claude-sesh-mover", "config.json"), '{"hub":{"path":"/tmp/evil"}}\n');
      writeFileSync(join(repo, ".claude-sesh-mover", "hubinclude"), "*\n");
      writeFileSync(join(repo, "real.txt"), "work\n");
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      expect(listFiles(join(dest, "untracked"))).toEqual(["real.txt"]);
      expect(r.meta.untrackedCount).toBe(1);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("never carries plugin state in the PATCH either, when git tracks it", async () => {
    // The untracked filter never sees a tracked file, and `git diff HEAD`
    // describes every tracked file that changed. Committing
    // `.claude-sesh-mover/` is what this project's own docs recommend (it is
    // where `hubinclude` and `project.json` live), so the leak is the ordinary
    // shape rather than an exotic one — and Task 11's `git apply` will write
    // whatever the patch names.
    const repo = gitRepo("carryplugintracked");
    const dest = tempDest();
    try {
      mkdirSync(join(repo, ".claude-sesh-mover", "nested"), { recursive: true });
      writeFileSync(join(repo, ".claude-sesh-mover", "config.json"), '{"hub":{"path":"/orig"}}\n');
      writeFileSync(join(repo, ".claude-sesh-mover", "hubinclude"), "docs/\n");
      // A nested one too: the floor is a per-segment rule at ANY depth, so the
      // pathspec that mirrors it has to be depth-independent as well.
      mkdirSync(join(repo, "pkg", ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(repo, "pkg", ".claude-sesh-mover", "config.json"), "{}\n");
      git(repo, ["add", "-A", "-f"]);
      git(repo, ["commit", "-q", "-m", "track plugin state"]);
      writeFileSync(join(repo, ".claude-sesh-mover", "config.json"), '{"hub":{"path":"/EVIL"}}\n');
      writeFileSync(join(repo, ".claude-sesh-mover", "hubinclude"), "*\n");
      writeFileSync(join(repo, "pkg", ".claude-sesh-mover", "config.json"), '{"x":"EVIL"}\n');
      writeFileSync(join(repo, "tracked.txt"), "real work\n");

      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      const patch = readFileSync(join(dest, "changes.patch"), "utf-8");
      expect(patch).toContain("diff --git a/tracked.txt b/tracked.txt");
      expect(patch).not.toContain(".claude-sesh-mover");
      expect(patch).not.toContain("EVIL");
    } finally {
      cleanup(repo, dest);
    }
  });

  it("reports gitignored files that git TRACKS, whose changes the patch carries anyway", async () => {
    // The disclosure the guarantee's wording used to hide: `.gitignore`,
    // `hubignore` and the built-in excludes all filter the UNTRACKED
    // enumeration only. A `.env` committed once and gitignored later (without
    // `git rm --cached`) travels in full, and `reIncludedCount` stays 0 because
    // `hubinclude` had nothing to do with it.
    const repo = gitRepo("carrytrackedignored");
    const dest = tempDest();
    try {
      writeFileSync(join(repo, ".env"), "DB_PASSWORD=old\n");
      mkdirSync(join(repo, "secrets"), { recursive: true });
      writeFileSync(join(repo, "secrets", "creds.txt"), "creds=v1\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "before the gitignore"]);
      writeFileSync(join(repo, ".gitignore"), ".env\nsecrets/\n");
      writeHubRules(repo, "hubignore", "secrets");
      git(repo, ["add", ".gitignore"]);
      git(repo, ["commit", "-q", "-m", "ignore them, but they stay tracked"]);
      writeFileSync(join(repo, ".env"), "DB_PASSWORD=hunter2_NEW\n");
      writeFileSync(join(repo, "secrets", "creds.txt"), "creds=v2\n");
      writeFileSync(join(repo, "secrets", "other.txt"), "untracked\n"); // dropped by hubignore

      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      const patch = readFileSync(join(dest, "changes.patch"), "utf-8");
      expect(patch).toContain("+DB_PASSWORD=hunter2_NEW");     // it really does travel
      expect(patch).toContain("+creds=v2");                    // hubignore does not stop it
      expect(existsSync(join(dest, "untracked"))).toBe(false); // …but it does stop the untracked one
      expect(r.meta.untrackedCount).toBe(0);
      // Named as its own set, with its own remedy — NOT folded into reIncluded,
      // where "remove the hubinclude line" would be advice that does nothing.
      expect(r.meta.trackedIgnored).toEqual([".env", "secrets/creds.txt"]);
      expect(r.meta.trackedIgnoredCount).toBe(2);
      expect(r.meta.reIncludedCount).toBe(0);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("never follows a symlink out of the project", async () => {
    const repo = gitRepo("carrylink");
    const dest = tempDest();
    const outside = mkdtempSync(join(tmpdir(), "sesh-outside-"));
    try {
      writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY\n");
      symlinkSync(join(outside, "id_rsa"), join(repo, "key-link"));
      symlinkSync(outside, join(repo, "dir-link"));
      writeFileSync(join(repo, "real.txt"), "work\n");
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      // git ls-files lists both links; statSync would follow them and copy the
      // TARGET's bytes into the bundle.
      expect(listFiles(join(dest, "untracked"))).toEqual(["real.txt"]);
      expect(r.meta.untrackedCount).toBe(1);
    } finally {
      cleanup(repo, dest, outside);
    }
  });

  it("refuses hostile paths from git's own output and writes nothing outside destDir", async () => {
    if (process.platform === "win32") return; // shell-script stub
    const repo = gitRepo("carryhostile");
    const destRoot = mkdtempSync(join(tmpdir(), "sesh-destroot-"));
    const stubDir = mkdtempSync(join(tmpdir(), "sesh-stubgit-"));
    const dest = join(destRoot, "a", "b", "carry");
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "ok.txt"), "fine\n");
    // Real files at every escape target, so a missing lstat is not what saves us.
    writeFileSync(join(destRoot, "escape.txt"), "ESCAPED\n");
    const restore = overridePath(stubDir);
    try {
      writeFileSync(
        join(stubDir, "git"),
        `#!/bin/sh
case "$1 $2" in
  "rev-parse --verify") printf '%s\\n' '${head}' ;;
  "rev-parse --absolute-git-dir") printf '%s\\n\\n' '${repo}/.git' ;;
  "symbolic-ref --short") printf 'main\\n' ;;
  "diff HEAD") : ;;
  "ls-files --others")
     printf '../escape.txt\\0../../escape.txt\\0/etc/hosts\\0.git/config\\0.claude-sesh-mover/config.json\\0ok.txt\\0' ;;
  *) : ;;
esac
exit 0
`,
        { mode: 0o755 }
      );
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      expect(r.meta.untrackedCount).toBe(1);
      expect(listFiles(destRoot).sort()).toEqual([
        "a/b/carry/carry.json",
        "a/b/carry/changes.patch",
        "a/b/carry/untracked/ok.txt",
        "escape.txt",
      ]);
      expect(readFileSync(join(destRoot, "escape.txt"), "utf-8")).toBe("ESCAPED\n");
    } finally {
      restore.restore();
      cleanup(repo, destRoot, stubDir);
    }
  });

  it("drops an untracked nested repository instead of counting a directory as a file", async () => {
    const repo = gitRepo("carrynested");
    const dest = tempDest();
    try {
      mkdirSync(join(repo, "vendor", "lib"), { recursive: true });
      git(join(repo, "vendor", "lib"), ["init", "-q"]);
      writeFileSync(join(repo, "vendor", "lib", "f.txt"), "x\n");
      writeFileSync(join(repo, "real.txt"), "work\n");
      // git spells this one "vendor/lib/" — an entry with a trailing slash, the
      // only directory shape `ls-files --others` emits.
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      expect(r.meta.untrackedCount).toBe(1);
      expect(listFiles(join(dest, "untracked"))).toEqual(["real.txt"]);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("honors hubignore on the untracked set, and hubinclude names a path back", async () => {
    const repo = gitRepo("carryrules");
    const dest = tempDest();
    try {
      writeHubRules(repo, "hubignore", "build\n");
      mkdirSync(join(repo, "build"), { recursive: true });
      writeFileSync(join(repo, "build", "out.js"), "junk\n");
      writeFileSync(join(repo, "build", "keep.txt"), "keep\n");
      writeFileSync(join(repo, "real.txt"), "work\n");
      const first = await captureCarry(repo, dest);
      expect(first.captured).toBe(true);
      expect(listFiles(join(dest, "untracked"))).toEqual(["real.txt"]);

      rmSync(dest, { recursive: true, force: true });
      writeHubRules(repo, "hubinclude", "build/keep.txt\n");
      const second = await captureCarry(repo, dest);
      expect(second.captured).toBe(true);
      expect(listFiles(join(dest, "untracked"))).toEqual(["build/keep.txt", "real.txt"]);
      if (!second.captured) return;
      // hubinclude beating hubignore is not a gitignore re-inclusion, so it is
      // not reported as one.
      expect(second.meta.reIncludedCount).toBe(0);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("drops a built-in-excluded untracked directory unless hubinclude names it", async () => {
    const repo = gitRepo("carrydefaults");
    const dest = tempDest();
    try {
      mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "dep\n");
      writeFileSync(join(repo, "real.txt"), "work\n");
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      expect(listFiles(join(dest, "untracked"))).toEqual(["real.txt"]);
    } finally {
      cleanup(repo, dest);
    }
  });
});

describe("captureCarry — git state", () => {
  it("records a detached HEAD as detached", async () => {
    const repo = gitRepo("carrydetached");
    const dest = tempDest();
    try {
      writeFileSync(join(repo, "second.txt"), "two\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "second"]);
      git(repo, ["checkout", "-q", "HEAD~1"]);
      writeFileSync(join(repo, "tracked.txt"), "detached edit\n");
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      expect(r.meta.detached).toBe(true);
      expect(r.meta.branch).toBe("HEAD");
    } finally {
      cleanup(repo, dest);
    }
  });

  it("records an in-progress merge so the apply side is not handed conflict markers blind", async () => {
    const repo = gitRepo("carrymerge");
    const dest = tempDest();
    try {
      writeFileSync(join(repo, "c.txt"), "base\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "base"]);
      git(repo, ["checkout", "-q", "-b", "other"]);
      writeFileSync(join(repo, "c.txt"), "other\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "other"]);
      git(repo, ["checkout", "-q", "-"]);
      writeFileSync(join(repo, "c.txt"), "mine\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "mine"]);
      expect(spawnSync("git", ["merge", "other"], { cwd: repo }).status).toBe(1);

      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      expect(r.meta.inProgress).toBe("merge");
      expect(readFileSync(join(dest, "changes.patch"), "utf-8")).toContain("<<<<<<<");
    } finally {
      cleanup(repo, dest);
    }
  });

  it("reports git-failed, and leaves no partial payload, when git cannot be run", async () => {
    if (process.platform === "win32") return; // shell-script stub
    const repo = gitRepo("carrygitfail");
    const dest = tempDest();
    const stubDir = mkdtempSync(join(tmpdir(), "sesh-stubgit-"));
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "new.txt"), "x\n");
    const restore = overridePath(stubDir);
    try {
      // HEAD resolves, then the diff blows up: the shape that must NOT be
      // reported as "not-git", and must not leave a half-written carry dir.
      writeFileSync(
        join(stubDir, "git"),
        `#!/bin/sh
case "$1 $2" in
  "rev-parse --verify") printf '%s\\n' '${head}'; exit 0 ;;
  "rev-parse --absolute-git-dir") printf '%s\\n\\n' '${repo}/.git'; exit 0 ;;
  "symbolic-ref --short") printf 'main\\n'; exit 0 ;;
  "diff HEAD") echo 'fatal: exploded' >&2; exit 128 ;;
esac
exit 0
`,
        { mode: 0o755 }
      );
      const r = await captureCarry(repo, dest);
      expect(r.captured).toBe(false);
      if (!r.captured) {
        expect(r.reason).toBe("git-failed");
        expect(r.detail).toMatch(/exploded/);
      }
      expect(existsSync(dest)).toBe(false);
    } finally {
      restore.restore();
      cleanup(repo, dest, stubDir);
    }
  });

  it("skips an unreadable untracked file with a diagnostic instead of failing the push", async () => {
    const repo = gitRepo("carryeacces");
    const dest = tempDest();
    const probe = join(repo, "probe.tmp");
    writeFileSync(probe, "x\n");
    chmodSync(probe, 0o000);
    let enforced = false;
    try {
      readFileSync(probe);
    } catch {
      enforced = true;
    }
    chmodSync(probe, 0o644);
    rmSync(probe);
    if (!enforced) return cleanup(repo, dest); // running as root: mode says nothing
    try {
      writeFileSync(join(repo, "readable.txt"), "fine\n");
      writeFileSync(join(repo, "locked.txt"), "nope\n");
      chmodSync(join(repo, "locked.txt"), 0o000);
      const diagnostics: string[] = [];
      const r = await captureCarry(repo, dest, { diagnostics });
      chmodSync(join(repo, "locked.txt"), 0o644);
      expect(r.captured).toBe(true);
      if (!r.captured) return;
      expect(r.meta.untrackedCount).toBe(1);
      expect(listFiles(join(dest, "untracked"))).toEqual(["readable.txt"]);
      expect(diagnostics.join(" ")).toMatch(/locked\.txt/);
    } finally {
      cleanup(repo, dest);
    }
  });

  it("surfaces an over-cap hubinclude as a diagnostic on the git path too", async () => {
    const repo = gitRepo("carrydiag");
    const dest = tempDest();
    try {
      writeHubRules(repo, "hubinclude", "x".repeat(70 * 1024));
      writeFileSync(join(repo, "new.txt"), "x\n");
      const diagnostics: string[] = [];
      const r = await captureCarry(repo, dest, { diagnostics });
      expect(r.captured).toBe(true);
      // Without threading these through, a git project's over-cap hubinclude
      // fails closed in total silence — snapshotWorkspace, which reports them,
      // never runs for a project with remotes.
      expect(diagnostics.join(" ")).toMatch(/hubinclude/);
    } finally {
      cleanup(repo, dest);
    }
  });
});

/**
 * Capture a carry out of `repo` (or a subdirectory of it) and hand back the
 * payload directory plus its metadata — the exact pair `applyCarry` receives
 * from a pulled bundle.
 */
async function capturePayload(
  projectPath: string
): Promise<{ dir: string; meta: CarryMeta }> {
  const dir = tempDest();
  const r = await captureCarry(projectPath, dir);
  if (!r.captured) throw new Error(`capture declined: ${r.reason} ${r.detail ?? ""}`);
  return { dir, meta: r.meta };
}

/** Hand-build a carry payload — the untrusted shape a peer's bundle really is. */
function handPayload(patch: string, meta: Partial<CarryMeta> & { baseCommit: string }): {
  dir: string;
  meta: CarryMeta;
} {
  const dir = tempDest();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "changes.patch"), patch);
  const full: CarryMeta = {
    baseCommit: meta.baseCommit,
    branch: meta.branch ?? "main",
    detached: false,
    inProgress: null,
    capturedAt: new Date().toISOString(),
    untrackedCount: 0,
    untrackedBytes: 0,
    patchBytes: Buffer.byteLength(patch),
    reIncludedCount: 0,
    reIncluded: [],
    trackedIgnoredCount: 0,
    trackedIgnored: [],
    repoPrefix: "",
    ...meta,
  };
  writeFileSync(join(dir, "carry.json"), JSON.stringify(full, null, 2));
  return { dir, meta: full };
}

/** Every `.claude-sesh-mover/carry-*` directory in a project, newest last. */
function savedDirs(project: string): string[] {
  const root = join(project, ".claude-sesh-mover");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => n.startsWith("carry-")).sort();
}

describe("applyCarry", () => {
  it("applies patch + untracked files on a matching clean tree", async () => {
    const repo = gitRepo("apply-ok");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      writeFileSync(join(repo, "new.txt"), "brand new\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      expect(readFileSync(join(twin, "tracked.txt"), "utf-8")).toBe("v1\n");

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      if (!r.applied) return;
      expect(readFileSync(join(twin, "tracked.txt"), "utf-8")).toBe("v2\n");
      expect(readFileSync(join(twin, "new.txt"), "utf-8")).toBe("brand new\n");
      expect(r.filesChanged).toBe(1);
      expect(r.untrackedCopied).toBe(1);
      expect(r.collisions).toEqual([]);
      // Nothing was saved aside: the payload landed where it belongs.
      expect(savedDirs(twin)).toEqual([]);
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("refuses on a dirty tree and saves the patch instead", async () => {
    const repo = gitRepo("apply-dirty");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      writeFileSync(join(twin, "tracked.txt"), "MY OWN WORK\n");

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("dirty-tree");
      // The user's own uncommitted work is exactly as it was.
      expect(readFileSync(join(twin, "tracked.txt"), "utf-8")).toBe("MY OWN WORK\n");
      expect(r.savedTo).toBeTruthy();
      expect(existsSync(join(r.savedTo!, "changes.patch"))).toBe(true);
      expect(existsSync(join(r.savedTo!, "README.md"))).toBe(true);
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("refuses on a different base commit and saves the patch", async () => {
    const repo = gitRepo("apply-base");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      writeFileSync(join(twin, "later.txt"), "moved on\n");
      git(twin, ["add", "-A"]);
      git(twin, ["commit", "-q", "-m", "later"]);

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("wrong-base");
      expect(r.detail).toContain(payload.meta.baseCommit.slice(0, 8));
      expect(readFileSync(join(twin, "tracked.txt"), "utf-8")).toBe("v1\n");
      expect(existsSync(join(r.savedTo!, "changes.patch"))).toBe(true);
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("never overwrites an existing untracked file — writes .incoming-<ts> instead", async () => {
    const repo = gitRepo("apply-collide");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "new.txt"), "theirs\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      writeFileSync(join(twin, "new.txt"), "MINE\n");

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      if (!r.applied) return;
      expect(readFileSync(join(twin, "new.txt"), "utf-8")).toBe("MINE\n");
      const sidecar = readdirSync(twin).find((n) => n.startsWith("new.txt.incoming-"));
      expect(sidecar).toBeTruthy();
      expect(readFileSync(join(twin, sidecar!), "utf-8")).toBe("theirs\n");
      expect(r.collisions).toEqual(["new.txt"]);
      expect(r.untrackedCopied).toBe(0);
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("treats an identical incoming untracked file as a no-op, not a collision", async () => {
    const repo = gitRepo("apply-same");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "new.txt"), "same bytes\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      writeFileSync(join(twin, "new.txt"), "same bytes\n");

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      if (!r.applied) return;
      expect(r.collisions).toEqual([]);
      expect(readdirSync(twin).some((n) => n.includes(".incoming-"))).toBe(false);
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  // --- The three Task 10 carry-forwards ---

  it("refuses a patch that names .claude-sesh-mover, including the trailing-dot spelling", async () => {
    // Task 10's FLOOR_PATHSPEC closes the capture side, but its `icase` mirrors
    // only the CASE half of isNeverSegment: `.claude-sesh-mover./config.json`
    // rides the patch, and `git apply` writes it (measured). A payload able to
    // write that directory rewrites the list deciding what the NEXT push ships.
    const repo = gitRepo("apply-floor");
    let twin: string | undefined;
    try {
      twin = cleanTwin(repo);
      const head = git(twin, ["rev-parse", "HEAD"]).trim();
      for (const path of [".claude-sesh-mover/config.json", ".claude-sesh-mover./config.json"]) {
        const patch =
          `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..d95f3ad\n` +
          `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+{"hub":{"path":"/tmp/attacker"}}\n`;
        const payload = handPayload(patch, { baseCommit: head });
        const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
        expect(r.applied).toBe(false);
        if (r.applied) return;
        expect(r.reason).toBe("unsafe-payload");
        expect(existsSync(join(twin, path))).toBe(false);
        rmSync(payload.dir, { recursive: true, force: true });
      }
    } finally {
      cleanup(repo, twin ?? "");
    }
  });

  it("refuses a patch containing a symlink entry rather than materialising it", async () => {
    if (process.platform === "win32") return; // symlink creation needs privileges
    const repo = gitRepo("apply-symlink");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      // A STAGED symlink enters `git diff HEAD` as `new file mode 120000` with
      // its target as content, and `git apply` materialises it (measured).
      symlinkSync("/etc/hosts", join(repo, "evil"));
      git(repo, ["add", "evil"]);
      payload = await capturePayload(repo);
      expect(readFileSync(join(payload.dir, "changes.patch"), "utf-8")).toContain("120000");
      twin = cleanTwin(repo);

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("unsafe-payload");
      expect(r.detail).toMatch(/symbolic link/i);
      expect(existsSync(join(twin, "evil"))).toBe(false);
      expect(existsSync(join(r.savedTo!, "changes.patch"))).toBe(true);
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("refuses a patch that re-points an existing tracked symlink", async () => {
    if (process.platform === "win32") return;
    const repo = gitRepo("apply-relink");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      symlinkSync("/etc/hosts", join(repo, "l"));
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "link"]);
      rmSync(join(repo, "l"));
      symlinkSync("/etc/passwd", join(repo, "l"));
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);

      // `git apply --summary` prints NOTHING for this shape (measured), so a
      // summary-based guard would miss it and the link would be re-pointed.
      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("unsafe-payload");
      expect(readFileSync(join(twin, "l"), "utf-8")).toBeTruthy();
      expect(execFileSync("readlink", [join(twin, "l")], { encoding: "utf-8" }).trim())
        .toBe("/etc/hosts");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("refuses a BINARY patch entry naming plugin internals, which the raw scan cannot see", async () => {
    // A binary entry carries no `---`/`+++` lines at all — `diff --git`, an
    // `index` line and a `GIT binary patch` blob — so the byte scan finds no
    // path in it and only git's own `--numstat` parse does. The mirror image of
    // the rename case below, and the reason both sources are consulted.
    const repo = gitRepo("apply-binfloor");
    let twin: string | undefined;
    try {
      twin = cleanTwin(repo);
      mkdirSync(join(repo, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(repo, ".claude-sesh-mover", "x.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
      git(repo, ["add", "-A"]);
      const patch = git(repo, ["diff", "HEAD", "--binary", "--src-prefix=a/", "--dst-prefix=b/"]);
      expect(patch).toContain("GIT binary patch");
      expect(patch).not.toContain("+++ b/");
      const head = git(twin, ["rev-parse", "HEAD"]).trim();
      const payload = handPayload(patch, { baseCommit: head });

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("unsafe-payload");
      expect(existsSync(join(twin, ".claude-sesh-mover", "x.bin"))).toBe(false);
      rmSync(payload.dir, { recursive: true, force: true });
    } finally {
      cleanup(repo, twin ?? "");
    }
  });

  it("refuses a patch that renames a plugin-internal file AWAY, which numstat cannot see", async () => {
    // `git apply --numstat -z` prints only the DESTINATION of a rename
    // (measured), so a patch spelled `rename from .claude-sesh-mover/hubinclude
    // / rename to moved.txt` reads as a perfectly ordinary write to
    // `moved.txt` — and it applies cleanly, deleting the file that decides what
    // this machine's NEXT push uploads. Only the raw scan of the patch's own
    // `rename from` line catches it.
    const repo = gitRepo("apply-renameaway");
    let twin: string | undefined;
    try {
      mkdirSync(join(repo, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(repo, ".claude-sesh-mover", "hubinclude"), "docs/\n");
      writeFileSync(join(repo, ".claude-sesh-mover", "café"), "CAFE\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "plugin state committed"]);
      twin = cleanTwin(repo);
      const head = git(twin, ["rev-parse", "HEAD"]).trim();

      for (const from of [".claude-sesh-mover/hubinclude", '".claude-sesh-mover/caf\\303\\251"']) {
        const patch =
          `diff --git a/x b/moved.txt\nsimilarity index 100%\nrename from ${from}\nrename to moved.txt\n`;
        const payload = handPayload(patch, { baseCommit: head });
        const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
        expect(r.applied).toBe(false);
        if (r.applied) return;
        expect(r.reason).toBe("unsafe-payload");
        rmSync(payload.dir, { recursive: true, force: true });
      }
      // Both files are still where they were: the second spelling is git's own
      // C-quoted form, which reads as a segment starting with `"` unless it is
      // decoded first.
      expect(readFileSync(join(twin, ".claude-sesh-mover", "hubinclude"), "utf-8")).toBe("docs/\n");
      expect(existsSync(join(twin, ".claude-sesh-mover", "café"))).toBe(true);
      expect(existsSync(join(twin, "moved.txt"))).toBe(false);
    } finally {
      cleanup(repo, twin ?? "");
    }
  });

  it("falls back to the user-scope directory when the project cannot hold the saved payload", async () => {
    if (process.platform === "win32") return; // symlink creation needs privileges
    const repo = gitRepo("apply-savefallback");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    let home: string | undefined;
    let elsewhere: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      // A symlink where the plugin directory belongs: writing through it would
      // put a peer's payload outside the project entirely.
      elsewhere = mkdtempSync(join(tmpdir(), "sesh-elsewhere-"));
      symlinkSync(elsewhere, join(twin, ".claude-sesh-mover"));
      writeFileSync(join(twin, "tracked.txt"), "MY OWN WORK\n"); // force a decline
      home = mkdtempSync(join(tmpdir(), "sesh-home-"));
      const restore = overrideHome(home);
      try {
        const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
        expect(r.applied).toBe(false);
        if (r.applied) return;
        expect(r.savedTo).toBeTruthy();
        expect(r.savedTo!.startsWith(join(home, ".claude-sesh-mover"))).toBe(true);
        expect(existsSync(join(r.savedTo!, "changes.patch"))).toBe(true);
      } finally {
        restore.restore();
      }
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "", home ?? "", elsewhere ?? "");
    }
  });

  it("applies an untracked-only payload instead of choking on the empty patch", async () => {
    // `git apply` REFUSES an empty patch (exit 128) and `changes.patch` is
    // always written, even at zero bytes — so its presence proves nothing.
    const repo = gitRepo("apply-empty");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "only-new.txt"), "fresh\n");
      payload = await capturePayload(repo);
      expect(payload.meta.patchBytes).toBe(0);
      twin = cleanTwin(repo);

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      if (!r.applied) return;
      expect(r.filesChanged).toBe(0);
      expect(r.untrackedCopied).toBe(1);
      expect(readFileSync(join(twin, "only-new.txt"), "utf-8")).toBe("fresh\n");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  // --- Guards the brief does not have ---

  it("does not read an untracked local file as a dirty tree", async () => {
    // pull.ts's identity linking writes .claude-sesh-mover/project.json into
    // the project EARLIER IN THE SAME PULL, and `git status --porcelain`
    // reports it as `?? .claude-sesh-mover/`. Counting untracked files as dirt
    // would refuse every hub-linked git project that has not committed the
    // plugin directory — i.e. the ordinary case, permanently.
    const repo = gitRepo("apply-untracked-dirt");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      mkdirSync(join(twin, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(twin, ".claude-sesh-mover", "project.json"), "{}\n");
      writeFileSync(join(twin, "scratch-of-mine.txt"), "mine\n");
      expect(git(twin, ["status", "--porcelain"])).not.toBe("");

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      expect(readFileSync(join(twin, "tracked.txt"), "utf-8")).toBe("v2\n");
      expect(readFileSync(join(twin, "scratch-of-mine.txt"), "utf-8")).toBe("mine\n");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("refuses while the target is mid-rebase, where the tree still reads clean", async () => {
    const repo = gitRepo("apply-rebase");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      writeFileSync(join(twin, "second.txt"), "s\n");
      git(twin, ["add", "-A"]);
      git(twin, ["commit", "-q", "-m", "second"]);
      // A failing `--exec` stops the rebase with a CLEAN working tree — status
      // is empty, so the dirty-tree guard cannot see it. `exit 1` rather than
      // `false`: git runs the command through a shell on every platform, and a
      // builtin cannot go missing the way a `false` binary can on Windows.
      spawnSync("git", ["rebase", "-q", "--exec", "exit 1", "HEAD~1"], { cwd: twin, stdio: "ignore" });
      expect(existsSync(join(twin, ".git", "rebase-merge"))).toBe(true);
      expect(git(twin, ["status", "--porcelain", "-uno"])).toBe("");
      // Reset HEAD back onto the carry's base so `wrong-base` cannot be what
      // answers here: the in-progress guard has to be the thing that fires.
      const head = git(twin, ["rev-parse", "HEAD"]).trim();
      const meta = { ...payload.meta, baseCommit: head };

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("in-progress");
      expect(r.detail).toMatch(/rebase/);
      expect(existsSync(join(r.savedTo!, "changes.patch"))).toBe(true);
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("applies at the project path when the project is a repository SUBDIRECTORY", async () => {
    // Inside a repository `git apply` resolves patch paths against the REPO
    // ROOT and silently ignores anything outside the cwd — exit 0, no stderr,
    // nothing written. A subtree-scoped `--relative` patch applied at a
    // subdirectory project is therefore a silent no-op unless --directory says
    // where it belongs, and `--check` passes just as quietly (all measured).
    const repo = gitRepo("apply-subdir");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      mkdirSync(join(repo, "pkg", "app"), { recursive: true });
      writeFileSync(join(repo, "pkg", "app", "f.txt"), "v1\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "sub"]);
      writeFileSync(join(repo, "pkg", "app", "f.txt"), "v2\n");
      writeFileSync(join(repo, "pkg", "app", "fresh.txt"), "new\n");
      payload = await capturePayload(join(repo, "pkg", "app"));
      expect(payload.meta.repoPrefix).toBe("pkg/app/");
      twin = cleanTwin(repo);
      // Dirt OUTSIDE the project subtree must not block it: the patch is scoped
      // to this package and cannot reach the rest of the monorepo, so requiring
      // the whole repository to be clean would make the feature unusable there.
      writeFileSync(join(twin, "tracked.txt"), "someone else's package\n");

      const r = await applyCarry({
        carryDir: payload.dir, targetPath: join(twin, "pkg", "app"), meta: payload.meta,
      });
      expect(r.applied).toBe(true);
      expect(readFileSync(join(twin, "pkg", "app", "f.txt"), "utf-8")).toBe("v2\n");
      expect(readFileSync(join(twin, "pkg", "app", "fresh.txt"), "utf-8")).toBe("new\n");
      // `filesChanged` is git's own count, from a `--numstat` that has to carry
      // the SAME --directory as the apply. Without it the number reported to
      // the user was 0 for every patch a subdirectory project applied.
      if (!r.applied) return;
      expect(r.filesChanged).toBe(1);
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  // --- The layout axis CROSSED with the hostile-payload axis ---
  //
  // Both axes were already covered, and neither crossed the other: the
  // hostile-payload tests all ran at repo-root layout, and the subdirectory
  // test ran a benign payload. The floor's `--numstat` source is exactly what
  // falls through that gap — `git apply --numstat` resolves paths against the
  // REPOSITORY ROOT and silently ignores everything outside the cwd, so at a
  // subdirectory project it reported no entries at all and the check passed
  // vacuously. Measured against the pre-fix build, all three payloads below
  // were REFUSED at repo root and APPLIED at a subdirectory project.

  /** A repo whose PROJECT is the subdirectory `pkg/app`, with a plugin dir in it. */
  function subdirRepo(name: string, seedHubinclude: boolean): {
    repo: string; project: string; head: string;
  } {
    const repo = gitRepo(name);
    const project = join(repo, "pkg", "app");
    mkdirSync(join(project, ".claude-sesh-mover"), { recursive: true });
    if (seedHubinclude) {
      writeFileSync(join(project, ".claude-sesh-mover", "hubinclude"), "docs/\n");
    }
    writeFileSync(join(project, "f.txt"), "v1\n");
    git(repo, ["add", "-A", "-f"]);
    git(repo, ["commit", "-q", "-m", "sub"]);
    return { repo, project, head: git(repo, ["rev-parse", "HEAD"]).trim() };
  }

  it("refuses a BINARY patch naming plugin internals at SUBDIRECTORY layout too", async () => {
    // The raw scan is blind to binary entries (no `---`/`+++` lines at all), so
    // `--numstat` is the ONLY source that sees this one — and it saw nothing
    // here until it carried the same --directory as the apply.
    const { repo, project, head } = subdirRepo("apply-subdir-bin", false);
    let dir: string | undefined;
    try {
      writeFileSync(
        join(project, ".claude-sesh-mover", "hubinclude"),
        Buffer.from([0, 1, 2, 3, 0, 255])
      );
      git(repo, ["add", "-A", "-f"]);
      // `--relative` is what the capture side uses, so the paths in the patch
      // are PROJECT-relative — the shape whose resolution --directory fixes.
      const patch = git(project, [
        "diff", "HEAD", "--binary", "--relative", "--src-prefix=a/", "--dst-prefix=b/",
      ]);
      expect(patch).toContain("GIT binary patch");
      expect(patch).not.toContain("+++ b/");
      git(repo, ["reset", "-q", "--hard", "HEAD"]);
      git(repo, ["clean", "-qfdx"]);
      const payload = handPayload(patch, { baseCommit: head, repoPrefix: "pkg/app/" });
      dir = payload.dir;

      const r = await applyCarry({ carryDir: dir, targetPath: project, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("unsafe-payload");
      // git's own parse reports the path with the prefix applied, which is
      // where it would really have landed.
      expect(r.detail).toContain("pkg/app/.claude-sesh-mover/hubinclude");
      expect(existsSync(join(project, ".claude-sesh-mover", "hubinclude"))).toBe(false);
      // Refused whole means refused whole: the saved copy carries no command.
      expect(readFileSync(join(r.savedTo!, "README.md"), "utf-8")).not.toContain("git apply");
    } finally {
      cleanup(repo, dir ?? "");
    }
  });

  it("refuses an EMPTY-FILE creation of plugin internals at SUBDIRECTORY layout", async () => {
    // A creation with no hunk at all: nothing for the raw scan's `+++ b/` line
    // to find beyond the header, and the file it creates is the project-scope
    // config.json that decides where the hub is.
    const { repo, project, head } = subdirRepo("apply-subdir-empty", true);
    let dir: string | undefined;
    try {
      const payload = handPayload(
        "diff --git a/.claude-sesh-mover/config.json b/.claude-sesh-mover/config.json\n" +
          "new file mode 100644\nindex 0000000..e69de29\n",
        { baseCommit: head, repoPrefix: "pkg/app/" }
      );
      dir = payload.dir;

      const r = await applyCarry({ carryDir: dir, targetPath: project, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("unsafe-payload");
      expect(existsSync(join(project, ".claude-sesh-mover", "config.json"))).toBe(false);
    } finally {
      cleanup(repo, dir ?? "");
    }
  });

  it("refuses a MODE CHANGE on plugin internals at SUBDIRECTORY layout", async () => {
    if (process.platform === "win32") return; // no POSIX mode bits to observe
    const { repo, project, head } = subdirRepo("apply-subdir-mode", true);
    let dir: string | undefined;
    try {
      const target = join(project, ".claude-sesh-mover", "hubinclude");
      const before = statSync(target).mode & 0o777;
      const payload = handPayload(
        "diff --git a/.claude-sesh-mover/hubinclude b/.claude-sesh-mover/hubinclude\n" +
          "old mode 100644\nnew mode 100755\n",
        { baseCommit: head, repoPrefix: "pkg/app/" }
      );
      dir = payload.dir;

      const r = await applyCarry({ carryDir: dir, targetPath: project, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("unsafe-payload");
      // `core.fileMode=false` does not stop a mode change reaching the
      // filesystem (measured) — only refusing the patch does.
      expect(statSync(target).mode & 0o777).toBe(before);
      expect(readFileSync(target, "utf-8")).toBe("docs/\n");
    } finally {
      cleanup(repo, dir ?? "");
    }
  });

  it("hands out an apply command that WORKS at SUBDIRECTORY layout", async () => {
    if (process.platform === "win32") return; // runs the README's POSIX line verbatim
    // The saved payload is the sole remedy on every declining path — the
    // re-run is foreclosed — so a command that exits 0 and writes nothing is
    // worse than no command. This runs the exact line the README hands over.
    const repo = gitRepo("apply-subdir-readme");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      mkdirSync(join(repo, "pkg", "app"), { recursive: true });
      writeFileSync(join(repo, "pkg", "app", "f.txt"), "v1\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "sub"]);
      writeFileSync(join(repo, "pkg", "app", "f.txt"), "v2\n");
      payload = await capturePayload(join(repo, "pkg", "app"));
      twin = cleanTwin(repo);
      const project = join(twin, "pkg", "app");

      // The routine path: a plain pull, no --apply-carry.
      const r = await applyCarry({
        carryDir: payload.dir, targetPath: project, meta: payload.meta, saveOnly: true,
      });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("not-requested");
      const readme = readFileSync(join(r.savedTo!, "README.md"), "utf-8");
      // The RECEIVER's prefix, read here, not the sender's `meta.repoPrefix`.
      expect(readme).toContain("--directory='pkg/app/'");

      const command = readme.match(/```bash\n(git [^\n]*)\n```/)?.[1];
      expect(command).toBeTruthy();
      const run = spawnSync("sh", ["-c", command!], { cwd: project, encoding: "utf-8" });
      expect(run.status).toBe(0);
      expect(readFileSync(join(project, "f.txt"), "utf-8")).toBe("v2\n");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("refuses an unsafe payload the numstat floor sees even when only SAVING it", async () => {
    // The save is the routine branch and its README recommends applying the
    // patch by hand. Recommending one that --apply-carry would refuse as a
    // security matter is the advice this guard exists to withhold, so the
    // check runs ahead of the save rather than after it.
    const { repo, project, head } = subdirRepo("apply-saveonly-unsafe", false);
    let dir: string | undefined;
    try {
      const payload = handPayload(
        "diff --git a/.claude-sesh-mover/config.json b/.claude-sesh-mover/config.json\n" +
          "new file mode 100644\nindex 0000000..e69de29\n",
        { baseCommit: head, repoPrefix: "pkg/app/" }
      );
      dir = payload.dir;

      const r = await applyCarry({
        carryDir: dir, targetPath: project, meta: payload.meta, saveOnly: true,
      });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("unsafe-payload");
      expect(existsSync(join(project, ".claude-sesh-mover", "config.json"))).toBe(false);
      const readme = readFileSync(join(r.savedTo!, "README.md"), "utf-8");
      expect(readme).toContain("refused, not merely deferred");
      expect(readme).not.toContain("git apply");
    } finally {
      cleanup(repo, dir ?? "");
    }
  });

  it("does not turn apply.whitespace=error into a false security refusal", async () => {
    // `git apply --numstat` honours apply.whitespace=error and exits 128 on a
    // patch that adds trailing whitespace (measured). An unhardened --numstat
    // therefore routed an innocent payload into `unsafe-payload` — the SECURITY
    // reason, with the security README text and no apply command — purely
    // because of the receiver's own config.
    const repo = gitRepo("apply-wserror");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v1\ntrailing   \n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      git(twin, ["config", "apply.whitespace", "error"]);

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      if (!r.applied) return;
      expect(r.filesChanged).toBe(1);
      expect(readFileSync(join(twin, "tracked.txt"), "utf-8")).toBe("v1\ntrailing   \n");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("says how to find the prefix when this machine could not be asked for it", async () => {
    if (process.platform === "win32") return; // PATH override + shell stub
    // With no runnable git there is no honest prefix to print — and
    // `meta.repoPrefix` is the SENDER's layout, not this machine's — so the
    // note names the one command that answers it instead of guessing.
    const repo = gitRepo("apply-noprefix");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      const emptyDir = mkdtempSync(join(tmpdir(), "sesh-nopath2-"));
      const restore = overridePath(emptyDir);
      try {
        const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
        expect(r.applied).toBe(false);
        if (r.applied) return;
        expect(r.reason).toBe("no-git");
        expect(readFileSync(join(r.savedTo!, "README.md"), "utf-8"))
          .toContain("git rev-parse --show-prefix");
      } finally {
        restore.restore();
        rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("does not let retention delete the payload it just saved, nor a foreign carry-*", async () => {
    // Retention is by NAME and chronological only because the stamps are ISO
    // timestamps: a pinned stamp, a clock stepped back or a different timezone
    // all produce a fresh save that sorts oldest. Pruning it would leave
    // `savedTo` naming a directory that no longer exists while the result says
    // the payload was saved. And `.claude-sesh-mover/` is also where a
    // project-scope `sesh-mover export` lands, so a name match alone reached
    // the user's own directories.
    const repo = gitRepo("apply-retention");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      writeFileSync(join(twin, "tracked.txt"), "MY OWN WORK\n"); // force a decline

      // A user export that merely happens to be called `carry-…`, named so
      // that it sorts INSIDE the prune window — a name-only rule deletes it.
      const foreign = join(twin, ".claude-sesh-mover", "carry-2024-notes");
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, "manifest.json"), "{}\n");

      // Five saves that all sort AFTER the sixth, which is the one just made.
      for (let i = 0; i < 5; i++) {
        await applyCarry({
          carryDir: payload.dir, targetPath: twin, meta: payload.meta,
          __stamp: `2026-09-0${i + 1}T00-00-00-000Z`,
        });
      }
      const last = await applyCarry({
        carryDir: payload.dir, targetPath: twin, meta: payload.meta,
        __stamp: "2026-01-01T00-00-00-000Z", // oldest by name, newest in fact
      });
      expect(last.applied).toBe(false);
      if (last.applied) return;

      expect(last.savedTo).toBeTruthy();
      expect(existsSync(last.savedTo!)).toBe(true);
      expect(existsSync(join(last.savedTo!, "changes.patch"))).toBe(true);
      expect(existsSync(join(foreign, "manifest.json"))).toBe(true);
      // Still bounded: the budget is kept by dropping OUR oldest instead.
      expect(savedDirs(twin).filter((n) => n !== "carry-2024-notes").length)
        .toBeLessThanOrEqual(5);
      expect(savedDirs(twin)).not.toContain("carry-2026-09-01T00-00-00-000Z");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("leaves no half-copied saved directory behind when the copy faults", async () => {
    if (process.platform === "win32") return; // relies on POSIX mode bits
    if (process.getuid?.() === 0) return; // root reads a 000-mode file anyway
    // A partly copied directory is indistinguishable from a complete one from
    // the outside — same name, same README — so leaving one behind after
    // falling through to the next root plants a plausible-looking decoy of the
    // peer's working tree that is missing files nobody will ever notice.
    const repo = gitRepo("apply-partialsave");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    let home: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      // Two untracked payload files; the SECOND one (sorted) cannot be read.
      mkdirSync(join(payload.dir, "untracked"), { recursive: true });
      writeFileSync(join(payload.dir, "untracked", "aaa.txt"), "readable\n");
      const unreadable = join(payload.dir, "untracked", "zzz.txt");
      writeFileSync(unreadable, "secret\n");
      chmodSync(unreadable, 0o000);
      twin = cleanTwin(repo);
      writeFileSync(join(twin, "tracked.txt"), "MY OWN WORK\n"); // force a decline
      home = mkdtempSync(join(tmpdir(), "sesh-home3-"));
      const restore = overrideHome(home);
      try {
        const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
        expect(r.applied).toBe(false);
        if (r.applied) return;
        // Every root failed the same way, so there is genuinely no saved copy —
        // and the result says so rather than pointing at a truncated one.
        expect(r.savedTo).toBeNull();
      } finally {
        restore.restore();
      }
      expect(savedDirs(twin)).toEqual([]);
      expect(readdirSync(join(home, ".claude-sesh-mover"), { withFileTypes: true })
        .filter((e) => e.name.startsWith("carry-"))).toEqual([]);
      chmodSync(unreadable, 0o600);
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "", home ?? "");
    }
  });

  it("does not let apply.whitespace=fix rewrite the sender's bytes", async () => {
    // Measured: with apply.whitespace=fix, `git apply` strips the trailing
    // whitespace it is being asked to add and exits 0 — the patch applies
    // cleanly and the peer's file ends up with bytes neither machine has.
    const repo = gitRepo("apply-ws");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v1\ntrailing   \n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      git(twin, ["config", "apply.whitespace", "fix"]);

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      expect(readFileSync(join(twin, "tracked.txt"), "utf-8")).toBe("v1\ntrailing   \n");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("does not let apply.ignoreWhitespace=change apply a patch that does not match", async () => {
    // Reachable only with a hand-made payload (a matching HEAD plus a clean
    // tree means the context always matches a genuine capture), which is
    // exactly the shape an untrusted bundle can carry. Measured without the
    // pin: exit 0, and the file is rewritten to the PATCH's indentation while
    // its untouched lines keep the local one — mixed indentation nobody wrote.
    const repo = gitRepo("apply-iws");
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "a.py"), "def f():\n\tx = 1\n\treturn x\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "tabs"]);
      twin = cleanTwin(repo);
      git(twin, ["config", "apply.ignoreWhitespace", "change"]);
      const head = git(twin, ["rev-parse", "HEAD"]).trim();
      const patch =
        "diff --git a/a.py b/a.py\nindex 1111111..2222222 100644\n--- a/a.py\n+++ b/a.py\n" +
        "@@ -1,3 +1,3 @@\n def f():\n-    x = 1\n+    x = 2\n     return x\n";
      const payload = handPayload(patch, { baseCommit: head });

      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("apply-failed");
      expect(readFileSync(join(twin, "a.py"), "utf-8")).toBe("def f():\n\tx = 1\n\treturn x\n");
      rmSync(payload.dir, { recursive: true, force: true });
    } finally {
      cleanup(repo, twin ?? "");
    }
  });

  it("skips an untracked payload path that names plugin internals, and reports it", async () => {
    const repo = gitRepo("apply-untracked-floor");
    let twin: string | undefined;
    let dir: string | undefined;
    try {
      twin = cleanTwin(repo);
      const head = git(twin, ["rev-parse", "HEAD"]).trim();
      const payload = handPayload("", { baseCommit: head });
      dir = payload.dir;
      for (const rel of [".claude-sesh-mover/hubinclude", ".git/config", "ok.txt"]) {
        const dest = join(dir, "untracked", ...rel.split("/"));
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, "planted\n");
      }

      const r = await applyCarry({ carryDir: dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      if (!r.applied) return;
      expect(r.refused.sort()).toEqual([".claude-sesh-mover/hubinclude", ".git/config"]);
      expect(readFileSync(join(twin, "ok.txt"), "utf-8")).toBe("planted\n");
      expect(existsSync(join(twin, ".claude-sesh-mover", "hubinclude"))).toBe(false);
      expect(readFileSync(join(twin, ".git", "config"), "utf-8")).not.toContain("planted");
    } finally {
      cleanup(repo, twin ?? "", dir ?? "");
    }
  });

  it("never writes an untracked file through a local symlinked parent", async () => {
    if (process.platform === "win32") return;
    const repo = gitRepo("apply-destsymlink");
    let twin: string | undefined;
    let dir: string | undefined;
    let outside: string | undefined;
    try {
      twin = cleanTwin(repo);
      outside = mkdtempSync(join(tmpdir(), "sesh-outside-"));
      writeFileSync(join(outside, "secret.txt"), "CANARY\n");
      symlinkSync(outside, join(twin, "docs"));
      const head = git(twin, ["rev-parse", "HEAD"]).trim();
      const payload = handPayload("", { baseCommit: head });
      dir = payload.dir;
      mkdirSync(join(dir, "untracked", "docs"), { recursive: true });
      writeFileSync(join(dir, "untracked", "docs", "secret.txt"), "PWNED\n");

      const r = await applyCarry({ carryDir: dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      if (!r.applied) return;
      expect(r.blocked.map((b) => b.path)).toEqual(["docs/secret.txt"]);
      expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe("CANARY\n");
    } finally {
      cleanup(repo, twin ?? "", dir ?? "", outside ?? "");
    }
  });

  it("says the project directory is missing rather than blaming git for it", async () => {
    // Spawning with a cwd that does not exist fails with the SAME ENOENT a
    // missing git binary does, so this is the one place the two have to be
    // told apart by hand — and nothing may create the directory just to park a
    // payload in it.
    const repo = gitRepo("apply-nodir");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let home: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      const gone = join(mkdtempSync(join(tmpdir(), "sesh-gone-")), "not-here");
      home = mkdtempSync(join(tmpdir(), "sesh-home2-"));
      const restore = overrideHome(home);
      try {
        const r = await applyCarry({ carryDir: payload.dir, targetPath: gone, meta: payload.meta });
        expect(r.applied).toBe(false);
        if (r.applied) return;
        expect(r.reason).toBe("not-git");
        expect(r.detail).toMatch(/does not exist/);
        expect(existsSync(gone)).toBe(false);
        expect(r.savedTo!.startsWith(join(home, ".claude-sesh-mover"))).toBe(true);
      } finally {
        restore.restore();
      }
    } finally {
      cleanup(repo, payload?.dir ?? "", home ?? "");
    }
  });

  it("saves the payload when the target is not a git repository at all", async () => {
    const repo = gitRepo("apply-notgit");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let plain: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      writeFileSync(join(repo, "new.txt"), "n\n");
      payload = await capturePayload(repo);
      plain = mkdtempSync(join(tmpdir(), "sesh-plain-"));

      const r = await applyCarry({ carryDir: payload.dir, targetPath: plain, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("not-git");
      expect(readFileSync(join(r.savedTo!, "untracked", "new.txt"), "utf-8")).toBe("n\n");
      const readme = readFileSync(join(r.savedTo!, "README.md"), "utf-8");
      expect(readme).toContain(payload.meta.baseCommit);
      // The manual command carries the same hardening the automatic path uses:
      // advice that silently corrupts under an ordinary `apply.whitespace=fix`
      // would be worse than no advice.
      expect(readme).toContain("apply --whitespace=nowarn");
      expect(readme).toContain("-c apply.ignoreWhitespace=no");
      expect(readme).toContain(join(r.savedTo!, "changes.patch"));
      // A saved payload must not become a thing git can commit by accident:
      // .claude-sesh-mover is committed in some projects, and this copy holds
      // the peer's gitignored-but-tracked files verbatim.
      expect(readFileSync(join(r.savedTo!, ".gitignore"), "utf-8")).toContain("*");
    } finally {
      cleanup(repo, payload?.dir ?? "", plain ?? "");
    }
  });

  it("saves the payload when git cannot be run at all", async () => {
    if (process.platform === "win32") return; // PATH override + shell stub
    const repo = gitRepo("apply-nogit");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      const emptyDir = mkdtempSync(join(tmpdir(), "sesh-nopath-"));
      const restore = overridePath(emptyDir);
      try {
        const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
        expect(r.applied).toBe(false);
        if (r.applied) return;
        expect(r.reason).toBe("no-git");
        expect(existsSync(join(r.savedTo!, "changes.patch"))).toBe(true);
      } finally {
        restore.restore();
        rmSync(emptyDir, { recursive: true, force: true });
      }
      expect(readFileSync(join(twin, "tracked.txt"), "utf-8")).toBe("v1\n");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  it("a saved fallback does not foreclose the next apply, and old ones are pruned", async () => {
    // The saved directory is the documented remedy, so it must not become the
    // reason the next attempt refuses: it lives under .claude-sesh-mover, which
    // is untracked in the ordinary project and invisible to the dirty check.
    const repo = gitRepo("apply-foreclose");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      writeFileSync(join(twin, "tracked.txt"), "MY OWN WORK\n");
      const first = await applyCarry({
        carryDir: payload.dir, targetPath: twin, meta: payload.meta,
      });
      expect(first.applied).toBe(false);

      // The user reconciles their own work; the very next attempt must succeed.
      git(twin, ["checkout", "-q", "--", "."]);
      const second = await applyCarry({
        carryDir: payload.dir, targetPath: twin, meta: payload.meta,
      });
      expect(second.applied).toBe(true);
      expect(readFileSync(join(twin, "tracked.txt"), "utf-8")).toBe("v2\n");

      // Retention is bounded, so a routine flow cannot fill the project with
      // superseded copies of the same peer's working tree.
      git(twin, ["checkout", "-q", "--", "."]);
      for (let i = 0; i < 8; i++) {
        writeFileSync(join(twin, "tracked.txt"), `dirt ${i}\n`);
        await applyCarry({
          carryDir: payload.dir, targetPath: twin, meta: payload.meta,
          __stamp: `2026-01-0${i + 1}T00-00-00-000Z`,
        });
      }
      // Retention is by name, and the names are ISO stamps — so the newest
      // pinned save survives and the oldest is gone. (The one real-clock save
      // from the first decline above sorts after every pinned one, which is
      // why this counts rather than indexes.)
      const saved = savedDirs(twin);
      expect(saved.length).toBeLessThanOrEqual(5);
      expect(saved).toContain("carry-2026-01-08T00-00-00-000Z");
      expect(saved).not.toContain("carry-2026-01-01T00-00-00-000Z");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  // --- Round 2: the floor's OTHER source-path blind spot, and the split
  // between "this machine's git failed" and "the payload is hostile" ---

  /** The same seeded project at either layout: the repo root, or `pkg/app`. */
  function layoutRepo(name: string, layout: "root" | "subdir"): {
    repo: string; project: string; head: string;
  } {
    const repo = gitRepo(name);
    const project = layout === "root" ? repo : join(repo, "pkg", "app");
    mkdirSync(join(project, ".claude-sesh-mover"), { recursive: true });
    writeFileSync(join(project, ".claude-sesh-mover", "hubinclude"), "docs/\n");
    writeFileSync(join(project, "f.txt"), "v1\n");
    git(repo, ["add", "-A", "-f"]);
    git(repo, ["commit", "-q", "-m", "seed"]);
    return { repo, project, head: git(repo, ["rev-parse", "HEAD"]).trim() };
  }

  /** A patch that changes `f.txt` and nothing else — the innocent payload. */
  const BENIGN_PATCH =
    "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n" +
    "--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-v1\n+v2\n";

  const COPY_OUT_PATCH =
    "diff --git a/.claude-sesh-mover/hubinclude b/stolen.txt\nsimilarity index 100%\n" +
    "copy from .claude-sesh-mover/hubinclude\ncopy to stolen.txt\n";

  it("refuses a patch that COPIES a plugin-internal file out, at BOTH layouts", async () => {
    // `git apply --numstat` prints only the DESTINATION of a COPY, exactly as
    // it does for a rename (measured), and the raw scan read `rename from` but
    // not `copy from` — so the two-source floor had a hole at the very shape it
    // claims to cover. Measured against the pre-fix build: `applied: true,
    // filesChanged: 1` at BOTH layouts, with `stolen.txt` holding the
    // RECEIVER's own bytes, from where the next auto-push carries this
    // machine's plugin internals to the hub.
    for (const layout of ["root", "subdir"] as const) {
      const { repo, project, head } = layoutRepo(`apply-copyout-${layout}`, layout);
      let dir: string | undefined;
      try {
        const payload = handPayload(COPY_OUT_PATCH, {
          baseCommit: head, repoPrefix: layout === "subdir" ? "pkg/app/" : "",
        });
        dir = payload.dir;

        const r = await applyCarry({ carryDir: dir, targetPath: project, meta: payload.meta });
        expect(r.applied, layout).toBe(false);
        if (r.applied) return;
        expect(r.reason, layout).toBe("unsafe-payload");
        expect(existsSync(join(project, "stolen.txt")), layout).toBe(false);
        expect(readFileSync(join(project, ".claude-sesh-mover", "hubinclude"), "utf-8")).toBe("docs/\n");
        // Refused whole: the saved copy carries no command to finish the job.
        expect(readFileSync(join(r.savedTo!, "README.md"), "utf-8")).not.toContain("git apply");
      } finally {
        cleanup(repo, dir ?? "");
      }
    }
  });

  it("still applies an ordinary rename, whose `diff --git` halves differ", async () => {
    // The header scan added for the mode-only/binary shapes must not turn every
    // rename into a refusal: the two halves of `diff --git a/<old> b/<new>` are
    // identical for everything EXCEPT a rename or a copy, and those carry their
    // own `rename from`/`copy from` lines, so the header contributes nothing
    // when they disagree.
    const repo = gitRepo("apply-rename-ok");
    let twin: string | undefined;
    try {
      twin = cleanTwin(repo);
      const head = git(twin, ["rev-parse", "HEAD"]).trim();
      const payload = handPayload(
        "diff --git a/tracked.txt b/renamed.txt\nsimilarity index 100%\n" +
          "rename from tracked.txt\nrename to renamed.txt\n",
        { baseCommit: head }
      );
      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      expect(existsSync(join(twin, "renamed.txt"))).toBe(true);
      expect(existsSync(join(twin, "tracked.txt"))).toBe(false);
      rmSync(payload.dir, { recursive: true, force: true });
    } finally {
      cleanup(repo, twin ?? "");
    }
  });

  it("refuses header-only shapes with NO runnable git, where the byte scan is the whole floor", async () => {
    if (process.platform === "win32") return; // PATH override + shell stub
    // Three shapes carry no `---`/`+++` and no rename/copy lines at all — a
    // mode-only change, a new binary file, and (for its source) a copy — so
    // their ONLY path reference is the `diff --git` line. `--numstat` sees them,
    // but `--numstat` needs a git to run: on a machine with none, the raw scan
    // is the entire floor, and it was blind to all three. Measured against the
    // pre-fix build, every one came back `not-requested` WITH an apply command
    // recommending a patch that writes this machine's plugin internals.
    const { repo, project, head } = layoutRepo("apply-nogit-header", "root");
    let empty: string | undefined;
    try {
      writeFileSync(join(project, ".claude-sesh-mover", "hubinclude"), Buffer.from([0, 1, 2, 0, 255]));
      git(repo, ["add", "-A", "-f"]);
      const binary = git(repo, ["diff", "HEAD", "--binary", "--src-prefix=a/", "--dst-prefix=b/"]);
      git(repo, ["reset", "-q", "--hard", "HEAD"]);
      expect(binary).toContain("GIT binary patch");
      expect(binary).not.toContain("+++ b/");
      const shapes: Array<[string, string]> = [
        ["binary entry", binary],
        [
          "mode-only change",
          "diff --git a/.claude-sesh-mover/hubinclude b/.claude-sesh-mover/hubinclude\n" +
            "old mode 100644\nnew mode 100755\n",
        ],
        [
          "empty-file creation",
          "diff --git a/.claude-sesh-mover/config.json b/.claude-sesh-mover/config.json\n" +
            "new file mode 100644\nindex 0000000..e69de29\n",
        ],
        ["copy source", COPY_OUT_PATCH],
      ];

      empty = mkdtempSync(join(tmpdir(), "sesh-nopath3-"));
      const restore = overridePath(empty);
      try {
        for (const [label, patch] of shapes) {
          const payload = handPayload(patch, { baseCommit: head });
          const r = await applyCarry({
            carryDir: payload.dir, targetPath: project, meta: payload.meta, saveOnly: true,
          });
          expect(r.applied, label).toBe(false);
          if (r.applied) return;
          expect(r.reason, label).toBe("unsafe-payload");
          expect(readFileSync(join(r.savedTo!, "README.md"), "utf-8"), label)
            .not.toContain("git apply");
          rmSync(payload.dir, { recursive: true, force: true });
        }
      } finally {
        restore.restore();
      }
    } finally {
      cleanup(repo, empty ?? "");
    }
  });

  it("blames this machine's broken git, not the payload, at BOTH layouts", async () => {
    // A `.git/config` git refuses to parse stands in for every receiver-side
    // git failure — `safe.directory` ownership, an unreadable `.git`, the 15s
    // timeout, EACCES on the binary: git answers every command in this
    // directory with the same words. Reading that refusal as a verdict on the
    // PATCH is what the round-1 fix did (measured: `unsafe-payload: the patch
    // could not be parsed (fatal: bad config line 12 …)`, with the security
    // README and no apply command, on the routine no-flag path as well).
    for (const layout of ["root", "subdir"] as const) {
      const { repo, project, head } = layoutRepo(`apply-brokengit-${layout}`, layout);
      let dir: string | undefined;
      try {
        appendFileSync(join(repo, ".git", "config"), "\nthis is not valid config\n");
        const payload = handPayload(BENIGN_PATCH, {
          baseCommit: head, repoPrefix: layout === "subdir" ? "pkg/app/" : "",
        });
        dir = payload.dir;

        // Asked to apply: the receiver's own state, in git's own words.
        const applied = await applyCarry({ carryDir: dir, targetPath: project, meta: payload.meta });
        expect(applied.applied, layout).toBe(false);
        if (applied.applied) return;
        expect(applied.reason, layout).toBe("not-git");
        expect(applied.detail, layout).toMatch(/bad config/);
        const appliedReadme = readFileSync(join(applied.savedTo!, "README.md"), "utf-8");
        expect(appliedReadme, layout).toContain("git -c apply.ignoreWhitespace=no apply");
        expect(appliedReadme, layout).not.toContain("refused, not merely deferred");

        // The routine no-flag path, which never ran this check at all before.
        const saved = await applyCarry({
          carryDir: dir, targetPath: project, meta: payload.meta, saveOnly: true,
        });
        expect(saved.applied, layout).toBe(false);
        if (saved.applied) return;
        expect(saved.reason, layout).toBe("not-requested");
        const savedReadme = readFileSync(join(saved.savedTo!, "README.md"), "utf-8");
        expect(savedReadme, layout).toContain("git -c apply.ignoreWhitespace=no apply");
        // And the prefix it could NOT measure is not silently claimed to be
        // empty: at subdirectory layout that would hand over a command which
        // exits 0 and writes nothing the moment they fix their config.
        expect(savedReadme, layout).toContain("git rev-parse --show-prefix");
        expect(savedReadme.match(/```bash\n(git [^\n]*)\n```/)?.[1], layout)
          .not.toContain("--directory=");
        expect(readFileSync(join(project, "f.txt"), "utf-8")).toBe("v1\n");
      } finally {
        cleanup(repo, dir ?? "");
      }
    }
  });

  it("calls an unreadable patch damaged, not hostile, when git works here", async () => {
    // The other side of the same split: a working git that refuses THIS patch
    // is evidence about the payload — but the floor did not fire, so nothing
    // unsafe was named. It declines (an un-inspected patch is not applied) with
    // git's own words and a README that says the bundle looks damaged, instead
    // of the security paragraph accusing the sender.
    for (const layout of ["root", "subdir"] as const) {
      const { repo, project, head } = layoutRepo(`apply-corrupt-${layout}`, layout);
      let dir: string | undefined;
      try {
        const payload = handPayload("this is not a patch at all\n", {
          baseCommit: head, repoPrefix: layout === "subdir" ? "pkg/app/" : "",
        });
        dir = payload.dir;

        for (const saveOnly of [false, true]) {
          const r = await applyCarry({
            carryDir: dir, targetPath: project, meta: payload.meta, saveOnly,
          });
          expect(r.applied, layout).toBe(false);
          if (r.applied) return;
          expect(r.reason, `${layout} saveOnly=${saveOnly}`).toBe("apply-failed");
          expect(r.detail, layout).toMatch(/could not be parsed/);
          const readme = readFileSync(join(r.savedTo!, "README.md"), "utf-8");
          // No command — the checks could not finish — but no accusation either.
          expect(readme, layout).not.toContain("git -c apply.ignoreWhitespace=no apply");
          expect(readme, layout).not.toContain("refused, not merely deferred");
          expect(readme, layout).toContain("damaged or truncated rather than hostile");
        }

        // ...unless the unparseable bytes also carry a header naming plugin
        // internals. Hostile outranks damaged: that user gets the security
        // wording, not "looks damaged".
        const hostile = handPayload(
          "this is not a patch at all\nrename from .claude-sesh-mover/hubinclude\n",
          { baseCommit: head }
        );
        const h = await applyCarry({
          carryDir: hostile.dir, targetPath: project, meta: hostile.meta,
        });
        expect(h.applied, layout).toBe(false);
        if (h.applied) return;
        expect(h.reason, layout).toBe("unsafe-payload");
        expect(readFileSync(join(h.savedTo!, "README.md"), "utf-8"), layout)
          .toContain("refused, not merely deferred");
        rmSync(hostile.dir, { recursive: true, force: true });
      } finally {
        cleanup(repo, dir ?? "");
      }
    }
  });

  it("emits an apply command that survives a hostile project path", async () => {
    if (process.platform === "win32") return; // runs the README's POSIX line verbatim
    // The README's command is the sole remedy on every declining path, and every
    // path in it comes from the project's own location. Interpolated into `"…"`
    // (what shipped), a project under `pk$g`+backticks emitted a line whose
    // `$g` the shell expanded away and whose backticks RAN — measured: the
    // command failed with `can't open patch …/pk'x/…` and left a `pwned` file
    // in the project. This runs the emitted line verbatim at SUBDIRECTORY
    // layout, so both interpolations — `--directory=` and the patch path — are
    // hostile.
    const outer = mkdtempSync(join(tmpdir(), "sesh-quote-"));
    const repo = join(outer, "repo");
    let twin: string | undefined;
    try {
      mkdirSync(repo);
      git(repo, ["init", "-q"]);
      git(repo, ["config", "user.email", "t@example.com"]);
      git(repo, ["config", "user.name", "Test"]);
      const hostile = "pk$g`touch pwned`'x";
      mkdirSync(join(repo, hostile, "app"), { recursive: true });
      writeFileSync(join(repo, hostile, "app", "f.txt"), "v1\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "init"]);
      writeFileSync(join(repo, hostile, "app", "f.txt"), "v2\n");
      writeFileSync(join(repo, hostile, "app", "fresh.txt"), "new\n");
      const payload = await capturePayload(join(repo, hostile, "app"));
      twin = cleanTwin(repo);
      const project = join(twin, hostile, "app");

      const r = await applyCarry({
        carryDir: payload.dir, targetPath: project, meta: payload.meta, saveOnly: true,
      });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      const readme = readFileSync(join(r.savedTo!, "README.md"), "utf-8");
      const command = readme.match(/```bash\n(git [^\n]*)\n```/)?.[1];
      expect(command).toBeTruthy();
      const run = spawnSync("sh", ["-c", command!], { cwd: project, encoding: "utf-8" });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(readFileSync(join(project, "f.txt"), "utf-8")).toBe("v2\n");
      // Nothing the path spelled was executed, anywhere the shell could have
      // run it from.
      expect(existsSync(join(project, "pwned"))).toBe(false);
      expect(existsSync(join(twin, "pwned"))).toBe(false);

      // The untracked copy line is the second interpolation site, so it is run
      // verbatim too rather than pattern-matched.
      const copy = readme.match(/```bash\n# macOS \/ Linux\n(cp [^\n]*)\n```/)?.[1];
      expect(copy).toBeTruthy();
      const copyRun = spawnSync("sh", ["-c", copy!], { cwd: project, encoding: "utf-8" });
      expect(copyRun.stderr).toBe("");
      expect(copyRun.status).toBe(0);
      expect(readFileSync(join(project, "fresh.txt"), "utf-8")).toBe("new\n");
      expect(existsSync(join(project, "pwned"))).toBe(false);

      // PowerShell cannot be run here, but its quoting is its own dialect: the
      // path's single quote is DOUBLED, not backslash-escaped, and nothing is
      // left in double quotes for `$`/backtick to expand.
      const ps = readme.match(/```powershell\n# Windows \(PowerShell\)\n(Copy-Item [^\n]*)\n```/)?.[1];
      expect(ps).toBeTruthy();
      expect(ps).toContain("''x");
      expect(ps).not.toContain('"');
      rmSync(payload.dir, { recursive: true, force: true });
    } finally {
      cleanup(outer, twin ?? "");
    }
  });

  it("uniquifies a saved directory and a sidecar that already exist", async () => {
    const repo = gitRepo("apply-stamp");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "new.txt"), "theirs\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      writeFileSync(join(twin, "new.txt"), "MINE\n");
      const stamp = "2026-02-03T04-05-06-007Z";

      const a = await applyCarry({
        carryDir: payload.dir, targetPath: twin, meta: payload.meta, __stamp: stamp,
      });
      const b = await applyCarry({
        carryDir: payload.dir, targetPath: twin, meta: payload.meta, __stamp: stamp,
      });
      expect(a.applied && b.applied).toBe(true);
      const sidecars = readdirSync(twin).filter((n) => n.startsWith("new.txt.incoming-")).sort();
      expect(sidecars).toHaveLength(2);
      expect(new Set(sidecars).size).toBe(2);
      expect(readFileSync(join(twin, "new.txt"), "utf-8")).toBe("MINE\n");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });

  // --- Round 3: the standard is what `git apply` ACCEPTS, not what `git diff`
  // emits. Every spelling below was measured against real git first (it prints
  // the path under `--numstat`, `--check` exits 0, and a bare `git apply`
  // writes the file) and only then against this module. ---

  /** `diff --git` header spellings real git accepts and an earlier scan missed. */
  const HEADER_EVASIONS: Array<[string, string]> = [
    // The two halves have different LENGTHS, so a midpoint split lands on the
    // `"` rather than on the separator. (Its mirror, `"a/…" b/…`, git rejects.)
    [
      "asymmetric quoting",
      'diff --git a/.claude-sesh-mover/config.json "b/.claude-sesh-mover/config.json"\n' +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    // `git diff --src-prefix=c/ --dst-prefix=d/` emits exactly this, and
    // `diff.mnemonicPrefix` renames the prefixes for ordinary users. Stripping
    // only `^[ab]/` leaves the halves unequal forever.
    [
      "non-a/b prefixes",
      "diff --git c/.claude-sesh-mover/config.json d/.claude-sesh-mover/config.json\n" +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    // Both halves quoted, in DIFFERENT escape spellings (`\056` is `.`): equal
    // paths, unequal bytes, unequal lengths.
    [
      "quoted halves, different escapes",
      'diff --git "a/.claude-sesh-mover/config.json" "b/\\056claude-sesh-mover/config.json"\n' +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    // Git's parser accepts a TAB between the names as readily as a space.
    [
      "tab separator",
      "diff --git a/.claude-sesh-mover/config.json\tb/.claude-sesh-mover/config.json\n" +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    // `git diff --no-prefix` emits this; `git apply -p0` then writes the path
    // verbatim, so the RAW form has to reach the floor too.
    [
      "no prefix at all",
      "diff --git .claude-sesh-mover/config.json .claude-sesh-mover/config.json\n" +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    // --- Round 4: two families the round-3 header parse still missed, both
    // measured applying against bare `git apply` (exit 0, the file lands).
    //
    // (1) `unquote_c_style` stops at the first UNESCAPED closing quote and
    // IGNORES the remainder; demanding the token END there left the literal
    // as the only reading, and its leading `"` fuses into the first segment.
    [
      "trailing byte after the closing quote",
      'diff --git a/.claude-sesh-mover/config.json "b/.claude-sesh-mover/config.json"JUNK\n' +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    [
      "trailing byte after both closing quotes",
      'diff --git "a/.claude-sesh-mover/config.json" "b/.claude-sesh-mover/config.json"JUNK\n' +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    [
      "tab separator plus a trailing byte",
      'diff --git a/.claude-sesh-mover/config.json\t"b/.claude-sesh-mover/config.json"JUNK\n' +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    // The same divergence on a keyword line rather than the `diff --git` one,
    // in the octal spelling: a traditional patch with no `diff --git` at all.
    [
      "octal spelling plus a trailing byte, on a traditional +++",
      '--- /dev/null\n+++ "b/\\056claude-sesh-mover/config.json"X\n@@ -0,0 +1 @@\n+hi\n',
    ],
    // (2) Git's separator class here is its own `isspace`: SP, TAB and CR all
    // separate the two names (VT and FF do not — measured rejected).
    [
      "CR separator",
      'diff --git a/.claude-sesh-mover/config.json\r"b/.claude-sesh-mover/config.json"\n' +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    [
      "CR separator, both halves quoted",
      'diff --git "a/.claude-sesh-mover/config.json"\r"b/.claude-sesh-mover/config.json"\n' +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    // A TAB *is* present here, so the round-3 scan did split — but its
    // `trim()`-then-quote-check left the CR inside the unquoted half, so the
    // two halves could never agree.
    [
      "CR followed by a TAB",
      'diff --git a/.claude-sesh-mover/config.json\r\t"b/.claude-sesh-mover/config.json"\n' +
        "new file mode 100644\nindex 0000000..e69de29\n",
    ],
    // --- Round 5: TAB does NOT end a name for seven of the nine keywords.
    // Only `---`/`+++` are read with TERM_TAB, and even they drop it when a
    // traditional line carries a trailing timestamp; the six rename/copy
    // keywords are read with `terminate = 0`. A scan that truncated every
    // keyword at the first TAB produced the candidate list `["b"]` for each of
    // these, all measured applying against bare `git apply` (exit 0, the file
    // lands or the receiver's own file is deleted).
    [
      "TAB inside a traditional +++ name, with a timestamp",
      "--- /dev/null\n+++ b\tQ/.claude-sesh-mover/config.json" +
        "\t2024-01-02 00:00:00.000000000 +0000\n@@ -0,0 +1 @@\n+{}\n",
    ],
    [
      "TAB inside a traditional --- name, with a timestamp (a DELETE)",
      "--- b\tQ/.claude-sesh-mover/hubinclude\t2024-01-02 00:00:00.000000000 +0000\n" +
        "+++ /dev/null\n@@ -1 +0,0 @@\n-docs/\n",
    ],
    [
      "TAB inside a `copy to` name",
      "diff --git a/decoy.txt b/stolen.txt\nsimilarity index 100%\n" +
        "copy from decoy.txt\ncopy to X\tsub/.claude-sesh-mover/config.json\n",
    ],
    [
      "TAB inside a `rename new` name (git's legacy spelling)",
      "diff --git a/decoy.txt b/moved.txt\nsimilarity index 100%\n" +
        "rename old decoy.txt\nrename new X\tsub/.claude-sesh-mover/config.json\n",
    ],
    // A SPACE-separated timestamp is stripped too, and only the LAST component
    // can be hidden behind one — so this is the one shape where the unstripped
    // reading of the line is not enough.
    [
      "SPACE-separated timestamp hiding the forbidden LEAF",
      "--- /dev/null\n+++ b/sub/.claude-sesh-mover 2024-01-02 00:00:00.000000000 +0000\n" +
        "@@ -0,0 +1 @@\n+pwned\n",
    ],
  ];

  it("refuses `diff --git` spellings git accepts, at BOTH layouts, with no runnable git", async () => {
    if (process.platform === "win32") return; // PATH override
    // An empty-file creation carries no `---`/`+++` and no rename/copy lines,
    // so the `diff --git` header is its ONLY path reference — and with no git
    // on PATH the byte scan is the WHOLE floor. Measured against the shipped
    // build at `7199c8f`, the first two came back `not-requested` at both
    // layouts WITH an apply command in the saved README: a copy-paste line that
    // writes `.claude-sesh-mover/config.json` (which redirects `hub.path`) the
    // moment the user has a working git. The symmetric `a/… b/…` control was
    // correctly refused, which is what hid them.
    for (const layout of ["root", "subdir"] as const) {
      const { repo, project, head } = layoutRepo(`apply-hdr-${layout}`, layout);
      let empty: string | undefined;
      try {
        empty = mkdtempSync(join(tmpdir(), "sesh-nopath4-"));
        const restore = overridePath(empty);
        try {
          for (const [label, patch] of HEADER_EVASIONS) {
            const payload = handPayload(patch, {
              baseCommit: head, repoPrefix: layout === "subdir" ? "pkg/app/" : "",
            });
            const r = await applyCarry({
              carryDir: payload.dir, targetPath: project, meta: payload.meta, saveOnly: true,
            });
            const where = `${layout}/${label}`;
            expect(r.applied, where).toBe(false);
            if (r.applied) return;
            expect(r.reason, where).toBe("unsafe-payload");
            expect(r.savedCommands, where).toBe(false);
            expect(readFileSync(join(r.savedTo!, "README.md"), "utf-8"), where)
              .not.toContain("git apply");
            expect(existsSync(join(project, ".claude-sesh-mover", "config.json")), where).toBe(false);
            rmSync(payload.dir, { recursive: true, force: true });
          }
        } finally {
          restore.restore();
        }
      } finally {
        cleanup(repo, empty ?? "");
      }
    }
  });

  it("refuses a `diff --git` header too padded to parse exhaustively", async () => {
    if (process.platform === "win32") return; // PATH override
    // Trying every separator position is quadratic in their number, and the
    // patch is attacker-supplied, so the parse is capped. The cap has to fail
    // CLOSED, because git's own parser has none: this path puts 280 separator
    // positions ahead of the real one (four directory components of 70 spaces
    // each — every component stays under NAME_MAX, so it is a path git really
    // creates), and measured against bare `git apply` it lands under
    // `.claude-sesh-mover/`. A cap that gave up saying "no paths here" would be
    // an evasion written with a `while` loop instead of a quote.
    const { repo, project, head } = layoutRepo("apply-padded", "root");
    let empty: string | undefined;
    try {
      const p = `.claude-sesh-mover/${[" ".repeat(70), " ".repeat(70), " ".repeat(70), " ".repeat(70)].join("/")}/x`;
      const payload = handPayload(
        `diff --git a/${p} b/${p}\nnew file mode 100644\nindex 0000000..e69de29\n`,
        { baseCommit: head }
      );
      empty = mkdtempSync(join(tmpdir(), "sesh-nopath5-"));
      const restore = overridePath(empty);
      let r;
      try {
        r = await applyCarry({
          carryDir: payload.dir, targetPath: project, meta: payload.meta, saveOnly: true,
        });
      } finally {
        restore.restore();
      }
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("unsafe-payload");
      expect(readdirSync(join(project, ".claude-sesh-mover")).sort())
        .toEqual(expect.arrayContaining(["hubinclude"]));
      expect(existsSync(join(project, p))).toBe(false);
      rmSync(payload.dir, { recursive: true, force: true });
    } finally {
      cleanup(repo, empty ?? "");
    }
  });

  it("refuses `rename old`/`rename new`, git's legacy rename spelling", async () => {
    // Found by re-running the blind-spot hunt against git's OWN keyword table
    // (read out of the shipped binary): `parse_git_header` has sixteen entries
    // and nine name a path — `rename old `/`rename new ` among them, still
    // accepted, and `--numstat` prints only a rename's DESTINATION. So unlike
    // the header spellings above this one was live even on a receiver with a
    // perfectly healthy git: measured `applied: true` at BOTH layouts, with
    // `.claude-sesh-mover/hubinclude` — the file deciding what this machine's
    // NEXT push uploads — deleted and `moved.txt` created in its place.
    for (const layout of ["root", "subdir"] as const) {
      const { repo, project, head } = layoutRepo(`apply-renameold-${layout}`, layout);
      let dir: string | undefined;
      try {
        const payload = handPayload(
          "diff --git a/.claude-sesh-mover/hubinclude b/moved.txt\nsimilarity index 100%\n" +
            "rename old .claude-sesh-mover/hubinclude\nrename new moved.txt\n",
          { baseCommit: head, repoPrefix: layout === "subdir" ? "pkg/app/" : "" }
        );
        dir = payload.dir;
        const r = await applyCarry({ carryDir: dir, targetPath: project, meta: payload.meta });
        expect(r.applied, layout).toBe(false);
        if (r.applied) return;
        expect(r.reason, layout).toBe("unsafe-payload");
        expect(existsSync(join(project, "moved.txt")), layout).toBe(false);
        expect(readFileSync(join(project, ".claude-sesh-mover", "hubinclude"), "utf-8")).toBe("docs/\n");
      } finally {
        cleanup(repo, dir ?? "");
      }
    }
  });

  it("refuses a rename/copy SOURCE hidden behind a trailing byte, healthy git, BOTH layouts", async () => {
    // The worst members of the round-4 family, and the reason it outranks the
    // header spellings above: `--numstat` prints only a rename's or copy's
    // DESTINATION, so on a receiver whose git works perfectly the byte scan is
    // the ONLY thing reading these lines. One appended byte after the closing
    // quote was enough to blind it while git decoded the real path — measured
    // against bare `git apply` at BOTH layouts: exit 0, and
    // `.claude-sesh-mover/hubinclude` (the file deciding what this machine's
    // next push uploads) either DELETED, or reproduced at an ordinary path
    // from where the next auto-push would carry it to the hub.
    const F = ".claude-sesh-mover/hubinclude";
    const payloads: Array<[string, string, string]> = [
      [
        "rename from, quoted with a trailing byte",
        `diff --git a/decoy b/moved.txt\nsimilarity index 100%\nrename from "${F}"X\nrename to moved.txt\n`,
        "moved.txt",
      ],
      [
        "rename from, octal-escaped with a trailing byte",
        'diff --git a/decoy b/moved.txt\nsimilarity index 100%\n' +
          'rename from "\\056claude-sesh-mover/hubinclude"X\nrename to moved.txt\n',
        "moved.txt",
      ],
      [
        "copy from, quoted with a trailing byte",
        `diff --git a/decoy b/stolen.txt\nsimilarity index 100%\ncopy from "${F}"X\ncopy to stolen.txt\n`,
        "stolen.txt",
      ],
    ];
    for (const layout of ["root", "subdir"] as const) {
      for (const [label, patch, dest] of payloads) {
        const { repo, project, head } = layoutRepo(`apply-trailing-${layout}`, layout);
        let dir: string | undefined;
        try {
          const payload = handPayload(patch, {
            baseCommit: head, repoPrefix: layout === "subdir" ? "pkg/app/" : "",
          });
          dir = payload.dir;
          const r = await applyCarry({ carryDir: dir, targetPath: project, meta: payload.meta });
          const where = `${layout}/${label}`;
          expect(r.applied, where).toBe(false);
          if (r.applied) return;
          expect(r.reason, where).toBe("unsafe-payload");
          expect(r.savedCommands, where).toBe(false);
          expect(existsSync(join(project, dest)), where).toBe(false);
          expect(readFileSync(join(project, ".claude-sesh-mover", "hubinclude"), "utf-8"), where)
            .toBe("docs/\n");
        } finally {
          cleanup(repo, dir ?? "");
        }
      }
    }
  });

  it("still applies a tracked file whose name begins with the plugin directory's", async () => {
    // The non-vacuity half of trying every separator position, and the reason
    // the halves must still AGREE. `docs/.claude-sesh-mover notes.md` contains
    // a space, and the split before it yields `docs/.claude-sesh-mover` — a
    // whole segment the floor matches, though no real path here has it. Only
    // the agreement requirement rejects that split, so dropping it turns an
    // ordinary edit into a security refusal naming a peer.
    const repo = gitRepo("apply-spacey");
    let twin: string | undefined;
    let payload: { dir: string; meta: CarryMeta } | undefined;
    try {
      const name = "docs/.claude-sesh-mover notes.md";
      mkdirSync(join(repo, "docs"), { recursive: true });
      writeFileSync(join(repo, name), "v1\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "notes"]);
      writeFileSync(join(repo, name), "v2\n");
      payload = await capturePayload(repo);
      // The header really is the mis-splittable shape, straight from git.
      expect(readFileSync(join(payload.dir, "changes.patch"), "utf-8"))
        .toContain("diff --git a/docs/.claude-sesh-mover notes.md b/docs/.claude-sesh-mover notes.md");

      twin = cleanTwin(repo);
      const r = await applyCarry({ carryDir: payload.dir, targetPath: twin, meta: payload.meta });
      expect(r.applied).toBe(true);
      expect(readFileSync(join(twin, name), "utf-8")).toBe("v2\n");
    } finally {
      cleanup(repo, twin ?? "", payload?.dir ?? "");
    }
  });

  it("finds the apply prefix unknown for a project more than 64 ancestors deep", async () => {
    // `hasGitAncestor` decides whether a `git rev-parse` refusal means "not a
    // repository" (an empty prefix is then RIGHT) or "this git cannot read the
    // repository" (the prefix is unknown and the README must say so). Its depth
    // cap of 64 was wrong in the UNSAFE direction: past that it answered
    // "false", i.e. a KNOWN empty prefix, so a deep project on a broken-git
    // receiver got an apply command with no `--directory` and no caveat —
    // measured, and exactly the silent no-op the note exists to prevent.
    const repo = gitRepo("apply-deep");
    let dir: string | undefined;
    try {
      const deep = join(repo, ...Array.from({ length: 70 }, (_, i) => `d${i}`));
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "f.txt"), "v1\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "deep"]);
      const head = git(repo, ["rev-parse", "HEAD"]).trim();
      appendFileSync(join(repo, ".git", "config"), "\nthis is not valid config\n");

      const payload = handPayload(BENIGN_PATCH, { baseCommit: head });
      dir = payload.dir;
      const r = await applyCarry({
        carryDir: dir, targetPath: deep, meta: payload.meta, saveOnly: true,
      });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      const readme = readFileSync(join(r.savedTo!, "README.md"), "utf-8");
      expect(readme).toContain("git rev-parse --show-prefix");
      expect(readme.match(/```bash\n(git [^\n]*)\n```/)?.[1]).not.toContain("--directory=");
    } finally {
      cleanup(repo, dir ?? "");
    }
  });

  it("still hands over the untracked files when the PATCH is the damaged half", async () => {
    // The `unsafe` README returns early on purpose — its whole point is to give
    // no instructions. The `unparseable` one inherited that early return by
    // accident: a patch git cannot read says nothing whatever about the
    // untracked files beside it, which are ordinary copies. Before, the saved
    // README counted them in its header and then never mentioned them again.
    const repo = gitRepo("apply-damaged-untracked");
    let dir: string | undefined;
    try {
      const head = git(repo, ["rev-parse", "HEAD"]).trim();
      const payload = handPayload("this is not a patch at all\n", {
        baseCommit: head, untrackedCount: 2, untrackedBytes: 12,
      });
      dir = payload.dir;
      mkdirSync(join(dir, "untracked"), { recursive: true });
      writeFileSync(join(dir, "untracked", "one.txt"), "a\n");
      writeFileSync(join(dir, "untracked", "two.txt"), "b\n");

      const r = await applyCarry({ carryDir: dir, targetPath: repo, meta: payload.meta });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      expect(r.reason).toBe("apply-failed");
      // No apply command, and the result says so rather than leaving the caller
      // to promise one.
      expect(r.savedCommands).toBe(false);
      const readme = readFileSync(join(r.savedTo!, "README.md"), "utf-8");
      expect(readme).toContain("damaged or truncated rather than hostile");
      expect(readme).not.toContain("git -c apply.ignoreWhitespace=no apply");
      // ...but the untracked half is still handed over, in both dialects, and
      // the copy line runs verbatim.
      expect(readme).toContain("nothing above affects them");
      const copy = readme.match(/```bash\n# macOS \/ Linux\n(cp [^\n]*)\n```/)?.[1];
      expect(copy).toBeTruthy();
      expect(readme).toContain("Copy-Item -Recurse -Force");
      if (process.platform !== "win32") {
        const run = spawnSync("sh", ["-c", copy!], { cwd: repo, encoding: "utf-8" });
        expect(run.status).toBe(0);
        expect(readFileSync(join(repo, "one.txt"), "utf-8")).toBe("a\n");
      }
      // The refused variant still says nothing at all, which is its point.
      const hostile = handPayload(
        "this is not a patch at all\nrename from .claude-sesh-mover/hubinclude\n",
        { baseCommit: head, untrackedCount: 2 }
      );
      const h = await applyCarry({ carryDir: hostile.dir, targetPath: repo, meta: hostile.meta });
      expect(h.applied).toBe(false);
      if (h.applied) return;
      expect(h.savedCommands).toBe(false);
      const hostileReadme = readFileSync(join(h.savedTo!, "README.md"), "utf-8");
      expect(hostileReadme).toContain("refused, not merely deferred");
      expect(hostileReadme).not.toContain("cp -R");
      rmSync(hostile.dir, { recursive: true, force: true });
    } finally {
      cleanup(repo, dir ?? "");
    }
  });

  it("describes the untracked files it really saved, not the count the bundle claims", async () => {
    // `meta.untrackedCount` is the SENDER's number, and a hand-made bundle can
    // say anything. Declaring `0` while shipping an `untracked/` tree used to
    // produce a README that never mentioned the copies sitting right beside it
    // — harmless (nothing is written either way) but a note describing the
    // directory it lives in has to describe THAT directory.
    const repo = gitRepo("apply-untracked-count");
    let dir: string | undefined;
    try {
      const head = git(repo, ["rev-parse", "HEAD"]).trim();
      const payload = handPayload("", { baseCommit: head, untrackedCount: 0, untrackedBytes: 0 });
      dir = payload.dir;
      mkdirSync(join(dir, "untracked"), { recursive: true });
      writeFileSync(join(dir, "untracked", "one.txt"), "a\n");
      writeFileSync(join(dir, "untracked", "two.txt"), "b\n");

      const r = await applyCarry({
        carryDir: dir, targetPath: repo, meta: payload.meta, saveOnly: true,
      });
      expect(r.applied).toBe(false);
      if (r.applied) return;
      const readme = readFileSync(join(r.savedTo!, "README.md"), "utf-8");
      expect(readme).toContain("2 untracked file(s)");
      expect(readme).toContain("cp -R");
      expect(readme).toContain("Copy-Item -Recurse -Force");
      // …and the mirror: a bundle CLAIMING files it did not ship must not send
      // the user looking for an `untracked/` directory that is not there.
      const empty = handPayload("", { baseCommit: head, untrackedCount: 7, untrackedBytes: 99 });
      const e = await applyCarry({
        carryDir: empty.dir, targetPath: repo, meta: empty.meta, saveOnly: true,
      });
      expect(e.applied).toBe(false);
      if (e.applied) return;
      const emptyReadme = readFileSync(join(e.savedTo!, "README.md"), "utf-8");
      expect(emptyReadme).toContain("0 untracked file(s)");
      expect(emptyReadme).not.toContain("cp -R");
      rmSync(empty.dir, { recursive: true, force: true });
    } finally {
      cleanup(repo, dir ?? "");
    }
  });

  it("reports savedCommands true exactly when the README carries them", async () => {
    // The field pull.ts branches on: promising "a README with the exact
    // commands" on a decline that deliberately withholds them sends the user
    // looking for something that is not there.
    const repo = gitRepo("apply-savedcommands");
    let payload: { dir: string; meta: CarryMeta } | undefined;
    let twin: string | undefined;
    try {
      writeFileSync(join(repo, "tracked.txt"), "v2\n");
      payload = await capturePayload(repo);
      twin = cleanTwin(repo);
      const ok = await applyCarry({
        carryDir: payload.dir, targetPath: twin, meta: payload.meta, saveOnly: true,
      });
      expect(ok.applied).toBe(false);
      if (ok.applied) return;
      expect(ok.reason).toBe("not-requested");
      expect(ok.savedCommands).toBe(true);
      expect(readFileSync(join(ok.savedTo!, "README.md"), "utf-8"))
        .toContain("git -c apply.ignoreWhitespace=no apply");
    } finally {
      cleanup(repo, payload?.dir ?? "", twin ?? "");
    }
  });
});
