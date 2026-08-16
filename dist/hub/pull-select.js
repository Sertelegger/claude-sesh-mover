/**
 * The pull's SELECT + REPAIR stage: which thread this pull is about, which
 * machine's copy of it it resolves to, and which of that copy's bundles are
 * still needed here.
 *
 * NOT a pure selector, and deliberately not named like one. `backfillThreadMappings`
 * WRITES sync-state (#28's crash window), so two of the seven exits below leave
 * the disk changed while handing back `success: false`. A caller may not treat a
 * non-proceed outcome as "nothing happened".
 *
 * SEVEN EXITS, and two of them cannot be an `ErrorResult` — which is why this
 * module carries its own outcome union rather than `StageOutcome`/`stageAbort`:
 * the pick list is `success: true` (`HubPullListResult`, so a status named
 * `aborted` inverts its meaning) and the not-yet-synced result has no `error`
 * field at all (so the synthesized `reasons: [terminal.error]` has nothing to
 * read).
 *
 * The UNION now has a producer for every kind: chain assembly landed and
 * `report` is reached from the empty-plan branch (see `SelectReport`).
 *
 * THE SYNC-STATE SPLIT IS LOAD-BEARING, so this stage takes a project PATH and
 * does its own I/O rather than accepting a `SyncState`. Only `readSyncState`
 * renames a corrupt file aside, and which branch has earned the right to do
 * that is decided per branch — `backfillThreadMappings` applies the rule twice
 * inside itself, peeking to ask whether there is anything to repair and reading
 * only once there is. Collapsing the two into one passed-in value would make a
 * `--latest` pull that finds nothing to do start renaming state files aside, on
 * the code path the SessionStart hook also runs.
 *
 * #35 (CHAIN ASSEMBLY) LANDED HERE, and this is the seam it landed in: `needed`
 * is no longer drawn from one machine's bundle list. `planThreadPull` assembles
 * every machine's records for the thread into one link-ordered plan and the
 * per-record receipt filter runs over that; `sourceCopy` survives as "the
 * machine this pull resolved to", which is the source label and the fallback
 * list for a hub whose bundles predate the link field, and is no longer the
 * answer to "which peer supplied this record" (that is per record, on `needed`).
 *
 * #44 IS NOW WHOLE. Every selector — `--thread`, `--latest`, and `whereis`'s
 * `pullNeeded` — asks one question, through `pullSourceFor`: is the assembled
 * chain fully received here? #44 closed the same-machine half and said so; the
 * cross-machine half closed when `pullSourceFor`'s body started asking the
 * assembled plan instead of one machine's list, which is why all three
 * selectors moved together with no edit at any call site. Head equality still
 * decides nothing; it survives only as `WhereisThread.localCopy.current`, a
 * display field.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { alternateSource, findUnfetchableBundles, planThreadPull, pullSourceFor, sourcedKey, } from "./threads.js";
import { createMachineNameLookup, shapeThreads } from "./whereis.js";
import { readSyncState, peekSyncState, writeSyncState, getThreadId, setThreadId, } from "../sync-state.js";
/**
 * The half of a thread this pull could not reach, in words.
 *
 * WHAT THIS SENTENCE USED TO CLAIM, AND WHY IT NO LONGER DOES. It ended
 * "…no flag or re-run fetches them — sesh-mover cannot yet assemble a thread
 * whose history is split across machines", and its doc argued the foreclosure
 * was deliberate. It was right when written and #35 is exactly what invalidates
 * it: a pull now assembles a thread across EVERY machine's bundle list, so the
 * split-history case this sentence was written for is the ordinary case that
 * arrives whole. Leaving the claim in place would put it in the milestone's own
 * defect class from the other side — a message that forecloses a remedy which
 * exists is as wrong as one that invents a remedy which does not.
 *
 * IT STILL NAMES NO FLAG, for a reason that survived the change: there is no
 * `--from-machine`, `--thread` and `--target-path` resolve to the same single
 * source, and `hub reindex` only rebuilds this machine's index from its own
 * bundles. What CHANGED the outcome is on the hub — a bundle pushed, a link
 * recorded — never an argument to this command.
 *
 * WHAT SURVIVES THE SUBTRACTION IS NARROWER, and that is what this text now
 * describes. Both callers subtract the assembled plan from
 * `findUnfetchableBundles` (spec §6), so a group here holds only bundles the
 * chain does not reach: behind a gap, on a branch this pull did not follow, or
 * pushed before links were recorded at all. This sentence names the MACHINES and
 * says nothing about WHICH of those it is — `describeAssembly` computes that
 * from the walk itself and is emitted beside this sentence wherever the walk
 * could tell. It is deliberately not a cross-reference ("see the note beside
 * this one"): there is a residual class where the heuristic sees records the
 * walk cannot account for, and a promise of a note that is not there is the
 * foreclosure defect wearing its opposite face. Restating the condition rule
 * here would be a second copy of it, which is how the two come to disagree.
 *
 * Machine names are capped at three so a hub with many machines still
 * produces one readable sentence; the full set is in the typed field.
 *
 * MACHINE NAMES ARE NOT UNIQUE. They come from the hostname, so a VM clone or
 * two default installs on same-named hosts give two machine ids one name — and
 * this sentence names a machine three times in three different roles, which
 * with bare names degenerates to "mbp holds bundles that mbp does not list …
 * the one machine it resolves to (mbp)". Any name shared by two of the roles in
 * THIS sentence therefore carries its machine id.
 */
