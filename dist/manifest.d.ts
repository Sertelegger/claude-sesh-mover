import type { ExportManifest } from "./types.js";
export declare function writeManifest(exportDir: string, manifest: ExportManifest): void;
export declare function readManifest(exportDir: string): ExportManifest;
export declare function isSafeSessionId(id: unknown): boolean;
export declare function assertSafeManifestIds(manifest: ExportManifest): void;
export declare function computeIntegrityHash(contents: string[]): string;
export declare function computeIntegrityHashFromFile(path: string): Promise<string>;
export declare function verifyIntegrity(contents: string[], expectedHash: string): boolean;
//# sourceMappingURL=manifest.d.ts.map