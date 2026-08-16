import type { ExportManifest } from "./types.js";
export type CompressionType = "gzip" | "zstd";
export type ArchiveManifestResult = {
    ok: true;
    manifest: ExportManifest;
} | {
    ok: false;
    reason: "no-zstd" | "unreadable" | "no-manifest" | "unsafe-manifest";
    detail: string;
};
/**
 * The decompression budget for a `.tar.zst` of `compressedBytes`. Exported so
 * a test can assert the exact rule rather than a hand-copied number.
 */
export declare function zstdDecompressionLimit(compressedBytes: number): number;
/**
 * A `.tar.zst` was produced whose frame carries no content checksum, so the
 * container cannot tell a corrupted bundle from an intact one. Thrown by
 * `createZstdArchive` and handled in cli.ts's `finalizeExport`, which falls back
 * to gzip through the same mechanism it already uses when `zstd` is missing.
 */
export declare class ZstdNoContentChecksumError extends Error {
    constructor(archivePath: string);
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
export declare function zstdFrameHasContentChecksum(archivePath: string): boolean | null;
export declare function createArchive(sourceDir: string, archivePath: string, compression: CompressionType): Promise<void>;
/**
 * `warnings`, when passed, collects non-fatal integrity observations about the
 * container itself — today only "this `.tar.zst` declares no content checksum".
 * Optional so the many callers that have nothing to do with a user-facing
 * result (hub/pull.ts's bundle loop, browse's metadata read) stay unchanged.
 */
export declare function extractArchive(archivePath: string, targetDir: string, warnings?: string[]): Promise<void>;
/**
 * Read ONLY manifest.json out of a bundle archive, without unpacking session
 * content. Used by `browse` so an archive can report its real origin instead
 * of a fabricated one. Never throws: every failure mode is a typed result, so
 * one bad archive in a directory can't break the whole listing.
 */
export declare function readManifestFromArchive(archivePath: string): Promise<ArchiveManifestResult>;
/**
 * Validate all tar entry metadata BEFORE extraction. node-tar has its own
 * runtime protections, but we refuse outright: absolute paths, any `..`
 * segment, and link entries (sesh-mover exports never contain links, so any
 * link entry is malicious or corrupt).
 * Works on .tar and .tar.gz inputs (tar.list auto-detects gzip).
 */
export declare function assertSafeEntries(tarFile: string): Promise<void>;
export declare function detectArchiveFormat(filePath: string): CompressionType | null;
export declare function isZstdAvailable(): Promise<boolean>;
//# sourceMappingURL=archiver.d.ts.map