export function describeUnfetchable(threadId, groups, source) {
    const NAMED = 3;
    const byName = new Map();
    for (const m of [source, ...groups]) {
        if (m.machineName)
            byName.set(m.machineName, (byName.get(m.machineName) ?? 0) + 1);
    }
    const label = (m) => !m.machineName
        ? m.machineId
        : (byName.get(m.machineName) ?? 0) > 1
            ? `${m.machineName} [${m.machineId}]`
            : m.machineName;
    const sourceLabel = label(source);
    const one = (g) => `${label(g)} (${g.bundleIds.length} bundle${g.bundleIds.length === 1 ? "" : "s"})`;
    const rest = groups.length - NAMED;
    const list = groups.slice(0, NAMED).map(one).join(", ") +
        (rest > 0 ? ` and ${rest} more machine${rest === 1 ? "" : "s"}` : "");
    const hold = groups.length === 1 ? "holds bundles" : "hold bundles";
    return (`Thread ${threadId} could not be pulled whole: ${list} ${hold} for it that ${sourceLabel} does not list, ` +
        `and although a pull now assembles a thread across every machine's bundle list rather than only the one ` +
        `it resolves to (${sourceLabel}), these bundles are not in the chain it assembled. The entries in them ` +
        `are not on this machine. Nothing is lost: every bundle is still on the hub.`);
}
function count(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
}
/**
 * The suggestion beside every "there is nothing left for this pull to fetch, and
 * the thread is still not whole here" refusal.
 *
 * ONE FUNCTION, THREE CALL SITES, and that is the point of it existing. What
 * stood at those three sites was a hand-copied sentence ending "…and no flag
 * makes one pull read two machines' lists, so a thread whose history is split
 * across machines cannot be assembled here yet" — the same foreclosure
 * `describeUnfetchable` carried, in the field a user is most likely to act on.
 * Three copies is how one of them gets fixed and two do not, so the sentence is
 * now written once and parameterised on the only thing that ever differed
 * between the copies: whether it is talking about one thread or several.
 *
 * IT STILL NAMES NO FLAG. #35 retired "cannot be assembled here yet", not the
 * reason there is nothing to offer: what changes this outcome is a bundle
 * appearing on the hub, or a link recorded by a push, and neither is an argument
 * to this command.
 */
function noMoreToFetch(scope) {
    return ("Nothing is left for this machine to fetch. This pull assembles a thread across every machine's " +
        "bundle list, and what it names here is outside the chain it could assemble — a gap, a branch it did " +
        "not follow, or a bundle pushed before sesh-mover recorded chain links; the warnings say which, where " +
        "the walk could tell. Running it again answers the same, because what would change the answer is on " +
        "the hub rather than in this command. " +
        `Run whereis — the same ${scope === "thread" ? "thread reports" : "threads report"} it as unfetchableBundles.`);
}
/** At most three ids, so one sentence stays readable however wide the hub is. */
function someIds(ids) {
    const NAMED = 3;
    const rest = ids.length - NAMED;
    return ids.slice(0, NAMED).join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}
