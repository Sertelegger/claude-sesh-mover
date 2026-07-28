import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync as mkdirSyncFs,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
import { overrideTmp, type TmpOverrideHandle } from "./helpers/env.js";

/**
 * Install a fake `zstd` on PATH that implements the exact invocations the
 * archiver uses (`--version`, `-f <in> -o <out>`, `-d <in> -o <out>`) via cp.
 * Compression is faked (output = input), which is fine: the ".tar.zst" the
 * shim produces is a plain tar, and the shim's -d copies it back.
 */
function installZstdShim(tempDir: string): string {
  const binDir = join(tempDir, "shim-bin");
  mkdirSyncFs(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "zstd 1.5.5-fake"; exit 0; fi',
    'if [ "$1" = "-f" ]; then cp "$2" "$4"; exit 0; fi',
    'if [ "$1" = "-d" ]; then',
    '  if [ -e "$4" ]; then echo "exists" >&2; exit 70; fi',
    '  cp "$2" "$4"; exit 0',
    "fi",
    "exit 64",
    "",
  ].join("\n");
  const shimPath = join(binDir, "zstd");
  writeFileSync(shimPath, script);
  chmodSync(shimPath, 0o755);
  return binDir;
}

describe("archiver", () => {
  let tempDir: string;
  let sourceDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-archiver-test-"));
    sourceDir = join(tempDir, "test-export");
    mkdirSync(join(sourceDir, "sessions"), { recursive: true });
    writeFileSync(
      join(sourceDir, "manifest.json"),
      '{"version":1,"plugin":"sesh-mover"}'
    );
    writeFileSync(
      join(sourceDir, "sessions", "test.jsonl"),
      '{"type":"user"}\n'
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createArchive (tar.gz)", () => {
    it("creates a .tar.gz archive of the export directory", async () => {
      const { createArchive } = await import("../src/archiver.js");
      const archivePath = join(tempDir, "test-export.tar.gz");
      await createArchive(sourceDir, archivePath, "gzip");
      expect(existsSync(archivePath)).toBe(true);
    });
  });

  describe("extractArchive (tar.gz)", () => {
    it("round-trips a directory through tar.gz", async () => {
      const { createArchive, extractArchive } = await import(
        "../src/archiver.js"
      );
      const archivePath = join(tempDir, "test-export.tar.gz");
      await createArchive(sourceDir, archivePath, "gzip");

      const extractDir = join(tempDir, "extracted");
      mkdirSync(extractDir);
      await extractArchive(archivePath, extractDir);
      expect(existsSync(join(extractDir, "manifest.json"))).toBe(true);
      expect(existsSync(join(extractDir, "sessions", "test.jsonl"))).toBe(
        true
      );
    });
  });

  describe("detectArchiveFormat", () => {
    it("detects tar.gz", async () => {
      const { detectArchiveFormat } = await import("../src/archiver.js");
      expect(detectArchiveFormat("export.tar.gz")).toBe("gzip");
    });

    it("detects tar.zst", async () => {
      const { detectArchiveFormat } = await import("../src/archiver.js");
      expect(detectArchiveFormat("export.tar.zst")).toBe("zstd");
    });

    it("returns null for directories", async () => {
      const { detectArchiveFormat } = await import("../src/archiver.js");
      expect(detectArchiveFormat("export-dir")).toBeNull();
    });
  });

  describe("isZstdAvailable", () => {
    it("returns a boolean", async () => {
      const { isZstdAvailable } = await import("../src/archiver.js");
      const result = await isZstdAvailable();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("zstd via shim", () => {
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPath = process.env.PATH;
      process.env.PATH = `${installZstdShim(tempDir)}:${process.env.PATH}`;
    });

    afterEach(() => {
      process.env.PATH = savedPath;
    });

    it("round-trips a directory through tar.zst", async () => {
      const { createArchive, extractArchive } = await import("../src/archiver.js");
      const archivePath = join(tempDir, "test-export.tar.zst");
      await createArchive(sourceDir, archivePath, "zstd");
      expect(existsSync(archivePath)).toBe(true);

      const extractDir = join(tempDir, "zst-extracted");
      mkdirSync(extractDir);
      await extractArchive(archivePath, extractDir);
      expect(existsSync(join(extractDir, "manifest.json"))).toBe(true);
    });

    it("never touches a pre-existing sibling .tar during zstd extraction", async () => {
      const { createArchive, extractArchive } = await import("../src/archiver.js");
      const archivePath = join(tempDir, "test-export.tar.zst");
      await createArchive(sourceDir, archivePath, "zstd");

      // The old implementation decompressed to <archive-dir>/test-export.tar
      // and deleted it in a finally block — destroying this file.
      const preciousPath = join(tempDir, "test-export.tar");
      writeFileSync(preciousPath, "precious pre-existing tar");

      const extractDir = join(tempDir, "zst-extracted-2");
      mkdirSync(extractDir);
      await extractArchive(archivePath, extractDir);

      expect(existsSync(preciousPath)).toBe(true);
      expect(readFileSync(preciousPath, "utf-8")).toBe("precious pre-existing tar");
    });

    it("never leaves or deletes a sibling .tar during zstd creation", async () => {
      const { createArchive } = await import("../src/archiver.js");
      const preciousPath = join(tempDir, "created.tar");
      writeFileSync(preciousPath, "precious");
      await createArchive(sourceDir, join(tempDir, "created.tar.zst"), "zstd");
      expect(readFileSync(preciousPath, "utf-8")).toBe("precious");
    });
  });

  describe("pre-extraction validation", () => {
    it("rejects a tar containing parent-traversal entries before writing anything", async () => {
      const { extractArchive } = await import("../src/archiver.js");
      // Craft a malicious tar: entry path "../escaped.txt"
      const outer = join(tempDir, "mal");
      const inner = join(outer, "inner");
      mkdirSync(inner, { recursive: true });
      writeFileSync(join(outer, "escaped.txt"), "boom");
      const malPath = join(tempDir, "malicious.tar.gz");
      await tar.create(
        { gzip: true, file: malPath, cwd: inner, preservePaths: true },
        ["../escaped.txt"]
      );

      const extractDir = join(tempDir, "mal-extract");
      mkdirSync(extractDir);
      await expect(extractArchive(malPath, extractDir)).rejects.toThrow(/unsafe archive entries/i);
      // Nothing extracted at all
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(extractDir)).toHaveLength(0);
    });

    it("rejects a tar containing symlink entries", async () => {
      const { extractArchive } = await import("../src/archiver.js");
      const linkSrc = join(tempDir, "linksrc");
      mkdirSync(linkSrc, { recursive: true });
      writeFileSync(join(linkSrc, "ok.txt"), "fine");
      symlinkSync("/etc", join(linkSrc, "evil-link"));
      const linkTar = join(tempDir, "link.tar.gz");
      await tar.create({ gzip: true, file: linkTar, cwd: tempDir }, ["linksrc"]);

      const extractDir = join(tempDir, "link-extract");
      mkdirSync(extractDir);
      await expect(extractArchive(linkTar, extractDir)).rejects.toThrow(/unsafe archive entries/i);
    });
  });

  describe("readManifestFromArchive", () => {
    it("reads the manifest out of a .tar.gz without unpacking session content", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        // Build a realistic bundle staging dir: manifest.json + sessions/<id>.jsonl
        const staging = join(dir, "my-export");
        mkdirSync(join(staging, "sessions"), { recursive: true });
        const manifest = {
          version: 1, plugin: "sesh-mover", exportedAt: "2026-07-25T18:30:48.718Z",
          sourcePlatform: "wsl2", sourceProjectPath: "/mnt/e/GitHub/x/y",
          sourceConfigDir: "/home/u/.claude", sourceClaudeVersion: "2.1.81",
          sessionScope: "current", includedLayers: ["jsonl"],
          sessions: [{
            sessionId: "550e8400-e29b-41d4-a716-446655440000", slug: "s", summary: "sum",
            lastActiveAt: "2026-07-25T18:00:00Z", messageCount: 42,
            gitBranch: "main", entrypoint: "cli", integrityHash: "sha256:abc",
          }],
        };
        writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
        writeFileSync(join(staging, "sessions", "550e8400-e29b-41d4-a716-446655440000.jsonl"), '{"uuid":"a"}\n');
        const archive = join(dir, "my-export.tar.gz");
        await createArchive(staging, archive, "gzip");

        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.manifest.sourcePlatform).toBe("wsl2");
        expect(r.manifest.sourceProjectPath).toBe("/mnt/e/GitHub/x/y");
        expect(r.manifest.exportedAt).toBe("2026-07-25T18:30:48.718Z");
        expect(r.manifest.sessions).toHaveLength(1);
        expect(r.manifest.sessions[0].messageCount).toBe(42);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("ignores a nested manifest.json and only reads the bundle-root one", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        const staging = join(dir, "nested-export");
        mkdirSync(join(staging, "sessions", "deep"), { recursive: true });
        const base = {
          version: 1, plugin: "sesh-mover", exportedAt: "2026-07-25T18:30:48.718Z",
          sourceConfigDir: "/c", sourceClaudeVersion: "2.1.81",
          sessionScope: "current", includedLayers: ["jsonl"], sessions: [],
        };
        writeFileSync(
          join(staging, "manifest.json"),
          JSON.stringify({ ...base, sourcePlatform: "wsl2", sourceProjectPath: "/root/one" })
        );
        writeFileSync(
          join(staging, "sessions", "deep", "manifest.json"),
          JSON.stringify({ ...base, sourcePlatform: "win32", sourceProjectPath: "C:\\decoy" })
        );
        const archive = join(dir, "nested-export.tar.gz");
        await createArchive(staging, archive, "gzip");

        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.manifest.sourcePlatform).toBe("wsl2");
        expect(r.manifest.sourceProjectPath).toBe("/root/one");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("reports unreadable for a corrupt archive instead of throwing", async () => {
      const { readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        const bogus = join(dir, "bogus.tar.gz");
        writeFileSync(bogus, "definitely not a tar archive");
        const r = await readManifestFromArchive(bogus);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(["unreadable", "no-manifest"]).toContain(r.reason);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("reports no-manifest for an archive that has none", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        const staging = join(dir, "empty-export");
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "readme.txt"), "no manifest here\n");
        const archive = join(dir, "empty-export.tar.gz");
        await createArchive(staging, archive, "gzip");
        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("no-manifest");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("reports unreadable for a name that isn't a recognized archive", async () => {
      const { readManifestFromArchive } = await import("../src/archiver.js");
      const r = await readManifestFromArchive(join(tempDir, "not-an-archive"));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("unreadable");
    });

    it("rejects a manifest carrying an unsafe session id (0.3.2 chokepoint)", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        const staging = join(dir, "hostile");
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "manifest.json"), JSON.stringify({
          version: 1, plugin: "sesh-mover", exportedAt: "t", sourcePlatform: "linux",
          sourceProjectPath: "/x", sourceConfigDir: "/y", sourceClaudeVersion: "1",
          sessionScope: "current", includedLayers: [],
          sessions: [{ sessionId: "../../../etc/passwd", slug: "s", summary: "",
            lastActiveAt: "t", messageCount: 1, gitBranch: "m", entrypoint: "cli", integrityHash: "sha256:x" }],
        }));
        const archive = join(dir, "hostile.tar.gz");
        await createArchive(staging, archive, "gzip");
        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("unsafe-manifest");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("degrades a wrong-shaped manifest instead of reporting a fabricated session count", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        // `sessions` is a string, not an array. Without a shape guard this
        // parses fine, survives assertSafeManifestIds (iterating a string
        // yields chars, whose .sessionId is undefined), and browse then
        // reports sessionCount: 3 — "abc".length — as if it were real.
        const staging = join(dir, "shapeless");
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "manifest.json"), JSON.stringify({
          version: 1, plugin: "sesh-mover", exportedAt: "t", sourcePlatform: "linux",
          sourceProjectPath: "/x", sourceConfigDir: "/y", sourceClaudeVersion: "1",
          sessionScope: "current", includedLayers: [], sessions: "abc",
        }));
        const archive = join(dir, "shapeless.tar.gz");
        await createArchive(staging, archive, "gzip");
        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason).toBe("unreadable");
          expect(r.detail).toMatch(/sesh-mover bundle manifest/i);
        }

        // Same for a JSON document that simply isn't a bundle manifest.
        const other = join(dir, "notours");
        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, "manifest.json"), JSON.stringify({ some: "other tool" }));
        const otherArchive = join(dir, "notours.tar.gz");
        await createArchive(other, otherArchive, "gzip");
        const r2 = await readManifestFromArchive(otherArchive);
        expect(r2.ok).toBe(false);
        if (!r2.ok) expect(r2.reason).toBe("unreadable");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("reads a .tar.zst manifest when zstd is available, else reports no-zstd", async () => {
      const { createArchive, readManifestFromArchive, isZstdAvailable } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        const archive = join(dir, "z-export.tar.zst");
        if (await isZstdAvailable()) {
          const staging = join(dir, "z-export");
          mkdirSync(join(staging, "sessions"), { recursive: true });
          writeFileSync(join(staging, "manifest.json"), JSON.stringify({
            version: 1, plugin: "sesh-mover", exportedAt: "2026-07-25T18:30:48.718Z",
            sourcePlatform: "wsl2", sourceProjectPath: "/mnt/e/GitHub/x/y",
            sourceConfigDir: "/home/u/.claude", sourceClaudeVersion: "2.1.81",
            sessionScope: "current", includedLayers: ["jsonl"], sessions: [],
          }));
          writeFileSync(join(staging, "sessions", "a.jsonl"), '{"uuid":"a"}\n');
          // createArchive("zstd") shells out to zstd unconditionally — the
          // gzip fallback lives in cli.ts, not here — so only call it when
          // zstd really exists.
          await createArchive(staging, archive, "zstd");
          const r = await readManifestFromArchive(archive);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.manifest.sourcePlatform).toBe("wsl2");
          expect(r.manifest.sourceProjectPath).toBe("/mnt/e/GitHub/x/y");
        } else {
          writeFileSync(archive, "opaque zstd bytes we cannot decode");
          const r = await readManifestFromArchive(archive);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.reason).toBe("no-zstd");
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("contains a scratch-dir allocation failure as a typed result instead of throwing", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      // overrideTmp, not a bare TMPDIR assignment: os.tmpdir() reads TEMP/TMP
      // on Windows and ignores TMPDIR entirely, so a one-variable override
      // leaves the temp root perfectly usable there and this test asserts
      // ok === false against a read that quietly succeeded.
      let tmp: TmpOverrideHandle | undefined;
      try {
        const staging = join(dir, "fine-export");
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "manifest.json"), JSON.stringify({
          version: 1, plugin: "sesh-mover", exportedAt: "2026-07-25T18:30:48.718Z",
          sourcePlatform: "wsl2", sourceProjectPath: "/mnt/e/x",
          sourceConfigDir: "/c", sourceClaudeVersion: "2.1.81",
          sessionScope: "current", includedLayers: ["jsonl"], sessions: [],
        }));
        const archive = join(dir, "fine-export.tar.gz");
        await createArchive(staging, archive, "gzip");

        // A real resource failure, not a corrupt archive: the process temp
        // root doesn't exist, so mkdtempSync throws ENOENT. That used to
        // escape as a rejection because the allocation sat outside the try —
        // which, under Promise.all, failed the caller's ENTIRE listing.
        tmp = overrideTmp(join(dir, "no-such-temp-root"));
        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason).toBe("unreadable");
          expect(r.detail).toMatch(/ENOENT|no such file/i);
        }

        // ...and the very next call succeeds once the temp root is usable
        // again: the failure is per-call, not sticky.
        tmp.restore();
        tmp = undefined;
        const again = await readManifestFromArchive(archive);
        expect(again.ok).toBe(true);
      } finally {
        tmp?.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("leaves no scratch dir behind on success or failure", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      // Must override TEMP/TMP as well as TMPDIR: on Windows a TMPDIR-only
      // override sends the reads to the real system temp dir, and scanning
      // our own untouched tmpRoot for leftovers would pass vacuously.
      let tmp: TmpOverrideHandle | undefined;
      try {
        const staging = join(dir, "clean-export");
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "manifest.json"), JSON.stringify({
          version: 1, plugin: "sesh-mover", exportedAt: "t", sourcePlatform: "linux",
          sourceProjectPath: "/x", sourceConfigDir: "/y", sourceClaudeVersion: "1",
          sessionScope: "current", includedLayers: [], sessions: [],
        }));
        const good = join(dir, "clean-export.tar.gz");
        await createArchive(staging, good, "gzip");
        const bad = join(dir, "corrupt.tar.gz");
        writeFileSync(bad, "not a tar");

        const tmpRoot = join(dir, "tmproot");
        mkdirSync(tmpRoot, { recursive: true });
        tmp = overrideTmp(tmpRoot);
        // Positive control for the assertion below: prove the reads actually
        // allocate inside tmpRoot on THIS platform before concluding anything
        // from it being empty afterwards.
        expect(tmpdir()).toBe(tmpRoot);

        expect((await readManifestFromArchive(good)).ok).toBe(true);
        expect((await readManifestFromArchive(bad)).ok).toBe(false);

        const leaked = readdirSync(tmpRoot).filter((n) => n.startsWith("sesh-manifest-"));
        expect(leaked).toEqual([]);
      } finally {
        tmp?.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports no-zstd for a .tar.zst when zstd is off PATH", async () => {
      const { readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      const savedPath = process.env.PATH;
      try {
        // Deterministic coverage of the no-zstd branch even on machines that
        // do have zstd installed.
        process.env.PATH = join(dir, "no-such-bin");
        const archive = join(dir, "z-export.tar.zst");
        writeFileSync(archive, "opaque zstd bytes");
        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason).toBe("no-zstd");
          expect(r.detail).toMatch(/zstd/i);
        }
      } finally {
        process.env.PATH = savedPath;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
