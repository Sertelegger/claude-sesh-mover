import type { SyncState, SyncStateSessionSent, WorkspaceGenerationRef } from "./types.js";
export declare function syncStatePath(projectPath: string): string;
/**
 * A record whose KEYS come from outside this machine, built with NO PROTOTYPE.
 *
 * `peers`, `lineage`, `imported` and each peer's `sent`/`received` are all keyed
 * by strings a peer supplies — a `machineId` read off a hub index file, a
 * `sourceMachineId` off a bundle manifest, a `sessionIdInBundle` off an index
 * record, an `integrityHash` off the same manifest. The only filter any of them
 * passes is `isSafeSessionId`, which answers a DIFFERENT question (path shapes):
 * `__proto__`, `constructor`, `toString`, `valueOf` and `hasOwnProperty` all
 * pass it.
 *
 * On a plain `{}` those keys are already "present". `state.peers["__proto__"]`
 * yields `Object.prototype`, so the `state.peers[id] ??= {…}` / `if
 * (!state.peers[id])` guards every writer here uses do NOT create the entry, and
 * the writes that follow land on `Object.prototype` ITSELF before dying on the
 * first nested one. Measured against shipped `dist/`: `name` and
 * `lastReceivedAt` were added to `Object.prototype` and the operation then threw
 * `Cannot set properties of undefined` — in `hub/pull.ts`'s `recordSplice`,
 * which runs AFTER the user's transcript has already been extended, so the throw
 * leaves the splice unrecorded and the next pull re-needs the same bundle.
 *
 * A null prototype answers the whole family at the container: every lookup is an
 * own lookup, so a hostile key is an ordinary key and the guards mean what they
 * say. ONE copy of the rule on purpose — `importer.ts` and `cli.ts` also index
 * these records with peer-supplied strings, and they get the guarantee from the
 * state object they were handed rather than from a guard each of them has to
 * remember to write. Anything that BUILDS one of these records must use this
 * (`hub/pull.ts` does), which is why it is exported.
 *
 * JSON round-trips unchanged: `JSON.stringify` reads own enumerable keys, and
 * `JSON.parse` defines a `__proto__` key as an OWN property, which `Object.assign`
 * then copies onto a null-prototype target as an own property too.
 */
export declare function foreignKeyedRecord<T>(from?: Record<string, T> | null): Record<string, T>;
export declare function readSyncState(projectPath: string): SyncState;
/**
 * Read-only twin of `readSyncState`: same file, same parse, but it NEVER
 * writes — a corrupt file is left exactly where it is and reads as the default
 * state.
 *
 * For commands that are read-only by contract. `whereis` is the caller this
 * exists for: it needs this machine's peer bookkeeping to tell a genuinely
 * missing half of a thread from one it already holds, and `readSyncState`
 * renames a corrupt file aside as a side effect — a write, in a command
 * documented as never changing anything, on a path the SessionStart hook also
 * runs.
 */
export declare function peekSyncState(projectPath: string): SyncState;
export declare function writeSyncState(state: SyncState): void;
export declare function recordSentFromBundle(projectPath: string, peer: {
    id: string;
    name?: string;
}, bundleDir: string): void;
export declare function recordSentToPeer(projectPath: string, peer: {
    id: string;
    name?: string;
}, localSessionId: string, sent: SyncStateSessionSent): void;
/**
 * Credit a peer with the memory layer a bundle just delivered to it — the
 * whole-file counterpart of `recordSentFromBundle`'s per-session ledger, and the
 * input the next export reads back as `IncrementalExportOptions.peerMemoryDigest`.
 *
 * Two rules, both inherited from the ledgers beside it:
 *
 * - **Call it only once the bundle has actually reached the peer**, exactly as
 *   `setLastWorkspace` is only called once the bundle is committed to the hub.
 *   Recording a digest for a bundle that never arrived makes the next export skip
 *   a directory the peer does not have, and nothing ever re-sends it.
 * - **Pass the digest of the BUNDLE's copy** (`ExportManifest.memoryDigest`),
 *   never a fresh hash of the live source directory. The live directory can have
 *   changed since the export, and crediting the peer with bytes it was not sent
 *   suppresses precisely the push that would have fixed it.
 *
 * Creates the peer entry if it does not exist yet, for the same reason its
 * siblings do: a peer's first delivery is also the first time it is named.
 * Purely additive — see `SyncStatePeer.memoryDigest` for why this does not
 * promote the file to `schemaVersion` 2.
 */
