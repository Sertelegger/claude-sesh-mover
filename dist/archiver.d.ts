export type CompressionType = "gzip" | "zstd";
export declare function createArchive(sourceDir: string, archivePath: string, compression: CompressionType): Promise<void>;
export declare function extractArchive(archivePath: string, targetDir: string): Promise<void>;
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