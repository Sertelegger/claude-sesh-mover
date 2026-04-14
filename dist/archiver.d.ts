export type CompressionType = "gzip" | "zstd";
export declare function createArchive(sourceDir: string, archivePath: string, compression: CompressionType): Promise<void>;
export declare function extractArchive(archivePath: string, targetDir: string): Promise<void>;
export declare function detectArchiveFormat(filePath: string): CompressionType | null;
export declare function isZstdAvailable(): Promise<boolean>;
//# sourceMappingURL=archiver.d.ts.map