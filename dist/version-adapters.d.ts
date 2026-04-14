import type { VersionAdapter } from "./types.js";
export declare function compareVersions(a: string, b: string): number;
export declare function classifyVersionDifference(sourceVersion: string, targetVersion: string): "same" | "source-newer" | "target-newer";
export declare function getApplicableAdapters(sourceVersion: string, targetVersion: string): VersionAdapter[];
export declare function applyAdapters(entry: Record<string, unknown>, adapters: VersionAdapter[]): {
    entry: Record<string, unknown>;
    applied: string[];
};
//# sourceMappingURL=version-adapters.d.ts.map