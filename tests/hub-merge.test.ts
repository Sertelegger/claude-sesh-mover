import { describe, it, expect } from "vitest";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
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

  it("never overwrites an existing sidecar, it uniquifies the name", async () => {
    const { root, a, i, t } = trees();
    try {
      put(a, "img.bin", Buffer.from([1, 0, 2]));
      put(t, "img.bin", Buffer.from([1, 0, 9]));
      put(i, "img.bin", Buffer.from([1, 0, 7]));
      const first = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      // Second pull in the same run/second: the first sidecar must survive.
      put(i, "img.bin", Buffer.from([1, 0, 5]));
      const second = await mergeWorkspaceTrees({ ancestorDir: a, incomingDir: i, targetDir: t });
      expect(second.sidecars).toHaveLength(1);
      expect(second.sidecars[0]!.sidecar).not.toBe(first.sidecars[0]!.sidecar);
      expect(readFileSync(join(t, first.sidecars[0]!.sidecar))).toEqual(Buffer.from([1, 0, 7]));
      expect(readFileSync(join(t, second.sidecars[0]!.sidecar))).toEqual(Buffer.from([1, 0, 5]));
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
