#!/usr/bin/env node

import { Command } from "commander";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveConfigDir } from "./platform.js";
import {
  getDefaultConfig,
  readConfig,
  writeConfig,
  setConfigValue,
  computeEffectiveConfig,
} from "./config.js";
import { exportSession, exportAllSessions } from "./exporter.js";
import { importSession } from "./importer.js";
import { migrateSession } from "./migrator.js";
import { readManifest, assertSafeManifestIds } from "./manifest.js";
import { loadOrCreateMachineId } from "./machine.js";
import { readSyncState, recordSentFromBundle } from "./sync-state.js";
import { readLastEntryUuid } from "./jsonl.js";
import {
  createArchive,
  extractArchive,
  detectArchiveFormat,
  isZstdAvailable,
  readManifestFromArchive,
} from "./archiver.js";
import { discoverSessionById } from "./discovery.js";
import { hubInit } from "./hub/init.js";
import { hubStatus } from "./hub/status.js";
import { readHookPayload, evaluateHookGate } from "./hub/hooks.js";
import type {
  ExportLayer,
  ExportResult,
  SessionScope,
  StorageScope,
  ExportFormat,
  BrowseResult,
  ErrorResult,
  ConfigureResult,
  OnDivergenceMode,
} from "./types.js";

const program = new Command();

