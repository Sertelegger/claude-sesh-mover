import type { PathMapping, RewriteReport, Platform } from "./types.js";
import { samePlatformFamily, translatePath } from "./platform.js";

export interface RewriteContext {
  mappings: PathMapping[];
  sourcePlatform: Platform;
  targetPlatform: Platform;
  sourceUser: string;
  targetUser: string;
}

// Characters that terminate a path token embedded in free text.
const UNIX_TOKEN = /(?:\/[A-Za-z0-9._@+~-]+)+\/?/g;
const WIN_TOKEN = /[A-Za-z]:\\[^\s"'`)\]}>,;]*/g;
const TAIL = /[^\s"'`)\]}>,;:]*/;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSeparators(tail: string, targetPlatform: Platform): string {
  return targetPlatform === "win32"
    ? tail.replace(/\//g, "\\")
    : tail.replace(/\\/g, "/");
}

export function rewriteString(input: string, ctx: RewriteContext): string {
  const crossFamily = !samePlatformFamily(ctx.sourcePlatform, ctx.targetPlatform);
  let result = input;

  // Stage 1: exact mappings (project path, config dir, home), longest first.
  // Cross-family, the tail after the replacement gets its separators
  // normalized up to a token boundary; same-family tails are left alone.
  for (const mapping of ctx.mappings) {
    const re = new RegExp(escapeRegex(mapping.from) + "(" + TAIL.source + ")", "g");
    result = result.replace(re, (_m, tail: string) =>
      mapping.to + (crossFamily ? normalizeSeparators(tail, ctx.targetPlatform) : tail)
    );
  }

  // Stage 2 (cross-family only): translate remaining path-like tokens through
  // the platform engine (/mnt/<drive>, /tmp, /home, /Users, drive letters).
  if (crossFamily) {
    const tokenRe = ctx.sourcePlatform === "win32" ? WIN_TOKEN : UNIX_TOKEN;
    result = result.replace(tokenRe, (token) =>
      translatePath(token, ctx.sourcePlatform, ctx.targetPlatform, {
        sourceUser: ctx.sourceUser,
        targetUser: ctx.targetUser,
      })
    );
  }

  return result;
}

export function buildPathMappings(
  sourcePlatform: Platform,
  targetPlatform: Platform,
  sourceProjectPath: string,
  targetProjectPath: string,
  sourceConfigDir: string,
  targetConfigDir: string,
  sourceUser: string,
  targetUser: string
): PathMapping[] {
  const mappings: PathMapping[] = [];

  // Project path mapping (most specific first)
  if (sourceProjectPath !== targetProjectPath) {
    mappings.push({
      from: sourceProjectPath,
      to: targetProjectPath,
      description: `Project path: ${sourceProjectPath} -> ${targetProjectPath}`,
    });
  }

  // Config dir mapping
  if (sourceConfigDir !== targetConfigDir) {
    mappings.push({
      from: sourceConfigDir,
      to: targetConfigDir,
      description: `Config dir: ${sourceConfigDir} -> ${targetConfigDir}`,
    });
  }

  // Home dir mapping — cross-platform or same-platform different user
  if (!samePlatformFamily(sourcePlatform, targetPlatform)) {
    const sourceHome = getHomePath(sourcePlatform, sourceUser);
    const targetHome = getHomePath(targetPlatform, targetUser);
    if (sourceHome !== targetHome) {
      mappings.push({
        from: sourceHome,
        to: targetHome,
        description: `Home dir: ${sourceHome} -> ${targetHome}`,
      });
    }
  } else if (sourceUser !== targetUser) {
    // Same platform family, different user
    const sourceHome = getHomePath(sourcePlatform, sourceUser);
    const targetHome = getHomePath(targetPlatform, targetUser);
    if (sourceHome !== targetHome) {
      mappings.push({
        from: sourceHome,
        to: targetHome,
        description: `User home: ${sourceHome} -> ${targetHome}`,
      });
    }
  }

  // Sort longest-from first to prevent prefix collisions
  mappings.sort((a, b) => b.from.length - a.from.length);

  return mappings;
}

function getHomePath(platform: Platform, user: string): string {
  if (platform === "win32") return `C:\\Users\\${user}`;
  if (platform === "darwin") return `/Users/${user}`;
  return `/home/${user}`;
}

export function rewriteEntry(
  entry: Record<string, unknown>,
  ctx: RewriteContext,
  newSessionId?: string
): Record<string, unknown> {
  const result = structuredClone(entry);

  // Rewrite sessionId
  if (newSessionId) {
    result.sessionId = newSessionId;
  }

  // Rewrite cwd (always)
  if (typeof result.cwd === "string") {
    result.cwd = rewriteString(result.cwd, ctx);
  }

  // Rewrite tool_result content and toolUseResult for user entries
  if (result.type === "user" && result.message) {
    const msg = result.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.map((item: Record<string, unknown>) => {
        if (item.type === "tool_result" && typeof item.content === "string") {
          return { ...item, content: rewriteString(item.content, ctx) };
        }
        if (item.type === "tool_result" && Array.isArray(item.content)) {
          return {
            ...item,
            content: (item.content as Array<Record<string, unknown>>).map((block) =>
              block?.type === "text" && typeof block.text === "string"
                ? { ...block, text: rewriteString(block.text as string, ctx) }
                : block
            ),
          };
        }
        return item;
      });
    }
    // Do NOT rewrite plain string user message content

    // Rewrite toolUseResult stdout/stderr
    if (result.toolUseResult) {
      const tr = result.toolUseResult as Record<string, unknown>;
      if (typeof tr.stdout === "string") {
        tr.stdout = rewriteString(tr.stdout, ctx);
      }
      if (typeof tr.stderr === "string") {
        tr.stderr = rewriteString(tr.stderr, ctx);
      }
    }
  }

  // Rewrite file-history-snapshot trackedFileBackups keys
  if (result.type === "file-history-snapshot" && result.snapshot) {
    const snapshot = result.snapshot as Record<string, unknown>;
    if (snapshot.trackedFileBackups) {
      const backups = snapshot.trackedFileBackups as Record<string, unknown>;
      const newBackups: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(backups)) {
        const newKey = rewriteString(key, ctx);
        newBackups[newKey] = value;
      }
      snapshot.trackedFileBackups = newBackups;
    }
  }

  return result;
}

export function rewriteJsonl(
  jsonlContent: string,
  ctx: RewriteContext,
  newSessionId?: string
): { rewritten: string; report: RewriteReport } {
  const lines = jsonlContent.trim().split("\n").filter(Boolean);
  let entriesRewritten = 0;
  let fieldsRewritten = 0;
  const warnings: string[] = [];

  const rewrittenLines = lines.map((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const original = JSON.stringify(entry);
      const rewritten = rewriteEntry(entry, ctx, newSessionId);
      const rewrittenStr = JSON.stringify(rewritten);
      if (rewrittenStr !== original) {
        entriesRewritten++;
        // Count changed top-level fields (nested changes are attributed to their parent key)
        for (const key of Object.keys(entry)) {
          if (
            JSON.stringify(entry[key]) !==
            JSON.stringify((rewritten as Record<string, unknown>)[key])
          ) {
            fieldsRewritten++;
          }
        }
      }
      return rewrittenStr;
    } catch (e) {
      warnings.push(`Failed to parse JSONL line: ${(e as Error).message}`);
      return line; // preserve unparseable lines
    }
  });

  return {
    rewritten: rewrittenLines.join("\n") + "\n",
    report: {
      mappings: ctx.mappings,
      entriesRewritten,
      fieldsRewritten,
      warnings,
    },
  };
}
