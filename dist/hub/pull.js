import { mkdtempSync, rmSync, mkdirSync, createReadStream, createWriteStream, existsSync, readdirSync, appendFileSync, copyFileSync, statSync, } from "node:fs";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend } from "./backend.js";
import { HUB_JSON } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import { resolveProjectIdentity, linkToHubProject } from "./identity.js";
import { registerMachine } from "./init.js";
import { buildIndexFile, readMachineIndex, writeMachineIndex, readAllIndexes } from "./index-file.js";
import { resolveThreads } from "./threads.js";
import { shapeThreads } from "./whereis.js";
import { unpackWorkspace, WorkspaceTargetNotEmptyError } from "./workspace.js";
import { adoptHubBranch, readDeltaChainInfo, tryAppendContinuation, APPEND_LIVE_WINDOW_MS, } from "./append.js";
import { extractArchive } from "../archiver.js";
import { importSession } from "../importer.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { computeIntegrityHashFromFile, readManifest } from "../manifest.js";
import { countJsonlLines, findEntryOffsetByUuid, readLastEntryUuid, readLastJsonlLine, } from "../jsonl.js";
import { encodeProjectPath } from "../platform.js";
import { buildImportRewriteContext, rewriteJsonlStream } from "../rewriter.js";
import { getApplicableAdapters } from "../version-adapters.js";
import { readSyncState, writeSyncState, setThreadId, recordSentToPeer } from "../sync-state.js";
/**
 * Pick which of a thread's local sessions a continuation should splice onto.
 *
 * A thread maps to MORE THAN ONE local session as a matter of course: every
 * time a splice is declined (a live-looking base, a chain that doesn't line
 * up, `--no-append`) the fragment import mints a new session and maps it onto
 * the same thread, while the older mapping stays. "Whichever key comes first"
 * therefore returns the OLDEST session forever, and since the continuation
 * chain has moved on, every subsequent pull chain-mismatches and forks off
 * another fragment — a state `--force-append` cannot rescue, because force
 * never skips the chain guard. index-file.ts:30-41 refuses the mirror-image
 * shortcut in the forward direction for the same reason.
 *
 * So: the delta's anchor decides. The session whose head IS the entry this
 * continuation follows is the one it belongs on, whatever the map's insertion
 * order says — which is also what makes a poisoned map self-healing, since
 * the fragment that stranded the thread is exactly the session carrying the
 * anchor next time round.
 *
 * Order of preference:
 *   1. sessions whose head uuid equals `anchorUuid` (when it's known and any
 *      candidate matches) — otherwise every candidate stays in the running,
 *      so the caller still gets a sensible base to name in the decline;
 *   2. `preferred` (the session THIS pull already landed content in) if it
 *      survived step 1;
 *   3. most recent `lastActiveAt`, ties broken by lexically greatest session
 *      id — a strict total order, so the answer never depends on map or
 *      directory iteration order.
 */
export function selectThreadBase(candidates, anchorUuid, preferred) {
    if (candidates.length === 0)
        return null;
    const anchored = anchorUuid
        ? candidates.filter((c) => c.headEntryUuid !== null && c.headEntryUuid === anchorUuid)
        : [];
    const pool = anchored.length > 0 ? anchored : candidates;
    if (preferred && pool.some((c) => c.localSessionId === preferred))
        return preferred;
    return pool.reduce((best, c) => {
        const a = best.lastActiveAt ?? "";
        const b = c.lastActiveAt ?? "";
        if (a !== b)
            return b > a ? c : best;
        return c.localSessionId > best.localSessionId ? c : best;
    }).localSessionId;
}
/** Head uuid + last-entry timestamp from one bounded tail read. */
function readSessionTail(path) {
    const line = readLastJsonlLine(path);
    if (!line)
        return { headEntryUuid: null, lastActiveAt: null };
    try {
        const e = JSON.parse(line);
        return { headEntryUuid: e.uuid ?? null, lastActiveAt: e.timestamp ?? null };
    }
    catch {
        return { headEntryUuid: null, lastActiveAt: null };
    }
}
/**
 * Every local session currently mapped to `threadId`, plus the one this pull
 * has already landed content in (which isn't in the map yet — thread mappings
 * are only written once the whole chain has been applied). Sessions whose
 * file is gone are dropped: a mapping outlives the file it points at.
 */
