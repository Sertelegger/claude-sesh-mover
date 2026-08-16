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
import type { HubBackend } from "./backend.js";
import type { HubBundleRecord } from "./layout.js";
import {
  alternateSource, findUnfetchableBundles, planThreadPull, pullSourceFor, sourcedKey,
  type AssembledChain, type ResolvedThread, type ThreadCopy,
} from "./threads.js";
import { createMachineNameLookup, shapeThreads } from "./whereis.js";
import {
  readSyncState, peekSyncState, writeSyncState, getThreadId, setThreadId,
} from "../sync-state.js";
import type {
  ErrorResult,
  HubPullFindings,
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

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** At most three ids, so one sentence stays readable however wide the hub is. */
function someIds(ids: string[]): string {
  const NAMED = 3;
  const rest = ids.length - NAMED;
  return ids.slice(0, NAMED).join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}

/**
 * What chain assembly worked out about a thread and could NOT deliver, in
 * words — one sentence per KIND of anomaly, never one per record.
 *
 * THE FOUR ARE DELIBERATELY FOUR SENTENCES, because they are four different
 * facts with four different remedies, and spec §0b exists to keep the first two
 * apart:
 *
 * - a GAP is a link naming an entry no bundle carries: something is missing;
 * - a PRE-ASSEMBLY record is a bundle pushed before `anchorEntryUuid` existed:
 *   nothing is missing, the link was never written, and a fresh push re-links
 *   it. Reporting it as a gap would send a user hunting for a bundle that is
 *   sitting right there;
 * - a PARKED branch is a real fork on the hub — this pull followed one side;
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
 */
async function describeAssembly(
  threadId: string,
  assembled: AssembledChain,
  args: {
    localMachineId: string;
    outstanding: Set<string>;
    machineName: (id: string) => Promise<string | null>;
  }
): Promise<{ notes: string[]; reportOnly: string[] }> {
  const { localMachineId, outstanding, machineName } = args;
  const left = (machineId: string, bundleId: string): boolean =>
    outstanding.has(sourcedKey(machineId, bundleId));
  const label = async (id: string): Promise<string> => (await machineName(id)) ?? id;

  const notes: string[] = [];

  const gaps = assembled.gaps.filter((g) => left(g.machineId, g.bundleId));
  if (gaps.length > 0) {
    const stranded = new Set(gaps.flatMap((g) => g.strandedBundleIds));
    for (const g of gaps) stranded.delete(g.bundleId);
    notes.push(
      `Thread ${threadId} could not be assembled whole: ${count(gaps.length, "bundle")} ` +
        `(${someIds(gaps.map((g) => g.bundleId))}) continue${gaps.length === 1 ? "s" : ""} an entry ` +
        `no bundle on this hub carries` +
        (stranded.size > 0 ? `, which strands ${count(stranded.size, "later bundle")} behind them` : "") +
        `. The chain was applied up to that point and stopped there rather than resuming past it. ` +
        `Nothing is lost: every bundle is still on the hub.`
    );
  }

  const pre = assembled.unanchored.filter((u) => u.preAssembly && left(u.machineId, u.bundleId));
  if (pre.length > 0) {
    notes.push(
      `${count(pre.length, "bundle")} for thread ${threadId} (${someIds(pre.map((u) => u.bundleId))}) ` +
        `${pre.length === 1 ? "was" : "were"} pushed before sesh-mover recorded which entry a ` +
        `continuation chains onto, so ${pre.length === 1 ? "it has" : "they have"} no place in this ` +
        `thread's history to be put in. That is a bundle pushed before chain assembly existed, not a ` +
        `missing one — nothing is lost, and the machine that still holds that session re-links ` +
        `${pre.length === 1 ? "it" : "them"} the next time it pushes.`
    );
  }

  const damaged = assembled.unanchored.filter((u) => !u.preAssembly && left(u.machineId, u.bundleId));
  if (damaged.length > 0) {
    notes.push(
      `${count(damaged.length, "bundle")} for thread ${threadId} ` +
        `(${someIds(damaged.map((u) => u.bundleId))}) ${damaged.length === 1 ? "declares" : "declare"} ` +
        `itself a continuation of nothing, which no sesh-mover push can produce — that index is ` +
        `damaged or hand-edited. ${damaged.length === 1 ? "It was" : "They were"} left alone.`
    );
  }

  const parked = assembled.forks
    .flatMap((f) => f.parked)
    .filter((b) => left(b.machineId, b.bundleId));
  if (parked.length > 0) {
    notes.push(
      `Thread ${threadId} forks on the hub. This pull followed one branch ` +
        `(${someIds(assembled.forks.map((f) => f.followedBundleId))}) and left ` +
        `${count(parked.length, "other branch", "other branches")} ` +
        `(${someIds(parked.map((b) => b.bundleId))}) unfetched; ` +
        `${parked.length === 1 ? "it is" : "they are"} still on the hub.`
    );
  }

  const ads = assembled.advertisedUnshipped.filter((a) => a.machineId !== localMachineId);
  const reportOnly: string[] = [];
  if (ads.length > 0) {
    const names = await Promise.all([...new Set(ads.map((a) => a.machineId))].map(label));
    reportOnly.push(
      `${someIds(names)} ${names.length === 1 ? "advertises" : "advertise"} newer work on thread ` +
        `${threadId} than ${names.length === 1 ? "it has" : "they have"} pushed to the hub, so no ` +
        `pull can fetch it yet. That work is not missing from this machine — it has not been ` +
        `uploaded. It arrives once that machine pushes (its SessionEnd auto-push does this by default).`
    );
  }

  return { notes, reportOnly };
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

/**
 * One bundle this pull will fetch, paired with the machine whose index listed
 * it — the peer whose ledger that bundle's arrival credits.
 *
 * THE PAIRING LIVES HERE AND NOT ON THE RECORD, and that is a schema decision
 * rather than a style one. `HubBundleRecord` is the ON-DISK index shape
 * (`layout.ts`), so a machine id inside it would put one machine's claim about
 * its own identity inside a file every other machine parses — the exact
 * substitution `resolveThreads` already refuses by spreading the entry FIRST
 * and the file-derived id SECOND. A fetch plan is a per-pull structure nobody
 * stores, so it is free to carry what the schema may not.
 *
 * ELEMENTS OF ONE PLAN NOW DISAGREE, which is what the pairing was built for.
 * Chain assembly (#35) draws `needed` from every machine's list, and three
 * sites downstream spend a machine id on a peer ledger: a scalar that is right
 * for the plan is wrong for a record the moment those two come apart, and the
 * failure mode is a silently mis-credited `received`/`sent` ledger — which is
 * `recordSentToPeer`'s own unreconstructable-thread invariant
 * (src/sync-state.ts), i.e. the defect #35 exists to fix, reintroduced by its
 * own fix. Asserted end to end on the sync-state FILE, in both resolution
 * branches, by "cross-machine chain assembly, end to end" in
 * tests/hub-pull-stages.test.ts; the two-machine invariance case beside it is
 * the measurement that the pairing changed nothing for the shape every hub had
 * before assembly.
 */
export interface SourcedBundle {
  /**
   * The machine whose index lists this bundle. NOT "the machine this pull
   * resolved to" — see `SelectStageResult.sourceMachineId`, which is that and
   * stays that.
   */
  machineId: string;
  record: HubBundleRecord;
}

export interface SelectStageResult {
  /**
   * NARROWED on purpose: the thread's id and the source machine's id, never the
   * `ResolvedThread`/`ThreadCopy` they came from. Handing back `copies` would
   * let a later stage re-derive the selection from it, and `copies` is the field
   * carrying an iteration-order ban.
   */
  threadId: string;
  /**
   * The machine this pull RESOLVED to — what drives the source label on the
   * result and the alternate-source warning above.
   *
   * Deliberately no longer the answer to "which peer supplied this record":
   * that is per record, on `needed`. Keeping one scalar for both meanings is
   * what mis-credits a ledger once a chain spans machines.
   */
  sourceMachineId: string;
  needed: SourcedBundle[];
  /** Read exactly once, at the caller's final `HubPullResult` assembly. */
  unfetchableBundles: UnfetchableBundleGroup[] | undefined;
}

/**
 * THE FOURTH EXIT: this pull worked out a thread's history, found something it
 * could not deliver, and correctly applied nothing.
 *
 * Under the pull's failure contract — truthfulness is the invariant,
 * completeness is best-effort — that is a SUCCESS. The `needed.length === 0`
 * branch below is the only other exit for an empty fetch plan and both of its
 * variants are `success: false`, which is the nag loop this milestone exists to
 * break, relocated one branch later: an error tells the caller to try again, and
 * every try says the same thing forever.
 *
 * WHY A FOURTH ARM RATHER THAN THE CHEAPER FIX — recorded because the next
 * reader will reach for the cheaper one. The alternative is to relax the gate:
 * keep three arms, let `proceed` carry an EMPTY `needed`, and put the findings
 * on `warnings`. It is not a type-level worry, it is a crash. `pull-record.ts`
 * indexes the plan unconditionally and then dereferences the result:
 *
 *   - `const last = needed[…]` evaluates to `needed[-1]` for an empty plan:
 *     every branch of that index expression is guarded on
 *     `lastAppliedIndex >= 0` or `divergenceAborted`, which start at `-1` and
 *     `false` (`pull-apply-state.ts`), so it falls through to
 *     `needed.length - 1`. `last` is `undefined`.
 *   - `stateAfter.peers[last.machineId]?.received?.[last.record.sessionIdInBundle]`
 *     then throws a TypeError, on every arrangement rather than some of them.
 *   - Both halves of that sentence moved with the per-record machine id, and
 *     the move was in this argument's favour. While the plan was a bare record
 *     list, the peer was a scalar and the entry was first dereferenced INSIDE
 *     the computed key — so it only threw when `peers[sourceMachineId].received`
 *     happened to exist for the optional chain to run through, which is the
 *     ordinary state for an empty plan (the plan is empty BECAUSE those receipts
 *     cover it) but not the only one. Now the entry is dereferenced to BUILD the
 *     key, and nothing short-circuits past it.
 *   - The design doc puts the throw one line earlier, at the dereference inside
 *     the `find` predicate. It cannot fire there for an empty plan: that
 *     predicate only runs when `lastBundleManifest` is non-null, and nothing
 *     sets it when the bundle loop never iterates. The crash is real, and it is
 *     the receipt lookup. `tests/hub-pull-stages.test.ts` pins it, so this
 *     stays measured.
 *
 * This arm is also what the module doc's own argument already points at: two of
 * the exits cannot be an `ErrorResult`, which is why this stage carries its own
 * union instead of `StageOutcome`/`stageAbort`. A third exit that is
 * `success: true` and has no `error` field for a synthesized
 * `reasons: [terminal.error]` to read is that same argument a third time.
 *
 * ITS PRODUCER IS THE EMPTY-PLAN BRANCH, since chain assembly landed: an
 * assembled plan is legitimately empty whenever every record the walk could
 * place is already here, and the walk still has something to say about the
 * records it could not place.
 */
export interface SelectReport {
  threadId: string;
  /** Still "the machine this pull resolved to", never "the machines it read". */
  sourceMachineId: string;
  /**
   * Why nothing was applied. Non-empty; the caller puts it on the result's
   * `nothingToApply`.
   */
  reason: string;
  /**
   * The typed disclosures, SPREAD verbatim into the result by the caller.
   *
   * It is the shared `HubPullFindings` rather than a list of fields restated
   * here so that a disclosure added to the result type arrives on this exit with
   * no edit at either end — the chain gaps and advertised-but-unshipped heads
   * assembly will report are additions to that one interface, not to this arm.
   */
  findings: HubPullFindings;
}

/**
 * `warnings` rides on `proceed` and on `report` — the two arms whose result the
 * caller assembles with a `warnings` field to put them in — and on neither
 * `stop` nor `pick-list`. That is the contract, not an oversight: today's code
 * pushes the unfetchable sentence before the "already up to date" gate and the
 * `stop` returns there carry no `warnings` field, so the text is discarded. The
 * caller reproduces that by dispatching on `stop` BEFORE spreading `warnings`,
 * and on `report` after.
 *
 * `pick-list` carries no warnings for the same reason in reverse — the caller
 * owns the list (it has the lock-steal warning and the resolve stage's reasons
 * in it already), so handing it in only to get it back would be a detour.
 */
export type SelectOutcome =
  | { kind: "proceed"; value: SelectStageResult; warnings: string[] }
  | { kind: "pick-list"; threads: WhereisThread[] }
  | { kind: "report"; value: SelectReport; warnings: string[] }
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
      backend, resolved, machineId, peekSyncState(effectiveProjectPath), targetProjectDir
    );
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
    target = resolved.find(
      (t) => pullSourceFor(t, peeked, { machineId, targetProjectDir }) !== undefined
    );
    if (!target) {
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
  const needed: SourcedBundle[] = plan.needed;
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
  let unfetchableBundles: UnfetchableBundleGroup[] | undefined;
  let unfetchableText: string | undefined;
  const machineName = createMachineNameLookup(backend);
  if (unfetchableSets.length > 0) {
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
  // What assembly worked out and could not deliver. `notes` name records this
  // pull is NOT fetching; `reportOnly` is the advertised-but-unshipped head,
  // which is not a fetch failure at all and belongs only on the exit that
  // applied nothing (see describeAssembly).
  const assembly = await describeAssembly(target.threadId, plan.assembled, {
    localMachineId: machineId,
    outstanding: new Set(plan.outstanding.map((s) => sourcedKey(s.machineId, s.record.bundleId))),
    machineName,
  });

  if (needed.length === 0) {
    // Every variant below returns without reaching the mapping block — see
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
    /**
     * THE FOURTH EXIT, and its only producer (see `SelectReport`).
     *
     * Assembly worked this thread's history out, found something it could not
     * deliver — a gap, a parked fork branch, a bundle pushed before chain
     * assembly existed, a machine advertising work it never uploaded — and
     * correctly applied nothing. Under the failure contract (§1.1) that is a
     * SUCCESS: truthfulness is the invariant, completeness is best-effort, and
     * answering it with `success: false` is the nag loop this milestone exists
     * to break, relocated one branch later.
     *
     * IT SITS BELOW THE UNFETCHABLE STOP, deliberately. That stop fires when
     * another machine still holds records this pull cannot reach, which is a
     * strictly more specific statement about the same thread — and it is the
     * shape `tests/hub-pull.test.ts` pins as `success: false`. Task 7 rewrites
     * `describeUnfetchable`'s prose (it forecloses a remedy that now partly
     * exists) and folds the two exits together; until then the more specific
     * disclosure keeps precedence and this arm covers everything it cannot see
     * — the source's own list, this machine's own copy, and heads, none of
     * which `findUnfetchableBundles` looks at.
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
            .filter((s): s is string => !!s)
            .join(" "),
          findings: unfetchableBundles ? { unfetchableBundles } : {},
        },
        warnings,
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
  // unpushed work is not something THIS pull failed at.
  warnings.push(...assembly.notes);

  const missing: string[] = [];
  for (const { record } of needed) {
    if (!(await backend.exists(record.file))) missing.push(record.file);
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
      unfetchableBundles,
    },
    warnings,
  };
}
