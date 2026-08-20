#!/usr/bin/env node
import { Command } from "commander";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveConfigDir } from "./platform.js";
import { readConfig, readConfigOverrides, writeConfigOverrides, setConfigOverride, computeEffectiveConfig, resolveHubBudgets, resolvePayloadBudgets, configValueKind, } from "./config.js";
import { exportSession, exportAllSessions, planExportPayload } from "./exporter.js";
import { importSession } from "./importer.js";
import { migrateSession } from "./migrator.js";
import { readManifest, assertSafeManifestIds, isBundleManifestShape, } from "./manifest.js";
import { loadOrCreateMachineId } from "./machine.js";
import { readSyncState, recordSentFromBundle, setLastAutoPush, writeSyncState, } from "./sync-state.js";
import { acquireProjectLock } from "./hub/lock.js";
import { hubIoAbandoned } from "./hub/io-timeout.js";
import { readLastEntryUuid } from "./jsonl.js";
import { createArchive, extractArchive, detectArchiveFormat, isZstdAvailable, ZstdNoContentChecksumError, readManifestFromArchive, } from "./archiver.js";
import { discoverSessionById } from "./discovery.js";
// Value import, deliberately separate from the type-only one below: the exit-code
// classification is runtime behavior that lives beside the result union it
// classifies, so a new result shape and its exit class are edited in one file.
import { EXIT_FAILED, exitCodeForResult } from "./types.js";
import { PLUGIN_VERSION } from "./version.js";
import { hubInit } from "./hub/init.js";
import { hubStatus } from "./hub/status.js";
import { readHookPayload, evaluateHookGate } from "./hub/hooks.js";
import { PROJECT_DIR_NAME, projectSeshMoverDir, userSeshMoverDir } from "./paths.js";
const program = new Command();
program
    .name("sesh-mover")
    .description("Export, import, and migrate Claude Code sessions")
    .version(PLUGIN_VERSION);
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
    // ---------------------------------------------------------------------
    // THE FILE PAYLOAD (#47). Two positive flags, both OFF by default, and both
    // facts are load-bearing rather than stylistic.
    //
    // OFF: this is a SECURITY PROPERTY RATHER THAN A UX PREFERENCE. `hub push`
    // builds its payload unless told not to, because linking a project is the
    // hub's consent gate and the bundle lands in a directory the user configured.
    // An export bundle has no gate and no known destination — `--output` names any
    // path, and the artifact gets scp'd, emailed or handed to someone. So the
    // opt-in IS the consent, and Commander's `--no-*` spelling is forbidden here:
    // it would default them to true, which is the exact inversion.
    //
    // TWO, not one `--include-files`: the payloads have different disclosure
    // profiles — the snapshot ignores `.gitignore` entirely, the carry filters the
    // untracked half and nothing in the patch — so consent to one is not consent
    // to the other. Same rule the import side's `--apply-workspace` /
    // `--apply-carry` follow, and the same rule #36 states.
    .option("--include-workspace", "Also capture a copy of the project's working tree (only for a project with NO git remote; does not read .gitignore)")
    .option("--include-carry", "Also capture uncommitted work as a git patch plus untracked files (only for a project WITH a git remote)")
    .option("--payload-plan", "Measure what --include-workspace / --include-carry would carry and report it, writing nothing. Exports no sessions.")
    .option("--progress", "Emit NDJSON progress events on stderr")
    .action(async (opts) => {
    try {
        const onProgress = opts.progress
            ? (ev) => process.stderr.write(JSON.stringify(ev) + "\n")
            : undefined;
        const configDir = resolveConfigDir(opts.sourceConfigDir);
        const config = loadEffectiveConfig(configDir, process.cwd());
        // `!!`, never `!== false`: absence has to coerce to "do not capture" at
        // EVERY wiring site (#36's ruling, applied to #47's payloads). A config
        // key may raise the default because that is a capture decision the user
        // makes about their own machine's outgoing bundles — the apply side is
        // where a config key would be wrong, and there is none there.
        const includeWorkspace = !!opts.includeWorkspace || config.export.includeWorkspace === true;
        const includeCarry = !!opts.includeCarry || config.export.includeCarry === true;
        const payloadBudgets = resolvePayloadBudgets(config, "export");
        if (opts.payloadPlan) {
            const plan = await planExportPayload({
                projectPath: opts.projectPath ?? process.cwd(),
                includeWorkspace,
                includeCarry,
                payloadBudgets,
            });
            plan.warnings.unshift(...payloadBudgets.warnings);
            output(plan);
            return;
        }
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
                    hasWorkspace: false,
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
        const result = await doExport({
            configDir,
            projectPath: opts.projectPath ?? process.cwd(),
            scope,
            sessionId: opts.sessionId,
            outputDir,
            name: finalName,
            excludeLayers,
            claudeVersion,
            noSummary,
            incremental,
            includeWorkspace,
            includeCarry,
            payloadBudgets,
            onProgress,
        });
        if (result.success && (includeWorkspace || includeCarry)) {
            result.warnings.unshift(...payloadBudgets.warnings);
        }
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
    .option("--include-plans", "Also write the bundle's plans/ into <config-dir>/plans, which every project on this machine shares (off by default)")
    // The two shared-namespace layers, and their DEFAULTS ARE OPPOSITE ON PURPOSE
    // (#36). `plans/` is opt-in because `<config-dir>/plans` is machine-global;
    // `memory/` is opt-out because it lands in the target project's own
    // directory, is add-only, and parks a conflict instead of overwriting it —
    // and because it is the layer a future session reads prose out of, so making
    // it opt-in would silently break the single-owner "my memories came with"
    // flow. Both are DISCLOSED either way, in `memorySkipped`/`plansSkipped` and
    // in the dry run's `writeSet`.
    .option("--no-memory", "Do not write the bundle's memory/ into this project's memory folder (written by default — it lands in the target project's own directory)")
    // ---------------------------------------------------------------------
    // THE FILE PAYLOAD, RECEIVE SIDE (#47). Both plain positive flags, both OFF,
    // and neither has a `--no-*` form — that spelling would make Commander default
    // them to true, which is the exact inversion of the property below.
    //
    // A SECURITY PROPERTY RATHER THAN A UX PREFERENCE, and more so here than
    // anywhere else in this CLI. Every payload a machine applied before #47 was
    // produced by that user's own other machine and travelled through a directory
    // that user configured. An export bundle can come from anyone, so this is the
    // first place sesh-mover can write arbitrary project files on the say-so of a
    // stranger — and #36's ruling is that the flag IS the consent and is the whole
    // of it: no path filter stands behind it and none ever will, because "names
    // that subvert sesh-mover" is a finite set this plugin defines while "names
    // that lead to code execution" is a property of this machine's toolchain.
    //
    // PER PAYLOAD, never an umbrella `--apply-files`: one consent decision cannot
    // cover two payloads with different blast radii. The workspace unpack writes a
    // whole tree and, with --force-workspace, overwrites files of the same name;
    // the carry only ever applies to a clean tree at the exact recorded commit.
    //
    // And never "the bundle carried one, so it was applied" — a payload's presence
    // is not a request to write it.
    .option("--apply-workspace", "Unpack the bundle's workspace/ into the target project directory (refused if it is not empty, unless --force-workspace)")
    .option("--apply-carry", "Apply the bundle's carried uncommitted changes (requires the same base commit and a clean tree)")
    .option("--force-workspace", "Unpack the workspace payload over a target that already has content, OVERWRITING any file of the same name (it does not combine the two)")
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
            includePlans: !!opts.includePlans,
            // Commander's `--no-memory` sets `opts.memory` to false; absent, it is
            // `true`. Same shape as `--no-register` two lines up.
            noMemory: opts.memory === false,
            // Present at all only because THIS is `sesh-mover import` — `hub pull`
            // and `migrate` call `importSession` without it and get no file-payload
            // handling whatsoever (see `ImportOptions.filePayload`).
            //
            // `!!`, never `!== false`. See the flag declarations above: absence has
            // to coerce to "do not apply" at every wiring site, and `importSession`
            // coerces again with `=== true` for the same reason.
            filePayload: {
                applyWorkspace: !!opts.applyWorkspace,
                applyCarry: !!opts.applyCarry,
                forceWorkspace: !!opts.forceWorkspace,
            },
            onProgress,
        });
        // Container-level observations belong in the same warnings array as the
        // bundle-level ones: the user asked one question ("import this") and
        // should get one answer. Prepended because they describe something that
        // happened before the import did.
        //
        // These now reach a FAILED import too. The older rule was "an ErrorResult
        // carries no `warnings`, and its `error` is the more important message —
        // the extraction note would only bury it", which conflated prominence
        // with disclosure: `error` is still the headline, and a note in its own
        // field buries nothing. Dropping it was the worse outcome, because an
        // extraction observation (a zstd frame with no checksum, say) describes
        // something that really happened to the user's bytes and is *more*
        // relevant when the import then fails, not less.
        if (extractWarnings.length > 0) {
            result.warnings = [...extractWarnings, ...(result.warnings ?? [])];
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
/**
 * The one shape a READABLE bundle turns into — archive or directory, one
 * builder, so the two paths cannot drift into reporting different field sets
 * for the same fact.
 *
 * The payload answers come out of the manifest this function was already
 * handed, and that bound is deliberate: `browse` is IO-bound in total archive
 * size when `.tar.zst` bundles are present (reading one decompresses the whole
 * bundle), and a field that needed a second look inside the archive would
 * multiply exactly the cost #32 was about. Everything reported here is a field
 * of a manifest already in memory.
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
        // The SAME two tests the importer runs against the same manifest —
        // `declaresWorkspace: manifest.workspace !== undefined` and
        // `if (opts.declaredCarry)` in `importer.ts` — including the fact that they
        // are spelled differently there. What this row promises is "here is what an
        // import of this bundle will find", so a tidier second opinion would be a
        // listing that disagrees with the command it is advising about.
        hasWorkspace: manifest.workspace !== undefined,
        hasCarry: !!manifest.carry,
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
        // NOT `false`. The manifest is what says whether a bundle carries files,
        // and it is the manifest that could not be read — so `false` here would be
        // this listing's most dangerous invention: "importing this cannot write to
        // your project", asserted about a bundle nobody checked.
        hasWorkspace: null,
        hasCarry: null,
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
        // readManifest is the existing chokepoint: it parses, runs the shape check
        // AND runs the session-id safety assertion, so surfaced ids stay path-safe
        // here too — and a manifest that is not one of ours never gets this far.
        manifest = readManifest(dir);
    }
    catch (e) {
        return { ok: false, detail: e.message };
    }
    // UNREACHABLE, AND IT STAYS. #77 folded `isBundleManifestShape` into
    // `readManifest` itself (manifest.ts step one of three), so a shapeless
    // manifest — the `sessions: "abc"` that used to survive every check and turn
    // into a fabricated `sessionCount: 3` — now throws above and leaves through
    // the `catch`. This branch can no longer be entered from here.
    //
    // Deleting it would be the wrong repair for two reasons. The predicate's
    // anti-duplication guard (#60, tests/manifest.test.ts "one home") asserts that
    // every file naming this shape IMPORTS it from manifest.ts rather than
    // carrying a private copy, and `cli.ts` is one of the files it checks — the
    // import is the thing being pinned, and dropping the only call site drops the
    // import with it. And the reachability is a property of `readManifest`'s
    // current internals, not of this contract: this function's job is to answer
    // "shape before content" for the directory half of `browse`, and the day that
    // chokepoint is narrowed again, the belt is already fastened. It costs one
    // predicate call per directory bundle.
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
// --- Retirement (#43): two verbs, deliberately ---
//
// `hub retire` writes an assertion this machine can withdraw; `hub delete`
// destroys every machine's copy of a project. They are separate commands rather
// than one command with a `--delete` flag because that is the difference the
// grace window exists to protect, and a flag puts the irreversible half one
// keystroke from the reversible one. See src/hub/retire.ts.
hub
    .command("retire")
    .description("Retire this project from the hub — refuses new pulls of it, deletes nothing")
    .option("--project-path <path>", "Override project path (default: cwd)")
    .option("--project-id <id>", "Retire a hub project by id (for a project this directory is not linked to)")
    .option("--reason <text>", "Free text recorded on the tombstone and shown to every machine")
    .option("--undo", "Withdraw this machine's retirement assertion")
    .option("--source-config-dir <path>", "Override Claude config dir")
    .action(async (opts) => {
    try {
        const configDir = resolveConfigDir(opts.sourceConfigDir);
        const projectPath = opts.projectPath ?? process.cwd();
        const config = loadEffectiveConfig(configDir, projectPath);
        const { resolveHubPath } = await import("./hub/init.js");
        const hubPath = resolveHubPath(config);
        if (!hubPath) {
            outputError("hub-retire", new Error("No hub configured. Run: sesh-mover hub init --path <dir>"));
            return;
        }
        const { hubRetire } = await import("./hub/retire.js");
        output(await hubRetire({
            projectPath, hubPath,
            projectIdOverride: opts.projectId,
            reason: opts.reason,
            undo: !!opts.undo,
        }));
    }
    catch (e) {
        outputError("hub-retire", e);
    }
});
hub
    .command("delete")
    .description("Permanently delete a RETIRED hub project's files — owner machine only, after the grace window")
    .option("--project-path <path>", "Override project path (default: cwd)")
    .option("--project-id <id>", "Delete a hub project by id (for a project this directory is not linked to)")
    .option("--source-config-dir <path>", "Override Claude config dir")
    .action(async (opts) => {
    try {
        const configDir = resolveConfigDir(opts.sourceConfigDir);
        const projectPath = opts.projectPath ?? process.cwd();
        const config = loadEffectiveConfig(configDir, projectPath);
        const { resolveHubPath } = await import("./hub/init.js");
        const hubPath = resolveHubPath(config);
        if (!hubPath) {
            outputError("hub-delete", new Error("No hub configured. Run: sesh-mover hub init --path <dir>"));
            return;
        }
        const { hubDelete } = await import("./hub/retire.js");
        output(await hubDelete({
            projectPath, hubPath,
            projectIdOverride: opts.projectId,
        }));
    }
    catch (e) {
        outputError("hub-delete", e);
    }
});
// --- Encryption at rest (#91) ---
//
// One verb, two modes: a bare `hub encrypt` REPORTS and writes nothing, and
// `--enable` flips the hub-wide switch. There is deliberately no `--disable`.
// Turning encryption off is a confidentiality-reducing act with no urgency
// attached to it — nothing breaks while it stays on, because the reader
// branches on each bundle's own suffix and a plaintext bundle stays readable
// forever — so the one-keystroke path exists only in the direction that fails
// safe. Hand-editing `encrypt` in hub.json is the deliberate friction for the
// other direction.
hub
    .command("encrypt")
    .description("Report this hub's encryption-at-rest setting, or turn it on for every machine")
    .option("--enable", "Seal this hub: every machine's later pushes must be encrypted bundles")
    .option("--scope <scope>", "Config scope to record the local hub.encrypt preference in: user or project", "user")
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
            outputError("hub-encrypt", new Error("No hub configured. Run: sesh-mover hub init --path <dir>"));
            return;
        }
        const { hubEncrypt } = await import("./hub/encrypt.js");
        output(await hubEncrypt({
            hubPath,
            enable: !!opts.enable,
            configScope: parseStorage(opts.scope),
            // The local preference as it stands now, so the result reports what
            // this machine actually has rather than echoing the hub's setting back.
            preference: config.hub.encrypt,
            // `projectPath`, NOT `process.cwd()`. The config this verb read came
            // from `loadEffectiveConfig(configDir, projectPath)`, so writing the
            // preference under the cwd instead would record it in a scope the next
            // command does not read back — silently, and only when both
            // `--project-path` and `--scope project` are given.
            cwd: projectPath,
        }));
    }
    catch (e) {
        outputError("hub-encrypt", e);
    }
});
// `hub rekey` re-addresses THIS machine's own encrypted bundles to the hub's
// current recipient set — the answer to "a machine joined and cannot read
// anything older than itself". No flags, deliberately: the recipient set is the
// hub's roster and there is nothing here to choose. In particular there is no
// --force-unkeyed, because an un-keyed peer is a disclosure rather than a
// refusal for an operation that can simply be run again (src/hub/rekey.ts).
hub
    .command("rekey")
    .description("Re-address this machine's own encrypted bundles on the hub to every machine registered now")
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
            outputError("hub-rekey", new Error("No hub configured. Run: sesh-mover hub init --path <dir>"));
            return;
        }
        const { hubRekey } = await import("./hub/rekey.js");
        output(await hubRekey({ projectPath, hubPath }));
    }
    catch (e) {
        outputError("hub-rekey", e);
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
            // The local preference, so the auto-push discloses an unapplied one in
            // its durable breadcrumb (`hub status`'s `lastAutoPush`) — which is the
            // ONLY channel this push has. `--force-unkeyed` deliberately has no
            // counterpart here: an unattended push may never be the thing that
            // permanently excludes a machine from a bundle.
            encryptPreference: config.hub.encrypt,
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
    finally {
        // THE endpoint #71 is about. It is spawned detached with `async: true`
        // and no `timeout`, so Claude Code cannot bound it and nothing else will
        // ever end it; if a hub syscall was abandoned, this is the last chance
        // the process gets to stop existing. Nothing is written to stdout here
        // (the contract above), so there is nothing to flush first.
        leaveEvenIfHubIoWedged();
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
    finally {
        // Safe after the write above rather than in place of it:
        // `leaveEvenIfHubIoWedged` orders its signal behind a flush barrier, so
        // the hook JSON still reaches Claude Code whole.
        //
        // In practice this endpoint is bounded by Claude Code (`timeout: 10`)
        // well before HUB_IO_TIMEOUT_MS could fire, so the escalation is a
        // backstop here rather than the main event — but the endpoint must not be
        // the one place a wedged process can still survive.
        leaveEvenIfHubIoWedged();
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
    .option("--full", "Re-send every session in scope WHOLE — forget what the hub is recorded as already holding (recovery for a hub that can no longer serve it)")
    .option("--force-unkeyed", "On an encrypted hub, upload even though registered machines publish no key — they can never read this bundle")
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
            noCarry: opts.carry === false || !config.hub.carryDiff,
            // Flag-only, with NO config key beside it — deliberately unlike the two
            // above. A config key would arm the default-on, unattended SessionEnd
            // auto-push to re-upload every session in the project at every session
            // end, with no channel to disclose that it did. `--full` is a recovery
            // action a human takes once, watching it.
            full: !!opts.full,
            // Flag-only for the identical reason, and one step further: this one
            // permanently excludes a named machine from a bundle nothing will ever
            // re-wrap, so a config key would let the unattended auto-push do that
            // at every session end. It also cannot override the case where THIS
            // machine is the un-keyed one — see `planBundleEncryption`.
            forceUnkeyed: !!opts.forceUnkeyed,
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
            // The local PREFERENCE, never the switch: the hub's own `encrypt` field
            // is what a push obeys. Passed only so a push can disclose the one case
            // the hub cannot — this machine wants encryption and the hub does not
            // require it — which is a machine-local fact by definition.
            encryptPreference: config.hub.encrypt,
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
    // OPT-IN, AND THAT IS A SECURITY PROPERTY RATHER THAN A UX PREFERENCE (#36).
    //
    // The carry payload is arbitrary project-file content: a `git apply` of a
    // patch plus a copy of untracked files. Nothing on the apply path filters it
    // by name or by extension, and nothing ever will — the recorded rule is that
    // the `NEVER_INCLUDABLE` floor is about what a name can DO (redirect the hub,
    // rewrite what the next push ships, overwrite a VCS store), not what it
    // contains, and it can be complete only because plugin-subverting names are a
    // finite set this plugin defines. "Leads to code execution" is a property of
    // the receiver's toolchain and can never close, so a denylist of
    // executable-adjacent paths is not a boundary and must not be added here.
    //
    // The flag IS the consent, and it is the whole of the consent. So:
    //   - it stays a bare boolean whose ABSENCE means "do not apply", coerced at
    //     BOTH wiring sites — the action below and hub/pull.ts's `applyRequested`.
    //     Never a negated `--no-` form, never a config key that turns it on,
    //     never "the bundle carried one, so it was applied". (Deliberately not
    //     quoting the two expressions here: `tests/apply-consent.test.ts` greps
    //     for them, and a comment that echoes the code it pins makes the grep
    //     pass over its own text — measured, while writing that test.)
    //   - #47's `--apply-workspace` on `sesh-mover import` does not exist yet and
    //     must land in exactly this shape, per payload, with no `--apply-files`
    //     that implies both. `tests/apply-consent.test.ts` pins both halves.
    .option("--apply-carry", "Apply carried uncommitted changes (requires the same base commit and a clean tree)")
    .option("--project-id <id>", "Link to an existing hub project id")
    .option("--force-append", "Append a pulled continuation even if the local session looks recently active")
    .option("--no-append", "Never append; import continuations as separate sessions")
    .option("--on-divergence <mode>", "When a thread was extended on both machines: fragment | adopt-hub | skip")
    .option("--ignore-retirement", "Pull even though the project has been retired on the hub (its bundles may be deleted soon)")
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
            ignoreRetirement: !!opts.ignoreRetirement,
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
async function doExport(options) {
    const { scope, ...rest } = options;
    return scope === "all" ? exportAllSessions(rest) : exportSession(rest);
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
            // `error` FIRST, then the `reason` discriminator, and only then the whole
            // object.
            //
            // The middle arm is not defensive padding: `HubUnreachableResult` (#75)
            // has no `error` field at all — `reason` + `hubState` + `suggestion` and
            // nothing else — and an unreachable hub is the single likeliest way for an
            // unattended session-end push to fail. Before that shape existed every
            // failure reaching here carried `error`, so the `JSON.stringify` fallback
            // was unreachable in practice; now it was the ordinary path, and it wrote
            // a wall of escaped JSON into a note a human reads out of `hub status`'s
            // `lastAutoPush`. The `suggestion` appended below already carries the
            // diagnosis, so the prefix only has to name WHICH refusal it was.
            //
            // `lock-busy` is the other `error`-optional shape but never arrives here:
            // the SessionEnd endpoint filters it out before calling this, because that
            // push did nothing. The `JSON.stringify` fallback stays as the last resort
            // for a future `success: false` with neither field.
            const reason = typeof r.reason === "string" ? r.reason : null;
            const error = typeof r.error === "string"
                ? r.error
                : reason !== null
                    ? `The push was refused (${reason}${typeof r.hubState === "string" ? `: ${r.hubState}` : ""}).`
                    : JSON.stringify(result);
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
// --- Output chokepoints ---
//
// EXACTLY TWO of them, and the difference between them is the stated rule
// rather than an accident of which one a call site reached (#76):
//
//   output(result)          — the command produced a RESULT. The result's own
//                             shape picks the exit code, via the single
//                             `exitCodeForResult` mapping in src/types.ts.
//   outputError(cmd, error) — the command THREW. Always class 1.
//
// There is no third convention and there must not be one: the defect #76 fixes
// is precisely that `output()` returned (exit 0) while `outputError()` exited 1,
// so `success: false` did not imply a non-zero exit and a shell caller's
// `sesh-mover hub pull || handle_failure` was a no-op for every refusal. The
// former `outputRefusal`/`outputHubResult` pair — which hand-picked exit 1 for
// `no-such-project` alone — is gone into `exitCodeForResult`, where a new result
// type cannot silently default to the wrong class.
//
// Both set `process.exitCode` rather than calling `process.exit()`, and that is
// not cosmetic. `process.exit()` terminates synchronously: it can truncate a
// large JSON body still queued on a piped stdout (a `pull` result with many
// warnings is not small), and it skips pending `finally` blocks — the `import`
// command's `finally` removes its archive extract dir, which a failing import
// therefore used to leak. Setting `exitCode` lets Node flush and unwind. Every
// call site either returns immediately or is the last statement of its `catch`,
// so nothing can overwrite the code afterwards.
//
// The hook endpoints call NEITHER helper. That is what keeps their "always exit
// 0" protocol requirement structurally out of reach of this scheme.
// The two are ordered, and the order is the contract: set the code first, then
// escalate. On every ordinary run the escalation is a no-op and the code is what
// the caller reads. On the wedged path the code becomes unreadable — a signal
// death has none — which is not a regression, because the alternative there is a
// process that never exits and therefore never has a code to read at all.
/**
 * LEAVE, FOR REAL — the other half of the #71 fix, and the one that decides
 * whether it stops the orphan accrual or merely renames it.
 *
 * Making the hub backend non-blocking is what lets a wedged push release its
 * project lock, clean up its staging directory and emit a typed refusal. It
 * does NOT let the process exit. The abandoned syscall is still running on a
 * libuv threadpool thread, that outstanding request keeps the loop ref'd, and
 * the exit path itself then blocks. Measured on Linux / Node 22.23.1, 3/3 runs
 * each, identical for the callback API (so it is the libuv request, not a
 * pending JS promise):
 *
 *   - letting the script end naturally  -> hangs until the filesystem answers
 *   - `process.exit(0)`                 -> hangs (the 'exit' event fires first)
 *   - `process.reallyExit(0)`           -> hangs
 *   - `process.kill(pid, SIGTERM/KILL)` -> exits immediately
 *
 * A signal is therefore the ONLY thing that ends such a process, and without
 * this the fix would trade "one lock-holding orphan per 10-minute staleness
 * window" for "one inert 50 MB orphan per session end" — which is not obviously
 * a smaller number.
 *
 * **It is called only at the process's exit boundary, and that placement is the
 * safety property.** A timer-based watchdog was rejected: a hub timeout can fire
 * in a place where the pull legitimately keeps going (a degraded workspace
 * merge), and a blind SIGKILL some seconds later could land in the middle of a
 * transcript splice or a `git apply` into the user's tree. Here there is
 * provably no work left — the result has already been written.
 *
 * **The exit code changes in this one case, from "none at all" to a signal
 * death**, and that is an improvement rather than a contract break: the
 * alternative on this path is a process that never exits and therefore never
 * has an exit code to read. It fires only when `hubIoAbandoned()` is true, so
 * every ordinary run — including every ordinary FAILURE — keeps its existing 0
 * or 1 exactly. It deliberately does not try to be the "environment not ready"
 * code: there is no code to give when the runtime will not let us return one.
 *
 * **Returns true when it has taken over the exit**, so a caller with its own
 * `process.exit` can stand down — that call is itself one of the ones measured
 * to hang.
 *
 * SIGKILL drops whatever is still buffered in the stdio pipes, and on this path
 * stderr usually holds the only diagnostic explaining the wedge, so the signal
 * is ordered behind a flush barrier: a trailing zero-length write's callback
 * runs after every earlier write's, because Writable fires them in write order.
 * The timer is a backstop for a pipe whose reader is already gone and which may
 * therefore never call back — the alternative there is the indefinite hang this
 * function exists to end.
 *
 * **Where that barrier's proof lives, stated because the test suite is NOT it.**
 * Measured with stdout on a pipe, killing with and without the barrier: 600 B
 * arrives whole either way, 200 KB arrives whole only with it (65,536 B without
 * — exactly one pipe buffer), 2 MB likewise (81,920 B without). Redirected to a
 * FILE it always arrives whole, because Node writes those synchronously. So the
 * barrier bites only above the pipe buffer, and every result a wedged run can
 * currently produce is a refusal of a few hundred bytes — which is why
 * `tests/hub-lock-orphan.test.ts` still passes with the barrier removed and says
 * so. It is kept because `output()` is shared with results that are not bounded
 * that way (a pull's warnings and disclosures), and losing one to a truncation
 * that only appears on big payloads is the kind of thing found in production.
 */
function leaveEvenIfHubIoWedged() {
    if (!hubIoAbandoned())
        return false;
    const kill = () => {
        process.kill(process.pid, "SIGKILL");
    };
    let pending = 2;
    const drained = () => {
        if (--pending === 0)
            kill();
    };
    try {
        process.stdout.write("", drained);
        process.stderr.write("", drained);
    }
    catch {
        kill();
        return true;
    }
    setTimeout(kill, 250).unref();
    return true;
}
function output(result) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = exitCodeForResult(result);
    // A no-op on every ordinary run, wedged or not — see the doc above.
    leaveEvenIfHubIoWedged();
}
/**
 * Emit an `ErrorResult` for something that THREW (or for an argument the
 * command validated itself) and take the failure code.
 *
 * Class 1 is set here explicitly rather than derived, because the shape cannot
 * carry the distinction: an untyped `ErrorResult` RETURNED as a value is a
 * refusal the code got far enough to describe ("already up to date with the
 * source machine"), while the same shape built here stands for an exception it
 * did not. See `exitCodeForResult` for the full rule.
 */
function outputError(command, error) {
    const result = {
        success: false,
        command,
        error: error.message,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = EXIT_FAILED;
    // The two changes that met here are complementary, and one removed a hazard
    // the other had to work around. #71's version wrote `if
    // (leaveEvenIfHubIoWedged()) return; process.exit(1);` — the guard was
    // load-bearing, because `process.exit()` is itself one of the calls MEASURED
    // to hang while a hub syscall is outstanding, so on the wedged path it would
    // have hung on precisely the line explaining why the hub is unusable. #76
    // replaced `process.exit()` with `process.exitCode` for an unrelated reason
    // (it truncates a large piped result and skips pending `finally` blocks —
    // `import` was leaking its extract dir), and setting a field cannot hang. So
    // the guard is no longer needed to protect the exit, and the escalation runs
    // unconditionally as the last statement instead.
    leaveEvenIfHubIoWedged();
}
program.parse();
//# sourceMappingURL=cli.js.map