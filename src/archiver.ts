import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
import { assertSafeManifestIds } from "./manifest.js";
import type { ExportManifest } from "./types.js";

export type CompressionType = "gzip" | "zstd";

export type ArchiveManifestResult =
  | { ok: true; manifest: ExportManifest }
  | {
      ok: false;
      reason: "no-zstd" | "unreadable" | "no-manifest" | "unsafe-manifest";
      detail: string;
    };

const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * A `.tar.zst` was produced whose frame carries no content checksum, so the
 * container cannot tell a corrupted bundle from an intact one. Thrown by
 * `createZstdArchive` and handled in cli.ts's `finalizeExport`, which falls back
 * to gzip through the same mechanism it already uses when `zstd` is missing.
 */
export class ZstdNoContentChecksumError extends Error {
  constructor(archivePath: string) {
    super(
      `zstd produced ${basename(archivePath)} without a frame content checksum, so corruption in it could not be detected on extraction`
    );
  }
}

/**
 * Does the first zstd frame in this file declare a content checksum?
 * `true`/`false` when the frame header can be read, `null` when the answer
 * cannot be established (short file, unreadable, or not a zstd frame at all —
 * a skippable frame first, say).
 *
 * Reads five bytes, no subprocess. Frame layout (RFC 8878 §3.1.1): a 4-byte
 * little-endian magic `0xFD2FB528`, then the Frame_Header_Descriptor whose bit
 * 2 (`0x04`) is the Content_Checksum_flag.
 *
 * ## Why this exists — measured, not reasoned
 *
 * `.tar.gz` carries a CRC32 that zlib verifies, so both a truncated and a
 * bit-flipped `.tar.gz` throw out of node-tar (`zlib: unexpected end of file`
 * and `zlib: incorrect data check` respectively — measured on this repo's
 * pinned `tar`, for `tar.list` AND `tar.extract`). The `.tar.zst` path is only
 * as loud because the zstd CLI enables an XXH64 frame checksum by DEFAULT:
 * measured with zstd 1.5.7, a truncated frame fails `zstd -d` with "premature
 * end" whether or not a checksum is present, but a single flipped byte is
 * caught ONLY when it is — with `--no-check`, `zstd -d` exits 0 and writes
 * silently different bytes.
 *
 * That default was the whole of the guarantee and nothing asserted it. This
 * turns it into something the code checks rather than assumes, without betting
 * on a `--check` flag an older zstd build might not accept.
 */
export function zstdFrameHasContentChecksum(archivePath: string): boolean | null {
  let fd: number | undefined;
  try {
    fd = openSync(archivePath, "r");
    const head = Buffer.alloc(5);
    const read = readSync(fd, head, 0, 5, 0);
    if (read < 5) return null;
    if (head.readUInt32LE(0) !== 0xfd2fb528) return null;
    return (head[4] & 0x04) !== 0;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing left to do with it */
      }
    }
  }
}

export async function createArchive(
  sourceDir: string,
  archivePath: string,
  compression: CompressionType
): Promise<void> {
  if (compression === "zstd") {
    await createZstdArchive(sourceDir, archivePath);
  } else {
    await tar.create(
      { gzip: true, file: archivePath, cwd: dirname(sourceDir) },
      [basename(sourceDir)]
    );
  }
}

/**
 * `warnings`, when passed, collects non-fatal integrity observations about the
 * container itself — today only "this `.tar.zst` declares no content checksum".
 * Optional so the many callers that have nothing to do with a user-facing
 * result (hub/pull.ts's bundle loop, browse's metadata read) stay unchanged.
 */
export async function extractArchive(
  archivePath: string,
  targetDir: string,
  warnings?: string[]
): Promise<void> {
  const format = detectArchiveFormat(archivePath);
  if (format === "zstd") {
    await extractZstdArchive(archivePath, targetDir, warnings);
  } else {
    await assertSafeEntries(archivePath);
    await tar.extract({ file: archivePath, cwd: targetDir, strip: 1 });
  }
}

/**
 * Read ONLY manifest.json out of a bundle archive, without unpacking session
 * content. Used by `browse` so an archive can report its real origin instead
 * of a fabricated one. Never throws: every failure mode is a typed result, so
 * one bad archive in a directory can't break the whole listing.
 */