export declare function setPeerMemoryDigest(state: SyncState, peer: {
    id: string;
    name?: string;
}, digest: string): void;
/** What a forget actually dropped — see `forgetSentToPeer`. */
export interface ForgetSentResult {
    /**
     * Local session ids whose watermark was dropped, i.e. exactly the sessions
     * the next push to this peer sends WHOLE that it would otherwise have sent as
     * a delta. Empty when the peer held no ledger, which is a successful forget
     * and not an error.
     */
    forgotten: string[];
    /** True when the memory layer's "peer already has it" digest went too. */
    memoryDigest: boolean;
}
/**
 * Forget what this machine believes a peer already holds.
 *
 * **This is the ONE definition of what "forgetting" means**, so the callers that
 * need it cannot come to disagree about which ledgers it covers. Today that is
 * `hub push --full`; the design also names key-loss recovery and compaction
 * repair, which clear the same watermark for the same reason and must clear
 * exactly the same set.
 *
 * **Why it has to exist at all.** `sent` is not a fact about this machine — it
 * is a claim about what the PEER can still serve, and a hub can stop being able
 * to serve what it holds (bundles deleted by compaction; bundles encrypted to a
 * key that is gone). The ledger then makes the next push ship a delta anchored
 * on a base nobody can read, which is `recordSentToPeer`'s unreconstructable
 * thread arriving from the other end. Nothing else in this file can undo that:
 * every other writer here only ever credits.
 *
 * Note what this is NOT. `recordSentToPeer`'s invariant forbids CREDITING the
 * hub ledger from a transfer path that did not go through the hub, because a
 * false credit costs a thread. Forgetting fails in the opposite direction: the
 * worst a wrong forget does is re-send bytes the peer already had. So this adds
 * no new way to credit the ledger, and there is deliberately no
 * `--full`-shaped flag anywhere that writes one.
 *
 * **What it deliberately leaves alone, and why each is a different ledger:**
 *
 * - `received` — what this machine has TAKEN from the peer. A hub losing the
 *   ability to serve a bundle does not un-import a session already on local
 *   disk, so nothing here is falsified; clearing it would make the next pull
 *   re-fetch and re-apply bundles this machine already applied.
 * - `imported` — the content-hash dedup registry. Per PROJECT rather than per
 *   peer, and a claim about this machine's own disk, which no peer can
 *   invalidate. Clearing it turns import's idempotence off and duplicates
 *   sessions the user already has.
 * - `lineage` — provenance of what arrived. Same class as `received`.
 * - `hub.threadByLocalSession` — the one that would actively hurt. A thread id
 *   is the cross-machine identity of a conversation, so forgetting it mints a
 *   NEW one on the next push and splits the thread in two in every other
 *   machine's index. A recovery push has to land under the same thread as the
 *   history it is replacing, which is the whole point of it.
 * - `hub.workspaceGenerations` / `hub.lastWorkspace` — a workspace `basedOn`
 *   naming a bundle nobody can read is already handled, and one level down:
 *   `pull-apply-workspace.ts`'s `fetchAncestorWorkspace` degrades to no ancestor
 *   with a warning, and the merge falls to keep-local. Meanwhile that list is
 *   also OUR half of the "common to both trees" test for INCOMING payloads, so
 *   clearing it would break merges of other machines' work for a push-side
 *   problem it has nothing to do with.
 *
 * The peer entry itself is never created and never removed: forgetting a peer
 * that was never credited is a no-op, not the minting of an empty ledger, and a
 * forget must not take the peer's `name`/`received` with it.
 *
 * Mutates `state` in place and writes nothing, like `setThreadId` /
 * `setLastWorkspace` / `setPeerMemoryDigest` — the caller decides whether this
 * forget is persisted. `hub/push.ts` deliberately does not persist it: a
 * `--full` push that dies before its bundle lands leaves the old ledger intact,
 * so the retry is still a `--full` push rather than a silent full re-upload on
 * whatever unattended push happens next. Touches no `schemaVersion`, since
 * every field it reaches is v1.
 *
 * @param opts.localSessionIds Forget only these sessions (compaction repair
 * knows exactly whose bundles it deleted). Omitted means the whole ledger — and
 * only the whole-ledger form drops `memoryDigest`, which is not per-session and
 * so has no targeted meaning.
 */
