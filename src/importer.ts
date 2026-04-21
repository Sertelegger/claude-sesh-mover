import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readManifest,
  verifyIntegrity,
  computeIntegrityHash,
} from "./manifest.js";
import { rewriteJsonl, buildPathMappings } from "./rewriter.js";
import {
  encodeProjectPath,
  detectPlatform,
  extractUserFromPath,
  getCurrentUser,
} from "./platform.js";
import {
  getApplicableAdapters,
  applyAdapters,
  classifyVersionDifference,
} from "./version-adapters.js";
import { readSyncState, writeSyncState } from "./sync-state.js";
import type {
  ImportResult,
  DryRunResult,
  ErrorResult,
  RewriteReport,
  SyncStatePeer,
  SyncStateSessionReceived,
  SyncStateSessionSent,
  SyncStateLineage,
} from "./types.js";

export interface ImportOptions {
  exportPath: string;
  targetConfigDir: string;
  targetProjectPath: string;
  targetClaudeVersion: string;
  dryRun: boolean;
  sessionIds?: string[];
  noRegister?: boolean;
}

export async function importSession(
  options: ImportOptions
): Promise<ImportResult | DryRunResult | ErrorResult> {
  const {
    exportPath,
    targetConfigDir,
    targetProjectPath,
    targetClaudeVersion,
    dryRun,
    sessionIds,
    noRegister,
  } = options;

  const warnings: string[] = [];

  // Step 1: Read manifest
  let manifest;
  try {
    manifest = readManifest(exportPath);
  } catch (e) {
    return {
      success: false,
      command: "import",
      error: `Failed to read manifest: ${(e as Error).message}`,
    };
  }

  // Filter sessions if specific IDs requested
  let targetSessions = sessionIds
    ? manifest.sessions.filter((s) => sessionIds.includes(s.sessionId))
    : manifest.sessions;

  if (targetSessions.length === 0) {
    return {
      success: false,
      command: "import",
      error: "No matching sessions found in export",
    };
  }

  let skippedAlreadyReceived = 0;
  if (manifest.sourceMachineId) {
    const priorState = readSyncState(targetProjectPath);
    const peer = priorState.peers[manifest.sourceMachineId];
    if (peer) {
      const before = targetSessions.length;
      targetSessions = targetSessions.filter((session) => {
        const prior = peer.received[session.sessionId];
        return !prior;
      });
      skippedAlreadyReceived = before - targetSessions.length;
      if (skippedAlreadyReceived > 0) {
        warnings.push(
          `${skippedAlreadyReceived} session(s) already received from ${manifest.sourceMachineName ?? manifest.sourceMachineId} — skipped (idempotent).`
        );
      }
    }
  }

  if (targetSessions.length === 0) {
    return {
      success: true,
      command: "import",
      importedSessions: [],
      warnings,
      resumable: true,
    } satisfies ImportResult;
  }

  // Step 1.5: Version reconciliation
  const versionDiff = classifyVersionDifference(
    manifest.sourceClaudeVersion,
    targetClaudeVersion
  );
  const adapters = getApplicableAdapters(
    manifest.sourceClaudeVersion,
    targetClaudeVersion
  );
  const versionAdaptations: string[] = [];

  if (versionDiff === "source-newer") {
    warnings.push(
      `Export from newer Claude Code (${manifest.sourceClaudeVersion}) than target (${targetClaudeVersion}). Unknown entry types will be preserved.`
    );
  }

  // Step 2: Build path mappings
  const targetPlatform = detectPlatform();
  const sourceUser =
    extractUserFromPath(manifest.sourceProjectPath, manifest.sourcePlatform) ??
    "unknown";
  const targetUser = getCurrentUser();

  const mappings = buildPathMappings(
    manifest.sourcePlatform,
    targetPlatform,
    manifest.sourceProjectPath,
    targetProjectPath,
    manifest.sourceConfigDir,
    targetConfigDir,
    sourceUser,
    targetUser
  );

  // Step 3: Verify per-session integrity (before any rewriting)
  const integrityFailedSessions = new Set<string>();
  for (const session of targetSessions) {
    const jsonlPath = join(
      exportPath,
      "sessions",
      `${session.sessionId}.jsonl`
    );
    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, "utf-8");
      if (!verifyIntegrity([content], session.integrityHash)) {
        integrityFailedSessions.add(session.sessionId);
        warnings.push(
          `integrity check failed for session "${session.slug}" (${session.sessionId}): JSONL content doesn't match manifest hash. Data may be corrupted.`
        );
      }
    }
  }

  // Generate new session IDs
  const sessionIdMap = new Map<string, string>();
  for (const session of targetSessions) {
    sessionIdMap.set(session.sessionId, randomUUID());
  }

  const importedSessions: Array<{
    originalId: string;
    newId: string;
    slug: string;
    messageCount: number;
  }> = targetSessions.map((session) => ({
    originalId: session.sessionId,
    newId: sessionIdMap.get(session.sessionId)!,
    slug: session.slug,
    messageCount: session.messageCount,
  }));

  // For dry-run, return the report without writing anything
  if (dryRun) {
    let rewriteReport: RewriteReport | undefined;
    const firstSession = targetSessions[0];
    const firstJsonlPath = join(
      exportPath,
      "sessions",
      `${firstSession.sessionId}.jsonl`
    );
    if (existsSync(firstJsonlPath)) {
      const content = readFileSync(firstJsonlPath, "utf-8");
      const { report } = rewriteJsonl(
        content,
        mappings,
        sessionIdMap.get(firstSession.sessionId)
      );
      rewriteReport = report;
    }

    return {
      success: true,
      command: "import",
      dryRun: true,
      importedSessions,
      warnings,
      resumable: true,
      rewriteReport,
      versionAdaptations: adapters.map((a) => a.description),
    } satisfies DryRunResult;
  }

  // Step 4: Write session files
  const encodedTargetPath = encodeProjectPath(targetProjectPath);
  const targetProjectDir = join(
    targetConfigDir,
    "projects",
    encodedTargetPath
  );
  mkdirSync(targetProjectDir, { recursive: true });

  // Helper: remove only the files written by this import (targeted rollback)
  const rollbackImportedFiles = () => {
    for (const [, newId] of sessionIdMap) {
      // Remove new session JSONL file
      const jsonlFile = join(targetProjectDir, `${newId}.jsonl`);
      if (existsSync(jsonlFile)) rmSync(jsonlFile, { force: true });
      // Remove new session subdirectory (subagents, tool-results)
      const sessionSubDir = join(targetProjectDir, newId);
      if (existsSync(sessionSubDir))
        rmSync(sessionSubDir, { recursive: true, force: true });
      // Remove new file-history directory
      const fhDir = join(targetConfigDir, "file-history", newId);
      if (existsSync(fhDir)) rmSync(fhDir, { recursive: true, force: true });
    }
  };

  try {
    for (const session of targetSessions) {
      const newSessionId = sessionIdMap.get(session.sessionId)!;

      // Rewrite and write JSONL
      const jsonlPath = join(
        exportPath,
        "sessions",
        `${session.sessionId}.jsonl`
      );
      if (existsSync(jsonlPath)) {
        const jsonlContent = readFileSync(jsonlPath, "utf-8");

        // Apply version adapters
        let processedContent = jsonlContent;
        if (adapters.length > 0) {
          const lines = jsonlContent.trim().split("\n").filter(Boolean);
          const adaptedLines = lines.map((line) => {
            try {
              const entry = JSON.parse(line);
              const { entry: adapted, applied } = applyAdapters(entry, adapters);
              versionAdaptations.push(...applied);
              return JSON.stringify(adapted);
            } catch {
              return line;
            }
          });
          processedContent = adaptedLines.join("\n") + "\n";
        }

        const { rewritten } = rewriteJsonl(processedContent, mappings, newSessionId);
        writeFileSync(join(targetProjectDir, `${newSessionId}.jsonl`), rewritten);
      }

      // Copy subagents
      const subagentsDir = join(
        exportPath,
        "sessions",
        session.sessionId,
        "subagents"
      );
      if (existsSync(subagentsDir)) {
        const targetSubDir = join(targetProjectDir, newSessionId, "subagents");
        mkdirSync(targetSubDir, { recursive: true });
        for (const file of readdirSync(subagentsDir)) {
          if (file.endsWith(".jsonl")) {
            // Rewrite subagent JSONL too
            const content = readFileSync(join(subagentsDir, file), "utf-8");
            const { rewritten } = rewriteJsonl(content, mappings, newSessionId);
            writeFileSync(join(targetSubDir, file), rewritten);
          } else {
            copyFileSync(join(subagentsDir, file), join(targetSubDir, file));
          }
        }
      }

      // Copy tool results
      const toolResultsDir = join(
        exportPath,
        "sessions",
        session.sessionId,
        "tool-results"
      );
      if (existsSync(toolResultsDir)) {
        const targetTrDir = join(
          targetProjectDir,
          newSessionId,
          "tool-results"
        );
        mkdirSync(targetTrDir, { recursive: true });
        for (const file of readdirSync(toolResultsDir)) {
          copyFileSync(join(toolResultsDir, file), join(targetTrDir, file));
        }
      }

      // Copy file history
      const fileHistoryDir = join(
        exportPath,
        "file-history",
        session.sessionId
      );
      if (existsSync(fileHistoryDir)) {
        const targetFhDir = join(targetConfigDir, "file-history", newSessionId);
        mkdirSync(targetFhDir, { recursive: true });
        for (const file of readdirSync(fileHistoryDir)) {
          copyFileSync(join(fileHistoryDir, file), join(targetFhDir, file));
        }
      }
    }
  } catch (writeErr) {
    // Mid-write failure: roll back only what this import created
    try {
      rollbackImportedFiles();
    } catch {
      /* best effort cleanup */
    }
    return {
      success: false as const,
      command: "import",
      error: `Import write failed: ${(writeErr as Error).message}`,
      details: "Partially written files have been cleaned up. No indexes were modified.",
      suggestion: "Check available disk space or file permissions and retry.",
    };
  }

  // Step 5: Merge memory files, tracking conflicts for user resolution
  const memoryConflicts: Array<{
    filename: string;
    existingHash: string;
    incomingHash: string;
  }> = [];
  const memoryDir = join(exportPath, "memory");
  if (existsSync(memoryDir)) {
    const targetMemDir = join(targetProjectDir, "memory");
    mkdirSync(targetMemDir, { recursive: true });
    for (const file of readdirSync(memoryDir)) {
      const targetFile = join(targetMemDir, file);
      if (existsSync(targetFile)) {
        const existingContent = readFileSync(targetFile, "utf-8");
        const newContent = readFileSync(join(memoryDir, file), "utf-8");
        if (existingContent !== newContent) {
          const existingHash = computeIntegrityHash([existingContent]);
          const incomingHash = computeIntegrityHash([newContent]);
          memoryConflicts.push({ filename: file, existingHash, incomingHash });
          warnings.push(
            `Memory file "${file}" exists with different content — kept existing version. Use memoryConflicts in result to resolve.`
          );
        }
        // Skip — keep existing (skill can overwrite if user chooses incoming)
      } else {
        copyFileSync(join(memoryDir, file), targetFile);
      }
    }
  }

  // Copy plans
  const plansDir = join(exportPath, "plans");
  if (existsSync(plansDir)) {
    const targetPlansDir = join(targetConfigDir, "plans");
    mkdirSync(targetPlansDir, { recursive: true });
    for (const file of readdirSync(plansDir)) {
      const targetFile = join(targetPlansDir, file);
      if (!existsSync(targetFile)) {
        copyFileSync(join(plansDir, file), targetFile);
      }
    }
  }

  // Step 6: Validate written files before registering in index.
  // Sessions that already failed the integrity check are known-corrupt; we
  // skip strict JSON validation for them so the import can still succeed with
  // a warning. We only hard-fail if a session that passed integrity check
  // produces unparseable output (indicating a rewrite pipeline bug).
  for (const session of targetSessions) {
    const newSessionId = sessionIdMap.get(session.sessionId)!;
    const writtenJsonlPath = join(targetProjectDir, `${newSessionId}.jsonl`);
    if (!existsSync(writtenJsonlPath)) {
      // Session had no JSONL file to write; skip validation for this session
      continue;
    }

    // Skip strict validation for sessions with known integrity failures
    if (integrityFailedSessions.has(session.sessionId)) {
      continue;
    }

    try {
      const content = readFileSync(writtenJsonlPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      // Verify each line is valid JSON
      for (const line of lines) {
        JSON.parse(line);
      }
    } catch (e) {
      // Rollback: clean up only files written by this import
      try {
        rollbackImportedFiles();
      } catch {
        /* best effort cleanup */
      }
      return {
        success: false as const,
        command: "import",
        error: `Import validation failed: ${(e as Error).message}`,
        details:
          "Written files have been cleaned up. No indexes were modified.",
        suggestion:
          "Check the export bundle for corruption, or try --no-register to import as read-only.",
      };
    }
  }

  // Step 7: Register in indexes (only after successful validation)
  if (!noRegister) {
    const historyPath = join(targetConfigDir, "history.jsonl");
    for (const session of targetSessions) {
      const newSessionId = sessionIdMap.get(session.sessionId)!;
      const historyEntry = {
        display: session.summary || session.slug,
        pastedContents: {},
        timestamp: Date.now(),
        project: targetProjectPath,
        sessionId: newSessionId,
      };
      appendFileSync(historyPath, JSON.stringify(historyEntry) + "\n", "utf-8");
    }
  }

  if (manifest.sourceMachineId) {
    const state = readSyncState(targetProjectPath);
    const peerId = manifest.sourceMachineId;
    const peerName = manifest.sourceMachineName ?? "unknown";
    if (!state.peers[peerId]) {
      state.peers[peerId] = {
        name: peerName,
        lastSentAt: null,
        lastReceivedAt: null,
        sent: {},
        received: {},
      };
    }
    const peer: SyncStatePeer = state.peers[peerId];
    peer.name = peerName;
    peer.lastReceivedAt = new Date().toISOString();

    for (const session of targetSessions) {
      const newId = sessionIdMap.get(session.sessionId)!;
      const type: "full" | "continuation" =
        session.type === "continuation" ? "continuation" : "full";

      const received: SyncStateSessionReceived = {
        localSessionId: newId,
        type,
        importedAt: new Date().toISOString(),
      };
      peer.received[session.sessionId] = received;

      const lineage: SyncStateLineage = {
        sourceMachineId: peerId,
        sourceSessionId: session.sessionId,
        importedAt: received.importedAt,
        type,
        continuationOf: session.continuation
          ? peer.received[session.continuation.continuesPeerSessionId ?? ""]?.localSessionId
          : undefined,
      };
      state.lineage[newId] = lineage;

      const sent: SyncStateSessionSent = {
        headEntryUuid: readLastEntryUuid(join(targetProjectDir, `${newId}.jsonl`)) ?? "",
        messageCount: session.messageCount,
        sentAsType: type,
        sentAsSessionId: session.sessionId,
      };
      peer.sent[newId] = sent;
    }
    writeSyncState(state);
  }

  return {
    success: true,
    command: "import",
    importedSessions,
    warnings,
    resumable: !noRegister,
    versionAdaptations: versionAdaptations.length > 0 ? versionAdaptations : undefined,
    memoryConflicts: memoryConflicts.length > 0 ? memoryConflicts : undefined,
  } satisfies ImportResult;
}

function readLastEntryUuid(jsonlPath: string): string | null {
  try {
    const content = readFileSync(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]) as { uuid?: string };
    return last.uuid ?? null;
  } catch {
    return null;
  }
}
