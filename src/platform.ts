import { readFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Platform } from "./types.js";

export interface TranslateOptions {
  sourceUser: string;
  targetUser: string;
  sourceProjectPath?: string;
  targetProjectPath?: string;
}

export function detectPlatform(): Platform {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";

  // Linux — check for WSL
  if (process.platform === "linux") {
    try {
      if (existsSync("/proc/version")) {
        const procVersion = readFileSync("/proc/version", "utf-8");
        if (/microsoft/i.test(procVersion)) {
          // Detect WSL version
          if (/WSL2/i.test(procVersion)) return "wsl2";
          return "wsl1";
        }
      }
      if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) {
        return "wsl2"; // WSLInterop fallback — unreachable in practice since /proc/version check fires first on any WSL system
      }
    } catch {
      // If we can't read proc, assume standard Linux
    }
    return "linux";
  }

  return "linux"; // fallback
}

// Note: darwin↔linux cross-platform translation is intentionally not handled here. Callers always provide sourceProjectPath/targetProjectPath for those cases, which triggers same-platform substitution.
export function translatePath(
  inputPath: string,
  sourcePlatform: Platform,
  targetPlatform: Platform,
  options: TranslateOptions
): string {
  const { sourceUser, targetUser, sourceProjectPath, targetProjectPath } =
    options;

  // Same-platform path substitution
  if (
    samePlatformFamily(sourcePlatform, targetPlatform) &&
    sourceProjectPath &&
    targetProjectPath
  ) {
    if (inputPath.startsWith(sourceProjectPath)) {
      return targetProjectPath + inputPath.slice(sourceProjectPath.length);
    }
    // Also handle username-only changes
    // Intentionally rewrites usernames in ALL paths (not just under sourceProjectPath) since JSONL entries contain paths outside the project (e.g., config dirs, tool paths).
    if (sourceUser !== targetUser) {
      return inputPath.replace(
        new RegExp(`(^|/)${escapeRegex(sourceUser)}(/|$)`),
        `$1${targetUser}$2`
      );
    }
    return inputPath;
  }

  const sourceIsWsl = sourcePlatform === "wsl1" || sourcePlatform === "wsl2";
  const targetIsWsl = targetPlatform === "wsl1" || targetPlatform === "wsl2";
  const sourceIsWin = sourcePlatform === "win32";
  const targetIsWin = targetPlatform === "win32";

  // WSL/Linux -> Windows
  if ((sourceIsWsl || sourcePlatform === "linux") && targetIsWin) {
    // /tmp (exact) or /tmp/... -> C:\Users\<user>\AppData\Local\Temp\...
    if (inputPath === "/tmp") {
      return `C:\\Users\\${targetUser}\\AppData\\Local\\Temp`;
    }
    if (inputPath.startsWith("/tmp/")) {
      const rest = inputPath.slice(5);
      return `C:\\Users\\${targetUser}\\AppData\\Local\\Temp\\${rest}`.replace(
        /\//g,
        "\\"
      );
    }
    // /mnt/<drive>/... -> <DRIVE>:\...
    const mntMatch = inputPath.match(/^\/mnt\/([a-zA-Z])\/(.*)/);
    if (mntMatch) {
      const drive = mntMatch[1].toUpperCase();
      const rest = mntMatch[2];
      return `${drive}:\\${rest.replace(/\//g, "\\")}`;
    }
    // /home/<user> (exact) -> C:\Users\<targetUser>
    if (inputPath.match(/^\/home\/[^/]+$/)) {
      return `C:\\Users\\${targetUser}`;
    }
    // /home/<user>/... -> C:\Users\<targetUser>\...
    const homeMatch = inputPath.match(/^\/home\/([^/]+)\/(.*)/);
    if (homeMatch) {
      const rest = homeMatch[2];
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
    const userMatch = normalized.match(
      /^([A-Za-z]):\/Users\/([^/]+)\/(.*)/
    );
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
    return inputPath.replace(
      new RegExp(`(^|[/\\\\])${escapeRegex(sourceUser)}([/\\\\]|$)`),
      `$1${targetUser}$2`
    );
  }

  return inputPath;
}

export function samePlatformFamily(a: Platform, b: Platform): boolean {
  const wslOrLinux = (p: Platform) =>
    p === "linux" || p === "wsl1" || p === "wsl2";
  if (a === b) return true;
  if (wslOrLinux(a) && wslOrLinux(b)) return true;
  return false;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function encodeProjectPath(projectPath: string): string {
  // Claude Code encodes project paths by replacing / with -
  // On Windows, normalize backslashes to forward slashes first, remove drive colon
  // "/Users/sascha/Projects/foo" -> "-Users-sascha-Projects-foo"
  // "C:\Users\sascha\Projects\foo" -> "C-Users-sascha-Projects-foo"
  let normalized = projectPath.replace(/\\/g, "/");
  // Remove colon from drive letter (C: -> C)
  normalized = normalized.replace(/^([A-Za-z]):/, "$1");
  return normalized.replace(/\//g, "-");
}

// NOTE: decodeProjectPath is intentionally NOT provided.
// The encoding is lossy — paths containing hyphens (e.g., /my-project)
// cannot be distinguished from path separators in the encoded form.
// Always read the actual project path from JSONL cwd fields or history.jsonl
// instead of trying to decode the directory name.

export function resolveConfigDir(
  explicitFlag?: string,
  envVar?: string
): string {
  if (explicitFlag) return explicitFlag;
  if (envVar) return envVar;
  const envConfigDir = process.env.CLAUDE_CONFIG_DIR;
  if (envConfigDir) return envConfigDir;
  return join(homedir(), ".claude");
}

export function getCurrentUser(): string {
  return userInfo().username;
}

export function extractUserFromPath(
  path: string,
  platform: Platform
): string | null {
  if (platform === "win32") {
    const match = path.replace(/\\/g, "/").match(/^[A-Za-z]:\/Users\/([^/]+)/);
    return match ? match[1] : null;
  }
  // Unix-like
  const homeMatch = path.match(/^\/(home|Users)\/([^/]+)/);
  return homeMatch ? homeMatch[2] : null;
}
