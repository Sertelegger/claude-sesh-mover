import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  snapshotWorkspace, unpackWorkspace, isExcluded, readHubignore,
  readHubinclude, isReIncluded, mayContainReIncluded, isNeverIncludable,
  WorkspaceTargetNotEmptyError, DEFAULT_WORKSPACE_EXCLUDES, NEVER_INCLUDABLE,
} from "../src/hub/workspace.js";

function tmp(p: string): string { return mkdtempSync(join(tmpdir(), p)); }
const isWindows = platform() === "win32";

describe("workspace snapshot", () => {
  it("isExcluded matches literals and single-star globs per segment", () => {
    expect(isExcluded("node_modules", DEFAULT_WORKSPACE_EXCLUDES)).toBe(true);
    expect(isExcluded("src", DEFAULT_WORKSPACE_EXCLUDES)).toBe(false);
    expect(isExcluded("build-cache", ["build-*"])).toBe(true);
    expect(isExcluded("built", ["build-*"])).toBe(false);
  });

  it("hubignore lines add to excludes; comments and blanks skipped", () => {
    const dir = tmp("sesh-ws-");
    try {
      mkdirSync(join(dir, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(dir, ".claude-sesh-mover", "hubignore"), "# comment\n\n*.log\nbig-data\n");
      expect(readHubignore(dir)).toEqual(["*.log", "big-data"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("snapshot copies tree honoring excludes at any depth; counts files+bytes", async () => {
    const src = tmp("sesh-ws-src-");
    const dest = tmp("sesh-ws-dest-");
    try {
      mkdirSync(join(src, "src", "node_modules", "x"), { recursive: true });
      mkdirSync(join(src, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(src, "a.md"), "hello");
      writeFileSync(join(src, "src", "b.ts"), "world!");
      writeFileSync(join(src, "src", "node_modules", "x", "junk.js"), "junk");
      writeFileSync(join(src, ".claude-sesh-mover", "config.json"), "{}");
      const r = await snapshotWorkspace(src, dest);
      expect(r.fileCount).toBe(2);
      expect(r.byteSize).toBe(5 + 6);
      expect(existsSync(join(dest, "a.md"))).toBe(true);
      expect(existsSync(join(dest, "src", "b.ts"))).toBe(true);
      expect(existsSync(join(dest, "src", "node_modules"))).toBe(false);
      expect(existsSync(join(dest, ".claude-sesh-mover"))).toBe(false);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it.skipIf(isWindows)("symlinks are skipped, never followed", async () => {
    // Windows: symlinkSync needs elevation; the skip logic is platform-independent.
    const src = tmp("sesh-ws-src-");
    const dest = tmp("sesh-ws-dest-");
    try {
      writeFileSync(join(src, "real.txt"), "x");
      symlinkSync("/etc", join(src, "escape"));
      const r = await snapshotWorkspace(src, dest);
      expect(r.fileCount).toBe(1);
      expect(existsSync(join(dest, "escape"))).toBe(false);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("unpack refuses a non-empty target without force, honors force", async () => {
    const src = tmp("sesh-ws-src-");
    const target = tmp("sesh-ws-target-");
    try {
      writeFileSync(join(src, "f.txt"), "data");
      writeFileSync(join(target, "existing.txt"), "occupied");
      await expect(unpackWorkspace(src, target, { force: false }))
        .rejects.toThrow(WorkspaceTargetNotEmptyError);
      const r = await unpackWorkspace(src, target, { force: true });
      expect(r.fileCount).toBe(1);
      expect(readFileSync(join(target, "f.txt"), "utf-8")).toBe("data");
      expect(existsSync(join(target, "existing.txt"))).toBe(true); // merge, not wipe
    } finally { for (const d of [src, target]) rmSync(d, { recursive: true, force: true }); }
  });

  it("unpack into a nonexistent target creates it without force", async () => {
    const src = tmp("sesh-ws-src-");
    const parent = tmp("sesh-ws-parent-");
    try {
      writeFileSync(join(src, "f.txt"), "data");
      const target = join(parent, "new-project");
      const r = await unpackWorkspace(src, target, { force: false });
      expect(r.fileCount).toBe(1);
    } finally { for (const d of [src, parent]) rmSync(d, { recursive: true, force: true }); }
  });

  it("force-merge overwrites colliding filenames with src content", async () => {
    // Load-bearing for pull's retry flow: re-unpacking after a partial pull
    // must leave the incoming (src) content in place on collision.
    const src = tmp("sesh-ws-src-");
    const target = tmp("sesh-ws-target-");
    try {
      writeFileSync(join(src, "shared.txt"), "incoming");
      writeFileSync(join(target, "shared.txt"), "stale");
      writeFileSync(join(target, "keep.txt"), "untouched");
      const r = await unpackWorkspace(src, target, { force: true });
      expect(r.fileCount).toBe(1);
      expect(readFileSync(join(target, "shared.txt"), "utf-8")).toBe("incoming");
      expect(readFileSync(join(target, "keep.txt"), "utf-8")).toBe("untouched");
    } finally { for (const d of [src, target]) rmSync(d, { recursive: true, force: true }); }
  });

  it.skipIf(isWindows)("unpack skips symlinks with a count, never follows", async () => {
    // Windows: symlinkSync needs elevation; the skip logic is platform-independent.
    const src = tmp("sesh-ws-src-");
    const parent = tmp("sesh-ws-parent-");
    try {
      writeFileSync(join(src, "real.txt"), "x");
      symlinkSync("/etc", join(src, "escape"));
      const target = join(parent, "new-project");
      const r = await unpackWorkspace(src, target, { force: false });
      expect(r.fileCount).toBe(1);
      expect(r.symlinksSkipped).toBe(1);
      expect(existsSync(join(target, "escape"))).toBe(false);
    } finally { for (const d of [src, parent]) rmSync(d, { recursive: true, force: true }); }
  });

  it.skipIf(isWindows)("unpack never writes through a symlink in the TARGET tree", async () => {
    // The source side has always been safe; the destination side was not.
    // Measured before this guard: a `docs -> outside` link in the target sent
    // the incoming docs/note.md straight into `outside`, overwriting a file
    // nothing asked to touch, and the result still reported a clean unpack.
    const src = tmp("sesh-ws-src-");
    const target = tmp("sesh-ws-target-");
    const outside = tmp("sesh-ws-outside-");
    try {
      mkdirSync(join(src, "docs"), { recursive: true });
      writeFileSync(join(src, "docs", "note.md"), "incoming\n");
      writeFileSync(join(src, "ok.txt"), "fine\n");
      writeFileSync(join(outside, "note.md"), "PRECIOUS\n");
      symlinkSync(outside, join(target, "docs"));

      const r = await unpackWorkspace(src, target, { force: true });
      expect(r.blocked).toEqual([{ path: "docs", reason: "local-symlink" }]);
      expect(readFileSync(join(outside, "note.md"), "utf-8")).toBe("PRECIOUS\n");
      // The rest of the payload still lands.
      expect(r.fileCount).toBe(1);
      expect(readFileSync(join(target, "ok.txt"), "utf-8")).toBe("fine\n");
    } finally {
      for (const d of [src, target, outside]) rmSync(d, { recursive: true, force: true });
    }
  });

  it.skipIf(isWindows)("unpack never writes through a symlink standing where a FILE goes", async () => {
    const src = tmp("sesh-ws-src-");
    const target = tmp("sesh-ws-target-");
    const outside = tmp("sesh-ws-outside-");
    try {
      writeFileSync(join(src, "config.json"), "incoming\n");
      writeFileSync(join(outside, "real.json"), "PRECIOUS\n");
      symlinkSync(join(outside, "real.json"), join(target, "config.json"));

      const r = await unpackWorkspace(src, target, { force: true });
      expect(r.blocked).toEqual([{ path: "config.json", reason: "local-symlink" }]);
      expect(readFileSync(join(outside, "real.json"), "utf-8")).toBe("PRECIOUS\n");
      expect(r.fileCount).toBe(0);
    } finally {
      for (const d of [src, target, outside]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("unpack reports a file standing where a directory belongs instead of crashing", async () => {
    const src = tmp("sesh-ws-src-");
    const target = tmp("sesh-ws-target-");
    try {
      mkdirSync(join(src, "docs"), { recursive: true });
      writeFileSync(join(src, "docs", "note.md"), "incoming\n");
      writeFileSync(join(src, "ok.txt"), "fine\n");
      writeFileSync(join(target, "docs"), "a file, not a directory\n");

      const r = await unpackWorkspace(src, target, { force: true });
      expect(r.blocked).toEqual([{ path: "docs", reason: "local-not-a-file" }]);
      expect(readFileSync(join(target, "docs"), "utf-8")).toBe("a file, not a directory\n");
      expect(readFileSync(join(target, "ok.txt"), "utf-8")).toBe("fine\n");
    } finally {
      for (const d of [src, target]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("unpack writes into an existing directory of the same name (a dir is not a collision)", async () => {
    const src = tmp("sesh-ws-src-");
    const target = tmp("sesh-ws-target-");
    try {
      mkdirSync(join(src, "docs"), { recursive: true });
      writeFileSync(join(src, "docs", "note.md"), "incoming\n");
      mkdirSync(join(target, "docs"), { recursive: true });
      writeFileSync(join(target, "docs", "mine.md"), "local\n");

      const r = await unpackWorkspace(src, target, { force: true });
      expect(r.blocked).toEqual([]);
      expect(r.fileCount).toBe(1);
      expect(readFileSync(join(target, "docs", "note.md"), "utf-8")).toBe("incoming\n");
      expect(readFileSync(join(target, "docs", "mine.md"), "utf-8")).toBe("local\n");
    } finally {
      for (const d of [src, target]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("hubignore pattern suppresses matching files during snapshot", async () => {
    const src = tmp("sesh-ws-src-");
    const dest = tmp("sesh-ws-dest-");
    try {
      mkdirSync(join(src, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(src, ".claude-sesh-mover", "hubignore"), "# ignore logs\n*.log\n");
      writeFileSync(join(src, "app.log"), "log line");
      writeFileSync(join(src, "keep.ts"), "ok");
      const r = await snapshotWorkspace(src, dest);
      expect(r.fileCount).toBe(1);
      expect(existsSync(join(dest, "keep.ts"))).toBe(true);
      expect(existsSync(join(dest, "app.log"))).toBe(false);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("a hubignore `dir/` line excludes `dir` (a trailing slash is not a silent no-op)", async () => {
    // isExcluded compares a pattern to a bare directory ENTRY NAME, which never
    // carries a slash — so an unstripped "build/" matched nothing at all and the
    // directory was carried anyway. hubinclude documents `dir/` as meaningful
    // (§6.0), so the sibling file has to mean the same thing.
    const src = tmp("sesh-ws-src-");
    const dest = tmp("sesh-ws-dest-");
    try {
      mkdirSync(join(src, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(src, ".claude-sesh-mover", "hubignore"), "build/\n");
      expect(readHubignore(src)).toEqual(["build"]);
      mkdirSync(join(src, "build"), { recursive: true });
      writeFileSync(join(src, "build", "out.js"), "generated");
      writeFileSync(join(src, "keep.ts"), "ok");
      const r = await snapshotWorkspace(src, dest);
      expect(r.fileCount).toBe(1);
      expect(existsSync(join(dest, "build"))).toBe(false);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });
});

describe("hubinclude", () => {
  const writeInclude = (dir: string, body: string): void => {
    mkdirSync(join(dir, ".claude-sesh-mover"), { recursive: true });
    writeFileSync(join(dir, ".claude-sesh-mover", "hubinclude"), body);
  };
  const writeIgnore = (dir: string, body: string): void => {
    mkdirSync(join(dir, ".claude-sesh-mover"), { recursive: true });
    writeFileSync(join(dir, ".claude-sesh-mover", "hubignore"), body);
  };

  it("parses patterns, skipping comments and blanks", () => {
    const dir = tmp("sesh-inc-");
    try {
      writeInclude(dir, "# keep specs\n\ndocs/superpowers/\n*.keepme\n");
      expect(readHubinclude(dir)).toEqual(["docs/superpowers/", "*.keepme"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns [] when the file is missing, and never reads a non-file", () => {
    const dir = tmp("sesh-inc-");
    try {
      expect(readHubinclude(dir)).toEqual([]);
      mkdirSync(join(dir, ".claude-sesh-mover", "hubinclude"), { recursive: true });
      expect(readHubinclude(dir)).toEqual([]); // a DIRECTORY named hubinclude
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("matches subtrees and globs but never .git or .claude-sesh-mover", () => {
    const pats = ["docs/superpowers/", "*.keepme", ".git", ".claude-sesh-mover"];
    expect(isReIncluded("docs/superpowers/specs/a.md", pats)).toBe(true);
    expect(isReIncluded("docs/other/a.md", pats)).toBe(false);
    expect(isReIncluded("notes.keepme", pats)).toBe(true);
    expect(isReIncluded(".git/config", pats)).toBe(false);              // hard-excluded
    expect(isReIncluded(".claude-sesh-mover/config.json", pats)).toBe(false);
  });

  it("a rooted pattern carries its subtree and nothing beside it", () => {
    expect(isReIncluded("docs/superpowers", ["docs/superpowers/"])).toBe(true);
    expect(isReIncluded("docs/superpowers/a/b/c.md", ["docs/superpowers/"])).toBe(true);
    expect(isReIncluded("docs/superpowers-notes/a.md", ["docs/superpowers/"])).toBe(false);
    expect(isReIncluded("docs", ["docs/superpowers/"])).toBe(false); // parent is not carried
    expect(isReIncluded("build/keep.txt", ["build/keep.txt"])).toBe(true);
    expect(isReIncluded("build/other.txt", ["build/keep.txt"])).toBe(false);
  });

  it("a rooted pattern may glob per segment; a bare pattern matches at any depth", () => {
    expect(isReIncluded("docs/a.md", ["docs/*.md"])).toBe(true);
    expect(isReIncluded("docs/a.txt", ["docs/*.md"])).toBe(false);
    expect(isReIncluded("docs/sub/a.md", ["docs/*.md"])).toBe(false); // one segment deep only
    expect(isReIncluded("docs/sub/a.md", ["docs/*"])).toBe(true);     // …unless the glob is the segment
    expect(isReIncluded("a/b/c/notes.keepme", ["*.keepme"])).toBe(true);
    expect(isReIncluded("a/b/secrets/x.txt", ["secrets"])).toBe(true); // bare literal, any depth
  });

  it("says no to an empty path, an empty pattern list, and patterns that normalize to nothing", () => {
    expect(isReIncluded("a.txt", [])).toBe(false);
    expect(isReIncluded("", ["*"])).toBe(false);
    expect(isReIncluded("a.txt", ["/", ".", "./", "//", "   "])).toBe(false);
  });

  // --- Attacks: every way a pattern might smuggle back a hard-excluded path ---

  it("blocks .git and .claude-sesh-mover at ANY depth, not just the first segment", () => {
    // The obvious implementation checks relPath.split("/")[0]; a vendored
    // submodule then carries a whole .git store through a `vendor/` pattern.
    expect(isReIncluded("vendor/lib/.git/config", ["vendor/"])).toBe(false);
    expect(isReIncluded("vendor/lib/.git", ["vendor/"])).toBe(false);
    expect(isReIncluded("sub/.claude-sesh-mover/config.json", ["sub"])).toBe(false);
    expect(isReIncluded("vendor/lib/.git/config", ["*"])).toBe(false);
    // …and the ordinary file beside it still travels.
    expect(isReIncluded("vendor/lib/index.js", ["vendor/"])).toBe(true);
  });

  it("blocks equivalent spellings of a hard-excluded pattern", () => {
    for (const pattern of [".git", ".git/", "./.git", ".git/config", "x/../.git", "/.git", ".git\\config"]) {
      expect(isReIncluded(".git/config", [pattern])).toBe(false);
    }
    for (const pattern of [".claude-sesh-mover", ".claude-sesh-mover/", "./.claude-sesh-mover/hubinclude"]) {
      expect(isReIncluded(".claude-sesh-mover/hubinclude", [pattern])).toBe(false);
    }
  });

  it("blocks case-folded and trailing-dot/space spellings of a hard-excluded path", () => {
    // macOS/Windows resolve .GIT to .git, and Win32 strips trailing dots and
    // spaces — so a directory that IS the git store can readdir as any of these.
    for (const p of [".GIT/config", ".Git/config", ".git./config", ".git /config", ".GIT./config"]) {
      expect(isReIncluded(p, ["*"])).toBe(false);
    }
    expect(isReIncluded(".CLAUDE-SESH-MOVER/hubinclude", ["*"])).toBe(false);
    expect(isNeverIncludable("a/b/.GIT/c")).toBe(true);
    expect(isNeverIncludable("a/b/gitignore")).toBe(false);
  });

  it("blocks paths and patterns that escape the project", () => {
    expect(isReIncluded("../secrets.env", ["*"])).toBe(false);
    expect(isReIncluded("a/../../secrets.env", ["*"])).toBe(false);
    expect(isReIncluded("/etc/passwd", ["etc/passwd"])).toBe(false);
    expect(isReIncluded("/etc/passwd", ["*"])).toBe(false);
    expect(isReIncluded("C:/Windows/win.ini", ["*"])).toBe(false);
    expect(isReIncluded("\\\\server\\share\\x", ["*"])).toBe(false);
    // A pattern that escapes can never match a project-relative path.
    expect(isReIncluded("secrets.env", ["../secrets.env"])).toBe(false);
    expect(isReIncluded("secrets.env", ["/secrets.env"])).toBe(true); // rooted-at-project spelling
  });

  it("treats a backslash as a separator on both sides so one committed file works on every OS", () => {
    // relPath from path.relative() is "\"-separated on Windows; a pattern
    // written on Windows uses "\" too. Both must land on the same meaning, and
    // — load-bearing — a "\"-spelled .git must not slip past the segment guard.
    expect(isReIncluded("docs\\superpowers\\a.md", ["docs/superpowers/"])).toBe(true);
    expect(isReIncluded("docs/superpowers/a.md", ["docs\\superpowers\\"])).toBe(true);
    expect(isReIncluded(".git\\config", ["*"])).toBe(false);
  });

  it("survives a pattern built to blow up the matcher", () => {
    const bomb = "*a*a*a*a*a*a*a*a*a*a*a*b";
    const victim = "a".repeat(64);
    const started = Date.now();
    expect(isReIncluded(victim, [bomb])).toBe(false);
    expect(isReIncluded(`dir/${victim}`, [`dir/${bomb}`])).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("caps an enormous pattern file instead of carrying it into every path test", () => {
    const dir = tmp("sesh-inc-");
    try {
      writeInclude(dir, Array.from({ length: 5000 }, (_, i) => `p${i}`).join("\n"));
      expect(readHubinclude(dir).length).toBeLessThanOrEqual(500);
      writeInclude(dir, "x".repeat(200_000));
      expect(readHubinclude(dir)).toEqual([]); // over the byte cap: no re-includes at all
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("mayContainReIncluded only descends where a pattern can actually reach", () => {
    expect(mayContainReIncluded("build", ["build/keep.txt"])).toBe(true);
    expect(mayContainReIncluded("build/sub", ["build/keep.txt"])).toBe(false);
    expect(mayContainReIncluded("other", ["build/keep.txt"])).toBe(false);
    expect(mayContainReIncluded("node_modules", ["*.keepme"])).toBe(true); // bare: any depth
    expect(mayContainReIncluded("node_modules", [])).toBe(false);
    // Never walk into what can never be carried.
    expect(mayContainReIncluded(".git", ["*"])).toBe(false);
    expect(mayContainReIncluded("vendor/lib/.git", ["*"])).toBe(false);
    expect(mayContainReIncluded(".claude-sesh-mover", ["*"])).toBe(false);
  });

  // --- Snapshot integration ---

  it("snapshotWorkspace carries a hubignore'd path that hubinclude re-includes", async () => {
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    try {
      writeIgnore(src, "build/\n");
      writeInclude(src, "build/keep.txt\n");
      mkdirSync(join(src, "build", "sub"), { recursive: true });
      writeFileSync(join(src, "build", "keep.txt"), "keep");
      writeFileSync(join(src, "build", "other.txt"), "drop");
      writeFileSync(join(src, "build", "sub", "deep.txt"), "drop");
      writeFileSync(join(src, "app.ts"), "ok");

      const r = await snapshotWorkspace(src, dest);
      expect(existsSync(join(dest, "build", "keep.txt"))).toBe(true);
      expect(existsSync(join(dest, "build", "other.txt"))).toBe(false);
      expect(existsSync(join(dest, "build", "sub"))).toBe(false);
      expect(r.fileCount).toBe(2); // build/keep.txt + app.ts
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("re-include overrides the DEFAULT excludes too, subtree and all", async () => {
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    try {
      writeInclude(src, "node_modules/local-pkg/\ndocs/\n");
      mkdirSync(join(src, "node_modules", "local-pkg", "lib"), { recursive: true });
      mkdirSync(join(src, "node_modules", "other-pkg"), { recursive: true });
      mkdirSync(join(src, "docs"), { recursive: true });
      writeFileSync(join(src, "node_modules", "local-pkg", "lib", "index.js"), "mine");
      writeFileSync(join(src, "node_modules", "other-pkg", "index.js"), "theirs");
      writeFileSync(join(src, "docs", ".DS_Store"), "junk"); // excluded by default, re-included by docs/

      const r = await snapshotWorkspace(src, dest);
      expect(existsSync(join(dest, "node_modules", "local-pkg", "lib", "index.js"))).toBe(true);
      expect(existsSync(join(dest, "node_modules", "other-pkg"))).toBe(false);
      expect(existsSync(join(dest, "docs", ".DS_Store"))).toBe(true);
      expect(r.fileCount).toBe(2);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("a bare pattern reaches into an excluded directory, so matcher and snapshot agree", async () => {
    // isReIncluded("build/notes.keepme", ["*.keepme"]) is true, so the walk has
    // to descend into an excluded `build` to find it — otherwise the predicate
    // and the payload builder disagree about what "carry these regardless"
    // means, which §6.0 forbids.
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    try {
      writeIgnore(src, "build\n");
      writeInclude(src, "*.keepme\n");
      mkdirSync(join(src, "build"), { recursive: true });
      writeFileSync(join(src, "build", "notes.keepme"), "keep");
      writeFileSync(join(src, "build", "out.js"), "drop");

      const r = await snapshotWorkspace(src, dest);
      expect(isReIncluded("build/notes.keepme", ["*.keepme"])).toBe(true);
      expect(existsSync(join(dest, "build", "notes.keepme"))).toBe(true);
      expect(existsSync(join(dest, "build", "out.js"))).toBe(false);
      expect(r.fileCount).toBe(1);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("no hubinclude pattern can put .git or .claude-sesh-mover into a snapshot", async () => {
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    try {
      writeInclude(src, "*\n.git\n.git/\n./.git\n.claude-sesh-mover/\nvendor/\n");
      mkdirSync(join(src, ".git", "objects"), { recursive: true });
      mkdirSync(join(src, "vendor", "lib", ".git"), { recursive: true });
      writeFileSync(join(src, ".git", "config"), "[remote]\n");
      writeFileSync(join(src, ".git", "objects", "blob"), "x");
      writeFileSync(join(src, "vendor", "lib", ".git", "config"), "nested\n");
      writeFileSync(join(src, "vendor", "lib", "index.js"), "code");
      writeFileSync(join(src, "app.ts"), "ok");

      const r = await snapshotWorkspace(src, dest);
      expect(existsSync(join(dest, ".git"))).toBe(false);
      expect(existsSync(join(dest, ".claude-sesh-mover"))).toBe(false);
      expect(existsSync(join(dest, "vendor", "lib", ".git"))).toBe(false);
      expect(existsSync(join(dest, "vendor", "lib", "index.js"))).toBe(true);
      expect(r.fileCount).toBe(2); // vendor/lib/index.js + app.ts
      expect(NEVER_INCLUDABLE).toEqual([".git", ".claude-sesh-mover"]);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("a case-folded .git store is never snapshotted, hubinclude or not", async () => {
    // DEFAULT_WORKSPACE_EXCLUDES is matched case-SENSITIVELY, but macOS and
    // Windows filesystems are not: a store renamed `.GIT` still works there and
    // still readdirs as ".GIT". It was carried into the payload — measured,
    // before and after this task's re-include logic, since an entry the
    // excludes never matched never reached the re-include check at all.
    for (const includeBody of [null, "*\n"]) {
      const src = tmp("sesh-inc-src-");
      const dest = tmp("sesh-inc-dest-");
      try {
        if (includeBody) writeInclude(src, includeBody);
        mkdirSync(join(src, ".GIT"), { recursive: true });
        writeFileSync(join(src, ".GIT", "config"), "[remote]\n  url = SECRET\n");
        writeFileSync(join(src, "app.ts"), "ok");
        const r = await snapshotWorkspace(src, dest);
        expect(existsSync(join(dest, ".GIT"))).toBe(false);
        expect(r.fileCount).toBe(1);
      } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
    }
  });

  it("matches across NFC/NFD spellings, so one committed pattern works on every OS", () => {
    const nfd = "café", nfc = "café"; // macOS hands back NFD; Linux stores what you wrote
    expect(nfd).not.toBe(nfc);
    expect(isReIncluded(`${nfd}/notes.md`, [`${nfc}/`])).toBe(true);
    expect(isReIncluded(`${nfc}/notes.md`, [`${nfd}/`])).toBe(true);
    expect(isReIncluded(`${nfc}/notes.md`, ["cafe/"])).toBe(false);
  });

  it.skipIf(isWindows)("a re-included symlink is still skipped, never followed", async () => {
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    const outside = tmp("sesh-inc-outside-");
    try {
      writeFileSync(join(outside, "secret.txt"), "PRECIOUS\n");
      writeIgnore(src, "linked\n");
      writeInclude(src, "*\n");
      symlinkSync(outside, join(src, "linked"));
      writeFileSync(join(src, "app.ts"), "ok");

      const r = await snapshotWorkspace(src, dest);
      expect(existsSync(join(dest, "linked"))).toBe(false);
      expect(r.symlinksSkipped).toBe(1);
      expect(r.fileCount).toBe(1);
    } finally { for (const d of [src, dest, outside]) rmSync(d, { recursive: true, force: true }); }
  });

  it("unpack refuses payload paths that are plugin or VCS internals", async () => {
    // A bundle this machine produced never contains them (snapshotWorkspace
    // hard-excludes both), so a payload that does is malformed or hostile —
    // and .claude-sesh-mover/hubinclude is the file that decides what the NEXT
    // push ships, which makes planting it an exfiltration primitive.
    const src = tmp("sesh-inc-src-");
    const target = tmp("sesh-inc-target-");
    try {
      mkdirSync(join(src, ".claude-sesh-mover"), { recursive: true });
      mkdirSync(join(src, ".git"), { recursive: true });
      writeFileSync(join(src, ".claude-sesh-mover", "hubinclude"), "*\n");
      writeFileSync(join(src, ".git", "config"), "planted\n");
      writeFileSync(join(src, "ok.txt"), "fine\n");

      const r = await unpackWorkspace(src, target, { force: true });
      expect(r.fileCount).toBe(1);
      expect(r.refused.sort()).toEqual([".claude-sesh-mover", ".git"]);
      expect(existsSync(join(target, ".claude-sesh-mover"))).toBe(false);
      expect(existsSync(join(target, ".git"))).toBe(false);
      expect(readFileSync(join(target, "ok.txt"), "utf-8")).toBe("fine\n");
    } finally { for (const d of [src, target]) rmSync(d, { recursive: true, force: true }); }
  });
});
