#!/usr/bin/env node

import { Command } from "commander";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveConfigDir, detectPlatform, encodeProjectPath } from "./platform.js";
import {
  getDefaultConfig,
  readConfig,
  writeConfig,
  mergeConfigs,
  setConfigValue,
} from "./config.js";
import { exportSession, exportAllSessions } from "./exporter.js";
import { importSession } from "./importer.js";
import { migrateSession } from "./migrator.js";
import { readManifest } from "./manifest.js";
import { loadOrCreateMachineId } from "./machine.js";
import { readSyncState, writeSyncState } from "./sync-state.js";
import {
  createArchive,
  extractArchive,
  detectArchiveFormat,
  isZstdAvailable,
} from "./archiver.js";
import { discoverSessionById } from "./discovery.js";
import type {
  ExportLayer,
  ExportResult,
  SessionScope,
  StorageScope,
  ExportFormat,
  BrowseResult,
  ErrorResult,
  ConfigureResult,
} from "./types.js";

const program = new Command();

program
  .name("sesh-mover")
  .description("Export, import, and migrate Claude Code sessions")
  .version("0.2.0");

// --- Export ---
program
  .command("export")
  .description("Export session(s) from the current project")
  .option("--scope <scope>", "current or all")
  .option("--storage <storage>", "user or project")
  .option("--format <format>", "dir, archive, or zstd")
  .option("--exclude <layers...>", "Layers to exclude")
  .option("--source-config-dir <path>", "Override Claude config dir")
  .option("--session-id <id>", "Export specific session by ID")
  .option("--name <name>", "Export name")
  .option("--output <path>", "Override output path")
  .option("--project-path <path>", "Override project path (default: cwd)")
  .option("--no-summary", "Skip Claude-generated summary (reserved for future use — currently summaries always use fallback extraction)")
  .option("--overwrite", "Overwrite existing export")
  .option("--suffix", "Auto-suffix on name collision")
  .option("--incremental", "Produce an incremental export (requires --to or --since)")
  .option("--to <peer>", "Target peer machine id or name (incremental)")
  .option("--since <path>", "Diff against a previous export at <path> (incremental)")
  .action(async (opts) => {
    try {
      const configDir = resolveConfigDir(opts.sourceConfigDir);
      const config = loadEffectiveConfig(configDir, process.cwd());
      const scope = parseScope(opts.scope ?? config.export.scope, "export");
      const storage = parseStorage(opts.storage ?? config.export.storage);
      const format = parseFormat(opts.format ?? config.export.format);
      const excludeLayers = (opts.exclude ?? config.export.exclude) as ExportLayer[];
      const claudeVersion = getClaudeVersion();

      let incremental: import("./exporter.js").IncrementalExportOptions | undefined;
      try {
        incremental = resolveIncrementalOptions({
          incremental: opts.incremental,
          to: opts.to,
          since: opts.since,
          projectPath: opts.projectPath,
        });
      } catch (e) {
        outputError("export", e as Error);
        return;
      }

      // Determine output directory
      let outputDir: string;
      if (opts.output) {
        outputDir = opts.output;
      } else if (storage === "project") {
        outputDir = join(process.cwd(), ".claude-sesh-mover");
      } else {
        outputDir = join(homedir(), ".claude-sesh-mover");
      }
      mkdirSync(outputDir, { recursive: true });

      // Generate name
      const name = opts.name ?? generateExportName(configDir, opts.sessionId);

      // Check collision
      const exportPath = join(outputDir, name);
      if (existsSync(exportPath) && !opts.overwrite) {
        if (opts.suffix) {
          // Find next available suffix
          let suffix = 2;
          while (existsSync(join(outputDir, `${name}-${suffix}`))) {
            suffix++;
          }
          const suffixedName = `${name}-${suffix}`;
          const result = await doExport(
            configDir,
            scope,
            opts.sessionId,
            outputDir,
            suffixedName,
            excludeLayers,
            claudeVersion,
            opts.projectPath,
            incremental
          );
          output(result);
          return;
        }
        // Report collision
        output({
          success: true,
          command: "export",
          exportPath,
          sessions: [],
          warnings: [],
          archivePath: null,
          collision: true,
          existingPath: exportPath,
        });
        return;
      }

      const result = await doExport(
        configDir,
        scope,
        opts.sessionId,
        outputDir,
        name,
        excludeLayers,
        claudeVersion,
        opts.projectPath,
        incremental
      );

      // Capture the bundle dir before archive cleanup destroys the staging tree.
      // At this point result.exportPath is still the directory path (not the .tar.gz),
      // so we can read the manifest from disk before archive packaging + rm happens.
      const preArchiveBundleDir =
        result.success && incremental?.targetMachineId
          ? (result as ExportResult).exportPath
          : null;

      // Handle archive
      if (result.success && (format === "archive" || format === "zstd")) {
        const exportResult = result as ExportResult;
        let compression: "gzip" | "zstd" = format === "zstd" ? "zstd" : "gzip";
        if (compression === "zstd" && !(await isZstdAvailable())) {
          exportResult.warnings.push(
            "zstd not found on system, falling back to gzip"
          );
          compression = "gzip";
          exportResult.actualFormat = "archive"; // signal fallback to skill
        }
        const ext = compression === "zstd" ? ".tar.zst" : ".tar.gz";
        const archivePath = exportResult.exportPath + ext;
        const stagingDir = exportResult.exportPath;
        if (preArchiveBundleDir) {
          updateSyncStateAfterExport(
            configDir,
            opts.projectPath ?? process.cwd(),
            incremental!,
            stagingDir
          );
        }
        await createArchive(stagingDir, archivePath, compression);
        rmSync(stagingDir, { recursive: true, force: true });
        exportResult.archivePath = archivePath;
        exportResult.exportPath = archivePath;
      } else if (preArchiveBundleDir) {
        updateSyncStateAfterExport(
          configDir,
          opts.projectPath ?? process.cwd(),
          incremental!,
          preArchiveBundleDir
        );
      }

      output(result);
    } catch (e) {
      outputError("export", e as Error);
    }
  });