export declare function forgetSentToPeer(state: SyncState, peer: {
    id: string;
}, opts?: {
    localSessionIds?: string[];
}): ForgetSentResult;
export declare function getThreadId(state: SyncState, localSessionId: string): string | null;
export declare function setThreadId(state: SyncState, hubId: string, localSessionId: string, threadId: string): void;
/**
 * How many workspace generations this machine remembers having held.
 *
 * The list is what makes a merge base provably common to both trees (see
 * `knownWorkspaceGenerations`), so this bound is the one place that guarantee
 * degrades: a peer more than this many generations behind us declares a base we
 * have forgotten, and the pull then finds no common generation and falls to
 * no-ancestor mode — a loud skip — rather than merging against a guess. That is
 * the safe direction to degrade in, and 50 (fifty workspace pushes or pulls on
 * THIS machine with no sync from that peer in between) is deep enough that
 * reaching it means the peer has effectively stopped syncing. It is bounded at
 * all because each entry is ~200 bytes of a file rewritten on every hub
 * operation.
 */
export declare const MAX_WORKSPACE_GENERATIONS = 50;
/**
 * Record a workspace generation this machine's tree now reflects — pushed or
 * applied — as the new head of its generation history.
 *
 * A generation is a POINTER at a bundle on the hub, never a copy of the tree,
 * because every workspace payload is a full snapshot and the hub already stores
 * it.
 *
 * Three rules the callers depend on:
 *
 * - **Write it only for a generation this machine's tree actually reflects.**
 *   Recording a generation that was never applied (a skipped payload, say)
 *   would make the NEXT merge read "present in the ancestor, absent locally"
 *   as a deliberate local deletion, so files the user never received would be
 *   silently withheld rather than delivered.
 * - **The history matters, not just the head.** `lastWorkspace` alone answers
 *   "what does our tree look like now"; choosing a legal merge base needs "did
 *   we ever hold the generation the peer says it built on", which only the list
 *   can answer. Keeping the head alone is what let a pull merge against a
 *   generation one of the two trees had never held.
 * - `generation.pushedAt` dates the BUNDLE and is DIAGNOSTIC ONLY: it is the
 *   pushing machine's wall clock — the hub is a passive filesystem and stamps
 *   nothing — so it must never be compared with another machine's stamp to
 *   order two generations.
 *
 * Same v1/v2 discipline as `setThreadId`: the hub block (and with it
 * schemaVersion 2) appears only once hub data is first written.
 */
export declare function setLastWorkspace(state: SyncState, hubId: string, generation: {
    bundleId: string;
    file: string;
    pushedAt: string;
}): void;
/**
 * Cap on the notes carried in `hub.lastAutoPush`. This is a breadcrumb, not a
 * log: enough to recognize a recurring disclosure or a persistent failure, and
 * bounded because the file is rewritten on every hub operation.
 */
export declare const MAX_AUTO_PUSH_NOTES = 5;
/**
 * Record what the last SessionEnd auto-push produced for a human to read —
 * which is otherwise thrown away, since that hook's stdout is closed and its
 * stderr is only visible in Claude Code's debug output. See the field's doc in
 * `types.ts`.
 *
 * No-op without a hub block: the breadcrumb is hub bookkeeping, and a project
 * that has never pushed has nothing to say. That also keeps this from being the
 * thing that bumps a file to schemaVersion 2 (the auto-push mints thread ids
 * before it gets here, so a real push has always created the block already).
 */
export declare function setLastAutoPush(state: SyncState, entry: {
    ok: boolean;
    notes: string[];
    at?: string;
}): void;
/**
 * Every workspace generation this machine's tree has passed through, most
 * recent first.
 *
 * This is one half of the "common to both trees" test that a 3-way merge base
 * must pass. The other half is what the incoming bundle chain declares it
 * descends from (`manifest.workspace.basedOn`); the intersection is the set of
 * legal bases, and `hub/pull-apply-workspace.ts`'s `chooseMergeAncestor` takes the newest of
 * them.
 *
 * No timestamp is involved in that decision, deliberately. `pushedAt` is the
 * pushing machine's clock, so ordering two machines' generations by it is
 * meaningless — and a machine whose clock ran fast could otherwise talk a peer
 * into merging against the peer's OWN newest generation, which is precisely the
 * shape that silently reverts the peer's work.
 *
 * `lastWorkspace` leads whenever it is not already the head, so a state file
 * written before the list existed — or hand-edited — still contributes it.
 */
export declare function knownWorkspaceGenerations(state: SyncState): WorkspaceGenerationRef[];
//# sourceMappingURL=sync-state.d.ts.map