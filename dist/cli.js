#!/usr/bin/env node
import { Command } from "commander";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveConfigDir, detectPlatform } from "./platform.js";
import { getDefaultConfig, readConfig, writeConfig, setConfigValue, computeEffectiveConfig, } from "./config.js";
import { exportSession, exportAllSessions } from "./exporter.js";
import { importSession } from "./importer.js";
import { migrateSession } from "./migrator.js";
import { readManifest, assertSafeManifestIds } from "./manifest.js";
import { loadOrCreateMachineId } from "./machine.js";
import { readSyncState, recordSentFromBundle } from "./sync-state.js";
import { readLastEntryUuid } from "./jsonl.js";
import { createArchive, extractArchive, detectArchiveFormat, isZstdAvailable, } from "./archiver.js";
import { discoverSessionById } from "./discovery.js";
import { hubInit } from "./hub/init.js";
import { hubStatus } from "./hub/status.js";
const program = new Command();
program
    .name("sesh-mover")
    .description("Export, import, and migrate Claude Code sessions")
    .version("0.4.1");
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
            ? (ev) => process.stderr.write(JSON.stringify(ev) + "\n")
            : undefined;
        const configDir = resolveConfigDir(opts.sourceConfigDir);
        const config = loadEffectiveConfig(configDir, process.cwd());
        const scope = parseScope(opts.scope ?? config.export.scope, "export");
        const storage = parseStorage(opts.storage ?? config.export.storage);
        const format = parseFormat(opts.format ?? config.export.format);
        const excludeLayers = (opts.exclude ?? config.export.exclude);
        const claudeVersion = getClaudeVersion();
        let incremental;
        try {
            incremental = resolveIncrementalOptions({
                incremental: opts.incremental,
                to: opts.to,
                since: opts.since,
                projectPath: opts.projectPath,
            });
        }
        catch (e) {
            outputError("export", e);
            return;
        }
        // Determine output directory
        let outputDir;
        if (opts.output) {
            outputDir = opts.output;
        }
        else if (storage === "project") {
            outputDir = join(process.cwd(), ".claude-sesh-mover");
        }
        else {
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
            while (exportArtifactExists(outputDir, `${name}-${suffix}`))
                suffix++;
            finalName = `${name}-${suffix}`;
        }
        const noSummary = opts.summary === false || config.export.noSummary;
        const result = await doExport(configDir, scope, opts.sessionId, outputDir, finalName, excludeLayers, claudeVersion, opts.projectPath, noSummary, incremental, onProgress);
        if (result.success) {
            await finalizeExport({
                result: result,
                format,
                incremental,
                projectPath: opts.projectPath ?? process.cwd(),
                onProgress,
            });
        }
        output(result);
    }
    catch (e) {
        outputError("export", e);
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
    let tempExtractDir;
    try {
        const onProgress = opts.progress
            ? (ev) => process.stderr.write(JSON.stringify(ev) + "\n")
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
    }
    catch (e) {
        outputError("import", e);
    }
    finally {
        if (tempExtractDir)
            rmSync(tempExtractDir, { recursive: true, force: true });
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
            ? (ev) => process.stderr.write(JSON.stringify(ev) + "\n")
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
            excludeLayers: (opts.exclude ?? []),
            claudeVersion,
            dryRun: !!opts.dryRun,
            renameDir: !!opts.renameDir,
            currentCwd: process.cwd(),
            force: !!opts.force,
            onProgress,
        });
        output(result);
    }
    catch (e) {
        outputError("migrate", e);
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
        const exports = [];
        const searchDirs = [];
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
                    }
                    catch {
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
                if (entry === ".claude-sesh-mover")
                    continue; // already scanned above
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
                    }
                    catch {
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
        const result = {
            success: true,
            command: "browse",
            exports: exports.sort((a, b) => new Date(b.exportedAt || 0).getTime() -
                new Date(a.exportedAt || 0).getTime()),
        };
        output(result);
    }
    catch (e) {
        outputError("browse", e);
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
        const configDir = opts.scope === "project"
            ? join(process.cwd(), ".claude-sesh-mover")
            : join(homedir(), ".claude-sesh-mover");
        if (opts.reset) {
            writeConfig(configDir, getDefaultConfig());
            const result = {
                success: true,
                command: "configure",
                config: getDefaultConfig(),
                scope: opts.scope,
                message: "Config reset to defaults",
            };
            output(result);
            return;
        }
        if (opts.set) {
            const eqIndex = opts.set.indexOf("=");
            if (eqIndex === -1) {
                outputError("configure", new Error("--set requires key=value format"));
                return;
            }
            const key = opts.set.slice(0, eqIndex);
            const value = opts.set.slice(eqIndex + 1);
            if (!key) {
                outputError("configure", new Error("--set requires key=value format"));
                return;
            }
            if (key === "machine.name") {
                const { setMachineName } = await import("./machine.js");
                const identity = setMachineName(value);
                const result = {
                    success: true,
                    command: "configure",
                    config: readConfig(configDir),
                    scope: opts.scope,
                    message: `Set machine.name = ${identity.name}`,
                };
                output(result);
                return;
            }
            let config = readConfig(configDir);
            // Parse value
            let parsedValue = value;
            if (value === "true")
                parsedValue = true;
            else if (value === "false")
                parsedValue = false;
            else if (value.startsWith("[")) {
                try {
                    parsedValue = JSON.parse(value);
                }
                catch (parseErr) {
                    outputError("configure", new Error(`Invalid JSON for ${key}: ${parseErr.message}`));
                    return;
                }
            }
            config = setConfigValue(config, key, parsedValue);
            writeConfig(configDir, config);
            const result = {
                success: true,
                command: "configure",
                config,
                scope: opts.scope,
                message: `Set ${key} = ${value}`,
            };
            output(result);
            return;
        }
        if (opts.show) {
            const config = loadEffectiveConfig(resolveConfigDir(), process.cwd());
            const result = {
                success: true,
                command: "configure",
                config,
                scope: opts.scope,
                message: "Current effective config",
            };
            output(result);
            return;
        }
        // Default: show config
        const config = readConfig(configDir);
        const result = {
            success: true,
            command: "configure",
            config,
            scope: opts.scope,
            message: `Config for ${opts.scope} scope`,
        };
        output(result);
    }
    catch (e) {
        outputError("configure", e);
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
    }
    catch (e) {
        outputError("hub-init", e);
    }
});
hub
    .command("status")
    .description("Report hub reachability, machine registration, and project link state")
    .option("--source-config-dir <path>", "Override Claude config dir")
    .action(async (opts) => {
    try {
        const configDir = resolveConfigDir(opts.sourceConfigDir);
        output(await hubStatus({ configDir, cwd: process.cwd() }));
    }
    catch (e) {
        outputError("hub-status", e);
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
            ? (ev) => process.stderr.write(JSON.stringify(ev) + "\n")
            : undefined;
        output(await hubPush({
            configDir, projectPath, hubPath,
            sessionIds: opts.sessionId,
            noWorkspace: opts.workspace === false || config.hub.noWorkspace,
            projectIdOverride: opts.projectId,
            createProject: !!opts.createProject,
            claudeVersion: getClaudeVersion(),
            onProgress,
        }));
    }
    catch (e) {
        outputError("push", e);
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
    .option("--source-config-dir <path>", "Override Claude config dir")
    .option("--progress", "Emit NDJSON progress events on stderr")
    .action(async (opts) => {
    try {
        const configDir = resolveConfigDir(opts.sourceConfigDir);
        const projectPath = opts.projectPath ?? process.cwd();
        const config = loadEffectiveConfig(configDir, projectPath);
        const { resolveHubPath } = await import("./hub/init.js");
        const hubPath = resolveHubPath(config);
        if (!hubPath) {
            outputError("pull", new Error("No hub configured. Run: sesh-mover hub init --path <dir>"));
            return;
        }
        const { hubPull } = await import("./hub/pull.js");
        const onProgress = opts.progress
            ? (ev) => process.stderr.write(JSON.stringify(ev) + "\n")
            : undefined;
        output(await hubPull({
            configDir, projectPath, hubPath,
            threadId: opts.thread,
            latest: !!opts.latest,
            targetPath: opts.targetPath,
            forceWorkspace: !!opts.forceWorkspace,
            projectIdOverride: opts.projectId,
            claudeVersion: getClaudeVersion(),
            onProgress,
        }));
    }
    catch (e) {
        outputError("pull", e);
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
    }
    catch (e) {
        outputError("whereis", e);
    }
});
// --- Helpers ---
// Single predicate for both the collision gate and the --suffix loop, so a
// plain directory export and an archive/zstd export of the same name can
// never collide silently (an archive's staging dir is removed after
// packaging, so only `<name>.tar.gz`/`<name>.tar.zst` remains on disk).
function exportArtifactExists(outputDir, name) {
    return (existsSync(join(outputDir, name)) ||
        existsSync(join(outputDir, `${name}.tar.gz`)) ||
        existsSync(join(outputDir, `${name}.tar.zst`)));
}
async function doExport(configDir, scope, sessionId, outputDir, name, excludeLayers, claudeVersion, projectPathOverride, noSummary, incremental, onProgress) {
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
async function finalizeExport(params) {
    const { result, format, incremental, projectPath, onProgress } = params;
    const bundleDir = result.exportPath;
    if (format === "archive" || format === "zstd") {
        let compression = format === "zstd" ? "zstd" : "gzip";
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
            recordSentFromBundle(projectPath, { id: incremental.targetMachineId, name: incremental.targetMachineName }, bundleDir);
        }
        rmSync(bundleDir, { recursive: true, force: true });
        result.archivePath = archivePath;
        result.exportPath = archivePath;
        return;
    }
    // dir format: no archiving step that can fail, so record immediately.
    if (incremental?.targetMachineId) {
        recordSentFromBundle(projectPath, { id: incremental.targetMachineId, name: incremental.targetMachineName }, bundleDir);
    }
}
function resolvePeer(state, needle) {
    if (state.peers[needle])
        return { id: needle };
    const byName = Object.entries(state.peers).find(([, p]) => p.name === needle);
    if (byName)
        return { id: byName[0] };
    return null;
}
function readReferenceManifest(path) {
    const manifestPath = join(path, "manifest.json");
    if (!existsSync(manifestPath)) {
        throw new Error(`--since ${path} does not contain a manifest.json (archive --since is a phase-2 feature).`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assertSafeManifestIds(manifest);
    return manifest;
}
function resolveIncrementalOptions(opts) {
    if (!opts.incremental)
        return undefined;
    if (!opts.to && !opts.since) {
        throw new Error("Invalid --incremental usage: provide either --to <peer> or --since <path>.");
    }
    if (opts.to && opts.since) {
        throw new Error("Invalid --incremental usage: --to and --since are mutually exclusive.");
    }
    const machine = loadOrCreateMachineId();
    const projectPath = opts.projectPath ?? process.cwd();
    if (opts.to) {
        const state = readSyncState(projectPath);
        const match = resolvePeer(state, opts.to);
        if (!match) {
            throw new Error(`No sync history with peer "${opts.to}". Run a full export to this peer first, or use --since <path>.`);
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
    const refManifest = readReferenceManifest(opts.since);
    const peerSent = {};
    for (const s of refManifest.sessions) {
        const localId = s.type === "continuation" && s.continuation
            ? s.continuation.continuesLocalSessionId
            : s.sessionId;
        peerSent[localId] = {
            headEntryUuid: readLastEntryUuid(join(opts.since, "sessions", `${s.sessionId}.jsonl`)) ?? "",
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
function parseScope(value, command) {
    if (value === "current" || value === "all")
        return value;
    throw new Error(`Invalid --scope value for ${command}: "${value}". Valid: current, all.`);
}
function parseStorage(value) {
    if (value === "user" || value === "project")
        return value;
    throw new Error(`Invalid --storage value: "${value}". Valid: user, project.`);
}
function parseFormat(value) {
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
            throw new Error(`Invalid --format value: "${value}". Valid: dir, archive (tar.gz), zstd (tar.zst).`);
    }
}
function loadEffectiveConfig(_configDir, projectDir) {
    const userConfigDir = join(homedir(), ".claude-sesh-mover");
    const projectConfigDir = join(projectDir, ".claude-sesh-mover");
    return computeEffectiveConfig(userConfigDir, projectConfigDir);
}
function generateExportName(configDir, sessionId) {
    const date = new Date().toISOString().split("T")[0];
    if (sessionId) {
        const session = discoverSessionById(configDir, sessionId);
        if (session && session.slug) {
            return `${date}-${session.slug}`;
        }
    }
    return `${date}-export`;
}
function getClaudeVersion() {
    try {
        const version = execFileSync("claude", ["--version"], {
            encoding: "utf-8",
            timeout: 5000,
        }).trim();
        // Extract version number
        const match = version.match(/(\d+\.\d+\.\d+)/);
        return match ? match[1] : "unknown";
    }
    catch {
        return "unknown";
    }
}
function output(result) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
function outputError(command, error) {
    const result = {
        success: false,
        command,
        error: error.message,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(1);
}
program.parse();
//# sourceMappingURL=cli.js.map