program
  .name("sesh-mover")
  .description("Export, import, and migrate Claude Code sessions")
  .version("0.5.1");

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
  .option("--no-summary", "Use slug-only summaries; no conversation text is copied into the manifest")
  .option("--overwrite", "Overwrite existing export")
  .option("--suffix", "Auto-suffix on name collision")
  .option("--incremental", "Produce an incremental export (requires --to or --since)")
  .option("--to <peer>", "Target peer machine id or name (incremental)")
  .option("--since <path>", "Diff against a previous export at <path> (incremental)")
  .option("--progress", "Emit NDJSON progress events on stderr")
  .action(async (opts) => {
    try {
      const onProgress = opts.progress
        ? (ev: import("./types.js").ProgressEvent) =>
            process.stderr.write(JSON.stringify(ev) + "\n")
        : undefined;
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

      // Collision handling: resolve the final name first, then run ONE shared
      // export + finalize tail for every branch (fixes the old --suffix early
      // return that skipped archive packaging and sync-state recording).
      let finalName = name;
      if (exportArtifactExists(outputDir, name) && !opts.overwrite) {
        if (!opts.suffix) {
          output({
            success: true,
            command: "export",
            exportPath: join(outputDir, name),
            sessions: [],
            warnings: [],
            archivePath: null,
            collision: true,
            existingPath: join(outputDir, name),
          });
          return;
        }
        let suffix = 2;
        while (exportArtifactExists(outputDir, `${name}-${suffix}`)) suffix++;
        finalName = `${name}-${suffix}`;
      }

      const noSummary = opts.summary === false || config.export.noSummary;

      const result = await doExport(
        configDir,
        scope,
        opts.sessionId,
        outputDir,
        finalName,
        excludeLayers,
        claudeVersion,
        opts.projectPath,
        noSummary,
        incremental,
        onProgress
      );

      if (result.success) {
        await finalizeExport({
          result: result as ExportResult,
          format,
          incremental,
          projectPath: opts.projectPath ?? process.cwd(),
          onProgress,
        });
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
  .option("--allow-duplicates", "Re-import sessions even if identical content was imported before")
  .option("--progress", "Emit NDJSON progress events on stderr")
  .action(async (opts) => {
    let tempExtractDir: string | undefined;
    try {
      const onProgress = opts.progress
        ? (ev: import("./types.js").ProgressEvent) =>
            process.stderr.write(JSON.stringify(ev) + "\n")
        : undefined;
      let fromPath = opts.from;

      // If archive, extract first
      const archiveFormat = detectArchiveFormat(fromPath);
      if (archiveFormat) {
        onProgress?.({ phase: "extract", percent: 0 });
        tempExtractDir = mkdtempSync(join(tmpdir(), "sesh-mover-extract-"));
        await extractArchive(fromPath, tempExtractDir);
        onProgress?.({ phase: "extract", percent: 100 });
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
        allowDuplicates: !!opts.allowDuplicates,
        onProgress,
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
  .option("--progress", "Emit NDJSON progress events on stderr")
  .action(async (opts) => {
    try {
      const onProgress = opts.progress
        ? (ev: import("./types.js").ProgressEvent) =>
            process.stderr.write(JSON.stringify(ev) + "\n")
        : undefined;
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
        onProgress,
      });

      output(result);
    } catch (e) {
      outputError("migrate", e as Error);
    }
  });

// --- Browse ---

/**
 * One archive -> one browse entry. Reads real metadata when possible and says
 * so plainly when not; never reports the local platform for a foreign archive.
 */
async function archiveBrowseEntry(
  archivePath: string,
  name: string,
  storage: StorageScope
): Promise<BrowseResult["exports"][number]> {
  const r = await readManifestFromArchive(archivePath);
  if (!r.ok) {
    return {
      name,
      path: archivePath,
      exportedAt: null,
      sourcePlatform: null,
      sourceProjectPath: null,
      sessionCount: null,
      sessions: [],
      storage,
      metadataAvailable: false,
      metadataError: r.detail,
    };
  }
  return {
    name,
    path: archivePath,
    exportedAt: r.manifest.exportedAt,
    sourcePlatform: r.manifest.sourcePlatform,
    sourceProjectPath: r.manifest.sourceProjectPath,
    sessionCount: r.manifest.sessions.length,
    sessions: r.manifest.sessions,
    storage,
    metadataAvailable: true,
  };
}

/**
 * How many archives `browse` reads at once. Each in-flight read holds a temp
 * dir and an open tar stream, and an archive costs nothing to merely *list* —
 * so an unbounded fan-out over a directory of hundreds of bundles can exhaust
 * the process's file-descriptor limit and fail the whole command where the old
 * (lying) code would at least have printed names. Batching caps the peak cost
 * at this many concurrent reads regardless of how many archives are present.
 */
const ARCHIVE_READ_CONCURRENCY = 8;

/**
 * Resolve queued archive reads in bounded batches, preserving queue order.
 * Takes thunks rather than promises on purpose: a promise is already running,
 * so an array of them is exactly the unbounded fan-out this avoids.
 */
async function runBounded<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < thunks.length; i += ARCHIVE_READ_CONCURRENCY) {
    const batch = thunks.slice(i, i + ARCHIVE_READ_CONCURRENCY);
    results.push(...(await Promise.all(batch.map((run) => run()))));
  }
  return results;
}

/** Sort key for browse entries: missing/unparseable timestamps become the epoch. */
function exportedAtMillis(exportedAt: string | null): number {
  const t = new Date(exportedAt ?? 0).getTime();
  return Number.isNaN(t) ? 0 : t;
}

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
                metadataAvailable: true,
              });
            } catch {
              // Skip malformed exports
            }
          }
        }
      }

      // Also look for archives in the search dirs. Each archive's manifest is
      // read out of the archive itself, so a bundle carried over from another
      // machine reports ITS origin, not this one's. The reads are queued as
      // thunks and run in bounded batches: concurrent enough that a directory
      // of bundles doesn't serialize, bounded so it can't exhaust file
      // descriptors and fail the listing outright.
      const archiveReads: Array<() => Promise<BrowseResult["exports"][number]>> = [];
      for (const { dir, storage } of searchDirs) {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (entry.endsWith(".tar.gz") || entry.endsWith(".tar.zst")) {
            const archivePath = join(dir, entry);
            archiveReads.push(() => archiveBrowseEntry(archivePath, entry, storage));
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
                  metadataAvailable: true,
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
              archiveReads.push(() => archiveBrowseEntry(entryPath, entry, "project"));
            }
          }
        }
      }

      exports.push(...(await runBounded(archiveReads)));

      // Note: --prune is a signal for the skill layer to handle interactively.
      // The skill prompts the user and runs `rm -rf <path>` after confirmation.
      // The CLI just lists exports with their paths; no extra marking needed here.

      const result: BrowseResult = {
        success: true,
        command: "browse",
        // Null-safe: entries whose metadata couldn't be read carry a null
        // exportedAt. `new Date(null ?? 0)` is the epoch, and an unparseable
        // string is coerced to the epoch too, so those sort last (newest
        // first) instead of poisoning the comparator with NaN.
        exports: exports.sort(
          (a, b) => exportedAtMillis(b.exportedAt) - exportedAtMillis(a.exportedAt)
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
        if (key === "machine.name") {
          const { setMachineName } = await import("./machine.js");
          const identity = setMachineName(value);
          const result: ConfigureResult = {
            success: true,
            command: "configure",
            config: readConfig(configDir),
            scope: opts.scope as StorageScope,
            message: `Set machine.name = ${identity.name}`,
          };
          output(result);
          return;
        }
        let config = readConfig(configDir);
        // Parse value
        let parsedValue: unknown = value;
        if (value === "true") parsedValue = true;
        else if (value === "false") parsedValue = false;
        else if (value.startsWith("[")) {
          try {
            parsedValue = JSON.parse(value);
          } catch (parseErr) {
            outputError(
              "configure",
              new Error(`Invalid JSON for ${key}: ${(parseErr as Error).message}`)
            );
            return;
          }
        }

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

// --- Hub ---
const hub = program.command("hub").description("Cross-machine session hub");

hub
  .command("init")
  .description("Initialize or join a hub directory and set hub.path")
  .requiredOption("--path <dir>", "Hub directory (network share, synced folder, or local path)")
  .option("--scope <scope>", "Config scope to write hub.path into: user or project", "user")
  .action(async (opts) => {
    try {
      const scope = parseStorage(opts.scope);
      const result = await hubInit({ hubPath: opts.path, configScope: scope, cwd: process.cwd() });
      output(result);
    } catch (e) {
      outputError("hub-init", e as Error);
    }
  });

hub
  .command("status")
  .description("Report hub reachability, machine registration, and project link state")
  .action(async () => {
    try {
      output(await hubStatus({ cwd: process.cwd() }));
    } catch (e) {
      outputError("hub-status", e as Error);
    }
  });

hub
  .command("reindex")
  .description("Rebuild this machine's hub index for the current project from its own bundles")
  .option("--project-path <path>", "Override project path (default: cwd)")
  .option("--source-config-dir <path>", "Override Claude config dir")
  .action(async (opts) => {
    try {
      const configDir = resolveConfigDir(opts.sourceConfigDir);
      const projectPath = opts.projectPath ?? process.cwd();
      const config = loadEffectiveConfig(configDir, projectPath);
      const { resolveHubPath } = await import("./hub/init.js");
      const hubPath = resolveHubPath(config);
      if (!hubPath) {
        outputError("hub-reindex", new Error("No hub configured. Run: sesh-mover hub init --path <dir>"));
        return;
      }
      const { hubReindex } = await import("./hub/reindex.js");
      output(await hubReindex({ configDir, projectPath, hubPath }));
    } catch (e) {
      outputError("hub-reindex", e as Error);
    }
  });

hub
  .command("hook-session-end")
  .description("Internal: Claude Code SessionEnd hook — auto-push this project to the hub")
  .action(async () => {
    // ---------------------------------------------------------------------
    // STDOUT CONTRACT EXCEPTION — deliberate, do not "fix".
    //
    // Every other sesh-mover command emits exactly one JSON result object on
    // stdout and exits non-zero on failure. The hook endpoints speak Claude
    // Code's HOOK protocol instead: this one writes NOTHING to stdout, ever,
    // and ALWAYS exits 0. A broken/unreachable hub must never surface as a
    // hook error when a user's session ends. Diagnostics go to stderr only,
    // through writeHookDiagnostic so they can't break that promise either.
    // ---------------------------------------------------------------------
    // SessionEnd fires while the parent Claude Code process is tearing down,
    // so this hook's stdio pipes can be closed out from under it. A write to
    // a reader-less pipe EPIPEs *asynchronously*, surfacing as an 'error'
    // event that — with no listener — terminates the process with exit 1.
    // One listener, attached before any write, keeps the contract.
    process.stderr.on("error", () => {});
    try {
      const payload = readHookPayload(await readStdin());
      const gate = evaluateHookGate(payload, "autoPush");
      if (!gate.ok) return; // no hub / unlinked / disabled / no cwd — silent no-op
      const projectPath = gate.projectPath as string;
      const configDir = resolveConfigDir();
      // Re-read the effective config for this project so the automatic push
      // honors the same hub.noWorkspace / hub.carryDiff opt-outs the manual
      // `push` does — an automated push must not upload project files, or
      // uncommitted work, that the user opted out of. This is the only place
      // either opt-out can be expressed for the hook: it takes no flags.
      const config = loadEffectiveConfig(configDir, projectPath);
      const { hubPush } = await import("./hub/push.js");
      const result = await hubPush({
        configDir,
        projectPath,
        hubPath: gate.hubPath as string,
        noWorkspace: config.hub.noWorkspace,
        noCarry: !config.hub.carryDiff,
        // Nothing this push produces is read by a human: stdout is closed to it
        // and stderr only carries failures. `quiet` keeps it from computing the
        // ignored-path discovery aid nobody will see (and from walking the
        // working tree to do it) — see HubPushOptions.quiet.
        quiet: true,
        claudeVersion: getClaudeVersion(),
      });
      // lock-busy is an expected outcome, not a failure: another sesh-mover
      // hub operation for this project is already running, so this push is
      // redundant by definition. Everything else is worth a stderr line.
      if (!result.success && !("reason" in result && result.reason === "lock-busy")) {
        writeHookDiagnostic(`sesh-mover auto-push: ${JSON.stringify(result)}\n`);
      }
    } catch (e) {
      writeHookDiagnostic(`sesh-mover auto-push failed: ${(e as Error).message}\n`);
    }
  });

hub
  .command("hook-session-start")
  .description("Internal: Claude Code SessionStart hook — announce newer sessions on other machines")
  .action(async () => {
    // ---------------------------------------------------------------------
    // STDOUT CONTRACT EXCEPTION — deliberate, do not "fix".
    //
    // This endpoint speaks Claude Code's HOOK protocol, not sesh-mover's
    // one-JSON-result CLI protocol. It writes either NOTHING or exactly one
    // hook-JSON object, and ALWAYS exits 0. The object shape below was
    // verified against the installed Claude Code build's own output schema:
    //
    //   E.object({ hookEventName: E.literal("SessionStart"),
    //              additionalContext: E.string().optional(), … })
    //
    // Every failure mode degrades to silence: a session must never open with
    // an error, a stack trace, or a half-written object on stdout that Claude
    // Code would then fail to parse. Diagnostics go to stderr, which Claude
    // Code does not show the user at exit 0.
    // ---------------------------------------------------------------------
    // Same asynchronous-EPIPE hazard the SessionEnd endpoint has for stderr,
    // and this is the ONE endpoint that writes stdout: if the reader of either
    // pipe goes away before the write lands, the write EPIPEs *asynchronously*,
    // so a try/catch cannot see it — with no 'error' listener that terminates
    // the process with exit 1 and a stack trace, which for SessionStart is
    // "other exit codes → show stderr to user". One listener per pipe,
    // attached before any write, keeps the contract above true.
    process.stderr.on("error", () => {});
    process.stdout.on("error", () => {});
    try {
      const payload = readHookPayload(await readStdin());
      const gate = evaluateHookGate(payload, "startupNotice");
      if (!gate.ok) return; // no hub / unlinked / disabled / no cwd — silent no-op

      const { hubWhereis } = await import("./hub/whereis.js");
      const result = await hubWhereis({
        configDir: resolveConfigDir(),
        projectPath: gate.projectPath as string,
        hubPath: gate.hubPath as string,
      });
      if (!result.success || !result.linked) return;

      // Newest first, so the one thread we name is the one most likely to be
      // what the user came back for. resolveThreads' ordering is deterministic
      // but is not recency ordering, so sorting here is not redundant.
      const stale = result.threads
        .filter((t) => t.pullNeeded)
        .sort((a, b) => parseTime(b.latest.lastActiveAt) - parseTime(a.latest.lastActiveAt));
      if (stale.length === 0) return;

      const top = stale[0];
      // Every field below comes out of another machine's index file, so each
      // one is sanitized and each one has a fallback: a torn or old-format
      // entry missing `slug` would otherwise render the literal string
      // "undefined" as the name of the thread the user is being told to pull.
      const what = noticeField(top.slug) || noticeField(top.threadId) || "a session";
      const where =
        noticeField(top.latest.machineName) ||
        noticeField(top.latest.machineId) ||
        "another machine";
      const rest = stale.length > 1 ? ` (+${stale.length - 1} more)` : "";
      const context =
        `sesh-mover: newer work for this project exists on another machine — ` +
        `"${what}" on ${where}, ${describeAge(top.latest.lastActiveAt)}${rest}. ` +
        `Run /sesh-mover:pull to bring it here.`;

      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
        }) + "\n"
      );
    } catch (e) {
      writeHookDiagnostic(`sesh-mover startup notice failed: ${(e as Error).message}\n`);
    }
  });

