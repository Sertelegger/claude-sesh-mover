import {
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
  appendFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readManifest,
  computeIntegrityHash,
  computeIntegrityHashFromFile,
  isSafeSessionId,
} from "./manifest.js";
import { rewriteJsonlStream, buildPathMappings } from "./rewriter.js";
import {
  encodeProjectPath,
  detectPlatform,
  extractUserFromPath,
  getCurrentUser,
} from "./platform.js";
import {
  getApplicableAdapters,
  classifyVersionDifference,
} from "./version-adapters.js";
import { readSyncState, writeSyncState } from "./sync-state.js";
import { readLastEntryUuid } from "./jsonl.js";
import { percentThrottle } from "./progress.js";
import { readLocalProjectId, writeLocalProjectId } from "./hub/identity.js";
import type {
  ImportResult,
  DryRunResult,
  ErrorResult,
  RewriteReport,
  SyncStatePeer,
  SyncStateSessionReceived,
  SyncStateSessionSent,
  SyncStateLineage,
  ProgressEvent,
} from "./types.js";

export interface ImportOptions {
  exportPath: string;
  targetConfigDir: string;
  targetProjectPath: string;
  targetClaudeVersion: string;
  dryRun: boolean;
  sessionIds?: string[];
  noRegister?: boolean;
  allowDuplicates?: boolean;
  onProgress?: (ev: ProgressEvent) => void;
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
    allowDuplicates,
    onProgress,
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

  // Compute the target project dir up front — the dedup filters below need
  // it to verify a prior "imported" record still has a file on disk before
  // trusting it (see Fix 1: a registry/peer record can outlive the file it
  // points at, e.g. after a migrate deleted it, and trusting the record
  // alone would silently drop the session instead of importing it fresh).
  const encodedTargetPath = encodeProjectPath(targetProjectPath);
  const targetProjectDir = join(
    targetConfigDir,
    "projects",
    encodedTargetPath
  );

  const state = readSyncState(targetProjectPath);
  const skippedSessions: Array<{
    originalId: string;
    reason: "duplicate" | "already-received";
  }> = [];

  if (!allowDuplicates && manifest.sourceMachineId) {
    const peer = state.peers[manifest.sourceMachineId];
    if (peer) {
      const before = targetSessions.length;
      targetSessions = targetSessions.filter((session) => {
        const prior = peer.received[session.sessionId];
        if (
          prior &&
          existsSync(join(targetProjectDir, `${prior.localSessionId}.jsonl`))
        ) {
          skippedSessions.push({
            originalId: session.sessionId,
            reason: "already-received",
          });
          return false;
        }
        return true;
      });
      if (targetSessions.length < before) {
        warnings.push(
          `${before - targetSessions.length} session(s) already received from ${manifest.sourceMachineName ?? manifest.sourceMachineId} — skipped (idempotent).`
        );
      }
    }
  }

  if (!allowDuplicates) {
    const before = targetSessions.length;
    targetSessions = targetSessions.filter((session) => {
      const prior = state.imported[session.integrityHash];
      const priorFileExists =
        !!prior &&
        existsSync(join(targetProjectDir, `${prior.localSessionId}.jsonl`));
      if (priorFileExists && (prior.registered || noRegister)) {
        skippedSessions.push({
          originalId: session.sessionId,
          reason: "duplicate",
        });
        return false;
      }
      if (priorFileExists && prior && !prior.registered && !noRegister) {
        warnings.push(
          `Session "${session.slug}" was previously imported with --no-register; importing a registered copy (the older unregistered copy remains on disk as ${prior.localSessionId}).`
        );
      }
      return true;
    });
    if (targetSessions.length < before) {
      warnings.push(
        `${before - targetSessions.length} session(s) already imported into this project — skipped (idempotent). Use --allow-duplicates to import anyway.`
      );
    }
  }