// --- Import ---
program
  .command("import")
  .description("Import session(s) from an export")
  .requiredOption("--from <path>", "Path to export directory or archive")
  .option("--session-id <ids...>", "Import specific sessions")
  .option("--target-project-path <path>", "Target project path", process.cwd())
  .option("--target-config-dir <path>", "Target Claude config dir")
  .option("--dry-run", "Show changes without applying")
  .option("--no-register", "Skip session index registration")
  .option("--force", "Skip confirmation")
  .action(async (opts) => {
    let tempExtractDir: string | undefined;
    try {
      let fromPath = opts.from;

      // If archive, extract first
      const archiveFormat = detectArchiveFormat(fromPath);
      if (archiveFormat) {
        tempExtractDir = mkdtempSync(join(tmpdir(), "sesh-mover-extract-"));
        await extractArchive(fromPath, tempExtractDir);
        fromPath = tempExtractDir;
      }

      const targetConfigDir = resolveConfigDir(opts.targetConfigDir);
      const claudeVersion = getClaudeVersion();

      const result = await importSession({
        exportPath: fromPath,
        targetConfigDir,
        targetProjectPath: opts.targetProjectPath,
        targetClaudeVersion: claudeVersion,
        dryRun: !!opts.dryRun,
        sessionIds: opts.sessionId,
        noRegister: !opts.register, // Commander.js --no-register sets opts.register to false
      });

      output(result);
    } catch (e) {
      outputError("import", e as Error);
    } finally {
      if (tempExtractDir) rmSync(tempExtractDir, { recursive: true, force: true });
    }
  });

