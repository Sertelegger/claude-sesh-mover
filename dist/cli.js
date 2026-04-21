#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_fs_1 = require("node:fs");
const node_child_process_1 = require("node:child_process");
const platform_js_1 = require("./platform.js");
const config_js_1 = require("./config.js");
const exporter_js_1 = require("./exporter.js");
const importer_js_1 = require("./importer.js");
const migrator_js_1 = require("./migrator.js");
const manifest_js_1 = require("./manifest.js");
const machine_js_1 = require("./machine.js");
const sync_state_js_1 = require("./sync-state.js");
const archiver_js_1 = require("./archiver.js");
const discovery_js_1 = require("./discovery.js");
const program = new commander_1.Command();
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
        const configDir = (0, platform_js_1.resolveConfigDir)(opts.sourceConfigDir);
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
            outputDir = (0, node_path_1.join)(process.cwd(), ".claude-sesh-mover");
        }
        else {
            outputDir = (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude-sesh-mover");
        }
        (0, node_fs_1.mkdirSync)(outputDir, { recursive: true });
        // Generate name
        const name = opts.name ?? generateExportName(configDir, opts.sessionId);
        // Check collision
        const exportPath = (0, node_path_1.join)(outputDir, name);
        if ((0, node_fs_1.existsSync)(exportPath) && !opts.overwrite) {
            if (opts.suffix) {
                // Find next available suffix
                let suffix = 2;
                while ((0, node_fs_1.existsSync)((0, node_path_1.join)(outputDir, `${name}-${suffix}`))) {
                    suffix++;
                }
                const suffixedName = `${name}-${suffix}`;
                const result = await doExport(configDir, scope, opts.sessionId, outputDir, suffixedName, excludeLayers, claudeVersion, opts.projectPath, incremental);
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
        const result = await doExport(configDir, scope, opts.sessionId, outputDir, name, excludeLayers, claudeVersion, opts.projectPath, incremental);
        // Capture the bundle dir before archive cleanup destroys the staging tree.
        // At this point result.exportPath is still the directory path (not the .tar.gz),
        // so we can read the manifest from disk before archive packaging + rm happens.
        const preArchiveBundleDir = result.success && incremental?.targetMachineId
            ? result.exportPath
            : null;
        // Handle archive
        if (result.success && (format === "archive" || format === "zstd")) {
            const exportResult = result;
            let compression = format === "zstd" ? "zstd" : "gzip";
            if (compression === "zstd" && !(await (0, archiver_js_1.isZstdAvailable)())) {
                exportResult.warnings.push("zstd not found on system, falling back to gzip");
                compression = "gzip";
                exportResult.actualFormat = "archive"; // signal fallback to skill
            }
            const ext = compression === "zstd" ? ".tar.zst" : ".tar.gz";
            const archivePath = exportResult.exportPath + ext;
            const stagingDir = exportResult.exportPath;
            if (preArchiveBundleDir) {
                updateSyncStateAfterExport(configDir, opts.projectPath ?? process.cwd(), incremental, stagingDir);
            }
            await (0, archiver_js_1.createArchive)(stagingDir, archivePath, compression);
            (0, node_fs_1.rmSync)(stagingDir, { recursive: true, force: true });
            exportResult.archivePath = archivePath;
            exportResult.exportPath = archivePath;
        }
        else if (preArchiveBundleDir) {
            updateSyncStateAfterExport(configDir, opts.projectPath ?? process.cwd(), incremental, preArchiveBundleDir);
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
    .option("--force", "Skip confirmation")
    .action(async (opts) => {
    let tempExtractDir;
    try {
        let fromPath = opts.from;
        // If archive, extract first
        const archiveFormat = (0, archiver_js_1.detectArchiveFormat)(fromPath);
        if (archiveFormat) {
            tempExtractDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "sesh-mover-extract-"));
            await (0, archiver_js_1.extractArchive)(fromPath, tempExtractDir);
            fromPath = tempExtractDir;
        }
        const targetConfigDir = (0, platform_js_1.resolveConfigDir)(opts.targetConfigDir);
        const claudeVersion = getClaudeVersion();
        const result = await (0, importer_js_1.importSession)({
            exportPath: fromPath,
            targetConfigDir,
            targetProjectPath: opts.targetProjectPath,
            targetClaudeVersion: claudeVersion,
            dryRun: !!opts.dryRun,
            sessionIds: opts.sessionId,
            noRegister: !opts.register, // Commander.js --no-register sets opts.register to false
        });
        output(result);
    }
    catch (e) {
        outputError("import", e);
    }
    finally {
        if (tempExtractDir)
            (0, node_fs_1.rmSync)(tempExtractDir, { recursive: true, force: true });
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
        const sourceConfigDir = (0, platform_js_1.resolveConfigDir)(opts.sourceConfigDir);
        const targetConfigDir = (0, platform_js_1.resolveConfigDir)(opts.targetConfigDir);
        const claudeVersion = getClaudeVersion();
        const sourceProjectPath = opts.sourceProjectPath ?? process.cwd();
        const config = loadEffectiveConfig(sourceConfigDir, sourceProjectPath);
        const scope = parseScope(opts.scope ?? config.migrate.scope, "migrate");
        const result = await (0, migrator_js_1.migrateSession)({
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
            const userDir = (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude-sesh-mover");
            if ((0, node_fs_1.existsSync)(userDir)) {
                searchDirs.push({ dir: userDir, storage: "user" });
            }
        }
        if (opts.storage === "project" || opts.storage === "all") {
            const projectDir = (0, node_path_1.join)(process.cwd(), ".claude-sesh-mover");
            if ((0, node_fs_1.existsSync)(projectDir)) {
                searchDirs.push({ dir: projectDir, storage: "project" });
            }
        }
        for (const { dir, storage } of searchDirs) {
            const entries = (0, node_fs_1.readdirSync)(dir);
            for (const entry of entries) {
                const manifestPath = (0, node_path_1.join)(dir, entry, "manifest.json");
                if ((0, node_fs_1.existsSync)(manifestPath)) {
                    try {
                        const manifest = (0, manifest_js_1.readManifest)((0, node_path_1.join)(dir, entry));
                        exports.push({
                            name: entry,
                            path: (0, node_path_1.join)(dir, entry),
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
            const entries = (0, node_fs_1.readdirSync)(dir);
            for (const entry of entries) {
                if (entry.endsWith(".tar.gz") || entry.endsWith(".tar.zst")) {
                    // We can't read manifests from archives without extracting
                    // Just list them with minimal info
                    exports.push({
                        name: entry,
                        path: (0, node_path_1.join)(dir, entry),
                        exportedAt: "",
                        sourcePlatform: (0, platform_js_1.detectPlatform)(),
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
            const cwdEntries = (0, node_fs_1.readdirSync)(cwd);
            for (const entry of cwdEntries) {
                if (entry === ".claude-sesh-mover")
                    continue; // already scanned above
                const entryPath = (0, node_path_1.join)(cwd, entry);
                // Check for export directories with manifest.json
                const manifestPath = (0, node_path_1.join)(entryPath, "manifest.json");
                if ((0, node_fs_1.existsSync)(manifestPath)) {
                    try {
                        const manifest = (0, manifest_js_1.readManifest)(entryPath);
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
                            sourcePlatform: (0, platform_js_1.detectPlatform)(),
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
            ? (0, node_path_1.join)(process.cwd(), ".claude-sesh-mover")
            : (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude-sesh-mover");
        if (opts.reset) {
            (0, config_js_1.writeConfig)(configDir, (0, config_js_1.getDefaultConfig)());
            const result = {
                success: true,
                command: "configure",
                config: (0, config_js_1.getDefaultConfig)(),
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
            let config = (0, config_js_1.readConfig)(configDir);
            // Parse value
            let parsedValue = value;
            if (value === "true")
                parsedValue = true;
            else if (value === "false")
                parsedValue = false;
            else if (value.startsWith("["))
                parsedValue = JSON.parse(value);
            config = (0, config_js_1.setConfigValue)(config, key, parsedValue);
            (0, config_js_1.writeConfig)(configDir, config);
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
            const config = loadEffectiveConfig((0, platform_js_1.resolveConfigDir)(), process.cwd());
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
        const config = (0, config_js_1.readConfig)(configDir);
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
// --- Helpers ---
async function doExport(configDir, scope, sessionId, outputDir, name, excludeLayers, claudeVersion, projectPathOverride, incremental) {
    // Detect project path from cwd or override
    const projectPath = projectPathOverride ?? process.cwd();
    if (scope === "all") {
        return (0, exporter_js_1.exportAllSessions)({
            configDir,
            projectPath,
            outputDir,
            name,
            excludeLayers,
            claudeVersion,
            incremental,
        });
    }
    return (0, exporter_js_1.exportSession)({
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
function readLastEntryUuid(jsonlPath) {
    if (!(0, node_fs_1.existsSync)(jsonlPath))
        return null;
    const content = (0, node_fs_1.readFileSync)(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0)
        return null;
    try {
        return (JSON.parse(lines[lines.length - 1]).uuid ?? null);
    }
    catch {
        return null;
    }
}
function readLastEntryUuidInExport(exportPath, sessionId) {
    return readLastEntryUuid((0, node_path_1.join)(exportPath, "sessions", `${sessionId}.jsonl`));
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
    const manifestPath = (0, node_path_1.join)(path, "manifest.json");
    if (!(0, node_fs_1.existsSync)(manifestPath)) {
        throw new Error(`--since ${path} does not contain a manifest.json (archive --since is a phase-2 feature).`);
    }
    return JSON.parse((0, node_fs_1.readFileSync)(manifestPath, "utf-8"));
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
    const machine = (0, machine_js_1.loadOrCreateMachineId)();
    const projectPath = opts.projectPath ?? process.cwd();
    if (opts.to) {
        const state = (0, sync_state_js_1.readSyncState)(projectPath);
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
        peerSent[s.sessionId] = {
            headEntryUuid: readLastEntryUuidInExport(opts.since, s.sessionId) ?? "",
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
function updateSyncStateAfterExport(configDir, projectPath, incremental, bundleDir) {
    if (!incremental.targetMachineId)
        return;
    const state = (0, sync_state_js_1.readSyncState)(projectPath);
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
    const manifest = (0, manifest_js_1.readManifest)(bundleDir);
    const sourceProjectsDir = (0, node_path_1.join)(configDir, "projects", (0, platform_js_1.encodeProjectPath)(projectPath));
    for (const s of manifest.sessions) {
        const localSessionId = s.type === "continuation" && s.continuation
            ? s.continuation.continuesLocalSessionId
            : s.sessionId;
        const localJsonl = (0, node_path_1.join)(sourceProjectsDir, `${localSessionId}.jsonl`);
        const headUuid = readLastEntryUuid(localJsonl) ?? s.continuation?.fromEntryUuid ?? "";
        state.peers[peerId].sent[localSessionId] = {
            headEntryUuid: headUuid,
            messageCount: s.messageCount,
            sentAsType: s.type === "continuation" ? "continuation" : "full",
            sentAsSessionId: s.sessionId,
        };
    }
    (0, sync_state_js_1.writeSyncState)(state);
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
function loadEffectiveConfig(configDir, projectDir) {
    const userConfigDir = (0, node_path_1.join)((0, node_os_1.homedir)(), ".claude-sesh-mover");
    const projectConfigDir = (0, node_path_1.join)(projectDir, ".claude-sesh-mover");
    const userConfig = (0, config_js_1.readConfig)(userConfigDir);
    const projectConfig = (0, config_js_1.readConfig)(projectConfigDir);
    return (0, config_js_1.mergeConfigs)(userConfig, projectConfig);
}
function generateExportName(configDir, sessionId) {
    const date = new Date().toISOString().split("T")[0];
    if (sessionId) {
        const session = (0, discovery_js_1.discoverSessionById)(configDir, sessionId);
        if (session && session.slug) {
            return `${date}-${session.slug}`;
        }
    }
    return `${date}-export`;
}
function getClaudeVersion() {
    try {
        const version = (0, node_child_process_1.execFileSync)("claude", ["--version"], {
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