// --- Push ---
program
  .command("push")
  .description("Push this project's sessions to the hub")
  .option("--session-id <ids...>", "Push specific sessions only")
  .option("--project-path <path>", "Override project path (default: cwd)")
  .option("--source-config-dir <path>", "Override Claude config dir")
  .option("--project-id <id>", "Link to an existing hub project id")
  .option("--create-project", "Mint a new hub project for this directory")
  .option("--no-workspace", "Skip the workspace snapshot for non-git projects")
  .option("--no-carry", "Do not carry uncommitted changes (git projects)")
  .option("--progress", "Emit NDJSON progress events on stderr")
  .action(async (opts) => {
    try {
      const configDir = resolveConfigDir(opts.sourceConfigDir);
      const projectPath = opts.projectPath ?? process.cwd();
      const config = loadEffectiveConfig(configDir, projectPath);
      const { resolveHubPath } = await import("./hub/init.js");
      const hubPath = resolveHubPath(config);
      if (!hubPath) {
        outputError("push", new Error("No hub configured. Run: sesh-mover hub init --path <dir>"));
        return;
      }
      const { hubPush } = await import("./hub/push.js");
      const onProgress = opts.progress
        ? (ev: import("./types.js").ProgressEvent) => process.stderr.write(JSON.stringify(ev) + "\n")
        : undefined;
      output(await hubPush({
        configDir, projectPath, hubPath,
        sessionIds: opts.sessionId,
        noWorkspace: opts.workspace === false || config.hub.noWorkspace,
        noCarry: opts.carry === false || !config.hub.carryDiff,
        projectIdOverride: opts.projectId,
        createProject: !!opts.createProject,
        claudeVersion: getClaudeVersion(),
        onProgress,
      }));
    } catch (e) {
      outputError("push", e as Error);
    }
  });

