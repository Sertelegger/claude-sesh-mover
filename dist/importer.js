import { mkdirSync, readFileSync, readdirSync, existsSync, copyFileSync, appendFileSync, lstatSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readManifest, computeIntegrityHash, computeIntegrityHashFromFile, computeLayerDigest, verifySessionsDigest, isSafeSessionId, } from "./manifest.js";
import { rewriteJsonlStream, buildImportRewriteContext } from "./rewriter.js";
import { encodeProjectPath } from "./platform.js";
import { getApplicableAdapters, classifyVersionDifference, } from "./version-adapters.js";
import { foreignKeyedRecord, readSyncState, writeSyncState } from "./sync-state.js";
import { readLastEntryUuid } from "./jsonl.js";
import { percentThrottle } from "./progress.js";
import { readLocalProjectId, writeLocalProjectId } from "./hub/identity.js";
import { unpackWorkspace } from "./payload/workspace.js";
import { applyCarry, normalizeCarryMeta, orNotRecorded, } from "./payload/carry.js";
import { isReadableDir } from "./hub/fs-probe.js";
import { IGNORE_FILE_NAME, INCLUDE_FILE_NAME, isPluginStateName } from "./paths.js";
import { MEMORY_INDEX_NAME, appendIndexLines, formatMemoryPointer, memoryIndexTargets, unionMemoryIndex, } from "./memory-index.js";
import { MAX_SIDECAR_ATTEMPTS, copyToNewFile, copyToUniqueName } from "./sidecar.js";
/**
 * QUOTING — every bundle-supplied string echoed into a message in this file is
 * wrapped in `JSON.stringify`, never in a hand-written `"${…}"`.
 *
 * The rule is `hub/index-file.ts`'s, applied here rather than re-invented:
 * quoting is what escapes the control characters that let a name redraw the
 * line it is printed on. The transport cannot be the defence — a `warnings`
 * entry rides out as JSON, where a newline is `\n` and corrupts nothing, and
 * then `commands/import.md` relays it into markdown for a human. That relay is
 * the sink, and it is the same one #79 closed for `MEMORY.md` pointer lines;
 * these messages were the sibling class that fix deliberately left alone.
 *
 * Two things make the swap cheap, and both are why the manual quotes were not
 * already good enough:
 *
 *  - `JSON.stringify` SUPPLIES the surrounding quotes, so `"${file}"` becomes
 *    `${JSON.stringify(file)}` and not a double-quoted string. For an ordinary
 *    filename the rendered output is byte-identical — which is why converting
 *    the whole class required changing NO existing assertion, and why leaving
 *    the sites bare bought nothing in the first place.
 *  - It is the only form that also escapes `"` itself, so a name carrying a
 *    quote can no longer close the quotes the message opened.
 *
 * Two sites here are NOT byte-identical for ordinary input, deliberately: the
 * park failure quotes the OS error text (which repeats the name), and the
 * version-skew warning quotes a manifest version string that had no quotes at
 * all. Both are argued at their own site.
 *
 * Applies to: a filename read out of the bundle's `memory/` or `plans/`, a name
 * derived from one (`parkedAs`), `manifest.sessions[].slug`, and
 * `manifest.sourceClaudeVersion`/`sourceMachineName`. It does NOT apply to a
 * value this machine produced (a target path, a minted session id, a config-dir
 * path) or to an id `assertSafeManifestIds`/`isSafeSessionId` has already
 * cleared — quoting those would assert a distrust that is not there, and the
 * next reader would have to re-derive why.
 */
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
        plansSkipped: shared.plansSkipped,
        memorySkipped: shared.memorySkipped,
        // The ONE field this projection does not apply the empty-is-absent rule to,
        // and the exception is the point (#36). Every other field here answers
        // "did something notable happen"; this one is a consent gate's INPUT, and
        // an absent write set and an empty one are the same JSON — so a reader
        // could not tell "nothing lands outside the session" from "nobody asked".
        // Always present, `total: 0` when there is nothing.
        writeSet: shared.writeSet,
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
 * How a BUNDLE's shared-layer ROOT (`memory/`, `plans/`) presents itself.
 *
 * `lstatSync`, never `existsSync`, and that distinction is the whole of #68's
 * first half. #64 closed every per-FILE read with `isRegularFile` and every
 * destination write with an exclusive create, but the two probes that decide
 * whether to WALK a layer at all still resolved links — so a directory-form
 * bundle whose `memory/` was itself a symlink to, say, `~/.ssh` had its real
 * files enumerated and copied into the target's memory folder, under names of
 * the attacker's choosing, in the one directory a later session reads prose
 * out of and can then repeat. A read-side gather rather than a write outside
 * the tree, and none the better for it.
 *
 * Same bound as `isRegularFile`: `archiver.ts` rejects symlink and hardlink
 * tar entries at extraction, so every hub bundle (`bundle.tar.gz`) is already
 * immune and the case this closes is a hand-placed DIRECTORY-form bundle.
 *
 * `"symlink"` is refused rather than followed, and it deliberately covers a
 * DANGLING link too — `existsSync` answered "absent" for one and said nothing
 * at all, which is the same silence #68's second half is about.
 */
