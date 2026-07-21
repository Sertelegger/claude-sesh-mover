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
