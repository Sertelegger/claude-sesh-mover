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
/**
 * The spelling Claude Code uses for a project directory ON THIS MACHINE when it
 * files that project's sessions: absolute, with every symlink followed (#149).
 *
 * Claude Code keys `<configDir>/projects/<encoded>/` on its working directory,
 * and a process's working directory is the physical path — `process.cwd()` is
 * `getcwd(3)`, which has no idea which symlink a shell `cd`-ed through, and
 * macOS's `/tmp` comes back as `/private/tmp`. A caller-typed destination is
 * whatever was typed. Encoding that verbatim wrote an import into a folder
 * `claude --continue` in the same directory never opens, and a relative `../x`
 * encoded as `---x`. Reported against Claude Code 2.1.284 on Linux: an import
 * through a symlink said success, and `claude --continue` in that directory
 * started a fresh transcript under the physical path instead.
 *
 * For a path that does not exist yet — a bootstrap pull's `--target-path`, a
 * `migrate --rename-dir` target — the nearest EXISTING ancestor is resolved and
 * the rest re-appended, which is the spelling Claude Code will see once the
 * directory is created and someone starts a session in it.
 *
 * Unlike `encodeProjectPath`, this one does branch on `process.platform`, and
 * must: it asks THIS machine's filesystem about a path that lives on this
 * machine, where the encoder handles strings from either side of a transfer.
 * **On Windows it only makes the path absolute and tidies it** (separators, a
 * trailing one, `.`/`..` segments), and follows no link. A Windows working
 * directory is the string it was set to rather than something the OS resolves
 * the way `getcwd(3)` does, so a session started through a junction, a `subst`
 * drive or an 8.3 short name may well be filed under that spelling — and
 * following links here could then rewrite Claude Code's own working directory,
 * which the slash commands pass in verbatim, into one it never uses. Which
 * spelling Windows Claude Code keys on is unmeasured and is what #148 answers;
 * until then this leaves a Windows spelling alone, which is the direction to
 * be wrong in.
 *
 * Deliberately not `hub/escrow.ts`'s `canonicalPath`. That one answers "are
 * these two paths the same directory", so it resolves as hard as the platform
 * allows (including the Windows long-name form this must not produce) and falls
 * back to the input unchanged when a path does not exist — where this has to
 * keep going, one ancestor up.
 *
 * The JS `realpathSync`, deliberately NOT `realpathSync.native`. The JS one
 * walks the typed path a component at a time and substitutes only what a
 * symlink names, so a path with no link in it comes back exactly as typed,
 * letter case included — which is what keeps Claude Code's own working
 * directory (what the slash commands pass) byte-identical on every POSIX
 * system. `.native` is `realpath(3)`, and on macOS that returns a name the
 * way the case-insensitive volume stores it: a working directory entered as
 * `/Users/me/Code/x` over an on-disk `code/` would come back re-cased, and
 * whether Claude Code keys on that spelling is unmeasured. It is also the
 * function #149 found Claude Code's own session-store helper calling
 * (`realpathSync` from `fs`, after `path.resolve`). On Linux the two agree,
 * so nothing here can prove the choice; macOS is where it matters.
 */
export declare function physicalProjectPath(typed: string): string;
export declare function resolveConfigDir(explicitFlag?: string, envVar?: string): string;
export declare function getCurrentUser(): string;
export declare function extractUserFromPath(path: string, platform: Platform): string | null;
//# sourceMappingURL=platform.d.ts.map