export async function readManifestFromArchive(
  archivePath: string
): Promise<ArchiveManifestResult> {
  const format = detectArchiveFormat(archivePath);
  if (!format) {
    return { ok: false, reason: "unreadable", detail: "not a recognized archive name" };
  }

  // The scratch dir is allocated INSIDE the try: a resource failure here
  // (no temp root, fd/inode exhaustion) is just as much "this archive could
  // not be read" as a corrupt tar, and must not escape as a throw — callers
  // batch these, and one escaping rejection would take a whole listing down.
  let work: string | undefined;
  try {
    work = mkdtempSync(join(tmpdir(), "sesh-manifest-"));

    let tarFile = archivePath;
    if (format === "zstd") {
      if (!(await isZstdAvailable())) {
        return {
          ok: false,
          reason: "no-zstd",
          detail: "zstd is not installed, so .tar.zst metadata cannot be read",
        };
      }
      tarFile = join(work, "bundle.tar");
      await decompressZstd(archivePath, tarFile);
    }

    // Same pre-extraction validation every other extraction path runs.
    await assertSafeEntries(tarFile);

    const out = join(work, "out");
    mkdirSync(out, { recursive: true });
    await tar.extract({
      file: tarFile,
      cwd: out,
      strip: 1,
      // `filter` sees the path AS STORED in the archive (pre-strip), so the
      // bundle-root manifest is exactly two segments: "<bundle>/manifest.json".
      // Never nested manifests, never session data.
      filter: (p) => p.split("/").filter(Boolean).length === 2 && p.endsWith("/manifest.json"),
    });

    const manifestPath = join(out, "manifest.json");
    if (!existsSync(manifestPath)) {
      return {
        ok: false,
        reason: "no-manifest",
        detail: "archive contains no bundle-root manifest.json",
      };
    }
    if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) {
      return { ok: false, reason: "unreadable", detail: "manifest.json is implausibly large" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (e) {
      return {
        ok: false,
        reason: "unreadable",
        detail: `manifest.json is not valid JSON: ${(e as Error).message}`,
      };
    }
    // Valid JSON is not yet a manifest. Everything below is surfaced to the
    // user as fact, so a wrong-shaped `sessions` must degrade rather than
    // fabricate: `sessions: "abc"` would otherwise report sessionCount 3
    // (string length) — an invented number, in the code path whose whole
    // point is never inventing metadata. Deliberately minimal, not a schema
    // validator: the plugin marker plus the one field a count is derived from.
    if (!isBundleManifestShape(parsed)) {
      return {
        ok: false,
        reason: "unreadable",
        detail:
          'manifest.json is not a sesh-mover bundle manifest (needs plugin "sesh-mover" and a sessions array)',
      };
    }
    const manifest = parsed as ExportManifest;
    try {
      assertSafeManifestIds(manifest); // 0.3.2 chokepoint — surfaced data must be safe
    } catch (e) {
      return { ok: false, reason: "unsafe-manifest", detail: (e as Error).message };
    }
    return { ok: true, manifest };
  } catch (e) {
    return { ok: false, reason: "unreadable", detail: (e as Error).message };
  } finally {
    // Best-effort: `force: true` swallows ENOENT but NOT EBUSY/EPERM, which
    // Windows really does return for a just-closed file. A throw here escapes
    // the finally, rejects this thunk, and fails the caller's whole Promise.all
    // batch — collapsing an entire listing to success:false over nothing but
    // an undeleted scratch dir. Leaking a temp dir is the lesser outcome.
    if (work !== undefined) {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        /* leave the scratch dir to the OS temp reaper */
      }
    }
  }
}

/**
 * Minimal structural check that a parsed manifest.json is a sesh-mover bundle
 * manifest — the plugin marker (the same one the directory-export path in
 * cli.ts checks) and a real `sessions` array. Field-level validation is
 * deliberately out of scope; this only guards against reporting numbers
 * derived from a value that was never a session list.
 */
function isBundleManifestShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { plugin?: unknown; sessions?: unknown };
  return m.plugin === "sesh-mover" && Array.isArray(m.sessions);
}