function threadBaseCandidates(state, threadId, pendingSessionId, targetProjectDir) {
    const ids = new Set();
    for (const [localSessionId, tid] of Object.entries(state.hub?.threadByLocalSession ?? {})) {
        if (tid === threadId)
            ids.add(localSessionId);
    }
    if (pendingSessionId)
        ids.add(pendingSessionId);
    const candidates = [];
    for (const localSessionId of ids) {
        const p = join(targetProjectDir, `${localSessionId}.jsonl`);
        if (!existsSync(p))
            continue;
        candidates.push({ localSessionId, ...readSessionTail(p) });
    }
    return candidates;
}
/**
 * A spliced continuation's layer files belong to the BASE session, so they
 * land in the base's directories rather than under the bundle's (now
 * discarded) session id.
 *
 * Subagent JSONL — and ONLY subagent JSONL — is rewritten through the same
 * context as the transcript, exactly as importer.ts does it: those files are
 * Claude Code transcripts carrying the source machine's `cwd` and tool output,
 * so a plain copy would leave foreign paths behind in the one place nobody
 * looks. tool-results and file-history are opaque user data (a file-history
 * backup of a `.jsonl` the user was editing is NOT a transcript) and are
 * copied byte-for-byte. Existing files are never overwritten: layer files are
 * uuid-named, so a collision means the same artifact already arrived.
 */
async function copyLayerDirs(extractDir, bundleSessionId, targetProjectDir, baseSessionId, targetConfigDir, ctx) {
    const pairs = [
        {
            from: join(extractDir, "sessions", bundleSessionId, "subagents"),
            to: join(targetProjectDir, baseSessionId, "subagents"),
            rewriteJsonl: true,
        },
        {
            from: join(extractDir, "sessions", bundleSessionId, "tool-results"),
            to: join(targetProjectDir, baseSessionId, "tool-results"),
            rewriteJsonl: false,
        },
        {
            from: join(extractDir, "file-history", bundleSessionId),
            to: join(targetConfigDir, "file-history", baseSessionId),
            rewriteJsonl: false,
        },
    ];
    for (const { from, to, rewriteJsonl } of pairs) {
        if (!existsSync(from))
            continue;
        mkdirSync(to, { recursive: true });
        for (const f of readdirSync(from)) {
            const dest = join(to, f);
            if (existsSync(dest))
                continue;
            if (rewriteJsonl && f.endsWith(".jsonl")) {
                // Path rewrite + the base's session id, never version adapters —
                // the same rule importer.ts follows for subagents.
                await rewriteJsonlStream(join(from, f), dest, ctx, { newSessionId: baseSessionId });
            }
            else {
                copyFileSync(join(from, f), dest);
            }
        }
    }
}
/**
 * How many entries the local base holds beyond the common anchor — the "your
 * side" number the divergence report shows the user.
 *
 * Reading from `start: offset` rather than counting bytes back up to it keeps
 * this immune to the byte-arithmetic caveats on `findEntryOffsetByUuid`: an
 * offset past EOF yields nothing (0), and a CRLF offset that lands on the
 * terminator just produces one leading empty line, which is skipped.
 */
async function countEntriesAfterOffset(path, offset) {
    const input = createReadStream(path, { encoding: "utf-8", start: offset });
    const rl = createInterface({ input, crlfDelay: Infinity });
    let count = 0;
    try {
        for await (const line of rl)
            if (line.trim())
                count++;
    }
    finally {
        rl.close();
        input.destroy();
    }
    return count;
}
/**
 * The bookkeeping `importSession` would normally do, which the splice paths
 * (plain append and divergence adoption alike) deliberately bypass: no new
 * session was created, so there is nothing for the importer to record — but
 * without these entries the very same bundle is "needed" again on the next
 * pull (selectNeededBundles reads peers[...].received) and a push back to the
 * hub would re-upload the whole session as a full bundle.
 *
 * Callers must run this BEFORE copying layer files: the base is already
 * extended by then, so a layer-copy fault must not leave the splice
 * unrecorded — the next pull would re-need the bundle, chain-mismatch against
 * the now-longer base, and land the very same entries again as a fragment.
 *
 * Deliberately NOT written: state.lineage[baseSessionId]. The base already has
 * lineage describing where the SESSION came from; overwriting it with this
 * splice's provenance would destroy that and claim the whole transcript
 * arrived as a continuation.
 */