  if (targetSessions.length === 0) {
    if (dryRun) {
      return {
        success: true,
        command: "import",
        dryRun: true,
        importedSessions: [],
        skippedSessions,
        warnings,
        resumable: true,
      } satisfies DryRunResult;
    }
    return {
      success: true,
      command: "import",
      importedSessions: [],
      skippedSessions,
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

  const ctx = {
    mappings,
    sourcePlatform: manifest.sourcePlatform,
    targetPlatform,
    sourceUser,
    targetUser,
  };

  // Step 3: Verify per-session integrity (before any rewriting)
  const integrityFailedSessions = new Set<string>();
  for (const [sessionIndex, session] of targetSessions.entries()) {
    onProgress?.({
      phase: "import-verify",
      sessionId: session.sessionId,
      sessionIndex,
      sessionCount: targetSessions.length,
    });
    const jsonlPath = join(
      exportPath,
      "sessions",
      `${session.sessionId}.jsonl`
    );
    if (existsSync(jsonlPath)) {
      const actualHash = await computeIntegrityHashFromFile(jsonlPath);
      if (actualHash !== session.integrityHash) {
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
      rewriteReport = await rewriteJsonlStream(
        firstJsonlPath,
        null,
        ctx,
        { newSessionId: sessionIdMap.get(firstSession.sessionId) }
      );
    }

    return {
      success: true,
      command: "import",
      dryRun: true,
      importedSessions,
      skippedSessions,
      warnings,
      resumable: true,
      rewriteReport,
      versionAdaptations: adapters.map((a) => a.description),
    } satisfies DryRunResult;
  }

  // Step 4: Write session files
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

  const postRewriteHashes = new Map<string, string>();

  try {
    for (const [sessionIndex, session] of targetSessions.entries()) {
      const newSessionId = sessionIdMap.get(session.sessionId)!;

      // Rewrite and write JSONL
      const jsonlPath = join(
        exportPath,
        "sessions",
        `${session.sessionId}.jsonl`
      );
      if (existsSync(jsonlPath)) {
        const bytesTotal = statSync(jsonlPath).size;
        const throttled = onProgress
          ? percentThrottle(bytesTotal, (percent, bytesProcessed) =>
              onProgress({
                phase: "import-rewrite",
                sessionId: session.sessionId,
                sessionIndex,
                sessionCount: targetSessions.length,
                bytesProcessed,
                bytesTotal,
                percent,
              })
            )
          : undefined;
        const streamReport = await rewriteJsonlStream(
          jsonlPath,
          join(targetProjectDir, `${newSessionId}.jsonl`),
          ctx,
          { adapters, newSessionId, computeHash: true, onProgress: throttled }
        );
        versionAdaptations.push(...streamReport.adaptationsApplied);
        postRewriteHashes.set(session.sessionId, streamReport.outputHash!);

        // Strict-validation semantics (previously a post-write re-read in
        // Step 6): an unparseable line in a session that PASSED the integrity
        // check indicates corruption the hash didn't catch or a pipeline bug —
        // hard-fail and roll back. Known-corrupt sessions already warned.
        if (
          streamReport.parseFailures > 0 &&
          !integrityFailedSessions.has(session.sessionId)
        ) {
          try {
            rollbackImportedFiles();
          } catch {
            /* best effort cleanup */
          }
          return {
            success: false as const,
            command: "import",
            error: `Import validation failed: session "${session.slug}" contains ${streamReport.parseFailures} unparseable JSONL line(s) after rewrite`,
            details:
              "Partially written session files have been cleaned up. No indexes were modified.",
            suggestion:
              "Check the export bundle for corruption, or try --no-register to import as read-only.",
          };
        }
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
            // Rewrite subagent JSONL too (never applies version adapters).
            await rewriteJsonlStream(
              join(subagentsDir, file),
              join(targetSubDir, file),
              ctx,
              { newSessionId }
            );
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

  // Plant the project identity carried by the bundle so hub adoption is
  // seamless later. Never overwrite an existing (different) identity.
  // manifest.projectId isn't covered by assertSafeManifestIds (that only
  // guards session ids), so it must be validated here before it's ever
  // written to disk or used to build a hub path.
  if (manifest.projectId && existsSync(targetProjectPath)) {
    if (!isSafeSessionId(manifest.projectId)) {
      warnings.push("Bundle carries an unsafe project id — ignored.");
    } else {
      const existing = readLocalProjectId(targetProjectPath);
      if (!existing) {
        writeLocalProjectId(targetProjectPath, {
          projectId: manifest.projectId,
          name:
            manifest.sourceProjectPath.split(/[\\/]/).filter(Boolean).pop() ??
            "project",
          createdAt: new Date().toISOString(),
          createdByMachine: manifest.sourceMachineId ?? "unknown",
        });
      } else if (existing.projectId !== manifest.projectId) {
        warnings.push(
          `Bundle carries project id ${manifest.projectId} but this project is already ${existing.projectId} — kept existing.`
        );
      }
    }
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

  // Always record the imported-hash registry entries — machine-id or not —
  // so a later import of identical content is recognized as a duplicate.
  for (const session of targetSessions) {
    const newId = sessionIdMap.get(session.sessionId)!;
    state.imported[session.integrityHash] = {
      localSessionId: newId,
      importedAt: new Date().toISOString(),
      registered: !noRegister,
    };
  }

  if (manifest.sourceMachineId) {
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
        postRewriteHash: postRewriteHashes.get(session.sessionId),
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
  }

  writeSyncState(state);

  return {
    success: true,
    command: "import",
    importedSessions,
    skippedSessions,
    warnings,
    resumable: !noRegister,
    versionAdaptations: versionAdaptations.length > 0 ? versionAdaptations : undefined,
    memoryConflicts: memoryConflicts.length > 0 ? memoryConflicts : undefined,
  } satisfies ImportResult;
}