/**
 * What chain assembly worked out about a thread and could NOT deliver — one
 * sentence and one typed field per KIND of anomaly, never one per record.
 *
 * THE FIVE ARE DELIBERATELY FIVE SENTENCES, because they are five different
 * facts with five different answers, and spec §0b exists to keep the first two
 * apart:
 *
 * - a GAP is a link naming an entry no bundle carries: something is missing;
 * - a PRE-ASSEMBLY record is a bundle pushed before `anchorEntryUuid` existed:
 *   nothing is missing, the link was never written, and a fresh push re-links
 *   it. Reporting it as a gap would send a user hunting for a bundle that is
 *   sitting right there;
 * - a PARKED branch is a real fork on the hub — this pull followed one side;
 * - an UNWALKED ROOT is a second starting point for the same thread, which is
 *   ORDINARY rather than damage (`computeIncrementalPlan` re-sends a session
 *   whole after a compaction and `push.ts` files it under the same thread id) —
 *   but a pull walks one of them, and saying nothing about the other is how a
 *   thread silently arrives half-length. Two roots can never be joined: a
 *   compaction rewrites the very uuids a link would need;
 * - an ADVERTISED-BUT-UNSHIPPED head is not on the hub at all, so no pull of
 *   any kind reaches it. That one is `reportOnly`: on a pull that applied
 *   something it is noise about another machine's local state, while on a pull
 *   that applied nothing it is frequently the entire answer to "why".
 *
 * ONLY OUTSTANDING RECORDS ARE EVER NAMED — `outstanding` is `planThreadPull`'s
 * own answer to "what is this pull leaving where it is", i.e. every record this
 * machine neither already holds nor is about to fetch. The rule is not restated
 * here on purpose: a hand-written second copy of the receipt test is how a
 * disclosure comes to name a bundle the user received months ago. Our own
 * advertised head is excluded for the analogous reason — it is local work we
 * have not pushed yet, which is the ordinary state of every machine
 * mid-session.
 *
 * THE UNWALKED-ROOT GATE IS BY BUNDLE ID rather than by sourced key, and that is
 * the one place this file is deliberately looser than `outstanding`'s own
 * identity. A root's reachable set is a set of bundle IDS (`ChainRoot.bundleIds`
 * — the walk crosses machines, so the ids in it do not all belong to the root's
 * own machine), and rebuilding the pairing here would mean re-walking the chain
 * outside `assembleChain`. Erring toward naming a root is the right direction
 * for the one condition whose silence costs a user half a conversation.
 */
