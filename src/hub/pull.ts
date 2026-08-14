import {
  mkdtempSync, rmSync, mkdirSync, createReadStream, existsSync, readdirSync,
  appendFileSync, copyFileSync, statSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend, type HubBackend } from "./backend.js";
import { type HubBundleRecord } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import {
  findUnfetchableBundles, newerThreadCopy,
  type ResolvedThread, type ThreadCopy,
} from "./threads.js";
import { createMachineNameLookup, shapeThreads } from "./whereis.js";
import {
  adoptHubBranch, readDeltaChainInfo, tryAppendContinuation, APPEND_LIVE_WINDOW_MS,
} from "./append.js";
import { runApplyCarryStage } from "./pull-apply-carry.js";
import { runApplyWorkspaceStage } from "./pull-apply-workspace.js";
import { initApplyState, isCarrySuppressed } from "./pull-apply-state.js";
import { runFetchStage } from "./pull-fetch.js";
import { runRecordStage } from "./pull-record.js";
import { runResolveStage } from "./pull-resolve.js";
import { importSession } from "../importer.js";
import { loadOrCreateMachineId } from "../machine.js";
import { computeIntegrityHashFromFile } from "../manifest.js";
import {
  countJsonlLines, findEntryOffsetByUuid, readLastConversationEntry, readLastEntryUuid,
} from "../jsonl.js";
import { encodeProjectPath } from "../platform.js";
import { buildImportRewriteContext, rewriteJsonlStream, type RewriteContext } from "../rewriter.js";
import { getApplicableAdapters } from "../version-adapters.js";
import {
  readSyncState, peekSyncState, writeSyncState, getThreadId, setThreadId, recordSentToPeer,
} from "../sync-state.js";
import type {
  ErrorResult,
  ExportManifest,
  HubLockBusyResult,
  HubPullDivergence,
  HubPullListResult,
  HubPullResult,
  HubUnlinkedResult,
  NotYetSyncedResult,
  OnDivergenceMode,
  ProgressEvent,
  SessionManifest,
  SyncState,
  UnfetchableBundleGroup,
} from "../types.js";

export interface HubPullOptions {
  configDir: string;
  projectPath: string;
  hubPath: string;
  threadId?: string;
  latest?: boolean;
  targetPath?: string; // workspace unpack destination when project dir absent
  forceWorkspace?: boolean;
  /**
   * Apply carried uncommitted changes to the working tree (design §6.2).
   * Without it a carried payload is still SAVED — see `applyCarry`'s
   * `saveOnly` for why reporting it and dropping it would be a dead end.
   */
  applyCarry?: boolean;
  projectIdOverride?: string;
  claudeVersion: string;
  /** Splice onto a base that looks like a live session (skips the mtime guard). */
  forceAppend?: boolean;
  /** Never splice: import every continuation as its own session (Slice-1 behavior). */
  noAppend?: boolean;
  /** How to resolve a two-sided fork. Defaults to "fragment". */
  onDivergence?: OnDivergenceMode;
  onProgress?: (ev: ProgressEvent) => void;
}