// --- Pull ---
program
  .command("pull")
  .description("Pull a project's thread from the hub into this machine")
  .option("--thread <id>", "Pull a specific thread by id")
  .option("--latest", "Pull whichever thread most needs updating on this machine")
  .option("--project-path <path>", "Override project path (default: cwd)")
  .option("--target-path <path>", "Workspace unpack destination when the project directory doesn't exist locally yet")
  .option("--force-workspace", "Merge workspace files into a non-empty target directory")
  .option("--project-id <id>", "Link to an existing hub project id")
  .option("--force-append", "Append a pulled continuation even if the local session looks recently active")
  .option("--no-append", "Never append; import continuations as separate sessions")
  .option("--on-divergence <mode>", "When a thread was extended on both machines: fragment | adopt-hub | skip")
  .option("--source-config-dir <path>", "Override Claude config dir")
  .option("--progress", "Emit NDJSON progress events on stderr")
  .action(async (opts) => {
    try {
      const configDir = resolveConfigDir(opts.sourceConfigDir);
      const projectPath = opts.projectPath ?? process.cwd();
      const config = loadEffectiveConfig(configDir, projectPath);
      // Validated before the hub lookup: a bad mode is a bad invocation, and
      // saying so should not depend on whether a hub happens to be configured.
      const onDivergence = parseOnDivergence(opts.onDivergence ?? config.hub.onDivergence);
      const { resolveHubPath } = await import("./hub/init.js");
      const hubPath = resolveHubPath(config);
      if (!hubPath) {
        outputError("pull", new Error("No hub configured. Run: sesh-mover hub init --path <dir>"));
        return;
      }
      const { hubPull } = await import("./hub/pull.js");
      const onProgress = opts.progress
        ? (ev: import("./types.js").ProgressEvent) => process.stderr.write(JSON.stringify(ev) + "\n")
        : undefined;
      output(await hubPull({
        configDir, projectPath, hubPath,
        threadId: opts.thread,
        latest: !!opts.latest,
        targetPath: opts.targetPath,
        forceWorkspace: !!opts.forceWorkspace,
        projectIdOverride: opts.projectId,
        forceAppend: !!opts.forceAppend,
        noAppend: opts.append === false || !config.hub.pullAppend,
        onDivergence,
        claudeVersion: getClaudeVersion(),
        onProgress,
      }));
    } catch (e) {
      outputError("pull", e as Error);
    }
  });

