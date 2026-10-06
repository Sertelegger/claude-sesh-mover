import { rmSync, existsSync, readdirSync, mkdtempSync, renameSync, } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { discoverSessions } from "./discovery.js";
import { exportSession, exportAllSessions } from "./exporter.js";
import { importSession } from "./importer.js";
import { encodeProjectPath, physicalProjectPath } from "./platform.js";
import { errorMessage } from "./errors.js";
import { EXPORTED_SESSION_DIR_NAMES } from "./paths.js";
function isWithin(child, parent) {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
/**
 * A session folder, spelled so that two spellings of ONE directory compare
 * equal — the test behind "is this the folder the import will write".
 *
 * The config dir physically: the CLI resolves neither config dir, and a folder
 * under either spelling (a trailing separator, a symlink) is one place on disk.
 *
 * Case-folded on darwin and win32, and only there: on those platforms two
 * names differing only in letter case are one directory, so a target typed
 * `/Users/me/Proj` over a source `/Users/me/proj` writes into the folder the
 * source's sessions are in — while on Linux they are two directories and the
 * move is real. Keyed on the platform rather than probed on the volume: a
 * case-SENSITIVE macOS volume makes two distinct folders compare equal here,
 * which errs toward leaving a session in place (or refusing), never toward
 * re-minting or deleting one.
 */
function folderIdentity(configDir, encoded) {
    const folder = join(physicalProjectPath(configDir), "projects", encoded);
    return process.platform === "darwin" || process.platform === "win32"
        ? folder.toLowerCase()
        : folder;
}
/**
 * Single source of truth for the `--rename-dir` preconditions, shared by the
 * dry-run preview and the apply path.
 *
 * It exists because the two used to disagree: the preview hardcoded
 * `directoryRenamed: false` and emitted no rename warning, so a dry-run with
 * `--rename-dir` was byte-identical to one without it — and the model reading
 * that preview reported "the directory will not be renamed" immediately before
 * the real run `mv`-ed it. A preview that omits the most destructive step of
 * the plan is worse than no preview, so both paths now ask the same question
 * here and only the tense of the prose differs.
 *
 * Evaluating this at dry-run time is faithful: cleanup (step 3) only ever
 * deletes files under `<configDir>/projects/…`, never the project directories
 * themselves, so the existence checks the apply path makes after cleanup see
 * exactly what these see. It performs no filesystem mutation in either mode.
 */
function planDirectoryRename(renameDir, sourceProjectPath, targetProjectPath, mode) {
    if (!renameDir)
        return { rename: false };
    if (sourceProjectPath === targetProjectPath) {
        return {
            rename: false,
            // The apply path is silent here (nothing happens, nothing to undo); a
            // preview owes the user the reason its requested rename isn't in the plan.
            warning: mode === "dry-run"
                ? `DRY RUN: --rename-dir was requested, but the source and target project paths are identical (${sourceProjectPath}) — no directory would be renamed.`
                : undefined,
        };
    }
    if (!existsSync(sourceProjectPath)) {
        return {
            rename: false,
            warning: mode === "dry-run"
                ? `DRY RUN: source directory ${sourceProjectPath} does not exist — the rename would be skipped. It may have already been moved.`
                : `Source directory ${sourceProjectPath} does not exist — cannot rename. It may have already been moved.`,
        };
    }
    if (existsSync(targetProjectPath)) {
        return {
            rename: false,
            warning: mode === "dry-run"
                ? `DRY RUN: target directory ${targetProjectPath} already exists — the rename would be skipped to avoid overwriting. Move files manually if needed.`
                : `Target directory ${targetProjectPath} already exists — skipping rename to avoid overwriting. Move files manually if needed.`,
        };
    }
    return {
        rename: true,
        warning: mode === "dry-run"
            ? `DRY RUN: the project directory ${sourceProjectPath} would be renamed to ${targetProjectPath}.`
            : undefined,
    };
}
export async function migrateSession(options) {
    const { sourceConfigDir, targetConfigDir, sourceProjectPath, targetProjectPath, scope, sessionId, excludeLayers, claudeVersion, dryRun, renameDir, currentCwd, force, onProgress, } = options;
    const isSelfMigration = !!currentCwd && isWithin(currentCwd, sourceProjectPath);
    const selfMigrationWarnings = [];
    if (isSelfMigration) {
        selfMigrationWarnings.push(currentCwd === sourceProjectPath
            ? `Self-migration detected: current working directory matches source path (${sourceProjectPath}). If this is the running Claude Code session, its JSONL is being actively written — the migration takes a snapshot, but new messages after this run go to the deleted source file. Exit this session and re-run migrate from an outer directory for a clean handoff.`
            : `Self-migration detected: current working directory (${currentCwd}) is inside source path (${sourceProjectPath}). ${renameDir ? "It will cease to exist after --rename-dir is applied." : "The session and shell may misbehave after cleanup."} Consider running migrate from an outer directory.`);
    }
    // Block actual self-migration runs unless the caller explicitly forces.
    // Dry-run is allowed through so the user can still preview the plan.
    if (isSelfMigration && !dryRun && !force) {
        return {
            success: false,
            command: "migrate",
            error: `Refusing self-migration: current working directory (${currentCwd}) is inside the source project path (${sourceProjectPath}). This Claude Code session is actively writing to a JSONL in the source; after cleanup, Claude Code recreates it at the old path and the session is orphaned with a stale cwd.`,
            suggestion: "Exit this Claude Code session, `cd` to an outer directory (e.g. ~/ or the parent of the project), start a fresh Claude Code session there, then re-run /sesh-mover:migrate. Override (unsafe): pass --force only if you are certain the active session is NOT in the source path.",
        };
    }
    if (scope === "current" && !sessionId) {
        return {
            success: false,
            command: "migrate",
            error: "Migrate with --scope current requires --session-id: without it the previous behavior silently migrated and deleted ALL sessions for the project.",
            suggestion: "Pass --session-id <id> to move one session, or --scope all to intentionally move every session for this project.",
        };
    }
    // WHICH sessions move (#126, #149). Discovery reads up to two folders for
    // one source path — `encodeProjectPath(source)`, where Claude Code files it,
    // and `legacyEncodeProjectPath(source)`, where a pre-0.12.0 import misfiled
    // sessions for any path with a `.`, a `_` or a space — while the import
    // writes exactly one: `encodeProjectPath(target)` in the target config dir.
    //
    // A session found IN that write folder is already where the import would
    // put it, so it stays, under its own id. Moving it would not be a no-op: the
    // import mints a new id for every session and cleanup deletes the original,
    // so `claude --resume <oldId>` and the hub's `threadByLocalSession` would
    // both lose it under a result that says success. Every other session moves —
    // which is what makes `migrate R -> R` the remedy 0.12.0 promised for #126:
    // it leaves R's own sessions alone and brings the legacy folder's into place.
    // Only when nothing is left to move is the migrate refused, on a dry run too.
    //
    // Decided on FOLDERS, never on paths, because the folder is what the import
    // writes: a target through a symlink to the source (the CLI resolves it), a
    // link whose own path encodes the same as its target's, two directories whose
    // names differ only in punctuation (`/a/b-c`, `/a/b.c`) — each writes a
    // folder the source's sessions may already be in, and none of them may
    // re-mint one there. The source is taken as typed, because discovery reads
    // exactly the folders its spelling names; that is how sessions a pre-#149
    // import filed under a symlinked or trailing-separator spelling are moved to
    // the physical path.
    //
    // ONE discovery, handed to the export (`ExportOptions.discovered`), so the
    // skip, the export and the cleanup all see the same sessions — and cleanup
    // deletes each moved one from the folder it was FOUND in, which is not
    // derivable from the path when there are two.
    const discovered = discoverSessions(sourceConfigDir, sourceProjectPath);
    const writeFolder = folderIdentity(targetConfigDir, encodeProjectPath(targetProjectPath));
    const isInPlace = (s) => folderIdentity(sourceConfigDir, s.encodedProjectDir) === writeFolder;
    const inScope = (s) => scope !== "current" || s.sessionId === sessionId;
    const staying = discovered.filter(isInPlace);
    const movable = discovered.filter((s) => !isInPlace(s));
    const stayingInScope = staying.filter(inScope);
    if (stayingInScope.length > 0 && !movable.some(inScope)) {
        const folder = join(sourceConfigDir, "projects", stayingInScope[0].encodedProjectDir);
        const n = stayingInScope.length;
        const what = scope === "current"
            ? `session ${sessionId} is`
            : n === 1
                ? "the one session found for the source is"
                : `all ${n} sessions found for the source are`;
        return {
            success: false,
            command: "migrate",
            error: `Nothing to move: ${what} already in ${JSON.stringify(folder)}, which is the folder this migrate would write the target's sessions to: the source (${JSON.stringify(sourceProjectPath)}) and the target (${JSON.stringify(targetProjectPath)}) name the same one. Migrating ${n === 1 ? "it anyway would re-import it" : "them anyway would re-import each one"} into that same folder under a NEW session id and delete the original, so \`claude --resume <id>\` and the hub's record of each session's thread would both stop finding ${n === 1 ? "it" : "them"}.`,
            suggestion: "Nothing was written or deleted. To move these sessions to another project directory, give that directory as --target-project-path; to move them to another config dir, give it as --target-config-dir.",
        };
    }
    // Said on the dry run and the real run alike: the preview must not list
    // fewer sessions than the source holds without saying why.
    const inPlaceWarnings = [];
    if (stayingInScope.length > 0) {
        const n = stayingInScope.length;
        const folder = join(sourceConfigDir, "projects", stayingInScope[0].encodedProjectDir);
        inPlaceWarnings.push(`${n === 1 ? "Session" : `${n} sessions:`} ${stayingInScope.map((s) => s.sessionId).join(", ")} ${n === 1 ? "is" : "are"} already in ${JSON.stringify(folder)}, the folder this migrate writes the target's sessions to, so ${n === 1 ? "it is" : "they are"} left where ${n === 1 ? "it is" : "they are"}, under ${n === 1 ? "its" : "their"} own id${n === 1 ? "" : "s"} — moving ${n === 1 ? "it" : "them"} there would only re-import ${n === 1 ? "it" : "them"} under a new id and delete the original. Only the sessions found in another folder are moved.`);
    }
    // Create temp directory for the intermediate export
    const tempExportDir = mkdtempSync(join(tmpdir(), "sesh-mover-migrate-"));
    try {
        // Step 1: Export
        const exportOpts = {
            configDir: sourceConfigDir,
            projectPath: sourceProjectPath,
            outputDir: tempExportDir,
            name: "migrate-temp",
            excludeLayers,
            claudeVersion,
            // Every session found outside the write folder — the in-place ones are
            // not the export's to see. `sessionId` still narrows it for --scope current.
            discovered: movable,
            onProgress,
        };
        const exportResult = scope === "current" && sessionId
            ? await exportSession({ ...exportOpts, sessionId })
            : await exportAllSessions(exportOpts);
        if (!exportResult.success) {
            return exportResult;
        }
        const exported = exportResult;
        const exportPath = exported.exportPath;
        // Step 2: Import to target (or dry-run)
        const importResult = await importSession({
            exportPath,
            targetConfigDir,
            targetProjectPath,
            targetClaudeVersion: claudeVersion,
            dryRun: !!dryRun,
            onProgress,
        });
        if (!importResult.success) {
            return importResult;
        }
        // If dry-run, return preview without cleanup.
        //
        // `dryRun: true` marks EVERY field below as a prediction: `cleanedUp` and
        // `directoryRenamed` answer "would this happen", not "did this happen".
        // Nothing outside the (temp) export staging dir is touched on this path.
        if (dryRun) {
            const dryResult = importResult;
            const renamePlan = planDirectoryRename(renameDir, sourceProjectPath, targetProjectPath, "dry-run");
            // Cleanup deletes the source copy of every session the real run would
            // move — imported plus skipped-as-duplicate (see step 3 below).
            const wouldCleanUp = dryResult.importedSessions.length + dryResult.skippedSessions.length > 0;
            return {
                success: true,
                command: "migrate",
                dryRun: true,
                importedSessions: dryResult.importedSessions,
                skippedSessions: dryResult.skippedSessions,
                cleanedUp: wouldCleanUp,
                directoryRenamed: renamePlan.rename,
                sourcePath: sourceProjectPath,
                targetPath: targetProjectPath,
                // The shared-layer preview, forwarded rather than re-derived. A migrate
                // is an import, so its dry run has the same memory plan an `import
                // --dry-run` has, and dropping it here was why `commands/migrate.md`
                // could preview sessions but not the one part of the move that touches
                // a directory the target already owns.
                memoryPlan: dryResult.memoryPlan,
                memoryDir: dryResult.memoryDir,
                planConflicts: dryResult.planConflicts,
                warnings: [
                    ...selfMigrationWarnings,
                    ...inPlaceWarnings,
                    // The export runs for real even on a dry run (into a temp staging
                    // dir), so its warnings are already true of what the real migrate
                    // would carry — including the `--exclude` disclosure the apply path
                    // relays for the same reason.
                    ...exported.warnings,
                    ...dryResult.warnings,
                    ...(renamePlan.warning ? [renamePlan.warning] : []),
                    "DRY RUN: no files were modified or deleted",
                ],
            };
        }
        const imported = importResult;
        // Step 3: Clean up source — only sessions confirmed moved. Sessions the
        // import skipped as duplicates still count: identical content already
        // exists at the target, so migrate semantics (source ends up gone) hold.
        const movedIds = new Set(imported.importedSessions.map((s) => s.originalId));
        for (const s of imported.skippedSessions ?? [])
            movedIds.add(s.originalId);
        // From the folder each one was FOUND in, never `encodeProjectPath(source)`:
        // a session moved out of the legacy folder is not in that one, and deleting
        // there left the moved session behind as a duplicate (and could reach a
        // same-id copy that was never moved). The export saw exactly `movable`, so
        // every moved id is in this map.
        const foundIn = new Map();
        for (const s of movable) {
            const folders = foundIn.get(s.sessionId) ?? new Set();
            folders.add(s.encodedProjectDir);
            foundIn.set(s.sessionId, folders);
        }
        // `file-history/<id>` is keyed by id ALONE, so a session left in place that
        // shares an id with a moved copy (only a hand copy makes one: every import
        // mints a new id) shares its file-history too, and keeps it.
        const stayingIds = new Set(staying.map((s) => s.sessionId));
        let cleanedUp = false;
        // What the cleanup KEPT because no bundle carried it, collected across every
        // moved session so the warning names them once rather than per session.
        const keptUncarried = new Set();
        for (const movedId of movedIds) {
            for (const encodedDir of foundIn.get(movedId) ?? []) {
                const sourceProjectDir = join(sourceConfigDir, "projects", encodedDir);
                const jsonlPath = join(sourceProjectDir, `${movedId}.jsonl`);
                if (existsSync(jsonlPath))
                    rmSync(jsonlPath);
                const sessionSubDir = join(sourceProjectDir, movedId);
                if (existsSync(sessionSubDir)) {
                    // **Delete only what the export carried** (#124). This used to be a
                    // flat `rmSync(sessionSubDir, { recursive: true })`, which deleted the
                    // whole session directory — including anything Claude Code had written
                    // there that no version of this plugin knows how to export. That is
                    // migrate's own documented hazard (`--exclude` drops a layer from the
                    // bundle while cleanup still deletes the source) applied to a name
                    // nobody registered as a layer, and it has already cost two: a
                    // session's `workflows/` run records and scripts, and
                    // `auto-mode-classifier-error.txt`. Both were found by hand-diffing a
                    // real migration, not by this code noticing.
                    //
                    // So the direction is inverted: remove the carried names, leave
                    // everything else where it is, and report it. A user who wants the rest
                    // gone can delete a directory; nobody can recover one migrate removed.
                    for (const name of readdirSync(sessionSubDir)) {
                        if (EXPORTED_SESSION_DIR_NAMES.includes(name)) {
                            rmSync(join(sessionSubDir, name), { recursive: true, force: true });
                        }
                        else {
                            keptUncarried.add(name);
                        }
                    }
                    // Gone only if nothing unrecognised was left in it.
                    if (readdirSync(sessionSubDir).length === 0)
                        rmSync(sessionSubDir, { recursive: true });
                }
            }
            const fileHistoryDir = join(sourceConfigDir, "file-history", movedId);
            if (!stayingIds.has(movedId) && existsSync(fileHistoryDir)) {
                rmSync(fileHistoryDir, { recursive: true });
            }
            cleanedUp = true;
        }
        if (keptUncarried.size > 0) {
            imported.warnings.push(`The source session folder${movedIds.size === 1 ? "" : "s"} still hold${movedIds.size === 1 ? "s" : ""} ${[...keptUncarried].sort().map((n) => JSON.stringify(n)).join(", ")}, which no export carries — so ${movedIds.size === 1 ? "it was" : "they were"} left in place rather than deleted with the rest. Claude Code writes these; sesh-mover does not know how to move them. Copy them by hand if you want them at the destination, then remove the source folder yourself. Nothing else about the migration is affected.`);
        }
        // Step 4: Optionally rename the actual project directory. The
        // preconditions are decided by the same helper the dry-run preview uses,
        // so the preview can never again disagree with what happens here.
        let directoryRenamed = false;
        const renamePlan = planDirectoryRename(renameDir, sourceProjectPath, targetProjectPath, "apply");
        if (renamePlan.warning)
            imported.warnings.push(renamePlan.warning);
        if (renamePlan.rename) {
            try {
                // Ensure parent directory of target exists
                const targetParent = dirname(targetProjectPath);
                if (!existsSync(targetParent)) {
                    const { mkdirSync } = await import("node:fs");
                    mkdirSync(targetParent, { recursive: true });
                }
                renameSync(sourceProjectPath, targetProjectPath);
                directoryRenamed = true;
            }
            catch (e) {
                imported.warnings.push(`Failed to rename directory ${sourceProjectPath} → ${targetProjectPath}: ${errorMessage(e)}. You may need to rename it manually.`);
            }
        }
        return {
            success: true,
            command: "migrate",
            importedSessions: imported.importedSessions,
            skippedSessions: imported.skippedSessions,
            cleanedUp,
            directoryRenamed,
            sourcePath: sourceProjectPath,
            targetPath: targetProjectPath,
            // The typed shared-layer fields, forwarded ALONGSIDE the import's warnings
            // rather than instead of them (#59 item 3). A migrate reconciles `memory/`
            // and `plans/` into the target exactly as an import does — it IS an import
            // — so a migrate that parks a memory file must hand the skill layer the
            // same `parkedAs`/`memoryDir` pair `commands/import.md` acts on. Only the
            // warnings crossed this line before, which made the parked copy visible
            // and unactionable. One migrate is one import call, so there is nothing to
            // aggregate here (unlike a pull, which walks a chain).
            memoryConflicts: imported.memoryConflicts,
            memoryIndex: imported.memoryIndex,
            memoryDir: imported.memoryDir,
            planConflicts: imported.planConflicts,
            // `plansSkipped` matters MORE here than on import, not less. `migrate`
            // declares no `--include-plans`, so it always takes the skip — and unlike
            // an import, the user is moving a session and may reasonably read that as
            // "everything came with it". The warning already crosses; without this
            // the count is the one part the skill layer cannot branch on. (It is not
            // data loss either way: cleanup deletes only the source project's
            // sessions and file-history, never `<sourceConfigDir>/plans`, so the
            // source plans stay where they are. The visible gap is a cross-config-dir
            // migrate.)
            plansSkipped: imported.plansSkipped,
            // The EXPORT's warnings ride along too, and they are not decoration on a
            // migrate: `--exclude` drops a layer from the bundle, but cleanup then
            // deletes the whole source session directory and its file-history
            // regardless — so the excluded layer is destroyed rather than left
            // behind. "<layer> excluded by user request" is the only thing that says
            // so, and returning only the IMPORT's warnings swallowed it.
            warnings: [
                ...selfMigrationWarnings,
                ...inPlaceWarnings,
                ...exported.warnings,
                ...imported.warnings,
            ],
        };
    }
    finally {
        // Clean up temp export
        rmSync(tempExportDir, { recursive: true, force: true });
    }
}
//# sourceMappingURL=migrator.js.map