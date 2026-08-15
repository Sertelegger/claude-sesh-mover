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
 * THE SYNC-STATE SPLIT IS LOAD-BEARING, so this stage takes a project PATH and
 * does its own I/O rather than accepting a `SyncState`. Only `readSyncState`
 * renames a corrupt file aside, and which branch has earned the right to do
 * that is decided per branch — `backfillThreadMappings` applies the rule twice
 * inside itself, peeking to ask whether there is anything to repair and reading
 * only once there is. Collapsing the two into one passed-in value would make a
 * `--latest` pull that finds nothing to do start renaming state files aside, on
 * the code path the SessionStart hook also runs.
 *
 * This is the seam #35 (chain assembly) and #44 (the `--latest` re-gate) land
 * in: `needed` being drawn from ONE machine's bundle list, and `alternateSource`
 * being the only widening of that, are both stated here and nowhere else.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HubBackend } from "./backend.js";
import type { HubBundleRecord } from "./layout.js";
import {
  findUnfetchableBundles, newerThreadCopy,
  type ResolvedThread, type ThreadCopy,
} from "./threads.js";
import { createMachineNameLookup, shapeThreads } from "./whereis.js";
import {
  readSyncState, peekSyncState, writeSyncState, getThreadId, setThreadId,
} from "../sync-state.js";
import type {
  ErrorResult,
  NotYetSyncedResult,
  SyncState,
  UnfetchableBundleGroup,
  WhereisThread,
} from "../types.js";

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

/** Does this machine already hold the thread's newest head? */
export function isCurrent(t: ResolvedThread, machineId: string): boolean {
  const localEntry = t.copies.find((c) => c.machineId === machineId);
  return !!localEntry && localEntry.headEntryUuid === t.latest.headEntryUuid;
}

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
export function alternateSource(
  t: ResolvedThread,
  st: SyncState,
  ctx: { machineId: string; targetProjectDir: string }
): ThreadCopy | undefined {
  const candidates = t.copies.filter(
    (c) =>
      c.machineId !== ctx.machineId &&
      selectNeededBundles(c.bundles, st.peers[c.machineId]?.received, (id) =>
        existsSync(join(ctx.targetProjectDir, `${id}.jsonl`))
      ).length > 0
  );
  return candidates.length === 0 ? undefined : candidates.reduce(newerThreadCopy);
}

export interface SelectStageInput {
  backend: HubBackend;
  /** Every machine's view of this project's threads, as `resolve` produced it. */
  resolved: ResolvedThread[];
  /** This machine's id — the "is it already here" side of every comparison. */
  machineId: string;
  /** Keys the thread mapping this stage may repair. */
  hubId: string;
  threadId?: string;
  latest?: boolean;
  /**
   * `--target-path` when given, else the project path. Everything downstream of
   * selection keys its sync-state off this, so the pick list's disclosure
   * describes exactly what pulling that thread would report. The stage reads
   * (and, on the repair path, writes) the state file itself — see the module
   * doc for why a `SyncState` parameter would be wrong.
   */
  effectiveProjectPath: string;
  /** `<configDir>/projects/<encoded effective path>` — where a local session file would be. */
  targetProjectDir: string;
}

export interface SelectStageResult {
  /**
   * NARROWED on purpose: the thread's id and the source machine's id, never the
   * `ResolvedThread`/`ThreadCopy` they came from. Handing back `copies` would
   * let a later stage re-derive the selection from it, and `copies` is the field
   * carrying an iteration-order ban.
   */
  threadId: string;
  sourceMachineId: string;
  needed: HubBundleRecord[];
  /** Read exactly once, at the caller's final `HubPullResult` assembly. */
  unfetchableBundles: UnfetchableBundleGroup[] | undefined;
}

/**
 * `warnings` rides on `proceed` ALONE, and that is the contract, not an
 * oversight: today's code pushes the unfetchable sentence before the
 * "already up to date" gate and the returns there carry no `warnings` field,
 * so the text is discarded. The caller reproduces that by dispatching on
 * `stop` BEFORE spreading `warnings`.
 *
 * `pick-list` carries no warnings for the same reason in reverse — the caller
 * owns the list (it has the lock-steal warning and the resolve stage's reasons
 * in it already), so handing it in only to get it back would be a detour.
 */
