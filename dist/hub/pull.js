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
import { mergeWorkspaceTrees } from "./merge.js";
import { applyCarry } from "./carry.js";
import { adoptHubBranch, readDeltaChainInfo, tryAppendContinuation, APPEND_LIVE_WINDOW_MS, } from "./append.js";
import { extractArchive } from "../archiver.js";
import { importSession } from "../importer.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { computeIntegrityHashFromFile, readManifest } from "../manifest.js";
import { countJsonlLines, findEntryOffsetByUuid, readLastConversationEntry, readLastEntryUuid, } from "../jsonl.js";
import { encodeProjectPath } from "../platform.js";
import { buildImportRewriteContext, rewriteJsonlStream } from "../rewriter.js";
import { getApplicableAdapters } from "../version-adapters.js";
import { readSyncState, writeSyncState, setThreadId, setLastWorkspace, recordSentToPeer, knownWorkspaceGenerations, } from "../sync-state.js";
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
/**
 * Is this path a directory we can list?
 *
 * Both "the bundle declares a payload it does not contain" guards use this
 * rather than `existsSync`, because the failure they exist to close is a
 * `readdirSync` throwing out of `hubPull` BEFORE the session import — which a
 * plain file at that path does just as well (ENOTDIR) as a missing one
 * (ENOENT). Any error reads as "not usable": the caller's next move is to warn
 * and skip, which is the right answer for a permission failure too.
 */
