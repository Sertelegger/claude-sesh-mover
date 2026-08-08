import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  snapshotWorkspace, unpackWorkspace, isExcluded, readHubignore,
  readHubinclude, isReIncluded, mayContainReIncluded, isNeverIncludable,
  WorkspaceTargetNotEmptyError, DEFAULT_WORKSPACE_EXCLUDES, NEVER_INCLUDABLE,
  WORKSPACE_MAX_BYTES, isCarriedPath, readCarryRules, forEachCarriedFile,
} from "../src/hub/workspace.js";

function tmp(p: string): string { return mkdtempSync(join(tmpdir(), p)); }
const isWindows = platform() === "win32";

/** Every file under `root`, as sorted "/"-joined relative paths. */
function listAll(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listAll(root, childRel));
    else out.push(childRel);
  }
  return out.sort();
}

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
      mkdirSync(join(dir, ".sesh-mover"), { recursive: true });
      writeFileSync(join(dir, ".sesh-mover-hubignore"), "# comment\n\n*.log\nbig-data\n");
      expect(readHubignore(dir)).toEqual(["*.log", "big-data"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("snapshot copies tree honoring excludes at any depth; counts files+bytes", async () => {
    const src = tmp("sesh-ws-src-");
    const dest = tmp("sesh-ws-dest-");
    try {
      mkdirSync(join(src, "src", "node_modules", "x"), { recursive: true });
      mkdirSync(join(src, ".sesh-mover"), { recursive: true });
      writeFileSync(join(src, "a.md"), "hello");
      writeFileSync(join(src, "src", "b.ts"), "world!");
      writeFileSync(join(src, "src", "node_modules", "x", "junk.js"), "junk");
      writeFileSync(join(src, ".sesh-mover", "config.json"), "{}");
      const r = await snapshotWorkspace(src, dest);
      expect(r.fileCount).toBe(2);
      expect(r.byteSize).toBe(5 + 6);
      expect(existsSync(join(dest, "a.md"))).toBe(true);
      expect(existsSync(join(dest, "src", "b.ts"))).toBe(true);
      expect(existsSync(join(dest, "src", "node_modules"))).toBe(false);
      expect(existsSync(join(dest, ".sesh-mover"))).toBe(false);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("never snapshots the project-local .claude tree — settings, hooks, and a config dir living inside the project", async () => {
    // A workspace snapshot is a plain file copy, so before `.claude` was a
    // built-in exclude every git-less project's push uploaded it whole:
    // settings.local.json (permission allowlists, which routinely name paths and
    // hostnames), project-local hooks, and — whenever CLAUDE_CONFIG_DIR points
    // inside the project — every transcript a SECOND time, in the workspace
    // payload rather than the sessions payload the "sessions are secrets"
    // handling applies to. Measured in a real bundle as
    // bundle/workspace/.claude/settings.json and
    // bundle/workspace/.claude/projects/-tmp-…/<session>.jsonl. The default-on
    // SessionEnd auto-push is what made it the ordinary case rather than
    // something a user chose per push.
    const src = tmp("sesh-ws-claude-src-");
    const dest = tmp("sesh-ws-claude-dest-");
    try {
      const encoded = "-tmp-sesh-ws-claude-src";
      const transcript = `${encoded}/550e8400-e29b-41d4-a716-446655440000.jsonl`;
      mkdirSync(join(src, ".claude", "projects", encoded), { recursive: true });
      mkdirSync(join(src, ".claude", "hooks"), { recursive: true });
      mkdirSync(join(src, "src"), { recursive: true });
      writeFileSync(join(src, ".claude", "settings.json"), '{"model":"opus"}\n');
      writeFileSync(
        join(src, ".claude", "settings.local.json"),
        '{"permissions":{"allow":["Bash(ssh prod-01:*)"]}}\n'
      );
      writeFileSync(join(src, ".claude", "hooks", "notify.sh"), "#!/bin/sh\ncurl -d @- https://x\n");
      writeFileSync(join(src, ".claude", "projects", ...transcript.split("/")), '{"type":"user"}\n');
      writeFileSync(join(src, "app.ts"), "real project content\n");
      writeFileSync(join(src, "src", "index.ts"), "more\n");

      const r = await snapshotWorkspace(src, dest);
      expect(existsSync(join(dest, ".claude"))).toBe(false);
      expect(r.fileCount).toBe(2); // app.ts + src/index.ts, and nothing out of .claude
      expect(existsSync(join(dest, "app.ts"))).toBe(true);
      expect(existsSync(join(dest, "src", "index.ts"))).toBe(true);

      // The same rule filters the carry's UNTRACKED half (carry.ts runs
      // `git ls-files --others` through isCarriedPath), so an untracked
      // settings.local.json in a git project stops travelling too. Its TRACKED
      // sibling still rides the `git diff HEAD` patch, which only the
      // NEVER_INCLUDABLE floor filters — see README's tracked/untracked split.
      const rules = readCarryRules(src);
      expect(isCarriedPath(".claude/settings.local.json", rules)).toBe(false);
      expect(isCarriedPath(`.claude/projects/${transcript}`, rules)).toBe(false);
      expect(isCarriedPath("app.ts", rules)).toBe(true);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("creates the payload directory even when it carries nothing, so a declared payload is never absent", async () => {
    // Every other snapshot test here hands `snapshotWorkspace` a dest that
    // mkdtempSync already created, which is why this went unnoticed: the real
    // caller (hub/push.ts) passes `<staging>/workspace`, a path that does NOT
    // exist yet, and the copy pass only ever mkdirs the PARENT of a file it is
    // about to write. Carry zero files and the directory was never created —
    // while push still wrote `manifest.workspace` and declared `hasWorkspace`,
    // so the bundle claimed a payload it did not contain and every puller of it
    // crashed with ENOENT inside the apply step (measured, and see
    // hub-pull.test.ts's end-to-end pair for this).
    //
    // Reachable without any exotic input: an empty project directory (the
    // `mkdir scratch && cd scratch && claude` shape), or a hubignore broad
    // enough to drop the whole tree.
    const src = tmp("sesh-ws-empty-src-");
    const staging = tmp("sesh-ws-empty-stage-");
    const target = tmp("sesh-ws-empty-target-");
    try {
      const dest = join(staging, "workspace");
      const r = await snapshotWorkspace(src, dest);
      expect(r.fileCount).toBe(0);
      expect(r.skipped).toBe(false);
      expect(existsSync(dest)).toBe(true);
      // And it survives the trip a real payload makes: applying an empty
      // payload is a no-op, not a throw.
      const u = await unpackWorkspace(dest, target, { force: true });
      expect(u.fileCount).toBe(0);
    } finally {
      for (const d of [src, staging, target]) rmSync(d, { recursive: true, force: true });
    }
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
      mkdirSync(join(src, ".sesh-mover"), { recursive: true });
      writeFileSync(join(src, ".sesh-mover-hubignore"), "# ignore logs\n*.log\n");
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
      mkdirSync(join(src, ".sesh-mover"), { recursive: true });
      writeFileSync(join(src, ".sesh-mover-hubignore"), "build/\n");
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
    mkdirSync(join(dir, ".sesh-mover"), { recursive: true });
    writeFileSync(join(dir, ".sesh-mover-hubinclude"), body);
  };
  const writeIgnore = (dir: string, body: string): void => {
    mkdirSync(join(dir, ".sesh-mover"), { recursive: true });
    writeFileSync(join(dir, ".sesh-mover-hubignore"), body);
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
      mkdirSync(join(dir, ".sesh-mover-hubinclude"), { recursive: true });
      expect(readHubinclude(dir)).toEqual([]); // a DIRECTORY named hubinclude
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("matches subtrees and globs but never .git or .sesh-mover", () => {
    const pats = ["docs/superpowers/", "*.keepme", ".git", ".sesh-mover"];
    expect(isReIncluded("docs/superpowers/specs/a.md", pats)).toBe(true);
    expect(isReIncluded("docs/other/a.md", pats)).toBe(false);
    expect(isReIncluded("notes.keepme", pats)).toBe(true);
    expect(isReIncluded(".git/config", pats)).toBe(false);              // hard-excluded
    expect(isReIncluded(".sesh-mover/config.json", pats)).toBe(false);
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

  it("a trailing slash roots a one-segment pattern — `docs/` is not the bare form", () => {
    // The single commonest hubinclude line there is: `push.md` offers
    // `ignoredNotCarried` entries to be pasted VERBATIM and forbids widening
    // one, and `git ls-files --directory` spells a wholly-ignored top-level
    // directory as exactly `dist/`. Read as bare (the shipped bug — the empty
    // tail segment is dropped, so the pattern looked one-segment-long), it also
    // carried every nested `dist`, which is the permissive direction.
    expect(isReIncluded("docs/x.md", ["docs/"])).toBe(true);
    expect(isReIncluded("docs/sub/x.md", ["docs/"])).toBe(true);   // its subtree
    expect(isReIncluded("a/b/docs/x.md", ["docs/"])).toBe(false);  // NOT at any depth
    expect(isReIncluded("packages/one/dist/x.js", ["dist/"])).toBe(false);
    expect(isReIncluded("dist/x.js", ["dist/"])).toBe(true);
    // Every other spelling that carries a separator roots the same way…
    for (const rooted of ["docs/", "/docs", "/docs/", "./docs", "docs\\"]) {
      expect(isReIncluded("docs/x.md", [rooted])).toBe(true);
      expect(isReIncluded("a/b/docs/x.md", [rooted])).toBe(false);
    }
    // …and only a pattern with no separator at all is the any-depth form.
    expect(isReIncluded("a/b/docs/x.md", ["docs"])).toBe(true);
    // The walker has to agree, or the payload and the predicate diverge.
    expect(mayContainReIncluded("a/b", ["docs/"])).toBe(false);
    expect(mayContainReIncluded("a/b", ["docs"])).toBe(true);
    expect(mayContainReIncluded("docs", ["docs/sub/"])).toBe(true);
  });

  it("says no to an empty path, an empty pattern list, and patterns that normalize to nothing", () => {
    expect(isReIncluded("a.txt", [])).toBe(false);
    expect(isReIncluded("", ["*"])).toBe(false);
    expect(isReIncluded("a.txt", ["/", ".", "./", "//", "   "])).toBe(false);
  });

  // --- Attacks: every way a pattern might smuggle back a hard-excluded path ---

  it("blocks .git and .sesh-mover at ANY depth, not just the first segment", () => {
    // The obvious implementation checks relPath.split("/")[0]; a vendored
    // submodule then carries a whole .git store through a `vendor/` pattern.
    expect(isReIncluded("vendor/lib/.git/config", ["vendor/"])).toBe(false);
    expect(isReIncluded("vendor/lib/.git", ["vendor/"])).toBe(false);
    expect(isReIncluded("sub/.sesh-mover/config.json", ["sub"])).toBe(false);
    expect(isReIncluded("vendor/lib/.git/config", ["*"])).toBe(false);
    // …and the ordinary file beside it still travels.
    expect(isReIncluded("vendor/lib/index.js", ["vendor/"])).toBe(true);
  });

  it("blocks equivalent spellings of a hard-excluded pattern", () => {
    for (const pattern of [".git", ".git/", "./.git", ".git/config", "x/../.git", "/.git", ".git\\config"]) {
      expect(isReIncluded(".git/config", [pattern])).toBe(false);
    }
    for (const pattern of [".sesh-mover", ".sesh-mover/", "./.sesh-mover-hubinclude"]) {
      expect(isReIncluded(".sesh-mover-hubinclude", [pattern])).toBe(false);
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

  it("matches globs in linear-ish time, at and past every boundary a filesystem can reach", () => {
    // The regex matcher this replaced backtracked ~n^7 on these. Measured
    // through the shipped isReIncluded at EIGHT wildcards — inside the wildcard
    // cap that was supposed to prevent exactly this — a 56-char name took
    // 4.7 s and a 64-char one 13.7 s; hubignore had no cap at all (10 stars vs
    // a 44-char name: 9.6 s). The old test used a 12-star bomb, which the cap
    // DROPPED, so it passed without ever running the matcher it was testing.
    const a = (n: number): string => "a".repeat(n);
    const stars = (n: number): string => "*a".repeat(n) + "b"; // n wildcards
    const started = Date.now();
    for (const n of [3, 8, 9, 12, 127]) {          // at, over, and far over the old cap of 8
      for (const len of [32, 64, 128, 255]) {      // 255 = the longest name a filesystem gives us
        expect(isReIncluded(a(len), [stars(n)])).toBe(false);
        expect(isExcluded(a(len), [stars(n)])).toBe(false);      // hubignore shares the matcher
        expect(isReIncluded(`dir/${a(len)}`, [`dir/${stars(n)}`])).toBe(false);
      }
    }
    // The full hostile load the caps still permit: 500 patterns x one path.
    const many = Array.from({ length: 500 }, () => stars(127));
    expect(isReIncluded(a(255), many)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);

    // And they are no longer DROPPED, which is what the cap used to do: a
    // many-star pattern is honest, just unusual, and it has to still match.
    expect(isReIncluded(a(64) + "b", [stars(12)])).toBe(true);
    expect(isExcluded("axxbxxc", ["*a*b*c*"])).toBe(true);
    // A name containing a literal `*` must not eat the pattern's wildcard.
    expect(isExcluded("*b", ["*"])).toBe(true);
    expect(isExcluded("a*b", ["a*b"])).toBe(true);
    // `*` now crosses a newline, where RegExp's `.` did not — an ignore
    // pattern that silently stopped matching such a name was the unsafe way
    // round, and the hard exclusions never depended on the glob.
    expect(isExcluded("evil\nx.log", ["*.log"])).toBe(true);
    expect(isReIncluded(".git\nfoo/x", ["*"])).toBe(true); // a genuinely different name
    expect(isReIncluded(".git/x", ["*"])).toBe(false);     // …and the real one still cannot travel
  });

  it("caps an enormous pattern file instead of carrying it into every path test, and SAYS it did", () => {
    // Both caps fail closed — fewer re-includes — which from the outside is
    // indistinguishable from "my files just stopped syncing". A caller with
    // somewhere to put it gets a sentence naming the file, the limit and the
    // consequence; a caller that passes nothing still gets the same patterns.
    const dir = tmp("sesh-inc-");
    try {
      writeInclude(dir, Array.from({ length: 5000 }, (_, i) => `p${i}`).join("\n"));
      const overCount: string[] = [];
      expect(readHubinclude(dir, overCount).length).toBe(500);
      expect(overCount).toHaveLength(1);
      expect(overCount[0]).toContain("5000 patterns");
      expect(overCount[0]).toContain("only the first 500");

      writeInclude(dir, "x".repeat(200_000));
      const overBytes: string[] = [];
      expect(readHubinclude(dir, overBytes)).toEqual([]); // over the byte cap: nothing at all
      expect(overBytes).toHaveLength(1);
      expect(overBytes[0]).toContain("200000 bytes");
      expect(overBytes[0]).toContain("ENTIRELY");

      // A file inside both caps is silent.
      const quiet: string[] = [];
      writeInclude(dir, "docs/\n");
      expect(readHubinclude(dir, quiet)).toEqual(["docs/"]);
      expect(quiet).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("warns when the exclude rules swallowed the whole snapshot", async () => {
    // `*/` in hubignore matches every directory entry at every level, so the
    // payload came out empty and nothing said so. It fails safe (an empty
    // payload can delete nothing downstream — upstreamDeleted is report-only)
    // but a silently empty push is not something a user can diagnose.
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    try {
      writeIgnore(src, "*/\n*\n");
      mkdirSync(join(src, "sub"), { recursive: true });
      writeFileSync(join(src, "sub", "a.ts"), "x");
      writeFileSync(join(src, "b.ts"), "y");
      const r = await snapshotWorkspace(src, dest);
      expect(r.fileCount).toBe(0);
      expect(r.warnings.some((w) => w.includes("workspace snapshot is empty"))).toBe(true);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("an empty project produces no empty-snapshot warning, and cap diagnostics reach the snapshot", async () => {
    const empty = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    try {
      expect((await snapshotWorkspace(empty, dest)).warnings).toEqual([]);
      writeInclude(empty, "x".repeat(200_000)); // only .sesh-mover exists
      const r = await snapshotWorkspace(empty, dest);
      expect(r.warnings).toHaveLength(1);       // the cap, not the emptiness
      expect(r.warnings[0]).toContain("hubinclude");
    } finally { for (const d of [empty, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("skips the whole snapshot, copying nothing, when the payload busts the budget", async () => {
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    try {
      mkdirSync(join(src, "assets"), { recursive: true });
      writeFileSync(join(src, "assets", "huge.bin"), "x".repeat(40_000));
      writeFileSync(join(src, "small.txt"), "y");
      const r = await snapshotWorkspace(src, dest, { maxBytes: 4096 });
      expect(r.skipped).toBe(true);
      expect(r.fileCount).toBe(0);
      expect(r.byteSize).toBeGreaterThan(4096);
      // All-or-nothing: a truncated payload reads on the apply side as upstream
      // state, not as an upload that was cut short.
      expect(existsSync(join(dest, "small.txt"))).toBe(false);
      expect(existsSync(join(dest, "assets"))).toBe(false);
      expect(r.warnings.some((w) => w.includes("assets/huge.bin"))).toBe(true);
      expect(r.warnings.some((w) => w.includes("snapshot budget"))).toBe(true);
      // The emptiness warning must not also fire: nothing was "dropped by the
      // excludes" here, and pointing the user at hubignore for that reason
      // would be a wrong diagnosis.
      expect(r.warnings.some((w) => w.includes("snapshot is empty"))).toBe(false);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("bounds the one payload hubinclude made unbounded: `*` re-admitting node_modules", async () => {
    // Before hubinclude existed the built-in excludes made an over-budget
    // payload essentially unreachable. One line changed that, and this is the
    // guard for it.
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    try {
      writeInclude(src, "*\n");
      mkdirSync(join(src, "node_modules", "pkg"), { recursive: true });
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(src, "node_modules", "pkg", `f${i}.js`), "z".repeat(1000));
      }
      writeFileSync(join(src, "index.ts"), "real\n");
      const unbounded = await snapshotWorkspace(src, dest);
      expect(unbounded.skipped).toBe(false);
      expect(unbounded.fileCount).toBe(21); // `*` really does re-admit it
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });

      const r = await snapshotWorkspace(src, dest, { maxBytes: 8192 });
      expect(r.skipped).toBe(true);
      expect(r.warnings.some((w) => w.includes("hubinclude"))).toBe(true);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("WORKSPACE_MAX_BYTES is the 50 MB default, and the carry's now matches it", async () => {
    const { CARRY_MAX_BYTES } = await import("../src/hub/carry.js");
    expect(WORKSPACE_MAX_BYTES).toBe(50 * 1024 * 1024);
    // They disagreed (50 MB vs 5 MB) on the reasoning that a carry is a diff
    // and therefore small. Measured, that was false — this repo's own untracked
    // working notes are ~12.6 MB — so the numbers agree now because the
    // distinction they encoded did not exist, not because the payloads did.
    // They stay SEPARATELY configurable so a user who does find the split real
    // can restore it.
    expect(CARRY_MAX_BYTES).toBe(WORKSPACE_MAX_BYTES);
  });

  it("a budget of 0 skips the snapshot outright, even for an EMPTY project", async () => {
    // The over-budget branch compares `cost > maxBytes`, and an empty project
    // measures 0 — so `0 > 0` is false and a plain reuse of that branch would
    // build an empty payload for a setting that said not to. It is answered
    // before the measuring walk instead.
    for (const seed of [true, false]) {
      const src = tmp("sesh-zero-src-");
      const dest = tmp("sesh-zero-dest-");
      try {
        if (seed) writeFileSync(join(src, "app.ts"), "code\n");
        const r = await snapshotWorkspace(src, dest, { maxBytes: 0 });
        expect(r.skipped).toBe(true);
        expect(r.fileCount).toBe(0);
        expect(r.warnings.join(" ")).toContain("hub.workspaceMaxMb");
        expect(listAll(dest)).toEqual([]);
      } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
    }
  });

  it("a raised budget carries what the old 50 MB default would have declined", async () => {
    const src = tmp("sesh-raise-src-");
    const dest = tmp("sesh-raise-dest-");
    try {
      writeFileSync(join(src, "big.bin"), Buffer.alloc(64 * 1024, 7));
      // Just under, then just over: the budget is the thing being tested, not
      // the tree.
      expect((await snapshotWorkspace(src, dest, { maxBytes: 32 * 1024 })).skipped).toBe(true);
      rmSync(dest, { recursive: true, force: true });
      const ok = await snapshotWorkspace(src, dest, { maxBytes: 128 * 1024 });
      expect(ok.skipped).toBe(false);
      expect(ok.fileCount).toBe(1);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("counts files as well as bytes, so a tree of empty files cannot slip the budget", async () => {
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    try {
      mkdirSync(join(src, "generated"), { recursive: true });
      for (let i = 0; i < 40; i++) writeFileSync(join(src, "generated", `f${i}.txt`), "");
      const r = await snapshotWorkspace(src, dest, { maxBytes: 4096 });
      expect(r.skipped).toBe(true);
      expect(r.warnings.some((w) => w.includes("40 file"))).toBe(true);
      expect(existsSync(join(dest, "generated"))).toBe(false);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  it("isCarriedPath agrees with the walk it stands in for, file by file", async () => {
    // carry.ts filters `git ls-files` output with isCarriedPath while
    // snapshotWorkspace walks the tree with forEachCarriedFile. Two rules for
    // one question is how the payload and the apply side drifted apart before;
    // this is the assertion that keeps them one rule.
    const src = tmp("sesh-inc-src-");
    try {
      writeIgnore(src, "build\n*.log\n");
      writeInclude(src, "build/keep.txt\n*.keepme\n");
      mkdirSync(join(src, "src", "deep"), { recursive: true });
      mkdirSync(join(src, "build", "sub"), { recursive: true });
      mkdirSync(join(src, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(src, ".git"), { recursive: true });
      mkdirSync(join(src, "docs"), { recursive: true });
      const all = [
        "a.ts", "a.log", "docs/x.md", "docs/y.keepme", "src/deep/b.ts",
        "build/keep.txt", "build/other.txt", "build/sub/c.txt",
        "node_modules/pkg/index.js", ".git/config",
      ];
      for (const rel of all) writeFileSync(join(src, ...rel.split("/")), "x");

      const rules = readCarryRules(src);
      const walked: string[] = [];
      forEachCarriedFile(src, rules, (rel) => { walked.push(rel); });
      const predicated = all.filter((rel) => isCarriedPath(rel, rules));
      expect(predicated.sort()).toEqual(walked.sort());
      // Non-vacuous: the set is a real mix of admitted, excluded and re-admitted.
      expect(walked.sort()).toEqual(
        ["a.ts", "build/keep.txt", "docs/x.md", "docs/y.keepme", "src/deep/b.ts"].sort()
      );
    } finally { rmSync(src, { recursive: true, force: true }); }
  });

  it("isCarriedPath refuses paths that escape the project or name internals", () => {
    const rules = { excludePatterns: [...DEFAULT_WORKSPACE_EXCLUDES], includePatterns: ["*"] };
    for (const hostile of [
      "../escape.txt", "../../escape.txt", "/etc/hosts", "C:/Windows/system32",
      ".git/config", "vendor/.git/config", ".sesh-mover/config.json",
      ".GIT/config", ".git./config", "..",
    ]) {
      expect(isCarriedPath(hostile, rules)).toBe(false);
    }
    expect(isCarriedPath("ok.txt", rules)).toBe(true);
  });

  it("NEVER_INCLUDABLE is frozen, not just readonly at compile time", () => {
    expect(Object.isFrozen(NEVER_INCLUDABLE)).toBe(true);
    expect(() => (NEVER_INCLUDABLE as string[]).push(".env")).toThrow();
    // The pre-0.7.0 directory name is on this list PERMANENTLY: bundles
    // carrying it are already on hubs, and dropping it would un-protect every
    // one of them. The three root dotfiles are the 0.7.0 additions — ordinary
    // files at the project root, so nothing but this list stands between a
    // payload and the file deciding what the next push ships.
    expect(NEVER_INCLUDABLE).toEqual([
      ".git",
      ".sesh-mover",
      ".claude-sesh-mover",
      ".sesh-mover-hubinclude",
      ".sesh-mover-hubignore",
      ".sesh-mover-project.json",
    ]);
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
    expect(mayContainReIncluded(".sesh-mover", ["*"])).toBe(false);
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

  it("a hubinclude line naming .claude re-includes it — it is a DEFAULT, not the floor", async () => {
    // The pair to the test below this one, and the reason `.claude` went into
    // DEFAULT_WORKSPACE_EXCLUDES rather than NEVER_INCLUDABLE: the floor holds
    // the names that decide where the hub is and what the next push ships, and
    // nothing names those back. `.claude` is excluded because of what leaves
    // the machine, which is the user's own call — a project-level settings.json
    // or a set of shared agents is ordinary content to carry between your own
    // machines. So the same file, in the same run, must move `.claude` and must
    // not move `.git`.
    const src = tmp("sesh-inc-claude-src-");
    const before = tmp("sesh-inc-claude-before-");
    const after = tmp("sesh-inc-claude-after-");
    try {
      mkdirSync(join(src, ".claude", "agents"), { recursive: true });
      mkdirSync(join(src, ".git"), { recursive: true });
      writeFileSync(join(src, ".claude", "settings.json"), '{"model":"opus"}\n');
      writeFileSync(join(src, ".claude", "agents", "reviewer.md"), "shared agent\n");
      writeFileSync(join(src, ".git", "config"), "[remote]\n  url = SECRET\n");
      writeFileSync(join(src, "app.ts"), "ok\n");

      // Default: dropped, like every other convenience exclude.
      const plain = await snapshotWorkspace(src, before);
      expect(existsSync(join(before, ".claude"))).toBe(false);
      expect(plain.fileCount).toBe(1); // app.ts alone

      // Named back: carried, subtree and all — while the floor does not move.
      writeInclude(src, ".claude\n.git\n");
      const r = await snapshotWorkspace(src, after);
      expect(existsSync(join(after, ".claude", "settings.json"))).toBe(true);
      expect(existsSync(join(after, ".claude", "agents", "reviewer.md"))).toBe(true);
      expect(existsSync(join(after, ".git"))).toBe(false);
      expect(r.fileCount).toBe(3); // app.ts + both .claude files, never .git/config
    } finally {
      for (const d of [src, before, after]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("no hubinclude pattern can put .git or plugin state into a snapshot", async () => {
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    try {
      writeInclude(src, "*\n.git\n.git/\n./.git\n.sesh-mover/\nvendor/\n");
      mkdirSync(join(src, ".git", "objects"), { recursive: true });
      mkdirSync(join(src, "vendor", "lib", ".git"), { recursive: true });
      writeFileSync(join(src, ".git", "config"), "[remote]\n");
      writeFileSync(join(src, ".git", "objects", "blob"), "x");
      writeFileSync(join(src, "vendor", "lib", ".git", "config"), "nested\n");
      writeFileSync(join(src, "vendor", "lib", "index.js"), "code");
      writeFileSync(join(src, "app.ts"), "ok");

      const r = await snapshotWorkspace(src, dest);
      expect(existsSync(join(dest, ".git"))).toBe(false);
      expect(existsSync(join(dest, ".sesh-mover"))).toBe(false);
      expect(existsSync(join(dest, "vendor", "lib", ".git"))).toBe(false);
      expect(existsSync(join(dest, "vendor", "lib", "index.js"))).toBe(true);
      expect(r.fileCount).toBe(2); // vendor/lib/index.js + app.ts
      expect(NEVER_INCLUDABLE).toEqual([
      ".git",
      ".sesh-mover",
      ".claude-sesh-mover",
      ".sesh-mover-hubinclude",
      ".sesh-mover-hubignore",
      ".sesh-mover-project.json",
    ]);
    } finally { for (const d of [src, dest]) rmSync(d, { recursive: true, force: true }); }
  });

  // The 0.7.0 rename made two things newly reachable, and they are the reason
  // the floor grew rather than moved: the OLD directory name still sits inside
  // bundles already on hubs, and the committed rule files are now ordinary
  // root dotfiles that a payload can name directly with no directory in the
  // way. Both spellings, both sides (carry and apply), and every fold the
  // existing check already handles.
  const FLOOR_SPELLINGS = [
    ".sesh-mover", ".claude-sesh-mover",
    ".sesh-mover-hubinclude", ".sesh-mover-hubignore", ".sesh-mover-project.json",
    ".SESH-MOVER-HUBINCLUDE", ".Claude-Sesh-Mover", ".sesh-mover-hubinclude.",
    ".sesh-mover-hubinclude ", ".sesh-mover-project.json...",
  ];

  it("the floor refuses every plugin-state spelling on the CARRY side, at any depth", async () => {
    for (const name of FLOOR_SPELLINGS) {
      // `isNeverIncludable` is the predicate every carry path shares; the
      // per-path assertion below is what `forEachCarriedFile`, `isCarriedPath`
      // and carry.ts's patch scan all consult.
      expect([name, isNeverIncludable(name)]).toEqual([name, true]);
      expect([name, isNeverIncludable(`deep/nested/${name}`)]).toEqual([name, true]);
      expect([name, isNeverIncludable(`${name}/inside.txt`)]).toEqual([name, true]);
      // No hubinclude pattern digs under it, however it is spelled.
      expect([name, isReIncluded(name, ["*", name, `${name}/`])]).toEqual([name, false]);
      expect([name, isCarriedPath(name, { excludePatterns: [], includePatterns: ["*"] })])
        .toEqual([name, false]);
    }
  });

  it("the floor keeps every plugin-state spelling out of a snapshot and out of an unpack", async () => {
    const src = tmp("sesh-floor-src-");
    const dest = tmp("sesh-floor-dest-");
    const target = tmp("sesh-floor-target-");
    try {
      // `*` re-admits everything the convenience excludes drop, so anything
      // still missing below was stopped by the floor and nothing else.
      writeInclude(src, "*\n");
      writeFileSync(join(src, "app.ts"), "ok\n");
      for (const name of FLOOR_SPELLINGS) {
        // Skip the spellings a filesystem cannot distinguish from one already
        // written (macOS/Windows fold case and strip trailing dots/spaces).
        if (existsSync(join(src, name))) continue;
        try {
          writeFileSync(join(src, name), "planted\n");
        } catch {
          continue; // Win32 refuses some of these names outright
        }
      }
      mkdirSync(join(src, "sub", ".sesh-mover"), { recursive: true });
      writeFileSync(join(src, "sub", ".sesh-mover", "config.json"), '{"hub":{"path":"/evil"}}');
      mkdirSync(join(src, "sub", ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(src, "sub", ".claude-sesh-mover", "hubinclude"), "*\n");

      const snap = await snapshotWorkspace(src, dest);
      expect(snap.fileCount).toBe(1); // app.ts, and nothing else
      expect(listAll(dest)).toEqual(["app.ts"]);

      // Apply side: the same tree offered as a PAYLOAD (which a current
      // sesh-mover never produces — this is the hand-made/older-version case).
      const r = await unpackWorkspace(src, target, { force: true });
      expect(listAll(target)).toEqual(["app.ts"]);
      expect(r.refused.length).toBeGreaterThan(0);
      for (const p of r.refused) expect([p, isNeverIncludable(p)]).toEqual([p, true]);
    } finally {
      for (const d of [src, dest, target]) rmSync(d, { recursive: true, force: true });
    }
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

  it.skipIf(isWindows)("a symlink NAMED .git is skipped AND counted, not silently dropped", async () => {
    // The hard-exclusion check fires before the symlink branch, so this one
    // link was invisible in the snapshot's own report: right outcome, wrong
    // accounting. It is still never followed.
    const src = tmp("sesh-inc-src-");
    const dest = tmp("sesh-inc-dest-");
    const outside = tmp("sesh-inc-outside-");
    try {
      mkdirSync(join(outside, "objects"), { recursive: true });
      writeFileSync(join(outside, "config"), "[remote]\n  url = SECRET\n");
      symlinkSync(outside, join(src, ".git"));
      writeInclude(src, "*\n.git\n");
      writeFileSync(join(src, "app.ts"), "ok");

      const r = await snapshotWorkspace(src, dest);
      expect(existsSync(join(dest, ".git"))).toBe(false);
      expect(r.fileCount).toBe(1);
      expect(r.symlinksSkipped).toBe(1);
    } finally { for (const d of [src, dest, outside]) rmSync(d, { recursive: true, force: true }); }
  });

  it("unpack refuses payload paths that are plugin or VCS internals", async () => {
    // A bundle this machine produced never contains them (snapshotWorkspace
    // hard-excludes both), so a payload that does is malformed or hostile —
    // and .sesh-mover-hubinclude is the file that decides what the NEXT
    // push ships, which makes planting it an exfiltration primitive.
    const src = tmp("sesh-inc-src-");
    const target = tmp("sesh-inc-target-");
    try {
      mkdirSync(join(src, ".sesh-mover"), { recursive: true });
      mkdirSync(join(src, ".git"), { recursive: true });
      writeFileSync(join(src, ".sesh-mover-hubinclude"), "*\n");
      writeFileSync(join(src, ".git", "config"), "planted\n");
      writeFileSync(join(src, "ok.txt"), "fine\n");

      const r = await unpackWorkspace(src, target, { force: true });
      expect(r.fileCount).toBe(1);
      expect(r.refused.sort()).toEqual([".git", ".sesh-mover", ".sesh-mover-hubinclude"]);
      expect(existsSync(join(target, ".sesh-mover"))).toBe(false);
      expect(existsSync(join(target, ".git"))).toBe(false);
      expect(readFileSync(join(target, "ok.txt"), "utf-8")).toBe("fine\n");
    } finally { for (const d of [src, target]) rmSync(d, { recursive: true, force: true }); }
  });
});
