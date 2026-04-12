import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
});