// --- Whereis ---
program
  .command("whereis")
  .description("Show this project's sessions across all hub machines")
  .option("--project-path <path>", "Override project path (default: cwd)")
  .option("--source-config-dir <path>", "Override Claude config dir")
  .action(async (opts) => {
    try {
      const configDir = resolveConfigDir(opts.sourceConfigDir);
      const projectPath = opts.projectPath ?? process.cwd();
      const config = loadEffectiveConfig(configDir, projectPath);
      const { resolveHubPath } = await import("./hub/init.js");
      const hubPath = resolveHubPath(config);
      if (!hubPath) {
        outputError("whereis", new Error("No hub configured. Run: sesh-mover hub init --path <dir>"));
        return;
      }
      const { hubWhereis } = await import("./hub/whereis.js");
      output(await hubWhereis({ configDir, projectPath, hubPath }));
    } catch (e) {
      outputError("whereis", e as Error);
    }
  });

// --- Helpers ---

// Single predicate for both the collision gate and the --suffix loop, so a
// plain directory export and an archive/zstd export of the same name can
// never collide silently (an archive's staging dir is removed after
// packaging, so only `<name>.tar.gz`/`<name>.tar.zst` remains on disk).
function exportArtifactExists(outputDir: string, name: string): boolean {
  return (
    existsSync(join(outputDir, name)) ||
    existsSync(join(outputDir, `${name}.tar.gz`)) ||
    existsSync(join(outputDir, `${name}.tar.zst`))
  );
}