export interface ThreadBaseCandidate {
  localSessionId: string;
  /** Uuid of the session's last entry, or null when it can't be read. */
  headEntryUuid: string | null;
  /** Timestamp of that last entry, or null when it can't be read. */
  lastActiveAt: string | null;
}

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
export function selectThreadBase(
  candidates: ThreadBaseCandidate[],
  anchorUuid: string | null,
  preferred: string | null
): string | null {
  if (candidates.length === 0) return null;
  const anchored = anchorUuid
    ? candidates.filter((c) => c.headEntryUuid !== null && c.headEntryUuid === anchorUuid)
    : [];
  const pool = anchored.length > 0 ? anchored : candidates;

  if (preferred && pool.some((c) => c.localSessionId === preferred)) return preferred;

  return pool.reduce((best, c) => {
    const a = best.lastActiveAt ?? "";
    const b = c.lastActiveAt ?? "";
    if (a !== b) return b > a ? c : best;
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

function readSessionTail(path: string): Omit<ThreadBaseCandidate, "localSessionId"> {
  const e = readLastConversationEntry(path);
  if (!e) return { headEntryUuid: null, lastActiveAt: null };
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
function threadBaseCandidates(
  state: SyncState,
  threadId: string,
  pendingSessionId: string | null,
  targetProjectDir: string
): ThreadBaseCandidate[] {
  const ids = new Set<string>();
  for (const [localSessionId, tid] of Object.entries(state.hub?.threadByLocalSession ?? {})) {
    if (tid === threadId) ids.add(localSessionId);
  }
  if (pendingSessionId) ids.add(pendingSessionId);

  const candidates: ThreadBaseCandidate[] = [];
  for (const localSessionId of ids) {
    const p = join(targetProjectDir, `${localSessionId}.jsonl`);
    if (!existsSync(p)) continue;
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
async function copyLayerDirs(
  extractDir: string,
  bundleSessionId: string,
  targetProjectDir: string,
  baseSessionId: string,
  targetConfigDir: string,
  ctx: RewriteContext
): Promise<void> {
  const pairs: Array<{ from: string; to: string; rewriteJsonl: boolean }> = [
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
    if (!existsSync(from)) continue;
    mkdirSync(to, { recursive: true });
    for (const f of readdirSync(from)) {
      const dest = join(to, f);
      if (existsSync(dest)) continue;
      if (rewriteJsonl && f.endsWith(".jsonl")) {
        // Path rewrite + the base's session id, never version adapters —
        // the same rule importer.ts follows for subagents.
        await rewriteJsonlStream(join(from, f), dest, ctx, { newSessionId: baseSessionId });
      } else {
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
async function countEntriesAfterOffset(path: string, offset: number): Promise<number> {
  const input = createReadStream(path, { encoding: "utf-8", start: offset });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of rl) if (line.trim()) count++;
  } finally {
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
function recordSplice(b: {
  projectPath: string;
  basePath: string;
  baseSessionId: string;
  peerId: string;
  hubPeerId: string;
  manifest: ExportManifest;
  record: HubBundleRecord;
  bundleSession: SessionManifest;
  newHeadUuid: string;
}): void {
  const now = new Date().toISOString();
  const messageCount = countJsonlLines(b.basePath);
  const st = readSyncState(b.projectPath);
  st.peers[b.peerId] ??= {
    name: b.manifest.sourceMachineName ?? b.peerId,
    lastSentAt: null, lastReceivedAt: null, sent: {}, received: {},
  };
  const peer = st.peers[b.peerId];
  if (b.manifest.sourceMachineName) peer.name = b.manifest.sourceMachineName;
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
 * The half of a thread this pull cannot reach, in words.
 *
 * Deliberately names NO remedy: there is no `--from-machine`, `--thread` and
 * `--target-path` resolve to the same single source, and `hub reindex` only
 * rebuilds this machine's index from its own bundles. Saying plainly that a
 * thread split across machines cannot be assembled yet is honest; inventing a
 * flag would put this in the milestone's own foreclosure class — a warning
 * whose stated remedy silently does nothing.
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
export function describeUnfetchable(
  threadId: string,
  groups: UnfetchableBundleGroup[],
  source: { machineId: string; machineName: string | null }
): string {
  const NAMED = 3;
  const byName = new Map<string, number>();
  for (const m of [source, ...groups]) {
    if (m.machineName) byName.set(m.machineName, (byName.get(m.machineName) ?? 0) + 1);
  }
  const label = (m: { machineId: string; machineName?: string | null }): string =>
    !m.machineName
      ? m.machineId
      : (byName.get(m.machineName) ?? 0) > 1
        ? `${m.machineName} [${m.machineId}]`
        : m.machineName;
  const sourceLabel = label(source);
  const one = (g: UnfetchableBundleGroup): string =>
    `${label(g)} (${g.bundleIds.length} bundle${g.bundleIds.length === 1 ? "" : "s"})`;
  const rest = groups.length - NAMED;
  const list =
    groups.slice(0, NAMED).map(one).join(", ") +
    (rest > 0 ? ` and ${rest} more machine${rest === 1 ? "" : "s"}` : "");
  const hold = groups.length === 1 ? "holds bundles" : "hold bundles";
  return (
    `Thread ${threadId} could not be pulled whole: ${list} ${hold} for it that ${sourceLabel} does not list, ` +
    `and a pull only ever fetches the bundle list of the one machine it resolves to (${sourceLabel}). ` +
    `The entries in those bundles are not on this machine, and no flag or re-run fetches them — ` +
    `sesh-mover cannot yet assemble a thread whose history is split across machines. ` +
    `Nothing is lost: every bundle is still on the hub.`
  );
}

// Last full bundle + everything after it, minus records already received AND
// still present locally (mirrors the importer's own dedup verification: a
// registry/peer record can outlive the file it points at, e.g. after a
// migrate deleted it, so "already received" is only trusted when the file is
// still there).
export function selectNeededBundles(
  bundles: HubBundleRecord[],
  received: Record<string, { localSessionId: string }> | undefined,
  localSessionFileExists: (localSessionId: string) => boolean
): HubBundleRecord[] {
  let lastFull = -1;
  for (let i = 0; i < bundles.length; i++) if (bundles[i].type === "full") lastFull = i;
  const chain = lastFull >= 0 ? bundles.slice(lastFull) : bundles.slice();
  return chain.filter((r) => {
    const prior = received?.[r.sessionIdInBundle];
    return !(prior && localSessionFileExists(prior.localSessionId));
  });
}

export async function hubPull(
  opts: HubPullOptions
): Promise<
  | HubPullResult
  | HubPullListResult
  | NotYetSyncedResult
  | HubUnlinkedResult
  | HubLockBusyResult
  | ErrorResult
> {
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
  } catch (e) {
    if (e instanceof LockBusyError) {
      return {
        success: false, command: "pull", reason: "lock-busy",
        holderPid: e.holderPid, ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
        suggestion: "Another sesh-mover hub operation is running for this project — wait for it or retry.",
      };
    }
    throw e;
  }

  let tempRoot: string | null = null;
  try {
    tempRoot = mkdtempSync(join(tmpdir(), "sesh-hub-pull-"));
    const backend = createFsBackend(opts.hubPath);
    const warnings: string[] = [];
    if (lock.stoleStale) {
      warnings.push(
        "Stole a stale project lock left by a previous sesh-mover hub operation (likely crashed or was killed) — proceeding, but verify no other push/pull is genuinely in progress."
      );
    }
    const machine = loadOrCreateMachineId();

    // Identity is resolved/linked against opts.projectPath — deliberately
    // NOT the "effective" project path below. In the bootstrap case (the
    // project doesn't exist locally yet and --target-path names a fresh
    // destination for the workspace) that destination must stay genuinely
    // nonexistent until the workspace-unpack step runs; if linking wrote
    // .sesh-mover under it first, the "project path doesn't exist
    // locally" gate on the workspace flow (step 8) would never fire.
    const resolveStage = await runResolveStage({
      backend,
      projectPath: opts.projectPath,
      hubPath: opts.hubPath,
      projectIdOverride: opts.projectIdOverride,
    });
    // The unlinked escape is the finished result, candidates and all — it
    // carries no reasons, and the warnings collected so far are discarded with
    // it exactly as they were before this was a stage.
    if (resolveStage.kind === "return") return resolveStage.result;
    const { local, hub, hubPeerId, resolved } = resolveStage.value;
    warnings.push(...resolveStage.reasons);

    if (!opts.threadId && !opts.latest) {
      // Same project path the real pull below keys its sync-state off, so the
      // pick list's `unfetchableBundles` says exactly what pulling that thread
      // would report. peekSyncState, not readSyncState: this branch returns
      // without applying anything, and it is the only place in pull that reads
      // sync-state without going on to write it — a corrupt file must not be
      // renamed aside by a run that does nothing else.
      const threads = await shapeThreads(
        backend, resolved, machine.id, peekSyncState(opts.targetPath ?? opts.projectPath)
      );
      return { success: true, command: "pull", pickRequired: true, threads, warnings };
    }

    const isCurrent = (t: ResolvedThread): boolean => {
      const localEntry = t.copies.find((c) => c.machineId === machine.id);
      return !!localEntry && localEntry.headEntryUuid === t.latest.headEntryUuid;
    };

    // Everything below (dedup/sync-state, workspace unpack, session import,
    // and this machine's own index projection) is keyed off the EFFECTIVE
    // project path: --target-path when given, else opts.projectPath. Declared
    // here rather than after thread selection so the two "there is nothing to
    // pull" early returns can read sync-state too — see `discloseUnfetchable`.
    const effectiveProjectPath = opts.targetPath ?? opts.projectPath;

    /**
     * The #35 disclosure for a branch that returns BEFORE fetching anything.
     *
     * "Nothing to pull" and "the latest copy is already local" are the two
     * answers a machine holding half a cross-machine thread gets most often —
     * head equality is exactly what a fragment produces (see the head-equality
     * trap in the ledger), so `isCurrent` is TRUE for the thread that is most
     * incomplete. Saying "all threads are current" there is the nag loop this
     * disclosure exists to break, one step earlier than the `needed.length ===
     * 0` branch that already handles it.
     *
     * peekSyncState, not readSyncState: these branches apply nothing, and a
     * corrupt state file must not be renamed aside by a run that does nothing
     * else (same rule as the pick-list branch above).
     */
    const discloseUnfetchable = async (candidates: ResolvedThread[]): Promise<string | null> => {
      const peeked = peekSyncState(effectiveProjectPath);
      const machineName = createMachineNameLookup(backend);
      const lines: string[] = [];
      for (const t of candidates) {
        const sets = findUnfetchableBundles({
          copies: t.copies,
          sourceMachineId: t.latest.machineId,
          localMachineId: machine.id,
          state: peeked,
        });
        if (sets.length === 0) continue;
        const groups = await Promise.all(
          sets.map(async (u) => ({
            machineId: u.machineId,
            machineName: await machineName(u.machineId),
            bundleIds: u.bundleIds,
          }))
        );
        lines.push(
          describeUnfetchable(t.threadId, groups, {
            machineId: t.latest.machineId,
            machineName: await machineName(t.latest.machineId),
          })
        );
      }
      return lines.length > 0 ? lines.join(" ") : null;
    };

    const targetProjectDir = join(opts.configDir, "projects", encodeProjectPath(effectiveProjectPath));

    /**
     * Repair for #28's crash window, on every branch that returns before the
     * thread-mapping block at the bottom of this function can run.
     *
     * THE WINDOW. `peers[...].received` is written INSIDE the bundle loop (by
     * `importSession`, and by `recordSplice` on the append path), while
     * `setThreadId` runs only after the whole chain, the workspace merge and the
     * carry apply. Slice 2 widened the gap considerably. A pull interrupted in
     * between — Ctrl-C, a crash, a laptop lid — therefore leaves this machine
     * holding the content with the receipts to prove it, and no record of which
     * thread it belongs to.
     *
     * WHAT THAT COSTS, MEASURED. The re-pull sees every bundle already received,
     * so it answers "Already up to date with the source machine" (or, once this
     * machine has an index entry with a matching head, "Nothing to pull: all
     * threads are current") and returns — never reaching the mapping block. The
     * next push then finds a local session with no thread id and MINTS A NEW
     * THREAD for it, whose only bundle is a `continuation` with no base anywhere
     * in its own chain: the unreconstructable thread `recordSentToPeer`'s own
     * doc forbids. `whereis` shows two threads for one conversation.
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
    const backfillThreadMappings = (threads: ResolvedThread[]): string | undefined => {
      const peeked = peekSyncState(effectiveProjectPath);
      const wanted = new Map<string, string>(); // localSessionId -> threadId
      for (const t of threads) {
        for (const copy of t.copies) {
          const peer = peeked.peers[copy.machineId];
          if (!peer) continue;
          for (const b of copy.bundles) {
            const localId = peer.received?.[b.sessionIdInBundle]?.localSessionId;
            if (!localId) continue;
            if (getThreadId(peeked, localId)) continue; // already mapped — leave it
            if (!existsSync(join(targetProjectDir, `${localId}.jsonl`))) continue;
            wanted.set(localId, t.threadId);
          }
        }
      }
      if (wanted.size === 0) return undefined;
      // Only now is the state read for WRITING. These branches apply nothing,
      // and `readSyncState` renames a corrupt file aside — a repair that has
      // something to write has earned that, a run with nothing to write has not
      // (same rule the `peekSyncState` callers around here follow).
      const st = readSyncState(effectiveProjectPath);
      let wrote = 0;
      for (const [localId, threadId] of wanted) {
        if (getThreadId(st, localId)) continue;
        setThreadId(st, hub.hubId, localId, threadId);
        wrote++;
      }
      if (wrote === 0) return undefined;
      writeSyncState(st);
      return `${wrote} local session${wrote === 1 ? "" : "s"} held this project's hub content with no thread mapping recorded — the mapping has been restored, so the next push continues the existing thread instead of starting a second one for the same conversation. That gap is what an interrupted pull leaves behind.`;
    };

    /**
     * A copy OTHER than this machine's that still lists bundles this machine
     * has never received — the answer to "the newest head is mine, so is there
     * anything left on the hub for me?", which is NOT the same question.
     *
     * The two come apart on the ordinary divergence flow, and the default-on
     * auto-push makes it routine. `/sesh-mover:pull` probes with
     * `--on-divergence skip` and re-runs with the user's answer; between the
     * two, one SessionEnd hook publishes this machine's own diverged branch,
     * which is more recently active than the hub's side. `target.latest` is
     * then local, and refusing outright ("the latest copy of this thread is
     * already local" / "all threads are current") drops the answer the user
     * just gave for a bundle that is still sitting on the hub, unreceived.
     *
     * Deliberately narrow. It only ever fires when `target.latest` is THIS
     * machine, so it cannot change which copy an ordinary pull resolves to, and
     * it never merges two machines' bundle records into one list (ledger: that
     * linearity is what Task 8's `basedOn` chain walk rests on). Assembling a
     * thread whose history is split across two OTHER machines is still a later
     * slice — `findUnfetchableBundles` remains the disclosure for that.
     *
     * `newerThreadCopy` for the preference so the choice is a strict total order over the
     * candidate set rather than index-file iteration order.
     */
    const alternateSource = (t: ResolvedThread, st: SyncState): ThreadCopy | undefined => {
      const candidates = t.copies.filter(
        (c) =>
          c.machineId !== machine.id &&
          selectNeededBundles(c.bundles, st.peers[c.machineId]?.received, (id) =>
            existsSync(join(targetProjectDir, `${id}.jsonl`))
          ).length > 0
      );
      return candidates.length === 0 ? undefined : candidates.reduce(newerThreadCopy);
    };

    let target: ResolvedThread | undefined;
    if (opts.threadId) {
      target = resolved.find((t) => t.threadId === opts.threadId);
      if (!target) {
        return {
          success: false, command: "pull",
          error: `No thread "${opts.threadId}" found for this project on the hub.`,
          suggestion: "Run whereis to list available threads.",
        };
      }
    } else {
      // --latest: resolveThreads already sorts desc by latest activity —
      // take the first thread that is NOT already current on this machine.
      // Then, only if none qualifies, the thread whose newest copy is ours but
      // which still has an unreceived bundle waiting on another machine — see
      // `alternateSource`.
      target =
        resolved.find((t) => !isCurrent(t)) ??
        resolved.find(
          (t) =>
            t.latest.machineId === machine.id &&
            alternateSource(t, peekSyncState(effectiveProjectPath)) !== undefined
        );
      if (!target) {
        const split = await discloseUnfetchable(resolved);
        const repaired = backfillThreadMappings(resolved);
        return {
          success: false, command: "pull",
          error: split
            ? `Nothing to pull: every thread is current with the machine it resolves to, but not every thread is whole here. ${split}`
            : "Nothing to pull: all threads are current on this machine.",
          details: repaired,
          suggestion: split
            ? "Nothing is left for this machine to fetch from the machine this thread resolves to. The remaining bundles sit on a machine whose bundle list this pull did not read, and no flag makes one pull read two machines' lists, so a thread whose history is split across machines cannot be assembled here yet. Run whereis — the same threads report it as unfetchableBundles."
            : "Run whereis to double-check thread status.",
        };
      }
    }

    let sourceCopy = target.latest;
    if (sourceCopy.machineId === machine.id) {
      const alternate = alternateSource(target, peekSyncState(effectiveProjectPath));
      if (!alternate) {
        const split = await discloseUnfetchable([target]);
        return {
          success: false, command: "pull",
          error: split
            ? `The latest copy of this thread is already local, but the thread is not whole here. ${split}`
            : "The latest copy of this thread is already local.",
          suggestion: split
            ? "Nothing is left for this machine to fetch from the machine this thread resolves to. The remaining bundles sit on a machine whose bundle list this pull did not read, and no flag makes one pull read two machines' lists, so a thread whose history is split across machines cannot be assembled here yet. Run whereis — the same thread reports it as unfetchableBundles."
            : "Run whereis to confirm — there is nothing to pull.",
        };
      }
      const label = (await createMachineNameLookup(backend)(alternate.machineId)) ?? alternate.machineId;
      warnings.push(
        `The most recent copy of thread ${target.threadId} is this machine's own, but ${label} still lists bundles this machine has never received — this pull fetched those instead of answering "the latest copy is already local". That is the ordinary shape after a divergence was left undecided and this machine's own session was pushed in the meantime.`
      );
      sourceCopy = alternate;
    }

    const state = readSyncState(effectiveProjectPath);
    const received = state.peers[sourceCopy.machineId]?.received;
    const needed = selectNeededBundles(
      sourceCopy.bundles,
      received,
      (localSessionId) => existsSync(join(targetProjectDir, `${localSessionId}.jsonl`))
    );
    // DISCLOSURE ONLY — see findUnfetchableBundles. It reads no timestamp, it
    // merges nothing into the source's bundle list, and nothing below it
    // changes what this pull fetches, applies, records, orders or resolves to.
    // A pull that gets half a cross-machine thread still gets exactly the same
    // half it got before; it just no longer does so in silence.
    const unfetchableSets = findUnfetchableBundles({
      copies: target.copies,
      sourceMachineId: sourceCopy.machineId,
      localMachineId: machine.id,
      state,
    });
    let unfetchableBundles: UnfetchableBundleGroup[] | undefined;
    let unfetchableText: string | undefined;
    if (unfetchableSets.length > 0) {
      const machineName = createMachineNameLookup(backend);
      unfetchableBundles = await Promise.all(
        unfetchableSets.map(async (u) => ({
          machineId: u.machineId,
          machineName: await machineName(u.machineId),
          bundleIds: u.bundleIds,
        }))
      );
      unfetchableText = describeUnfetchable(target.threadId, unfetchableBundles, {
        machineId: sourceCopy.machineId,
        machineName: await machineName(sourceCopy.machineId),
      });
      warnings.push(unfetchableText);
    }

    if (needed.length === 0) {
      // Both variants below return without reaching the mapping block — see
      // backfillThreadMappings. This is the branch an interrupted pull's re-run
      // actually lands in when this machine has no index entry for the thread:
      // every bundle is already recorded as received, so `needed` is empty.
      const repaired = backfillThreadMappings([target]);
      if (unfetchableText) {
        // The nag loop this defect produces: whereis says the thread needs
        // pulling, the SessionStart notice repeats it, and every pull used to
        // answer "already up to date" — true of the source machine, false of
        // the thread. Say which.
        return {
          success: false, command: "pull",
          error: `Already up to date with the source machine, but this thread is not whole here. ${unfetchableText}`,
          details: repaired,
          suggestion:
            "Nothing is left for this machine to fetch from the machine this thread resolves to. The remaining bundles sit on a machine whose bundle list this pull did not read, and no flag makes one pull read two machines' lists, so a thread whose history is split across machines cannot be assembled here yet. Run whereis — the same threads report it as unfetchableBundles.",
        };
      }
      return {
        success: false, command: "pull",
        error: "Already up to date with the source machine.",
        details: repaired,
        suggestion: "Run whereis to confirm.",
      };
    }

    const missing: string[] = [];
    for (const record of needed) if (!(await backend.exists(record.file))) missing.push(record.file);
    if (missing.length > 0) {
      return {
        success: false, command: "pull", reason: "not-yet-synced", missing,
        suggestion: "The hub folder has not finished syncing these files — retry in a moment.",
      };
    }

    opts.onProgress?.({ phase: "hub-pull", percent: 0 });

    // Every accumulator this pull's per-bundle loop writes, in one MUTABLE
    // object passed by reference. Nothing here may be snapshotted or copied —
    // see pull-apply-state.ts.
    const st = initApplyState({ needed });

    for (const [i, record] of needed.entries()) {
      // Download, unpack and read the manifest — and, on the way through,
      // write this bundle's workspace generation and carry into `st`. Both are
      // MUTATIONS rather than returned values on purpose (see pull-fetch.ts):
      // the generation must be in `st.chainWorkspaceBases` before the workspace
      // gate a few lines below reads it, and a returned optional carry invites
      // `?? null` at this call site, which would clear an earlier bundle's carry
      // whenever a later bundle has none.
      const fetched = await runFetchStage({
        backend, record, bundleIndex: i, tempRoot, state: st,
      });
      // The only correct handling of a fetch abort. `break` would fall through
      // to the carry gate, the thread mapping, `writeSyncState` and
      // `writeMachineIndex` and then return `success: true` — a refusal turned
      // into a successful pull. `continue` would violate the chain invariant
      // (bundle N+1 is anchored on N's head) and fragment-import AND record the
      // next bundle, foreclosing the remedy the message names.
      if (fetched.status === "aborted") return fetched.terminal!;
      const { extractDir, manifest: bundleManifest } = fetched.value!;

      // Merge, unpack, or decline the chain's workspace payload. Self-gating:
      // called on every bundle, does its work only on the newest one carrying a
      // generation. It stays INSIDE the loop for two reasons — the generation
      // the fetch above just pushed into `st.chainWorkspaceBases` is read by
      // the ancestor hunt in this same iteration, and an earlier bundle's
      // integrity abort has to be able to stop the pull before it runs.
      const ws = await runApplyWorkspaceStage({
        backend,
        extractDir,
        effectiveProjectPath,
        // GIVEN-ness, not path equality: naming a destination is an explicit
        // "use this one", and the routine skip is only for the destination the
        // user never named.
        targetPathGiven: !!opts.targetPath,
        forceWorkspace: !!opts.forceWorkspace,
        bundleDeclaresWorkspace: i === st.workspaceBundleIndex && !!bundleManifest.workspace,
        chainWorkspaceBases: st.chainWorkspaceBases,
        hubId: hub.hubId,
        record,
        tempRoot,
      });
      // Terminal, never apply-safe. Carrying on past it would import this
      // bundle's sessions and record it, foreclosing the --force-workspace
      // re-run the abort's own message promises.
      if (ws.status === "aborted") return ws.terminal!;
      if (ws.value) {
        st.workspaceUnpacked = ws.value.unpacked;
        st.workspaceMerge = ws.value.merge;
        st.workspaceRefused = ws.value.refused;
        st.workspaceDeclaredMissing = ws.value.declaredMissing;
      }
      // Spread HERE, inside the loop, at the position the moved code occupied:
      // these interleave with the session warnings of the same and earlier
      // bundles, and a stage-major concatenation reorders them (see
      // tests/hub-pull-invariants.test.ts).
      warnings.push(...ws.reasons);

      // Append path: a continuation whose chain matches one of this thread's
      // local sessions splices onto that session, so the conversation stays
      // one resumable transcript. Every guard lives in append.ts and ANY
      // decline falls through to the import below — content always arrives,
      // at worst as the Slice-1 fragment.
      const bundleSession = bundleManifest.sessions.find(
        (s) => s.sessionId === record.sessionIdInBundle
      );
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
          warnings.push(
            `Continuation for thread ${target.threadId} failed its integrity check (bundle content doesn't match the manifest hash) — not spliced into the existing session; importing it as a separate session instead.`
          );
        } else {
          // Which of this thread's local sessions does this delta continue?
          // Decided by the delta's own anchor, never by map order — see
          // selectThreadBase. Re-read state because importSession rewrites it
          // between iterations.
          const deltaInfo = await readDeltaChainInfo(deltaPath);
          const anchorUuid = deltaInfo.firstEntryParentUuid;
          const baseSessionId = selectThreadBase(
            threadBaseCandidates(
              readSyncState(effectiveProjectPath),
              target.threadId,
              st.threadLandedSessionId,
              targetProjectDir
            ),
            anchorUuid,
            st.threadLandedSessionId
          );

          if (baseSessionId) {
            const basePath = join(targetProjectDir, `${baseSessionId}.jsonl`);
            // Identical derivation to importSession's — same manifest, same
            // target — so a spliced continuation and an imported fragment
            // carry byte-identical rewrites.
            const ctx = buildImportRewriteContext(
              bundleManifest,
              effectiveProjectPath,
              opts.configDir
            );
            // Captured before the attempt, kept only if it succeeds: a declined
            // append writes nothing, and recording an offset for it would make a
            // later bundle discount entries that ARE the user's own.
            const baseSizeBeforeAppend = statSync(basePath).size;
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
              st.rememberOurWrite(basePath, baseSizeBeforeAppend);
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
                await copyLayerDirs(
                  extractDir, record.sessionIdInBundle,
                  targetProjectDir, baseSessionId, opts.configDir, ctx
                );
              } catch (e) {
                warnings.push(
                  `Continuation was appended to session ${baseSessionId}, but copying its subagent/tool-result/file-history files failed (${(e as Error).message}) — the transcript is complete; those side files are missing.`
                );
              }

              st.appended.push({
                threadId: target.threadId,
                baseSessionId,
                entriesAppended: outcome.entriesAppended,
              });
              st.threadLandedSessionId = baseSessionId;
              st.lastAppliedIndex = i;
              st.lastBundleManifest = bundleManifest;
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
              // "Entries the hub hasn't seen" must mean the USER's entries. An
              // earlier bundle of this same pull may have spliced onto this very
              // transcript, and those entries came FROM the hub moments ago — a
              // measured fork of 4 was 2 local entries plus this pull's own 2.
              // Our writes are contiguous at the end of the file, so everything
              // at or after `ourStart` is ours; counting from the later of the
              // two offsets subtracts exactly that tail and leaves the entries
              // between the anchor and our first byte, which are the real fork.
              const rawSinceAnchor =
                anchorOffset === null ? 0 : await countEntriesAfterOffset(basePath, anchorOffset);
              const ourStart = st.ourWritesFrom.get(basePath);
              const oursSinceAnchor =
                anchorOffset === null || ourStart === undefined
                  ? 0
                  : await countEntriesAfterOffset(basePath, Math.max(anchorOffset, ourStart));
              const baseMtimeMs = statSync(basePath).mtimeMs;
              const mode = opts.onDivergence ?? "fragment";
              const divergence: HubPullDivergence = {
                threadId: target.threadId,
                anchorUuid: anchorUuid ?? "",
                localSessionId: baseSessionId,
                localHeadUuid: readLastEntryUuid(basePath) ?? "",
                localEntriesSinceAnchor: Math.max(0, rawSinceAnchor - oursSinceAnchor),
                localLastActiveAt: new Date(baseMtimeMs).toISOString(),
                hubHeadUuid: deltaInfo.lastEntryUuid ?? "",
                // The synthetic continuation header is bundle plumbing, not a
                // message — counting it would overstate the hub's side by one.
                hubEntriesSinceAnchor: Math.max(
                  0,
                  bundleSession.messageCount - (deltaInfo.headerPresent ? 1 : 0)
                ),
                hubLastActiveAt: record.pushedAt,
                adoptAvailable: anchorOffset !== null,
                resolution: mode,
              };
              st.lastDivergence = divergence;

              // The two sides of the fork, phrased for the user. When the
              // anchor isn't in the local session at all there IS no shared
              // point to count from — `localEntriesSinceAnchor` is 0 by
              // definition, and reporting "0 entries the hub hasn't seen"
              // about a session that doesn't even contain the anchor is
              // simply false. Say what actually happened instead.
              const plural = (n: number): string => `${n} entr${n === 1 ? "y" : "ies"}`;
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
                // Two texts, because "nothing changed" is only true at the head
                // of the chain. At i > 0 the abort still leaves the FORK
                // undecided and this bundle unrecorded — which is what keeps the
                // re-run honest — but the bundles before it are applied and
                // recorded, and saying otherwise is a false statement about the
                // user's own transcripts.
                warnings.push(
                  i === 0
                    ? `Thread ${target.threadId} has diverged: ${forkSummary} — skipped, nothing changed. Re-run with --on-divergence fragment${divergence.adoptAvailable ? " or adopt-hub" : ""} to decide.`
                    : `Thread ${target.threadId} has diverged: ${forkSummary} — this bundle was skipped and the fork is still undecided, but ${st.describeApplied(i)}, so this pull was not a no-op. Re-run with --on-divergence fragment${divergence.adoptAvailable ? " or adopt-hub" : ""} to decide; the re-run resumes at this bundle, not at the start of the chain.`
                );
                st.skippedByDivergence = true;
                // The whole thread stops here, not just this bundle — see
                // `divergenceAborted`. Nothing is recorded FOR THIS BUNDLE OR
                // ANY LATER ONE, so the decision can still be made in full.
                st.divergenceAborted = true;
                st.abortIndex = i;
                st.deferredBundles = needed.length - 1 - i;
                break;
              }

              if (mode === "adopt-hub" && divergence.adoptAvailable && looksLive && !opts.forceAppend) {
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
                warnings.push(
                  i === 0
                    ? `adopt-hub refused for thread ${target.threadId}: session ${baseSessionId} was modified ${Math.round(baseAgeMs / 1000)}s ago, so a Claude Code session may still be open on it — adopting would truncate a transcript that is being written to, and anything it writes afterwards would chain onto the hub's branch instead of yours. Nothing was applied and nothing was recorded: exit that session, then re-run with --on-divergence adopt-hub --force-append (or --on-divergence fragment to keep both as separate sessions).`
                    : `adopt-hub refused for thread ${target.threadId}: session ${baseSessionId} was modified ${Math.round(baseAgeMs / 1000)}s ago, so a Claude Code session may still be open on it — adopting would truncate a transcript that is being written to, and anything it writes afterwards would chain onto the hub's branch instead of yours. Nothing was applied or recorded for this bundle or any later one in the chain, so the adoption is still open; ${st.describeApplied(i)}. Exit that session, then re-run with --on-divergence adopt-hub --force-append (or --on-divergence fragment to keep both as separate sessions) — the re-run resumes at this bundle.`
                );
                divergence.resolution = "skip";
                st.skippedByDivergence = true;
                st.divergenceAborted = true;
                st.abortIndex = i;
                st.deferredBundles = needed.length - 1 - i;
                break;
              }

              if (mode === "adopt-hub" && divergence.adoptAvailable) {
                const preservedSessionId = randomUUID();
                const preservedPath = join(targetProjectDir, `${preservedSessionId}.jsonl`);
                const adopt = await adoptHubBranch({
                  basePath, baseSessionId, deltaPath,
                  anchorOffset: anchorOffset!,
                  preservedSessionId, preservedPath, ctx,
                  adapters: getApplicableAdapters(
                    bundleManifest.sourceClaudeVersion, opts.claudeVersion
                  ),
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
                    appendFileSync(
                      join(opts.configDir, "history.jsonl"),
                      JSON.stringify({
                        display: `${bundleSession.slug} (local divergence, preserved ${new Date().toISOString().slice(0, 10)})`,
                        pastedContents: {},
                        timestamp: Date.now(),
                        project: effectiveProjectPath,
                        sessionId: preservedSessionId,
                      }) + "\n",
                      "utf-8"
                    );
                  } catch (e) {
                    warnings.push(
                      `Your local branch was preserved as session ${preservedSessionId}, but registering it in history.jsonl failed (${(e as Error).message}) — the file is there and \`claude --resume ${preservedSessionId}\` still works; it just won't be listed.`
                    );
                  }
                  // The adopted branch's layer files, onto the base — exactly
                  // as for a plain append. The PRESERVED session deliberately
                  // gets none: layer files are uuid-named under the base
                  // session's directories and stay there, shared history and
                  // local branch alike. Duplicating arbitrarily large blobs to
                  // give a second session the same auxiliary detail is a poor
                  // trade; the preserved transcript is complete without them.
                  try {
                    await copyLayerDirs(
                      extractDir, record.sessionIdInBundle,
                      targetProjectDir, baseSessionId, opts.configDir, ctx
                    );
                  } catch (e) {
                    warnings.push(
                      `The hub branch was adopted into session ${baseSessionId}, but copying its subagent/tool-result/file-history files failed (${(e as Error).message}) — the transcript is complete; those side files are missing.`
                    );
                  }

                  divergence.preservedSessionId = preservedSessionId;
                  st.appended.push({
                    threadId: target.threadId,
                    baseSessionId,
                    entriesAppended: adopt.entriesAppended,
                  });
                  warnings.push(
                    `Adopted the hub branch for thread ${target.threadId} into session ${baseSessionId}; your local branch was preserved in full as session ${preservedSessionId}, which has no thread mapping and will therefore be published as its own thread on the next push.`
                  );
                  // Only reachable with --force-append (the refusal above owns
                  // the unforced case), so this is the consequence the user
                  // consented to, restated now that it is real.
                  if (looksLive) {
                    warnings.push(
                      `Session ${baseSessionId} was modified ${Math.round(baseAgeMs / 1000)}s ago and was adopted anyway because --force-append was passed. If a Claude Code session is still open on it, exit it now: anything it writes from here chains onto the adopted hub branch, not onto the local branch preserved as ${preservedSessionId}.`
                    );
                  }
                  st.threadLandedSessionId = baseSessionId;
                  st.lastAppliedIndex = i;
                  st.lastBundleManifest = bundleManifest;
                  st.rememberOurWrite(basePath, anchorOffset!);
                  continue; // bundle handled — no fragment import
                }

                warnings.push(
                  // "left unchanged", not "restored unchanged": a `failed`
                  // adoption covers both the restored-byte-for-byte case and
                  // the (more common) one where the fault landed before the
                  // truncate and nothing was ever written, so nothing was
                  // restored either. Either way the user's session is as it
                  // was, which is the part that matters to them.
                  `adopt-hub failed for thread ${target.threadId} and session ${baseSessionId} was left unchanged (${adopt.detail}) — importing the hub's branch as a separate session instead.`
                );
                divergence.resolution = "fragment";
              } else if (mode === "adopt-hub") {
                warnings.push(
                  `adopt-hub is unavailable for thread ${target.threadId}: the continuation's anchor ${divergence.anchorUuid} is not present in the local session ${baseSessionId} (unrelated or compacted history) — importing the hub's branch as a separate session instead.`
                );
                divergence.resolution = "fragment";
              } else if (divergence.adoptAvailable) {
                // No re-run is offered, because none exists: the fragment
                // import below records this bundle, after which
                // `--on-divergence adopt-hub` reports "already up to date" and
                // never reaches the fork. `skip` is named only as the mode to
                // run the NEXT divergence under — it applies and records
                // nothing, which is what keeps the choice open.
                warnings.push(
                  `Thread ${target.threadId} has diverged: ${forkSummary}, so the hub's branch was imported as a separate session and nothing local was touched. Both branches are now local sessions and this bundle is recorded as received, so that decision stands for it — adopt-hub cannot be applied to it afterwards. To be asked instead of having fragment chosen for you, pull with --on-divergence skip (what /sesh-mover:pull always passes) or set hub.onDivergence=skip.`
                );
              } else {
                warnings.push(
                  `Thread ${target.threadId} could not be continued locally: ${forkSummary}. The hub's branch was imported as a separate session and nothing local was touched — adopt-hub cannot help here.`
                );
              }
              // fall through to the fragment import
            } else {
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
              const preventive =
                outcome.reason === "recently-active"
                  ? " Nothing local was touched. This bundle is now recorded, so no re-run applies it to the existing session. To have later continuations of this thread spliced in, close the Claude Code session writing to that transcript before pulling — and note that an earlier sesh-mover pull's own write to that session looks the same from here, in which case there is no session to close and passing --force-append on the next pull of this thread splices that pull's continuation instead."
                  : "";
              warnings.push(
                `Continuation for thread ${target.threadId} could not be appended to the local session (${outcome.detail}) — imported as a separate session instead.${preventive}`
              );
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
      if (!importResult.success) return importResult; // importer already rolled back partial writes
      st.lastAppliedIndex = i;
      st.lastBundleManifest = bundleManifest;
      st.importedSessions.push(...importResult.importedSessions);
      st.skippedSessions.push(...importResult.skippedSessions);
      warnings.push(...importResult.warnings);
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
        recordSentToPeer(effectiveProjectPath, { id: hubPeerId, name: "hub" }, st.lastImportedNewId, {
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
    const carrySuppressed = isCarrySuppressed(st);
    if (st.divergenceAborted) {
      const parts: string[] = [];
      if (st.deferredBundles > 0) {
        parts.push(
          `the ${st.deferredBundles} later bundle${st.deferredBundles === 1 ? "" : "s"} in this thread's chain ${st.deferredBundles === 1 ? "was" : "were"} not fetched`
        );
      }
      if (carrySuppressed) {
        parts.push("the uncommitted work that bundle carried was left in it");
      }
      if (parts.length > 0) {
        warnings.push(
          `Because that decision is still open, ${parts.join(" and ")} — nothing from ${parts.length === 1 ? "it" : "them"} was applied, saved or recorded either.` +
            (st.abortIndex > 0
              ? ` The ${st.abortIndex} bundle${st.abortIndex === 1 ? "" : "s"} before it in the chain had already been applied and recorded, so your answer applies from the diverged bundle onward rather than to the whole thread.`
              : " Whichever answer you give next applies to the whole thread rather than half of it.")
        );
      }
    }
    // `applyRequested: false` is NOT a skip — the stage still SAVES the
    // payload beside the project. See the module doc before changing this.
    const carryStage = await runApplyCarryStage({
      targetPath: effectiveProjectPath,
      applyRequested: opts.applyCarry === true,
      apply: st,
    });
    warnings.push(...carryStage.reasons);
    const carryAvailable = carryStage.value?.carryAvailable;
    const carryApplied = carryStage.value?.carryApplied;

    const recorded = await runRecordStage({
      backend,
      configDir: opts.configDir,
      effectiveProjectPath,
      projectId: local.projectId,
      machineId: machine.id,
      hubId: hub.hubId,
      threadId: target.threadId,
      sourceMachineId: sourceCopy.machineId,
      needed,
      apply: st,
    });
    warnings.push(...recorded.reasons);
    const localSessionId = recorded.value?.localSessionId ?? null;

    opts.onProgress?.({ phase: "hub-pull", percent: 100 });
    return {
      success: true,
      command: "pull",
      threadId: target.threadId,
      sourceMachineId: sourceCopy.machineId,
      importedSessions: st.importedSessions,
      skippedSessions: st.skippedSessions,
      localSessionId,
      workspaceUnpacked: st.workspaceUnpacked,
      workspaceMerge: st.workspaceMerge,
      workspaceRefused: st.workspaceRefused,
      workspaceDeclaredMissing: st.workspaceDeclaredMissing,
      carryAvailable,
      carryApplied,
      appended: st.appended.length > 0 ? st.appended : undefined,
      divergence: st.lastDivergence,
      unfetchableBundles,
      warnings,
    };
  } finally {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    lock.release();
  }
}