// --- Migrate ---
program
  .command("migrate")
  .description("Move session(s) to a new path (same machine)")
  .requiredOption("--target-project-path <path>", "Destination project path")
  .option("--scope <scope>", "current or all")
  .option("--source-project-path <path>", "Source project path (default: cwd)")
  .option("--source-config-dir <path>", "Source Claude config dir")
  .option("--target-config-dir <path>", "Target Claude config dir")
  .option("--exclude <layers...>", "Layers to exclude")
  .option("--session-id <id>", "Migrate specific session")
  .option("--dry-run", "Show changes without applying")
  .option("--rename-dir", "Also rename the actual project directory to the target path")
  .option("--force", "Override the self-migration safety block (unsafe — only use when the active Claude Code session is NOT in the source path)")
  .action(async (opts) => {
    try {
      const sourceConfigDir = resolveConfigDir(opts.sourceConfigDir);
      const targetConfigDir = resolveConfigDir(opts.targetConfigDir);
      const claudeVersion = getClaudeVersion();

      const sourceProjectPath = opts.sourceProjectPath ?? process.cwd();
      const config = loadEffectiveConfig(sourceConfigDir, sourceProjectPath);
      const scope = parseScope(opts.scope ?? config.migrate.scope, "migrate");

      const result = await migrateSession({
        sourceConfigDir,
        targetConfigDir,
        sourceProjectPath,
        targetProjectPath: opts.targetProjectPath,
        scope,
        sessionId: opts.sessionId,
        excludeLayers: (opts.exclude ?? []) as ExportLayer[],
        claudeVersion,
        dryRun: !!opts.dryRun,
        renameDir: !!opts.renameDir,
        currentCwd: process.cwd(),
        force: !!opts.force,
      });

      output(result);
    } catch (e) {
      outputError("migrate", e as Error);
    }
  });

// --- Browse ---
program
  .command("browse")
  .description("List available exports")
  .option("--storage <storage>", "user, project, or all", "all")
  .option("--source-config-dir <path>", "Override config dir")
  .option("--json", "Output raw JSON")
  .option("--prune", "Delete old exports interactively")
  .action(async (opts) => {
    try {
      const exports: BrowseResult["exports"] = [];

      const searchDirs: Array<{ dir: string; storage: StorageScope }> = [];

      if (opts.storage === "user" || opts.storage === "all") {
        const userDir = join(homedir(), ".claude-sesh-mover");
        if (existsSync(userDir)) {
          searchDirs.push({ dir: userDir, storage: "user" });
        }
      }

      if (opts.storage === "project" || opts.storage === "all") {
        const projectDir = join(process.cwd(), ".claude-sesh-mover");
        if (existsSync(projectDir)) {
          searchDirs.push({ dir: projectDir, storage: "project" });
        }
      }

      for (const { dir, storage } of searchDirs) {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const manifestPath = join(dir, entry, "manifest.json");
          if (existsSync(manifestPath)) {
            try {
              const manifest = readManifest(join(dir, entry));
              exports.push({
                name: entry,
                path: join(dir, entry),
                exportedAt: manifest.exportedAt,
                sourcePlatform: manifest.sourcePlatform,
                sourceProjectPath: manifest.sourceProjectPath,
                sessionCount: manifest.sessions.length,
                sessions: manifest.sessions,
                storage,
              });
            } catch {
              // Skip malformed exports
            }
          }
        }
      }

      // Also look for archives in the search dirs
      for (const { dir, storage } of searchDirs) {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (entry.endsWith(".tar.gz") || entry.endsWith(".tar.zst")) {
            // We can't read manifests from archives without extracting
            // Just list them with minimal info
            exports.push({
              name: entry,
              path: join(dir, entry),
              exportedAt: "",
              sourcePlatform: detectPlatform(),
              sourceProjectPath: "",
              sessionCount: 0,
              sessions: [],
              storage,
            });
          }
        }
      }

      // Also scan cwd for export bundles and archives that aren't inside .claude-sesh-mover/
      // This catches exports dropped directly in the project root (e.g., received via file transfer)
      if (opts.storage === "project" || opts.storage === "all") {
        const cwd = process.cwd();
        const cwdEntries = readdirSync(cwd);
        for (const entry of cwdEntries) {
          if (entry === ".claude-sesh-mover") continue; // already scanned above
          const entryPath = join(cwd, entry);
          // Check for export directories with manifest.json
          const manifestPath = join(entryPath, "manifest.json");
          if (existsSync(manifestPath)) {
            try {
              const manifest = readManifest(entryPath);
              if (manifest.plugin === "sesh-mover") {
                exports.push({
                  name: entry,
                  path: entryPath,
                  exportedAt: manifest.exportedAt,
                  sourcePlatform: manifest.sourcePlatform,
                  sourceProjectPath: manifest.sourceProjectPath,
                  sessionCount: manifest.sessions.length,
                  sessions: manifest.sessions,
                  storage: "project",
                });
              }
            } catch {
              // Not a sesh-mover export, skip
            }
          }
          // Check for archive files
          if (entry.endsWith(".tar.gz") || entry.endsWith(".tar.zst")) {
            // Only include if filename looks like a sesh-mover export (date prefix pattern)
            if (/^\d{4}-\d{2}-\d{2}-/.test(entry)) {
              exports.push({
                name: entry,
                path: entryPath,
                exportedAt: "",
                sourcePlatform: detectPlatform(),
                sourceProjectPath: "",
                sessionCount: 0,
                sessions: [],
                storage: "project",
              });
            }
          }
        }
      }

      // Note: --prune is a signal for the skill layer to handle interactively.
      // The skill prompts the user and runs `rm -rf <path>` after confirmation.
      // The CLI just lists exports with their paths; no extra marking needed here.

      const result: BrowseResult = {
        success: true,
        command: "browse",
        exports: exports.sort(
          (a, b) =>
            new Date(b.exportedAt || 0).getTime() -
            new Date(a.exportedAt || 0).getTime()
        ),
      };

      output(result);
    } catch (e) {
      outputError("browse", e as Error);
    }
  });

