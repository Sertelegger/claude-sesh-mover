import { buildIndexFile, readMachineIndex, writeMachineIndex } from "./index-file.js";
import { stageOk } from "./pull-stages.js";
import { discoverSessions } from "../discovery.js";
import { readLastEntryUuid } from "../jsonl.js";
import { getThreadId, readSyncState, setThreadId, writeSyncState } from "../sync-state.js";
/**
 * Which local session a bundle's content is in, asked of ONE bundle.
 *
 * THREE SOURCES, IN THIS ORDER, and the order is the whole content of the
 * function: the session this pull landed content in; failing that, the local
 * session an earlier receipt from THAT BUNDLE'S OWN machine was recorded
 * against; failing that, the imported-hash registry — the cross-route duplicate
 * case, where identical content arrived earlier via a plain import (no peer
 * bookkeeping) and the importer skipped it via `state.imported[integrityHash]`
 * rather than `peers[...].received`.
 *
 * ASKED OF `last.machineId`, NEVER OF THE PULL'S RESOLVED MACHINE. The receipt
 * was written by whoever supplied that bundle, so on a chain that spans machines
 * the resolved machine's ledger simply does not hold it.
 *
 * ONE COPY, TWO CALLERS, and they differ in exactly one thing: WHICH bundle they
 * call `last`. That choice is the caller's and is stated at each call site,
 * because the two are asking different questions — `flushThreadMapping` asks
 * about a bundle this pull has already applied, `runRecordStage` about the last
 * bundle it handled at all. Copying the resolution to say that would let the two
 * drift, and a mapping written from a bundle nobody opened is the failure this
 * whole path exists to avoid.
 */
function threadSessionFor(state, last, st) {
    const lastSessionManifest = st.lastBundleManifest?.sessions.find((s) => s.sessionId === last.record.sessionIdInBundle) ?? null;
    const hashRegistryFallback = lastSessionManifest
        ? state.imported[lastSessionManifest.integrityHash]?.localSessionId
        : undefined;
    return (st.threadLandedSessionId ??
        state.peers[last.machineId]?.received?.[last.record.sessionIdInBundle]?.localSessionId ??
        hashRegistryFallback ??
        null);
}
/**
 * Persist the thread mapping for what this pull has applied SO FAR, from inside
 * the per-bundle loop.
 *
 * **Why this exists at all, given `runRecordStage` writes the same mapping.**
 * The receipts — `peers[...].received` from `importSession`, and the hub ledger
 * `recordSentToPeer` credits — are written INSIDE the loop, one bundle at a
 * time. `runRecordStage` runs only after it. Three hard returns in that loop (a
 * fetch abort, a workspace abort, an import failure) leave bundles `0..i-1`
 * applied and credited and never reach the record stage at all, so the mapping
 * they earned was never written. That is not a crash window — #28's filed shape,
 * fixed by `backfillThreadMappings` — it is a deterministic route into the same
 * end state on an ordinary trigger (a bundle only partly delivered to a synced
 * hub folder), and `backfillThreadMappings` cannot repair it: that repair runs
 * only on exits where `needed` is EMPTY, and the deferred bundle was never
 * recorded as received, so the re-run's plan is non-empty and aborts again.
 *
 * WHAT IT COSTS WHEN IT IS MISSING. The next push finds a local session with no
 * thread id and MINTS A NEW THREAD for it (`push.ts`), and because the hub
 * ledger was already credited that push ships only a DELTA — a continuation
 * chain on the hub with no base bundle to anchor it, which is the
 * unreconstructable thread `recordSentToPeer`'s own invariant forbids by name.
 * `hub reindex` does not repair it either: it reads `getThreadId`, finds
 * nothing, and drops the session from the index with a warning. The auto-push is
 * default-on and unattended, so it routinely fires before the user retries.
 *
 * **It may never map a bundle that was not applied**, which is what the
 * `lastAppliedIndex < 0` gate is for and why the gate is on THAT and not on
 * `needed.length`. `lastAppliedIndex` is written by the sessions stage only once
 * a bundle has been spliced, adopted or imported, so `needed[lastAppliedIndex]`
 * is by construction a bundle this pull really handled. `runRecordStage`'s own
 * index expression deliberately falls back to `needed.length - 1` when nothing
 * was applied; reusing that here would ask the receipt ledger about a bundle
 * nobody opened.
 *
 * Idempotent, and quiet when there is nothing to do: it writes at most once per
 * pull per session, and returns without touching the state file when the mapping
 * it would write is already there. `runRecordStage` still writes the mapping at
 * the end of a pull that gets that far — this makes the mapping as durable as
 * the receipt written beside it, it does not replace the projection.
 */
