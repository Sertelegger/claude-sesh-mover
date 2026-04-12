#!/usr/bin/env node

import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolveConfigDir, detectPlatform } from "./platform.js";
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
import {
  createArchive,
  extractArchive,
  detectArchiveFormat,
  isZstdAvailable,
} from "./archiver.js";
import { discoverSessionById } from "./discovery.js";
import type {
  ExportLayer,
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
  .version("0.1.0");

// --- Export ---
program
  .command("export")
  .description("Export session(s) from the current project")
  .option("--scope <scope>", "current or all", "current")
  .option("--storage <storage>", "user or project", "user")
  .option("--format <format>", "dir, archive, or zstd", "dir")
  .option("--exclude <layers...>", "Layers to exclude")
  .option("--source-config-dir <path>", "Override Claude config dir")
  .option("--session-id <id>", "Export specific session by ID")
  .option("--name <name>", "Export name")
  .option("--output <path>", "Override output path")
  .option("--project-path <path>", "Override project path (default: cwd)")
  .option("--no-summary", "Skip Claude-generated summary")
  .option("--overwrite", "Overwrite existing export")
  .option("--suffix", "Auto-suffix on name collision")
  .action(async (opts) => {
    try {
      const configDir = resolveConfigDir(opts.sourceConfigDir);
      const config = loadEffectiveConfig(configDir, process.cwd());
      const scope = (opts.scope ?? config.export.scope) as SessionScope;
      const storage = (opts.storage ?? config.export.storage) as StorageScope;
      const format = (opts.format ?? config.export.format) as ExportFormat;
      const excludeLayers = (opts.exclude ?? config.export.exclude) as ExportLayer[];
      const claudeVersion = getClaudeVersion();

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
            opts.projectPath
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
        opts.projectPath
      );

      // Handle archive
      if (result.success && (format === "archive" || format === "zstd")) {
        let compression: "gzip" | "zstd" = format === "zstd" ? "zstd" : "gzip";
        if (compression === "zstd" && !(await isZstdAvailable())) {
          (result as any).warnings.push(
            "zstd not found on system, falling back to gzip"
          );
          compression = "gzip";
          (result as any).actualFormat = "archive"; // signal fallback to skill
        }
        const ext = compression === "zstd" ? ".tar.zst" : ".tar.gz";
        const archivePath = (result as any).exportPath + ext;
        await createArchive((result as any).exportPath, archivePath, compression);
        (result as any).archivePath = archivePath;
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
    try {
      let fromPath = opts.from;

      // If archive, extract first
      const archiveFormat = detectArchiveFormat(fromPath);
      if (archiveFormat) {
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const extractDir = mkdtempSync(join(tmpdir(), "sesh-mover-extract-"));
        await extractArchive(fromPath, extractDir);
        fromPath = extractDir;
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
    }
  });

// --- Migrate ---
program
  .command("migrate")
  .description("Move session(s) to a new path (same machine)")
  .requiredOption("--target-project-path <path>", "Destination project path")
  .option("--scope <scope>", "current or all", "current")
  .option("--source-config-dir <path>", "Source Claude config dir")
  .option("--target-config-dir <path>", "Target Claude config dir")
  .option("--exclude <layers...>", "Layers to exclude")
  .option("--session-id <id>", "Migrate specific session")
  .option("--dry-run", "Show changes without applying")
  .action(async (opts) => {
    try {
      const sourceConfigDir = resolveConfigDir(opts.sourceConfigDir);
      const targetConfigDir = resolveConfigDir(opts.targetConfigDir);
      const claudeVersion = getClaudeVersion();

      // Source project path is the current working directory
      const sourceProjectPath = process.cwd();

      const result = await migrateSession({
        sourceConfigDir,
        targetConfigDir,
        sourceProjectPath,
        targetProjectPath: opts.targetProjectPath,
        scope: opts.scope as SessionScope,
        sessionId: opts.sessionId,
        excludeLayers: (opts.exclude ?? []) as ExportLayer[],
        claudeVersion,
        dryRun: !!opts.dryRun,
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

      // Also look for archives
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

      // Handle --prune: output exports with a prunable flag for the skill to act on
      if (opts.prune) {
        // In non-interactive mode, list exports that can be pruned
        // The skill will present options and invoke delete via rm
        for (const exp of exports) {
          (exp as any).prunable = true;
        }
      }

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
        const [key, value] = opts.set.split("=");
        if (!key || value === undefined) {
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
  projectPathOverride?: string
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
  });
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
    const version = execSync("claude --version", {
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
