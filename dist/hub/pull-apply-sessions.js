import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { adoptHubBranch, readDeltaChainInfo, tryAppendContinuation, APPEND_LIVE_WINDOW_MS, } from "./append.js";
import { importSession } from "../importer.js";
import { computeIntegrityHashFromFile } from "../manifest.js";
import { findEntryOffsetByUuid, readLastConversationEntry, readLastEntryUuid, } from "../jsonl.js";
import { buildImportRewriteContext, rewriteJsonlStream } from "../rewriter.js";
import { getApplicableAdapters } from "../version-adapters.js";
import { readSyncState, recordSentToPeer } from "../sync-state.js";
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
/**
 * Head uuid + last-entry timestamp from one bounded tail read.
 *
 * Both come from the SAME entry — the last conversation entry — on purpose.
 * `selectThreadBase` above uses them as a pair (anchor match first, then
 * recency), and `resolveThreads` does the same across machines; taking the
 * uuid from one line and the timestamp from a later bookkeeping line would
 * describe two different points in the transcript and make that comparison
 * incoherent. A `queue-operation` or `pr-link` timestamp is real wall-clock
 * activity, but it is not conversation, and "which copy has the most
 * conversation" is the question these fields are asked.
 */
function readSessionTail(path) {
    const e = readLastConversationEntry(path);
    if (!e)
        return { headEntryUuid: null, lastActiveAt: null };
    return {
        headEntryUuid: typeof e.uuid === "string" ? e.uuid : null,
        lastActiveAt: typeof e.timestamp === "string" ? e.timestamp : null,
    };
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
 * Land ONE bundle's session content: splice it onto an existing transcript,
 * adopt the hub's branch over a diverged one, or import it as its own session.
 *
 * Runs inside `hubPull`'s per-bundle loop, after `fetch` and `apply.workspace`
 * for the same bundle. Three things about it are load-bearing and invisible in
 * the signature:
 *
 * 1. **`state` is mutated in place** — see the field doc above.
 * 2. **The `divergence` object is ALIASED into `state.lastDivergence`, not
 *    copied.** `.resolution` is written at three points AFTER the assignment
 *    and `.preservedSessionId` at one. Assigning a spread (`{...divergence}`),
 *    or returning it as a value for the caller to assign, freezes `resolution`
 *    at the requested mode and leaves `preservedSessionId` permanently
 *    undefined — with no type error anywhere. The literal, the alias and all
 *    four later writes have to stay on one binding.
 * 3. **`tryAppendContinuation` and `adoptHubBranch` are NOT wrapped in a
 *    `try`/`catch`, and must not be.** They refuse-and-throw when a
 *    transcript's size is not exactly what our own write accounts for — the
 *    rollback rule that stops us reporting a clean restore over another
 *    writer's bytes. `hubPull`'s outer block has only a `finally`, so that
 *    throw reaches the CLI intact. A catch added "to make the stage total"
 *    turns the loudest safety property in the codebase into a silent decline,
 *    and the fragment import below would then run on top of a base that may
 *    hold another writer's bytes. `try`/`finally` is fine; `try`/`catch` is
 *    not.
 *
 * The `RewriteContext` is built HERE, per bundle, from this bundle's manifest —
 * never handed in. `append.ts` does neither the path rewrite nor the version
 * adaptation, so the delta has to be rewritten before it reaches either splice
 * path; and one context for a whole chain is wrong the moment two bundles come
 * from machines with different source paths.
 */
export async function runApplySessionsStage(input) {
    const { extractDir, bundleManifest, record, chainLength, projectPath, configDir, targetProjectDir, claudeVersion, threadId, bundleMachineId, hubPeerId, noAppend, forceAppend, onDivergence, opNowMs, ageNowMs, historyNowDate, historyNowMs, recordSplice, countEntriesAfterOffset, } = input;
    // Short local names for the two the moved warning strings interpolate, so
    // their text stays byte-identical (tests/hub-warning-flags.test.ts scans
    // src/hub/*.ts line by line).
    const st = input.state;
    const i = input.bundleIndex;
    const reasons = [];
    // Append path: a continuation whose chain matches one of this thread's
    // local sessions splices onto that session, so the conversation stays
    // one resumable transcript. Every guard lives in append.ts and ANY
    // decline falls through to the import below — content always arrives,
    // at worst as the Slice-1 fragment.
    const bundleSession = bundleManifest.sessions.find((s) => s.sessionId === record.sessionIdInBundle);
    const deltaPath = join(extractDir, "sessions", `${record.sessionIdInBundle}.jsonl`);
    if (record.type === "continuation" && !noAppend && bundleSession && existsSync(deltaPath)) {
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
            reasons.push(`Continuation for thread ${threadId} failed its integrity check (bundle content doesn't match the manifest hash) — not spliced into the existing session; importing it as a separate session instead.`);
        }
        else {
            // Which of this thread's local sessions does this delta continue?
            // Decided by the delta's own anchor, never by map order — see
            // selectThreadBase. Re-read state because importSession rewrites it
            // between iterations.
            const deltaInfo = await readDeltaChainInfo(deltaPath);
            const anchorUuid = deltaInfo.firstEntryParentUuid;
            const baseSessionId = selectThreadBase(threadBaseCandidates(readSyncState(projectPath), threadId, st.threadLandedSessionId, targetProjectDir), anchorUuid, st.threadLandedSessionId);
            if (baseSessionId) {
                const basePath = join(targetProjectDir, `${baseSessionId}.jsonl`);
                // Identical derivation to importSession's — same manifest, same
                // target — so a spliced continuation and an imported fragment
                // carry byte-identical rewrites.
                const ctx = buildImportRewriteContext(bundleManifest, projectPath, configDir);
                // Captured before the attempt, kept only if it succeeds: a declined
                // append writes nothing, and recording an offset for it would make a
                // later bundle discount entries that ARE the user's own.
                const baseSizeBeforeAppend = statSync(basePath).size;
                const outcome = await tryAppendContinuation({
                    basePath,
                    baseSessionId,
                    deltaPath,
                    ctx,
                    adapters: getApplicableAdapters(bundleManifest.sourceClaudeVersion, claudeVersion),
                    opNowMs,
                    force: forceAppend,
                });
                if (outcome.kind === "appended") {
                    st.rememberOurWrite(basePath, baseSizeBeforeAppend);
                    recordSplice({
                        projectPath, basePath, baseSessionId,
                        peerId: bundleMachineId, hubPeerId, manifest: bundleManifest,
                        record, bundleSession, newHeadUuid: outcome.newHeadUuid,
                    });
                    // Best effort by design: layers are auxiliary artifacts
                    // (subagent transcripts, tool-result blobs, file-history
                    // backups). Losing them costs detail, never transcript
                    // integrity — and the splice above is already committed, so a
                    // throw here would be strictly worse than a warning.
                    try {
                        await copyLayerDirs(extractDir, record.sessionIdInBundle, targetProjectDir, baseSessionId, configDir, ctx);
                    }
                    catch (e) {
                        reasons.push(`Continuation was appended to session ${baseSessionId}, but copying its subagent/tool-result/file-history files failed (${e.message}) — the transcript is complete; those side files are missing.`);
                    }
                    st.appended.push({
                        threadId,
                        baseSessionId,
                        entriesAppended: outcome.entriesAppended,
                    });
                    st.threadLandedSessionId = baseSessionId;
                    st.lastAppliedIndex = i;
                    st.lastBundleManifest = bundleManifest;
                    return { control: { kind: "next" }, reasons }; // bundle handled — no fragment import
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
                    // "Entries the hub hasn't seen" must mean the USER's entries. An
                    // earlier bundle of this same pull may have spliced onto this very
                    // transcript, and those entries came FROM the hub moments ago — a
                    // measured fork of 4 was 2 local entries plus this pull's own 2.
                    // Our writes are contiguous at the end of the file, so everything
                    // at or after `ourStart` is ours; counting from the later of the
                    // two offsets subtracts exactly that tail and leaves the entries
                    // between the anchor and our first byte, which are the real fork.
                    const rawSinceAnchor = anchorOffset === null ? 0 : await countEntriesAfterOffset(basePath, anchorOffset);
                    const ourStart = st.ourWritesFrom.get(basePath);
                    const oursSinceAnchor = anchorOffset === null || ourStart === undefined
                        ? 0
                        : await countEntriesAfterOffset(basePath, Math.max(anchorOffset, ourStart));
                    const baseMtimeMs = statSync(basePath).mtimeMs;
                    const mode = onDivergence ?? "fragment";
                    const divergence = {
                        threadId,
                        anchorUuid: anchorUuid ?? "",
                        localSessionId: baseSessionId,
                        localHeadUuid: readLastEntryUuid(basePath) ?? "",
                        localEntriesSinceAnchor: Math.max(0, rawSinceAnchor - oursSinceAnchor),
                        localLastActiveAt: new Date(baseMtimeMs).toISOString(),
                        hubHeadUuid: deltaInfo.lastEntryUuid ?? "",
                        // The synthetic continuation header is bundle plumbing, not a
                        // message — counting it would overstate the hub's side by one.
                        hubEntriesSinceAnchor: Math.max(0, bundleSession.messageCount - (deltaInfo.headerPresent ? 1 : 0)),
                        hubLastActiveAt: record.pushedAt,
                        adoptAvailable: anchorOffset !== null,
                        resolution: mode,
                    };
                    // ALIASED, never copied: `.resolution` is rewritten at three points
                    // below and `.preservedSessionId` at one, and every one of them has
                    // to be visible through this field.
                    st.lastDivergence = divergence;
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
                    const baseAgeMs = ageNowMs - baseMtimeMs;
                    const looksLive = baseMtimeMs < opNowMs && baseAgeMs < APPEND_LIVE_WINDOW_MS;
                    if (mode === "skip") {
                        // Two texts, because "nothing changed" is only true at the head
                        // of the chain. At i > 0 the abort still leaves the FORK
                        // undecided and this bundle unrecorded — which is what keeps the
                        // re-run honest — but the bundles before it are applied and
                        // recorded, and saying otherwise is a false statement about the
                        // user's own transcripts.
                        reasons.push(i === 0
                            ? `Thread ${threadId} has diverged: ${forkSummary} — skipped, nothing changed. Re-run with --on-divergence fragment${divergence.adoptAvailable ? " or adopt-hub" : ""} to decide.`
                            : `Thread ${threadId} has diverged: ${forkSummary} — this bundle was skipped and the fork is still undecided, but ${st.describeApplied(i)}, so this pull was not a no-op. Re-run with --on-divergence fragment${divergence.adoptAvailable ? " or adopt-hub" : ""} to decide; the re-run resumes at this bundle, not at the start of the chain.`);
                        st.skippedByDivergence = true;
                        // The whole thread stops here, not just this bundle — see
                        // `divergenceAborted`. Nothing is recorded FOR THIS BUNDLE OR
                        // ANY LATER ONE, so the decision can still be made in full.
                        st.divergenceAborted = true;
                        st.abortIndex = i;
                        st.deferredBundles = chainLength - 1 - i;
                        return { control: { kind: "stop-chain" }, reasons };
                    }
                    if (mode === "adopt-hub" && divergence.adoptAvailable && looksLive && !forceAppend) {
                        // Refuse with SKIP semantics, never fragment, and stop the
                        // WHOLE THREAD rather than this one bundle. Falling through to
                        // the import would record the bundle in peers[...].received,
                        // selectNeededBundles would drop it from every later pull, and
                        // the instruction in this very warning would be impossible to
                        // carry out — "already up to date" on the re-run, recoverable
                        // only by hand-editing sync-state. Carrying on to the NEXT
                        // bundle of the chain foreclosed it just as thoroughly and far
                        // less visibly (see `divergenceAborted`). Refusing an operation
                        // must never also foreclose it, and a user who asked to adopt
                        // should not be permanently handed a fragment instead.
                        // `skippedByDivergence` is what keeps the thread resolvable (it
                        // suppresses the index rewrite and the "could not be
                        // identified" warning).
                        reasons.push(i === 0
                            ? `adopt-hub refused for thread ${threadId}: session ${baseSessionId} was modified ${Math.round(baseAgeMs / 1000)}s ago, so a Claude Code session may still be open on it — adopting would truncate a transcript that is being written to, and anything it writes afterwards would chain onto the hub's branch instead of yours. Nothing was applied and nothing was recorded: exit that session, then re-run with --on-divergence adopt-hub --force-append (or --on-divergence fragment to keep both as separate sessions).`
                            : `adopt-hub refused for thread ${threadId}: session ${baseSessionId} was modified ${Math.round(baseAgeMs / 1000)}s ago, so a Claude Code session may still be open on it — adopting would truncate a transcript that is being written to, and anything it writes afterwards would chain onto the hub's branch instead of yours. Nothing was applied or recorded for this bundle or any later one in the chain, so the adoption is still open; ${st.describeApplied(i)}. Exit that session, then re-run with --on-divergence adopt-hub --force-append (or --on-divergence fragment to keep both as separate sessions) — the re-run resumes at this bundle.`);
                        divergence.resolution = "skip";
                        st.skippedByDivergence = true;
                        st.divergenceAborted = true;
                        st.abortIndex = i;
                        st.deferredBundles = chainLength - 1 - i;
                        return { control: { kind: "stop-chain" }, reasons };
                    }
                    if (mode === "adopt-hub" && divergence.adoptAvailable) {
                        const preservedSessionId = randomUUID();
                        const preservedPath = join(targetProjectDir, `${preservedSessionId}.jsonl`);
                        const adopt = await adoptHubBranch({
                            basePath, baseSessionId, deltaPath,
                            anchorOffset: anchorOffset,
                            preservedSessionId, preservedPath, ctx,
                            adapters: getApplicableAdapters(bundleManifest.sourceClaudeVersion, claudeVersion),
                        });
                        if (adopt.kind === "adopted") {
                            // Same ordering rule as the plain append: durable
                            // bookkeeping first, then everything whose loss is a
                            // nuisance rather than a correctness problem.
                            recordSplice({
                                projectPath, basePath, baseSessionId,
                                peerId: bundleMachineId, hubPeerId, manifest: bundleManifest,
                                record, bundleSession, newHeadUuid: adopt.newHeadUuid,
                            });
                            // Register the preserved branch so it is resumable and
                            // findable. The "preserved" marker lives HERE, in the
                            // display name — never as an injected entry in the
                            // transcript itself.
                            try {
                                appendFileSync(join(configDir, "history.jsonl"), JSON.stringify({
                                    display: `${bundleSession.slug} (local divergence, preserved ${historyNowDate})`,
                                    pastedContents: {},
                                    timestamp: historyNowMs,
                                    project: projectPath,
                                    sessionId: preservedSessionId,
                                }) + "\n", "utf-8");
                            }
                            catch (e) {
                                reasons.push(`Your local branch was preserved as session ${preservedSessionId}, but registering it in history.jsonl failed (${e.message}) — the file is there and \`claude --resume ${preservedSessionId}\` still works; it just won't be listed.`);
                            }
                            // The adopted branch's layer files, onto the base — exactly
                            // as for a plain append. The PRESERVED session deliberately
                            // gets none: layer files are uuid-named under the base
                            // session's directories and stay there, shared history and
                            // local branch alike. Duplicating arbitrarily large blobs to
                            // give a second session the same auxiliary detail is a poor
                            // trade; the preserved transcript is complete without them.
                            try {
                                await copyLayerDirs(extractDir, record.sessionIdInBundle, targetProjectDir, baseSessionId, configDir, ctx);
                            }
                            catch (e) {
                                reasons.push(`The hub branch was adopted into session ${baseSessionId}, but copying its subagent/tool-result/file-history files failed (${e.message}) — the transcript is complete; those side files are missing.`);
                            }
                            divergence.preservedSessionId = preservedSessionId;
                            st.appended.push({
                                threadId,
                                baseSessionId,
                                entriesAppended: adopt.entriesAppended,
                            });
                            reasons.push(`Adopted the hub branch for thread ${threadId} into session ${baseSessionId}; your local branch was preserved in full as session ${preservedSessionId}, which has no thread mapping and will therefore be published as its own thread on the next push.`);
                            // Only reachable with --force-append (the refusal above owns
                            // the unforced case), so this is the consequence the user
                            // consented to, restated now that it is real.
                            if (looksLive) {
                                reasons.push(`Session ${baseSessionId} was modified ${Math.round(baseAgeMs / 1000)}s ago and was adopted anyway because --force-append was passed. If a Claude Code session is still open on it, exit it now: anything it writes from here chains onto the adopted hub branch, not onto the local branch preserved as ${preservedSessionId}.`);
                            }
                            st.threadLandedSessionId = baseSessionId;
                            st.lastAppliedIndex = i;
                            st.lastBundleManifest = bundleManifest;
                            st.rememberOurWrite(basePath, anchorOffset);
                            return { control: { kind: "next" }, reasons }; // bundle handled — no fragment import
                        }
                        reasons.push(
                        // "left unchanged", not "restored unchanged": a `failed`
                        // adoption covers both the restored-byte-for-byte case and
                        // the (more common) one where the fault landed before the
                        // truncate and nothing was ever written, so nothing was
                        // restored either. Either way the user's session is as it
                        // was, which is the part that matters to them.
                        `adopt-hub failed for thread ${threadId} and session ${baseSessionId} was left unchanged (${adopt.detail}) — importing the hub's branch as a separate session instead.`);
                        divergence.resolution = "fragment";
                    }
                    else if (mode === "adopt-hub") {
                        reasons.push(`adopt-hub is unavailable for thread ${threadId}: the continuation's anchor ${divergence.anchorUuid} is not present in the local session ${baseSessionId} (unrelated or compacted history) — importing the hub's branch as a separate session instead.`);
                        divergence.resolution = "fragment";
                    }
                    else if (divergence.adoptAvailable) {
                        // No re-run is offered, because none exists: the fragment
                        // import below records this bundle, after which
                        // `--on-divergence adopt-hub` reports "already up to date" and
                        // never reaches the fork. `skip` is named only as the mode to
                        // run the NEXT divergence under — it applies and records
                        // nothing, which is what keeps the choice open.
                        reasons.push(`Thread ${threadId} has diverged: ${forkSummary}, so the hub's branch was imported as a separate session and nothing local was touched. Both branches are now local sessions and this bundle is recorded as received, so that decision stands for it — adopt-hub cannot be applied to it afterwards. To be asked instead of having fragment chosen for you, pull with --on-divergence skip (what /sesh-mover:pull always passes) or set hub.onDivergence=skip.`);
                    }
                    else {
                        reasons.push(`Thread ${threadId} could not be continued locally: ${forkSummary}. The hub's branch was imported as a separate session and nothing local was touched — adopt-hub cannot help here.`);
                    }
                    // fall through to the fragment import
                }
                else {
                    // THIS bundle is foreclosed — the fragment import below records
                    // it, so nothing reaches it again — but the flag is not, and the
                    // two were being conflated. `--force-append` on the NEXT pull of
                    // this thread overrides the liveness guard for the continuation
                    // THAT pull carries, and it does splice (measured: one transcript,
                    // not two). So the scoping has to be explicit rather than the flag
                    // being withheld: naming it unscoped told users to re-run a pull
                    // that cannot work, and withholding it entirely told them nothing
                    // works, which is equally false. The preventive advice stays
                    // first because it is the answer that needs no flag. (The decline
                    // is left as a fragment rather than converted to a skip, unlike
                    // the adopt-hub refusal: a plain append is the default path, and
                    // the invariant that content always arrives — at worst as a
                    // second session — is worth more here than the chance to retry.)
                    const preventive = outcome.reason === "recently-active"
                        ? " Nothing local was touched. This bundle is now recorded, so no re-run applies it to the existing session. To have later continuations of this thread spliced in, close the Claude Code session writing to that transcript before pulling — and note that an earlier sesh-mover pull's own write to that session looks the same from here, in which case there is no session to close and passing --force-append on the next pull of this thread splices that pull's continuation instead."
                        : "";
                    reasons.push(`Continuation for thread ${threadId} could not be appended to the local session (${outcome.detail}) — imported as a separate session instead.${preventive}`);
                }
            }
        }
    }
    const importResult = await importSession({
        exportPath: extractDir,
        targetConfigDir: configDir,
        targetProjectPath: projectPath,
        targetClaudeVersion: claudeVersion,
        dryRun: false,
        sessionIds: [record.sessionIdInBundle],
    });
    // importer already rolled back partial writes. Returned VERBATIM by the
    // caller, `command: "import"` and all — and note this happens BEFORE the
    // importer's own warnings are folded into `reasons` below, exactly as it
    // did when this was a `return` out of hubPull's loop.
    if (!importResult.success)
        return { control: { kind: "fail", result: importResult }, reasons };
    st.lastAppliedIndex = i;
    st.lastBundleManifest = bundleManifest;
    st.importedSessions.push(...importResult.importedSessions);
    st.skippedSessions.push(...importResult.skippedSessions);
    reasons.push(...importResult.warnings);
    if (importResult.importedSessions.length > 0) {
        st.lastImportedNewId = importResult.importedSessions[importResult.importedSessions.length - 1].newId;
        // The freshly written session now carries the thread: a later
        // continuation in this same chain must splice onto IT, not onto
        // whatever older session the mapping still points at. Its mtime is
        // inside this operation, so the liveness guard exempts it.
        st.threadLandedSessionId = st.lastImportedNewId;
        // The hub is the origin of this bundle's content, so as far as this
        // machine's OWN sync-state is concerned the hub already has it up to
        // this head — record that against the hub's own peer id (not the
        // originating machine's, which importSession already recorded above)
        // so a future push of just-appended content is recognized as a
        // continuation instead of re-uploading the whole session as "full".
        recordSentToPeer(projectPath, { id: hubPeerId, name: "hub" }, st.lastImportedNewId, {
            headEntryUuid: record.headEntryUuid,
            messageCount: record.messageCount,
            sentAsType: record.type,
            sentAsSessionId: record.sessionIdInBundle,
        });
    }
    return { control: { kind: "next" }, reasons };
}
//# sourceMappingURL=pull-apply-sessions.js.map