async function describeAssembly(threadId, assembled, args) {
    const { localMachineId, outstanding, outstandingIds, machineName } = args;
    const left = (machineId, bundleId) => outstanding.has(sourcedKey(machineId, bundleId));
    const label = async (id) => (await machineName(id)) ?? id;
    const withName = async (rows) => Promise.all(rows.map(async (r) => ({ ...r, machineName: await machineName(r.machineId) })));
    const notes = [];
    const findings = {};
    const gaps = assembled.gaps.filter((g) => left(g.machineId, g.bundleId));
    if (gaps.length > 0) {
        const stranded = new Set(gaps.flatMap((g) => g.strandedBundleIds));
        for (const g of gaps)
            stranded.delete(g.bundleId);
        findings.chainGaps = await withName(gaps);
        notes.push(`Thread ${threadId} could not be assembled whole: ${count(gaps.length, "bundle")} ` +
            `(${someIds(gaps.map((g) => g.bundleId))}) continue${gaps.length === 1 ? "s" : ""} an entry ` +
            `no bundle on this hub carries` +
            (stranded.size > 0 ? `, which strands ${count(stranded.size, "later bundle")} behind them` : "") +
            `. The chain was applied up to that point and stopped there rather than resuming past it. ` +
            `Nothing is lost: every bundle is still on the hub.`);
    }
    const pre = assembled.unanchored.filter((u) => u.preAssembly && left(u.machineId, u.bundleId));
    const damaged = assembled.unanchored.filter((u) => !u.preAssembly && left(u.machineId, u.bundleId));
    // ONE FIELD, TWO SENTENCES: `preAssembly` is what tells them apart, and it is
    // the discriminator a caller branches on. Two fields would let the two lists
    // drift, and the condition ("this bundle belongs in no chain") is one.
    if (pre.length > 0 || damaged.length > 0) {
        findings.unplaceableBundles = await withName([...pre, ...damaged]);
    }
    if (pre.length > 0) {
        notes.push(`${count(pre.length, "bundle")} for thread ${threadId} (${someIds(pre.map((u) => u.bundleId))}) ` +
            `${pre.length === 1 ? "was" : "were"} pushed before sesh-mover recorded which entry a ` +
            `continuation chains onto, so ${pre.length === 1 ? "it has" : "they have"} no place in this ` +
            `thread's history to be put in. That is a bundle pushed before chain assembly existed, not a ` +
            `missing one — nothing is lost, and the machine that still holds that session re-links ` +
            `${pre.length === 1 ? "it" : "them"} the next time it pushes.`);
    }
    if (damaged.length > 0) {
        notes.push(`${count(damaged.length, "bundle")} for thread ${threadId} ` +
            `(${someIds(damaged.map((u) => u.bundleId))}) ${damaged.length === 1 ? "declares" : "declare"} ` +
            `itself a continuation of nothing, which no sesh-mover push can produce — that index is ` +
            `damaged or hand-edited. ${damaged.length === 1 ? "It was" : "They were"} left alone.`);
    }
    const parked = assembled.forks
        .flatMap((f) => f.parked.map((b) => ({ ...b, anchorEntryUuid: f.anchorEntryUuid, followedBundleId: f.followedBundleId })))
        .filter((b) => left(b.machineId, b.bundleId));
    if (parked.length > 0) {
        findings.parkedBranches = await withName(parked);
        notes.push(`Thread ${threadId} forks on the hub. This pull followed one branch ` +
            `(${someIds(assembled.forks.map((f) => f.followedBundleId))}) and left ` +
            `${count(parked.length, "other branch", "other branches")} ` +
            `(${someIds(parked.map((b) => b.bundleId))}) unfetched; ` +
            `${parked.length === 1 ? "it is" : "they are"} still on the hub.`);
    }
    const unwalked = assembled.roots.filter((r) => !r.followed && r.bundleIds.some((id) => outstandingIds.has(id)));
    if (unwalked.length > 0) {
        findings.unwalkedRoots = await withName(unwalked.map((r) => ({ machineId: r.machineId, bundleId: r.bundleId, bundleIds: r.bundleIds })));
        notes.push(`Thread ${threadId} has ${count(assembled.roots.length, "independent starting point")} on the hub. ` +
            `This pull followed one and left ${count(unwalked.length, "other")} ` +
            `(${someIds(unwalked.map((r) => r.bundleId))}) where ` +
            `${unwalked.length === 1 ? "it is" : "they are"}. More than one starting point is ordinary ` +
            `rather than damage — a session that was compacted, truncated or rolled back is re-pushed whole ` +
            `under the same thread id — and two of them cannot be joined into one history, because a ` +
            `compaction rewrites the very entry uuids a link would need. Nothing is lost: every bundle is ` +
            `still on the hub.`);
    }
    const ads = assembled.advertisedUnshipped.filter((a) => a.machineId !== localMachineId);
    const reportOnly = [];
    const reportOnlyFindings = {};
    if (ads.length > 0) {
        const names = await Promise.all([...new Set(ads.map((a) => a.machineId))].map(label));
        reportOnlyFindings.advertisedUnshipped = await withName(ads);
        reportOnly.push(`${someIds(names)} ${names.length === 1 ? "advertises" : "advertise"} newer work on thread ` +
            `${threadId} than ${names.length === 1 ? "it has" : "they have"} pushed to the hub, so no ` +
            `pull can fetch it yet. That work is not missing from this machine — it has not been ` +
            `uploaded. It arrives once that machine pushes (its SessionEnd auto-push does this by default).`);
    }
    return { notes, findings, reportOnly, reportOnlyFindings };
}
export async function runSelectStage(input) {
    const { backend, resolved, machineId, hubId, effectiveProjectPath, targetProjectDir } = input;
    const warnings = [];
    if (!input.threadId && !input.latest) {
        // Same project path the real pull below keys its sync-state off, so the
        // pick list's `unfetchableBundles` says exactly what pulling that thread
        // would report. peekSyncState, not readSyncState: this branch returns
        // without applying anything, and it is the only place in pull that reads
        // sync-state without going on to write it — a corrupt file must not be
        // renamed aside by a run that does nothing else.
        const threads = await shapeThreads(backend, resolved, machineId, peekSyncState(effectiveProjectPath), targetProjectDir);
        return { kind: "pick-list", threads };
    }
    /**
     * The #35 disclosure for a branch that returns BEFORE fetching anything.
     *
     * "Nothing to pull" and "the latest copy is already local" are the two
     * answers a machine holding half a cross-machine thread gets most often, and
     * #44's re-gate did NOT retire either of them: a fragment whose remaining
     * bundles are listed by a machine the pull does not resolve to is exactly the
     * shape where the resolved machine's own list is fully received, so the
     * thread that is most incomplete still reaches these branches. Answering it
     * with a bare "nothing to pull" is the nag loop this disclosure exists to
     * break, one step earlier than the `needed.length === 0` branch that already
     * handles it.
     *
     * peekSyncState, not readSyncState: these branches apply nothing, and a
     * corrupt state file must not be renamed aside by a run that does nothing
     * else (same rule as the pick-list branch above).
     *
     * IT RUNS ASSEMBLY TOO, and that is Task 7's half of it. `describeUnfetchable`
     * now ends "the note beside this one says which condition put them out of
     * reach", which was true at the `needed.length === 0` exit and a lie here —
     * these branches used to emit the machine-naming sentence alone. Running the
     * same `planThreadPull` + `describeAssembly` pair the fetching path runs is
     * what makes the promise good, and it is the same two calls rather than a
     * second, simpler copy of them for the usual reason: a hand-written second
     * copy of the receipt rule names bundles the user already has.
     *
     * WHICH SOURCE THE PLAN IS BUILT FROM, since no source was chosen here.
     * `pullSourceFor` answers "the copy a pull would fetch from", and it is
     * `undefined` for every thread that reaches these branches — that is WHY they
     * were reached — so the fallback is `t.latest`. Both spellings produce the
     * same `outstanding`: with a real source the plan is empty (nothing to fetch),
     * and with our own copy as the source the plan is either empty or the
     * back-compat fallback over our OWN records, which `sourcedRecordIsHere`
     * already counts as here. `outstanding` is what these sentences read, and it
     * is right in both.
     */
    const discloseUnfetchable = async (candidates) => {
        const peeked = peekSyncState(effectiveProjectPath);
        const machineName = createMachineNameLookup(backend);
        const ctx = { machineId, targetProjectDir };
        const lines = [];
        for (const t of candidates) {
            const plan = planThreadPull({
                thread: t,
                source: pullSourceFor(t, peeked, ctx) ?? t.latest,
                state: peeked,
                machineId,
                targetProjectDir,
            });
            const fetching = new Set(plan.needed.map((n) => sourcedKey(n.machineId, n.record.bundleId)));
            // Subtracted exactly as the fetching path subtracts it (spec §6). It is a
            // no-op whenever the plan is empty, which is the ordinary case here — but
            // writing the subtraction once per SITE rather than once per code path is
            // how the two disclosures stay the same disclosure.
            const sets = findUnfetchableBundles({
                copies: t.copies,
                sourceMachineId: t.latest.machineId,
                localMachineId: machineId,
                state: peeked,
            })
                .map((u) => ({
                machineId: u.machineId,
                bundleIds: u.bundleIds.filter((id) => !fetching.has(sourcedKey(u.machineId, id))),
            }))
                .filter((u) => u.bundleIds.length > 0);
            const assembly = await describeAssembly(t.threadId, plan.assembled, {
                localMachineId: machineId,
                outstanding: new Set(plan.outstanding.map((s) => sourcedKey(s.machineId, s.record.bundleId))),
                outstandingIds: new Set(plan.outstanding.map((s) => s.record.bundleId)),
                machineName,
            });
            if (sets.length === 0 && assembly.notes.length === 0 && assembly.reportOnly.length === 0) {
                continue;
            }
            if (sets.length > 0) {
                const groups = await Promise.all(sets.map(async (u) => ({
                    machineId: u.machineId,
                    machineName: await machineName(u.machineId),
                    bundleIds: u.bundleIds,
                })));
                lines.push(describeUnfetchable(t.threadId, groups, {
                    machineId: t.latest.machineId,
                    machineName: await machineName(t.latest.machineId),
                }));
            }
            // `reportOnly` is included HERE and nowhere else on a stop: these branches
            // fetched nothing at all, so "another machine advertises work it never
            // pushed" is not noise beside an import — it is frequently the whole
            // answer to the SessionStart notice the user is reacting to.
            lines.push(...assembly.notes, ...assembly.reportOnly);
        }
        return lines.length > 0 ? lines.join(" ") : null;
    };
    /**
     * Repair for #28's crash window, on every branch that returns before the
     * thread-mapping block at the bottom of `hubPull` can run.
     *
     * THE WINDOW. `peers[...].received` is written INSIDE the bundle loop (by
     * `importSession`, and by `recordSplice` on the append path), while
     * `setThreadId` runs only after the whole chain, the workspace merge and the
     * carry apply. Slice 2 widened the gap considerably. A pull interrupted in
     * between — Ctrl-C, a crash, a laptop lid — therefore leaves this machine
     * holding the content with the receipts to prove it, and no record of which
     * thread it belongs to.
     *
     * WHAT THAT COSTS, MEASURED. The re-pull sees every bundle already received
     * and returns — never reaching the mapping block. The next push then finds a
     * local session with no thread id and MINTS A NEW THREAD for it, whose only
     * bundle is a `continuation` with no base anywhere in its own chain: the
     * unreconstructable thread `recordSentToPeer`'s own doc forbids. `whereis`
     * shows two threads for one conversation.
     *
     * WHICH EXIT THAT RE-RUN LANDS IN, and #44 moved it. `--thread <id>` still
     * reaches the `needed.length === 0` branch ("Already up to date with the
     * source machine"). `--latest` no longer does: the same receipts that empty
     * `needed` now also make `pullSourceFor` yield no source, so it stops one
     * branch earlier, at "nothing to pull" — which repairs MORE, not less, since
     * that branch backfills across every resolved thread rather than the single
     * one `--thread` named. Both exits call this closure; that is the invariant,
     * not which of them a given run hits.
     *
     * WHY EVERY CANDIDATE IS MAPPED RATHER THAN THE "RIGHT" ONE. A chain that
     * fragmented leaves several local sessions carrying one thread's content,
     * and picking between them here would need a preference this branch has no
     * information to form — and any preference read off `t.copies` would be
     * index-file ITERATION ORDER, which this module bans for anything
     * user-visible. It does not need one: `buildIndexFile` already resolves
     * many-sessions-to-one-thread by recency, and `selectThreadBase` picks the
     * base by the delta's own anchor. Mapping the set is order-independent by
     * construction and strictly more information than mapping one of them.
     *
     * A session already mapped to some thread is never re-pointed: this repairs
     * an ABSENT mapping and is not a route by which a pull that fetched nothing
     * can move a session between threads.
     */
    const backfillThreadMappings = (threads) => {
        const peeked = peekSyncState(effectiveProjectPath);
        const wanted = new Map(); // localSessionId -> threadId
        for (const t of threads) {
            for (const copy of t.copies) {
                const peer = peeked.peers[copy.machineId];
                if (!peer)
                    continue;
                for (const b of copy.bundles) {
                    const localId = peer.received?.[b.sessionIdInBundle]?.localSessionId;
                    if (!localId)
                        continue;
                    if (getThreadId(peeked, localId))
                        continue; // already mapped — leave it
                    if (!existsSync(join(targetProjectDir, `${localId}.jsonl`)))
                        continue;
                    wanted.set(localId, t.threadId);
                }
            }
        }
        if (wanted.size === 0)
            return undefined;
        // Only now is the state read for WRITING. These branches apply nothing,
        // and `readSyncState` renames a corrupt file aside — a repair that has
        // something to write has earned that, a run with nothing to write has not
        // (same rule the `peekSyncState` callers around here follow).
        const st = readSyncState(effectiveProjectPath);
        let wrote = 0;
        for (const [localId, threadId] of wanted) {
            if (getThreadId(st, localId))
                continue;
            setThreadId(st, hubId, localId, threadId);
            wrote++;
        }
        if (wrote === 0)
            return undefined;
        writeSyncState(st);
        return `${wrote} local session${wrote === 1 ? "" : "s"} held this project's hub content with no thread mapping recorded — the mapping has been restored, so the next push continues the existing thread instead of starting a second one for the same conversation. That gap is what an interrupted pull leaves behind.`;
    };
    let target;
    if (input.threadId) {
        target = resolved.find((t) => t.threadId === input.threadId);
        if (!target) {
            return {
                kind: "stop",
                result: {
                    success: false, command: "pull",
                    error: `No thread "${input.threadId}" found for this project on the hub.`,
                    suggestion: "Run whereis to list available threads.",
                },
            };
        }
    }
    else {
        // --latest: resolveThreads already sorts desc by latest activity — take
        // the first thread a pull would actually fetch something for. ONE find,
        // over `pullSourceFor`, because a second predicate here is exactly the #44
        // disagreement: this used to skip a thread whose head matched (which says
        // nothing about which bundles arrived) and then re-ask a receipt question
        // of the local-machine case alone.
        //
        // peekSyncState, hoisted out of the find, not readSyncState: this branch
        // may apply nothing, and only `readSyncState` renames a corrupt file aside
        // (module doc, and the same rule the two closures above follow).
        const peeked = peekSyncState(effectiveProjectPath);
        target = resolved.find((t) => pullSourceFor(t, peeked, { machineId, targetProjectDir }) !== undefined);
        if (!target) {
            /**
             * WHY THIS EXIT IS NOT THE `report` ARM, decided rather than deferred.
             *
             * `--thread <id>` reaches `report`; this branch cannot, and the asymmetry
             * is structural rather than an oversight. `SelectReport` — and
             * `HubPullResult` under it — require a `threadId` and a
             * `sourceMachineId`, and both mean "the thread this pull resolved to and
             * the machine it resolved to". This branch resolved NEITHER: it asked
             * `pullSourceFor` of every thread and got no source for any of them, and
             * the disclosure it emits is about all of them together. Putting one
             * thread's id on a result describing several would be a false narrowing,
             * and widening the shipped result contract to `threadId: null` to express
             * "this is about no thread in particular" costs a public interface for a
             * branch whose content is already fully in `error` + `suggestion`.
             *
             * The harm the fold exists to remove is absent here too: the indefinite
             * nag was `whereis` asking for a pull that then answered "nothing to
             * pull" forever, and #44's `pullSourceFor` closed that by making the three
             * selectors ask one question — this branch is now reached only when there
             * genuinely is nothing for this machine to fetch, which is what an error
             * saying "nothing to pull" means. What this branch DID owe was the
             * disclosure, and that is what `discloseUnfetchable` now carries: it runs
             * the same assembly the fetching path runs, so the condition is named
             * here too rather than only the machines.
             */
            const split = await discloseUnfetchable(resolved);
            const repaired = backfillThreadMappings(resolved);
            return {
                kind: "stop",
                result: {
                    success: false, command: "pull",
                    // RECEIPT-SHAPED, because that is what was tested. "All threads are
                    // current" was a claim about heads, and after the re-gate above the
                    // code no longer asks that question of anything: a thread is skipped
                    // here because every bundle the machine it resolves to lists is
                    // already accounted for on this machine, which is a strictly
                    // narrower statement and the only one earned.
                    error: split
                        ? `Nothing to pull: every bundle the machine each thread resolves to lists has already been received here, but not every thread is whole here. ${split}`
                        : "Nothing to pull: every bundle the machine each thread resolves to lists has already been received here.",
                    details: repaired,
                    suggestion: split ? noMoreToFetch("threads") : "Run whereis to double-check thread status.",
                },
            };
        }
    }
    let sourceCopy = target.latest;
    if (sourceCopy.machineId === machineId) {
        const alternate = alternateSource(target, peekSyncState(effectiveProjectPath), {
            machineId, targetProjectDir,
        });
        if (!alternate) {
            const split = await discloseUnfetchable([target]);
            return {
                kind: "stop",
                result: {
                    success: false, command: "pull",
                    error: split
                        ? `The latest copy of this thread is already local, but the thread is not whole here. ${split}`
                        : "The latest copy of this thread is already local.",
                    suggestion: split ? noMoreToFetch("thread") : "Run whereis to confirm — there is nothing to pull.",
                },
            };
        }
        const label = (await createMachineNameLookup(backend)(alternate.machineId)) ?? alternate.machineId;
        warnings.push(`The most recent copy of thread ${target.threadId} is this machine's own, but ${label} still lists bundles this machine has never received — this pull fetched those instead of answering "the latest copy is already local". That is the ordinary shape after a divergence was left undecided and this machine's own session was pushed in the meantime.`);
        sourceCopy = alternate;
    }
    const state = readSyncState(effectiveProjectPath);
    /**
     * THE #35 LANDING SITE. What stood here was
     *
     *   selectNeededBundles(sourceCopy.bundles, received, …)
     *
     * — ONE machine's bundle list, sliced from its last full record onward. That
     * slice is array-position logic over one machine's push order and has no
     * cross-machine analogue, so it is what assembly supersedes; the per-record
     * receipt filter it also performed survives untouched and now runs over the
     * assembled chain, asking each record's OWN machine's ledger (see
     * `sourcedRecordIsHere`).
     *
     * `planThreadPull` orders by links and never by `pushedAt`, writes back into
     * no machine's stored bundle list, and stamps every record with the machine
     * that listed it — which is the whole reason `SourcedBundle` exists, because
     * three sites downstream spend that id on a peer ledger.
     *
     * `sourceCopy` is still handed in, and still means "the machine this pull
     * RESOLVED to". It is spent on two things and neither is a ledger: the plan's
     * back-compat fallback (a hub whose bundles predate `anchorEntryUuid` cannot
     * be assembled, and must not thereby stop being fetchable — see
     * `assembledCoversSource`) and the source label on the result.
     */
    const plan = planThreadPull({
        thread: target,
        source: sourceCopy,
        state,
        machineId,
        targetProjectDir,
    });
    const needed = plan.needed;
    const fetching = new Set(needed.map((n) => sourcedKey(n.machineId, n.record.bundleId)));
    // DISCLOSURE ONLY — see findUnfetchableBundles. It reads no timestamp, it
    // merges nothing into the source's bundle list, and nothing below it
    // changes what this pull fetches, applies, records, orders or resolves to.
    //
    // MINUS WHAT THIS PULL IS ACTUALLY FETCHING, which is new and is the half of
    // the #35 fix that keeps the disclosure honest. The heuristic answers "which
    // bundles do other machines list that the RESOLVED machine's list does not
    // offer" — a question whose answer stopped being "unfetchable" the moment
    // assembly started reaching across lists. Subtracting the plan leaves exactly
    // the records this pull will not fetch, which is what the field has always
    // claimed to be. The relation is spec §6's `assemblySet ⊆ heuristicSet`, in
    // the one direction it holds.
    const unfetchableSets = findUnfetchableBundles({
        copies: target.copies,
        sourceMachineId: sourceCopy.machineId,
        localMachineId: machineId,
        state,
    })
        .map((u) => ({
        machineId: u.machineId,
        bundleIds: u.bundleIds.filter((id) => !fetching.has(sourcedKey(u.machineId, id))),
    }))
        .filter((u) => u.bundleIds.length > 0);
    let unfetchableBundles;
    let unfetchableText;
    const machineName = createMachineNameLookup(backend);
    if (unfetchableSets.length > 0) {
        unfetchableBundles = await Promise.all(unfetchableSets.map(async (u) => ({
            machineId: u.machineId,
            machineName: await machineName(u.machineId),
            bundleIds: u.bundleIds,
        })));
        unfetchableText = describeUnfetchable(target.threadId, unfetchableBundles, {
            machineId: sourceCopy.machineId,
            machineName: await machineName(sourceCopy.machineId),
        });
        warnings.push(unfetchableText);
    }
    // What assembly worked out and could not deliver. `notes` name records this
    // pull is NOT fetching; `reportOnly` is the advertised-but-unshipped head,
    // which is not a fetch failure at all and belongs only on the exit that
    // applied nothing (see describeAssembly).
    const assembly = await describeAssembly(target.threadId, plan.assembled, {
        localMachineId: machineId,
        outstanding: new Set(plan.outstanding.map((s) => sourcedKey(s.machineId, s.record.bundleId))),
        outstandingIds: new Set(plan.outstanding.map((s) => s.record.bundleId)),
        machineName,
    });
    const findings = {
        ...(unfetchableBundles ? { unfetchableBundles } : {}),
        ...assembly.findings,
    };
    if (needed.length === 0) {
        // Every variant below returns without reaching the mapping block — see
        // backfillThreadMappings. This is the branch an interrupted pull's re-run
        // actually lands in when this machine has no index entry for the thread:
        // every bundle is already recorded as received, so `needed` is empty.
        const repaired = backfillThreadMappings([target]);
        /**
         * THE FOURTH EXIT, and its only producer (see `SelectReport`).
         *
         * THE RULE, and it is the one Task 7 had to settle: **a pull that can NAME
         * the condition succeeds; a pull that can only name the machines fails.**
         *
         * Assembly worked this thread's history out, found something it could not
         * deliver — a gap, a parked fork branch, a second starting point, a bundle
         * pushed before chain assembly existed, a machine advertising work it never
         * uploaded — and correctly applied nothing. Under the failure contract
         * (§1.1) that is a SUCCESS: truthfulness is the invariant, completeness is
         * best-effort, and a complete, truthful, actionable answer is not an error.
         * Returning `success: false` for it is the nag loop this milestone exists to
         * break, relocated one branch later — an error tells the caller to try
         * again, and every try says the same thing forever.
         *
         * IT NOW SITS ABOVE THE UNFETCHABLE STOP, which is the fold. It sat below
         * for one commit, because that stop was pinned as `success: false` by a
         * fixture whose "unfetchable" bundle is a PRE-ASSEMBLY record — i.e. exactly
         * the case assembly can name, and therefore exactly the case that should
         * have been the success. The ordering was an artifact of a test that could
         * not be edited yet, not a judgement.
         *
         * WHAT THE STOP BELOW STILL COVERS, and why it is not dead. It is the
         * residual class: another machine lists records the assembled chain does not
         * reach AND the walk has nothing to say about why. That pull genuinely does
         * not know what it is missing, which is a different answer from "here is
         * what I am missing and why", and an error is the honest shape for it.
         */
        const said = [...assembly.notes, ...assembly.reportOnly];
        if (said.length > 0) {
            return {
                kind: "report",
                value: {
                    threadId: target.threadId,
                    sourceMachineId: sourceCopy.machineId,
                    reason: [
                        `Nothing to apply: every bundle this pull could place in thread ${target.threadId}'s history is already here.`,
                        ...said,
                        repaired,
                    ]
                        .filter((s) => !!s)
                        .join(" "),
                    // `reportOnlyFindings` is folded in HERE and nowhere else, which is
                    // the typed half of `reportOnly` being report-only: an advertised
                    // head is not something a pull that applied something failed at.
                    findings: { ...findings, ...assembly.reportOnlyFindings },
                },
                warnings,
            };
        }
        if (unfetchableText) {
            // The residual class described above. `whereis` says the thread needs
            // pulling, the SessionStart notice repeats it, and every pull used to
            // answer "already up to date" — true of the source machine, false of the
            // thread. Say which, and stay an error: with no assembly note beside it
            // this names the machines and nothing else, so the caller is being told
            // that something is out of reach for a reason this pull could not work
            // out.
            return {
                kind: "stop",
                result: {
                    success: false, command: "pull",
                    error: `Already up to date with the source machine, but this thread is not whole here. ${unfetchableText}`,
                    details: repaired,
                    // Singular: this branch resolved exactly ONE thread. The copy it
                    // replaced said "threads", which was the plural site's wording
                    // hand-carried to a site it did not fit — the sort of drift three
                    // copies of a sentence produce and one function cannot.
                    suggestion: noMoreToFetch("thread"),
                },
            };
        }
        return {
            kind: "stop",
            result: {
                success: false, command: "pull",
                error: "Already up to date with the source machine.",
                details: repaired,
                suggestion: "Run whereis to confirm.",
            },
        };
    }
    // Only now, on the exit that applies something: these name records this pull
    // is leaving where they are, which is a fact about the result the user is
    // about to be told about. `reportOnly` stays out — a machine advertising
    // unpushed work is not something THIS pull failed at — and so does
    // `reportOnlyFindings`, which is the typed half of the same judgement.
    warnings.push(...assembly.notes);
    const missing = [];
    for (const { record } of needed) {
        if (!(await backend.exists(record.file)))
            missing.push(record.file);
    }
    if (missing.length > 0) {
        return {
            kind: "stop",
            result: {
                success: false, command: "pull", reason: "not-yet-synced", missing,
                suggestion: "The hub folder has not finished syncing these files — retry in a moment.",
            },
        };
    }
    return {
        kind: "proceed",
        value: {
            threadId: target.threadId,
            sourceMachineId: sourceCopy.machineId,
            needed,
            findings,
        },
        warnings,
    };
}
//# sourceMappingURL=pull-select.js.map