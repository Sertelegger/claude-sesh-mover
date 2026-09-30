import { readFileSync, existsSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
export function detectPlatform() {
    if (process.platform === "win32")
        return "win32";
    if (process.platform === "darwin")
        return "darwin";
    // Linux — check for WSL
    if (process.platform === "linux") {
        try {
            if (existsSync("/proc/version")) {
                const procVersion = readFileSync("/proc/version", "utf-8");
                if (/microsoft/i.test(procVersion)) {
                    // Detect WSL version
                    if (/WSL2/i.test(procVersion))
                        return "wsl2";
                    return "wsl1";
                }
            }
            if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) {
                return "wsl2"; // WSLInterop fallback — unreachable in practice since /proc/version check fires first on any WSL system
            }
        }
        catch {
            // If we can't read proc, assume standard Linux
        }
        return "linux";
    }
    return "linux"; // fallback
}
// Note: darwin↔linux cross-platform translation is intentionally not handled here. Callers always provide sourceProjectPath/targetProjectPath for those cases, which triggers same-platform substitution.
export function translatePath(inputPath, sourcePlatform, targetPlatform, options) {
    const { sourceUser, targetUser, sourceProjectPath, targetProjectPath } = options;
    // Same-platform path substitution
    if (samePlatformFamily(sourcePlatform, targetPlatform) &&
        sourceProjectPath &&
        targetProjectPath) {
        if (inputPath.startsWith(sourceProjectPath)) {
            return targetProjectPath + inputPath.slice(sourceProjectPath.length);
        }
        // Also handle username-only changes
        // Intentionally rewrites usernames in ALL paths (not just under sourceProjectPath) since JSONL entries contain paths outside the project (e.g., config dirs, tool paths).
        if (sourceUser !== targetUser) {
            return inputPath.replace(new RegExp(`(^|/)${escapeRegex(sourceUser)}(/|$)`), `$1${targetUser}$2`);
        }
        return inputPath;
    }
    const sourceIsWsl = sourcePlatform === "wsl1" || sourcePlatform === "wsl2";
    const targetIsWsl = targetPlatform === "wsl1" || targetPlatform === "wsl2";
    const sourceIsWin = sourcePlatform === "win32";
    const targetIsWin = targetPlatform === "win32";
    // Unix-like (WSL/Linux/macOS) -> Windows
    if ((sourceIsWsl || sourcePlatform === "linux" || sourcePlatform === "darwin") && targetIsWin) {
        // /tmp (exact) or /tmp/... -> C:\Users\<user>\AppData\Local\Temp\...
        if (inputPath === "/tmp") {
            return `C:\\Users\\${targetUser}\\AppData\\Local\\Temp`;
        }
        if (inputPath.startsWith("/tmp/")) {
            const rest = inputPath.slice(5);
            return `C:\\Users\\${targetUser}\\AppData\\Local\\Temp\\${rest}`.replace(/\//g, "\\");
        }
        // /mnt/<drive>/... -> <DRIVE>:\...
        const mntMatch = inputPath.match(/^\/mnt\/([a-zA-Z])\/(.*)/);
        if (mntMatch) {
            const drive = mntMatch[1].toUpperCase();
            const rest = mntMatch[2];
            return `${drive}:\\${rest.replace(/\//g, "\\")}`;
        }
        // /home/<user> or /Users/<user> (exact) -> C:\Users\<targetUser>
        if (inputPath.match(/^\/(home|Users)\/[^/]+$/)) {
            return `C:\\Users\\${targetUser}`;
        }
        // /home/<user>/... or /Users/<user>/... -> C:\Users\<targetUser>\...
        const homeMatch = inputPath.match(/^\/(home|Users)\/([^/]+)\/(.*)/);
        if (homeMatch) {
            const rest = homeMatch[3];
            return `C:\\Users\\${targetUser}\\${rest.replace(/\//g, "\\")}`;
        }
        return inputPath;
    }
    // Windows -> WSL/Linux
    if (sourceIsWin && (targetIsWsl || targetPlatform === "linux")) {
        // Normalize backslashes
        const normalized = inputPath.replace(/\\/g, "/");
        // C:\Users\<user> (exact, no subpath) -> /home/<targetUser>
        if (normalized.match(/^[A-Za-z]:\/Users\/[^/]+$/)) {
            return `/home/${targetUser}`;
        }
        // C:\Users\<user>\... -> /home/<targetUser>/...
        const userMatch = normalized.match(/^([A-Za-z]):\/Users\/([^/]+)\/(.*)/);
        if (userMatch) {
            const rest = userMatch[3];
            return `/home/${targetUser}/${rest}`;
        }
        // <DRIVE>:\... -> /mnt/<drive>/...
        const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)/);
        if (driveMatch) {
            const drive = driveMatch[1].toLowerCase();
            const rest = driveMatch[2];
            return `/mnt/${drive}/${rest}`;
        }
        return inputPath;
    }
    // Same platform but different users (no project path override)
    if (sourceUser !== targetUser) {
        return inputPath.replace(new RegExp(`(^|[/\\\\])${escapeRegex(sourceUser)}([/\\\\]|$)`), `$1${targetUser}$2`);
    }
    return inputPath;
}
export function samePlatformFamily(a, b) {
    const wslOrLinux = (p) => p === "linux" || p === "wsl1" || p === "wsl2";
    if (a === b)
        return true;
    if (wslOrLinux(a) && wslOrLinux(b))
        return true;
    return false;
}
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Claude Code's cap on an encoded project-folder name. Verified identical (200)
 * in the embedded JS of 2.1.276, 2.1.277 and 2.1.278 — the minified identifier
 * moves between builds, the value does not. Pin claims to behaviour, never to a
 * minified name.
 */
