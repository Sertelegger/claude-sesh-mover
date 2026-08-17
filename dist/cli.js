#!/usr/bin/env node
import { Command } from "commander";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveConfigDir } from "./platform.js";
import { readConfig, readConfigOverrides, writeConfigOverrides, setConfigOverride, computeEffectiveConfig, resolveHubBudgets, configValueKind, } from "./config.js";
import { exportSession, exportAllSessions } from "./exporter.js";
import { importSession } from "./importer.js";
import { migrateSession } from "./migrator.js";
import { readManifest, assertSafeManifestIds, isBundleManifestShape, } from "./manifest.js";
import { loadOrCreateMachineId } from "./machine.js";
import { readSyncState, recordSentFromBundle, setLastAutoPush, writeSyncState, } from "./sync-state.js";
import { acquireProjectLock } from "./hub/lock.js";
import { readLastEntryUuid } from "./jsonl.js";
import { createArchive, extractArchive, detectArchiveFormat, isZstdAvailable, ZstdNoContentChecksumError, readManifestFromArchive, } from "./archiver.js";
import { discoverSessionById } from "./discovery.js";
import { hubInit } from "./hub/init.js";
import { hubStatus } from "./hub/status.js";
import { readHookPayload, evaluateHookGate } from "./hub/hooks.js";
import { PROJECT_DIR_NAME, projectSeshMoverDir, userSeshMoverDir } from "./paths.js";
const program = new Command();
program
    .name("sesh-mover")
    .description("Export, import, and migrate Claude Code sessions")
    .version("0.8.0");
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
            outputDir = projectSeshMoverDir(process.cwd());
        }
        else {
            outputDir = userSeshMoverDir();
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
        const extractWarnings = [];
        const archiveFormat = detectArchiveFormat(fromPath);
        if (archiveFormat) {
            onProgress?.({ phase: "extract", percent: 0 });
            tempExtractDir = mkdtempSync(join(tmpdir(), "sesh-mover-extract-"));
            await extractArchive(fromPath, tempExtractDir, extractWarnings);
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
        // Container-level observations belong in the same warnings array as the
        // bundle-level ones: the user asked one question ("import this") and
        // should get one answer. Prepended because they describe something that
        // happened before the import did. An ErrorResult carries no `warnings`,
        // and its `error` is the more important message — the extraction note
        // would only bury it.
        if (extractWarnings.length > 0 && "warnings" in result) {
            result.warnings = [...extractWarnings, ...result.warnings];
        }
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
/**
 * The one shape a READABLE bundle turns into — archive or directory, one
 * builder, so the two paths cannot drift into reporting different field sets
 * for the same fact.
 */
function readableBrowseEntry(name, path, storage, manifest) {
    return {
        name,
        path,
        exportedAt: manifest.exportedAt,
        sourcePlatform: manifest.sourcePlatform,
        sourceProjectPath: manifest.sourceProjectPath,
        sessionCount: manifest.sessions.length,
        sessions: manifest.sessions,
        storage,
        metadataAvailable: true,
    };
}
/**
 * The one shape an UNREADABLE bundle turns into: `null` everywhere a value
 * would otherwise be invented (the browsing machine's platform, "", 0), plus
 * the reason. Archives and directory exports both build their degraded row
 * here, so the skill layer's single `metadataAvailable: false` branch (see
 * `commands/browse.md`) handles either without knowing which it got.
 */
function degradedBrowseEntry(name, path, storage, detail) {
    return {
        name,
        path,
        exportedAt: null,
        sourcePlatform: null,
        sourceProjectPath: null,
        sessionCount: null,
        sessions: [],
        storage,
        metadataAvailable: false,
        metadataError: detail,
    };
}
/**
 * One archive -> one browse entry. Reads real metadata when possible and says
 * so plainly when not; never reports the local platform for a foreign archive.
 */
async function archiveBrowseEntry(archivePath, name, storage) {
    const r = await readManifestFromArchive(archivePath);
    return r.ok
        ? readableBrowseEntry(name, archivePath, storage, r.manifest)
        : degradedBrowseEntry(name, archivePath, storage, r.detail);
}
/**
 * Read `<dir>/manifest.json` without throwing, mirroring
 * `readManifestFromArchive`'s result contract so both halves of `browse` work
 * from the same kind of value.
 *
 * It deliberately does NOT decide what a failure means: the store scan and the
 * cwd scan disagree about that, and keeping the decision at the two call sites
 * is what keeps the disagreement visible (see `storeDirectoryBrowseEntry` and
 * `cwdDirectoryBrowseEntry`, whose return types differ for exactly this reason).
 */
function readDirectoryManifest(dir) {
    let manifest;
    try {
        // readManifest is the existing chokepoint: it parses AND runs the
        // session-id safety assertion, so surfaced ids stay path-safe here too.
        manifest = readManifest(dir);
    }
    catch (e) {
        return { ok: false, detail: e.message };
    }
    // Shape before content, using the SAME predicate the archive path applies
    // (manifest.ts) — a `sessions` that is not an array is what turns a listing
    // into a fabricated `sessionCount`, and readManifest above does not see it.
    if (!isBundleManifestShape(manifest)) {
        return {
            ok: false,
            detail: 'manifest.json is not a sesh-mover bundle manifest (needs plugin "sesh-mover" and a sessions array)',
        };
    }
    return { ok: true, manifest };
}
/**
 * One STORE directory (`~/.sesh-mover/<name>` or `<cwd>/.sesh-mover/<name>`)
 * -> one browse entry, ALWAYS. The non-nullable return type is the point: a
 * store directory that has a `manifest.json` can never be dropped from the
 * listing.
 *
 * Inside a store directory a `manifest.json` is OURS BY CONSTRUCTION, so one
 * that won't read is a broken export, not a stranger. It degrades — same row
 * shape an unreadable archive has produced since v0.5.1 — instead of vanishing
 * and leaving the user with nothing to look at (#33).
 */
function storeDirectoryBrowseEntry(dirPath, name, storage) {
    const r = readDirectoryManifest(dirPath);
    return r.ok
        ? readableBrowseEntry(name, dirPath, storage, r.manifest)
        : degradedBrowseEntry(name, dirPath, storage, r.detail);
}
/**
 * One CWD directory -> a browse entry, or `null` meaning "not one of ours, say
 * nothing". That nullable return is the entire difference from
 * `storeDirectoryBrowseEntry`, and it is load-bearing rather than incidental.
 *
 * A project root is full of directories that carry a `manifest.json` and have
 * nothing to do with sesh-mover (npm package dirs, build output, other tools'
 * bundles). Here, reading that file IS the "is this even a sesh-mover export?"
 * test — so a failed read is a NEGATIVE ANSWER to that question, not a broken
 * export. Degrading here would list every stranger in the user's project root
 * as a broken export, which is worse than the bug #33 fixes.
 *
 * If you have come here to make the two directory paths symmetric: this is the
 * one that stays as it is. `tests/cli.test.ts` guards it.
 */
function cwdDirectoryBrowseEntry(dirPath, name) {
    const r = readDirectoryManifest(dirPath);
    return r.ok ? readableBrowseEntry(name, dirPath, "project", r.manifest) : null;
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
async function runBounded(thunks) {
    const results = [];
    for (let i = 0; i < thunks.length; i += ARCHIVE_READ_CONCURRENCY) {
        const batch = thunks.slice(i, i + ARCHIVE_READ_CONCURRENCY);
        results.push(...(await Promise.all(batch.map((run) => run()))));
    }
    return results;
}
/** Sort key for browse entries: missing/unparseable timestamps become the epoch. */
function exportedAtMillis(exportedAt) {
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
        const exports = [];
        const searchDirs = [];
        if (opts.storage === "user" || opts.storage === "all") {
            const userDir = userSeshMoverDir();
            if (existsSync(userDir)) {
                searchDirs.push({ dir: userDir, storage: "user" });
            }
        }
        if (opts.storage === "project" || opts.storage === "all") {
            const projectDir = projectSeshMoverDir(process.cwd());
            if (existsSync(projectDir)) {
                searchDirs.push({ dir: projectDir, storage: "project" });
            }
        }
        for (const { dir, storage } of searchDirs) {
            const entries = readdirSync(dir);
            for (const entry of entries) {
                // The presence of a manifest.json is what makes a directory an
                // export CLAIM. No manifest.json at all (a plain subdirectory, or
                // this dir's own config.json / locks/ / sync-state/) is not an
                // export and is not listed; a manifest.json that won't read is a
                // broken export and IS listed, degraded.
                const manifestPath = join(dir, entry, "manifest.json");
                if (existsSync(manifestPath)) {
                    exports.push(storeDirectoryBrowseEntry(join(dir, entry), entry, storage));
                }
            }
        }
        // Also look for archives in the search dirs. Each archive's manifest is
        // read out of the archive itself, so a bundle carried over from another
        // machine reports ITS origin, not this one's. The reads are queued as
        // thunks and run in bounded batches: concurrent enough that a directory
        // of bundles doesn't serialize, bounded so it can't exhaust file
        // descriptors and fail the listing outright.
        const archiveReads = [];
        for (const { dir, storage } of searchDirs) {
            const entries = readdirSync(dir);
            for (const entry of entries) {
                if (entry.endsWith(".tar.gz") || entry.endsWith(".tar.zst")) {
                    const archivePath = join(dir, entry);
                    archiveReads.push(() => archiveBrowseEntry(archivePath, entry, storage));
                }
            }
        }
        // Also scan cwd for export bundles and archives that aren't inside .sesh-mover/
        // This catches exports dropped directly in the project root (e.g., received via file transfer)
        if (opts.storage === "project" || opts.storage === "all") {
            const cwd = process.cwd();
            const cwdEntries = readdirSync(cwd);
            for (const entry of cwdEntries) {
                if (entry === PROJECT_DIR_NAME)
                    continue; // already scanned above
                const entryPath = join(cwd, entry);
                // Check for export directories with manifest.json. Unlike the store
                // scan above, an unreadable or non-sesh-mover manifest here is
                // silently skipped, never degraded — see cwdDirectoryBrowseEntry.
                const manifestPath = join(entryPath, "manifest.json");
                if (existsSync(manifestPath)) {
                    const cwdEntry = cwdDirectoryBrowseEntry(entryPath, entry);
                    if (cwdEntry !== null)
                        exports.push(cwdEntry);
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
        const result = {
            success: true,
            command: "browse",
            // Null-safe: entries whose metadata couldn't be read carry a null
            // exportedAt. `new Date(null ?? 0)` is the epoch, and an unparseable
            // string is coerced to the epoch too, so those sort last (newest
            // first) instead of poisoning the comparator with NaN.
            exports: exports.sort((a, b) => exportedAtMillis(b.exportedAt) - exportedAtMillis(a.exportedAt)),
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
    .option("--reset", "Clear this scope's config file (the other scope is untouched)")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
    try {
        const configDir = opts.scope === "project"
            ? projectSeshMoverDir(process.cwd())
            : userSeshMoverDir();
        if (opts.reset) {
            // Clear this scope's overrides rather than writing a snapshot of every
            // default: a defaults-filled file is indistinguishable from one whose
            // author meant those values, so `--reset --scope project` used to pin
            // every default over the user scope (`hub.path: ""` included). The
            // reported config is the EFFECTIVE one, which for a project-scope reset
            // is the user's settings — that is what now applies here.
            writeConfigOverrides(configDir, {});
            const result = {
                success: true,
                command: "configure",
                config: loadEffectiveConfig(resolveConfigDir(), process.cwd()),
                scope: opts.scope,
                message: `Cleared all ${opts.scope}-scope settings; the effective config below is what applies now.`,
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
                    // Effective, like the other --set branches: machine.name lives in
                    // machine-id.json rather than config.json, so this scope's file has
                    // nothing to say about it either way.
                    config: loadEffectiveConfig(resolveConfigDir(), process.cwd()),
                    scope: opts.scope,
                    message: `Set machine.name = ${identity.name}`,
                };
                output(result);
                return;
            }
            // Read/write this scope's OVERRIDES, never a defaults-backfilled
            // config: writing the latter into the project scope pins every default
            // over the user scope, which silently unconfigured the hub for that
            // project (`hub.path: ""` beats a user-scope hub.path). Same defect
            // class as the read side that computeEffectiveConfig exists to fix.
            let overrides = readConfigOverrides(configDir);
            // Parse value
            let parsedValue = value;
            if (configValueKind(key) === "number") {
                // Refused at write time rather than coerced or stored as a string.
                // A numeric key holding `"100"` reads back as "not a size" on every
                // push afterwards, and the user has no way to tell that from the
                // setting working — see `configValueKind`.
                const n = Number(value);
                if (value.trim() === "" || !Number.isFinite(n)) {
                    outputError("configure", new Error(`${key} expects a number (megabytes); got "${value}"`));
                    return;
                }
                parsedValue = n;
            }
            else if (value === "true")
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
            overrides = setConfigOverride(overrides, key, parsedValue);
            writeConfigOverrides(configDir, overrides);
            const result = {
                success: true,
                command: "configure",
                // The EFFECTIVE config after the write, not this scope's file: with
                // only the overrides on disk, that file no longer describes what
                // applies, and what applies is the useful answer (it also shows a
                // user-scope --set that a project-scope file still overrides).
                config: loadEffectiveConfig(resolveConfigDir(), process.cwd()),
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
    .action(async () => {
    try {
        output(await hubStatus({ cwd: process.cwd() }));
    }
    catch (e) {
        outputError("hub-status", e);
    }
});
hub
    .command("unlink")
    .description("Remove this project's hub link — disarms the session-end auto-push for this directory")
    .option("--project-path <path>", "Override project path (default: cwd)")
    .option("--force", "Skip the project lock")
    .action(async (opts) => {
    try {
        // NO hub lookup and no config dir, deliberately — unlink is the DISARM
        // path for a default-on automation, so it must not depend on the thing
        // being disarmed. A user whose share is unmounted (or who has already
        // cleared `hub.path`) would otherwise be told "No hub configured" by the
        // one command that could turn the automation off. See src/hub/unlink.ts.
        const { hubUnlink } = await import("./hub/unlink.js");
        output(hubUnlink({
            projectPath: opts.projectPath ?? process.cwd(),
            force: !!opts.force,
        }));
    }
    catch (e) {
        outputError("hub-unlink", e);
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
    }
    catch (e) {
        outputError("hub-reindex", e);
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
    process.stderr.on("error", () => { });
    try {
        const payload = readHookPayload(await readStdin());
        const gate = evaluateHookGate(payload, "autoPush");
        if (!gate.ok)
            return; // no hub / unlinked / disabled / no cwd — silent no-op
        const projectPath = gate.projectPath;
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
            hubPath: gate.hubPath,
            noWorkspace: config.hub.noWorkspace,
            noCarry: !config.hub.carryDiff,
            // ...and `export.noSummary`, for the same reason and out of the same
            // effective config: a bundle manifest's summary is conversation text
            // unless this is set, and THIS is the push that uploads it unattended
            // with no channel to say what it sent.
            noSummary: config.export.noSummary,
            budgets: resolveHubBudgets(config),
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
        const lockBusy = "reason" in result && result.reason === "lock-busy";
        if (!result.success && !lockBusy) {
            writeHookDiagnostic(`sesh-mover auto-push: ${JSON.stringify(result)}\n`);
        }
        // ...and a durable copy, because that stderr line is invisible at a clean
        // exit. This push computes real disclosures — which gitignored-but-TRACKED
        // files its patch carried off the machine, which include-list paths it
        // re-included — and then discards every one of them. `hub status` reads
        // this back. Never for lock-busy: that push did nothing.
        if (!lockBusy) {
            recordAutoPushOutcome(projectPath, result);
        }
    }
    catch (e) {
        writeHookDiagnostic(`sesh-mover auto-push failed: ${e.message}\n`);
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
    process.stderr.on("error", () => { });
    process.stdout.on("error", () => { });
    try {
        const payload = readHookPayload(await readStdin());
        const gate = evaluateHookGate(payload, "startupNotice");
        if (!gate.ok)
            return; // no hub / unlinked / disabled / no cwd — silent no-op
        const { hubWhereis } = await import("./hub/whereis.js");
        const result = await hubWhereis({
            configDir: resolveConfigDir(),
            projectPath: gate.projectPath,
            hubPath: gate.hubPath,
        });
        if (!result.success || !result.linked)
            return;
        // Newest first, so the one thread we name is the one most likely to be
        // what the user came back for. resolveThreads' ordering is deterministic
        // but is not recency ordering, so sorting here is not redundant.
        const stale = result.threads
            .filter((t) => t.pullNeeded)
            .sort((a, b) => parseTime(b.latest.lastActiveAt) - parseTime(a.latest.lastActiveAt));
        if (stale.length === 0)
            return;
        const top = stale[0];
        // Every field below comes out of another machine's index file, so each
        // one is sanitized and each one has a fallback: a torn or old-format
        // entry missing `slug` would otherwise render the literal string
        // "undefined" as the name of the thread the user is being told to pull.
        const what = noticeField(top.slug) || noticeField(top.threadId) || "a session";
        const where = noticeField(top.latest.machineName) ||
            noticeField(top.latest.machineId) ||
            "another machine";
        const rest = stale.length > 1 ? ` (+${stale.length - 1} more)` : "";
        const context = `sesh-mover: newer work for this project exists on another machine — ` +
            `"${what}" on ${where}, ${describeAge(top.latest.lastActiveAt)}${rest}. ` +
            `Run /sesh-mover:pull to bring it here.`;
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
        }) + "\n");
    }
    catch (e) {
        writeHookDiagnostic(`sesh-mover startup notice failed: ${e.message}\n`);
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
    .option("--no-workspace", "Skip the workspace snapshot (taken for projects with no git remote, including a git repo that has none)")
    .option("--no-carry", "Do not carry uncommitted changes (taken for projects that have a git remote)")
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
        // Before hubPush, deliberately: this push would otherwise register this
        // machine on the hub, mint a thread and run a full export before it ever
        // read the id. See refuseUnknownProjectId.
        const badId = await refuseUnknownProjectId("push", hubPath, opts.projectId);
        if (badId) {
            outputRefusal(badId);
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
            noCarry: opts.carry === false || !config.hub.carryDiff,
            // Deliberately NO `--carry-max-mb` flag to override this. The decline
            // is not retryable on demand — the carry rides a bundle, so an
            // immediate re-push answers `upToDate` and a flag on the retry would be
            // inert in the one situation you would reach for it. And the push that
            // matters most is the unattended SessionEnd one, which takes no flags
            // at all. Config is the lever that actually works in both cases.
            budgets: resolveHubBudgets(config),
            // Config-only, deliberately — see HubPushOptions.noSummary for why
            // `push` grows no `--no-summary` flag to go with it.
            noSummary: config.export.noSummary,
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
    .option("--force-workspace", "Unpack the hub's workspace copy over a non-empty target directory, overwriting files of the same name (never a merge)")
    .option("--apply-carry", "Apply carried uncommitted changes (requires the same base commit and a clean tree)")
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
        const badId = await refuseUnknownProjectId("pull", hubPath, opts.projectId);
        if (badId) {
            outputRefusal(badId);
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
            applyCarry: !!opts.applyCarry,
            projectIdOverride: opts.projectId,
            forceAppend: !!opts.forceAppend,
            noAppend: opts.append === false || !config.hub.pullAppend,
            onDivergence,
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
        let ext = compression === "zstd" ? ".tar.zst" : ".tar.gz";
        let archivePath = bundleDir + ext;
        // Archive FIRST. If this throws, the staging dir is left intact and no
        // sent-state is recorded — a failed export must not advance peer heads
        // (those entries would never actually ship, and would be silently
        // skipped on the next incremental export as "already sent").
        onProgress?.({ phase: "archive", percent: 0 });
        try {
            await createArchive(bundleDir, archivePath, compression);
        }
        catch (e) {
            // A zstd build whose default leaves the frame checksum out would give the
            // user a container that cannot detect corruption, where the .tar.gz they
            // did not ask for can. Second-choice format beats first-choice format
            // with no error detection — the same trade the "zstd not found" fallback
            // above already makes, reported through the same two channels so the
            // skill layer needs no new branch.
            if (!(e instanceof ZstdNoContentChecksumError))
                throw e;
            result.warnings.push(`${e.message} — falling back to gzip, whose CRC32 does detect it.`);
            compression = "gzip";
            result.actualFormat = "archive";
            ext = ".tar.gz";
            archivePath = bundleDir + ext;
            await createArchive(bundleDir, archivePath, compression);
        }
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
            // The memory layer's "already has it" ledger — the whole-file counterpart
            // of `peerSent`, read from the same peer entry and written by the same
            // rule (only once a bundle actually reached the peer; see
            // `setPeerMemoryDigest`). Without it every `--incremental --to` bundle
            // re-shipped the whole `memory/` directory, which is safe but not minimal.
            //
            // `?? null` rather than omitted, because absent and null mean the same
            // thing to the exporter — nothing known, therefore ship — and spelling it
            // makes that the visible default for a peer this machine has never
            // delivered memory to.
            peerMemoryDigest: state.peers[match.id].memoryDigest ?? null,
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
    // NO `peerMemoryDigest` on the `--since` path, deliberately, and it is not the
    // one-liner it looks like (#59 item 1).
    //
    // `refManifest.memoryDigest` describes the memory directory THAT BUNDLE
    // carried. It says nothing about what the peer holds: a `--since` reference is
    // an artifact sitting on this machine, and nothing records that it was ever
    // delivered anywhere. That is precisely the rule `setPeerMemoryDigest` is
    // written to keep — credit the ledger only once the bundle has reached the peer
    // — and deriving a digest from a bundle whose delivery is unknown breaks it
    // from the reading side instead of the writing side.
    //
    // The `peerSent` map above IS derived from the same unverified reference, and
    // the asymmetry is on purpose: a session skipped in error still arrives, as a
    // continuation the receiver's append guard refuses and imports as its own
    // session, so the content lands either way. A memory skipped in error is
    // simply never sent and nobody is told. Ship the redundant copy.
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
/**
 * Validate `--project-id` against the hub BEFORE the verb runs (#29).
 *
 * Returns `null` when the flag was not passed or names a hub project that
 * exists; otherwise the typed refusal to emit instead of running the verb.
 *
 * Why here and not inside push/pull. Both funnel the flag into
 * `readHubProjectAsLocal`, which throws two different ways — `assertSafeHubId`
 * for a path-unsafe id, a raw `ENOENT` for a well-formed one the hub doesn't
 * have — and both escaped to the generic catch as an untyped `error` string
 * (the ENOENT one carrying the hub's absolute path). Worse on push: it decides
 * identity early but *resolves* it only after `registerMachine` (a hub write),
 * after minting a thread into local sync-state, and after a full incremental
 * export — so a typo'd id failed with residue on the hub and no typed result to
 * say so. A validation failure must not happen after side effects, and the CLI
 * boundary is the one point that is before all of them.
 *
 * This is a READ of `projects/<id>/project.json` and nothing else: it writes
 * nothing, links nothing, and does not weaken push's deferred-link consent gate
 * (that rationale is about the link WRITE, not about reading the project).
 */
async function refuseUnknownProjectId(command, hubPath, projectId) {
    if (!projectId)
        return null;
    const { createFsBackend } = await import("./hub/backend.js");
    const { HUB_JSON } = await import("./hub/layout.js");
    const { readHubProjectAsLocal, listHubProjects } = await import("./hub/identity.js");
    const backend = createFsBackend(hubPath);
    // An unreachable hub (unmounted share, a sync client mid-copy) makes EVERY
    // read fail, including this one — and answering "no such project" there would
    // be a confident wrong diagnosis, sending the user to fix an id that is
    // fine. Say nothing and let the verb report the hub problem in its own words.
    if (!(await backend.exists(HUB_JSON)))
        return null;
    try {
        await readHubProjectAsLocal(backend, projectId);
        return null;
    }
    catch {
        // Deliberately one arm for both throw flavours: from the caller's side
        // "that id is not a project on this hub" is the same fact and the same
        // remedy, and reflecting WHICH failure it was would mean reflecting the
        // hub's absolute path (the ENOENT message) back out.
        let linkCandidates = [];
        try {
            linkCandidates = (await listHubProjects(backend)).map((p) => ({
                projectId: p.projectId,
                name: p.name,
                gitRemotes: p.matchers.gitRemotes,
            }));
        }
        catch {
            // An unreadable/absent hub yields no pick list. The refusal still
            // stands — an empty array, never a missing field.
        }
        return {
            success: false,
            command,
            reason: "no-such-project",
            requestedProjectId: projectId,
            linkCandidates,
            suggestion: linkCandidates.length > 0
                ? `No hub project with that id. Pick one of the ${linkCandidates.length} project(s) in linkCandidates and pass its projectId to --project-id` +
                    (command === "push" ? ", or pass --create-project to mint a new one." : ".")
                : `No hub project with that id, and this hub lists no projects to pick from` +
                    (command === "push"
                        ? " — pass --create-project to mint one."
                        : " — push from the machine that has this project first."),
        };
    }
}
// Validates BOTH the flag and hub.onDivergence from config — a typo'd config
// value must fail loudly here rather than silently resolving to a mode the
// user didn't pick.
function parseOnDivergence(value) {
    if (value === "fragment" || value === "adopt-hub" || value === "skip")
        return value;
    throw new Error(`Invalid --on-divergence value: "${value}". Valid: fragment, adopt-hub, skip.`);
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
    const userConfigDir = userSeshMoverDir();
    const projectConfigDir = projectSeshMoverDir(projectDir);
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
// Timestamps in a hub index file are untrusted input (another machine wrote
// them, and the file can be torn). Date.parse returns NaN for anything it
// can't read, which would sort unpredictably and render as "NaN minutes ago",
// so unparseable timestamps sort last and describe as "recently".
function parseTime(iso) {
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
function describeAge(iso) {
    const then = parseTime(iso);
    if (then === 0)
        return "recently";
    const minutes = Math.max(0, Math.floor((Date.now() - then) / 60_000));
    if (minutes < 1)
        return "just now";
    if (minutes < 60)
        return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours} hour${hours === 1 ? "" : "s"} ago`;
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
function noticeField(value) {
    if (typeof value !== "string")
        return "";
    // \p{C} is Unicode's "other" category: C0/C1 controls, format characters
    // (including the bidi and zero-width overrides), surrogates and unassigned
    // code points — i.e. everything that can move or hide text rather than show
    // it. Nothing legible is in it, so replacing the whole category is both
    // safer and shorter than an escape range.
    const clean = value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
    if (clean.length <= NOTICE_FIELD_MAX)
        return clean;
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
function writeHookDiagnostic(message) {
    try {
        process.stderr.write(message);
    }
    catch {
        /* stderr is gone — stay silent rather than fail the hook */
    }
}
/**
 * Leave a durable trace of an auto-push in this project's sync-state.
 *
 * The SessionEnd push is the only push nobody reads: stdout is closed to it,
 * and Claude Code shows a clean-exit hook's stderr only in debug output. Two
 * things it computes are worth more than that — the carry disclosures (which
 * gitignored-but-TRACKED files the patch took off the machine, which
 * `.sesh-mover-include` paths were re-included) and the fact that it failed at all, which
 * an unmounted share otherwise hides indefinitely. `hub status` reads this back.
 *
 * Best effort in every direction, because a breadcrumb must never cost a push:
 * it takes the same project lock the push itself uses (sync-state is a
 * read-modify-write of a file `pull` also rewrites, and the push released the
 * lock before returning), and it gives up silently on a busy lock or any error.
 */
function recordAutoPushOutcome(projectPath, result) {
    try {
        const r = result;
        const notes = [];
        if (result.success) {
            const warnings = Array.isArray(r.warnings) ? r.warnings : [];
            notes.push(...warnings.filter((w) => typeof w === "string"));
        }
        else {
            const error = typeof r.error === "string" ? r.error : JSON.stringify(result);
            const suggestion = typeof r.suggestion === "string" ? ` ${r.suggestion}` : "";
            notes.push(`${error}${suggestion}`);
            // The link disclosure, carried across as its own note.
            //
            // This is the reason `HubPushFailedResult` puts the link state in FIELDS
            // rather than only in `details`: nothing here reads `details`, and this
            // function is the sole surviving trace of an unattended push. A push that
            // failed while leaving the project linked leaves the auto-push armed to
            // fail again tomorrow, which is exactly the thing a user needs told.
            if (typeof r.linked === "boolean") {
                notes.push(r.linked
                    ? `This project IS still linked to hub project ${String(r.projectId)}, so the session-end auto-push stays armed for it — run \`sesh-mover hub unlink\` here to turn it off.`
                    : `This project is NOT linked to the hub${r.linkRolledBack === true ? " (the link this push created was removed again)" : ""}, so the session-end auto-push is off for it until a push links it again.`);
            }
            if (typeof r.orphanHubProjectId === "string") {
                notes.push(`Hub project ${r.orphanHubProjectId} was created before the failure and nothing removes a hub project; a later push can pass --project-id ${r.orphanHubProjectId} to link to that one.`);
            }
            if (r.orphanBundle === true) {
                notes.push("A bundle reached the hub but this machine's index was not updated to reference it, so no other machine can see it yet; the next successful push republishes the index.");
            }
        }
        // Nothing to say and nothing already on record is the overwhelmingly common
        // case (a clean push of a project with no disclosures). Still recorded, so
        // "the last auto-push was fine" is distinguishable from "no auto-push has
        // ever run here" — both are answers a user asks `hub status` for.
        const lock = acquireProjectLock(projectPath);
        try {
            const state = readSyncState(projectPath);
            setLastAutoPush(state, { ok: result.success, notes });
            writeSyncState(state);
        }
        finally {
            lock.release();
        }
    }
    catch {
        /* lock busy, unreadable state, read-only home — the push already happened */
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
async function readStdin(timeoutMs = HOOK_STDIN_TIMEOUT_MS) {
    const stdin = process.stdin;
    if (stdin.isTTY)
        return "";
    const chunks = [];
    return new Promise((resolve) => {
        let settled = false;
        const onData = (chunk) => {
            chunks.push(chunk);
        };
        const finish = () => {
            if (settled)
                return;
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
function output(result) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
/**
 * Emit a TYPED refusal and exit non-zero.
 *
 * Two exit conventions already live side by side here and the difference is not
 * arbitrary: `output()` exits 0 even for a `success: false` body, which is right
 * for a refusal that is an ordinary state of the workflow (`unlinked`,
 * `lock-busy`, `not-yet-synced`, "already up to date" — the caller is meant to
 * read the shape and continue), while `outputError()` exits 1 for a bad
 * invocation. A `--project-id` naming no hub project is the second kind — the
 * same class as `--on-divergence bogus`, which has always exited 1 — so this
 * keeps that exit code while upgrading the BODY from a raw error string to a
 * shape with a `reason` and a pick list.
 */
function outputRefusal(result) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(1);
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