// --- Configure ---
program
  .command("configure")
  .description("Set defaults for sesh-mover commands")
  .option("--scope <scope>", "user or project", "user")
  .option("--set <keyvalue>", "Set a config value (key=value)")
  .option("--show", "Show current effective config")
  .option("--reset", "Reset config to defaults")
  .option("--json", "Output raw JSON")
  .action(async (opts) => {
    try {
      const configDir =
        opts.scope === "project"
          ? join(process.cwd(), ".claude-sesh-mover")
          : join(homedir(), ".claude-sesh-mover");

      if (opts.reset) {
        writeConfig(configDir, getDefaultConfig());
        const result: ConfigureResult = {
          success: true,
          command: "configure",
          config: getDefaultConfig(),
          scope: opts.scope as StorageScope,
          message: "Config reset to defaults",
        };
        output(result);
        return;
      }

      if (opts.set) {
        const eqIndex = opts.set.indexOf("=");
        if (eqIndex === -1) {
          outputError(
            "configure",
            new Error("--set requires key=value format")
          );
          return;
        }
        const key = opts.set.slice(0, eqIndex);
        const value = opts.set.slice(eqIndex + 1);
        if (!key) {
          outputError(
            "configure",
            new Error("--set requires key=value format")
          );
          return;
        }
        let config = readConfig(configDir);
        // Parse value
        let parsedValue: unknown = value;
        if (value === "true") parsedValue = true;
        else if (value === "false") parsedValue = false;
        else if (value.startsWith("[")) parsedValue = JSON.parse(value);

        config = setConfigValue(config, key, parsedValue);
        writeConfig(configDir, config);
        const result: ConfigureResult = {
          success: true,
          command: "configure",
          config,
          scope: opts.scope as StorageScope,
          message: `Set ${key} = ${value}`,
        };
        output(result);
        return;
      }

      if (opts.show) {
        const config = loadEffectiveConfig(resolveConfigDir(), process.cwd());
        const result: ConfigureResult = {
          success: true,
          command: "configure",
          config,
          scope: opts.scope as StorageScope,
          message: "Current effective config",
        };
        output(result);
        return;
      }

      // Default: show config
      const config = readConfig(configDir);
      const result: ConfigureResult = {
        success: true,
        command: "configure",
        config,
        scope: opts.scope as StorageScope,
        message: `Config for ${opts.scope} scope`,
      };
      output(result);
    } catch (e) {
      outputError("configure", e as Error);
    }
  });

