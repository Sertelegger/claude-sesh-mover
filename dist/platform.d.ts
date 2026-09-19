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
/**
 * The name Claude Code gives a project's folder under `<configDir>/projects/`.
 * A verbatim port of its own encoder (2.1.277 bundle offset 192854672),
 * verified to reproduce 33 of 33 live on-disk directory names across three
 * config dirs, keyed on each transcript's FIRST conversation entry's `cwd`.
 *
 * Two things this must NOT do, both of which the pre-0.12.0 version did (#126):
 *
 * 1. **It replaces every non-alphanumeric, not just the separator.** A `.`, a
 *    `_`, a space or a version suffix all become `-`. The old rule made
 *    `import` write into a directory Claude Code never reads — and report
 *    success, which is why it survived until a 190-session migration was
 *    hand-diffed.
 * 2. **It takes the path RAW** — no separator normalization, no drive-colon
 *    strip. On Windows a `C:` drive path keeps BOTH the colon and the separator
 *    as dashes. Claude Code hands its encoder the OS-native path, and its own
 *    slug-collision predicate backslash-normalizes SEPARATELY, which is what
 *    shows the encoder itself does not.
 *
 * There is deliberately **no `process.platform` branch**. This runs on the
 * TARGET machine with paths from the SOURCE machine and vice versa, so a
 * platform branch would make one path encode two ways depending on who asked —
 * which is the failure this fix exists to end.
 *
 * The hash is over the RAW path, never the sanitized one. Hashing the sanitized
 * string is the natural mistake and changes the suffix on every capped path.
 */
export declare function encodeProjectPath(projectPath: string): string;
/**
 * The pre-0.12.0 spelling of `encodeProjectPath`. **READ-ONLY, and never used
 * to choose a write destination.**
 *
 * It exists so there is ONE copy of the old rule rather than a hand-written one
 * at each reader. Its only callers are `discovery.ts` (so a session a
 * pre-0.12.0 import misplaced is still findable, and can be migrated into
 * place) and `sync-state.ts`'s single rename-forward. Delete it when nothing on
 * any supported upgrade path can still hold a file under it.
 */
export declare function legacyEncodeProjectPath(projectPath: string): string;
export declare function resolveConfigDir(explicitFlag?: string, envVar?: string): string;
export declare function getCurrentUser(): string;
export declare function extractUserFromPath(path: string, platform: Platform): string | null;
//# sourceMappingURL=platform.d.ts.map