import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync as mkdirSyncFs,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";

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
});
