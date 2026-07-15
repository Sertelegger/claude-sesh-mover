import {
  mkdirSync,
  copyFileSync,
  readdirSync,
  existsSync,
  createReadStream,
  createWriteStream,
} from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { writeManifest } from "./manifest.js";
import { discoverSessions } from "./discovery.js";
import { detectPlatform } from "./platform.js";
import { extractSummaryFromFile } from "./summary.js";
import { buildContinuationStream } from "./continuation.js";
import { computeIncrementalPlan } from "./diff.js";
import { readEntryUuids } from "./jsonl.js";
import type {
  ExportManifest,
  ExportLayer,
  ExportResult,
  ErrorResult,
  SessionManifest,
  DiscoveredSession,
  SyncStateSessionSent,
} from "./types.js";

function copyDirIfExists(srcDir: string, destDir: string): void {
  if (!existsSync(srcDir)) return;
  mkdirSync(destDir, { recursive: true });
  for (const file of readdirSync(srcDir)) {
    copyFileSync(join(srcDir, file), join(destDir, file));
  }
}

// Stream copy with a sha256 tee: the copy and the manifest hash in one pass,
// O(chunk) memory. onBytes reports cumulative bytes for progress.
async function copyFileWithHash(
  src: string,
  dest: string,
  onBytes?: (bytesProcessed: number) => void
): Promise<string> {
  const hash = createHash("sha256");
  const input = createReadStream(src);
  const output = createWriteStream(dest);
  let bytes = 0;
  // Same error-latch hardening as rewriter.ts's rewriteJsonlStream and
  // continuation.ts's buildContinuationStream: without racing a latched
  // 'error' promise at both await points, a write failure (bad dest dir,
  // disk full, EACCES) either crashes the process (unhandled 'error' event)
  // or hangs forever (once(output, "drain") missing an 'error' that fired
  // before the wait began).
  const outputErrored: Promise<never> = new Promise<never>((_, reject) =>
    output.once("error", reject)
  );
  outputErrored.catch(() => {});
  try {
    for await (const chunk of input) {
      const buf = chunk as Buffer;
      hash.update(buf);
      bytes += buf.length;
      if (!output.write(buf)) {
        await Promise.race([once(output, "drain"), outputErrored]);
      }
      onBytes?.(bytes);
    }
    output.end();
    await Promise.race([finished(output), outputErrored]);
  } catch (e) {
    output.destroy();
    throw e;
  } finally {
    input.destroy();
  }
  return `sha256:${hash.digest("hex")}`;
}