function layerRootStatus(path) {
    try {
        return lstatSync(path).isSymbolicLink() ? "symlink" : "present";
    }
    catch {
        return "absent";
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
    const includePlans = opts.includePlans === true;
    const includeMemory = opts.noMemory !== true;
    const sourceName = opts.sourceMachineName ?? "another machine";
    const warnings = [];
    const memoryConflicts = [];
    const planConflicts = [];
    const memoryPlan = [];
    let memoryIndex;
    let reportedMemoryDir;
    let plansSkipped;
    let memorySkipped;
    /**
     * THE WRITE SET (#36) — every path this step writes outside the session id
     * the import minted, recorded AT THE SITE THAT DECIDES IT.
     *
     * Completeness is the whole value, so it is structural rather than asserted.
     * Two properties do the work:
     *
     *  - **Recorded where the verdict is taken**, never by a second walk over the
     *    bundle. A second walk is a second implementation of "what will be
     *    written", and this module already carries the argument for why there is
     *    exactly one (`memoryPlan` in plan mode is the run's own function, not a
     *    preview of it). So a branch that writes and forgets to record is a
     *    branch that also forgot its verdict, which is visible in review.
     *  - **The preview and the run share it.** `plan: true` runs the same code
     *    with the writes suppressed, so a disclosure the gate shows and the bytes
     *    the run lands come off one set of decisions.
     *
     * What that still cannot catch is a *new* write added without a record, which
     * is why `tests/importer.test.ts` diffs the target config dir across a real
     * import and asserts the created files are exactly this set.
     */
    const writeEntries = [];
    const writeRoots = [];
    const recordWrite = (layer, path, kind) => {
        // `display` is computed HERE and never by the consumer: the final segment
        // is a bundle-chosen basename, and the sink is a markdown list in
        // `commands/import.md`. See `WriteSetEntry` in types.ts, and QUOTING at the
        // top of this file for the rule it follows.
        writeEntries.push({ layer, path, display: JSON.stringify(path), kind });
    };
    const memoryDir = join(exportPath, "memory");
    // `layerRootStatus`, not `existsSync`: the probe that decides whether to walk
    // this layer must not resolve a link (#68). A symlinked root is refused and
    // SAID — never enumerated, and never passed over in silence.
    const memoryRoot = layerRootStatus(memoryDir);
    if (memoryRoot === "symlink") {
        warnings.push(`The memory folder in this bundle is a symlink, not a directory — nothing was read through it, and nothing in your memory folder was changed.`);
    }
    // OPT-OUT, where `plans/` below is opt-in. Both halves are DISCLOSED either
    // way — silence about a payload we chose not to write is what makes a flag
    // feel like a bug — and both count the files rather than reporting a boolean,
    // because "this bundle wanted to write 14 files here" is a different sentence
    // from "it wanted to write 1".
    if (memoryRoot === "present" && !includeMemory) {
        writeRoots.push({
            layer: "memory",
            path: join(targetProjectDir, "memory"),
            scope: "project",
            applied: false,
            // Enumerated in full: this layer is a handful of files, and one of its
            // kinds edits a file the user already had.
            enumerated: true,
        });
        try {
            // Names only: the root is not a symlink (checked above), no file in it is
            // opened, and nothing is written.
            memorySkipped = readdirSync(memoryDir).filter((f) => isRegularFile(join(memoryDir, f))).length;
        }
        catch {
            memorySkipped = undefined;
        }
        if (memorySkipped !== undefined && memorySkipped > 0) {
            warnings.push(`This bundle carries ${memorySkipped} memory file(s), and they were NOT written, because \`sesh-mover import --no-memory\` was passed. Every one of them is still in the bundle, so nothing was consumed by declining: re-run the same import without that flag to land them.`);
        }
    }
    if (memoryRoot === "present" && includeMemory) {
        try {
            const targetMemDir = join(targetProjectDir, "memory");
            reportedMemoryDir = targetMemDir;
            writeRoots.push({
                layer: "memory",
                path: targetMemDir,
                scope: "project",
                applied: true,
                // Enumerated in full: a handful of files, and one kind edits a file
                // the user already had.
                enumerated: true,
            });
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
            //
            // Captured rather than re-asked, because the write set needs the answer
            // as it stood BEFORE this import: it is what separates `create` from
            // `index-append`, i.e. whether the user already had the one file in this
            // layer that a write modifies rather than adds.
            const indexExistedBefore = pathIsTaken(indexPath);
            if (indexExistedBefore)
                readLocalIndex();
            let indexChanged = false;
            /** Does `indexPath` get written at all, by any of the three routes? */
            let indexWillBeWritten = false;
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
                        // Route 1 of 3 to a written index: the bundle's own MEMORY.md
                        // landing on a free name. Recorded once, at the end of this block,
                        // so the three routes cannot produce three entries for one path.
                        indexWillBeWritten = true;
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
                    // `JSON.stringify`, not a hand-written `"${file}"` — see QUOTING at
                    // the top of this file. Identical output for an ordinary name.
                    warnings.push(`Ignored ${JSON.stringify(file)} in the bundle's memory folder — it is not a regular file.`);
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
                    recordWrite("memory", dst, "create");
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
                    warnings.push(`Memory file ${JSON.stringify(file)} could not be compared with the incoming copy — kept the existing version.`);
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
                            // BOTH halves are quoted, and the second one is the reason this
                            // site is not just `JSON.stringify(file)`. `copyToUniqueName`
                            // throws with the destination PATH in its message, and that path
                            // is built from `file` — so quoting the name and leaving the OS
                            // text bare would escape one copy of a hostile name and print the
                            // other verbatim, which fixes nothing. It is the only interpolated
                            // OS error message in this file whose text demonstrably carries a
                            // bundle-chosen name; the rest name a local path (the config dir,
                            // the project dir, MEMORY.md) and stay unquoted for that reason.
                            warnings.push(`Could not park the incoming copy of ${JSON.stringify(file)} (${JSON.stringify(e.message)}).`);
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
                    warnings.push(`Memory file ${JSON.stringify(file)} differs from the incoming copy — kept yours, and the incoming copy could NOT be saved beside it. It is only in the bundle.`);
                    continue;
                }
                memoryPlan.push({ filename: file, verdict: "park", parkedAs });
                // `!reusedParked` is load-bearing, not a tidy-up: a reused park is a
                // copy that was ALREADY on disk with these exact bytes (a chain pull
                // re-applying an unchanged memory), so nothing is written for it and
                // listing it would put a path in the write set that the run does not
                // touch. The set has to be exactly the writes, in both directions.
                if (!reusedParked)
                    recordWrite("memory", join(targetMemDir, parkedAs), "park");
                memoryConflicts.push({ filename: file, existingHash, incomingHash, parkedAs });
                warnings.push(reusedParked
                    ? `Memory file ${JSON.stringify(file)} differs from the copy in this bundle — kept yours; theirs was already saved here as ${JSON.stringify(parkedAs)}.`
                    : `Memory file ${JSON.stringify(file)} differs from the copy in this bundle — kept yours and saved theirs as ${JSON.stringify(parkedAs)} (listed in ${MEMORY_INDEX_NAME}). Nothing was overwritten.`);
                // One pointer per parked file, ever: keyed off the index's own targets,
                // so a reused copy adds no second line and a user who deleted the line
                // by hand gets it back rather than a duplicate.
                //
                // EVERY argument below is bundle-supplied and validated by nothing:
                // `stem` and `parkedAs` derive from a filename inside the bundle, and
                // `sourceName` is the manifest's self-declared machine name. Raw
                // interpolation here let any of them carry a newline and append
                // arbitrary entries to the user's index — `formatMemoryPointer` is the
                // chokepoint that closed it, and `null` is its answer for a target it
                // cannot express as a link. See memory-index.ts for why the target is
                // refused rather than escaped.
                const base = indexText ?? "";
                if (indexUsable && !memoryIndexTargets(base).includes(parkedAs)) {
                    const pointer = formatMemoryPointer(`${stem} (incoming copy)`, parkedAs, `incoming version of ${file} from ${sourceName} — differs from your copy, not merged`);
                    if (pointer === null) {
                        // The parked copy is on disk and named in `memoryConflicts`, so it
                        // is not lost — only unreferenced, which is the same outcome
                        // `memoryIndex.unindexed` already reports for a file the sender
                        // never indexed. Better than the alternative the raw template gave:
                        // a line whose key does not read back as `parkedAs`, so this very
                        // check misses it and appends another copy on EVERY later import.
                        // `JSON.stringify`, per QUOTING at the top of this file — which now
                        // covers the warnings above it too. This site was the FIRST to
                        // adopt it (#79) because it is the one message guaranteed to
                        // interpolate a hostile string: the branch is reached precisely
                        // because the name carries something a markdown link cannot hold.
                        // The others were left bare on the argument that their names are
                        // ordinary in every ordinary case, which is an argument about the
                        // usual input rather than about the message — so they are quoted
                        // now as well, at no cost, since the rendering of an ordinary name
                        // is identical either way.
                        warnings.push(`Saved the incoming copy of ${JSON.stringify(file)} beside yours as ${JSON.stringify(parkedAs)}, but could not list it in ${MEMORY_INDEX_NAME}: that name cannot be written as a markdown link target. The file is on disk (see memoryConflicts) and your index was not changed.`);
                    }
                    else {
                        const next = appendIndexLines(base, [pointer]);
                        if (next !== base) {
                            indexText = next;
                            indexChanged = true;
                        }
                    }
                }
            }
            // ONE boolean decides both the write and its disclosure. Route 2 (the
            // union appended entries) and route 3 (a parked copy needed a pointer and
            // there was no index) both land here, and both are `indexChanged`.
            const indexNeedsWrite = indexUsable && indexChanged && indexText !== null;
            if (indexNeedsWrite)
                indexWillBeWritten = true;
            if (indexWillBeWritten) {
                // `create` vs `index-append` is decided by whether the user ALREADY had
                // this file, which is the only distinction that matters to someone
                // being asked to consent: one of these adds a file, the other edits the
                // file that decides what a future session reads.
                recordWrite("memory", indexPath, indexExistedBefore ? "index-append" : "create");
            }
            if (!plan && indexNeedsWrite) {
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
                    // `indexText!`: the null check moved into `indexNeedsWrite` above, so
                    // the narrowing is no longer inline. Same idiom as `unionMemoryIndex`
                    // higher in this block.
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
                // Quoted PER ELEMENT, then joined — not `unindexed.join(", ")` with the
                // whole thing quoted, and not left bare. The separator is the second
                // defect here and it is independent of the control characters: `, ` is
                // a legal filename substring, so an unquoted join renders one file
                // named `a, b.md` and two files named `a` and `b.md` identically, and
                // the reader has no way to tell which they are looking at. Quoting each
                // element fixes the ambiguity and the escaping in one move. The count
                // in front stays authoritative either way.
                warnings.push(`${unindexed.length} memory file(s) in this bundle are listed in no index and landed unreferenced: ${unindexed
                    .map((f) => JSON.stringify(f))
                    .join(", ")}.`);
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
    // Same rule as the memory root above, and it bites harder here: `plans/` is
    // config-dir-GLOBAL, so files gathered through a symlinked bundle root land
    // in a directory every project on this machine shares.
    const plansRoot = layerRootStatus(plansDir);
    if (plansRoot === "symlink") {
        warnings.push(`The plans folder in this bundle is a symlink, not a directory — nothing was read through it, and nothing in your plans folder was changed.`);
    }
    // OPT-IN, and the asymmetry with `memory/` is the point (#74). A memory lands
    // in the target PROJECT's own directory; a plan lands in `<configDir>/plans`,
    // which every project on this machine shares — so accepting one writes
    // machine-global files on the say-so of a bundle that may have come from
    // anywhere. CLAUDE.md already records the send-side half of this decision
    // ("`plans/` deliberately does NOT travel to the hub … fix the payload's
    // scope before widening its transport"); the receive side has the same scope
    // problem and now the same answer. The layer is disclosed either way: silence
    // about a payload we chose not to write is what makes an opt-in feel like a
    // bug.
    if (plansRoot === "present" && !includePlans) {
        writeRoots.push({
            layer: "plans",
            path: join(targetConfigDir, "plans"),
            scope: "machine",
            applied: false,
            // Enumerated in full: this layer is a handful of files, and one of its
            // kinds edits a file the user already had.
            enumerated: true,
        });
        try {
            // Safe to enumerate: the root is not a symlink (checked above), and this
            // reads names only — no file in it is opened and nothing is written.
            plansSkipped = readdirSync(plansDir).filter((f) => isRegularFile(join(plansDir, f))).length;
        }
        catch {
            plansSkipped = undefined;
        }
        if (plansSkipped !== undefined && plansSkipped > 0) {
            warnings.push(`This bundle carries ${plansSkipped} plan file(s), and they were NOT written. Plans go to ${join(targetConfigDir, "plans")}, a directory every project on this machine shares, so an import writes them only when asked: re-run with \`sesh-mover import --include-plans\` if you want them.`);
        }
    }
    if (plansRoot === "present" && includePlans) {
        try {
            const targetPlansDir = join(targetConfigDir, "plans");
            // `scope: "machine"` is the whole reason this layer is opt-in, and the
            // gate has to be able to SAY it rather than infer it from the path.
            writeRoots.push({
                layer: "plans",
                path: targetPlansDir,
                scope: "machine",
                applied: true,
                // Enumerated in full: a handful of files, and one kind edits a file
                // the user already had.
                enumerated: true,
            });
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
                if (copied) {
                    recordWrite("plans", dst, "create");
                    continue;
                }
                const existingContent = readTextFile(dst);
                const newContent = readTextFile(src);
                // #68's second half. This used to fold "one of the two could not be
                // read" into the identical-bytes `continue`, so a plans destination the
                // exclusive create refused and the read then could not open — a dangling
                // symlink, a directory in its place, a permission problem — delivered
                // nothing and reported NOTHING: no warning, no `planConflicts` entry,
                // no field in the result the skill layer branches on since #59. The
                // memory side already warns in exactly this situation; the asymmetry
                // was not a decision, it is what the older check-then-write shape
                // happened to produce.
                //
                // A warning and NOT a `planConflicts` entry, matching the memory side
                // rather than out-doing it: an `AuxiliaryConflict` asserts that the two
                // copies differ and carries a hash of each, and here at least one of
                // them could not be read at all — so both the claim and the hashes
                // would have to be invented.
                if (existingContent === null || newContent === null) {
                    warnings.push(`Plan ${JSON.stringify(file)} could not be compared with the incoming copy — kept the existing version, and the incoming plan was not written (it is only in the bundle).`);
                    continue;
                }
                if (existingContent === newContent)
                    continue;
                planConflicts.push({
                    filename: file,
                    existingHash: computeIntegrityHash([existingContent]),
                    incomingHash: computeIntegrityHash([newContent]),
                });
                warnings.push(`Plan ${JSON.stringify(file)} already exists here with different content — kept yours. The incoming plan was not written and is only in the bundle (see planConflicts).`);
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
        plansSkipped,
        memorySkipped,
        // `total` is `entries.length` because nothing truncates the enumeration
        // here. It is a separate field anyway, so a bounded PRESENTATION (see
        // `commands/import.md` step 8) takes its "and N more" from the data rather
        // than from counting a list it has already cut down — and so a future
        // payload class that does truncate has somewhere honest to put the count.
        writeSet: { total: writeEntries.length, entries: writeEntries, roots: writeRoots },
    };
}
// ---------------------------------------------------------------------------
// THE FILE PAYLOAD, APPLY SIDE (#47)
// ---------------------------------------------------------------------------
/**
 * Cap on how many WORKSPACE paths a write set enumerates.
 *
 * A workspace payload is a whole project tree and is routinely thousands of
 * files, where `memory/` and `plans/` are a handful each. Emitting one entry
 * per file would put megabytes of JSON on stdout for the skill layer to parse,
 * so the enumeration is bounded — and `WriteSet.total` stays the TRUE count of
 * paths that will be written, which is the field `commands/import.md` takes its
 * "and N more" from. That contract was written down before this feature existed
 * (see `WriteSet.total`) precisely so the bound would land somewhere honest.
 *
 * The memory and plans entries are NEVER truncated: they are few, and one of
 * their kinds (`index-append`) modifies a file the user already had, which the
 * gate is required to show in full.
 */
const MAX_WORKSPACE_WRITE_ENTRIES = 200;
/**
 * What a caller that does not handle file payloads contributes: nothing, in
 * every field. Distinct from "handled and found nothing" only in that it is
 * never reached — which is the point, since `hub pull` and `migrate` both go
 * through `importSession` and neither may emit a word about these payloads.
 */
function emptyPayloadReport() {
    return {
        warnings: [], writeEntries: [], writeRoots: [],
        workspacePathCount: 0, workspaceWriteCount: 0,
    };
}
/**
 * Apply — or preview, or decline — the two FILE payloads a bundle can carry.
 *
 * ## Bootstrap, not sync, and the difference is enforced rather than intended
 *
 * `hub pull` needs a 3-way merge, ancestor selection (`chooseMergeAncestor`) and
 * a divergence policy because two machines drift apart over repeated syncs.
 * export -> import is the BOOTSTRAP case: a bundle is handed over once. So none
 * of that is here, and none of it is deferred either —
 *
 *  - no `mergeWorkspaceTrees`: a non-empty target REFUSES (see the precondition
 *    in `importSession`) rather than being merged into. If a user wants merge
 *    semantics they want the hub.
 *  - no `chooseMergeAncestor`, and nothing is recorded into
 *    `SyncState.hub.workspaceGenerations` / `lastWorkspace`. A generation is
 *    identified by a HUB BUNDLE ID and is the one input `chooseMergeAncestor`
 *    treats as proof that a tree really held it; recording an id no hub bundle
 *    has would put a lie in that set. The visible consequence — a later hub pull
 *    into this project merges in no-ancestor mode — is correct, and no-ancestor
 *    mode fails toward "keep local + visible conflicts".
 *  - no `--on-divergence`: it was never a workspace concern (it is a SESSIONS
 *    policy), and a bootstrap import mints a fresh session id per session and
 *    never splices.
 *
 * ## Where this deliberately differs from the pull stage
 *
 * **A carry the user did not ask to apply is NOT saved into their project.**
 * `pull-apply-carry.ts` runs `applyCarry` with `saveOnly: true` when
 * `--apply-carry` is absent, and it is right to: by the time that stage runs the
 * pull has recorded its bundles as received, the extraction directory is about
 * to be deleted, and a re-run answers "already up to date" — there is no second
 * chance, so parking the payload beside the project is the only way not to
 * destroy another machine's work.
 *
 * None of that holds here. The bundle is a FILE THE USER HAS: a directory
 * export, or an archive that `--from` re-extracts on demand. Re-running
 * `sesh-mover import --from <same bundle> --apply-carry` reaches this payload
 * even when every session is now a duplicate, because the fully-duplicate branch
 * of `importSession` calls this function too — the same shape #53 established
 * for the memory layer. So the pull's argument for writing an unrequested
 * payload into the user's project inverts into #36's: writing files a user
 * declined, into a directory they own, is exactly what the opt-in exists to
 * prevent. Nothing is written; `carryAvailable` says what the bundle holds.
 *
 * ## `plan` mode
 *
 * Same function, writes suppressed — the rule `reconcileSharedLayers` follows,
 * for the same reason: the write set the consent gate shows and the bytes the
 * run lands have to come off ONE set of decisions. `unpackWorkspace`'s own
 * `plan` option is what makes that true for the workspace half rather than a
 * second walk predicting it.
 */
async function reconcilePayloadLayers(opts) {
    const { exportPath, targetProjectPath, applyWorkspace, forceWorkspace, plan, } = opts;
    const warnings = [];
    const writeEntries = [];
    const writeRoots = [];
    const report = {
        warnings, writeEntries, writeRoots, workspacePathCount: 0, workspaceWriteCount: 0,
    };
    const incomingDir = join(exportPath, "workspace");
    // `isReadableDir`, not `existsSync`: a bundle whose `workspace` entry is a
    // FILE reaches the same `readdirSync` and throws ENOTDIR — the identical
    // terminal shape the pull stage's own guard exists to close, and here it would
    // land AFTER the sessions were written.
    const hasWorkspacePayload = isReadableDir(incomingDir);
    if (opts.declaresWorkspace && !hasWorkspacePayload) {
        report.workspaceDeclaredMissing = true;
        warnings.push("The bundle's manifest declares a workspace payload but the bundle does not contain one, so there was nothing to apply and this project's files were left untouched. It was written by an older sesh-mover whose snapshot carried no files, damaged in transit, or not produced by sesh-mover at all.");
    }
    if (hasWorkspacePayload) {
        const entries = existsSync(targetProjectPath) ? readdirSync(targetProjectPath) : [];
        // Plugin state is not content — an import plants `.sesh-mover-project.json`
        // into the project root when the bundle carries an id, and that metadata
        // alone must not make the next import read the directory as occupied.
        // `isPluginStateName` rather than one literal, for the reason its own doc
        // gives.
        const hasRealContent = entries.some((n) => !isPluginStateName(n));
        writeRoots.push({
            layer: "workspace",
            path: targetProjectPath,
            scope: "project",
            applied: applyWorkspace,
            enumerated: true,
        });
        try {
            const ws = await unpackWorkspace(incomingDir, targetProjectPath, {
                // In `plan` mode nothing is written, so `force` decides nothing — it is
                // passed as `true` only to keep the emptiness THROW out of a preview.
                // The real run's emptiness decision is the precondition in
                // `importSession`, taken before a single byte is written, so this call
                // can never reach the throw either.
                force: plan || forceWorkspace || !hasRealContent,
                // The declined case still WALKS the payload, to count it. That count is
                // the disclosure — "this bundle wanted to write 1,412 files into your
                // project" is a different sentence from "it wanted to write 3" — and it
                // is the same reason `plansSkipped`/`memorySkipped` are counts.
                plan: plan || !applyWorkspace,
                onFile: (relPath, existing) => {
                    report.workspacePathCount++;
                    // A DECLINED layer contributes nothing to the write set — not an
                    // entry, not a count. The set is what this run writes, and a declined
                    // layer writes nothing; what it contributes instead is
                    // `workspaceSkipped`, the same split `plansSkipped` makes.
                    if (!applyWorkspace)
                        return;
                    report.workspaceWriteCount++;
                    if (writeEntries.length >= MAX_WORKSPACE_WRITE_ENTRIES)
                        return;
                    const abs = join(targetProjectPath, ...relPath.split("/"));
                    writeEntries.push({
                        layer: "workspace",
                        path: abs,
                        // Computed HERE, never by the consumer. Every segment after the
                        // target path came out of the bundle. Same rule, same sink, same
                        // reason as the memory entries above.
                        display: JSON.stringify(abs),
                        // `overwrite` is only reachable with --force-workspace, and it is
                        // the one fact the gate must not blur into "a new file arrived".
                        kind: existing ? "overwrite" : "create",
                    });
                },
            });
            if (applyWorkspace && !plan) {
                report.workspaceUnpacked = { path: targetProjectPath, fileCount: ws.fileCount };
                // A CONSEQUENCE OF THE FLOOR, disclosed rather than fixed by weakening
                // it. `.sesh-mover-include` and `.sesh-mover-ignore` are on
                // `NEVER_INCLUDABLE`, so no payload can carry them — the floor exists
                // precisely to stop a payload rewriting the list that decides what the
                // next push ships, and that argument does not weaken because the target
                // happened to be empty: a planted include list is the same exfiltration
                // primitive one push later.
                //
                // The cost is real and lands exactly here, where the whole point of the
                // operation is "this project now lives here": the destination has
                // neither file, so its next push or export carries a different set than
                // the source did. For a git project the clone already has both, since
                // they are meant to be committed.
                const missingRules = [INCLUDE_FILE_NAME, IGNORE_FILE_NAME].filter((name) => !existsSync(join(targetProjectPath, name)));
                if (missingRules.length > 0) {
                    warnings.push(`The workspace payload could not carry ${missingRules.join(" or ")} — those names are on the floor that stops a bundle rewriting what this machine's next push uploads, so no payload may contain them. This project therefore has ${missingRules.length > 1 ? "neither file" : "no such file"} and will carry a different set of files than the source did. Copy ${missingRules.length > 1 ? "them" : "it"} across by hand if the source had ${missingRules.length > 1 ? "them" : "it"}; for a git project they are meant to be committed, so a clone already has ${missingRules.length > 1 ? "them" : "it"}.`);
                }
            }
            if (ws.symlinksSkipped > 0) {
                warnings.push(`${ws.symlinksSkipped} symlink(s) skipped while unpacking the workspace.`);
            }
            if (ws.refused.length > 0) {
                report.workspaceRefused = ws.refused;
                // Deliberately does NOT accuse the sender: a bundle written by an older
                // sesh-mover, on a case-insensitive filesystem, legitimately carried a
                // `.GIT` store — the very leak the guard closed.
                warnings.push(`${ws.refused.length} path(s) in the workspace payload were refused because they name plugin or VCS internals that never travel (${ws.refused.slice(0, 5).join(", ")}). Nothing from them was written here. Current sesh-mover versions never put those in a bundle, so this one came from an older version, was damaged in transit, or was not produced by sesh-mover at all.`);
            }
            if (ws.blocked.length > 0) {
                warnings.push(`${ws.blocked.length} workspace file(s) were not unpacked because of what already occupies their path here (${[...new Set(ws.blocked.map((b) => b.reason))].join(", ")}): ${ws.blocked.slice(0, 5).map((b) => b.path).join(", ")}. Nothing was written near them; the incoming copies are still in the bundle.`);
            }
            if (!applyWorkspace) {
                report.workspaceSkipped = report.workspacePathCount;
                if (report.workspacePathCount > 0) {
                    warnings.push(`This bundle carries ${report.workspacePathCount} project file(s), and they were NOT written, because \`sesh-mover import --apply-workspace\` was not passed. Every one of them is still in the bundle, so nothing was consumed by declining: re-run the same import with that flag to land them.`);
                }
            }
            else if (!plan && hasRealContent) {
                warnings.push("This import unpacked the workspace payload over the existing directory, overwriting any file of the same name, because --force-workspace was passed. It is a bootstrap copy, not a merge — anything of yours the payload does not contain is still here, and anything it does contain was replaced.");
            }
        }
        catch (e) {
            // Defence in depth. The emptiness precondition in `importSession` makes
            // `WorkspaceTargetNotEmptyError` unreachable from here, and every other
            // failure is a filesystem fault against the user's own project. Either way
            // it must NOT become an ErrorResult: the sessions are already on disk by
            // the time this runs, and the failure contract is that no failure of the
            // optional half costs the user a transcript.
            warnings.push(`The workspace payload could not be applied (${e.message}) — the sessions imported normally and nothing else in this import depends on it.`);
        }
    }
    // --- carry ---
    const carryDir = join(exportPath, "carry");
    if (opts.declaredCarry) {
        const { meta, unreadable } = normalizeCarryMeta(opts.declaredCarry);
        report.carryAvailable = meta;
        if (unreadable.length > 0) {
            warnings.push(`This bundle's manifest describes the uncommitted changes it carries in a way this version could not read (${unreadable.join(", ")}), so ${unreadable.length > 1 ? "those fields are" : "that field is"} reported as "(not recorded)". A current sesh-mover always records ${unreadable.length > 1 ? "them" : "it"}, so this bundle came from an older version, was damaged in transit, or was not produced by sesh-mover at all.`);
        }
        if (!isReadableDir(carryDir)) {
            warnings.push("The bundle's manifest declares carried uncommitted changes but the bundle does not contain them, so there was nothing to apply. The bundle is damaged or was not produced by sesh-mover.");
        }
        else {
            writeRoots.push({
                layer: "carry",
                path: targetProjectPath,
                scope: "project",
                applied: opts.applyCarry,
                // The ONE root whose paths are not in `entries`, and the reason is #38's
                // ruling rather than an omission. A patch's destinations are decided by
                // git's own parse and ONLY git's — `git apply --numstat -z --summary`,
                // read once, because two invocations differing only in mode cannot
                // disagree. Enumerating them before the apply means either a second
                // parser (this module HAD one; it was removed for cause, after a
                // measured copy-out of a floor-protected file) or a second git
                // invocation against a tree that can change in between. What bounds the
                // blast radius instead is the payload's own gates: `applyCarry` refuses
                // anything but a CLEAN tree at the EXACT recorded commit, so unlike the
                // workspace it cannot overwrite uncommitted work, and `git checkout --
                // .` undoes the patch half whole. `commands/import.md` says exactly this
                // at the gate.
                enumerated: false,
            });
            if (opts.applyCarry && !plan) {
                report.carryApplied = await applyCarry({
                    carryDir,
                    targetPath: targetProjectPath,
                    meta,
                    // Never `saveOnly` on this path — see the module doc above. Reaching
                    // `applyCarry` at all is what `--apply-carry` buys.
                    saveOnly: false,
                });
                warnings.push(...describeCarryOutcome(report.carryApplied, meta));
            }
            else {
                warnings.push(`This bundle carries uncommitted work (${meta.untrackedCount} untracked file(s) and a ${meta.patchBytes}-byte patch against commit ${orNotRecorded(meta.baseCommit.slice(0, 8))} on branch ${orNotRecorded(meta.branch)}), and ${plan ? "it would not be applied" : "NONE of it was applied"}, because \`sesh-mover import --apply-carry\` was not passed. Nothing was written and nothing was consumed by declining — it is still in the bundle, and a re-run with that flag reaches it even when every session is a duplicate by then.`);
            }
        }
    }
    return report;
}
/** What `applyCarry` did, in sentences a user can act on. */
function describeCarryOutcome(result, meta) {
    const out = [];
    const origin = `branch ${orNotRecorded(meta.branch)} at commit ${orNotRecorded(meta.baseCommit.slice(0, 8))}`;
    if (!result.applied) {
        out.push(`The uncommitted changes this bundle carries (${origin}) were not applied: ${result.detail}. ` +
            (result.savedTo === null
                ? "They could not be saved beside the project either, so the only remaining copy is the bundle itself."
                : `The whole payload — patch, untracked files and a README ${result.savedCommands
                    ? "with the exact commands"
                    : "explaining what was found and what was withheld"} — is saved at ${result.savedTo}. Nothing was written to your working tree.`));
        if (result.refused.length > 0) {
            out.push(`${result.refused.length} path(s) in that payload were left out of the saved copy because they name plugin or VCS internals that never travel (${result.refused.slice(0, 5).join(", ")}). They are not in the saved directory, so the commands in its README cannot write them here.`);
        }
        if (result.reason === "unsafe-payload") {
            out.push("That payload tried to write paths that never travel (plugin or VCS internals such as .sesh-mover-include, which decides what this machine's NEXT push uploads), or to create a symbolic link, or it described its own changes in a way git's output could not be read back unambiguously. It was refused whole rather than partly applied. Read the saved copy before doing anything with it.");
        }
        return out;
    }
    out.push(`Applied the uncommitted changes this bundle carries (${origin}): ${result.filesChanged} file(s) from the patch, ${result.untrackedCopied} untracked file(s) copied. They are uncommitted here too — \`git status\` shows them, and \`git checkout -- .\` undoes the patch half.`);
    if (meta.inProgress) {
        out.push(`Those changes were captured during an in-progress ${meta.inProgress} on the source machine, so the patch contained conflict markers as ordinary file content and the ${meta.inProgress} itself did not travel — search for <<<<<<< before working on them.`);
    }
    if (result.collisions.length > 0) {
        out.push(`${result.collisions.length} carried file(s) already existed here with different content, so yours were left alone and the incoming copies were written beside them as *.incoming-*: ${result.collisions.slice(0, 5).join(", ")}. Reconcile and delete the sidecars.`);
    }
    if (result.refused.length > 0) {
        out.push(`${result.refused.length} carried file(s) were refused because they name plugin or VCS internals that never travel (${result.refused.slice(0, 5).join(", ")}). Nothing from them was written.`);
    }
    if (result.blocked.length > 0) {
        out.push(`${result.blocked.length} carried file(s) were not written because of what already occupies their path here (${[...new Set(result.blocked.map((b) => b.reason))].join(", ")}): ${result.blocked.slice(0, 5).map((b) => b.path).join(", ")}. Nothing was written near them.`);
    }
    return out;
}
/**
 * The one write set an import discloses — the shared-namespace layers plus the
 * file payload, concatenated in ONE place so `total` cannot be computed two
 * ways.
 *
 * `total` is the count of paths that WILL BE WRITTEN, which is not
 * `entries.length` any more: the workspace enumeration is bounded (see
 * `MAX_WORKSPACE_WRITE_ENTRIES`) while the count is not, and
 * `commands/import.md`'s "and N more" takes N from here. That is the contract
 * `WriteSet.total` was written with.
 */
/**
 * The public `PayloadFindings` projection of a payload report. ONE place, for
 * the reason `sharedFindings` is one place: the preview and the real run build
 * different result objects, and a hand-written second copy is how a field ends
 * up on one of them and not the other.
 */
function payloadFindings(p) {
    return {
        workspaceUnpacked: p.workspaceUnpacked,
        workspaceRefused: p.workspaceRefused,
        workspaceDeclaredMissing: p.workspaceDeclaredMissing,
        workspaceSkipped: p.workspaceSkipped,
        carryAvailable: p.carryAvailable,
        carryApplied: p.carryApplied,
    };
}
function mergeWriteSets(shared, payload) {
    return {
        total: shared.writeSet.total + payload.workspaceWriteCount,
        entries: [...shared.writeSet.entries, ...payload.writeEntries],
        roots: [...shared.writeSet.roots, ...payload.writeRoots],
    };
}
/**
 * Reconcile a bundle's `memory/` and `plans/` **without importing a session**.
 *
 * ## Why this exists (#63)
 *
 * `reconcileSharedLayers` runs inside `importSession`, and a hub pull does not
 * always call it: when `tryAppendContinuation` splices a continuation onto an
 * existing transcript — or `adoptHubBranch` adopts one — the bundle is handled
 * and `pull-apply-sessions.ts` returns before the fragment import. The two
 * shared layers were extracted and then discarded with the extract dir.
 *
 * That was not a slow leak, it was permanent: the pushing machine credits its
 * own hub ledger with the `memoryDigest` it sent (`hub/push.ts` ->
 * `setPeerMemoryDigest`), so the exporter never ships that memory again. After
 * a machine's first pull of a thread, every later memory update reached it only
 * on the paths where the splice was DECLINED — which is why it looked like it
 * worked when tested seconds after a push (inside the 5-minute liveness window
 * the splice declines and the fragment import applies the memory) and silently
 * did not on the quiet path, which is also the common one.
 *
 * ## Why it is a wrapper and not a second implementation
 *
 * `reconcileSharedLayers` stays private with FOUR internal callers precisely so
 * the dry-run preview cannot drift from the run — the preview is the same
 * function in `plan: true` mode, never a parallel implementation. This fifth
 * caller preserves that: it is a one-line delegation, so a rule added there
 * reaches the splice path with no edit here, and the projection to
 * `SharedLayerFindings` still goes through `sharedFindings`, the single site
 * that decides an empty array is reported as absent.
 *
 * There is deliberately no `plan` parameter: the two splice paths write to a
 * transcript the user already owns before they get here, so there is no preview
 * of them to keep honest, and offering the mode would invite a caller to preview
 * one half of an operation whose other half already happened.
 *
 * ## Double-running is prevented STRUCTURALLY, not by dedupe
 *
 * Both call sites sit immediately before a `return` that skips the fragment
 * import, so a bundle reaches either this function or `importSession`, never
 * both — and a splice that is refused falls through untouched to the import,
 * which reconciles exactly once as it always did. `SharedLayerAccumulator`
 * dedupes `memoryConflicts` by value, which would make a double-run *harmless*;
 * it would not make it correct (the index union's `alreadyPresent` is summed,
 * not deduped), so nothing here leans on it.
 */
export function applySharedLayers(opts) {
    const shared = reconcileSharedLayers({ ...opts, plan: false });
    return { warnings: shared.warnings, ...sharedFindings(shared) };
}
export async function importSession(options) {
    const { exportPath, targetConfigDir, targetProjectPath, targetClaudeVersion, dryRun, sessionIds, noRegister, allowDuplicates, includePlans, noMemory, onProgress, } = options;
    // `=== true`, never `!== false`: absence coerces to "do not apply" at EVERY
    // wiring site. These are the receive-side consent gate for a payload that
    // lands in the user's own project directory (#36's ruling, #47's payloads),
    // and one `!== false` here turns a bundle someone handed you into an arbitrary
    // project-file write. `handlesPayload` is the separate question of whether
    // this CALLER deals with file payloads at all — see `ImportOptions.filePayload`.
    const handlesPayload = options.filePayload !== undefined;
    const applyWorkspace = options.filePayload?.applyWorkspace === true;
    const applyCarryRequested = options.filePayload?.applyCarry === true;
    const forceWorkspace = options.filePayload?.forceWorkspace === true;
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
    // The FILE payload runs at all FOUR of the shared-layer sites, for the reason
    // #53 established for `memory/`: a fully-duplicate import is "no new
    // sessions", not "nothing happened", and a user who declined the payload on
    // the first run and re-runs with the flag must reach it even though every
    // session is a duplicate by then. That reachability is what lets the import
    // side decline WITHOUT saving an unrequested payload into the project.
    const payloadFor = (plan) => handlesPayload
        ? reconcilePayloadLayers({
            exportPath,
            targetProjectPath,
            applyWorkspace,
            applyCarry: applyCarryRequested,
            forceWorkspace,
            declaredCarry: manifest.carry,
            declaresWorkspace: manifest.workspace !== undefined,
            plan,
        })
        : Promise.resolve(emptyPayloadReport());
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
        // `slug` quoted (QUOTING at the top of this file), `sessionId` not:
        // `readManifest` ran `assertSafeManifestIds` over every session id before
        // this function saw the manifest, and nothing clears a slug.
        const named = absentFromBundle
            .map((s) => `${JSON.stringify(s.slug)} (${s.sessionId})`)
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
    // Step 1c: a workspace payload asked to land in a directory that already has
    // content is REFUSED, and refused HERE — before any write.
    //
    // `unpackWorkspace` has this check of its own and throws
    // `WorkspaceTargetNotEmptyError`, but at APPLY time, which for an import is
    // after the sessions have landed: a partial result, where every other gate in
    // this function advertises "a refused bundle leaves the target config dir
    // byte-identical". So the test is lifted to a precondition and the throw
    // becomes unreachable.
    //
    // TWO differences from `unpackWorkspace`'s raw `readdirSync().length > 0`,
    // both deliberate:
    //  - `isPluginStateName` decides what counts as content. This import plants
    //    `.sesh-mover-project.json` into the project root when the bundle carries
    //    an id, so a directory holding nothing but plugin state must still read as
    //    empty on the NEXT import of the same bundle.
    //  - it fires only when the payload would actually be applied. A bundle whose
    //    workspace nobody asked for writes nothing, so there is nothing to refuse.
    //
    // The word "merge" appears nowhere in the refusal, on purpose: `force` means
    // unpack OVER what is there. Calling it a merge is how a user consents to an
    // overwrite believing their local files will be combined.
    if (applyWorkspace && !forceWorkspace && isReadableDir(join(exportPath, "workspace"))) {
        const occupants = existsSync(targetProjectPath) ? readdirSync(targetProjectPath) : [];
        if (occupants.some((n) => !isPluginStateName(n))) {
            return {
                success: false,
                command: "import",
                error: `workspace target ${targetProjectPath} exists and is not empty — nothing was written`,
                details: "No sessions were imported and no project files were written. An export bundle's workspace payload is a bootstrap copy, not a merge: applying it here would overwrite files of the same name.",
                suggestion: "Re-run this import against an empty directory with --target-project-path <dir>, or pass --force-workspace to unpack over what is there, OVERWRITING any file of the same name — it does not combine the two. To take the sessions only, drop --apply-workspace.",
            };
        }
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
                // JSON.stringify, not bare interpolation (#28). Both halves of this are
                // bundle-supplied strings that nothing validates — see the reach note
                // at the peer-ledger write below — and index-file.ts already states the
                // rule for every hub-supplied string echoed into a message: quoting is
                // what escapes the control characters that let a name redraw the line
                // it is printed on.
                warnings.push(`${before - targetSessions.length} session(s) already received from ${JSON.stringify(manifest.sourceMachineName ?? manifest.sourceMachineId)} — skipped (idempotent).`);
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
                // TWO causes, and they are NOT distinguishable from what is recorded.
                // `SyncStateImported` carries one boolean and no reason: `registered`
                // is written as `!noRegister && !registrationFailed.has(id)` (see the
                // registry write in step 7), so it is `false` both when the earlier run
                // was given `--no-register` and when that run's `history.jsonl` append
                // THREW — the case #78's round found, where the sentence then named a
                // flag the user never passed. Nothing else separates them either: both
                // leave the same on-disk state (a transcript with no history entry), so
                // re-deriving the cause from the config dir would answer the same
                // question the boolean already answers. So the message names both and
                // asserts neither, which is also what `commands/import.md` already does
                // at its own resumability branch.
                //
                // Widening the record (a `reason` field) would let it assert one — that
                // is a sync-state schema change, and it is not this fix. Do not restore
                // the single-cause wording without it.
                warnings.push(`Session ${JSON.stringify(session.slug)} is already here as an unregistered copy — it is absent from Claude Code's resume list, either because the earlier import could not write that list or because it was given \`sesh-mover import --no-register\`; importing a registered copy (the older unregistered copy remains on disk as ${prior.localSessionId}).`);
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
            includePlans,
            noMemory,
            plan: dryRun,
        });
        warnings.push(...shared.warnings);
        const payload = await payloadFor(dryRun);
        warnings.push(...payload.warnings);
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
                plansSkipped: shared.plansSkipped,
                memorySkipped: shared.memorySkipped,
                writeSet: mergeWriteSets(shared, payload),
                ...payloadFindings(payload),
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
            writeSet: mergeWriteSets(shared, payload),
            ...payloadFindings(payload),
        };
    }
    // Step 1.5: Version reconciliation
    const versionDiff = classifyVersionDifference(manifest.sourceClaudeVersion, targetClaudeVersion);
    const adapters = getApplicableAdapters(manifest.sourceClaudeVersion, targetClaudeVersion);
    const versionAdaptations = [];
    if (versionDiff === "source-newer") {
        // The source version is a manifest field and nothing validates it — not
        // `assertSafeManifestIds`, which covers ids only — so it is quoted like any
        // other bundle string. The TARGET version is this machine's own and stays
        // bare: quoting it would imply a distrust that is not there.
        warnings.push(`Export from newer Claude Code (${JSON.stringify(manifest.sourceClaudeVersion)}) than target (${targetClaudeVersion}). Unknown entry types will be preserved.`);
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
            warnings.push(`integrity check failed for session ${JSON.stringify(session.slug)} (${session.sessionId}): JSONL content doesn't match manifest hash. Data may be corrupted.`);
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
                // `layer` is not quoted and must not be: it is one of the three literal
                // strings `layerDirsFor` returns, not a bundle field.
                warnings.push(`bundle declares a "${layer}" layer for session ${JSON.stringify(session.slug)} (${session.sessionId}) but does not contain it — those files are missing from this import.`);
                continue;
            }
            if (actual !== declared) {
                failedLayers.add(`${session.sessionId}\0${layer}`);
                warnings.push(`integrity check failed for the "${layer}" files of session ${JSON.stringify(session.slug)} (${session.sessionId}): they don't match the manifest digest, so they were NOT copied. The transcript itself imported normally.`);
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
            includePlans,
            noMemory,
            plan: true,
        });
        const payload = await payloadFor(true);
        return {
            success: true,
            command: "import",
            dryRun: true,
            importedSessions,
            skippedSessions,
            warnings: [...warnings, ...shared.warnings, ...payload.warnings],
            resumable: true,
            rewriteReport,
            versionAdaptations: adapters.map((a) => a.description),
            memoryPlan: shared.memoryPlan,
            memoryDir: shared.memoryDir,
            planConflicts: shared.planConflicts.length > 0 ? shared.planConflicts : undefined,
            plansSkipped: shared.plansSkipped,
            memorySkipped: shared.memorySkipped,
            writeSet: mergeWriteSets(shared, payload),
            ...payloadFindings(payload),
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
                        error: `Import validation failed: session ${JSON.stringify(session.slug)} contains ${streamReport.parseFailures} unparseable JSONL line(s) after rewrite`,
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
    // ---------------------------------------------------------------------
    // DURABLE-BOOKKEEPING TAIL (#28). Everything from here to `writeSyncState`
    // runs AFTER the write loop's try/catch, so `rollbackImportedFiles` is out of
    // reach: the session JSONL is on disk and staying there. The invariant this
    // stretch has to keep is therefore not "roll back on failure" — it is
    // **`writeSyncState` must be reached**, because `state.imported` is the only
    // record that a later import of the same bundle is a duplicate.
    //
    // It was not reached. Three steps here threw, and each one left the sessions
    // written (and possibly registered) while the whole in-memory state — the
    // imported-hash registry, the peer receipts, the lineage — was discarded with
    // the rejected promise. The observable result is a DUPLICATE FACTORY, not a
    // crash window: the user retries, no dedup filter has anything to match, and
    // every session imports again under a fresh uuid, one full extra copy per
    // attempt. The trigger did not need a crash — `writeLocalProjectId` below
    // writes into the user's PROJECT directory, so a project dir that is
    // read-only to the importing user made it throw EACCES deterministically,
    // every time.
    //
    // So each of the three is guarded where it stands, and reports what was lost:
    // planting the project identity (a convenience whose two sibling arms already
    // only warn), registering in `history.jsonl` (guarded per session, so the
    // `registered` flag records what actually happened rather than what was
    // intended), and the state write itself.
    // ---------------------------------------------------------------------
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
                try {
                    writeLocalProjectId(targetProjectPath, {
                        projectId: manifest.projectId,
                        name: manifest.sourceProjectPath.split(/[\\/]/).filter(Boolean).pop() ??
                            "project",
                        createdAt: new Date().toISOString(),
                        createdByMachine: manifest.sourceMachineId ?? "unknown",
                    });
                }
                catch (e) {
                    // Warn, never throw. This is the one step in the tail that writes
                    // OUTSIDE the config dir — into the user's project directory, which
                    // an importing user may not own — and nothing about the import
                    // depends on it: the file only lets a later push already know this
                    // project's hub id, which a push asks for itself when it does not.
                    //
                    // The message names no flag deliberately. The remedy is the OS error
                    // plus the path; a flag named here would be a second thing that can
                    // be wrong, and it would need its own entry and re-run proof in
                    // tests/hub-warning-flags.test.ts.
                    warnings.push(`Could not write the project identity file into ${targetProjectPath} (${e.message}) — the sessions imported normally. Only this project's hub link is affected; nothing else in the import depends on that file.`);
                }
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
        includePlans,
        noMemory,
        plan: false,
    });
    warnings.push(...shared.warnings);
    // Step 6: the FILE payload — LAST, and after the write loop's try/catch, so
    // `rollbackImportedFiles` is out of reach by the time it runs.
    //
    // That ordering is the failure contract (#47 §4.4): the sessions are the
    // primary artifact and no failure of the optional half may cost the user a
    // transcript. A workspace or carry failure here is reported as `success: true`
    // with warnings, never as an `ErrorResult`, and `rollbackImportedFiles` must
    // never grow a notion of the project tree — there is no rollback for an
    // unpack, and there should not be one: "undoing" it means deleting files in
    // the user's project directory on the strength of our own bookkeeping.
    //
    // The one refusal that IS allowed is the non-empty-target check, and it is a
    // precondition (step 1c) precisely so that it happens before anything is
    // written rather than here.
    const payload = await payloadFor(false);
    warnings.push(...payload.warnings);
    // Step 7: Register in indexes (only after successful validation)
    /** Sessions whose `history.jsonl` append failed, so they are NOT resumable. */
    const registrationFailed = new Set();
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
            try {
                appendFileSync(historyPath, JSON.stringify(historyEntry) + "\n", "utf-8");
            }
            catch (e) {
                // Per session, not per import, so `registered` below records what
                // actually happened. An unguarded throw here cost the whole registry
                // (see the tail note above); an import-wide flag would instead record
                // "unregistered" for sessions that ARE registered, and the dedup filter
                // treats an unregistered prior as re-importable — which would duplicate
                // them on the next run. Both directions have to be right.
                registrationFailed.add(session.sessionId);
                warnings.push(`Session ${JSON.stringify(session.slug)} imported but could not be added to ${historyPath} (${e.message}), so it will not appear in Claude Code's resume list. Its files are in place; nothing was lost.`);
            }
        }
    }
    // Always record the imported-hash registry entries — machine-id or not —
    // so a later import of identical content is recognized as a duplicate.
    for (const session of targetSessions) {
        const newId = sessionIdMap.get(session.sessionId);
        state.imported[session.integrityHash] = {
            localSessionId: newId,
            importedAt: new Date().toISOString(),
            registered: !noRegister && !registrationFailed.has(session.sessionId),
        };
    }
    // WHAT `manifest.sourceMachineId` CAN REACH (#28). It is the one id on a
    // bundle manifest that goes through no validation at all — not
    // `assertSafeManifestIds` (session ids and the two continuation ids only),
    // not `assertSafeHubId`. That is deliberate, and this is the record of why,
    // so the next reader does not have to re-derive it:
    //
    //   - It is a KEY into `state.peers` (here and at the dedup filter above) and
    //     a VALUE in `state.lineage[…].sourceMachineId`. Those records are
    //     null-prototype by construction, so a hostile key is an ordinary key.
    //   - It is a VALUE in `.sesh-mover-project.json`'s `createdByMachine`, which
    //     round-trips to `HubProjectJson.createdByMachine` and back as a value
    //     and is never a path segment.
    //   - It is echoed into two warnings (quoted — see the dedup filter above).
    //
    // It reaches NO path. `machinePath()` is called only from `init.ts`,
    // `status.ts` and `whereis.ts`'s `createMachineNameLookup`, and every caller
    // passes either this machine's own identity or a machineId taken from a hub
    // INDEX — never a peers key, and never a manifest field. `bundleDir()` and
    // `indexPath()` likewise take local identity or an index-derived id. So there
    // is no chokepoint for it to pass through, and adding a gate here would only
    // choose between refusing an otherwise-good bundle and dropping the receipt
    // that stops the next import duplicating it.
    //
    // RE-DERIVE THIS before letting the field reach anything new. The moment a
    // peers key, a lineage source, or `createdByMachine` is used to build a hub
    // or filesystem path, `assertSafeHubId` belongs right here, at the read.
    if (manifest.sourceMachineId) {
        const peerId = manifest.sourceMachineId;
        const peerName = manifest.sourceMachineName ?? "unknown";
        if (!state.peers[peerId]) {
            state.peers[peerId] = {
                name: peerName,
                lastSentAt: null,
                lastReceivedAt: null,
                // `foreignKeyedRecord`, not `{}` (#28). sync-state.ts's own rule is
                // "anything that BUILDS one of these records must use this", and this
                // is the site that BUILDS one — it does not inherit the guarantee from
                // the state object it was handed, which is why the container-level fix
                // did not reach it. Measured: `received["__proto__"] = receipt` on a
                // plain object invokes Object.prototype's setter, creates NO own key,
                // and serializes as `{}` — so the receipt for a session the manifest
                // named `__proto__` (which `isSafeSessionId` allows) is silently lost
                // and every later import of it duplicates. It bites only on FIRST
                // contact with a peer, because `parseSyncState` re-wraps the record
                // null-prototype on the next read — which is exactly why it survived.
                sent: foreignKeyedRecord(),
                received: foreignKeyedRecord(),
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
    try {
        writeSyncState(state);
    }
    catch (e) {
        // The last step of the tail, and the only one whose failure the import
        // itself survives intact: the sessions are written and registered, so this
        // import SUCCEEDED. What is lost is the bookkeeping that makes the NEXT one
        // idempotent, so the honest report is success plus the consequence, spelled
        // out — not an exception that discards a completed import (and, on
        // `migrate`, left the source sessions undeleted beside the copies that
        // already landed).
        warnings.push(`The sessions imported, but this project's sync-state could not be saved (${e.message}). Importing this same bundle again will NOT be recognized as a duplicate — it would add a second copy of each session. Free space or fix permissions before re-running an import here.`);
    }
    return {
        success: true,
        command: "import",
        importedSessions,
        skippedSessions,
        warnings,
        resumable: !noRegister && registrationFailed.size === 0,
        versionAdaptations: versionAdaptations.length > 0 ? versionAdaptations : undefined,
        ...sharedFindings(shared),
        writeSet: mergeWriteSets(shared, payload),
        ...payloadFindings(payload),
    };
}
//# sourceMappingURL=importer.js.map