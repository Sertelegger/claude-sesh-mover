import { mkdirSync, readFileSync, readdirSync, existsSync, copyFileSync, appendFileSync, lstatSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readManifest, computeIntegrityHash, computeIntegrityHashFromFile, computeLayerDigest, verifySessionsDigest, isSafeSessionId, } from "./manifest.js";
import { rewriteJsonlStream, buildImportRewriteContext } from "./rewriter.js";
import { encodeProjectPath } from "./platform.js";
import { getApplicableAdapters, classifyVersionDifference, } from "./version-adapters.js";
import { readSyncState, writeSyncState } from "./sync-state.js";
import { readLastEntryUuid } from "./jsonl.js";
import { percentThrottle } from "./progress.js";
import { readLocalProjectId, writeLocalProjectId } from "./hub/identity.js";
import { MEMORY_INDEX_NAME, appendIndexLines, formatMemoryPointer, memoryIndexTargets, unionMemoryIndex, } from "./memory-index.js";
import { MAX_SIDECAR_ATTEMPTS, copyToNewFile, copyToUniqueName } from "./sidecar.js";
/**
 * The three auxiliary layer directories a bundle carries for one session, in
 * the layout the exporter writes them. Single source of truth shared by the
 * digest verification in step 3 and the copies in step 4, so a layer can never
 * be verified under one path and copied from another.
 */
function layerDirsFor(exportPath, bundleSessionId) {
    return [
        ["subagents", join(exportPath, "sessions", bundleSessionId, "subagents")],
        ["tool-results", join(exportPath, "sessions", bundleSessionId, "tool-results")],
        ["file-history", join(exportPath, "file-history", bundleSessionId)],
    ];
}
/**
 * The public `SharedLayerFindings` projection of a report. ONE place, so the
 * three result shapes that carry these fields (`ImportResult` here,
 * `MigrateResult` via migrator.ts, `HubPullResult` via the pull's accumulator)
 * cannot disagree about when a field is present — an empty array is reported as
 * absent, never as `[]`, and that rule is written once.
 */
function sharedFindings(shared) {
    return {
        memoryConflicts: shared.memoryConflicts.length > 0 ? shared.memoryConflicts : undefined,
        memoryIndex: shared.memoryIndex,
        memoryDir: shared.memoryDir,
        planConflicts: shared.planConflicts.length > 0 ? shared.planConflicts : undefined,
    };
}
function readTextFile(path) {
    try {
        return readFileSync(path, "utf-8");
    }
    catch {
        return null;
    }
}
/**
 * `lstatSync`, never `statSync`: a symlink is not a regular file even when it
 * points at one. Every caller is SOURCE-side (a file in the bundle), and a
 * DIRECTORY-form bundle is the case this closes — `archiver.ts` rejects
 * symlink entries before an archive is ever extracted, but a directory export
 * is handed to us as-is, so `memory/notes.md` can be a link to anything on this
 * machine and `statSync().isFile()` would read straight through it into the
 * target's memory folder. Destination side, the same class is closed by
 * `copyIfAbsent`.
 */
function isRegularFile(path) {
    try {
        return lstatSync(path).isFile();
    }
    catch {
        return false;
    }
}
/**
 * Is `path` occupied by ANYTHING — a file, a directory, or a symlink whose
 * target does not exist? `lstatSync`, so a dangling symlink answers `true`,
 * which is the answer `copyIfAbsent`'s `O_EXCL` gives the real run.
 *
 * Only plan mode needs this. A real run's answer to "is this destination
 * taken" is the exclusive write itself; a preview writes nothing, so it has to
 * ask, and asking with `existsSync` is what would make the plan disagree with
 * the run about a link.
 */