// --- Helpers ---

async function doExport(
  configDir: string,
  scope: SessionScope,
  sessionId: string | undefined,
  outputDir: string,
  name: string,
  excludeLayers: ExportLayer[],
  claudeVersion: string,
  projectPathOverride?: string,
  incremental?: import("./exporter.js").IncrementalExportOptions
) {
  // Detect project path from cwd or override
  const projectPath = projectPathOverride ?? process.cwd();

  if (scope === "all") {
    return exportAllSessions({
      configDir,
      projectPath,
      outputDir,
      name,
      excludeLayers,
      claudeVersion,
      incremental,
    });
  }

  return exportSession({
    configDir,
    projectPath,
    sessionId,
    outputDir,
    name,
    excludeLayers,
    claudeVersion,
    incremental,
  });
}

function readLastEntryUuid(jsonlPath: string): string | null {
  if (!existsSync(jsonlPath)) return null;
  const content = readFileSync(jsonlPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  try {
    return (
      (JSON.parse(lines[lines.length - 1]) as { uuid?: string }).uuid ?? null
    );
  } catch {
    return null;
  }
}

function readLastEntryUuidInExport(
  exportPath: string,
  sessionId: string
): string | null {
  return readLastEntryUuid(join(exportPath, "sessions", `${sessionId}.jsonl`));
}

function resolvePeer(
  state: import("./types.js").SyncState,
  needle: string
): { id: string } | null {
  if (state.peers[needle]) return { id: needle };
  const byName = Object.entries(state.peers).find(([, p]) => p.name === needle);
  if (byName) return { id: byName[0] };
  return null;
}

function readReferenceManifest(
  path: string
): import("./types.js").ExportManifest {
  const manifestPath = join(path, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `--since ${path} does not contain a manifest.json (archive --since is a phase-2 feature).`
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

function resolveIncrementalOptions(opts: {
  incremental?: boolean;
  to?: string;
  since?: string;
  projectPath?: string;
}): import("./exporter.js").IncrementalExportOptions | undefined {
  if (!opts.incremental) return undefined;
  if (!opts.to && !opts.since) {
    throw new Error(
      "Invalid --incremental usage: provide either --to <peer> or --since <path>."
    );
  }
  if (opts.to && opts.since) {
    throw new Error(
      "Invalid --incremental usage: --to and --since are mutually exclusive."
    );
  }

  const machine = loadOrCreateMachineId();
  const projectPath = opts.projectPath ?? process.cwd();

  if (opts.to) {
    const state = readSyncState(projectPath);
    const match = resolvePeer(state, opts.to);
    if (!match) {
      throw new Error(
        `No sync history with peer "${opts.to}". Run a full export to this peer first, or use --since <path>.`
      );
    }
    return {
      sourceMachineId: machine.id,
      sourceMachineName: machine.name,
      targetMachineId: match.id,
      targetMachineName: state.peers[match.id].name,
      peerSent: state.peers[match.id].sent,
      lastSyncAt: state.peers[match.id].lastSentAt ?? undefined,
    };
  }

  const refManifest = readReferenceManifest(opts.since!);
  const peerSent: Record<
    string,
    import("./types.js").SyncStateSessionSent
  > = {};
  for (const s of refManifest.sessions) {
    peerSent[s.sessionId] = {
      headEntryUuid: readLastEntryUuidInExport(opts.since!, s.sessionId) ?? "",
      messageCount: s.messageCount,
      sentAsType: s.type === "continuation" ? "continuation" : "full",
      sentAsSessionId: s.sessionId,
    };
  }

  return {
    sourceMachineId: machine.id,
    sourceMachineName: machine.name,
    targetMachineId: refManifest.baseline?.targetMachineId,
    targetMachineName: refManifest.baseline?.targetMachineName,
    referenceExport: opts.since,
    peerSent,
  };
}

function updateSyncStateAfterExport(
  configDir: string,
  projectPath: string,
  incremental: import("./exporter.js").IncrementalExportOptions,
  bundleDir: string
): void {
  if (!incremental.targetMachineId) return;
  const state = readSyncState(projectPath);
  const peerId = incremental.targetMachineId;
  if (!state.peers[peerId]) {
    state.peers[peerId] = {
      name: incremental.targetMachineName ?? peerId,
      lastSentAt: null,
      lastReceivedAt: null,
      sent: {},
      received: {},
    };
  }
  state.peers[peerId].lastSentAt = new Date().toISOString();
  state.peers[peerId].name =
    incremental.targetMachineName ?? state.peers[peerId].name;

  const manifest = readManifest(bundleDir);
  const sourceProjectsDir = join(
    configDir,
    "projects",
    encodeProjectPath(projectPath)
  );

  for (const s of manifest.sessions) {
    const localSessionId =
      s.type === "continuation" && s.continuation
        ? s.continuation.continuesLocalSessionId
        : s.sessionId;
    const localJsonl = join(sourceProjectsDir, `${localSessionId}.jsonl`);
    const headUuid =
      readLastEntryUuid(localJsonl) ?? s.continuation?.fromEntryUuid ?? "";

    state.peers[peerId].sent[localSessionId] = {
      headEntryUuid: headUuid,
      messageCount: s.messageCount,
      sentAsType: s.type === "continuation" ? "continuation" : "full",
      sentAsSessionId: s.sessionId,
    };
  }
  writeSyncState(state);
}

function parseScope(value: string, command: string): SessionScope {
  if (value === "current" || value === "all") return value;
  throw new Error(
    `Invalid --scope value for ${command}: "${value}". Valid: current, all.`
  );
}

function parseStorage(value: string): StorageScope {
  if (value === "user" || value === "project") return value;
  throw new Error(
    `Invalid --storage value: "${value}". Valid: user, project.`
  );
}

function parseFormat(value: string): ExportFormat {
  switch (value) {
    case "dir":
    case "archive":
    case "zstd":
      return value;
    case "tar.gz":
    case "gzip":
    case "gz":
      return "archive";
    case "tar.zst":
    case "tar.zstd":
    case "zst":
      return "zstd";
    default:
      throw new Error(
        `Invalid --format value: "${value}". Valid: dir, archive (tar.gz), zstd (tar.zst).`
      );
  }
}

function loadEffectiveConfig(configDir: string, projectDir: string) {
  const userConfigDir = join(homedir(), ".claude-sesh-mover");
  const projectConfigDir = join(projectDir, ".claude-sesh-mover");
  const userConfig = readConfig(userConfigDir);
  const projectConfig = readConfig(projectConfigDir);
  return mergeConfigs(userConfig, projectConfig);
}

function generateExportName(configDir: string, sessionId?: string): string {
  const date = new Date().toISOString().split("T")[0];
  if (sessionId) {
    const session = discoverSessionById(configDir, sessionId);
    if (session && session.slug) {
      return `${date}-${session.slug}`;
    }
  }
  return `${date}-export`;
}

function getClaudeVersion(): string {
  try {
    const version = execFileSync("claude", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    // Extract version number
    const match = version.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : "unknown";
  } catch {
    return "unknown";
  }
}

function output(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function outputError(command: string, error: Error): void {
  const result: ErrorResult = {
    success: false,
    command,
    error: error.message,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(1);
}

program.parse();