/**
 * Validate all tar entry metadata BEFORE extraction. node-tar has its own
 * runtime protections, but we refuse outright: absolute paths, any `..`
 * segment, and link entries (sesh-mover exports never contain links, so any
 * link entry is malicious or corrupt).
 * Works on .tar and .tar.gz inputs (tar.list auto-detects gzip).
 */
export async function assertSafeEntries(tarFile: string): Promise<void> {
  const offenders: string[] = [];
  await tar.list({
    file: tarFile,
    onReadEntry: (entry) => {
      const p = String(entry.path);
      if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
        offenders.push(`${p} (absolute path)`);
      } else if (p.split("/").includes("..")) {
        offenders.push(`${p} (parent traversal)`);
      } else if (entry.type === "SymbolicLink" || entry.type === "Link") {
        offenders.push(`${p} (${entry.type})`);
      }
    },
  });
  if (offenders.length > 0) {
    throw new Error(`Unsafe archive entries detected: ${offenders.join(", ")}`);
  }
}

export function detectArchiveFormat(
  filePath: string
): CompressionType | null {
  if (filePath.endsWith(".tar.gz") || filePath.endsWith(".tgz")) return "gzip";
  if (filePath.endsWith(".tar.zst") || filePath.endsWith(".tar.zstd")) return "zstd";
  return null;
}

export async function isZstdAvailable(): Promise<boolean> {
  try {
    execFileSync("zstd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function createZstdArchive(sourceDir: string, archivePath: string): Promise<void> {
  // All intermediate .tar work happens in a private temp dir — never next to
  // the destination, so we can never clobber or delete a user's file.
  const workDir = mkdtempSync(join(tmpdir(), "sesh-mover-zstd-"));
  const tarPath = join(workDir, "bundle.tar");
  try {
    await tar.create({ file: tarPath, cwd: dirname(sourceDir) }, [basename(sourceDir)]);
    execFileSync("zstd", ["-f", tarPath, "-o", archivePath], { stdio: "ignore" });
    // The invocation is deliberately unchanged — a `--check` flag would be
    // rejected outright by a zstd predating 1.3.4, turning a guarantee into an
    // export failure. Verify the RESULT instead: if this build's default left
    // the checksum out, the caller falls back to gzip rather than shipping a
    // container that cannot detect corruption (see ZstdNoContentChecksumError).
    if (zstdFrameHasContentChecksum(archivePath) === false) {
      rmSync(archivePath, { force: true });
      throw new ZstdNoContentChecksumError(archivePath);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Decompress a .tar.zst to a plain .tar at `tarPath`. Shared by the extract
 * path and by `readManifestFromArchive` so there is exactly one place that
 * knows how sesh-mover shells out to zstd. Callers must have already checked
 * `isZstdAvailable()` (or be prepared for the throw when zstd is missing).
 */
async function decompressZstd(archivePath: string, tarPath: string): Promise<void> {
  execFileSync("zstd", ["-d", archivePath, "-o", tarPath], { stdio: "ignore" });
}

async function extractZstdArchive(
  archivePath: string,
  targetDir: string,
  warnings?: string[]
): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "sesh-mover-zstd-"));
  const tarPath = join(workDir, "bundle.tar");
  try {
    // Reported, not refused. A checksum-less frame means the CONTAINER cannot
    // vouch for these bytes, but the bundle inside it is separately covered by
    // manifest.json's own session digest and per-session/per-layer hashes
    // (manifest.ts), all of which the importer verifies before writing
    // anything. Refusing here would put this check between a user and their
    // only copy of a transcript, for a bundle whose real content is about to be
    // hashed anyway. Only the FIRST frame is inspected; sesh-mover writes
    // single-frame archives.
    if (zstdFrameHasContentChecksum(archivePath) === false) {
      warnings?.push(
        `${basename(archivePath)} was compressed without a zstd frame checksum, so the archive itself cannot show whether it was corrupted in transit. The bundle's own manifest hashes were still verified.`
      );
    }
    await decompressZstd(archivePath, tarPath);
    await assertSafeEntries(tarPath);
    await tar.extract({ file: tarPath, cwd: targetDir, strip: 1 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