export type SelectOutcome =
  | { kind: "proceed"; value: SelectStageResult; warnings: string[] }
  | { kind: "pick-list"; threads: WhereisThread[] }
  | { kind: "stop"; result: ErrorResult | NotYetSyncedResult };

export async function runSelectStage(input: SelectStageInput): Promise<SelectOutcome> {
  const { backend, resolved, machineId, hubId, effectiveProjectPath, targetProjectDir } = input;
  const warnings: string[] = [];

  if (!input.threadId && !input.latest) {
    // Same project path the real pull below keys its sync-state off, so the
    // pick list's `unfetchableBundles` says exactly what pulling that thread
    // would report. peekSyncState, not readSyncState: this branch returns
    // without applying anything, and it is the only place in pull that reads
    // sync-state without going on to write it — a corrupt file must not be
    // renamed aside by a run that does nothing else.
    const threads = await shapeThreads(
      backend, resolved, machineId, peekSyncState(effectiveProjectPath)
    );
    return { kind: "pick-list", threads };
  }

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
        localMachineId: machineId,
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
      setThreadId(st, hubId, localId, threadId);
      wrote++;
    }
    if (wrote === 0) return undefined;
    writeSyncState(st);
    return `${wrote} local session${wrote === 1 ? "" : "s"} held this project's hub content with no thread mapping recorded — the mapping has been restored, so the next push continues the existing thread instead of starting a second one for the same conversation. That gap is what an interrupted pull leaves behind.`;
  };

  let target: ResolvedThread | undefined;
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
  } else {
    // --latest: resolveThreads already sorts desc by latest activity —
    // take the first thread that is NOT already current on this machine.
    // Then, only if none qualifies, the thread whose newest copy is ours but
    // which still has an unreceived bundle waiting on another machine — see
    // `alternateSource`.
    target =
      resolved.find((t) => !isCurrent(t, machineId)) ??
      resolved.find(
        (t) =>
          t.latest.machineId === machineId &&
          alternateSource(t, peekSyncState(effectiveProjectPath), {
            machineId, targetProjectDir,
          }) !== undefined
      );
    if (!target) {
      const split = await discloseUnfetchable(resolved);
      const repaired = backfillThreadMappings(resolved);
      return {
        kind: "stop",
        result: {
          success: false, command: "pull",
          error: split
            ? `Nothing to pull: every thread is current with the machine it resolves to, but not every thread is whole here. ${split}`
            : "Nothing to pull: all threads are current on this machine.",
          details: repaired,
          suggestion: split
            ? "Nothing is left for this machine to fetch from the machine this thread resolves to. The remaining bundles sit on a machine whose bundle list this pull did not read, and no flag makes one pull read two machines' lists, so a thread whose history is split across machines cannot be assembled here yet. Run whereis — the same threads report it as unfetchableBundles."
            : "Run whereis to double-check thread status.",
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
          suggestion: split
            ? "Nothing is left for this machine to fetch from the machine this thread resolves to. The remaining bundles sit on a machine whose bundle list this pull did not read, and no flag makes one pull read two machines' lists, so a thread whose history is split across machines cannot be assembled here yet. Run whereis — the same thread reports it as unfetchableBundles."
            : "Run whereis to confirm — there is nothing to pull.",
        },
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
    localMachineId: machineId,
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
        kind: "stop",
        result: {
          success: false, command: "pull",
          error: `Already up to date with the source machine, but this thread is not whole here. ${unfetchableText}`,
          details: repaired,
          suggestion:
            "Nothing is left for this machine to fetch from the machine this thread resolves to. The remaining bundles sit on a machine whose bundle list this pull did not read, and no flag makes one pull read two machines' lists, so a thread whose history is split across machines cannot be assembled here yet. Run whereis — the same threads report it as unfetchableBundles.",
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

  const missing: string[] = [];
  for (const record of needed) if (!(await backend.exists(record.file))) missing.push(record.file);
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
      unfetchableBundles,
    },
    warnings,
  };
}
