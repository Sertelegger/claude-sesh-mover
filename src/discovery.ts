import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodeProjectPath } from "./platform.js";
import {
  readFirstJsonlLine,
  readFirstConversationEntry,
  readLastConversationEntry,
  countJsonlLines,
} from "./jsonl.js";
import type { DiscoveredSession } from "./types.js";

export function discoverSessions(
  configDir: string,
  projectPath: string
): DiscoveredSession[] {
  const encoded = encodeProjectPath(projectPath);
  const projectDir = join(configDir, "projects", encoded);

  if (!existsSync(projectDir)) {
    return [];
  }

  const sessions: DiscoveredSession[] = [];

  const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));

  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    const jsonlPath = join(projectDir, file);
    const session = parseSessionJsonl(
      jsonlPath,
      sessionId,
      projectPath,
      encoded,
      configDir
    );
    if (session) {
      sessions.push(session);
    }
  }

  return sessions.sort(
    (a, b) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
  );
}

export function discoverSessionById(
  configDir: string,
  sessionId: string
): DiscoveredSession | null {
  const projectsDir = join(configDir, "projects");
  if (!existsSync(projectsDir)) return null;

  const projectDirs = readdirSync(projectsDir);

  for (const encoded of projectDirs) {
    const jsonlPath = join(projectsDir, encoded, `${sessionId}.jsonl`);
    if (existsSync(jsonlPath)) {
      // Read actual project path from JSONL (encoding is lossy, cannot decode)
      const projectPath = readProjectPathFromJsonl(jsonlPath) ?? encoded;
      const session = parseSessionJsonl(
        jsonlPath,
        sessionId,
        projectPath,
        encoded,
        configDir
      );
      return session;
    }
  }

  return null;
}

export function listAllProjects(
  configDir: string
): Array<{ projectPath: string; encodedDir: string; sessionCount: number }> {
  const projectsDir = join(configDir, "projects");
  if (!existsSync(projectsDir)) return [];

  const dirs = readdirSync(projectsDir);
  const projects: Array<{
    projectPath: string;
    encodedDir: string;
    sessionCount: number;
  }> = [];

  for (const encoded of dirs) {
    const dirPath = join(projectsDir, encoded);
    if (!statSync(dirPath).isDirectory()) continue;

    const jsonlFiles = readdirSync(dirPath).filter((f) =>
      f.endsWith(".jsonl")
    );
    if (jsonlFiles.length > 0) {
      // Read actual project path from first session's JSONL (lossy encoding, cannot decode)
      const firstJsonl = join(dirPath, jsonlFiles[0]);
      const projectPath = readProjectPathFromJsonl(firstJsonl) ?? encoded;
      projects.push({
        projectPath,
        encodedDir: encoded,
        sessionCount: jsonlFiles.length,
      });
    }
  }

  return projects;
}

/**
 * Read the actual project path from a JSONL file by finding the first entry with a cwd field.
 * This is necessary because the directory encoding (/ -> -) is lossy for hyphenated paths.
 *
 * It reads the first CONVERSATION entry, not the literal first line: Claude
 * Code writes uuid-less bookkeeping (`last-prompt`, `queue-operation`,
 * `ai-title`, …) at the top of a transcript, and those entries have no `cwd`.
 * Measured 2026-08-04, the first line of 7 of 7 real transcripts on this
 * machine was such an entry, so this returned `null` for all of them and every
 * caller silently fell back to the lossy encoded directory name — the exact
 * decoding this function exists to avoid.
 */
function readProjectPathFromJsonl(jsonlPath: string): string | null {
  const entry = readFirstConversationEntry(jsonlPath);
  const cwd = entry?.cwd;
  return typeof cwd === "string" ? cwd : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseSessionJsonl(
  jsonlPath: string,
  sessionId: string,
  projectPath: string,
  encodedProjectDir: string,
  configDir: string
): DiscoveredSession | null {
  try {
    // Session metadata comes off the first and last CONVERSATION entries, not
    // the literal first and last lines. Claude Code brackets a transcript with
    // uuid-less bookkeeping at BOTH ends, and those entries carry none of the
    // fields read below — no `timestamp`, no `cwd`, no `gitBranch`. Reading the
    // raw last line is what made `lastActiveAt` `undefined` on real sessions,
    // which then sorts as NaN and is dropped outright by `JSON.stringify`.
    let firstEntry = readFirstConversationEntry(jsonlPath);
    if (!firstEntry) {
      // No conversation entry at all (or an unreadable leading line): fall back
      // to the literal first line so a degraded transcript still lists rather
      // than disappearing from browse/export.
      const firstLine = readFirstJsonlLine(jsonlPath);
      if (!firstLine) return null;
      try {
        firstEntry = JSON.parse(firstLine) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    const lastEntry = readLastConversationEntry(jsonlPath) ?? firstEntry;
    const messageCount = countJsonlLines(jsonlPath);
    if (messageCount === 0) return null;

    // Check for subagents
    const sessionSubDir = join(
      configDir,
      "projects",
      encodedProjectDir,
      sessionId,
      "subagents"
    );
    const hasSubagents =
      existsSync(sessionSubDir) && readdirSync(sessionSubDir).length > 0;

    // Check for tool results
    const toolResultsDir = join(
      configDir,
      "projects",
      encodedProjectDir,
      sessionId,
      "tool-results"
    );
    const hasToolResults =
      existsSync(toolResultsDir) && readdirSync(toolResultsDir).length > 0;

    // Check for file history
    const fileHistoryDir = join(configDir, "file-history", sessionId);
    const hasFileHistory =
      existsSync(fileHistoryDir) && readdirSync(fileHistoryDir).length > 0;

    // Both fields are typed `string` and are consumed as dates (sorted with
    // getTime(), written into manifests and hub indexes). An entry with no
    // timestamp would make them `undefined` — NaN in every sort, and silently
    // absent from any JSON.stringify'd record — so mtime, which is always
    // available and is a truthful answer for "last touched", is the floor.
    //
    // `createdAt` falls through the LAST entry's timestamp before reaching
    // mtime. Only the degraded shapes get that far (a transcript whose leading
    // line is unreadable, or which holds no conversation entry at all), and
    // without the middle step they came out with `createdAt` = now and
    // `lastActiveAt` = the real, older conversation timestamp — i.e. created
    // after last active. Informational only, no sort depends on the pair, but
    // there is no reason to publish an impossible one.
    //
    // The mtime floor is also the one place a FILESYSTEM clock can enter
    // `lastActiveAt`, which `resolveThreads` compares across machines to pick
    // the latest copy. Benign in practice — it is unreachable for any
    // non-degraded transcript (0 of 7 real ones), and an mtime is stable rather
    // than drifting — but it is a different clock from the one every other copy
    // is dated by, so a thread whose winner is decided on an mtime is being
    // decided on a weaker basis than one decided on entry timestamps.
    const mtimeIso = (): string => statSync(jsonlPath).mtime.toISOString();
    const createdAt =
      asString(firstEntry.timestamp) ?? asString(lastEntry.timestamp) ?? mtimeIso();
    const lastActiveAt = asString(lastEntry.timestamp) ?? createdAt;

    return {
      sessionId,
      projectPath,
      encodedProjectDir,
      jsonlPath,
      slug: (firstEntry.slug as string) || sessionId,
      createdAt,
      lastActiveAt,
      messageCount,
      gitBranch: (firstEntry.gitBranch as string) || "unknown",
      entrypoint: (firstEntry.entrypoint as string) || "cli",
      hasSubagents,
      hasToolResults,
      hasFileHistory,
    };
  } catch {
    return null;
  }
}