export function flushThreadMapping(input) {
    const { effectiveProjectPath, hubId, threadId, needed, apply: st } = input;
    if (st.lastAppliedIndex < 0)
        return false;
    const state = readSyncState(effectiveProjectPath);
    const localSessionId = threadSessionFor(state, needed[st.lastAppliedIndex], st);
    // Never map a thread to a fabricated id — same rule as the record stage. The
    // silence is deliberate: this is a durability step inside a loop, and the
    // "its session could not be identified" sentence belongs to the one stage
    // that knows the pull is over.
    if (localSessionId === null)
        return false;
    if (getThreadId(state, localSessionId) === threadId)
        return false;
    setThreadId(state, hubId, localSessionId, threadId);
    writeSyncState(state);
    return true;
}
/**
 * The pull's last stage: map the thread onto a local session, then republish
 * this machine's index over what the project now holds.
 *
 * **The outcome is always `applied`.** A skip or a refusal would carry no
 * value, and `hubPull` needs `localSessionId` unconditionally; both would also
 * demand a reason, while the pure-divergence-skip case deliberately emits none.
 * The gaps this stage can hit are reported as `reasons` on an applied outcome,
 * which is what that status means here (see `pull-stages.ts`).
 *
 * `SyncState` is read, mutated, persisted and projected inside this one body on
 * purpose: `importSession` and `recordSplice` rewrite the file between apply
 * iterations, so a snapshot taken by the caller would be stale, and the object
 * handed to `buildIndexFile` must be the same one `setThreadId` just mutated.
 */
export async function runRecordStage(input) {
    const { backend, configDir, effectiveProjectPath, projectId, machineId, hubId, threadId, needed, apply: st, } = input;
    const reasons = [];
    // Thread mapping, resolved by `threadSessionFor` — see it for the three
    // sources and their order. What is decided HERE is only WHICH bundle to ask
    // about, and that choice is this stage's alone (`flushThreadMapping` makes the
    // opposite one, for a stated reason).
    //
    // `lastRecord` is the last bundle this pull actually FETCHED, which stopped
    // being `needed[needed.length - 1]` the moment a divergence could break the
    // loop: after an abort that index names a bundle nobody opened, and looking
    // its `sessionIdInBundle` up in `received` is a question about content this
    // machine never saw. It misses harmlessly today (that key is only ever
    // written by an import that did happen), but it is a landmine if the keying
    // changes — so ask about a bundle that was really handled, and fall back to
    // the diverged one when the abort landed at the head of the chain.
    //
    // ASKED OF `last.machineId`, NEVER OF THE PULL'S RESOLVED MACHINE. The
    // receipt was written by whoever supplied that bundle, so on a chain that
    // spans machines the resolved machine's ledger simply does not hold it: the
    // lookup misses, falls through to the hash registry or to null, and a pull
    // that DID land content reports "its session could not be identified" and
    // writes no thread mapping — which is the interrupted-pull state
    // `backfillThreadMappings` exists to repair, manufactured on a healthy pull.
    const last = needed[st.lastAppliedIndex >= 0 ? st.lastAppliedIndex : st.divergenceAborted ? st.abortIndex : needed.length - 1];
    const stateAfter = readSyncState(effectiveProjectPath);
    const localSessionId = threadSessionFor(stateAfter, last, st);
    if (localSessionId !== null) {
        setThreadId(stateAfter, hubId, localSessionId, threadId);
        writeSyncState(stateAfter);
    }
    else if (!st.skippedByDivergence) {
        // Never map a thread to a fabricated id (an empty string would poison
        // the index projection below and every future pull's dedup).
        //
        // Gated on the divergence skip, which lands here by design: nothing was
        // applied, so there is nothing to map, and the skip warning has already
        // said exactly that. "Its session could not be identified" would be a
        // second, contradictory story about a deliberate no-op.
        reasons.push("pulled content already exists locally but its session could not be identified — a future push from this machine will re-map the thread");
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
    //
    // A workspace application deliberately does NOT count here. The index is a
    // projection of SESSIONS — unpacking or merging files into the project
    // directory changes nothing it publishes — so letting it defeat the
    // suppression would republish the local branch's head and foreclose the
    // re-run for a reason unrelated to sessions. Before Slice 2 that pairing
    // needed --force-workspace to reach; now that a routine pull merges a
    // workspace automatically, it would be the common case. The index stays as
    // it was for one pull and the next push/pull (or `hub reindex`) rewrites
    // it — it is a derived file by design.
    //
    // That "does not count" is enforced by the TYPE, not by care: RecordApplyView
    // has no workspace fields to read.
    const appliedNothing = st.importedSessions.length === 0 &&
        st.skippedSessions.length === 0 &&
        st.appended.length === 0;
    let indexWritten = false;
    if (!(st.skippedByDivergence && appliedNothing)) {
        // Listed HERE, after the apply loop, so the index publishes the sessions
        // this pull just imported or spliced. A list computed by the caller before
        // the loop publishes a stale head.
        // No `summary` here: `buildIndexFile` derives the thread entry's from the
        // slug, and is the only thing that writes it (see index-file.ts).
        const sessionsNow = discoverSessions(configDir, effectiveProjectPath).map((s) => ({
            sessionId: s.sessionId,
            slug: s.slug,
            headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
            messageCount: s.messageCount,
            lastActiveAt: s.lastActiveAt,
        }));
        const prior = await readMachineIndex(backend, projectId, machineId);
        await writeMachineIndex(backend, buildIndexFile({
            projectId,
            machineId,
            projectPath: effectiveProjectPath,
            sessions: sessionsNow,
            state: stateAfter,
            priorIndex: prior,
            newBundles: [],
            now: new Date().toISOString(),
        }));
        indexWritten = true;
    }
    return stageOk({ localSessionId, indexWritten }, reasons);
}
//# sourceMappingURL=pull-record.js.map