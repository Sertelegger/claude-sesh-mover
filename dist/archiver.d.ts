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
export declare function createArchive(sourceDir: string, archivePath: string, compression: CompressionType): Promise<void>;
export declare function extractArchive(archivePath: string, targetDir: string): Promise<void>;
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