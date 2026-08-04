import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  snapshotWorkspace, unpackWorkspace, isExcluded, readHubignore,
  WorkspaceTargetNotEmptyError, DEFAULT_WORKSPACE_EXCLUDES,
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
});
