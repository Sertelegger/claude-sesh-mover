import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { assertSafeManifestIds, isBundleManifestShape } from "./manifest.js";
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
 * How far a `.tar.zst` may expand before we abandon decompressing it, stated
 * the way node-tar states its own limit: a multiple of the COMPRESSED size, so
 * it scales with real bundles and only ever fires at a ratio no genuine
 * session bundle reaches.
 *
 * ## Why this exists — measured, not reasoned
 *
 * The `.tar.gz` path is self-limiting for free: node-tar's Parser
 * (`parse.js`, `MAX_DECOMPRESSION_RATIO = 1000`) aborts the stream as soon as
 * the bytes it has inflated exceed 1000x the bytes it has consumed, and that
 * abort surfaces here as an ordinary `unreadable`. Nothing equivalent guards
 * the zstd CLI, which writes whatever the frame decodes to. Measured on this
 * repo (#32): a 16 KB `.tar.zst` of zeros wrote 500 MB into the temp dir
 * during a plain `browse` — ~32,000:1 — because `MAX_MANIFEST_BYTES` only
 * fires once the archive is already unpacked, with the disk cost paid and up
 * to `ARCHIVE_READ_CONCURRENCY` (8) of them in flight. `browse` is not an
 * opt-in for this: `/sesh-mover:import` runs it automatically to build its
 * picker, so merely opening the picker opened every archive in the directory.
 *
 * ## Why the bound is imposed on the bytes, not read from the frame
 *
 * A zstd frame *may* declare its decompressed size, and ours do (`zstd -l`
 * reports "Decompressed Size" for a `createZstdArchive` output, which
 * compresses a single file of known length). That field is no basis for a cap,
 * because the attacker picks the framing: a frame produced by piping into
 * `zstd` on stdin has an unknown input size, so the Frame_Content_Size field
 * is simply absent — and `zstd -l` then prints an EMPTY Uncompressed column
 * and still **exits 0** (measured, zstd 1.5.5). A pre-check reads either a
 * blank or a number chosen by whoever wrote the file. So the only cap that
 * holds is one we impose ourselves, on the bytes as they arrive: see
 * `decompressZstd`, which streams `zstd -d --stdout` through a counting
 * transform and kills the child the moment the budget is gone.
 */
const MAX_ZSTD_DECOMPRESSION_RATIO = 1000;

/**
 * Floor under the ratio bound. A minimal bundle is mostly tar padding (512-byte
 * blocks plus a 1 KB zero trailer) which compresses to nearly nothing, so a
 * few hundred compressed bytes must not translate into a few hundred KB of
 * allowance. Cheap insurance: 1 MB x 8 concurrent reads is a rounding error
 * next to the 500 MB a single unbounded read could cost.
 */
const MIN_ZSTD_DECOMPRESSION_ALLOWANCE = 1024 * 1024;

/**
 * The decompression budget for a `.tar.zst` of `compressedBytes`. Exported so
 * a test can assert the exact rule rather than a hand-copied number.
 */
export function zstdDecompressionLimit(compressedBytes: number): number {
  return Math.max(
    MIN_ZSTD_DECOMPRESSION_ALLOWANCE,
    compressedBytes * MAX_ZSTD_DECOMPRESSION_RATIO
  );
}

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

    // Same pre-extraction validation every other extraction path runs, plus
    // the one thing only this path needs: how big the manifest says it is.
    const { manifestSize } = await scanBundleEntries(tarFile);
    if (manifestSize === null) {
      return {
        ok: false,
        reason: "no-manifest",
        detail: "archive contains no bundle-root manifest.json",
      };
    }
    if (manifestSize > MAX_MANIFEST_BYTES) {
      return { ok: false, reason: "unreadable", detail: "manifest.json is implausibly large" };
    }

    const out = join(work, "out");
    mkdirSync(out, { recursive: true });
    await tar.extract({ file: tarFile, cwd: out, strip: 1, filter: isBundleRootManifest });

    const manifestPath = join(out, "manifest.json");
    // Belt-and-braces against a scan/extract disagreement: the scan saw an
    // entry, so a missing file here means the filter and the size check are no
    // longer looking at the same thing, which must degrade rather than throw.
    if (!existsSync(manifestPath)) {
      return {
        ok: false,
        reason: "no-manifest",
        detail: "archive contains no bundle-root manifest.json",
      };
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
    // fabricate a count from it. The predicate is shared with the directory
    // path in cli.ts and lives in manifest.ts — see it for why those two
    // clauses, and for what `assertSafeManifestIds` below does not catch.
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
 * Validate all tar entry metadata BEFORE extraction. node-tar has its own
 * runtime protections, but we refuse outright: absolute paths, any `..`
 * segment, and link entries (sesh-mover exports never contain links, so any
 * link entry is malicious or corrupt).
 * Works on .tar and .tar.gz inputs (tar.list auto-detects gzip).
 */
export async function assertSafeEntries(tarFile: string): Promise<void> {
  await scanBundleEntries(tarFile);
}

/**
 * The single pass `assertSafeEntries` is built on: it throws on any unsafe
 * entry, and reports the DECLARED size of the bundle-root manifest.json (null
 * when the archive has none).
 *
 * That size is not a hint — in a tar the header's size field is exactly how
 * many bytes the parser will hand over for the entry, so it bounds the real
 * thing rather than describing it. Reading it here lets an implausible
 * manifest be refused before a byte of it is written to disk, where the old
 * post-extraction `statSync` could only refuse it afterwards.
 */
async function scanBundleEntries(tarFile: string): Promise<{ manifestSize: number | null }> {
  const offenders: string[] = [];
  let manifestSize: number | null = null;
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
      } else if (isBundleRootManifest(p)) {
        manifestSize = entry.size ?? 0;
      }
    },
  });
  if (offenders.length > 0) {
    throw new Error(`Unsafe archive entries detected: ${offenders.join(", ")}`);
  }
  return { manifestSize };
}

