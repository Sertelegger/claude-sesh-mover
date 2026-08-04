import { describe, it, expect } from "vitest";
import {
  chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isBinaryFile, isGitMergeFileAvailable, mergeWorkspaceTrees, MergeAncestorRequiredError,
} from "../src/hub/merge.js";
import { overridePath } from "./helpers/env.js";

const isWindows = platform() === "win32";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function put(dir: string, rel: string, content: string | Buffer): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** Three sibling trees under one disposable root. */
function trees(): { root: string; a: string; i: string; t: string } {
  const root = tmp("sesh-merge-");
  const a = join(root, "ancestor");
  const i = join(root, "incoming");
  const t = join(root, "target");
  for (const d of [a, i, t]) mkdirSync(d, { recursive: true });
  return { root, a, i, t };
}

/**
 * A file whose local and incoming edits are separated by `gap` untouched
 * lines. gap === 0 means the two edits are on adjacent lines.
 */
function gapped(gap: number): { base: string; local: string; incoming: string } {
  const mid = Array.from({ length: gap }, (_, j) => `m${j}`);
  const lines = (first: string, last: string): string =>
    [first, ...mid, last].join("\n") + "\n";
  return {
    base: lines("A", "B"),
    local: lines("LOCAL", "B"),
    incoming: lines("A", "INCOMING"),
  };
}

