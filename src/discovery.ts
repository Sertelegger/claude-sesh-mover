import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodeProjectPath } from "./platform.js";
import {
  readFirstJsonlLine,
  readLastJsonlLine,
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
 */
function readProjectPathFromJsonl(jsonlPath: string): string | null {
  const firstLine = readFirstJsonlLine(jsonlPath);
  if (!firstLine) return null;
  try {
    return (JSON.parse(firstLine) as { cwd?: string }).cwd ?? null;
  } catch {
    return null;
  }
}

function parseSessionJsonl(
  jsonlPath: string,
  sessionId: string,
  projectPath: string,
  encodedProjectDir: string,
  configDir: string
): DiscoveredSession | null {
  try {
    const firstLine = readFirstJsonlLine(jsonlPath);
    if (!firstLine) return null;
    let firstEntry: Record<string, unknown>;
    try {
      firstEntry = JSON.parse(firstLine);
    } catch {
      return null;
    }
    const lastLine = readLastJsonlLine(jsonlPath);
    let lastEntry: Record<string, unknown> = firstEntry;
    if (lastLine) {
      try {
        lastEntry = JSON.parse(lastLine);
      } catch {
        /* keep firstEntry as fallback */
      }
    }
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

    return {
      sessionId,
      projectPath,
      encodedProjectDir,
      jsonlPath,
      slug: (firstEntry.slug as string) || sessionId,
      createdAt: firstEntry.timestamp as string,
      lastActiveAt: lastEntry.timestamp as string,
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