function pathIsTaken(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Copy `src` to `dst` **only if `dst` can be created**, and answer whether it
 * was. The create is exclusive (`O_CREAT|O_EXCL`), so the check and the write
 * are one atomic step, and `false` (EEXIST) is an ANSWER the caller falls
 * through on — never swallowed, never a failure, never an abort of the layer.
 *
 * It replaces an `existsSync(dst)` + plain `copyFileSync` pair at all three of
 * this module's shared-layer destinations, for a reason bigger than the TOCTOU
 * window: **`existsSync` follows symlinks.** A DANGLING symlink at `dst`
 * resolves to nothing, so `existsSync` answers "absent" and the copy then
 * writes THROUGH the link, landing wherever it points and outside the memory
 * or plans directory entirely. `O_EXCL` refuses a symlink path outright,
 * dangling or not — which is why the fix is the exclusive create rather than an
 * `lstatSync` bolted in front of the same call, and why that create has to be
 * the thing that decides, not a second opinion after a check already decided.
 *
 * That sentence is a POSIX sentence, and #68 is where it stopped being the
 * whole story: `COPYFILE_EXCL` is `O_CREAT|O_EXCL` on POSIX and `CopyFileW`
 * with `bFailIfExists` on Windows, which resolves a reparse point and so asks
 * its question about the LINK'S TARGET — measured on `windows-latest`, where
 * the bundle's file landed in the escape directory while Linux and macOS
 * refused it. The write here now goes through `sidecar.ts`'s `copyToNewFile`,
 * which layers an explicit `lstat` refusal over the exclusive create precisely
 * because the exclusive create is only known to refuse a link on POSIX. Read
 * that function before changing any of this: the three guards, and which of
 * them is load-bearing on which platform, are argued there.
 *
 * Same rule and same reason as `sidecar.ts`'s `copyToUniqueName`, but
 * deliberately NOT that helper: these three sites write the CANONICAL name.
 * A `MEMORY-2.md`, a `notes-2.md` or a `test-plan-2.md` is not a fallback, it
 * is clutter no reader is pointed at — parking is only safe for a prose memory
 * because tier 1 indexes the parked copy, and that mechanism exists for
 * nothing else here. So the answer to "taken" is the compare branch below, not
 * a second name.
 *
 * Any other error still throws, exactly as the plain copy did: the layer's
 * enclosing catch turns it into "nothing in your memory folder was changed".
 */
function copyIfAbsent(src, dst) {
    try {
        copyToNewFile(src, dst);
        return true;
    }
    catch (e) {
        if (e.code === "EEXIST")
            return false;
        throw e;
    }
}
/** `notes.md` -> `notes`; `notes.txt` -> `notes.txt` (a parked copy is always `.md`). */
function memoryStem(filename) {
    return filename.toLowerCase().endsWith(".md") ? filename.slice(0, -3) : filename;
}
/**
 * Reconcile the two **shared-namespace** auxiliary layers: `memory/` (into the
 * target project dir) and `plans/` (into the target config dir).
 *
 * The other four layers — jsonl, subagents, tool-results, file-history — need
 * no rule at all: they are written under a session id this import minted
 * seconds earlier, so a collision is structurally impossible. These two are
 * written into directories the target already owns, where filenames are MEANT
 * to collide, and until #49 their rule was "copy if absent, otherwise keep
 * local" — which landed ten memory files and withheld the one edit
 * (`MEMORY.md`) that made them reachable, while reporting complete success.
 *
 * Three tiers, of which this function is the first two:
 *  1. `MEMORY.md` is an INDEX, not prose: it has a well-defined union, so it is
 *     unioned, unconditionally and with no confirmation. See `memory-index.ts`.
 *  2. A conflicting prose memory keeps the local file and parks the incoming
 *     copy beside it as `<stem>.incoming.md`, which tier 1 then indexes. That
 *     is lossless and deterministic, and it is the behaviour whenever nothing
 *     interactive is attached (a hook-driven `hub pull`, a scripted run) — not
 *     a fallback that "shouldn't normally happen".
 *  3. A semantic merge of the two texts lives in `commands/import.md`, in a
 *     session that already has a model attached, on the user's confirmation.
 *     It is built ON tier 2: `cli.ts` deletes an archive's extract dir before
 *     returning, so the parked file is the only place the incoming text still
 *     exists once this process exits.
 *
 * Nothing here is path-rewritten, deliberately. A memory is prose a model
 * wrote, and the rewriter's standing rule is that user and assistant text are
 * never rewritten: a memory saying "the config dir is /Users/x/.claude-nv" is a
 * statement ABOUT a machine, and rewriting it to the target's path would make
 * it false rather than portable.
 *
 * It must never fail the import. Every read, write and copy degrades to
 * "keep local, say so" — this step sits outside the session-write rollback, so
 * a throw here lands after the transcripts are written and before they are
 * registered.
 */
function reconcileSharedLayers(opts) {
    const { exportPath, targetProjectDir, targetConfigDir, plan } = opts;
    const sourceName = opts.sourceMachineName ?? "another machine";
    const warnings = [];
    const memoryConflicts = [];
    const planConflicts = [];
    const memoryPlan = [];
    let memoryIndex;
    let reportedMemoryDir;
    const memoryDir = join(exportPath, "memory");
    if (existsSync(memoryDir)) {
        try {
            const targetMemDir = join(targetProjectDir, "memory");
            reportedMemoryDir = targetMemDir;
            const indexPath = join(targetMemDir, MEMORY_INDEX_NAME);
            if (!plan)
                mkdirSync(targetMemDir, { recursive: true });
            const files = readdirSync(memoryDir).sort();
            // The local index, and whether we may write it at all. An index that
            // exists but cannot be read (a directory in its place, a DANGLING
            // SYMLINK, a permission problem) is left alone: overwriting it would be
            // the destructive move this whole step exists to avoid.
            let indexText = null;
            let indexUsable = true;
            /**
             * A real file we have either read or created is at `indexPath`. Gates the
             * final write's flag: `w` truncates whatever the name resolves to, which
             * is only ours to do for a file we know we have in hand.
             */
            let indexOnDisk = false;
            let indexReadAttempted = false;
            /**
             * Read the local index at most once. Called eagerly when something is
             * already at the path, and again by the tier-1 fall-through when the
             * exclusive copy answered EEXIST — the second call is a no-op, so the
             * fall-through cannot re-warn or re-read.
             */
            const readLocalIndex = () => {
                if (indexReadAttempted)
                    return;
                indexReadAttempted = true;
                indexText = readTextFile(indexPath);
                if (indexText === null) {
                    indexUsable = false;
                    warnings.push(`Could not read the existing memory index (${MEMORY_INDEX_NAME}) — left it untouched, so memories from this bundle may not be listed in it.`);
                }
                else {
                    indexOnDisk = true;
                }
            };
            // `pathIsTaken`, not `existsSync`: a dangling symlink here has to count
            // as an index we must not write, and `existsSync` reports it as absent.
            if (pathIsTaken(indexPath))
                readLocalIndex();
            let indexChanged = false;
            const added = [];
            let alreadyPresent = 0;
            let droppedProse = false;
            // Tier 1 runs FIRST: it decides what the parked copies below can be
            // appended to, so there is exactly one write of the index at the end.
            const incomingIndexPath = join(memoryDir, MEMORY_INDEX_NAME);
            if (files.includes(MEMORY_INDEX_NAME) && isRegularFile(incomingIndexPath)) {
                const incomingText = readTextFile(incomingIndexPath);
                if (incomingText === null) {
                    memoryPlan.push({
                        filename: MEMORY_INDEX_NAME,
                        verdict: "keep-local",
                        note: "the bundle's index could not be read",
                    });
                    warnings.push(`Could not read "${MEMORY_INDEX_NAME}" from the bundle — the memory index was left as it is.`);
                }
                else {
                    // The WRITE is the existence check, not a call in front of it.
                    // Copied rather than written back from the decoded string, so the
                    // bytes land exactly as they were sent; copied EXCLUSIVELY so that
                    // "there is already something at MEMORY.md" — an index, a directory,
                    // a dangling symlink pointing anywhere on this machine — is answered
                    // by the kernel at the moment of the write. See `copyIfAbsent`.
                    const copied = plan
                        ? !pathIsTaken(indexPath)
                        : copyIfAbsent(incomingIndexPath, indexPath);
                    if (copied) {
                        indexText = incomingText;
                        if (!plan)
                            indexOnDisk = true;
                        memoryPlan.push({ filename: MEMORY_INDEX_NAME, verdict: "copy" });
                    }
                    else {
                        // EEXIST falls THROUGH to the compare branches — the destination
                        // being taken is the ordinary case, not an error.
                        readLocalIndex();
                        if (!indexUsable) {
                            memoryPlan.push({
                                filename: MEMORY_INDEX_NAME,
                                verdict: "keep-local",
                                note: "the local index could not be read",
                            });
                        }
                        else if (indexText === incomingText) {
                            memoryPlan.push({ filename: MEMORY_INDEX_NAME, verdict: "identical" });
                        }
                        else {
                            const union = unionMemoryIndex(indexText, incomingText);
                            added.push(...union.added);
                            alreadyPresent = union.alreadyPresent;
                            droppedProse = union.droppedProse;
                            if (union.added.length > 0) {
                                indexText = union.text;
                                indexChanged = true;
                            }
                            memoryPlan.push({
                                filename: MEMORY_INDEX_NAME,
                                verdict: "index-union",
                                added: union.added,
                                alreadyPresent: union.alreadyPresent,
                            });
                        }
                    }
                }
            }
            for (const file of files) {
                if (file === MEMORY_INDEX_NAME)
                    continue;
                const src = join(memoryDir, file);
                if (!isRegularFile(src)) {
                    memoryPlan.push({ filename: file, verdict: "skip", note: "not a regular file" });
                    warnings.push(`Ignored "${file}" in the bundle's memory folder — it is not a regular file.`);
                    continue;
                }
                const dst = join(targetMemDir, file);
                // Same rule as the index above: the exclusive copy IS the "is this
                // name free" question, so a dangling symlink at `dst` cannot be
                // answered "absent" and then written through. A `false` here means the
                // name is taken and the compare/park branch below owns the decision.
                const copied = plan ? !pathIsTaken(dst) : copyIfAbsent(src, dst);
                if (copied) {
                    memoryPlan.push({ filename: file, verdict: "copy" });
                    continue;
                }
                const existingContent = readTextFile(dst);
                const newContent = readTextFile(src);
                if (existingContent === null || newContent === null) {
                    memoryPlan.push({
                        filename: file,
                        verdict: "keep-local",
                        note: "one of the two copies could not be read",
                    });
                    warnings.push(`Memory file "${file}" could not be compared with the incoming copy — kept the existing version.`);
                    continue;
                }
                if (existingContent === newContent) {
                    memoryPlan.push({ filename: file, verdict: "identical" });
                    continue;
                }
                // Tier 2. The local file is never touched; the incoming copy is parked
                // beside it and indexed, so it is reachable AND still on disk for the
                // skill layer's semantic merge once the bundle is gone.
                //
                // The name diverges from `merge.ts`'s `<name>.theirs-<stamp>` sidecar
                // on purpose: `notes.md.theirs-2026-…Z` is not a `.md` file and so is
                // not read as a memory at all, and this copy is user-facing and
                // transient (shown in a confirmation within seconds, retired on
                // acceptance) rather than an archaeological artifact. The
                // uniquification is NOT re-derived — `copyToUniqueName` is the one copy
                // of that rule, shared with `writeSidecar`, so a second import of a
                // still-conflicting memory can never eat the first parked copy.
                const stem = memoryStem(file);
                const nameFor = (n) => n === 0 ? `${stem}.incoming.md` : `${stem}.incoming-${n + 1}.md`;
                const existingHash = computeIntegrityHash([existingContent]);
                const incomingHash = computeIntegrityHash([newContent]);
                // An already-parked copy of exactly this text is this text. A hub pull
                // applies a CHAIN of bundles through one importSession call each, so
                // without this a five-bundle pull of a thread whose memory never
                // changed plants five identical `.incoming-N.md` files and five index
                // lines — degrading the index this fix exists to protect. Reuse is only
                // ever byte-identical, so nothing is lost by it; a genuinely different
                // incoming version still gets its own copy.
                //
                // (This is the one deviation from the design's §9 case 9b, which
                // expects a second import of the SAME bundle to produce
                // `.incoming-2.md`. The guarantee that case exists to pin — a later
                // parked copy never eats an earlier one — is unaffected and tested.)
                let parkedAs = null;
                let reusedParked = false;
                for (let n = 0; n < MAX_SIDECAR_ATTEMPTS; n++) {
                    const candidate = join(targetMemDir, nameFor(n));
                    // `pathIsTaken`, so this scan and `copyToUniqueName`'s `O_EXCL` agree
                    // about which names are free — an `existsSync` here would call a
                    // dangling symlink free, stop the scan early, and predict a parked
                    // name the exclusive copy then refuses.
                    if (!pathIsTaken(candidate))
                        break;
                    if (readTextFile(candidate) === newContent) {
                        parkedAs = nameFor(n);
                        reusedParked = true;
                        break;
                    }
                }
                if (parkedAs === null) {
                    if (plan) {
                        for (let n = 0; n < MAX_SIDECAR_ATTEMPTS; n++) {
                            if (!pathIsTaken(join(targetMemDir, nameFor(n)))) {
                                parkedAs = nameFor(n);
                                break;
                            }
                        }
                    }
                    else {
                        try {
                            parkedAs = copyToUniqueName(src, nameFor, (name) => join(targetMemDir, name));
                        }
                        catch (e) {
                            warnings.push(`Could not park the incoming copy of "${file}" (${e.message}).`);
                            parkedAs = null;
                        }
                    }
                }
                if (parkedAs === null) {
                    memoryPlan.push({
                        filename: file,
                        verdict: "keep-local",
                        note: "the incoming copy could not be parked",
                    });
                    memoryConflicts.push({ filename: file, existingHash, incomingHash });
                    warnings.push(`Memory file "${file}" differs from the incoming copy — kept yours, and the incoming copy could NOT be saved beside it. It is only in the bundle.`);
                    continue;
                }
                memoryPlan.push({ filename: file, verdict: "park", parkedAs });
                memoryConflicts.push({ filename: file, existingHash, incomingHash, parkedAs });
                warnings.push(reusedParked
                    ? `Memory file "${file}" differs from the copy in this bundle — kept yours; theirs was already saved here as "${parkedAs}".`
                    : `Memory file "${file}" differs from the copy in this bundle — kept yours and saved theirs as "${parkedAs}" (listed in ${MEMORY_INDEX_NAME}). Nothing was overwritten.`);
                // One pointer per parked file, ever: keyed off the index's own targets,
                // so a reused copy adds no second line and a user who deleted the line
                // by hand gets it back rather than a duplicate.
                const base = indexText ?? "";
                if (indexUsable && !memoryIndexTargets(base).includes(parkedAs)) {
                    const pointer = formatMemoryPointer(`${stem} (incoming copy)`, parkedAs, `incoming version of ${file} from ${sourceName} — differs from your copy, not merged`);
                    const next = appendIndexLines(base, [pointer]);
                    if (next !== base) {
                        indexText = next;
                        indexChanged = true;
                    }
                }
            }
            if (!plan && indexUsable && indexChanged && indexText !== null) {
                try {
                    // `w` (truncate whatever this name resolves to) is only ours to use
                    // for an index we have in hand — one we read, or one we just created
                    // exclusively. The other reachable case is "no index anywhere and a
                    // parked copy needs a pointer", which is a CREATE, so it takes `wx`.
                    //
                    // **`wx` is not a symlink guard on Windows** (#68), and this site is
                    // where that was nearly mis-read. Its test — "does not write the
                    // merged index through a dangling symlink when the bundle carries
                    // none" — passed on `windows-latest` while the three `copyIfAbsent`
                    // sites failed, which reads like evidence that `wx` refuses a link.
                    // It is not. MEASURED, by instrumenting this line: across the whole
                    // importer suite it runs 13 times and takes the `w` branch every
                    // time; in that test it never runs at all. `pathIsTaken` above is an
                    // `lstat`, so the dangling link counts as an index — the read through
                    // it then fails, `indexUsable` goes false, and this whole block is
                    // skipped. Swap that `lstat` back to the pre-#64 `existsSync` and the
                    // instrumented line prints `flag=wx` in exactly that test, i.e. the
                    // write IS attempted and only POSIX's `O_EXCL` refuses it.
                    //
                    // So what protected this site on Windows was `lstatSync`, not the
                    // flag — the same conclusion `copyToNewFile` reaches for the other
                    // three. Do not "simplify" `pathIsTaken` to `existsSync` here.
                    writeFileSync(indexPath, indexText, {
                        encoding: "utf-8",
                        flag: indexOnDisk ? "w" : "wx",
                    });
                }
                catch (e) {
                    warnings.push(`Could not update the memory index (${e.message}) — memories from this bundle are on disk but may not be listed in ${MEMORY_INDEX_NAME}.`);
                }
            }
            // A memory file the bundle carried that no index line points at is on
            // disk and unreachable. The union cannot fix this — it is a union over
            // index LINES, and a file no line points at contributes no line — and it
            // usually predates the transfer (the file was already orphaned on the
            // source machine). Adopting it would mean inventing an index entry whose
            // title has to be guessed, in the file that decides what future sessions
            // read, to repair someone else's housekeeping. So: report, don't adopt.
            const indexed = new Set(memoryIndexTargets(indexText ?? ""));
            const parked = new Set(memoryConflicts.map((c) => c.parkedAs));
            // With an unreadable index there is no reading of it to be had, so claim
            // nothing: every file would look unindexed for a reason that is about us.
            const unindexed = indexUsable
                ? files.filter((f) => f !== MEMORY_INDEX_NAME &&
                    !parked.has(f) &&
                    !indexed.has(f) &&
                    isRegularFile(join(memoryDir, f)))
                : [];
            memoryIndex = { added, alreadyPresent, droppedProse, unindexed };
            if (added.length > 0) {
                warnings.push(`Memory index: added ${added.length} ${added.length === 1 ? "entry" : "entries"} from this bundle to ${MEMORY_INDEX_NAME}${alreadyPresent > 0 ? ` (${alreadyPresent} already listed)` : ""}. Your existing entries and their order were kept.`);
            }
            if (droppedProse) {
                warnings.push(`The bundle's ${MEMORY_INDEX_NAME} carried text that is not an index entry (a heading or prose) — only its entries were merged, that text was not copied.`);
            }
            if (unindexed.length > 0) {
                warnings.push(`${unindexed.length} memory file(s) in this bundle are listed in no index and landed unreferenced: ${unindexed.join(", ")}.`);
            }
        }
        catch (e) {
            warnings.push(`Memory files could not be reconciled (${e.message}) — nothing in your memory folder was changed by this import.`);
        }
    }
    // `plans/` is config-dir-GLOBAL on both ends (the exporter applies no project
    // filter), so an import writes into a directory every project on this machine
    // shares. It gets the report half of the memory treatment and not the parking
    // half, deliberately: a plan is a document with no index, so a parked copy
    // there is unreachable clutter rather than a reachable alternative — the
    // mechanism that makes parking safe for a memory (tier 1 indexes it) does not
    // exist here. Until `plans/` is re-scoped, writing MORE files into a shared
    // directory is the wrong direction. The incoming plan stays in the bundle.
    const plansDir = join(exportPath, "plans");
    if (existsSync(plansDir)) {
        try {
            const targetPlansDir = join(targetConfigDir, "plans");
            if (!plan)
                mkdirSync(targetPlansDir, { recursive: true });
            for (const file of readdirSync(plansDir).sort()) {
                const src = join(plansDir, file);
                if (!isRegularFile(src))
                    continue;
                const dst = join(targetPlansDir, file);
                // Exclusive, for the same reason as the two memory sites — and it
                // matters more here, because `plans/` is config-dir-global: a dangling
                // symlink planted in it is reachable from every project on the machine.
                // A taken name falls through to the compare/report branch; nothing is
                // parked, deliberately (see the block comment above).
                const copied = plan ? !pathIsTaken(dst) : copyIfAbsent(src, dst);
                if (copied)
                    continue;
                const existingContent = readTextFile(dst);
                const newContent = readTextFile(src);
                if (existingContent === null || newContent === null || existingContent === newContent) {
                    continue;
                }
                planConflicts.push({
                    filename: file,
                    existingHash: computeIntegrityHash([existingContent]),
                    incomingHash: computeIntegrityHash([newContent]),
                });
                warnings.push(`Plan "${file}" already exists here with different content — kept yours. The incoming plan was not written and is only in the bundle (see planConflicts).`);
            }
        }
        catch (e) {
            warnings.push(`Plans could not be reconciled (${e.message}) — nothing in your plans folder was changed by this import.`);
        }
    }
    return {
        warnings,
        memoryConflicts,
        memoryIndex,
        memoryPlan: plan ? memoryPlan : undefined,
        memoryDir: reportedMemoryDir,
        planConflicts,
    };
}
export async function importSession(options) {
    const { exportPath, targetConfigDir, targetProjectPath, targetClaudeVersion, dryRun, sessionIds, noRegister, allowDuplicates, onProgress, } = options;
    const warnings = [];
    // Step 1: Read manifest
    let manifest;
    try {
        manifest = readManifest(exportPath);
    }
    catch (e) {
        return {
            success: false,
            command: "import",
            error: `Failed to read manifest: ${e.message}`,
        };
    }
    // Step 1a: the manifest must be the one the exporter wrote. This runs before
    // ANY other decision — the dedup filters, the per-session hash checks and the
    // rewrite context are all derived from the session list, so a damaged list is
    // not something to notice halfway through. `verifySessionsDigest` returns null
    // for a pre-0.6.0 bundle that declares no digest.
    const digestProblem = verifySessionsDigest(manifest);
    if (digestProblem) {
        return {
            success: false,
            command: "import",
            error: `Bundle integrity check failed: ${digestProblem}`,
            details: "Nothing was read from the bundle beyond its manifest, and nothing was written. The manifest's session list is not the one the export produced — the bundle was damaged in transit or edited after it was written.",
            suggestion: "Re-export or re-transfer the bundle. This check detects damage, not tampering: it cannot tell a corrupted bundle from one a sender rewrote deliberately.",
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
    // Step 1b: a session the manifest declares but the bundle does not contain is
    // an INTEGRITY FAILURE, not a skip.
    //
    // This gate used to be `existsSync(jsonlPath)` wrapped around the hash check
    // in step 3, so a missing file was simply never checked: the session was
    // counted in `importedSessions`, no file was written for it, and the result
    // was `success: true, imported: 1, warnings: []`. That is the exact signature
    // of a truncated transfer or a partial unpack, reported as a completed import
    // — the worst failure mode available, because every consumer downstream
    // (cli.ts's output, migrator.ts's `movedIds` cleanup set, hub/pull.ts's
    // `importedSessions`/`lastImportedNewId`/`appliedNothing`) reads that array as
    // "these sessions are now on disk". On a `migrate` it is destructive: the
    // source session is deleted because the import claimed to have moved it.
    //
    // Hard failure with the same treatment a post-rewrite parse failure already
    // gets, and for the same reason — the alternative is reporting a partial
    // import as a complete one. It sits before the dedup filters and before any
    // write, so there is nothing to roll back: a refused bundle leaves the target
    // config dir byte-identical.
    const absentFromBundle = targetSessions.filter((session) => !existsSync(join(exportPath, "sessions", `${session.sessionId}.jsonl`)));
    if (absentFromBundle.length > 0) {
        const named = absentFromBundle
            .map((s) => `"${s.slug}" (${s.sessionId})`)
            .join(", ");
        return {
            success: false,
            command: "import",
            error: `Bundle integrity check failed: ${absentFromBundle.length} session(s) declared by manifest.json have no session file in the bundle: ${named}`,
            details: "Nothing was written and no indexes were modified. A manifest that declares a session the bundle does not contain means the transfer was truncated or the archive was only partially unpacked.",
            // Every flag named in this module has to name `sesh-mover import` with
            // it. `importSession` is called by THREE commands — cli.ts's `import`,
            // migrator.ts and hub/pull-apply-sessions.ts — and migrate and pull
            // re-emit this ErrorResult and these warnings VERBATIM. `pull` declares
            // no --session-id, so a bare flag here is advice its reader cannot
            // follow. See tests/hub-warning-flags.test.ts's cross-command check.
            suggestion: "Re-transfer or re-extract the bundle and import again. To import only the sessions that ARE present, pass --session-id with their ids to `sesh-mover import`.",
        };
    }
    // Compute the target project dir up front — the dedup filters below need
    // it to verify a prior "imported" record still has a file on disk before
    // trusting it (see Fix 1: a registry/peer record can outlive the file it
    // points at, e.g. after a migrate deleted it, and trusting the record
    // alone would silently drop the session instead of importing it fresh).
    const encodedTargetPath = encodeProjectPath(targetProjectPath);
    const targetProjectDir = join(targetConfigDir, "projects", encodedTargetPath);
    const state = readSyncState(targetProjectPath);
    const skippedSessions = [];
    if (!allowDuplicates && manifest.sourceMachineId) {
        const peer = state.peers[manifest.sourceMachineId];
        if (peer) {
            const before = targetSessions.length;
            targetSessions = targetSessions.filter((session) => {
                const prior = peer.received[session.sessionId];
                if (prior &&
                    existsSync(join(targetProjectDir, `${prior.localSessionId}.jsonl`))) {
                    skippedSessions.push({
                        originalId: session.sessionId,
                        reason: "already-received",
                    });
                    return false;
                }
                return true;
            });
            if (targetSessions.length < before) {
                warnings.push(`${before - targetSessions.length} session(s) already received from ${manifest.sourceMachineName ?? manifest.sourceMachineId} — skipped (idempotent).`);
            }
        }
    }
    if (!allowDuplicates) {
        const before = targetSessions.length;
        targetSessions = targetSessions.filter((session) => {
            const prior = state.imported[session.integrityHash];
            const priorFileExists = !!prior &&
                existsSync(join(targetProjectDir, `${prior.localSessionId}.jsonl`));
            if (priorFileExists && (prior.registered || noRegister)) {
                skippedSessions.push({
                    originalId: session.sessionId,
                    reason: "duplicate",
                });
                return false;
            }
            if (priorFileExists && prior && !prior.registered && !noRegister) {
                warnings.push(`Session "${session.slug}" was previously imported with \`sesh-mover import --no-register\`; importing a registered copy (the older unregistered copy remains on disk as ${prior.localSessionId}).`);
            }
            return true;
        });
        if (targetSessions.length < before) {
            warnings.push(`${before - targetSessions.length} session(s) already imported into this project — skipped (idempotent). Run \`sesh-mover import --allow-duplicates\` against the bundle to import them anyway.`);
        }
    }
    if (targetSessions.length === 0) {
        // Every session in the bundle is already here — but the shared layers are
        // not session-scoped and may still be missing. This used to return above
        // the memory step, which is what made the measured defect unrecoverable:
        // the user who read the warning, understood it, and re-ran the import got
        // `importedSessions: []` and no memory work at all. The union is idempotent
        // by construction, so running it on a duplicate import is free and safe,
        // and the memories are content the user wants whether or not the
        // transcripts were new. The one contract change: a fully-duplicate import
        // now means "no new sessions", not "nothing happened".
        const shared = reconcileSharedLayers({
            exportPath,
            targetProjectDir,
            targetConfigDir,
            sourceMachineName: manifest.sourceMachineName,
            plan: dryRun,
        });
        warnings.push(...shared.warnings);
        if (dryRun) {
            return {
                success: true,
                command: "import",
                dryRun: true,
                importedSessions: [],
                skippedSessions,
                warnings,
                resumable: true,
                memoryPlan: shared.memoryPlan,
                memoryDir: shared.memoryDir,
                planConflicts: shared.planConflicts.length > 0 ? shared.planConflicts : undefined,
            };
        }
        return {
            success: true,
            command: "import",
            importedSessions: [],
            skippedSessions,
            warnings,
            resumable: true,
            ...sharedFindings(shared),
        };
    }
    // Step 1.5: Version reconciliation
    const versionDiff = classifyVersionDifference(manifest.sourceClaudeVersion, targetClaudeVersion);
    const adapters = getApplicableAdapters(manifest.sourceClaudeVersion, targetClaudeVersion);
    const versionAdaptations = [];
    if (versionDiff === "source-newer") {
        warnings.push(`Export from newer Claude Code (${manifest.sourceClaudeVersion}) than target (${targetClaudeVersion}). Unknown entry types will be preserved.`);
    }
    // Step 2: Build path mappings (shared with hub/pull.ts's append path — see
    // buildImportRewriteContext for why this must not be re-derived locally)
    const ctx = buildImportRewriteContext(manifest, targetProjectPath, targetConfigDir);
    // Step 3: Verify per-session integrity (before any rewriting)
    const integrityFailedSessions = new Set();
    /** `<sessionId>\0<layer>` for every layer directory that failed its digest. */
    const failedLayers = new Set();
    for (const [sessionIndex, session] of targetSessions.entries()) {
        onProgress?.({
            phase: "import-verify",
            sessionId: session.sessionId,
            sessionIndex,
            sessionCount: targetSessions.length,
        });
        const jsonlPath = join(exportPath, "sessions", `${session.sessionId}.jsonl`);
        // No existsSync guard: step 1b already refused the bundle outright if any
        // declared session file were missing. Presence is a precondition here, not
        // a condition — that conflation is what let a bundle with no session data
        // report a successful import.
        const actualHash = await computeIntegrityHashFromFile(jsonlPath);
        if (actualHash !== session.integrityHash) {
            integrityFailedSessions.add(session.sessionId);
            warnings.push(`integrity check failed for session "${session.slug}" (${session.sessionId}): JSONL content doesn't match manifest hash. Data may be corrupted.`);
        }
        // Auxiliary layers. Until 0.6.0 nothing hashed these at all, so a corrupted
        // file-history backup arrived silently and was later restored over the
        // user's own file by Claude Code. A layer whose digest doesn't match is NOT
        // copied: the transcript is the primary artifact and still imports, while a
        // backup that cannot be shown to be the backup that was taken has no
        // business being written where something may restore it. Bundles that
        // declare no digests (pre-0.6.0) are copied unchecked, exactly as before.
        for (const [layer, dir] of layerDirsFor(exportPath, session.sessionId)) {
            const declared = session.layerDigests?.[layer];
            if (!declared)
                continue;
            const actual = await computeLayerDigest(dir);
            if (actual === null) {
                warnings.push(`bundle declares a "${layer}" layer for session "${session.slug}" (${session.sessionId}) but does not contain it — those files are missing from this import.`);
                continue;
            }
            if (actual !== declared) {
                failedLayers.add(`${session.sessionId}\0${layer}`);
                warnings.push(`integrity check failed for the "${layer}" files of session "${session.slug}" (${session.sessionId}): they don't match the manifest digest, so they were NOT copied. The transcript itself imported normally.`);
            }
        }
    }
    // Step 3b, and it is a DECISION not to act: `manifest.memoryDigest` is NOT
    // verified here, and that is deliberate rather than an omission (#59 item 2).
    // Written down so the next reader does not re-litigate it.
    //
    // The gate above exists because of what those three layers DO after they land:
    // a file-history backup is later restored over the user's own file by Claude
    // Code, so a backup that cannot be shown to be the backup that was taken has no
    // business being written where something may restore it. `memory/` has no such
    // actuator — nothing consumes it but a human or a model reading markdown — and
    // the reconciliation it feeds is non-destructive BY CONSTRUCTION, verified
    // rather than assumed:
    //
    //  - `unionMemoryIndex` emits the local index verbatim. Every return path of
    //    `appendIndexLines` is either `text` unchanged or `text` with an insertion
    //    spliced in; no local byte is removed or rewritten, and an appended line is
    //    one incoming `raw` line, which is newline-free by construction, so a
    //    corrupt index cannot split or forge a local line.
    //  - A prose memory is copied only when the destination can be CREATED, and a
    //    conflicting one is parked through `copyToUniqueName`'s exclusive create
    //    — which cannot overwrite. Same for `plans/`, minus the parking. That first
    //    clause used to read "does not exist" and was tested with `existsSync`,
    //    which follows symlinks: a dangling link at the destination reported
    //    absent and the copy wrote THROUGH it, out of the directory entirely
    //    (#64). It is now the exclusive write itself that answers — see
    //    `copyIfAbsent` — so the premise this decision rests on is enforced by
    //    the same flag on all three destinations rather than by a check in front
    //    of them.
    //  - So the worst a damaged payload achieves is a bad NEW file, a bad parked
    //    copy, and a bad index line pointing at one — all of them named in the
    //    result's typed fields (`memoryIndex.added`/`unindexed`, `memoryConflicts`),
    //    on `pull` and `migrate` as well as `import` since #59 item 3. Visible and
    //    reversible, where a bad file-history entry is neither.
    //
    // The exposure is also narrower than it looks. An archive bundle's damage is
    // already caught upstream — gzip's CRC32 and zstd's XXH64 frame checksum both
    // make a truncated or bit-flipped archive throw out of extraction (archiver.ts)
    // — and every hub bundle is a `bundle.tar.gz` (hub/push.ts), so no hub pull
    // reaches this code with silently damaged bytes. What remains is a DIRECTORY
    // export damaged in place, and a hand-made `--no-check` `.tar.zst` this plugin
    // refuses to produce: both chosen by hand, on this machine.
    //
    // The cost of acting is real, and it is #49's defect coming back: a whole-layer
    // gate means one flipped byte in one memory file withholds the entire memory
    // layer INCLUDING the index union, which is the one edit that makes the other
    // machine's memories reachable at all.
    //
    // REVISIT THIS if either premise moves: if any path here starts overwriting a
    // file the target already had, or if a memory payload gains a consumer that
    // acts on it without a human reading it. Then the check belongs right here,
    // beside the loop above, and `manifest.memoryDigest` is what it compares
    // against `computeLayerDigest(join(exportPath, "memory"))`.
    // Generate new session IDs
    const sessionIdMap = new Map();
    for (const session of targetSessions) {
        sessionIdMap.set(session.sessionId, randomUUID());
    }
    const importedSessions = targetSessions.map((session) => ({
        originalId: session.sessionId,
        newId: sessionIdMap.get(session.sessionId),
        slug: session.slug,
        messageCount: session.messageCount,
    }));
    // For dry-run, return the report without writing anything
    if (dryRun) {
        let rewriteReport;
        const firstSession = targetSessions[0];
        const firstJsonlPath = join(exportPath, "sessions", `${firstSession.sessionId}.jsonl`);
        if (existsSync(firstJsonlPath)) {
            rewriteReport = await rewriteJsonlStream(firstJsonlPath, null, ctx, { newSessionId: sessionIdMap.get(firstSession.sessionId) });
        }
        // The preview is produced by the SAME function the real run executes,
        // called in plan mode — never by a parallel preview implementation. That is
        // exactly how `rewriteReport` drifted (it previews one session and the doc
        // says "path rewrites", plural).
        const shared = reconcileSharedLayers({
            exportPath,
            targetProjectDir,
            targetConfigDir,
            sourceMachineName: manifest.sourceMachineName,
            plan: true,
        });
        return {
            success: true,
            command: "import",
            dryRun: true,
            importedSessions,
            skippedSessions,
            warnings: [...warnings, ...shared.warnings],
            resumable: true,
            rewriteReport,
            versionAdaptations: adapters.map((a) => a.description),
            memoryPlan: shared.memoryPlan,
            memoryDir: shared.memoryDir,
            planConflicts: shared.planConflicts.length > 0 ? shared.planConflicts : undefined,
        };
    }
    // Step 4: Write session files
    mkdirSync(targetProjectDir, { recursive: true });
    // Helper: remove only the files written by this import (targeted rollback)
    const rollbackImportedFiles = () => {
        for (const [, newId] of sessionIdMap) {
            // Remove new session JSONL file
            const jsonlFile = join(targetProjectDir, `${newId}.jsonl`);
            if (existsSync(jsonlFile))
                rmSync(jsonlFile, { force: true });
            // Remove new session subdirectory (subagents, tool-results)
            const sessionSubDir = join(targetProjectDir, newId);
            if (existsSync(sessionSubDir))
                rmSync(sessionSubDir, { recursive: true, force: true });
            // Remove new file-history directory
            const fhDir = join(targetConfigDir, "file-history", newId);
            if (existsSync(fhDir))
                rmSync(fhDir, { recursive: true, force: true });
        }
    };
    const postRewriteHashes = new Map();
    try {
        for (const [sessionIndex, session] of targetSessions.entries()) {
            const newSessionId = sessionIdMap.get(session.sessionId);
            /** Verified in step 3; a mismatch means the files are not written at all. */
            const layerOk = (layer) => !failedLayers.has(`${session.sessionId}\0${layer}`);
            // Rewrite and write JSONL
            const jsonlPath = join(exportPath, "sessions", `${session.sessionId}.jsonl`);
            {
                const bytesTotal = statSync(jsonlPath).size;
                const throttled = onProgress
                    ? percentThrottle(bytesTotal, (percent, bytesProcessed) => onProgress({
                        phase: "import-rewrite",
                        sessionId: session.sessionId,
                        sessionIndex,
                        sessionCount: targetSessions.length,
                        bytesProcessed,
                        bytesTotal,
                        percent,
                    }))
                    : undefined;
                const streamReport = await rewriteJsonlStream(jsonlPath, join(targetProjectDir, `${newSessionId}.jsonl`), ctx, { adapters, newSessionId, computeHash: true, onProgress: throttled });
                versionAdaptations.push(...streamReport.adaptationsApplied);
                postRewriteHashes.set(session.sessionId, streamReport.outputHash);
                // Strict-validation semantics (previously a post-write re-read in
                // Step 6): an unparseable line in a session that PASSED the integrity
                // check indicates corruption the hash didn't catch or a pipeline bug —
                // hard-fail and roll back. Known-corrupt sessions already warned.
                if (streamReport.parseFailures > 0 &&
                    !integrityFailedSessions.has(session.sessionId)) {
                    try {
                        rollbackImportedFiles();
                    }
                    catch {
                        /* best effort cleanup */
                    }
                    return {
                        success: false,
                        command: "import",
                        error: `Import validation failed: session "${session.slug}" contains ${streamReport.parseFailures} unparseable JSONL line(s) after rewrite`,
                        details: "Partially written session files have been cleaned up. No indexes were modified.",
                        // This used to advise `--no-register`, and that advice was
                        // impossible: MEASURED, a second run with noRegister:true returns
                        // this identical object. The gate above reads only
                        // `streamReport.parseFailures` and `integrityFailedSessions` —
                        // `noRegister` is consulted in the dedup filters above and in the
                        // registration step BELOW this return, never here. The flag skips
                        // the session-index entry; it has nothing to say about a rewrite
                        // that produced unparseable JSONL. Naming no flag is the honest
                        // form (issue #45's tenth instance, found by the retry-works proof
                        // requirement in tests/hub-warning-flags.test.ts, not by reading
                        // the sentence).
                        suggestion: "The rewritten JSONL does not parse, so no import option changes the outcome: re-export the session from the source machine, or check the bundle for corruption in transit.",
                    };
                }
            }
            // Copy subagents
            const subagentsDir = join(exportPath, "sessions", session.sessionId, "subagents");
            if (existsSync(subagentsDir) && layerOk("subagents")) {
                const targetSubDir = join(targetProjectDir, newSessionId, "subagents");
                mkdirSync(targetSubDir, { recursive: true });
                for (const file of readdirSync(subagentsDir)) {
                    if (file.endsWith(".jsonl")) {
                        // Rewrite subagent JSONL too (never applies version adapters).
                        await rewriteJsonlStream(join(subagentsDir, file), join(targetSubDir, file), ctx, { newSessionId });
                    }
                    else {
                        copyFileSync(join(subagentsDir, file), join(targetSubDir, file));
                    }
                }
            }
            // Copy tool results
            const toolResultsDir = join(exportPath, "sessions", session.sessionId, "tool-results");
            if (existsSync(toolResultsDir) && layerOk("tool-results")) {
                const targetTrDir = join(targetProjectDir, newSessionId, "tool-results");
                mkdirSync(targetTrDir, { recursive: true });
                for (const file of readdirSync(toolResultsDir)) {
                    copyFileSync(join(toolResultsDir, file), join(targetTrDir, file));
                }
            }
            // Copy file history
            const fileHistoryDir = join(exportPath, "file-history", session.sessionId);
            if (existsSync(fileHistoryDir) && layerOk("file-history")) {
                const targetFhDir = join(targetConfigDir, "file-history", newSessionId);
                mkdirSync(targetFhDir, { recursive: true });
                for (const file of readdirSync(fileHistoryDir)) {
                    copyFileSync(join(fileHistoryDir, file), join(targetFhDir, file));
                }
            }
        }
    }
    catch (writeErr) {
        // Mid-write failure: roll back only what this import created
        try {
            rollbackImportedFiles();
        }
        catch {
            /* best effort cleanup */
        }
        return {
            success: false,
            command: "import",
            error: `Import write failed: ${writeErr.message}`,
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
        }
        else {
            const existing = readLocalProjectId(targetProjectPath);
            if (!existing) {
                writeLocalProjectId(targetProjectPath, {
                    projectId: manifest.projectId,
                    name: manifest.sourceProjectPath.split(/[\\/]/).filter(Boolean).pop() ??
                        "project",
                    createdAt: new Date().toISOString(),
                    createdByMachine: manifest.sourceMachineId ?? "unknown",
                });
            }
            else if (existing.projectId !== manifest.projectId) {
                warnings.push(`Bundle carries project id ${manifest.projectId} but this project is already ${existing.projectId} — kept existing.`);
            }
        }
    }
    // Step 5: Reconcile the shared-namespace layers (memory, plans). Stays here,
    // after the session writes and their rollback, so a failed import leaves the
    // user's memory folder untouched.
    const shared = reconcileSharedLayers({
        exportPath,
        targetProjectDir,
        targetConfigDir,
        sourceMachineName: manifest.sourceMachineName,
        plan: false,
    });
    warnings.push(...shared.warnings);
    // Step 7: Register in indexes (only after successful validation)
    if (!noRegister) {
        const historyPath = join(targetConfigDir, "history.jsonl");
        for (const session of targetSessions) {
            const newSessionId = sessionIdMap.get(session.sessionId);
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
        const newId = sessionIdMap.get(session.sessionId);
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
        const peer = state.peers[peerId];
        peer.name = peerName;
        peer.lastReceivedAt = new Date().toISOString();
        for (const session of targetSessions) {
            const newId = sessionIdMap.get(session.sessionId);
            const type = session.type === "continuation" ? "continuation" : "full";
            const received = {
                localSessionId: newId,
                type,
                importedAt: new Date().toISOString(),
            };
            peer.received[session.sessionId] = received;
            const lineage = {
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
            const sent = {
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
        ...sharedFindings(shared),
    };
}
//# sourceMappingURL=importer.js.map