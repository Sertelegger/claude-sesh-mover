import type { Platform } from "./types.js";
export interface TranslateOptions {
    sourceUser: string;
    targetUser: string;
    sourceProjectPath?: string;
    targetProjectPath?: string;
}
export declare function detectPlatform(): Platform;
export declare function translatePath(inputPath: string, sourcePlatform: Platform, targetPlatform: Platform, options: TranslateOptions): string;
export declare function samePlatformFamily(a: Platform, b: Platform): boolean;
export declare function encodeProjectPath(projectPath: string): string;
export declare function resolveConfigDir(explicitFlag?: string, envVar?: string): string;
export declare function getCurrentUser(): string;
export declare function extractUserFromPath(path: string, platform: Platform): string | null;
//# sourceMappingURL=platform.d.ts.map