async function doExport(
  configDir: string,
  scope: SessionScope,
  sessionId: string | undefined,
  outputDir: string,
  name: string,
  excludeLayers: ExportLayer[],
  claudeVersion: string,
  projectPathOverride?: string,
  noSummary?: boolean,
  incremental?: import("./exporter.js").IncrementalExportOptions,
  onProgress?: (ev: import("./types.js").ProgressEvent) => void
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
      noSummary,
      incremental,
      onProgress,
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
    noSummary,
    incremental,
    onProgress,
  });
}

async function finalizeExport(params: {
  result: ExportResult;
  format: ExportFormat;
  incremental?: import("./exporter.js").IncrementalExportOptions;
  projectPath: string;
  onProgress?: (ev: import("./types.js").ProgressEvent) => void;
}): Promise<void> {
  const { result, format, incremental, projectPath, onProgress } = params;
  const bundleDir = result.exportPath;

  if (format === "archive" || format === "zstd") {
    let compression: "gzip" | "zstd" = format === "zstd" ? "zstd" : "gzip";
    if (compression === "zstd" && !(await isZstdAvailable())) {
      result.warnings.push("zstd not found on system, falling back to gzip");
      compression = "gzip";
      result.actualFormat = "archive"; // signal fallback to skill
    }
    const ext = compression === "zstd" ? ".tar.zst" : ".tar.gz";
    const archivePath = bundleDir + ext;
    // Archive FIRST. If this throws, the staging dir is left intact and no
    // sent-state is recorded — a failed export must not advance peer heads
    // (those entries would never actually ship, and would be silently
    // skipped on the next incremental export as "already sent").
    onProgress?.({ phase: "archive", percent: 0 });
    await createArchive(bundleDir, archivePath, compression);
    onProgress?.({ phase: "archive", percent: 100 });

    // Record sync state from the bundle now that the archive exists — the
    // staging dir is still present at this point, so recordSentFromBundle
    // can still read the session JSONL snapshots out of it.
    if (incremental?.targetMachineId) {
      recordSentFromBundle(
        projectPath,
        { id: incremental.targetMachineId, name: incremental.targetMachineName },
        bundleDir
      );
    }

    rmSync(bundleDir, { recursive: true, force: true });
    result.archivePath = archivePath;
    result.exportPath = archivePath;
    return;
  }

  // dir format: no archiving step that can fail, so record immediately.
  if (incremental?.targetMachineId) {
    recordSentFromBundle(
      projectPath,
      { id: incremental.targetMachineId, name: incremental.targetMachineName },
      bundleDir
    );
  }
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
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as import("./types.js").ExportManifest;
  assertSafeManifestIds(manifest);
  return manifest;
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
    const localId =
      s.type === "continuation" && s.continuation
        ? s.continuation.continuesLocalSessionId
        : s.sessionId;
    peerSent[localId] = {
      headEntryUuid:
        readLastEntryUuid(join(opts.since!, "sessions", `${s.sessionId}.jsonl`)) ?? "",
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

function parseScope(value: string, command: string): SessionScope {
  if (value === "current" || value === "all") return value;
  throw new Error(
    `Invalid --scope value for ${command}: "${value}". Valid: current, all.`
  );
}

// Validates BOTH the flag and hub.onDivergence from config — a typo'd config
// value must fail loudly here rather than silently resolving to a mode the
// user didn't pick.
function parseOnDivergence(value: string): OnDivergenceMode {
  if (value === "fragment" || value === "adopt-hub" || value === "skip") return value;
  throw new Error(
    `Invalid --on-divergence value: "${value}". Valid: fragment, adopt-hub, skip.`
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

function loadEffectiveConfig(_configDir: string, projectDir: string) {
  const userConfigDir = join(homedir(), ".claude-sesh-mover");
  const projectConfigDir = join(projectDir, ".claude-sesh-mover");
  return computeEffectiveConfig(userConfigDir, projectConfigDir);
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

// Timestamps in a hub index file are untrusted input (another machine wrote
// them, and the file can be torn). Date.parse returns NaN for anything it
// can't read, which would sort unpredictably and render as "NaN minutes ago",
// so unparseable timestamps sort last and describe as "recently".
function parseTime(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

// A freshness notice reads at a glance or not at all: "4320 minutes ago" is
// noise where "3 days ago" is information.
//
// Every step FLOORS rather than rounds. Rounding overstates staleness — 90
// minutes would read "2 hours ago" and 36 hours "2 days ago" — in a notice
// whose whole job is a truthful at-a-glance read of how far behind the local
// copy is. Flooring can only understate, which is the safe direction: it
// never makes work sound more abandoned than it is.
function describeAge(iso: string): string {
  const then = parseTime(iso);
  if (then === 0) return "recently";
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Longest run of index-file text allowed into an injected notice. */
const NOTICE_FIELD_MAX = 80;

/**
 * Makes one field of another machine's index file safe to interpolate into
 * the SessionStart notice.
 *
 * That notice is injected straight into the model's context, and a thread slug
 * ultimately derives from a conversation-derived session title — so it is not
 * fully machine-controlled even under the hub's "your own machines" threat
 * model. Control characters (newlines above all) would let such a string forge
 * structure inside the injected text, and an unbounded one would let it
 * dominate it. Collapse whitespace, drop control characters, cap the length.
 *
 * Returns "" for anything absent or non-string, so every call site can fall
 * back with `||` rather than rendering "undefined".
 */
function noticeField(value: unknown): string {
  if (typeof value !== "string") return "";
  // \p{C} is Unicode's "other" category: C0/C1 controls, format characters
  // (including the bidi and zero-width overrides), surrogates and unassigned
  // code points — i.e. everything that can move or hide text rather than show
  // it. Nothing legible is in it, so replacing the whole category is both
  // safer and shorter than an escape range.
  const clean = value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= NOTICE_FIELD_MAX) return clean;
  // Cut on code points, not UTF-16 code units: slicing an astral character in
  // half leaves a lone surrogate, which renders as a replacement glyph in the
  // very notice this function exists to keep legible.
  return [...clean].slice(0, NOTICE_FIELD_MAX - 1).join("") + "…";
}

// Best-effort stderr diagnostic for the hook endpoints. A hook's diagnostic
// must never be able to change its exit code, so a failing write is swallowed
// here: writes to a closed/broken stderr can throw synchronously (closed fd)
// as well as emit asynchronously (EPIPE on a reader-less pipe, handled by the
// listener the endpoints attach). The hook contract outranks the diagnostic.
function writeHookDiagnostic(message: string): void {
  try {
    process.stderr.write(message);
  } catch {
    /* stderr is gone — stay silent rather than fail the hook */
  }
}

// How long a hook endpoint waits for its stdin payload before giving up and
// proceeding with whatever arrived. Claude Code's own hook runner writes the
// payload and calls stdin.end() immediately (verified in the installed 2.1.221
// build: both the sync and the `async: true` spawn paths do
// `stdin.write(json + "\n"); stdin.end()`), so in the real integration this
// bound is never reached — a few milliseconds is the normal case. It exists
// for every OTHER way the endpoint can be invoked.
const HOOK_STDIN_TIMEOUT_MS = 2000;

/**
 * Reads a hook payload from stdin, bounded.
 *
 * Returns "" immediately on a TTY, so an operator who runs a hook endpoint by
 * hand gets the same silent no-op as an empty payload instead of a process
 * that appears to hang.
 *
 * The timeout is the load-bearing part. This read happens BEFORE the gate, so
 * an un-closed stdin pipe hangs the endpoint even on a machine with no hub
 * configured — measured at >10s and needing SIGKILL before the bound existed.
 * That matters most at SessionEnd: Claude Code gives SessionEnd hooks a
 * 1.5s budget (`getSessionEndHookTimeoutMs`, floor 1500ms) and then force-exits
 * the process, so a hook that blocks on stdin is a hook that never runs.
 * Degrading to an empty payload is always safe — an empty payload has no
 * `cwd`, so the gate declines with "no-cwd" and the endpoint is a silent no-op.
 */
async function readStdin(timeoutMs = HOOK_STDIN_TIMEOUT_MS): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve) => {
    let settled = false;
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", finish);
      stdin.off("error", finish);
      // Release the handle explicitly. Attaching a 'data' listener puts stdin
      // in flowing mode, which keeps the event loop alive; if the writer never
      // closes the pipe, resolving alone would leave the process running until
      // something killed it — the exact hang this bound exists to prevent.
      stdin.pause();
      stdin.unref?.();
      resolve(Buffer.concat(chunks).toString("utf-8"));
    };
    // Deliberately NOT unref'd: this timer is the guarantee that finish() runs.
    const timer = setTimeout(finish, timeoutMs);
    stdin.on("data", onData);
    stdin.on("end", finish);
    // A broken/closed stdin is "no payload", not a crash.
    stdin.on("error", finish);
  });
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
