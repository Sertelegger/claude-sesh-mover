import { mkdtempSync, rmSync, createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
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
import { runApplyCarryStage } from "./pull-apply-carry.js";
import { runApplySessionsStage } from "./pull-apply-sessions.js";
import { runApplyWorkspaceStage } from "./pull-apply-workspace.js";
import { initApplyState, isCarrySuppressed } from "./pull-apply-state.js";
import { runFetchStage } from "./pull-fetch.js";
import { runRecordStage } from "./pull-record.js";
import { runResolveStage } from "./pull-resolve.js";
import { loadOrCreateMachineId } from "../machine.js";
import { countJsonlLines } from "../jsonl.js";
import { encodeProjectPath } from "../platform.js";
import {
  readSyncState, peekSyncState, writeSyncState, getThreadId, setThreadId, recordSentToPeer,
} from "../sync-state.js";
import type {
  ErrorResult,
  ExportManifest,
  HubLockBusyResult,
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

/**
 * Re-exported rather than re-declared. `apply.sessions` owns the thread-base
 * choice — it re-reads sync-state per bundle to make it — but `selectThreadBase`
 * and its candidate type are part of this package's PUBLIC surface:
 * `src/index.ts` does `export * from "./hub/pull.js"`, and `tests/hub-pull.test.ts`
 * imports it from here. Dropping this line silently deletes a named export from
 * the package entrypoint, and `dist/` is committed, so it would ship.
 * Importing it back the other way would make the two modules circular.
 */
export { selectThreadBase, type ThreadBaseCandidate } from "./pull-apply-sessions.js";

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

      // Splice onto an existing transcript, adopt the hub's branch over a
      // diverged one, or import this bundle's session as its own. `st` is
      // handed over BY REFERENCE and mutated in place — never snapshotted.
      const ss = await runApplySessionsStage({
        extractDir,
        bundleManifest,
        record,
        bundleIndex: i,
        chainLength: needed.length,
        projectPath: effectiveProjectPath,
        configDir: opts.configDir,
        targetProjectDir,
        claudeVersion: opts.claudeVersion,
        threadId: target.threadId,
        sourceMachineId: sourceCopy.machineId,
        hubPeerId,
        noAppend: !!opts.noAppend,
        forceAppend: !!opts.forceAppend,
        onDivergence: opts.onDivergence,
        opNowMs,
        // Three wall-clock reads used to live inside the moved code and are
        // parameters now: a stage file may not read the clock at all (see
        // tests/hub-pull-invariants.test.ts). `ageNowMs` stays SEPARATE from
        // `opNowMs` even though this call passes the same value — one is a
        // boundary ("at or after this was written by us"), the other a duration
        // rendered as "modified 37s ago", and only the second may ever be
        // refreshed. `new Date(opNowMs)` takes an argument, so it is not a
        // clock read.
        ageNowMs: opNowMs,
        historyNowDate: new Date(opNowMs).toISOString().slice(0, 10),
        historyNowMs: opNowMs,
        state: st,
        recordSplice,
        countEntriesAfterOffset,
      });
      // Spread HERE, at the position the moved code occupied and after the
      // workspace stage's reasons: the three in-loop stages are phases of one
      // loop body and their reasons interleave per bundle.
      warnings.push(...ss.reasons);
      // Forwarded VERBATIM, `command: "import"` and all — it is the importer's
      // own diagnosis carrying the importer's own suggestion, and the
      // importer's warnings are dropped with it exactly as before.
      if (ss.control.kind === "fail") return ss.control.result;
      // A REAL break, never a continue. A divergence stops the whole thread,
      // and since the workspace gate is evaluated at the TOP of each iteration
      // this is also what stops a payload on a LATER bundle being applied by a
      // pull the user is about to re-run.
      if (ss.control.kind === "stop-chain") break;
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
