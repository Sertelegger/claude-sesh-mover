import {
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { writeManifest, computeIntegrityHash } from "./manifest.js";
import { discoverSessions } from "./discovery.js";
import { detectPlatform } from "./platform.js";
import { extractSummary } from "./summary.js";
import type {
  ExportManifest,
  ExportLayer,
  ExportResult,
  ErrorResult,
  SessionManifest,
  DiscoveredSession,
} from "./types.js";

export interface ExportOptions {
  configDir: string;
  projectPath: string;
  sessionId?: string;
  outputDir: string;
  name: string;
  excludeLayers: ExportLayer[];
  claudeVersion: string;
  collisionCheck?: boolean;
  summaryOverrides?: Record<string, string>; // sessionId -> summary
}

export async function exportSession(
  options: ExportOptions
): Promise<ExportResult | ErrorResult> {
  const {
    configDir,
    projectPath,
    sessionId,
    outputDir,
    name,
    excludeLayers,
    claudeVersion,
    collisionCheck,
    summaryOverrides,
  } = options;

  const exportPath = join(outputDir, name);

  // Collision check
  if (collisionCheck && existsSync(exportPath)) {
    return {
      success: true,
      command: "export",
      exportPath,
      sessions: [],
      warnings: [],
      archivePath: null,
      collision: true,
      existingPath: exportPath,
    };
  }

  // Find the session
  const sessions = discoverSessions(configDir, projectPath);
  const target = sessionId
    ? sessions.find((s) => s.sessionId === sessionId)
    : sessions[0];

  if (!target) {
    return {
      success: false,
      command: "export",
      error: sessionId
        ? `Session ${sessionId} not found`
        : "No sessions found for this project",
    };
  }

  return exportSessions(
    [target],
    configDir,
    projectPath,
    exportPath,
    excludeLayers,
    claudeVersion,
    "current",
    summaryOverrides
  );
}

export async function exportAllSessions(
  options: Omit<ExportOptions, "sessionId">
): Promise<ExportResult | ErrorResult> {
  const {
    configDir,
    projectPath,
    outputDir,
    name,
    excludeLayers,
    claudeVersion,
    summaryOverrides,
  } = options;

  const sessions = discoverSessions(configDir, projectPath);
  if (sessions.length === 0) {
    return {
      success: false,
      command: "export",
      error: "No sessions found for this project",
    };
  }

  const exportPath = join(outputDir, name);
  return exportSessions(
    sessions,
    configDir,
    projectPath,
    exportPath,
    excludeLayers,
    claudeVersion,
    "all",
    summaryOverrides
  );
}

async function exportSessions(
  sessions: DiscoveredSession[],
  configDir: string,
  projectPath: string,
  exportPath: string,
  excludeLayers: ExportLayer[],
  claudeVersion: string,
  scope: "current" | "all",
  summaryOverrides?: Record<string, string>
): Promise<ExportResult | ErrorResult> {
  const includedLayers = getAllLayers().filter(
    (l) => !excludeLayers.includes(l)
  );
  const warnings: string[] = [];

  // Create export directory structure
  mkdirSync(join(exportPath, "sessions"), { recursive: true });

  const sessionManifests: SessionManifest[] = [];

  for (const session of sessions) {
    // Copy JSONL
    const jsonlContent = readFileSync(session.jsonlPath, "utf-8");

    writeFileSync(
      join(exportPath, "sessions", `${session.sessionId}.jsonl`),
      jsonlContent
    );

    // Copy subagents
    if (includedLayers.includes("subagents")) {
      const subagentsDir = join(
        configDir,
        "projects",
        session.encodedProjectDir,
        session.sessionId,
        "subagents"
      );
      if (existsSync(subagentsDir)) {
        const targetSubDir = join(
          exportPath,
          "sessions",
          session.sessionId,
          "subagents"
        );
        mkdirSync(targetSubDir, { recursive: true });
        for (const file of readdirSync(subagentsDir)) {
          copyFileSync(join(subagentsDir, file), join(targetSubDir, file));
        }
      }
    }

    // Copy tool results
    if (includedLayers.includes("tool-results")) {
      const toolResultsDir = join(
        configDir,
        "projects",
        session.encodedProjectDir,
        session.sessionId,
        "tool-results"
      );
      if (existsSync(toolResultsDir)) {
        const targetTrDir = join(
          exportPath,
          "sessions",
          session.sessionId,
          "tool-results"
        );
        mkdirSync(targetTrDir, { recursive: true });
        for (const file of readdirSync(toolResultsDir)) {
          copyFileSync(join(toolResultsDir, file), join(targetTrDir, file));
        }
      }
    }

    // Copy file history
    if (includedLayers.includes("file-history")) {
      const fileHistoryDir = join(
        configDir,
        "file-history",
        session.sessionId
      );
      if (existsSync(fileHistoryDir)) {
        const targetFhDir = join(
          exportPath,
          "file-history",
          session.sessionId
        );
        mkdirSync(targetFhDir, { recursive: true });
        for (const file of readdirSync(fileHistoryDir)) {
          copyFileSync(join(fileHistoryDir, file), join(targetFhDir, file));
        }
      }
    }

    // Content already in memory from the write above — parsing here is for summary extraction
    const entries = jsonlContent
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const summary =
      summaryOverrides?.[session.sessionId] ??
      extractSummary(session.slug, entries);

    // Per-session integrity hash
    const sessionHash = computeIntegrityHash([jsonlContent]);

    sessionManifests.push({
      sessionId: session.sessionId,
      slug: session.slug,
      summary,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      messageCount: session.messageCount,
      gitBranch: session.gitBranch,
      entrypoint: session.entrypoint,
      integrityHash: sessionHash,
    });
  }

  // Copy memory (shared across sessions in a project)
  if (includedLayers.includes("memory")) {
    const encoded = sessions[0].encodedProjectDir;
    const memoryDir = join(configDir, "projects", encoded, "memory");
    if (existsSync(memoryDir)) {
      const targetMemDir = join(exportPath, "memory");
      mkdirSync(targetMemDir, { recursive: true });
      for (const file of readdirSync(memoryDir)) {
        copyFileSync(join(memoryDir, file), join(targetMemDir, file));
      }
    }
  }

  // Copy plans
  if (includedLayers.includes("plans")) {
    const plansDir = join(configDir, "plans");
    if (existsSync(plansDir)) {
      const planFiles = readdirSync(plansDir).filter((f) =>
        f.endsWith(".md")
      );
      if (planFiles.length > 0) {
        const targetPlansDir = join(exportPath, "plans");
        mkdirSync(targetPlansDir, { recursive: true });
        for (const file of planFiles) {
          copyFileSync(join(plansDir, file), join(targetPlansDir, file));
        }
      }
    }
  }

  // Write manifest (per-session integrity hashes are already in sessionManifests)
  const manifest: ExportManifest = {
    version: 1,
    plugin: "sesh-mover",
    exportedAt: new Date().toISOString(),
    sourcePlatform: detectPlatform(),
    sourceProjectPath: projectPath,
    sourceConfigDir: configDir,
    sourceClaudeVersion: claudeVersion,
    sessionScope: scope,
    includedLayers,
    sessions: sessionManifests,
  };

  writeManifest(exportPath, manifest);

  // Add warnings for excluded layers
  for (const layer of excludeLayers) {
    warnings.push(`${layer} excluded by user request`);
  }

  return {
    success: true,
    command: "export",
    exportPath,
    sessions: sessionManifests.map((s) => ({
      originalId: s.sessionId,
      slug: s.slug,
      summary: s.summary,
      messageCount: s.messageCount,
      exportedLayers: includedLayers,
    })),
    warnings,
    archivePath: null,
    collision: false,
  };
}

function getAllLayers(): ExportLayer[] {
  return [
    "jsonl",
    "subagents",
    "file-history",
    "tool-results",
    "memory",
    "plans",
  ];
}