const MAX_ENCODED_LENGTH = 200;
/**
 * Claude Code's project-path hash, ported verbatim (2.1.277 bundle offset
 * 192032720): Java's `String.hashCode` — times-31 over UTF-16 CODE UNITS,
 * wrapped to int32 at every step.
 *
 * Three things here look like noise and are each load-bearing:
 *
 * - **`charCodeAt`, not code points.** An astral character is TWO units, and
 *   therefore two dashes on the sanitize side. The two halves must agree about
 *   what a character is.
 * - **`| 0` at every step, not at the end.** Without it the running value
 *   leaves int32 and the base36 suffix diverges on any path long enough to be
 *   capped.
 * - **`Math.abs` is on the NUMBER and is deliberately not re-coerced.** The
 *   hash can return exactly `-2147483648`, whose `Math.abs` is `2147483648` —
 *   outside int32 — giving `zik0zk`. Writing `Math.abs(h) | 0` hands back
 *   `-2147483648` and the encoded name grows a stray `-`: `-zik0zk`. Reachable
 *   rather than theoretical, and pinned by a test vector that hashes to exactly
 *   INT32_MIN.
 */
function projectPathHash(input) {
    let h = 0;
    for (let i = 0; i < input.length; i++) {
        h = ((h << 5) - h + input.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
}
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
export function encodeProjectPath(projectPath) {
    const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, "-");
    // Tested on `sanitized`, not on the input. The two lengths are equal today
    // because the replacement is length-preserving on code units — writing it
    // this way is what keeps the cap correct if the character class ever changes.
    if (sanitized.length <= MAX_ENCODED_LENGTH)
        return sanitized;
    return `${sanitized.slice(0, MAX_ENCODED_LENGTH)}-${projectPathHash(projectPath)}`;
}
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
export function legacyEncodeProjectPath(projectPath) {
    let normalized = projectPath.replace(/\\/g, "/");
    normalized = normalized.replace(/^([A-Za-z]):/, "$1");
    return normalized.replace(/\//g, "-");
}
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
export function physicalProjectPath(typed) {
    const absolute = resolve(typed);
    if (process.platform === "win32")
        return absolute;
    const rest = [];
    let head = absolute;
    for (;;) {
        try {
            const real = realpathSync(head);
            return rest.length === 0 ? real : join(real, ...rest.reverse());
        }
        catch {
            const up = dirname(head);
            // Nothing resolved all the way up: keep the lexical absolute path
            // rather than invent one.
            if (up === head)
                return absolute;
            rest.push(basename(head));
            head = up;
        }
    }
}
// NOTE: decodeProjectPath is intentionally NOT provided.
// The encoding is lossy — paths containing hyphens (e.g., /my-project)
// cannot be distinguished from path separators in the encoded form.
// Always read the actual project path from JSONL cwd fields or history.jsonl
// instead of trying to decode the directory name.
export function resolveConfigDir(explicitFlag, envVar) {
    if (explicitFlag)
        return explicitFlag;
    if (envVar)
        return envVar;
    const envConfigDir = process.env.CLAUDE_CONFIG_DIR;
    if (envConfigDir)
        return envConfigDir;
    return join(homedir(), ".claude");
}
export function getCurrentUser() {
    return userInfo().username;
}
export function extractUserFromPath(path, platform) {
    if (platform === "win32") {
        const match = path.replace(/\\/g, "/").match(/^[A-Za-z]:\/Users\/([^/]+)/);
        return match ? match[1] : null;
    }
    // Unix-like
    const homeMatch = path.match(/^\/(home|Users)\/([^/]+)/);
    return homeMatch ? homeMatch[2] : null;
}
//# sourceMappingURL=platform.js.map