/**
 * Is this the ONE manifest a bundle archive is allowed to speak for? Both the
 * entry scan and `tar.extract`'s filter see the path AS STORED (pre-strip), so
 * the bundle-root manifest is exactly two segments: "<bundle>/manifest.json".
 * Never a nested manifest, never session data. One copy of the rule, so the
 * entry the size check measured is the entry the extraction writes.
 */
function isBundleRootManifest(p: string): boolean {
  return p.split("/").filter(Boolean).length === 2 && p.endsWith("/manifest.json");
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
 * Decompress a .tar.zst to a plain .tar at `tarPath`, refusing to write more
 * than `zstdDecompressionLimit` bytes. Shared by the extract path and by
 * `readManifestFromArchive` so there is exactly one place that knows how
 * sesh-mover shells out to zstd — and therefore exactly one place the bound
 * has to hold. Callers must have already checked `isZstdAvailable()` (or be
 * prepared for the throw when zstd is missing).
 *
 * Streamed rather than run file-to-file (`zstd -d in -o out`) because that
 * form hands the size decision to zstd: the process returns only once the
 * whole frame is on disk, so any check we make afterwards is a check made
 * after paying the cost. Counting the bytes through a transform is the only
 * arrangement where the cap cannot be lied to — it never consults the frame
 * header, only what actually came out of it.
 *
 * The container-corruption guarantees survive the change to `--stdout`, which
 * matters because they are the reason `.tar.zst` is an acceptable format at
 * all (see `zstdFrameHasContentChecksum`). Measured with zstd 1.5.5: a
 * truncated frame still exits 1 ("premature end") and a bit-flipped one still
 * exits 1 ("Restored data doesn't match checksum"), both of which become a
 * throw here.
 */
async function decompressZstd(archivePath: string, tarPath: string): Promise<void> {
  const compressedBytes = statSync(archivePath).size;
  const limit = zstdDecompressionLimit(compressedBytes);

  const child = spawn("zstd", ["-d", "--stdout", archivePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let spawnError: Error | undefined;
  let stderr = "";
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => {
    // Bounded on purpose: this string ends up in a user-facing `metadataError`,
    // and a hostile archive should not get to choose how much of it there is.
    if (stderr.length < 2048) stderr += chunk;
  });

  // Settles once the child is gone, however it went. `error` is how a missing
  // zstd arrives now that this is not `execFileSync` (which threw ENOENT
  // synchronously); node does not promise a `close` after a spawn `error`, so
  // both settle it and the first one wins.
  const ended = new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    child.once("close", (code) => finish(code));
    child.once("error", (e: Error) => {
      spawnError = e;
      finish(null);
    });
  });

  let expanded = 0;
  let overran = false;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      expanded += chunk.length;
      if (expanded > limit) {
        overran = true;
        // Message is irrelevant — the pipeline rejection is only the signal to
        // stop; the error a caller sees is thrown below, where the numbers are.
        callback(new Error("zstd decompression budget exhausted"));
        return;
      }
      callback(null, chunk);
    },
  });

  let pipeFailure: unknown;
  try {
    await pipeline(child.stdout ?? emptyStdout(), bounded, createWriteStream(tarPath));
  } catch (e) {
    pipeFailure = e;
  }

  if (overran) {
    // The pipe is already torn down, but zstd may still be decoding into it and
    // a 32,000:1 frame produces a lot of bytes per millisecond. Don't wait for
    // it to notice EPIPE.
    child.kill("SIGKILL");
    await ended;
    // Nothing here is worth keeping, and holding the partial output would
    // concede most of what the bound was for.
    rmSync(tarPath, { force: true });
    throw new Error(
      `${basename(archivePath)} expands to more than ${limit} bytes — over ${MAX_ZSTD_DECOMPRESSION_RATIO}x its ${compressedBytes} compressed bytes, which no session bundle is — so it was not decompressed`
    );
  }

  const code = await ended;
  if (spawnError) throw spawnError;
  if (pipeFailure) throw pipeFailure;
  if (code !== 0) {
    const detail = stderr.trim();
    throw new Error(
      `zstd could not decompress ${basename(archivePath)} (exit ${code ?? "signal"})${detail ? `: ${detail}` : ""}`
    );
  }
}

/**
 * Stand-in for a child's stdout that never existed. Only reachable if spawn
 * failed outright, in which case `spawnError` is what the caller gets — this
 * just keeps the pipeline from being handed a null.
 */
function emptyStdout(): Transform {
  const s = new Transform({
    transform(_chunk, _encoding, callback) {
      callback();
    },
  });
  s.end();
  return s;
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
