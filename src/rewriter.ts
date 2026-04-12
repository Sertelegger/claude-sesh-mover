import type { PathMapping, RewriteReport } from "./types.js";
import type { Platform } from "./types.js";
import { samePlatformFamily } from "./platform.js";

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

  return mappings;
}

function getHomePath(platform: Platform, user: string): string {
  if (platform === "win32") return `C:\\Users\\${user}`;
  if (platform === "darwin") return `/Users/${user}`;
  return `/home/${user}`;
}

export function rewriteEntry(
  entry: Record<string, unknown>,
  mappings: PathMapping[],
  newSessionId?: string
): Record<string, unknown> {
  const result = structuredClone(entry);

  // Rewrite sessionId
  if (newSessionId) {
    result.sessionId = newSessionId;
  }

  // Rewrite cwd (always)
  if (typeof result.cwd === "string") {
    result.cwd = applyMappings(result.cwd, mappings);
  }

  // Rewrite tool_result content and toolUseResult for user entries
  if (result.type === "user" && result.message) {
    const msg = result.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.map((item: Record<string, unknown>) => {
        if (item.type === "tool_result" && typeof item.content === "string") {
          return { ...item, content: applyMappings(item.content, mappings) };
        }
        return item;
      });
    }
    // Do NOT rewrite plain string user message content

    // Rewrite toolUseResult stdout/stderr
    if (result.toolUseResult) {
      const tr = result.toolUseResult as Record<string, unknown>;
      if (typeof tr.stdout === "string") {
        tr.stdout = applyMappings(tr.stdout, mappings);
      }
      if (typeof tr.stderr === "string") {
        tr.stderr = applyMappings(tr.stderr, mappings);
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
        const newKey = applyMappings(key, mappings);
        newBackups[newKey] = value;
      }
      snapshot.trackedFileBackups = newBackups;
    }
  }

  return result;
}

export function rewriteJsonl(
  jsonlContent: string,
  mappings: PathMapping[],
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
      const rewritten = rewriteEntry(entry, mappings, newSessionId);
      const rewrittenStr = JSON.stringify(rewritten);
      if (rewrittenStr !== original) {
        entriesRewritten++;
        // Count changed top-level fields
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
      mappings,
      entriesRewritten,
      fieldsRewritten,
      warnings,
    },
  };
}

function applyMappings(input: string, mappings: PathMapping[]): string {
  let result = input;
  for (const mapping of mappings) {
    // Use replaceAll to avoid infinite loop when mapping.to contains mapping.from
    result = result.replaceAll(mapping.from, mapping.to);
  }
  return result;
}
