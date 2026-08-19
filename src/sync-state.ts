import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { encodeProjectPath } from "./platform.js";
import { userSeshMoverDir } from "./paths.js";
import { readManifest } from "./manifest.js";
import { readLastEntryUuid } from "./jsonl.js";
import type { SyncState, SyncStateSessionSent, WorkspaceGenerationRef } from "./types.js";

export function syncStatePath(projectPath: string): string {
  return join(userSeshMoverDir(), "sync-state", `${encodeProjectPath(projectPath)}.json`);
}

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
export function foreignKeyedRecord<T>(from?: Record<string, T> | null): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, from);
}

function defaultState(projectPath: string): SyncState {
  return {
    projectPath,
    schemaVersion: 1,
    peers: foreignKeyedRecord(),
    lineage: foreignKeyedRecord(),
    imported: foreignKeyedRecord(),
  };
}

// `null` means "not usable as sync state" — the caller decides what that
// costs. Extracted so the read-only reader below can share EXACTLY this
// parse without also inheriting the rename-aside that follows a failure.
function parseSyncState(raw: string): SyncState | null {
  try {
    const parsed = JSON.parse(raw) as SyncState;
    if (
      (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
      parsed.peers === null ||
      typeof parsed.peers !== "object" ||
      parsed.lineage === null ||
      typeof parsed.lineage !== "object"
    ) {
      return null;
    }
    // Normalize each PEER's shape, not just the `peers` container. A peer
    // entry that parses but is missing `received` or `sent` — an interrupted
    // write, a hand edit, a hub file a older version wrote — used to reach
    // `peer.received[id]` and throw `Cannot read properties of undefined`
    // straight out of BOTH hub read commands (`findUnfetchableBundles` runs on
    // every pull and every whereis). Because the file parses, `readSyncState`
    // does not rename it aside, so the project never recovers and no message
    // names the file. Backfilling here means every reader downstream gets the
    // shape its types already claim.
    //
    // Rebuilt with no prototype rather than backfilled in place, for the reason
    // `foreignKeyedRecord` states: every one of these is keyed by a string a
    // peer supplied, and on a plain object a `__proto__`/`constructor` key is
    // "present" before anything writes it.
    parsed.peers = foreignKeyedRecord(parsed.peers);
    parsed.lineage = foreignKeyedRecord(parsed.lineage);
    for (const peer of Object.values(parsed.peers)) {
      if (peer === null || typeof peer !== "object") continue;
      peer.received = foreignKeyedRecord(peer.received);
      peer.sent = foreignKeyedRecord(peer.sent);
    }
    parsed.imported = foreignKeyedRecord(parsed.imported);
    for (const entry of Object.values(parsed.imported)) {
      if (typeof entry.registered !== "boolean") entry.registered = true;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function readSyncState(projectPath: string): SyncState {
  const p = syncStatePath(projectPath);
  if (!existsSync(p)) return defaultState(projectPath);
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return defaultState(projectPath);
  }
  const parsed = parseSyncState(raw);
  if (parsed) return parsed;
  const aside = `${p}.corrupt.${Date.now()}`;
  try {
    renameSync(p, aside);
  } catch {
    /* best effort */
  }
  return defaultState(projectPath);
}

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
export function peekSyncState(projectPath: string): SyncState {
  const p = syncStatePath(projectPath);
  if (!existsSync(p)) return defaultState(projectPath);
  try {
    return parseSyncState(readFileSync(p, "utf-8")) ?? defaultState(projectPath);
  } catch {
    return defaultState(projectPath);
  }
}

export function writeSyncState(state: SyncState): void {
  const p = syncStatePath(state.projectPath);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
}

export function recordSentFromBundle(
  projectPath: string,
  peer: { id: string; name?: string },
  bundleDir: string
): void {
  const state = readSyncState(projectPath);
  if (!state.peers[peer.id]) {
    state.peers[peer.id] = {
      name: peer.name ?? peer.id,
      lastSentAt: null,
      lastReceivedAt: null,
      sent: foreignKeyedRecord(),
      received: foreignKeyedRecord(),
    };
  }
  const p = state.peers[peer.id];
  p.lastSentAt = new Date().toISOString();
  if (peer.name) p.name = peer.name;

  // readManifest is the validation chokepoint (assertSafeManifestIds runs
  // inside it) — session/continuation ids here are already guaranteed safe,
  // no need to re-validate.
  const manifest = readManifest(bundleDir);
  for (const s of manifest.sessions) {
    const localSessionId =
      s.type === "continuation" && s.continuation
        ? s.continuation.continuesLocalSessionId
        : s.sessionId;
    // Head uuid comes from the BUNDLE's snapshot, never the live JSONL:
    // entries appended mid-export stay "unsent" and ship next sync.
    const headUuid =
      readLastEntryUuid(join(bundleDir, "sessions", `${s.sessionId}.jsonl`)) ?? "";
    p.sent[localSessionId] = {
      headEntryUuid: headUuid,
      messageCount: s.messageCount,
      sentAsType: s.type === "continuation" ? "continuation" : "full",
      sentAsSessionId: s.sessionId,
    };
  }
  writeSyncState(state);
}

// Mark a single local session as already-known-to `peer`, without requiring
// a bundle directory on disk (unlike recordSentFromBundle, which derives the
// head uuid + session mapping from a manifest). Used by hub pull: a bundle
// pulled through the hub carries manifest.sourceMachineId set to the
// ORIGINATING machine (see hub/push.ts), so importSession's own peer
// bookkeeping (importer.ts) only ever credits that machine, never the hub
// itself. Without also recording it here, this machine's first push back to
// the hub would see no baseline for the hub's peer id and re-upload the
// whole session as "full" instead of recognizing later edits as a
// continuation (hub/push.ts's incremental diff only consults
// state.peers[hubPeerId]?.sent).
//
// INVARIANT — hub mediation: this credits a peer's "already has it" ledger for
// content that arrived FROM that peer. Its only caller is hub pull, where the
// content demonstrably just came from the hub, so the credit is always true by
// construction.
//
// Any future transfer path that moves sessions BETWEEN machines without going
// through the hub must NOT credit the hub ledger here. Doing so would make the
// next push ship only a delta, leaving a continuation chain on the hub with no
// base bundle to anchor it — an unreconstructable thread for any third machine.
export function recordSentToPeer(
  projectPath: string,
  peer: { id: string; name?: string },
  localSessionId: string,
  sent: SyncStateSessionSent
): void {
  const state = readSyncState(projectPath);
  if (!state.peers[peer.id]) {
    state.peers[peer.id] = {
      name: peer.name ?? peer.id,
      lastSentAt: null,
      lastReceivedAt: null,
      sent: foreignKeyedRecord(),
      received: foreignKeyedRecord(),
    };
  }
  if (peer.name) state.peers[peer.id].name = peer.name;
  state.peers[peer.id].sent[localSessionId] = sent;
  writeSyncState(state);
}

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
export function setPeerMemoryDigest(
  state: SyncState,
  peer: { id: string; name?: string },
  digest: string
): void {
  if (!state.peers[peer.id]) {
    state.peers[peer.id] = {
      name: peer.name ?? peer.id,
      lastSentAt: null,
      lastReceivedAt: null,
      sent: foreignKeyedRecord(),
      received: foreignKeyedRecord(),
    };
  }
  state.peers[peer.id].memoryDigest = digest;
}

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
export function forgetSentToPeer(
  state: SyncState,
  peer: { id: string },
  opts?: { localSessionIds?: string[] }
): ForgetSentResult {
  const entry = state.peers[peer.id];
  if (!entry) return { forgotten: [], memoryDigest: false };
  // `parseSyncState` backfills this, but a state object built in memory (a
  // test, a future caller) has only the type's word for it.
  const sent = entry.sent ?? foreignKeyedRecord();
  entry.sent = sent;

  const scope = opts?.localSessionIds;
  if (scope) {
    const forgotten: string[] = [];
    for (const id of scope) {
      // `Object.prototype.hasOwnProperty.call`, not `id in sent` and not
      // `sent.hasOwnProperty`: these keys come from outside this machine
      // (`foreignKeyedRecord`), so the record may have a null prototype — which
      // has no `hasOwnProperty` — or, if it was built by hand, a real one on
      // which `"__proto__" in sent` is true for a key nobody wrote.
      if (!Object.prototype.hasOwnProperty.call(sent, id)) continue;
      delete sent[id];
      forgotten.push(id);
    }
    return { forgotten, memoryDigest: false };
  }

  const forgotten = Object.keys(sent);
  entry.sent = foreignKeyedRecord();
  const memoryDigest = entry.memoryDigest !== undefined;
  delete entry.memoryDigest;
  return { forgotten, memoryDigest };
}

export function getThreadId(state: SyncState, localSessionId: string): string | null {
  // `?.` after threadByLocalSession too: `parseSyncState` validates neither
  // the `hub` block's shape nor its sub-objects, and `hub` now carries four of
  // them. Every sibling reader is already guarded (pull.ts's `?? {}`,
  // knownWorkspaceGenerations' check) — this was the straggler, and it is
  // called on every push, every pull's index projection, reindex, and the
  // unattended SessionEnd auto-push.
  return state.hub?.threadByLocalSession?.[localSessionId] ?? null;
}

// Files stay schemaVersion 1 until hub data is first written: non-hub users
// keep v1 files readable by older plugin versions. Older versions treat v2
// files as corrupt (rename-aside + fresh state) — that loses only peer
// bookkeeping, never session data.
export function setThreadId(
  state: SyncState,
  hubId: string,
  localSessionId: string,
  threadId: string
): void {
  if (!state.hub) {
    state.hub = { hubId, threadByLocalSession: {} };
    state.schemaVersion = 2;
  }
  // The WRITE half of the guard `getThreadId` already carries, and the half
  // that fails harder. `parseSyncState` shape-checks `schemaVersion`, `peers`
  // and `lineage` and never mentions `hub` at all, so a v2 file whose hub block
  // lost `threadByLocalSession` (an interrupted write, a hand edit) PARSES — the
  // corrupt-file rename-aside never fires — and this line threw `Cannot set
  // properties of undefined` on every push, pull and reindex of that project,
  // forever. On the CLI that is a visible error; on the default-on SessionEnd
  // auto-push `cli.ts` routes it to `writeHookDiagnostic` (stderr only, exit 0),
  // so auto-push simply stops working with no message anywhere.
  //
  // Repaired HERE and not in `parseSyncState`, deliberately: the hub block is
  // added lazily, and backfilling it at parse time would promote every plain
  // incremental-sync user's file to a shape that implies it has a hub.
  if (!state.hub.threadByLocalSession) {
    state.hub.threadByLocalSession = {};
  }
  state.hub.threadByLocalSession[localSessionId] = threadId;
}

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
export const MAX_WORKSPACE_GENERATIONS = 50;

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
export function setLastWorkspace(
  state: SyncState,
  hubId: string,
  generation: { bundleId: string; file: string; pushedAt: string }
): void {
  if (!state.hub) {
    state.hub = { hubId, threadByLocalSession: {} };
    state.schemaVersion = 2;
  }
  const ref: WorkspaceGenerationRef = {
    bundleId: generation.bundleId,
    file: generation.file,
    pushedAt: generation.pushedAt,
    syncedAt: new Date().toISOString(),
  };
  const rest = knownWorkspaceGenerations(state).filter((g) => g.bundleId !== ref.bundleId);
  state.hub.lastWorkspace = ref;
  // Re-applying a generation we already hold moves it back to the head instead
  // of duplicating it: the list is a SET ordered by recency, and a duplicate
  // would burn one of the bounded slots for no information.
  state.hub.workspaceGenerations = [ref, ...rest].slice(0, MAX_WORKSPACE_GENERATIONS);
}

/**
 * Cap on the notes carried in `hub.lastAutoPush`. This is a breadcrumb, not a
 * log: enough to recognize a recurring disclosure or a persistent failure, and
 * bounded because the file is rewritten on every hub operation.
 */
export const MAX_AUTO_PUSH_NOTES = 5;

/** Per-note character cap, for the same reason (a carry warning names files). */
const MAX_AUTO_PUSH_NOTE_CHARS = 500;

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
export function setLastAutoPush(
  state: SyncState,
  entry: { ok: boolean; notes: string[]; at?: string }
): void {
  if (!state.hub) return;
  state.hub.lastAutoPush = {
    at: entry.at ?? new Date().toISOString(),
    ok: entry.ok,
    notes: entry.notes
      .slice(0, MAX_AUTO_PUSH_NOTES)
      .map((n) => (n.length > MAX_AUTO_PUSH_NOTE_CHARS ? `${n.slice(0, MAX_AUTO_PUSH_NOTE_CHARS)}…` : n)),
    noteCount: entry.notes.length,
  };
}

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
export function knownWorkspaceGenerations(state: SyncState): WorkspaceGenerationRef[] {
  const hub = state.hub;
  if (!hub) return [];
  // `Array.isArray`, not `?? []`: the hub block is the one part of the file
  // `parseSyncState` does not shape-check at all, so `workspaceGenerations` can
  // be any JSON value. A string survives `??`, survives `list[0]?.bundleId`
  // (a character has none) and is returned as-is by the `.slice()` below —
  // `chooseMergeAncestor` then calls `.some()` on it and the pull dies with an
  // opaque TypeError. Reading an unusable value as "no generations" degrades the
  // way an empty intersection already does: no ancestor, so no merge.
  const list = Array.isArray(hub.workspaceGenerations) ? hub.workspaceGenerations : [];
  const head = hub.lastWorkspace;
  if (head && list[0]?.bundleId !== head.bundleId) {
    return [head, ...list.filter((g) => g.bundleId !== head.bundleId)];
  }
  return list.slice(); // never hand out the live array: callers only read
}