function isReadableDir(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
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
/**
 * Fetch one candidate workspace generation off the hub and unpack it into a
 * temp dir: the common-ancestor tree a 3-way merge needs (design §5.2).
 * `chooseMergeAncestor` decides WHICH generation; this only retrieves it.
 *
 * The hub already stores every generation — each workspace payload is a full
 * snapshot — so sync-state only holds a POINTER, and the tree comes back down
 * the same validated path as any other bundle (`record.file` and this
 * `ref.file` both go through the backend's `assertHubRelPath`, and
 * `extractArchive` rejects absolute/traversing/symlink tar entries before
 * anything is written).
 *
 * Every failure degrades to `{ dir: null }` with a warning rather than
 * throwing, and the caller then runs no-ancestor mode (§5.4). The reasons are
 * all ordinary: the bundle was pruned from the hub, the hub folder has not
 * finished syncing it, an older generation predates workspace payloads, or the
 * archive is unreadable. None of them is a reason to fail a pull whose sessions
 * are perfectly fine — and no-ancestor mode never overwrites anything.
 *
 * Each attempt gets its OWN scratch directory: `chooseMergeAncestor` can call
 * this twice, and a failed extraction may already have written part of a tree.
 * Sharing one directory would silently hand back a blend of two generations.
 */
async function fetchAncestorWorkspace(backend, ref, tempRoot) {
    const degraded = (why) => ({
        dir: null,
        warning: `The workspace generation ${ref.bundleId}, which this pull would have merged against, ` +
            `${why} — so that payload could not be merged 3-way against it.`,
    });
    try {
        if (!(await backend.exists(ref.file))) {
            return degraded("is no longer on the hub (pruned, or not yet synced to this machine)");
        }
        const work = mkdtempSync(join(tempRoot, "ancestor-"));
        const tarPath = join(work, "ancestor.tar.gz");
        await pipeline(await backend.readStream(ref.file), createWriteStream(tarPath));
        const bundleDir = join(work, "bundle");
        mkdirSync(bundleDir, { recursive: true });
        await extractArchive(tarPath, bundleDir);
        const tree = join(bundleDir, "workspace");
        if (!existsSync(tree))
            return degraded("carries no workspace tree");
        return { dir: tree };
    }
    catch (e) {
        return degraded(`could not be read back (${e.message})`);
    }
}
/**
 * Which generation to merge against — or none.
 *
 * **The invariant: a merge may only use a generation common to BOTH trees.**
 * Everything below is that one rule made executable, and every way this has
 * gone wrong so far was a violation of it:
 *
 * - Design §5.2 says "the generation this machine last pushed or applied". That
 *   is common exactly while both machines were in step, and silently
 *   destructive when they were not — which auto-push makes routine, since every
 *   session end pushes whether or not this machine has pulled the other's work.
 *   (gen-2 is common; A pushes gen-3; B, still at gen-2, pushes gen-4; A merges
 *   gen-4 against gen-3, every file of A's reads as unchanged, and A's tree is
 *   "taken" back to B's older copy — measured, reported as a clean merge.)
 * - Trusting the incoming payload's declared base on its own is the mirror
 *   defect: `basedOn` is common to the PEER and the hub, never to us. A machine
 *   holding no generation at all would merge against a tree it has never held,
 *   read the peer's own files as "deleted here", and withhold them permanently
 *   — also measured.
 * - Ordering the two by `pushedAt` cannot fix either, because `pushedAt` is the
 *   PUSHING machine's wall clock (the hub is a passive filesystem and stamps
 *   nothing). A one-hour skew on one machine reinstated the silent revert
 *   verbatim, reported as a `taken` row.
 *
 * So the decision is a SET INTERSECTION, with no clock in it anywhere:
 *
 *   ours   = every generation this machine's tree has passed through
 *            (`knownWorkspaceGenerations`, most recent first)
 *   theirs = every generation the bundles in THIS pull's chain declare they
 *            descend from (`manifest.workspace.basedOn`, oldest chain entry
 *            first)
 *
 * A generation in both was held by both trees, so it is a legal base. The
 * NEWEST such generation (smallest index in `ours`) is the tightest one, and
 * that is what wins.
 *
 * Read that guarantee precisely: OUR half is verified (membership in a list this
 * machine wrote), THEIRS is asserted (`basedOn` is a self-report). A peer that
 * lies — naming a generation of ours it never held — gets that generation used
 * as the base, which is the silent-revert shape again. That is a residual, not a
 * regression: a forged `pushedAt` bought the same thing before this rule
 * existed, and an honest pusher can only ever declare its own `lastWorkspace`.
 * Closing it needs the hub to attest what a bundle descends from, which the
 * filesystem backend cannot do. Under Slice 1's "your own machines" threat model
 * that is acceptable; it would not be under a shared or hostile hub. Empty intersection means we genuinely cannot name a common
 * point — so the payload degrades to no-ancestor mode (§5.4), which is loud and
 * changes nothing, rather than being merged against a guess.
 *
 * Why the whole chain and not just the applied payload's own base: being simply
 * BEHIND is the ordinary case, and a peer that pushed twice since our last sync
 * declares a base we never held (its own previous generation) — while the
 * EARLIER bundle in the same chain declares one we do hold. Walking the chain
 * is what keeps routine repeat pulls merging instead of skipping.
 *
 * The chain is one machine's own pushes (a machine's index lists only bundles it
 * pushed — `hub/pull.ts` writes its index with `newBundles: []`), so the bases
 * within a chain are linear and every earlier one is an ancestor of the applied
 * payload. That linearity is what makes "newest match across the chain" safe;
 * if index writing ever starts merging other machines' bundle records into one
 * thread list, this reasoning breaks before the code does.
 *
 * Known gap, three machines: C's chain declares C's generations. If this machine
 * shares a generation with C only through A, the intersection is empty and the
 * payload skips — even though a genuinely common older generation sits in our
 * own history. Worse, the skip is STICKY: C's next push declares the bundle we
 * just skipped, so every later pull skips too, until this machine pushes a
 * generation C then pulls, or the user reaches for a flag. Fixing it means
 * walking `basedOn` back through the hub's own bundle manifests rather than
 * stopping at the chain; deferred, not overlooked.
 *
 * Fallback direction: candidates after the first are `ours` continued from the
 * winner, i.e. strictly OLDER generations of our own. A base older than the
 * true common ancestor fails toward "keep local" and VISIBLE conflicts; a newer
 * one fails toward silently overwriting work. So a candidate that cannot be
 * fetched (pruned from the hub, not yet synced, unreadable) falls through
 * downward only, never back up to our head — and a merge that ran against a
 * fallback says so.
 */
async function chooseMergeAncestor(backend, 
/**
 * Bundle ids the incoming chain declares it descends from, oldest first.
 * Only the id is consulted: the peer's `file` never becomes a path here (we
 * use OUR record of the same generation), so a forged one cannot reach the
 * filesystem at all.
 */
chainBaseBundleIds, known, tempRoot) {
    let idx = -1;
    for (const bundleId of chainBaseBundleIds) {
        if (!bundleId)
            continue; // the peer's first workspace push declares none
        const j = known.findIndex((g) => g.bundleId === bundleId);
        if (j >= 0 && (idx === -1 || j < idx))
            idx = j;
    }
    if (idx === -1)
        return { dir: null, warnings: [] };
    const warnings = [];
    const candidates = known.slice(idx);
    const tried = new Set();
    for (const [n, ref] of candidates.entries()) {
        if (tried.has(ref.file))
            continue;
        tried.add(ref.file);
        const attempt = await fetchAncestorWorkspace(backend, ref, tempRoot);
        if (attempt.dir !== null) {
            if (n > 0) {
                warnings.push(`Merged against an older workspace generation (${ref.bundleId}) than the closest one shared with the other machine, which could not be fetched — so files that changed here since then may be reported as conflicts even where the other machine left them alone.`);
            }
            return { dir: attempt.dir, warnings };
        }
        if (attempt.warning)
            warnings.push(attempt.warning);
    }
    return { dir: null, warnings };
}
/**
 * The merge's per-file decisions, phrased for the human reading the pull.
 *
 * Everything the merge *withheld* has to be said out loud, not just what it
 * wrote: `skipped` paths park nothing at all (see merge.ts's `SkipReason`), and
 * a `localDeleted` row cannot be claimed to be a deletion, only described.
 * Silence on either would look exactly like a successful sync.
 *
 * No remedy sentence tells the user to "re-pull to get this" — the bundle is
 * recorded as received by the end of this pull, so a re-run finds nothing to
 * do. Remedies here are things that change the NEXT pull's outcome.
 */
function describeWorkspaceMerge(r) {
    const out = [];
    const names = (paths) => paths.slice(0, 5).join(", ") + (paths.length > 5 ? `, and ${paths.length - 5} more` : "");
    const count = (n) => `${n} workspace file${n === 1 ? "" : "s"}`;
    // Agreement helpers: `count()` produces a singular subject at n = 1, so every
    // verb and pronoun downstream of it has to agree or the sentence reads as
    // broken English on the most common case of all ("1 workspace file were…").
    const were = (n) => (n === 1 ? "was" : "were");
    const they = (n) => (n === 1 ? "It is" : "They are");
    if (r.conflicted.length > 0) {
        out.push(`${count(r.conflicted.length)} ${were(r.conflicted.length)} merged with conflict markers and need resolving by hand — search for "<<<<<<< local": ${names(r.conflicted)}. Conflicts are normal here: edits on adjacent lines conflict, and a file added independently on both machines conflicts over its whole length.`);
    }
    if (r.gitUnavailable) {
        out.push("No usable `git merge-file` on this machine, so files edited on both machines could not be merged — your copies were left exactly as they are and the other machine's versions were parked beside them. Install git (or put it on PATH) to have future pulls merge them automatically.");
    }
    if (r.sidecars.length > 0) {
        out.push(`${count(r.sidecars.length)} could not be merged, so your ${r.sidecars.length === 1 ? "copy was" : "copies were"} kept and the other machine's saved alongside as ${r.sidecars.length === 1 ? "a *.theirs-* file" : "*.theirs-* files"}: ${names(r.sidecars.map((s) => s.path))}. Delete ${r.sidecars.length === 1 ? "the sidecar" : "the sidecars"} once you've reconciled ${r.sidecars.length === 1 ? "it" : "them"} — they are ordinary files and will be pushed to the hub otherwise.`);
    }
    if (r.skipped.length > 0) {
        out.push(`${count(r.skipped.length)} ${were(r.skipped.length)} not applied at all and nothing was written near ${r.skipped.length === 1 ? "it" : "them"} (${[...new Set(r.skipped.map((s) => s.reason))].join(", ")}): ${names(r.skipped.map((s) => s.path))}. The incoming ${r.skipped.length === 1 ? "copy is" : "copies are"} still on the hub.`);
    }
    if (r.upstreamDeleted.length > 0) {
        out.push(`${count(r.upstreamDeleted.length)} ${were(r.upstreamDeleted.length)} deleted on the other machine but kept here (this merge never deletes your files): ${names(r.upstreamDeleted)}.`);
    }
    if (r.localDeleted.length > 0) {
        // Deliberately NOT phrased as "files you deleted". The merge cannot know
        // that: this row means "in the last shared generation, gone here now, and
        // untouched on the other machine", which a deletion produces — and so does
        // a file an earlier sync of ours could not write (its own warning said so
        // at the time, but that was a previous run). The distinction is invisible
        // from here and the consequence is not: the shared generation advances past
        // these paths on every pull, so nothing will offer them again on its own.
        // Saying "you deleted them" would make the second case unrecognizable and
        // leave it with no remedy to reach for.
        out.push(`${count(r.localDeleted.length)} that ${were(r.localDeleted.length)} in the last generation shared with the other machine ${r.localDeleted.length === 1 ? "is" : "are"} gone here and ${were(r.localDeleted.length)} not restored: ${names(r.localDeleted)}. ${they(r.localDeleted.length)} unchanged on the other machine, so this is what you asked for if you deleted ${r.localDeleted.length === 1 ? "it" : "them"} here — but an earlier sync that could not write ${r.localDeleted.length === 1 ? "that path" : "those paths"} (a symlink or a permissions failure it warned about at the time) looks identical from here. Nothing will offer ${r.localDeleted.length === 1 ? "it" : "them"} again on its own. If you did not delete ${r.localDeleted.length === 1 ? "it" : "them"}: the non-destructive route is to re-pull the next workspace payload with --target-path <fresh-dir> and copy ${r.localDeleted.length === 1 ? "that file" : "those files"} across by hand. Passing --force-workspace instead unpacks the hub's copy over THIS directory, OVERWRITING any file of the same name — including local edits this merge has been preserving for you.`);
    }
    if (r.restored.length > 0) {
        out.push(`${count(r.restored.length)} that you had deleted here ${were(r.restored.length)} changed on the other machine, so ${r.restored.length === 1 ? "it came" : "they came"} back rather than losing that work: ${names(r.restored)}. Delete ${r.restored.length === 1 ? "it" : "them"} again if you still don't want ${r.restored.length === 1 ? "it" : "them"}.`);
    }
    return out;
}
/**
 * What happened to a carried payload, in sentences a user can act on.
 *
 * Every branch here has to be honest about ONE fact that shapes all of them:
 * this pull records its bundles as received before it returns, so re-running it
 * — with or without `--apply-carry` — answers "Already up to date" and never
 * offers this payload again. Naming that re-run as a remedy is the foreclosure
 * this milestone keeps producing, so no branch below names it. What is named
 * instead is the saved directory, which is a copy the user already has.
 */
function describeCarryApply(result, meta, bundleFile) {
    const out = [];
    const origin = `branch ${meta.branch} at commit ${meta.baseCommit.slice(0, 8)}`;
    if (!result.applied) {
        const lost = `The uncommitted changes this pull carried (${origin}) were not applied: ${result.detail}. ` +
            (result.savedTo === null
                ? `They could not be saved beside the project either, so the only remaining copy is inside ${bundleFile} on the hub — extract that archive by hand to recover them.`
                : `The whole payload — patch, untracked files and a README ${
                // Two declines withhold the commands on purpose (a refused payload,
                // and a patch git could not parse here), so promising them on every
                // decline sends the user looking for something that is not there.
                result.savedCommands
                    ? "with the exact commands"
                    : "explaining what was found and what was withheld"} — is saved at ${result.savedTo}. Nothing was written to your working tree.`);
        out.push(result.reason === "not-requested"
            ? lost + " Pass --apply-carry on a future pull to have them applied straight into the tree instead."
            : lost);
        if (result.reason === "unsafe-payload") {
            // The same disclosure `workspaceRefused` carries, and the same rule: do
            // not accuse the sender. An older sesh-mover, on a case-insensitive
            // filesystem, legitimately produced payloads this guard now refuses.
            out.push("That payload tried to write paths that never travel (plugin or VCS internals such as .claude-sesh-mover/hubinclude, which decides what this machine's NEXT push uploads) or to create a symbolic link. It was refused whole rather than partly applied. Read the saved copy before doing anything with it.");
        }
        return out;
    }
    out.push(`Applied the uncommitted changes this pull carried (${origin}): ${result.filesChanged} file(s) from the patch, ${result.untrackedCopied} untracked file(s) copied. They are uncommitted here too — \`git status\` shows them, and \`git checkout -- .\` undoes the patch half.`);
    if (meta.inProgress) {
        out.push(`Those changes were captured during an in-progress ${meta.inProgress} on the other machine, so the patch contained conflict markers as ordinary file content and the ${meta.inProgress} itself did not travel — search for <<<<<<< before working on them.`);
    }
    if (result.collisions.length > 0) {
        out.push(`${result.collisions.length} carried file(s) already existed here with different content, so yours were left alone and the incoming copies were written beside them as *.incoming-*: ${result.collisions.slice(0, 5).join(", ")}. Reconcile and delete the sidecars — they are untracked files, so a later push would carry them too.`);
    }
    if (result.refused.length > 0) {
        out.push(`${result.refused.length} carried file(s) were refused because they name plugin or VCS internals that never travel (${result.refused.slice(0, 5).join(", ")}). Nothing from them was written. Current sesh-mover versions never put those in a bundle, so this one came from an older version, was damaged in transit, or was not produced by sesh-mover at all.`);
    }
    if (result.blocked.length > 0) {
        out.push(`${result.blocked.length} carried file(s) were not written because of what already occupies their path here (${[...new Set(result.blocked.map((b) => b.reason))].join(", ")}): ${result.blocked.slice(0, 5).map((b) => b.path).join(", ")}. Nothing was written near them.`);
    }
    return out;
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
        let workspaceMerge;
        let workspaceRefused;
        // Which bundle in this chain carries the workspace generation to apply:
        // the NEWEST one that has a payload, not needed[0].
        //
        // A chain is pulled in one pass and every bundle is recorded as received
        // by the end of it, so any generation that isn't applied now is never
        // offered again. Applying the OLDEST would therefore leave the tree
        // permanently behind the hub after two unpulled pushes — and, worse, would
        // record that stale generation as this machine's ancestor. Falls back to
        // index 0 when NO record claims a payload, which keeps the manifest check
        // below the sole authority in that case (Slice-1 behavior).
        //
        // That fallback is index 0 rather than "the newest bundle whose manifest
        // has one" because the manifests aren't read yet here. It can only disagree
        // with the manifests if a record's `hasWorkspace` is wrong, and the one
        // write site sets both from the same push (hub/push.ts), so the two cannot
        // drift in practice. If they ever did — a record claiming a payload whose
        // manifest lacks one — the gate would fire on that bundle, find no
        // `manifest.workspace`, and do nothing, suppressing an earlier bundle's
        // genuine payload for that pull.
        let workspaceBundleIndex = 0;
        for (let i = needed.length - 1; i >= 0; i--) {
            if (needed[i].hasWorkspace) {
                workspaceBundleIndex = i;
                break;
            }
        }
        // Every generation the bundles in this chain declare they descend from,
        // oldest first — the peer's half of the "common to both trees" test that
        // `chooseMergeAncestor` intersects with our own generation history.
        const chainWorkspaceBases = [];
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
        // The newest carry payload in this chain, if any — see the loop.
        let lastCarry = null;
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
            if (bundleManifest.workspace) {
                chainWorkspaceBases.push(bundleManifest.workspace.basedOn?.bundleId ?? null);
            }
            // The carry is applied AFTER the whole chain, and the newest one wins:
            // each payload is a full `git diff HEAD` of the sender's tree at that
            // moment, so an older one in the same chain describes a superseded
            // working tree. Recorded here because the extraction directories only
            // live until this function returns.
            if (bundleManifest.carry) {
                lastCarry = {
                    dir: join(extractDir, "carry"),
                    meta: bundleManifest.carry,
                    bundleFile: record.file,
                };
            }
            // Workspace gate (the chain's newest workspace-carrying bundle only).
            // Slice 1's four branches are preserved; what changed is that the
            // APPLICATION step is now a 3-way merge whenever a generation COMMON TO
            // BOTH TREES can be named (design §5.5, and see `chooseMergeAncestor` for
            // why nothing weaker will do):
            //
            // - target absent, empty, or
            //   metadata-only                -> unpack (bootstrap; no force needed).
            //                                   NEVER merge: with an empty tree every
            //                                   file reads as "deleted here" and the
            //                                   merge would write nothing at all.
            // - common generation found,
            //   target has real content,
            //   no --force-workspace         -> 3-way MERGE. No force needed: merging
            //                                   cannot lose local work, so requiring
            //                                   a destructive-sounding flag for it
            //                                   would be backwards.
            // - --force-workspace, target has
            //   real content                 -> unpack with force, i.e.
            //                                   OVERWRITE-ON-COLLISION (§5.4), merge
            //                                   or no merge. The flag keeps ONE
            //                                   meaning — "overwrite, don't combine"
            //                                   — and it is deliberately not made
            //                                   inert by having a generation on
            //                                   record: it is the only way to ask for
            //                                   the hub's copy wholesale, and the only
            //                                   remedy for a file a merge withheld.
            // - no common generation, explicit
            //   --target-path, has real
            //   content, no force            -> let unpackWorkspace throw, surface
            //                                   an ErrorResult with the
            //                                   --force-workspace suggestion (the
            //                                   user asked for that destination;
            //                                   refuse loudly)
            // - no common generation, no
            //   explicit --target-path,
            //   project dir has real content,
            //   no force                     -> SKIP with a warning (routine repeat
            //                                   pulls of non-git projects must not
            //                                   start erroring)
            //
            // ".claude-sesh-mover" counts as non-content on BOTH sides: identity
            // linking above may have just planted project.json into an otherwise
            // fresh directory (the in-place bootstrap flow, --project-id with no
            // --target-path), and that metadata alone must neither trigger the
            // routine-skip branch nor trip unpackWorkspace's own emptiness check —
            // hence force is also set when the dir holds nothing but our metadata.
            const incomingDir = join(extractDir, "workspace");
            const workspaceDeclared = i === workspaceBundleIndex && !!bundleManifest.workspace;
            // First, a payload the manifest declares and the bundle does not contain.
            // Both application paths below start by READING that directory, so an
            // absent one threw ENOENT straight out of hubPull: no sessions imported,
            // nothing recorded, and therefore the identical crash on every retry —
            // the optional half taking down the transcripts that are the point of the
            // operation. Every sesh-mover before the accompanying snapshotWorkspace
            // fix wrote exactly this bundle whenever a snapshot carried no files (an
            // empty project, or a hubignore broad enough to drop the whole tree), so
            // those bundles are on hubs now; a hand-made or truncated one says the
            // same thing. Deliberately the same shape as the carry's own "declares it
            // but does not contain it" guard further down.
            // `isDirectory`, not `existsSync`: a bundle whose `workspace` entry is a
            // FILE reaches the same `readdirSync` and throws ENOTDIR out of hubPull
            // before the session import — the identical terminal shape this guard
            // exists to close. No sesh-mover produces that, but the sentence below
            // claims to cover a hand-made bundle, so the check has to mean it.
            if (workspaceDeclared && !isReadableDir(incomingDir)) {
                warnings.push("The bundle's manifest declares a workspace payload but the bundle does not contain one, so there was nothing to apply and this project's files were left untouched. It was written by an older sesh-mover whose snapshot carried no files, damaged in transit, or not produced by sesh-mover at all.");
            }
            else if (workspaceDeclared) {
                const entries = existsSync(effectiveProjectPath) ? readdirSync(effectiveProjectPath) : [];
                const hasRealContent = entries.some((n) => n !== ".claude-sesh-mover");
                // Ancestor lookup is keyed off the EFFECTIVE project path, like every
                // other piece of local bookkeeping here — a pull into a fresh
                // --target-path has no sync-state there and therefore no generation
                // history, which is correct: that tree shares nothing with the hub.
                const known = knownWorkspaceGenerations(readSyncState(effectiveProjectPath));
                let ancestorDir = null;
                // --force-workspace is an explicit "overwrite, don't combine", so it
                // skips the ancestor hunt entirely rather than fetching a tree nothing
                // will read.
                if (hasRealContent && !opts.forceWorkspace) {
                    const ancestor = await chooseMergeAncestor(backend, chainWorkspaceBases, known, tempRoot);
                    ancestorDir = ancestor.dir;
                    warnings.push(...ancestor.warnings);
                }
                if (ancestorDir !== null) {
                    // No git probe up front, deliberately. mergeWorkspaceTrees only needs
                    // git for files changed on BOTH sides; take/keep/create/no-op rows —
                    // the overwhelming majority on a routine pull — are decided by
                    // content hash alone. Falling back to no-ancestor mode because git is
                    // missing would skip the payload outright on a non-empty tree, and
                    // since the bundle is recorded as received by the end of this pull,
                    // "install git and re-pull" would be advice that cannot work. The
                    // merge degrades per file instead (sidecars + `gitUnavailable`), and
                    // describeWorkspaceMerge says so.
                    const report = await mergeWorkspaceTrees({
                        ancestorDir,
                        incomingDir,
                        targetDir: effectiveProjectPath,
                    });
                    workspaceMerge = report;
                    workspaceUnpacked = {
                        path: effectiveProjectPath,
                        fileCount: report.taken.length + report.created.length + report.restored.length +
                            report.merged.length + report.conflicted.length,
                    };
                    // Record the new ancestor IMMEDIATELY, before the session half of
                    // this pull can fail. The tree already reflects this generation; if a
                    // later fault sent us back to the old one, the next pull would merge
                    // an already-merged (possibly conflict-marked) file against a stale
                    // base and manufacture conflicts out of work that was already done.
                    const stateWs = readSyncState(effectiveProjectPath);
                    setLastWorkspace(stateWs, hub.hubId, {
                        bundleId: record.bundleId, file: record.file, pushedAt: record.pushedAt,
                    });
                    writeSyncState(stateWs);
                    warnings.push(...describeWorkspaceMerge(report));
                }
                else if (hasRealContent && !opts.forceWorkspace && !opts.targetPath) {
                    warnings.push("Bundle carries a workspace payload but the project directory already has content and no workspace generation is shared between this machine and the payload, so there is no common point to merge from — pass --force-workspace to unpack it here, OVERWRITING any file of the same name, or re-pull with --target-path <fresh-dir> to unpack it elsewhere. Once this machine and the other one share one generation, later payloads merge 3-way instead.");
                }
                else {
                    try {
                        const ws = await unpackWorkspace(incomingDir, effectiveProjectPath, { force: !!opts.forceWorkspace || !hasRealContent });
                        workspaceUnpacked = { path: effectiveProjectPath, fileCount: ws.fileCount };
                        if (ws.symlinksSkipped > 0) {
                            warnings.push(`${ws.symlinksSkipped} symlink(s) skipped while unpacking the workspace.`);
                        }
                        if (ws.refused.length > 0) {
                            workspaceRefused = ws.refused;
                            // Deliberately does NOT accuse the sender. A bundle written by a
                            // sesh-mover older than this guard, on a case-insensitive
                            // filesystem, legitimately carried a `.GIT` store — the very leak
                            // the guard closed — so "hand-made or damaged" would be a false
                            // accusation in the commonest case that reaches here.
                            warnings.push(`${ws.refused.length} path(s) in the workspace payload were refused because they name plugin or VCS internals that never travel (${ws.refused.slice(0, 5).join(", ")}). Nothing from them was written here. Current sesh-mover versions never put those in a bundle, so this one came from an older version, was damaged in transit, or was not produced by sesh-mover at all.`);
                        }
                        if (ws.blocked.length > 0) {
                            warnings.push(`${ws.blocked.length} workspace file(s) were not unpacked because of what already occupies their path here (${[...new Set(ws.blocked.map((b) => b.reason))].join(", ")}): ${ws.blocked.slice(0, 5).map((b) => b.path).join(", ")}. Nothing was written near them; the incoming copies are still on the hub.`);
                        }
                        if (hasRealContent) {
                            warnings.push(opts.forceWorkspace && known.length > 0
                                ? "The workspace payload was unpacked over the existing directory, overwriting any file of the same name, because --force-workspace was passed — no 3-way merge was attempted even though this machine has workspace generations on record. Anything of yours that the payload does not contain is still here."
                                : "The workspace payload was unpacked over the existing directory, overwriting any file of the same name — no workspace generation is shared between this machine and the payload, so there was no common point to combine them from.");
                        }
                        // Both application paths record the generation: whatever was
                        // overwritten now matches it, and anything only this machine has is
                        // absent from it, which is exactly how the next merge should read
                        // this tree.
                        const stateWs = readSyncState(effectiveProjectPath);
                        setLastWorkspace(stateWs, hub.hubId, {
                            bundleId: record.bundleId, file: record.file, pushedAt: record.pushedAt,
                        });
                        writeSyncState(stateWs);
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
                                // Refuse with SKIP semantics, never fragment. Falling through
                                // to the import would record the bundle in
                                // peers[...].received, selectNeededBundles would drop it from
                                // every later pull, and the instruction in this very warning
                                // would be impossible to carry out — "already up to date" on
                                // the re-run, recoverable only by hand-editing sync-state.
                                // Refusing an operation must never also foreclose it, and a
                                // user who asked to adopt should not be permanently handed a
                                // fragment instead. `skippedByDivergence` is what keeps the
                                // thread resolvable (it suppresses the index rewrite and the
                                // "could not be identified" warning).
                                warnings.push(`adopt-hub refused for thread ${target.threadId}: session ${baseSessionId} was modified ${Math.round(baseAgeMs / 1000)}s ago, so a Claude Code session may still be open on it — adopting would truncate a transcript that is being written to, and anything it writes afterwards would chain onto the hub's branch instead of yours. Nothing was applied and nothing was recorded: exit that session, then re-run with --on-divergence adopt-hub --force-append (or --on-divergence fragment to keep both as separate sessions).`);
                                divergence.resolution = "skip";
                                skippedByDivergence = true;
                                continue;
                            }
                            if (mode === "adopt-hub" && divergence.adoptAvailable) {
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
                                warnings.push(
                                // "left unchanged", not "restored unchanged": a `failed`
                                // adoption covers both the restored-byte-for-byte case and
                                // the (more common) one where the fault landed before the
                                // truncate and nothing was ever written, so nothing was
                                // restored either. Either way the user's session is as it
                                // was, which is the part that matters to them.
                                `adopt-hub failed for thread ${target.threadId} and session ${baseSessionId} was left unchanged (${adopt.detail}) — importing the hub's branch as a separate session instead.`);
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
        // Git-diff carry (design §6.2) — after the whole chain, because the newest
        // payload supersedes every earlier one, and after the sessions, because
        // the working tree is the optional half: nothing here may cost the user
        // the transcripts this pull exists to deliver.
        //
        // It cannot collide with the workspace step above: `hub push` writes a
        // workspace payload only when the project has NO git remotes and a carry
        // only when it has one, so a bundle carrying both did not come from a
        // current sesh-mover. If one ever does, the workspace application dirties
        // the tree and the carry declines — the safe order.
        let carryAvailable;
        let carryApplied;
        if (lastCarry) {
            carryAvailable = lastCarry.meta;
            // isDirectory, not exists — see the workspace guard above.
            if (!isReadableDir(lastCarry.dir)) {
                warnings.push("The bundle's manifest declares carried uncommitted changes but the bundle does not contain them, so there was nothing to apply. The bundle is damaged or was not produced by sesh-mover.");
            }
            else {
                carryApplied = await applyCarry({
                    carryDir: lastCarry.dir,
                    targetPath: effectiveProjectPath,
                    meta: lastCarry.meta,
                    saveOnly: !opts.applyCarry,
                });
                warnings.push(...describeCarryApply(carryApplied, lastCarry.meta, lastCarry.bundleFile));
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
        const appliedNothing = importedSessions.length === 0 &&
            skippedSessions.length === 0 &&
            appended.length === 0;
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
            workspaceMerge,
            workspaceRefused,
            carryAvailable,
            carryApplied,
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