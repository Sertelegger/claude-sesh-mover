import { describe, it, expect } from "vitest";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overridePath } from "./helpers/env.js";
import { captureCarry, CARRY_MAX_BYTES } from "../src/hub/carry.js";

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