export interface IncrementalExportOptions {
  sourceMachineId: string;
  sourceMachineName: string;
  targetMachineId?: string;
  targetMachineName?: string;
  referenceExport?: string;
  lastSyncAt?: string;
  peerSent: Record<string, SyncStateSessionSent>;
}

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
  incremental?: IncrementalExportOptions;
  noSummary?: boolean;
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
    incremental,
    noSummary,
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
    summaryOverrides,
    noSummary,
    incremental
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
    incremental,
    noSummary,
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
    summaryOverrides,
    noSummary,
    incremental
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
  summaryOverrides?: Record<string, string>,
  noSummary?: boolean,
  incremental?: IncrementalExportOptions
): Promise<ExportResult | ErrorResult> {
  const includedLayers = getAllLayers().filter((l) => !excludeLayers.includes(l));
  const warnings: string[] = [];

  mkdirSync(join(exportPath, "sessions"), { recursive: true });

  const sessionManifests: SessionManifest[] = [];

  let toFull: DiscoveredSession[] = sessions;
  let toContinuation: Array<{
    session: DiscoveredSession;
    fromEntryIndex: number;
    fromEntryUuid: string;
  }> = [];

  if (incremental) {
    const uuidsBySession = new Map<string, Array<{ uuid: string }>>();
    for (const session of sessions) {
      uuidsBySession.set(session.sessionId, await readEntryUuids(session.jsonlPath));
    }
    const plan = computeIncrementalPlan(
      sessions,
      incremental.peerSent,
      (session) => uuidsBySession.get(session.sessionId)!
    );
    warnings.push(...plan.warnings);
    toFull = plan.full;
    toContinuation = plan.continuation;
  }

  for (const session of toFull) {
    const destJsonl = join(exportPath, "sessions", `${session.sessionId}.jsonl`);
    // copyFileWithHash returns "sha256:<hex>" — used directly as the manifest hash
    const sessionHash = await copyFileWithHash(session.jsonlPath, destJsonl);

    const sessionBase = join(configDir, "projects", session.encodedProjectDir, session.sessionId);
    if (includedLayers.includes("subagents")) {
      copyDirIfExists(join(sessionBase, "subagents"), join(exportPath, "sessions", session.sessionId, "subagents"));
    }
    if (includedLayers.includes("tool-results")) {
      copyDirIfExists(join(sessionBase, "tool-results"), join(exportPath, "sessions", session.sessionId, "tool-results"));
    }
    if (includedLayers.includes("file-history")) {
      copyDirIfExists(join(configDir, "file-history", session.sessionId), join(exportPath, "file-history", session.sessionId));
    }

    const summary = noSummary
      ? session.slug
      : summaryOverrides?.[session.sessionId] ??
        (await extractSummaryFromFile(session.slug, session.jsonlPath));

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
      type: incremental ? "full" : undefined,
    });
  }

  for (const item of toContinuation) {
    const newSessionId = randomUUID();
    const prevLocal = incremental?.peerSent[item.session.sessionId]?.sentAsSessionId;
    const contDest = join(exportPath, "sessions", `${newSessionId}.jsonl`);
    const { entryCount, integrityHash } = await buildContinuationStream({
      sourceJsonlPath: item.session.jsonlPath,
      outputPath: contDest,
      fromEntryIndex: item.fromEntryIndex,
      fromEntryUuid: item.fromEntryUuid,
      newSessionId,
      sourceSessionId: item.session.sessionId,
      sourceMachineId: incremental!.sourceMachineId,
      sourceMachineName: incremental!.sourceMachineName,
      previousLocalSessionId: prevLocal,
      targetProjectPath: projectPath,
      claudeVersion,
    });

    const contBase = join(configDir, "projects", item.session.encodedProjectDir, item.session.sessionId);
    if (includedLayers.includes("subagents")) {
      copyDirIfExists(join(contBase, "subagents"), join(exportPath, "sessions", newSessionId, "subagents"));
    }
    if (includedLayers.includes("tool-results")) {
      copyDirIfExists(join(contBase, "tool-results"), join(exportPath, "sessions", newSessionId, "tool-results"));
    }
    if (includedLayers.includes("file-history")) {
      copyDirIfExists(join(configDir, "file-history", item.session.sessionId), join(exportPath, "file-history", newSessionId));
    }

    sessionManifests.push({
      sessionId: newSessionId,
      slug: item.session.slug,
      summary: `continuation of ${item.session.slug}`,
      createdAt: new Date().toISOString(),
      lastActiveAt: item.session.lastActiveAt,
      messageCount: entryCount,
      gitBranch: item.session.gitBranch,
      entrypoint: item.session.entrypoint,
      integrityHash,
      type: "continuation",
      continuation: {
        continuesLocalSessionId: item.session.sessionId,
        continuesPeerSessionId: incremental?.peerSent[item.session.sessionId]?.sentAsSessionId,
        fromEntryIndex: item.fromEntryIndex,
        fromEntryUuid: item.fromEntryUuid,
      },
    });
  }

  if (!incremental) {
    if (includedLayers.includes("memory") && sessions.length > 0) {
      const encoded = sessions[0].encodedProjectDir;
      const memoryDir = join(configDir, "projects", encoded, "memory");
      copyDirIfExists(memoryDir, join(exportPath, "memory"));
    }
    if (includedLayers.includes("plans")) {
      const plansDir = join(configDir, "plans");
      if (existsSync(plansDir)) {
        const planFiles = readdirSync(plansDir).filter((f) => f.endsWith(".md"));
        if (planFiles.length > 0) {
          const targetPlansDir = join(exportPath, "plans");
          mkdirSync(targetPlansDir, { recursive: true });
          for (const file of planFiles) {
            copyFileSync(join(plansDir, file), join(targetPlansDir, file));
          }
        }
      }
    }
  }

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
    sourceMachineId: incremental?.sourceMachineId,
    sourceMachineName: incremental?.sourceMachineName,
    incremental: incremental ? true : undefined,
    baseline: incremental?.targetMachineId
      ? {
          targetMachineId: incremental.targetMachineId,
          targetMachineName: incremental.targetMachineName,
          lastSyncAt: incremental.lastSyncAt,
          referenceExport: incremental.referenceExport,
        }
      : undefined,
  };

  writeManifest(exportPath, manifest);

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