function recordSplice(b) {
    const now = new Date().toISOString();
    const messageCount = countJsonlLines(b.basePath);
    const st = readSyncState(b.projectPath);
    st.peers[b.peerId] ??= {
        name: b.manifest.sourceMachineName ?? b.peerId,
        lastSentAt: null, lastReceivedAt: null, sent: {}, received: {},
    };
    const peer = st.peers[b.peerId];
    if (b.manifest.sourceMachineName)
        peer.name = b.manifest.sourceMachineName;
    peer.lastReceivedAt = now;
    peer.received[b.record.sessionIdInBundle] = {
        localSessionId: b.baseSessionId,
        type: "continuation",
        importedAt: now,
    };
    // This machine is now level with that peer on this session.
    peer.sent[b.baseSessionId] = {
        headEntryUuid: b.newHeadUuid,
        messageCount,
        sentAsType: "continuation",
        sentAsSessionId: b.record.sessionIdInBundle,
    };
    st.imported[b.bundleSession.integrityHash] = {
        localSessionId: b.baseSessionId,
        importedAt: now,
        registered: true,
    };
    writeSyncState(st);
    // ...and so is the hub, which is where this content came from. After an
    // adoption the base matches the hub's branch exactly, so this is what stops
    // the next push re-shipping content we just took FROM the hub.
    recordSentToPeer(b.projectPath, { id: b.hubPeerId, name: "hub" }, b.baseSessionId, {
        headEntryUuid: b.newHeadUuid,
        messageCount,
        sentAsType: "continuation",
        sentAsSessionId: b.record.sessionIdInBundle,
    });
}
// Last full bundle + everything after it, minus records already received AND
// still present locally (mirrors the importer's own dedup verification: a
// registry/peer record can outlive the file it points at, e.g. after a
// migrate deleted it, so "already received" is only trusted when the file is
// still there).
export function selectNeededBundles(bundles, received, localSessionFileExists) {
    let lastFull = -1;
    for (let i = 0; i < bundles.length; i++)
        if (bundles[i].type === "full")
            lastFull = i;
    const chain = lastFull >= 0 ? bundles.slice(lastFull) : bundles.slice();
    return chain.filter((r) => {
        const prior = received?.[r.sessionIdInBundle];
        return !(prior && localSessionFileExists(prior.localSessionId));
    });
}
export async function hubPull(opts) {
    // Captured ONCE for the whole operation, never per bundle: append.ts treats
    // a base whose mtime is >= this as "written by us, not by a live Claude
    // Code session". A fresh machine pulling a full bundle plus N continuations
    // writes the base itself in this same run, and every one of those N splices
    // has to stay exempt from the liveness guard — a per-bundle timestamp would
    // re-arm the guard against our own writes and scatter the thread across
    // 1 + N fragments.
    const opNowMs = Date.now();
    let lock;
    try {
        lock = acquireProjectLock(opts.projectPath);
    }
    catch (e) {
        if (e instanceof LockBusyError) {
            return {
                success: false, command: "pull", reason: "lock-busy",
                holderPid: e.holderPid, ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
                suggestion: "Another sesh-mover hub operation is running for this project — wait for it or retry.",
            };
        }
        throw e;
    }
    let tempRoot = null;
    try {
        tempRoot = mkdtempSync(join(tmpdir(), "sesh-hub-pull-"));
        const backend = createFsBackend(opts.hubPath);
        const warnings = [];
        if (lock.stoleStale) {
            warnings.push("Stole a stale project lock left by a previous sesh-mover hub operation (likely crashed or was killed) — proceeding, but verify no other push/pull is genuinely in progress.");
        }
        const machine = loadOrCreateMachineId();
        // Identity is resolved/linked against opts.projectPath — deliberately
        // NOT the "effective" project path below. In the bootstrap case (the
        // project doesn't exist locally yet and --target-path names a fresh
        // destination for the workspace) that destination must stay genuinely
        // nonexistent until the workspace-unpack step runs; if linking wrote
        // .claude-sesh-mover under it first, the "project path doesn't exist
        // locally" gate on the workspace flow (step 8) would never fire.
        let local;
        if (opts.projectIdOverride) {
            local = await linkToHubProject(backend, opts.projectPath, opts.projectIdOverride);
        }
        else {
            const resolution = await resolveProjectIdentity(backend, opts.projectPath);
            if (resolution.kind === "linked") {
                local = resolution.local;
            }
            else if (resolution.kind === "match") {
                local = await linkToHubProject(backend, opts.projectPath, resolution.hubProject.projectId);
                warnings.push(`Linked to hub project ${resolution.hubProject.name} via git remote ${resolution.matchedRemote}.`);
            }
            else {
                return {
                    success: false, command: "pull", reason: "unlinked",
                    linkCandidates: resolution.candidates,
                    suggestion: "Pass --project-id <id> to link to an existing hub project.",
                };
            }
        }
        await registerMachine(opts.hubPath);
        // Read once, reused both for the hub-peer bookkeeping below (recognizing
        // pulled content as already-known-to-the-hub) and for this thread's
        // mapping write further down.
        const hub = JSON.parse((await backend.read(HUB_JSON)).toString());
        const hubPeerId = `hub:${hub.hubId}`;
        const { indexes, warnings: indexWarnings } = await readAllIndexes(backend, local.projectId);
        warnings.push(...indexWarnings);
        const resolved = resolveThreads(indexes);
        if (!opts.threadId && !opts.latest) {
            const threads = await shapeThreads(backend, resolved, machine.id);
            return { success: true, command: "pull", pickRequired: true, threads, warnings };
        }
        const isCurrent = (t) => {
            const localEntry = t.copies.find((c) => c.machineId === machine.id);
            return !!localEntry && localEntry.headEntryUuid === t.latest.headEntryUuid;
        };
        let target;
        if (opts.threadId) {
            target = resolved.find((t) => t.threadId === opts.threadId);
            if (!target) {
                return {
                    success: false, command: "pull",
                    error: `No thread "${opts.threadId}" found for this project on the hub.`,
                    suggestion: "Run whereis to list available threads.",
                };
            }
        }
        else {
            // --latest: resolveThreads already sorts desc by latest activity —
            // take the first thread that is NOT already current on this machine.
            target = resolved.find((t) => !isCurrent(t));
            if (!target) {
                return {
                    success: false, command: "pull",
                    error: "Nothing to pull: all threads are current on this machine.",
                    suggestion: "Run whereis to double-check thread status.",
                };
            }
        }
        const sourceCopy = target.latest;
        if (sourceCopy.machineId === machine.id) {
            return {
                success: false, command: "pull",
                error: "The latest copy of this thread is already local.",
                suggestion: "Run whereis to confirm — there is nothing to pull.",
            };
        }
        // Everything below (dedup/sync-state, workspace unpack, session import,
        // and this machine's own index projection) is keyed off the EFFECTIVE
        // project path: --target-path when given, else opts.projectPath.
        const effectiveProjectPath = opts.targetPath ?? opts.projectPath;
        const targetProjectDir = join(opts.configDir, "projects", encodeProjectPath(effectiveProjectPath));
        const state = readSyncState(effectiveProjectPath);
        const received = state.peers[sourceCopy.machineId]?.received;
        const needed = selectNeededBundles(sourceCopy.bundles, received, (localSessionId) => existsSync(join(targetProjectDir, `${localSessionId}.jsonl`)));
        if (needed.length === 0) {
            return {
                success: false, command: "pull",
                error: "Already up to date with the source machine.",
                suggestion: "Run whereis to confirm.",
            };
        }
        const missing = [];
        for (const record of needed)
            if (!(await backend.exists(record.file)))
                missing.push(record.file);
        if (missing.length > 0) {
            return {
                success: false, command: "pull", reason: "not-yet-synced", missing,
                suggestion: "The hub folder has not finished syncing these files — retry in a moment.",
            };
        }
        opts.onProgress?.({ phase: "hub-pull", percent: 0 });
        let workspaceUnpacked = null;
        const importedSessions = [];
        const skippedSessions = [];
        const appended = [];
        let lastImportedNewId = null;
        let lastBundleManifest = null;
        // The local session THIS pull has landed content in (imported or extended)
        // — null until something lands. It is both the thread mapping written at
        // the end and the preferred splice target for later bundles in the same
        // chain, since the mapping itself isn't written until the loop is done.
        let threadLandedSessionId = null;
        // The last two-sided fork this pull ran into, and whether a bundle was
        // deliberately left unapplied because of one. A chain is pulled in order,
        // so a later bundle's divergence supersedes an earlier one's.
        let lastDivergence;
        let skippedByDivergence = false;
        for (const [i, record] of needed.entries()) {
            const tarPath = join(tempRoot, `${record.bundleId}.tar.gz`);
            const out = createWriteStream(tarPath);
            // record.file is hub-sourced (read out of another machine's index
            // file) and used as a path immediately below — the backend's
            // assertHubRelPath (hub/layout.ts, enforced inside every HubBackend
            // method, see hub/backend.ts) is the containment that rejects
            // traversal/absolute paths before anything touches the filesystem.
            await pipeline(await backend.readStream(record.file), out);
            const extractDir = join(tempRoot, record.bundleId);
            mkdirSync(extractDir, { recursive: true });
            await extractArchive(tarPath, extractDir);
            // Archiver-rooting reality check: createArchive tars the staging dir
            // with `cwd: dirname(sourceDir)` and a single top-level entry
            // (basename(sourceDir), i.e. "bundle" for push's staging), and
            // extractArchive always calls tar.extract with strip:1 — which
            // removes exactly that one wrapper segment. So manifest.json/sessions/
            // etc. land directly under extractDir, the same way cli.ts's import
            // action treats its own tempExtractDir as the exportPath (no nested
            // "bundle/" to join).
            const bundleManifest = readManifest(extractDir);
            lastBundleManifest = bundleManifest;
            // Workspace gate (first needed bundle only):
            // - target absent, empty, or
            //   metadata-only                -> unpack (bootstrap; no force needed)
            // - explicit --target-path,
            //   has real content, no force   -> let unpackWorkspace throw, surface
            //                                   an ErrorResult with the
            //                                   --force-workspace suggestion (the
            //                                   user asked for that destination;
            //                                   refuse loudly)
            // - no explicit --target-path,
            //   project dir has real content,
            //   no force                     -> SKIP with a warning (routine repeat
            //                                   pulls of non-git projects must not
            //                                   start erroring)
            // - --force-workspace            -> unpack with force (merge) regardless
            //
            // ".claude-sesh-mover" counts as non-content on BOTH sides: identity
            // linking above may have just planted project.json into an otherwise
            // fresh directory (the in-place bootstrap flow, --project-id with no
            // --target-path), and that metadata alone must neither trigger the
            // routine-skip branch nor trip unpackWorkspace's own emptiness check —
            // hence force is also set when the dir holds nothing but our metadata.
            if (i === 0 && bundleManifest.workspace) {
                const entries = existsSync(effectiveProjectPath) ? readdirSync(effectiveProjectPath) : [];
                const hasRealContent = entries.some((n) => n !== ".claude-sesh-mover");
                if (hasRealContent && !opts.forceWorkspace && !opts.targetPath) {
                    warnings.push("Bundle carries a workspace payload but the project directory already has content — pass --force-workspace to merge it here, or re-pull with --target-path <fresh-dir> to unpack it elsewhere.");
                }
                else {
                    try {
                        const ws = await unpackWorkspace(join(extractDir, "workspace"), effectiveProjectPath, { force: !!opts.forceWorkspace || !hasRealContent });
                        workspaceUnpacked = { path: effectiveProjectPath, fileCount: ws.fileCount };
                        if (ws.symlinksSkipped > 0) {
                            warnings.push(`${ws.symlinksSkipped} symlink(s) skipped while unpacking the workspace.`);
                        }
                    }
                    catch (e) {
                        if (e instanceof WorkspaceTargetNotEmptyError) {
                            return {
                                success: false, command: "pull",
                                error: e.message,
                                suggestion: "Pass --force-workspace to merge into the existing (non-empty) target directory.",
                            };
                        }
                        throw e;
                    }
                }
            }
            // Append path: a continuation whose chain matches one of this thread's
            // local sessions splices onto that session, so the conversation stays
            // one resumable transcript. Every guard lives in append.ts and ANY
            // decline falls through to the import below — content always arrives,
            // at worst as the Slice-1 fragment.
            const bundleSession = bundleManifest.sessions.find((s) => s.sessionId === record.sessionIdInBundle);
            const deltaPath = join(extractDir, "sessions", `${record.sessionIdInBundle}.jsonl`);
            if (record.type === "continuation" && !opts.noAppend && bundleSession && existsSync(deltaPath)) {
                // Integrity parity with importSession (importer.ts step 3), and the
                // reason it is a REFUSAL here rather than the importer's warning: a
                // splice mutates a transcript the user already owns, and nothing
                // rolls that back once it is verified and committed. A truncated
                // delta that still gunzips and still chains (a half-synced hub file)
                // would otherwise be welded into their session silently. Declining
                // hands the bundle to the fragment path, which lands it in a NEW file
                // and emits the importer's own "Data may be corrupted" warning — the
                // content still arrives, the user still hears about it, and the file
                // they already had is untouched.
                const actualHash = await computeIntegrityHashFromFile(deltaPath);
                if (actualHash !== bundleSession.integrityHash) {
                    warnings.push(`Continuation for thread ${target.threadId} failed its integrity check (bundle content doesn't match the manifest hash) — not spliced into the existing session; importing it as a separate session instead.`);
                }
                else {
                    // Which of this thread's local sessions does this delta continue?
                    // Decided by the delta's own anchor, never by map order — see
                    // selectThreadBase. Re-read state because importSession rewrites it
                    // between iterations.
                    const deltaInfo = await readDeltaChainInfo(deltaPath);
                    const anchorUuid = deltaInfo.firstEntryParentUuid;
                    const baseSessionId = selectThreadBase(threadBaseCandidates(readSyncState(effectiveProjectPath), target.threadId, threadLandedSessionId, targetProjectDir), anchorUuid, threadLandedSessionId);
                    if (baseSessionId) {
                        const basePath = join(targetProjectDir, `${baseSessionId}.jsonl`);
                        // Identical derivation to importSession's — same manifest, same
                        // target — so a spliced continuation and an imported fragment
                        // carry byte-identical rewrites.
                        const ctx = buildImportRewriteContext(bundleManifest, effectiveProjectPath, opts.configDir);
                        const outcome = await tryAppendContinuation({
                            basePath,
                            baseSessionId,
                            deltaPath,
                            ctx,
                            adapters: getApplicableAdapters(bundleManifest.sourceClaudeVersion, opts.claudeVersion),
                            opNowMs,
                            force: !!opts.forceAppend,
                        });
                        if (outcome.kind === "appended") {
                            recordSplice({
                                projectPath: effectiveProjectPath, basePath, baseSessionId,
                                peerId: sourceCopy.machineId, hubPeerId, manifest: bundleManifest,
                                record, bundleSession, newHeadUuid: outcome.newHeadUuid,
                            });
                            // Best effort by design: layers are auxiliary artifacts
                            // (subagent transcripts, tool-result blobs, file-history
                            // backups). Losing them costs detail, never transcript
                            // integrity — and the splice above is already committed, so a
                            // throw here would be strictly worse than a warning.
                            try {
                                await copyLayerDirs(extractDir, record.sessionIdInBundle, targetProjectDir, baseSessionId, opts.configDir, ctx);
                            }
                            catch (e) {
                                warnings.push(`Continuation was appended to session ${baseSessionId}, but copying its subagent/tool-result/file-history files failed (${e.message}) — the transcript is complete; those side files are missing.`);
                            }
                            appended.push({
                                threadId: target.threadId,
                                baseSessionId,
                                entriesAppended: outcome.entriesAppended,
                            });
                            threadLandedSessionId = baseSessionId;
                            continue; // bundle handled — no fragment import
                        }
                        // A chain mismatch is not just "couldn't splice": it means this
                        // thread was extended on BOTH machines from a common anchor, so
                        // neither branch continues the other. The fragment fallback is
                        // safe but leaves the user with two half-conversations and no way
                        // forward, so the mode decides — and whatever happens, the shape
                        // of the fork is reported so the skill layer can explain it.
                        if (outcome.reason === "chain-mismatch") {
                            const anchorOffset = anchorUuid
                                ? await findEntryOffsetByUuid(basePath, anchorUuid)
                                : null;
                            const baseMtimeMs = statSync(basePath).mtimeMs;
                            const mode = opts.onDivergence ?? "fragment";
                            const divergence = {
                                threadId: target.threadId,
                                anchorUuid: anchorUuid ?? "",
                                localSessionId: baseSessionId,
                                localHeadUuid: readLastEntryUuid(basePath) ?? "",
                                localEntriesSinceAnchor: anchorOffset === null ? 0 : await countEntriesAfterOffset(basePath, anchorOffset),
                                localLastActiveAt: new Date(baseMtimeMs).toISOString(),
                                hubHeadUuid: deltaInfo.lastEntryUuid ?? "",
                                // The synthetic continuation header is bundle plumbing, not a
                                // message — counting it would overstate the hub's side by one.
                                hubEntriesSinceAnchor: Math.max(0, bundleSession.messageCount - (deltaInfo.headerPresent ? 1 : 0)),
                                hubLastActiveAt: record.pushedAt,
                                adoptAvailable: anchorOffset !== null,
                                resolution: mode,
                            };
                            lastDivergence = divergence;
                            // The two sides of the fork, phrased for the user. When the
                            // anchor isn't in the local session at all there IS no shared
                            // point to count from — `localEntriesSinceAnchor` is 0 by
                            // definition, and reporting "0 entries the hub hasn't seen"
                            // about a session that doesn't even contain the anchor is
                            // simply false. Say what actually happened instead.
                            const plural = (n) => `${n} entr${n === 1 ? "y" : "ies"}`;
                            const forkSummary = divergence.adoptAvailable
                                ? `your session ${baseSessionId} continues ${divergence.anchorUuid} with ${plural(divergence.localEntriesSinceAnchor)} the hub hasn't seen, and the hub's copy continues the same entry with ${plural(divergence.hubEntriesSinceAnchor)} of its own`
                                : `the hub's continuation follows entry ${divergence.anchorUuid}, which session ${baseSessionId} does not contain at all (unrelated or compacted history), so there is no shared point to splice at`;
                            // Adoption TRUNCATES a transcript the user already owns, which
                            // is strictly more destructive than the append that does check
                            // liveness — and the chain guard fires first, so a diverged base
                            // reaches here with no liveness scrutiny whatsoever. The most
                            // likely invocation is a pull run from INSIDE the diverged
                            // session, which is guaranteed to keep appending: its in-memory
                            // head would be an entry the file no longer ends with, so its
                            // next write chains onto the hub's branch instead of its own.
                            // Refuse by default, exactly as migrator.ts refuses a
                            // self-migration, and let --force-append be the consent.
                            const baseAgeMs = Date.now() - baseMtimeMs;
                            const looksLive = baseMtimeMs < opNowMs && baseAgeMs < APPEND_LIVE_WINDOW_MS;
                            if (mode === "skip") {
                                warnings.push(`Thread ${target.threadId} has diverged: ${forkSummary} — skipped, nothing changed. Re-run with --on-divergence fragment${divergence.adoptAvailable ? " or adopt-hub" : ""} to decide.`);
                                skippedByDivergence = true;
                                continue; // nothing recorded, so the decision can be revisited
                            }
                            if (mode === "adopt-hub" && divergence.adoptAvailable && looksLive && !opts.forceAppend) {
                                warnings.push(`adopt-hub refused for thread ${target.threadId}: session ${baseSessionId} was modified ${Math.round(baseAgeMs / 1000)}s ago, so a Claude Code session may still be open on it — adopting would truncate a transcript that is being written to, and anything it writes afterwards would chain onto the hub's branch instead of yours. Exit that session, then re-run with --on-divergence adopt-hub --force-append. The hub's branch was imported as a separate session in the meantime; nothing local was touched.`);
                                divergence.resolution = "fragment";
                            }
                            else if (mode === "adopt-hub" && divergence.adoptAvailable) {
                                const preservedSessionId = randomUUID();
                                const preservedPath = join(targetProjectDir, `${preservedSessionId}.jsonl`);
                                const adopt = await adoptHubBranch({
                                    basePath, baseSessionId, deltaPath,
                                    anchorOffset: anchorOffset,
                                    preservedSessionId, preservedPath, ctx,
                                    adapters: getApplicableAdapters(bundleManifest.sourceClaudeVersion, opts.claudeVersion),
                                });
                                if (adopt.kind === "adopted") {
                                    // Same ordering rule as the plain append: durable
                                    // bookkeeping first, then everything whose loss is a
                                    // nuisance rather than a correctness problem.
                                    recordSplice({
                                        projectPath: effectiveProjectPath, basePath, baseSessionId,
                                        peerId: sourceCopy.machineId, hubPeerId, manifest: bundleManifest,
                                        record, bundleSession, newHeadUuid: adopt.newHeadUuid,
                                    });
                                    // Register the preserved branch so it is resumable and
                                    // findable. The "preserved" marker lives HERE, in the
                                    // display name — never as an injected entry in the
                                    // transcript itself.
                                    try {
                                        appendFileSync(join(opts.configDir, "history.jsonl"), JSON.stringify({
                                            display: `${bundleSession.slug} (local divergence, preserved ${new Date().toISOString().slice(0, 10)})`,
                                            pastedContents: {},
                                            timestamp: Date.now(),
                                            project: effectiveProjectPath,
                                            sessionId: preservedSessionId,
                                        }) + "\n", "utf-8");
                                    }
                                    catch (e) {
                                        warnings.push(`Your local branch was preserved as session ${preservedSessionId}, but registering it in history.jsonl failed (${e.message}) — the file is there and \`claude --resume ${preservedSessionId}\` still works; it just won't be listed.`);
                                    }
                                    // The adopted branch's layer files, onto the base — exactly
                                    // as for a plain append. The PRESERVED session deliberately
                                    // gets none: layer files are uuid-named under the base
                                    // session's directories and stay there, shared history and
                                    // local branch alike. Duplicating arbitrarily large blobs to
                                    // give a second session the same auxiliary detail is a poor
                                    // trade; the preserved transcript is complete without them.
                                    try {
                                        await copyLayerDirs(extractDir, record.sessionIdInBundle, targetProjectDir, baseSessionId, opts.configDir, ctx);
                                    }
                                    catch (e) {
                                        warnings.push(`The hub branch was adopted into session ${baseSessionId}, but copying its subagent/tool-result/file-history files failed (${e.message}) — the transcript is complete; those side files are missing.`);
                                    }
                                    divergence.preservedSessionId = preservedSessionId;
                                    appended.push({
                                        threadId: target.threadId,
                                        baseSessionId,
                                        entriesAppended: adopt.entriesAppended,
                                    });
                                    warnings.push(`Adopted the hub branch for thread ${target.threadId} into session ${baseSessionId}; your local branch was preserved in full as session ${preservedSessionId}, which has no thread mapping and will therefore be published as its own thread on the next push.`);
                                    // Only reachable with --force-append (the refusal above owns
                                    // the unforced case), so this is the consequence the user
                                    // consented to, restated now that it is real.
                                    if (looksLive) {
                                        warnings.push(`Session ${baseSessionId} was modified ${Math.round(baseAgeMs / 1000)}s ago and was adopted anyway because --force-append was passed. If a Claude Code session is still open on it, exit it now: anything it writes from here chains onto the adopted hub branch, not onto the local branch preserved as ${preservedSessionId}.`);
                                    }
                                    threadLandedSessionId = baseSessionId;
                                    continue; // bundle handled — no fragment import
                                }
                                warnings.push(`adopt-hub failed for thread ${target.threadId} and session ${baseSessionId} was restored unchanged (${adopt.detail}) — importing the hub's branch as a separate session instead.`);
                                divergence.resolution = "fragment";
                            }
                            else if (mode === "adopt-hub") {
                                warnings.push(`adopt-hub is unavailable for thread ${target.threadId}: the continuation's anchor ${divergence.anchorUuid} is not present in the local session ${baseSessionId} (unrelated or compacted history) — importing the hub's branch as a separate session instead.`);
                                divergence.resolution = "fragment";
                            }
                            else if (divergence.adoptAvailable) {
                                warnings.push(`Thread ${target.threadId} has diverged: ${forkSummary}, so the hub's branch was imported as a separate session and nothing local was touched. Re-run with --on-divergence adopt-hub to make the hub's branch canonical and keep your branch as a second session, or --on-divergence skip to decide later.`);
                            }
                            else {
                                warnings.push(`Thread ${target.threadId} could not be continued locally: ${forkSummary}. The hub's branch was imported as a separate session and nothing local was touched — adopt-hub cannot help here.`);
                            }
                            // fall through to the fragment import
                        }
                        else {
                            warnings.push(`Continuation for thread ${target.threadId} could not be appended to the local session (${outcome.detail}) — imported as a separate session instead.`);
                        }
                    }
                }
            }
            const importResult = await importSession({
                exportPath: extractDir,
                targetConfigDir: opts.configDir,
                targetProjectPath: effectiveProjectPath,
                targetClaudeVersion: opts.claudeVersion,
                dryRun: false,
                sessionIds: [record.sessionIdInBundle],
            });
            if (!importResult.success)
                return importResult; // importer already rolled back partial writes
            importedSessions.push(...importResult.importedSessions);
            skippedSessions.push(...importResult.skippedSessions);
            warnings.push(...importResult.warnings);
            if (importResult.importedSessions.length > 0) {
                lastImportedNewId = importResult.importedSessions[importResult.importedSessions.length - 1].newId;
                // The freshly written session now carries the thread: a later
                // continuation in this same chain must splice onto IT, not onto
                // whatever older session the mapping still points at. Its mtime is
                // inside this operation, so the liveness guard exempts it.
                threadLandedSessionId = lastImportedNewId;
                // The hub is the origin of this bundle's content, so as far as this
                // machine's OWN sync-state is concerned the hub already has it up to
                // this head — record that against the hub's own peer id (not the
                // originating machine's, which importSession already recorded above)
                // so a future push of just-appended content is recognized as a
                // continuation instead of re-uploading the whole session as "full".
                recordSentToPeer(effectiveProjectPath, { id: hubPeerId, name: "hub" }, lastImportedNewId, {
                    headEntryUuid: record.headEntryUuid,
                    messageCount: record.messageCount,
                    sentAsType: record.type,
                    sentAsSessionId: record.sessionIdInBundle,
                });
            }
        }
        // Thread mapping: prefer the session this pull actually landed content
        // in (an imported fragment or an appended base); if every bundle in the
        // chain was skipped, fall back to (1) the local session id an earlier
        // receipt from this peer was recorded against, then (2) the imported-hash
        // registry — the cross-route duplicate case, where identical content
        // arrived earlier via a plain import (no peer bookkeeping) and the
        // importer skipped it via state.imported[integrityHash] rather than
        // peers[...].received.
        const lastRecord = needed[needed.length - 1];
        const stateAfter = readSyncState(effectiveProjectPath);
        const lastSessionManifest = lastBundleManifest?.sessions.find((s) => s.sessionId === lastRecord.sessionIdInBundle) ?? null;
        const hashRegistryFallback = lastSessionManifest
            ? stateAfter.imported[lastSessionManifest.integrityHash]?.localSessionId
            : undefined;
        const localSessionId = threadLandedSessionId ??
            stateAfter.peers[sourceCopy.machineId]?.received[lastRecord.sessionIdInBundle]?.localSessionId ??
            hashRegistryFallback ??
            null;
        if (localSessionId !== null) {
            setThreadId(stateAfter, hub.hubId, localSessionId, target.threadId);
            writeSyncState(stateAfter);
        }
        else if (!skippedByDivergence) {
            // Never map a thread to a fabricated id (an empty string would poison
            // the index projection below and every future pull's dedup).
            //
            // Gated on the divergence skip, which lands here by design: nothing was
            // applied, so there is nothing to map, and the skip warning has already
            // said exactly that. "Its session could not be identified" would be a
            // second, contradictory story about a deliberate no-op.
            warnings.push("pulled content already exists locally but its session could not be identified — a future push from this machine will re-map the thread");
        }
        // Rewrite our machine index over current local sessions — pulls never
        // create bundles, so newBundles is always empty here.
        //
        // Unless the run was a pure divergence skip, where "nothing changed" has
        // to include the index. The projection reads the LOCAL session head, so
        // rewriting it here would publish the local branch's head — which no
        // bundle on the hub backs — and make this machine the thread's most
        // recent copy. The re-run the skip warning promises would then be refused
        // outright ("the latest copy of this thread is already local"), turning
        // "decide later" into "decide never".
        const appliedNothing = importedSessions.length === 0 &&
            skippedSessions.length === 0 &&
            appended.length === 0 &&
            workspaceUnpacked === null;
        if (!(skippedByDivergence && appliedNothing)) {
            const sessionsNow = discoverSessions(opts.configDir, effectiveProjectPath).map((s) => ({
                sessionId: s.sessionId,
                slug: s.slug,
                summary: s.slug,
                headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
                messageCount: s.messageCount,
                lastActiveAt: s.lastActiveAt,
            }));
            const prior = await readMachineIndex(backend, local.projectId, machine.id);
            await writeMachineIndex(backend, buildIndexFile({
                projectId: local.projectId,
                machineId: machine.id,
                projectPath: effectiveProjectPath,
                sessions: sessionsNow,
                state: stateAfter,
                priorIndex: prior,
                newBundles: [],
                now: new Date().toISOString(),
            }));
        }
        opts.onProgress?.({ phase: "hub-pull", percent: 100 });
        return {
            success: true,
            command: "pull",
            threadId: target.threadId,
            sourceMachineId: sourceCopy.machineId,
            importedSessions,
            skippedSessions,
            localSessionId,
            workspaceUnpacked,
            appended: appended.length > 0 ? appended : undefined,
            divergence: lastDivergence,
            warnings,
        };
    }
    finally {
        if (tempRoot)
            rmSync(tempRoot, { recursive: true, force: true });
        lock.release();
    }
}
//# sourceMappingURL=pull.js.map