describe("merge helpers", () => {
  it("detects binaries by a NUL byte", () => {
    const dir = tmp("sesh-merge-");
    try {
      put(dir, "t.txt", "plain text\n");
      put(dir, "b.bin", Buffer.from([0x61, 0x00, 0x62]));
      expect(isBinaryFile(join(dir, "t.txt"))).toBe(false);
      expect(isBinaryFile(join(dir, "b.bin"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sniffs only the first 8 KB for the NUL byte", () => {
    const dir = tmp("sesh-merge-");
    try {
      // NUL at byte 8191 (inside the window) vs byte 8192 (just outside it).
      put(dir, "inside.bin", Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from([0x00])]));
      put(dir, "outside.bin", Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0x00])]));
      expect(isBinaryFile(join(dir, "inside.bin"))).toBe(true);
      expect(isBinaryFile(join(dir, "outside.bin"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports git merge-file as available", async () => {
    // git is a test prerequisite; the probe runs a real 3-way merge.
    expect(await isGitMergeFileAvailable()).toBe(true);
  });

  // The probe runs a real merge, so it is exposed to ambient repo config the
  // same way the merge is: standing in a repo whose `merge.conflictStyle` is
  // invalid, `git merge-file` exits 128 even with `--diff3` passed (config is
  // validated before the flag applies), and the probe would report a perfectly
  // good git as unusable. It runs in its own temp dir for that reason.
  it("reports git merge-file as available from inside a repo with a broken config", async () => {
    const repo = tmp("sesh-merge-badrepo-");
    const cwdBefore = process.cwd();
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: repo });
      execFileSync("git", ["config", "merge.conflictStyle", "bogusstyle"], { cwd: repo });
      process.chdir(repo);
      expect(await isGitMergeFileAvailable()).toBe(true);
    } finally {
      process.chdir(cwdBefore);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports git merge-file as unavailable when git is not on PATH", async () => {
    const empty = tmp("sesh-merge-nopath-");
    const handle = overridePath(empty);
    try {
      expect(await isGitMergeFileAvailable()).toBe(false);
    } finally {
      handle.restore();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("mergeWorkspaceTrees — per-file resolution", () => {
  it("takes incoming when local is unchanged", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "f.txt", "v1\n");
      put(t, "f.txt", "v1\n");
      put(i, "f.txt", "v2\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.taken).toEqual(["f.txt"]);
      expect(readFileSync(join(t, "f.txt"), "utf-8")).toBe("v2\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps local when incoming is unchanged", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "f.txt", "v1\n");
      put(i, "f.txt", "v1\n");
      put(t, "f.txt", "mine\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.kept).toEqual(["f.txt"]);
      expect(readFileSync(join(t, "f.txt"), "utf-8")).toBe("mine\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("3-way merges separated edits on both sides cleanly", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "f.txt", "1\n2\n3\n4\n5\n6\n7\n");
      put(t, "f.txt", "1\nLOCAL\n3\n4\n5\n6\n7\n");
      put(i, "f.txt", "1\n2\n3\n4\n5\nINCOMING\n7\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.merged).toEqual(["f.txt"]);
      expect(r.conflicted).toEqual([]);
      const out = readFileSync(join(t, "f.txt"), "utf-8");
      expect(out).toContain("LOCAL");
      expect(out).toContain("INCOMING");
      expect(out).not.toContain("<<<<<<<");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes diff3-labeled conflict markers when both sides edit the same region", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "f.txt", "1\n2\n3\n");
      put(t, "f.txt", "1\nLOCAL\n3\n");
      put(i, "f.txt", "1\nINCOMING\n3\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.conflicted).toEqual(["f.txt"]);
      const out = readFileSync(join(t, "f.txt"), "utf-8");
      expect(out).toContain("<<<<<<< local");
      // The ancestor section only appears because we pass --diff3 explicitly.
      // It is the ONLY place a user can see what the common ancestor said:
      // there is no repository here to recover it from.
      expect(out).toContain("||||||| ancestor");
      expect(out).toContain("2\n");
      expect(out).toContain(">>>>>>> incoming");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Brackets the diff3 adjacency rule from BOTH sides, so the test fails if
  // git's hunk-merging behavior changes in either direction rather than merely
  // documenting today's output: zero untouched lines between the two edits is
  // a conflict, one untouched line is a clean merge.
  it("conflicts on adjacent-line edits but merges cleanly across a single untouched line", async () => {
    const outcomeAtGap = async (gap: number): Promise<"merged" | "conflicted" | "other"> => {
      const { root, a, i, t } = trees();
      try {
        const g = gapped(gap);
        put(a, "f.txt", g.base);
        put(t, "f.txt", g.local);
        put(i, "f.txt", g.incoming);
        const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
        if (r.merged.length === 1 && r.conflicted.length === 0) return "merged";
        if (r.conflicted.length === 1 && r.merged.length === 0) return "conflicted";
        return "other";
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    expect(await outcomeAtGap(0)).toBe("conflicted");
    expect(await outcomeAtGap(1)).toBe("merged");
  });

  // `git merge-file` returns the conflict count as its exit status but CLAMPS
  // it at 127 (verified: 128 conflict hunks -> exit 127, 600 -> exit 127).
  // 127 must therefore stay inside the "this is a conflict count" band; a
  // reader who assumed the status was exact and treated 127 as a sentinel
  // would silently report a badly conflicted file as cleanly merged.
  it("reports a file with more than 127 conflict hunks as conflicted", async () => {
    const { root, a, i, t } = trees();
    try {
      const hunks = 130;
      const build = (marker: string | null): string => {
        const lines: string[] = [];
        for (let n = 0; n < hunks; n++) {
          lines.push(marker === null ? `a${n}` : `${marker}${n}`);
          for (let j = 0; j < 10; j++) lines.push(`c${n}_${j}`);
        }
        return lines.join("\n") + "\n";
      };
      put(a, "f.txt", build(null));
      put(t, "f.txt", build("L"));
      put(i, "f.txt", build("I"));
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.conflicted).toEqual(["f.txt"]);
      expect(r.merged).toEqual([]);
      expect(r.sidecars).toEqual([]);
      const out = readFileSync(join(t, "f.txt"), "utf-8");
      expect(out.split("<<<<<<< local").length - 1).toBe(hunks);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves CRLF line endings and still writes markers on a CRLF conflict", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "f.txt", "1\r\n2\r\n3\r\n");
      put(t, "f.txt", "1\r\nLOCAL\r\n3\r\n");
      put(i, "f.txt", "1\r\nINCOMING\r\n3\r\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.conflicted).toEqual(["f.txt"]);
      const out = readFileSync(join(t, "f.txt"), "utf-8");
      // git matches the file's dominant line ending on the marker lines too,
      // so a CRLF file does not come back with mixed endings.
      expect(out).toContain("<<<<<<< local\r\n");
      expect(out).toContain("||||||| ancestor\r\n");
      expect(out).toContain(">>>>>>> incoming\r\n");
      expect(out).not.toMatch(/[^\r]\n/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sidecars binaries changed on both sides, keeping local", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "img.bin", Buffer.from([1, 0, 2]));
      put(t, "img.bin", Buffer.from([1, 0, 9]));
      put(i, "img.bin", Buffer.from([1, 0, 7]));
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.sidecars).toHaveLength(1);
      expect(r.sidecars[0]!.path).toBe("img.bin");
      expect(r.sidecars[0]!.reason).toBe("binary");
      expect(readFileSync(join(t, "img.bin"))).toEqual(Buffer.from([1, 0, 9])); // local kept
      const sidecar = readdirSync(t).find((f) => f.startsWith("img.bin.theirs-"));
      expect(sidecar).toBeTruthy();
      // Reported workspace-relative, like every other path in the report.
      expect(r.sidecars[0]!.sidecar).toBe(sidecar);
      expect(readFileSync(join(t, sidecar!))).toEqual(Buffer.from([1, 0, 7]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The stamp is PINNED, not raced. Within one run a file is sidecarred at
  // most once, so the uniquification branch can only fire against a sidecar
  // left by an earlier run carrying the same stamp — and the stamp has
  // millisecond precision. Written as "run two merges and assert the names
  // differ", this test passed 8 runs in 10 with COPYFILE_EXCL deleted, because
  // the names differed by clock rather than by the guard.
  it("never overwrites an existing sidecar, it uniquifies the name", async () => {
    const { root, a, i, t } = trees();
    const stamp = "2026-01-02T03-04-05-678Z";
    try {
      put(a, "img.bin", Buffer.from([1, 0, 2]));
      put(t, "img.bin", Buffer.from([1, 0, 9]));
      put(i, "img.bin", Buffer.from([1, 0, 7]));
      const opts = { ancestorDir: a, incomingDir: i, targetDir: t, __sidecarStamp: stamp };
      const first = await mergeWorkspaceTrees(opts);
      expect(first.sidecars[0]!.sidecar).toBe(`img.bin.theirs-${stamp}`);
      // Second pull under the SAME stamp: the first sidecar must survive.
      put(i, "img.bin", Buffer.from([1, 0, 5]));
      const second = await mergeWorkspaceTrees(opts);
      expect(second.sidecars).toHaveLength(1);
      expect(second.sidecars[0]!.sidecar).toBe(`img.bin.theirs-${stamp}-2`);
      expect(readFileSync(join(t, first.sidecars[0]!.sidecar))).toEqual(Buffer.from([1, 0, 7]));
      expect(readFileSync(join(t, second.sidecars[0]!.sidecar))).toEqual(Buffer.from([1, 0, 5]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports io-error when every sidecar name is already taken", async () => {
    const { root, a, i, t } = trees();
    const stamp = "2026-01-02T03-04-05-678Z";
    try {
      put(a, "img.bin", Buffer.from([1, 0, 2]));
      put(t, "img.bin", Buffer.from([1, 0, 9]));
      put(i, "img.bin", Buffer.from([1, 0, 7]));
      // Occupy the stem and every one of the 99 uniquified names.
      const stem = `img.bin.theirs-${stamp}`;
      put(t, stem, "taken");
      for (let n = 2; n <= 100; n++) put(t, `${stem}-${n}`, "taken");
      const r = await mergeWorkspaceTrees({
        ancestorDir: a, incomingDir: i, targetDir: t, __sidecarStamp: stamp,
      });
      expect(r.sidecars).toEqual([]);
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped[0]!.path).toBe("img.bin");
      expect(r.skipped[0]!.reason).toBe("io-error");
      expect(r.skipped[0]!.detail).toContain("100 attempts");
      // Nothing was overwritten, and the local file is untouched.
      expect(readFileSync(join(t, stem), "utf-8")).toBe("taken");
      expect(readFileSync(join(t, `${stem}-100`), "utf-8")).toBe("taken");
      expect(readFileSync(join(t, "img.bin"))).toEqual(Buffer.from([1, 0, 9]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates files absent locally, and never deletes files removed upstream", async () => {
    const { root, a, i, t } = trees();
    try {
      put(i, "new.txt", "hello\n");
      put(a, "gone.txt", "x\n");
      put(t, "gone.txt", "x\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.created).toEqual(["new.txt"]);
      expect(r.upstreamDeleted).toEqual(["gone.txt"]);
      expect(existsSync(join(t, "gone.txt"))).toBe(true);
      // A file the ancestor never had is a plain create, never a resurrection.
      expect(r.localDeleted).toEqual([]);
      expect(r.restored).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors a local deletion instead of resurrecting the file on every pull", async () => {
    const { root, a, i, t } = trees();
    try {
      // In the ancestor (this machine had it at the last sync) and still on the
      // peer, unchanged there — so its absence here is a deliberate deletion.
      put(a, "dropped.txt", "v1\n");
      put(i, "dropped.txt", "v1\n");
      put(i, "fresh.txt", "new\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.localDeleted).toEqual(["dropped.txt"]);
      expect(r.created).toEqual(["fresh.txt"]);
      expect(r.restored).toEqual([]);
      expect(existsSync(join(t, "dropped.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores a locally-deleted file that was CHANGED upstream, and reports it separately", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "dropped.txt", "v1\n");
      put(i, "dropped.txt", "v2 — edited on the other machine\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.restored).toEqual(["dropped.txt"]);
      expect(r.created).toEqual([]);
      expect(r.localDeleted).toEqual([]);
      expect(readFileSync(join(t, "dropped.txt"), "utf-8")).toBe(
        "v2 — edited on the other machine\n"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(isWindows)("reports a path hidden behind a local symlink as SKIPPED, not as a local deletion", async () => {
    const { root, a, i, t } = trees();
    try {
      // The tree scan never follows symlinks, so docs/note.md is invisible
      // locally — and to the deletion rule alone it is indistinguishable from
      // a file the user removed. It is not: classifying the destination first
      // separates them, so the caller can say "nothing was written near this"
      // instead of telling the user about a deletion they did not make.
      const outside = join(root, "outside");
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(t, "docs"));
      put(a, join("docs", "note.md"), "v1\n");
      put(i, join("docs", "note.md"), "v1\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.skipped).toEqual([{ path: "docs/note.md", reason: "local-symlink" }]);
      expect(r.localDeleted).toEqual([]);
      expect(existsSync(join(outside, "note.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a path occupied by a directory as SKIPPED, not as a local deletion", async () => {
    const { root, a, i, t } = trees();
    try {
      // Same separation without needing symlinks (so it runs on Windows too):
      // a directory sits where the file goes, the tree scan lists no file at
      // that path, and "you deleted it" would be a fabrication.
      mkdirSync(join(t, "note.md"), { recursive: true });
      put(a, "note.md", "v1\n");
      put(i, "note.md", "v1\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.skipped).toEqual([{ path: "note.md", reason: "local-not-a-file" }]);
      expect(r.localDeleted).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("both-added with differing content conflicts against an empty ancestor", async () => {
    const { root, a, i, t } = trees();
    try {
      put(t, "both.txt", "mine\n");
      put(i, "both.txt", "theirs\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.conflicted).toEqual(["both.txt"]);
      expect(readFileSync(join(t, "both.txt"), "utf-8")).toContain("<<<<<<< local");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("identical content on both sides is a no-op", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "f.txt", "v1\n");
      put(t, "f.txt", "same\n");
      put(i, "f.txt", "same\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.merged).toEqual([]);
      expect(r.conflicted).toEqual([]);
      expect(r.taken).toEqual([]);
      expect(r.kept).toEqual([]);
      expect(r.sidecars).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports nested paths workspace-relative with forward slashes on every platform", async () => {
    const { root, a, i, t } = trees();
    try {
      put(i, join("sub", "deep", "new.txt"), "hi\n");
      put(a, join("sub", "old.txt"), "v1\n");
      put(t, join("sub", "old.txt"), "v1\n");
      put(i, join("sub", "old.txt"), "v2\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.created).toEqual(["sub/deep/new.txt"]);
      expect(r.taken).toEqual(["sub/old.txt"]);
      expect(readFileSync(join(t, "sub", "deep", "new.txt"), "utf-8")).toBe("hi\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors the default workspace excludes and the target's hubignore", async () => {
    const { root, a, i, t } = trees();
    try {
      mkdirSync(join(t, ".claude-sesh-mover"), { recursive: true });
      writeFileSync(join(t, ".claude-sesh-mover", "hubignore"), "# mine\n*.log\n");
      put(a, "debug.log", "old\n");
      put(t, "debug.log", "local log\n");
      put(i, "debug.log", "remote log\n");
      put(a, join("node_modules", "x.js"), "old\n");
      put(t, join("node_modules", "x.js"), "local\n");
      put(i, join("node_modules", "x.js"), "remote\n");
      put(a, "kept.txt", "v1\n");
      put(t, "kept.txt", "v1\n");
      put(i, "kept.txt", "v2\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.taken).toEqual(["kept.txt"]);
      expect(readFileSync(join(t, "debug.log"), "utf-8")).toBe("local log\n");
      expect(readFileSync(join(t, "node_modules", "x.js"), "utf-8")).toBe("local\n");
      const everything = [
        ...r.taken, ...r.kept, ...r.created, ...r.merged, ...r.conflicted,
        ...r.upstreamDeleted, ...r.sidecars.map((s) => s.path), ...r.skipped.map((s) => s.path),
      ];
      expect(everything).toEqual(["kept.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws rather than conflict-marking the whole tree when no ancestor is given", async () => {
    const { root, i, t } = trees();
    try {
      put(t, "f.txt", "mine\n");
      put(i, "f.txt", "theirs\n");
      await expect(
        mergeWorkspaceTrees({ ancestorDir: null, incomingDir: i, targetDir: t })
      ).rejects.toBeInstanceOf(MergeAncestorRequiredError);
      expect(readFileSync(join(t, "f.txt"), "utf-8")).toBe("mine\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mergeWorkspaceTrees — hostile and degenerate trees", () => {
  it.skipIf(isWindows)("never writes through a symlink that occupies a target path", async () => {
    const { root, a, i, t } = trees();
    try {
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "PRECIOUS\n");
      symlinkSync(outside, join(t, "link.txt"));
      put(i, "link.txt", "incoming\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.created).toEqual([]);
      expect(r.skipped).toEqual([{ path: "link.txt", reason: "local-symlink" }]);
      expect(readFileSync(outside, "utf-8")).toBe("PRECIOUS\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(isWindows)("never writes through a symlinked parent directory", async () => {
    const { root, a, i, t } = trees();
    try {
      const outside = join(root, "outside");
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(t, "docs"));
      put(i, join("docs", "note.md"), "incoming\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.created).toEqual([]);
      expect(r.skipped).toEqual([{ path: "docs/note.md", reason: "local-symlink" }]);
      expect(existsSync(join(outside, "note.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips instead of crashing when a directory occupies a file's path", async () => {
    const { root, a, i, t } = trees();
    try {
      mkdirSync(join(t, "docs"), { recursive: true });
      writeFileSync(join(t, "docs", "inner.md"), "local\n");
      put(i, "docs", "incoming file where local has a directory\n");
      put(i, "ok.txt", "fine\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.skipped).toEqual([{ path: "docs", reason: "local-not-a-file" }]);
      // The rest of the merge still runs.
      expect(r.created).toEqual(["ok.txt"]);
      expect(readFileSync(join(t, "docs", "inner.md"), "utf-8")).toBe("local\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips instead of crashing when a file occupies a directory's path", async () => {
    const { root, a, i, t } = trees();
    try {
      writeFileSync(join(t, "docs"), "local file\n");
      put(i, join("docs", "note.md"), "incoming\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.skipped).toEqual([{ path: "docs/note.md", reason: "local-not-a-file" }]);
      expect(readFileSync(join(t, "docs"), "utf-8")).toBe("local file\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not clobber a case-folded neighbour on a case-insensitive filesystem", async () => {
    const { root, a, i, t } = trees();
    try {
      put(t, "readme.md", "LOCAL\n");
      const caseInsensitive = existsSync(join(t, "README.md"));
      put(i, "README.md", "INCOMING\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      if (caseInsensitive) {
        expect(r.created).toEqual([]);
        expect(r.skipped).toEqual([{ path: "README.md", reason: "name-collision" }]);
        expect(readFileSync(join(t, "readme.md"), "utf-8")).toBe("LOCAL\n");
      } else {
        // Case-sensitive filesystem: two genuinely distinct files.
        expect(r.created).toEqual(["README.md"]);
        expect(readFileSync(join(t, "readme.md"), "utf-8")).toBe("LOCAL\n");
        expect(readFileSync(join(t, "README.md"), "utf-8")).toBe("INCOMING\n");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(isWindows)("preserves the local file's mode through a merge", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "run.sh", "1\n2\n3\n4\n5\n6\n7\n");
      put(t, "run.sh", "1\nLOCAL\n3\n4\n5\n6\n7\n");
      put(i, "run.sh", "1\n2\n3\n4\n5\nINCOMING\n7\n");
      chmodSync(join(t, "run.sh"), 0o755);
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.merged).toEqual(["run.sh"]);
      expect(statSync(join(t, "run.sh")).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `copyFileSync` propagates the SOURCE's mode onto the destination it
  // creates, and the three scratch slots are reused for every file that needs a
  // real 3-way merge. So one 0444 file anywhere in ANY of the three trees used
  // to leave a slot read-only for the rest of the run: every later copy into it
  // failed EACCES, and the merge silently under-delivered for an arbitrary
  // suffix of the tree (order-dependent, so it presents as "merges randomly
  // stop working"). Modes survive snapshot -> tar -> unpack, so the trigger
  // arrives in a peer's bundle, not just from a local oddity.
  //
  // Vacuous if the suite is ever run as root, which ignores the mode bits.
  it.skipIf(isWindows)("a read-only file does not disable merging for the rest of the tree", async () => {
    const sortsFirst = "a.txt"; // deliberately first, so the damage lands on b/c
    for (const which of ["incoming", "local", "ancestor"] as const) {
      const { root, a, i, t } = trees();
      const dirFor = { ancestor: a, incoming: i, local: t }[which];
      try {
        for (const name of [sortsFirst, "b.txt", "c.txt"]) {
          // Separated edits on both sides: each of these needs the real engine.
          put(a, name, "1\n2\n3\n4\n5\n6\n7\n");
          put(t, name, "1\nLOCAL\n3\n4\n5\n6\n7\n");
          put(i, name, "1\n2\n3\n4\n5\nINCOMING\n7\n");
        }
        chmodSync(join(dirFor, sortsFirst), 0o444);
        const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
        expect({ which, merged: r.merged, skipped: r.skipped, sidecars: r.sidecars })
          .toEqual({ which, merged: [sortsFirst, "b.txt", "c.txt"], skipped: [], sidecars: [] });
        for (const name of [sortsFirst, "b.txt", "c.txt"]) {
          const out = readFileSync(join(t, name), "utf-8");
          expect(out).toContain("LOCAL");
          expect(out).toContain("INCOMING");
        }
      } finally {
        chmodSync(join(dirFor, sortsFirst), 0o644);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  // git writes the merge RESULT into the scratch copy of the local file, so a
  // read-only local file must not make its own merge impossible — and the mode
  // it gets back must still be its own, not the scratch file's.
  it.skipIf(isWindows)("merges a read-only local file and gives it its mode back", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "ro.txt", "1\n2\n3\n4\n5\n6\n7\n");
      put(t, "ro.txt", "1\nLOCAL\n3\n4\n5\n6\n7\n");
      put(i, "ro.txt", "1\n2\n3\n4\n5\nINCOMING\n7\n");
      chmodSync(join(t, "ro.txt"), 0o444);
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.merged).toEqual(["ro.txt"]);
      expect(statSync(join(t, "ro.txt")).mode & 0o777).toBe(0o444);
      expect(readFileSync(join(t, "ro.txt"), "utf-8")).toContain("INCOMING");
    } finally {
      chmodSync(join(t, "ro.txt"), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The atomic write's temp path is the one write in the module that does NOT
  // go through classifyDestination. With the old fixed `.<name>.sesh-merge.tmp`
  // name, planting a symlink there overwrote a file outside the project AND
  // left the project file a symlink (verified against the pre-fix build).
  it.skipIf(isWindows)("does not write through a symlink planted at a predictable temp path", async () => {
    const { root, a, i, t } = trees();
    try {
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "PRECIOUS\n");
      put(a, "f.txt", "v1\n");
      put(t, "f.txt", "v1\n");
      put(i, "f.txt", "v2\n");
      symlinkSync(outside, join(t, ".f.txt.sesh-merge.tmp"));
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.taken).toEqual(["f.txt"]);
      expect(readFileSync(outside, "utf-8")).toBe("PRECIOUS\n");
      expect(lstatSync(join(t, "f.txt")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(t, "f.txt"), "utf-8")).toBe("v2\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The platform contract the temp write's COPYFILE_EXCL rests on. Once the
  // temp name carries random bytes no test can plant a symlink on it, so pin
  // the assumption itself: EXCL must REFUSE a symlink destination rather than
  // follow it, live or dangling. A plain copy follows it and escapes.
  it.skipIf(isWindows)("COPYFILE_EXCL refuses a symlink destination instead of following it", () => {
    const dir = tmp("sesh-merge-");
    try {
      put(dir, "src", "SRC\n");
      put(dir, "victim", "VICTIM\n");
      symlinkSync(join(dir, "victim"), join(dir, "live"));
      symlinkSync(join(dir, "nothere"), join(dir, "dangling"));
      for (const link of ["live", "dangling"]) {
        expect(() => copyFileSync(join(dir, "src"), join(dir, link), constants.COPYFILE_EXCL))
          .toThrow(expect.objectContaining({ code: "EEXIST" }));
      }
      expect(readFileSync(join(dir, "victim"), "utf-8")).toBe("VICTIM\n");
      // Without the flag the same call writes straight through the link.
      copyFileSync(join(dir, "src"), join(dir, "live"));
      expect(readFileSync(join(dir, "victim"), "utf-8")).toBe("SRC\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An incoming file carrying the old temp name was reported in `created` and
  // then silently eaten by the atomic write of its neighbour: report said
  // created, disk said gone.
  it("does not consume an incoming file named like its own temp file", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "f.txt", "v1\n");
      put(t, "f.txt", "v1\n");
      put(i, "f.txt", "v2\n");
      put(i, ".f.txt.sesh-merge.tmp", "decoy\n");
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.taken).toEqual(["f.txt"]);
      expect(r.created).toEqual([".f.txt.sesh-merge.tmp"]);
      expect(readFileSync(join(t, ".f.txt.sesh-merge.tmp"), "utf-8")).toBe("decoy\n");
      expect(readFileSync(join(t, "f.txt"), "utf-8")).toBe("v2\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves no scratch files behind in the target tree", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "f.txt", "1\n2\n3\n4\n5\n6\n7\n");
      put(t, "f.txt", "1\nLOCAL\n3\n4\n5\n6\n7\n");
      put(i, "f.txt", "1\n2\n3\n4\n5\nINCOMING\n7\n");
      await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(readdirSync(t).sort()).toEqual(["f.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mergeWorkspaceTrees — degraded merge engine", () => {
  it("sidecars instead of throwing when git cannot be found, and says why", async () => {
    const { root, a, i, t } = trees();
    const empty = tmp("sesh-merge-nopath-");
    const handle = overridePath(empty);
    let r;
    try {
      put(a, "f.txt", "1\n2\n3\n");
      put(t, "f.txt", "1\nLOCAL\n3\n");
      put(i, "f.txt", "1\nINCOMING\n3\n");
      put(a, "g.txt", "v1\n");
      put(t, "g.txt", "v1\n");
      put(i, "g.txt", "v2\n");
      r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
    } finally {
      handle.restore();
      rmSync(empty, { recursive: true, force: true });
    }
    try {
      expect(r.gitUnavailable).toBe(true);
      expect(r.sidecars).toHaveLength(1);
      expect(r.sidecars[0]!.path).toBe("f.txt");
      expect(r.sidecars[0]!.reason).toBe("git-unavailable");
      expect(r.sidecars[0]!.detail).toBeTruthy();
      // Local content survives untouched — no markers, no truncation.
      expect(readFileSync(join(t, "f.txt"), "utf-8")).toBe("1\nLOCAL\n3\n");
      expect(readFileSync(join(t, r.sidecars[0]!.sidecar), "utf-8")).toBe("1\nINCOMING\n3\n");
      // Resolutions that need no merge engine still happen.
      expect(r.taken).toEqual(["g.txt"]);
      expect(readFileSync(join(t, "g.txt"), "utf-8")).toBe("v2\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Both resolutions that write into the user's tree can fail at the write
  // back. `renameSync` is atomic, so the local file is provably as it was, and
  // the destination directory is one `classifyDestination` already approved —
  // so both park the incoming copy rather than falling through to `io-error`,
  // which parks nothing. Neither branch had coverage before: the reviewer who
  // found the asymmetry triggered it by hand with macOS `chflags uchg`.
  //
  // The mechanism here is a read-only PARENT directory, and it is probed at
  // runtime rather than gated on `platform()`. A directory mode is not portable
  // (Windows ignores it; root ignores it everywhere), and a test that silently
  // stopped exercising the branch would be worse than one that says it skipped
  // — the same trap as this project's tautological `sourcePlatform` assertion.
  it("keeps local intact when the write back fails on BOTH the taken and merged paths", async () => {
    const { root, a, i, t } = trees();
    try {
      // taken: local matches the ancestor, only incoming moved.
      put(a, "sub/taken.txt", "v1\n");
      put(t, "sub/taken.txt", "v1\n");
      put(i, "sub/taken.txt", "v2\n");
      // merged: both sides moved, far enough apart to merge cleanly.
      put(a, "sub/merged.txt", "1\n2\n3\n4\n5\n6\n7\n");
      put(t, "sub/merged.txt", "1\nLOCAL\n3\n4\n5\n6\n7\n");
      put(i, "sub/merged.txt", "1\n2\n3\n4\n5\nINCOMING\n7\n");

      const sub = join(t, "sub");
      chmodSync(sub, 0o500);
      let writesReallyFail = false;
      try {
        writeFileSync(join(sub, ".probe"), "x");
        rmSync(join(sub, ".probe"), { force: true });
      } catch {
        writesReallyFail = true;
      }
      if (!writesReallyFail) {
        chmodSync(sub, 0o700);
        return; // r/o directories are not enforced here — the branch is unreachable
      }

      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      chmodSync(sub, 0o700);

      // Neither resolution reached the tree.
      expect(r.taken).toEqual([]);
      expect(r.merged).toEqual([]);

      // Both write-back handlers ran and both TRIED to park a sidecar — the
      // `.theirs-` destination inside the error is the proof, since nothing
      // else in the module builds that name. Here the obstruction is the
      // directory itself, so the sidecar copy fails the same way and the file
      // degrades to `io-error`. That is Minor 5's boundary made concrete: a
      // sidecar can only rescue a write-back failure whose cause is specific to
      // the destination FILE. See the next test for that case.
      expect(r.sidecars).toEqual([]);
      expect(r.skipped.map((s) => s.path).sort()).toEqual(["sub/merged.txt", "sub/taken.txt"]);
      expect(r.skipped.every((s) => s.reason === "io-error")).toBe(true);
      expect(r.skipped.every((s) => s.detail?.includes(".theirs-"))).toBe(true);

      // Local content is exactly what it was — the rename is atomic, so a
      // failed write back is a no-op rather than a truncation.
      expect(readFileSync(join(t, "sub/taken.txt"), "utf-8")).toBe("v1\n");
      expect(readFileSync(join(t, "sub/merged.txt"), "utf-8")).toBe("1\nLOCAL\n3\n4\n5\n6\n7\n");
      // No temp litter from either failed write.
      expect(readdirSync(sub).filter((f) => f.includes("sesh-merge"))).toEqual([]);
    } finally {
      try { chmodSync(join(t, "sub"), 0o700); } catch { /* already restored */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The other half: the destination FILE cannot be replaced but its directory
  // is writable, so the sidecar lands. This is the case the write-back handlers
  // exist for, and the asymmetry a reviewer found by hand — the `taken` path
  // used to fall through to `io-error` while the merged path parked a sidecar.
  //
  // Probed at runtime, not gated on `platform()`: an immutable-file flag is the
  // only portable-ish way to fail a rename without failing its directory, and
  // it needs both the tool and the privilege. If it doesn't take, the branch is
  // genuinely unreachable here and the test says so by returning rather than
  // asserting something weaker.
  it("parks the peer's copy when only the destination file cannot be replaced", async () => {
    const { root, a, i, t } = trees();
    let locked: string | null = null;
    const unlock = (): void => {
      if (!locked) return;
      try { execFileSync("chflags", ["nouchg", locked]); } catch { /* best effort */ }
      locked = null;
    };
    try {
      put(a, "taken.txt", "v1\n");
      put(t, "taken.txt", "v1\n");
      put(i, "taken.txt", "v2\n");

      const dest = join(t, "taken.txt");
      try {
        execFileSync("chflags", ["uchg", dest], { stdio: "ignore" });
        locked = dest;
      } catch {
        return; // no chflags (non-macOS, or not permitted) — branch unreachable
      }
      // Confirm the flag actually bites before asserting on it.
      try {
        writeFileSync(dest, "probe");
        return; // flag accepted but not enforced
      } catch { /* good: the file really is immutable */ }

      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });

      expect(r.taken).toEqual([]);
      expect(r.skipped).toEqual([]);
      expect(r.sidecars).toHaveLength(1);
      expect(r.sidecars[0]!.path).toBe("taken.txt");
      expect(r.sidecars[0]!.reason).toBe("merge-failed");
      // `.theirs-` is honest: the sidecar carries the PEER's file.
      expect(r.sidecars[0]!.sidecar).toContain(".theirs-");
      expect(readFileSync(join(t, r.sidecars[0]!.sidecar), "utf-8")).toBe("v2\n");
      // Local is untouched, and nothing was left behind.
      expect(readFileSync(dest, "utf-8")).toBe("v1\n");
      expect(readdirSync(t).filter((f) => f.includes("sesh-merge"))).toEqual([]);
    } finally {
      unlock();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `git merge-file` reads config from whatever repository the process is
  // standing in, even though it takes three plain paths — and the caller's cwd
  // is normally the user's project, i.e. normally a repo. `--diff3` overrides
  // `merge.conflictStyle`, but config is VALIDATED before the flag applies, so
  // an INVALID repo-local value makes merge-file exit 128 with the flag passed.
  // Against the pre-fix build this produced a per-file `merge-failed` sidecar
  // with `gitUnavailable` false, one fresh doomed spawn per file. Standing in
  // the scratch dir removes repo-local influence outright.
  it("is not affected by a broken git config in the repo the caller stands in", async () => {
    const { root, a, i, t } = trees();
    const repo = join(root, "repo");
    const cwdBefore = process.cwd();
    try {
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "-q", "."], { cwd: repo });
      execFileSync("git", ["config", "merge.conflictStyle", "bogusstyle"], { cwd: repo });
      put(a, "f.txt", "1\n2\n3\n");
      put(t, "f.txt", "1\nLOCAL\n3\n");
      put(i, "f.txt", "1\nINCOMING\n3\n");
      process.chdir(repo);
      const r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(r.conflicted).toEqual(["f.txt"]);
      expect(r.sidecars).toEqual([]);
      expect(r.gitUnavailable).toBe(false);
      const out = readFileSync(join(t, "f.txt"), "utf-8");
      expect(out).toContain("<<<<<<< local");
      expect(out).toContain("||||||| ancestor");
    } finally {
      process.chdir(cwdBefore);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Exit 128 is git's "fatal": it could not run at all — a broken global or
  // system config is rejected before merge-file ever looks at its operands.
  // That is a property of the machine, not of the file, so it must degrade the
  // whole tree once rather than sidecar per file with a fresh doomed spawn each
  // time. A stub `git` on PATH pins it without depending on the runner's own
  // git config (a .cmd stub cannot be spawned without a shell on Windows).
  it.skipIf(isWindows)("degrades for the whole tree when git exits 128", async () => {
    const { root, a, i, t } = trees();
    const stubDir = tmp("sesh-merge-stubgit-");
    writeFileSync(
      join(stubDir, "git"),
      "#!/bin/sh\necho \"fatal: bad config variable 'merge.conflictstyle'\" >&2\nexit 128\n"
    );
    chmodSync(join(stubDir, "git"), 0o755);
    const handle = overridePath(stubDir);
    let r;
    try {
      for (const name of ["f.txt", "g.txt"]) {
        put(a, name, "1\n2\n3\n");
        put(t, name, "1\nLOCAL\n3\n");
        put(i, name, "1\nINCOMING\n3\n");
      }
      r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
    } finally {
      handle.restore();
      rmSync(stubDir, { recursive: true, force: true });
    }
    try {
      expect(r.gitUnavailable).toBe(true);
      expect(r.sidecars.map((s) => [s.path, s.reason])).toEqual([
        ["f.txt", "git-unavailable"], ["g.txt", "git-unavailable"],
      ]);
      expect(r.sidecars[0]!.detail).toContain("could not run");
      expect(r.sidecars[0]!.detail).toContain("bad config variable");
      // Both files kept their local content, both incoming copies parked.
      for (const s of r.sidecars) {
        expect(readFileSync(join(t, s.path), "utf-8")).toBe("1\nLOCAL\n3\n");
        expect(readFileSync(join(t, s.sidecar), "utf-8")).toBe("1\nINCOMING\n3\n");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gitUnavailable stays false when no file ever needed a 3-way merge", async () => {
    const { root, a, i, t } = trees();
    const empty = tmp("sesh-merge-nopath-");
    const handle = overridePath(empty);
    let r;
    try {
      put(a, "f.txt", "v1\n");
      put(t, "f.txt", "v1\n");
      put(i, "f.txt", "v2\n");
      r = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
    } finally {
      handle.restore();
      rmSync(empty, { recursive: true, force: true });
    }
    try {
      expect(r.gitUnavailable).toBe(false);
      expect(r.taken).toEqual(["f.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
