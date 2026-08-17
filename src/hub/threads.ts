import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SyncState } from "../types.js";
import type { HubBundleRecord, HubIndexJson } from "./layout.js";
// TYPE-ONLY, and it has to be: pull-select.ts imports this module for real, so
// a value import here would close a runtime cycle. `import type` is erased by
// tsc, so dist/hub/threads.js requires nothing from the stage. The pairing is
// defined there because that is where it is produced and consumed; defining a
// structurally identical second copy here is the duplication this repo keeps
// finding at the bottom of its own defects.
import type { SourcedBundle } from "./pull-select.js";

export interface ThreadCopy {
  machineId: string;
  localSessionId: string;
  slug: string;
  summary: string;
  headEntryUuid: string;
  messageCount: number;
  lastActiveAt: string;
  bundles: HubBundleRecord[];
}

export interface ResolvedThread {
  threadId: string;
  slug: string;
  summary: string;
  copies: ThreadCopy[];
  latest: ThreadCopy;
}

/**
 * Everything a `ThreadCopy` carries that `newerThreadCopy`'s named keys do NOT
 * compare, as one string — the last resort below, and the thing that makes it a
 * total order over CONTENT rather than over the input list.
 *
 * Built from an explicit tuple rather than `JSON.stringify(copy)` so it cannot
 * quietly start depending on which order an index file happened to write the
 * copy's own keys in. `bundles` is in it because that is the field a pull reads
 * off the winner (`planThreadPull` fetches from `source.bundles`); `slug` and
 * `summary` are in it because `ResolvedThread` republishes the winner's.
 * Together with the four keys compared before it, that is every field of
 * `ThreadCopy` — so two copies that tie all the way down here answer every
 * question a consumer asks identically, and returning either is the SAME
 * answer, not an arbitrary one.
 */
function threadCopyContentKey(c: ThreadCopy): string {
  return JSON.stringify([c.localSessionId, c.slug, c.summary, c.bundles]);
}

// Deterministic latest-copy ordering (spec §2): max lastActiveAt, then higher
// messageCount, then headEntryUuid lexical ascending. This tiebreak is
// load-bearing across the whole product ("which machine has my latest
// work") — it must produce the same answer regardless of machine/index
// iteration order, so every branch is a strict total order over the copy
// set, never insertion order.
export function newerThreadCopy(a: ThreadCopy, b: ThreadCopy): ThreadCopy {
  if (a.lastActiveAt !== b.lastActiveAt) return a.lastActiveAt > b.lastActiveAt ? a : b;
  if (a.messageCount !== b.messageCount) return a.messageCount > b.messageCount ? a : b;
  if (a.headEntryUuid !== b.headEntryUuid) return a.headEntryUuid < b.headEntryUuid ? a : b;
  // Total tie on the three named keys. Without a further key the answer was the
  // reduce ACCUMULATOR, i.e. whichever index file the hub directory listed
  // first — exactly the insertion-order dependence the comment above forbids,
  // and it is reachable from the ordinary round trip (A pushes, B continues, A
  // pulls the continuation back and splices it: both copies then carry the same
  // lastActiveAt, messageCount and head). The two copies list DIFFERENT
  // bundles, so this decides what a third machine's pull actually fetches.
  // machineId is arbitrary as a preference and that is fine — it is stable,
  // which is the property being bought here.
  if (a.machineId !== b.machineId) return a.machineId < b.machineId ? a : b;
  // ...and machineId alone was not enough, one layer down. Two copies of one
  // thread could carry the SAME machineId: `resolveThreads` stamps them with the
  // id an index file DECLARES (see below), while `readAllIndexes` dedupes on the
  // id derived from the file's NAME, so two differently-named index files that
  // both declared `"X"` landed here as two copies with every key equal — and the
  // reduce fell through to `readdirSync` order again. Measured against shipped
  // `dist/`: a forward listing resolved to one file's bundle list and the
  // reversed listing to the other's, deciding what `pullSourceFor` returns and
  // therefore what a pull fetches. Needed a damaged or hostile index (our own
  // writers always agree: `buildIndexFile` stamps `inputs.machineId` and
  // `writeMachineIndex` derives the path from `index.machineId`), which is why
  // this is the last key and not the first.
  //
  // #28 CLOSED THE INPUT, AND THIS KEY STAYS. `readMachineIndex` now skips (and
  // warns about) any index file whose declared `machineId` disagrees with its
  // filename, so a real hub read can no longer produce two copies sharing an id
  // — the two keys below are unobservable through `readAllIndexes` today. Kept
  // and annotated rather than deleted, the same call as the source-half NEVER
  // guard in `findUnfetchableBundles`: `resolveThreads` is exported and takes
  // any `HubIndexJson[]`, and "the answer is a total order over CONTENT" should
  // be a property of THIS function rather than of whichever reader fed it.
  const ka = threadCopyContentKey(a);
  const kb = threadCopyContentKey(b);
  return ka <= kb ? a : b;
}

export function resolveThreads(indexes: HubIndexJson[]): ResolvedThread[] {
  const byThread = new Map<string, ThreadCopy[]>();
  for (const index of indexes) {
    for (const [threadId, entry] of Object.entries(index.threads)) {
      // Spread FIRST, then the index-level id — never the other way round.
      // A thread ENTRY is peer-authored data; with the id first, an entry
      // carrying its own `machineId` key overrides the index's, and that id
      // selects `state.peers[...]` and feeds `alternateSource`, i.e. it decides
      // which machine a pull fetches from. One id per index file is the fact
      // every consumer here relies on; a per-entry override is not a fact at
      // all.
      //
      // WHERE `index.machineId` COMES FROM, and it is the file's CONTENT, not
      // its name. `readMachineIndex` uses its `machineId` ARGUMENT only to
      // build the path it reads and to label warnings; the `machineId` it
      // returns is whatever the file declared.
      //
      // #28 MADE THE TWO AGREE, AT THE READ RATHER THAN HERE. `readMachineIndex`
      // now skips (and warns about) any index whose declared `machineId`
      // disagrees with the filename it was read from — the filename wins,
      // because it is what every hub path is built from and the only one of the
      // two that has passed `assertSafeHubId`. So for every index that arrived
      // through `readAllIndexes` (the only production door), `ThreadCopy.machineId`
      // IS the filename-derived, path-safe id.
      //
      // That is the READER's guarantee, not this function's, and the difference
      // is why the downstream guards stay: `resolveThreads` is exported and
      // takes any `HubIndexJson[]`, so a caller that hand-builds one can still
      // hand it an unsafe or duplicated id. `whereis.ts` keeps its try/catch
      // around `machinePath(id)` (it must anyway — `machines/<id>.json` is
      // routinely absent), and `findUnfetchableBundles` below keeps keying by
      // machineId. Anything NEW that builds a hub path out of a
      // `ThreadCopy.machineId` should still validate it at that point.
      const copy: ThreadCopy = { ...entry, machineId: index.machineId };
      const list = byThread.get(threadId) ?? [];
      list.push(copy);
      byThread.set(threadId, list);
    }
  }
  const resolved: ResolvedThread[] = [];
  for (const [threadId, copies] of byThread) {
    const latest = copies.reduce(newerThreadCopy);
    resolved.push({ threadId, slug: latest.slug, summary: latest.summary, copies, latest });
  }
  // Same invariant as `newerThreadCopy` above, one level up: never depend on
  // iteration order. The obvious `a < b ? 1 : -1` is an INCONSISTENT comparator — it
  // returns -1 for equal values, so two equal-timestamped threads swap and
  // fourteen come back fully reversed when the input order reverses. Both
  // consumers pick positionally (`pull --latest` takes the first non-current
  // thread, the SessionStart notice takes the most recent stale one), so an
  // arbitrary winner among ties is a user-visible arbitrary answer.
  resolved.sort((a, b) => {
    if (a.latest.lastActiveAt !== b.latest.lastActiveAt) {
      return a.latest.lastActiveAt < b.latest.lastActiveAt ? 1 : -1;
    }
    return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
  });
  return resolved;
}

/**
 * THE LINK RULE, in one place: `""` is never a link, on either side.
 *
 * Both a bundle's `headEntryUuid` and the `anchorEntryUuid` that names it can
 * legitimately be `""` — `readLastEntryUuid(...) ?? ""` is how both index
 * writers spell a head, and it returns `null` when the bounded tail scan finds
 * no conversation entry (a bundle boundary landing on a run of uuid-less
 * bookkeeping lines). Two empty strings are not a match: treating them as one
 * would silently join two unrelated bundles, and a head-keyed map that admitted
 * `""` as a key would let two empty-headed records collide so that one vanishes
 * from the chain entirely.
 *
 * Used by `findUnfetchableBundles`'s recorded-head comparison and by
 * `assembleChain`'s walk, deliberately as ONE function rather than two inline
 * spellings of the same sentence.
 */
function isLinkUuid(uuid: string | null | undefined): uuid is string {
  return typeof uuid === "string" && uuid !== "";
}

/** One machine's bundles for a thread that a given pull cannot fetch. */
export interface UnfetchableBundleSet {
  machineId: string;
  /** Bundle ids, in the order that machine's index lists them. */
  bundleIds: string[];
}

/**
 * Bundles that OTHER machines list for this thread and that the RESOLVED
 * machine's own list does not offer.
 *
 * WHAT IT USED TO DISCLOSE, AND WHAT IT NOW OVER-REPORTS. A pull used to fetch
 * exactly ONE machine's bundle list, and every machine's index lists only the
 * bundles IT pushed — a pull writes its own index with `newBundles: []` — so a
 * thread whose history was written on two other machines arrived on a third in
 * halves, and this was the only signal that said so. Chain assembly (#35)
 * fetches across every machine's list, so most of what this function returns is
 * now fetched: **both** callers subtract `planThreadPull`'s plan from it before
 * showing anything (`pull-select.ts`, `whereis.ts`), which is spec §6's
 * `assemblySet ⊆ heuristicSet` in the one direction it holds. What survives the
 * subtraction is genuinely out of reach — a bundle behind a gap, on a parked
 * branch, or pushed before links were recorded at all.
 *
 * It is kept for one release as the cross-check against the assembled path
 * (§6), then removed. Do not add a third caller that reads it unsubtracted.
 *
 * IT IS A DIAGNOSTIC, NOT AN ORDERING, and deliberately stays away from the
 * two things this milestone has already been burned by:
 * - it reads NO timestamp. `pushedAt` is the PUSHING machine's wall clock and
 *   the hub stamps nothing; ordering two machines' records by it reinstated a
 *   silent data revert verbatim under a 1h skew (Task 8).
 * - it never merges another machine's bundle records into the source's list.
 *   That list being one machine's own pushes, in push order, is what Task 8's
 *   `basedOn` chain walk relies on.
 * Nothing it returns changes what is fetched, applied, recorded or ordered.
 *
 * SILENCE ON THE ORDINARY FLOW IS THE LOAD-BEARING PROPERTY — a warning that
 * fires on every pull trains users to ignore it. Two structural exclusions buy
 * most of it: the source's copy and this machine's copy are both skipped, so
 * with only two machines in play the candidate set is EMPTY before any content
 * test runs, and a third machine that has pulled the thread but never pushed
 * contributes an empty bundle list. What remains is filtered against this
 * machine's peer bookkeeping (`state.peers[...]`, the same records
 * `selectNeededBundles` dedups on):
 * - the position of the newest record whose `headEntryUuid` is the head we
 *   recorded holding from that machine says how far along its own list we
 *   already got; everything at or before it is accounted for.
 * - when no recorded head matches any of its records (a "" head, a session
 *   that arrived some other way), it falls back to "we received something from
 *   that machine for that session" — coarse, and coarse in the SILENT
 *   direction on purpose.
 */
export function findUnfetchableBundles(args: {
  copies: ThreadCopy[];
  sourceMachineId: string;
  localMachineId: string;
  state: SyncState;
}): UnfetchableBundleSet[] {
  const { copies, sourceMachineId, localMachineId, state } = args;

  // Everything the chosen source offers, by id — a bundle listed by two
  // machines is fetchable if the source is one of them.
  const offered = new Set<string>();
  for (const c of copies) {
    if (c.machineId !== sourceMachineId) continue;
    for (const b of c.bundles) offered.add(b.bundleId);
  }

  // Keyed by machineId rather than per copy. THE ORIGINAL REASON IS GONE and
  // the keying is not: it was built because `readMachineIndex` validated only
  // the id derived from an index file's NAME, so two index files could declare
  // the same internal machineId and both land here as separate copies. #28
  // closed that at the read (the filename wins; a disagreeing file is skipped
  // and warned about), so through `readAllIndexes` each machine now contributes
  // exactly one copy per thread. What the keying still buys is that this
  // function's OUTPUT SHAPE — one row per machine, and `state.peers[...]` read
  // once per machine rather than once per copy — is a property of the function
  // rather than of its caller's reader, for a `copies` list built any other way.
  const byMachine = new Map<string, string[]>();
  for (const c of copies) {
    // The source half of this test is UNOBSERVABLE today and kept anyway,
    // annotated rather than deleted (same call as the pattern-side NEVER guard
    // in workspace.ts): `offered` is built from exactly these copies, so the
    // per-record filter below already drops every one of them, and removing
    // this clause reddens nothing. It stays because it is what makes "with two
    // machines the candidate set is empty" true of THIS loop rather than of a
    // downstream filter — the property the whole disclosure rests on should
    // not depend on how `offered` is populated later.
    if (c.machineId === sourceMachineId || c.machineId === localMachineId) continue;
    const peer = state.peers[c.machineId];

    let consumedThrough = -1;
    for (let i = 0; i < c.bundles.length; i++) {
      const r = c.bundles[i];
      const rec = peer?.received?.[r.sessionIdInBundle];
      const heldHead = rec ? peer?.sent[rec.localSessionId]?.headEntryUuid : undefined;
      // Both sides can legitimately be "" (a bundle boundary landing on a
      // uuid-less bookkeeping line), and two empty strings are not a match —
      // `isLinkUuid` is that rule, shared with the assembly walk.
      if (isLinkUuid(heldHead) && isLinkUuid(r.headEntryUuid) && heldHead === r.headEntryUuid) {
        consumedThrough = i;
      }
    }

    const ids = byMachine.get(c.machineId) ?? [];
    const seen = new Set<string>(ids);
    for (let i = 0; i < c.bundles.length; i++) {
      const r = c.bundles[i];
      if (offered.has(r.bundleId) || seen.has(r.bundleId)) continue;
      const accounted =
        consumedThrough >= 0 ? i <= consumedThrough : !!peer?.received?.[r.sessionIdInBundle];
      if (accounted) continue;
      seen.add(r.bundleId);
      ids.push(r.bundleId);
    }
    if (ids.length > 0) byMachine.set(c.machineId, ids);
  }

  // Stated order, never map insertion order — the same rule the tiebreaks
  // above follow, for the same reason: this text reaches a user.
  return [...byMachine.entries()]
    .map(([machineId, bundleIds]) => ({ machineId, bundleIds }))
    .sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
}

/**
 * THE PER-RECORD HALF of `selectNeededBundles`, and the half that survives
 * chain assembly (#35).
 *
 * `selectNeededBundles` does two separable things: it takes the "last full
 * bundle onward" slice of ONE machine's list, and it drops each record whose
 * content is already here. The slice is array-position logic over one machine's
 * push order and has no cross-machine analogue — that is what `assembleChain`
 * supersedes. This test does not change at all: it is per record, it reads the
 * ledger of the machine that supplied the record, and it mirrors the importer's
 * own dedup verification (a registry/peer record can outlive the file it points
 * at, e.g. after a migrate deleted it, so "already received" is only trusted
 * while the file is still there).
 */
function isRecordAlreadyHere(
  record: HubBundleRecord,
  received: Record<string, { localSessionId: string }> | undefined,
  localSessionFileExists: (localSessionId: string) => boolean
): boolean {
  const prior = received?.[record.sessionIdInBundle];
  return !!(prior && localSessionFileExists(prior.localSessionId));
}

export function selectNeededBundles(
  bundles: HubBundleRecord[],
  received: Record<string, { localSessionId: string }> | undefined,
  localSessionFileExists: (localSessionId: string) => boolean
): HubBundleRecord[] {
  let lastFull = -1;
  for (let i = 0; i < bundles.length; i++) if (bundles[i].type === "full") lastFull = i;
  const chain = lastFull >= 0 ? bundles.slice(lastFull) : bundles.slice();
  return chain.filter((r) => !isRecordAlreadyHere(r, received, localSessionFileExists));
}

/**
 * Identity of a record within a pull plan: two machines may list one bundle id,
 * so a bare bundle id is not an identity.
 *
 * Exported because BOTH disclosure sites subtract a plan from the
 * `findUnfetchableBundles` heuristic — `pull`'s select stage and `whereis` —
 * and two hand-written key spellings that drift apart is how one of them comes
 * to report a bundle the other fetches.
 */
export function sourcedKey(machineId: string, bundleId: string): string {
  return `${machineId} ${bundleId}`;
}

/**
 * "This machine already holds what that record carries", per record — the
 * receipt filter of `selectNeededBundles` applied to a SOURCED record rather
 * than to a position in one machine's list.
 *
 * TWO RULES, and the second is the one a plain filter would miss. Each record is
 * checked against `peers[<the machine that listed it>].received`, never against
 * one scalar's ledger; and this machine's OWN records are "here" by
 * construction rather than checked. A machine has no `received` entry for a
 * bundle it PUSHED, so checking ours the same way would call every one of our
 * own pushes needed and start re-fetching them — which is exactly what
 * `pullSourceFor`'s local-machine branch and `alternateSource`'s
 * `c.machineId !== ctx.machineId` filter have always prevented, expressed once
 * here now that a plan may contain our own records (it must: dropping them from
 * the WALK would strand every successor that chains onto one).
 */
function sourcedRecordIsHere(
  s: SourcedBundle,
  st: SyncState,
  ctx: { machineId: string; targetProjectDir: string }
): boolean {
  if (s.machineId === ctx.machineId) return true;
  return isRecordAlreadyHere(s.record, st.peers[s.machineId]?.received, (id) =>
    existsSync(join(ctx.targetProjectDir, `${id}.jsonl`))
  );
}

/** One thread's assembled view plus the ordered plan a pull of it would fetch. */
export interface ThreadPullPlan {
  /** Every machine's records for the thread, ordered by links — see `assembleChain`. */
  assembled: AssembledChain;
  /**
   * The ordered fetch plan, receipts already applied. Empty means a pull of this
   * thread would fetch nothing.
   */
  needed: SourcedBundle[];
  /**
   * False when the assembled chain does NOT contain everything the source
   * machine's own list offers, in which case `needed` fell back to that list.
   *
   * THE FALLBACK IS BACK-COMPAT, not a hedge. Every bundle already sitting on
   * every hub predates `anchorEntryUuid` and is therefore unlinkable by
   * construction (spec §0b): assembly reduces such a thread to its root and
   * nothing else. Narrowing a pull to the assembled chain alone would make this
   * release stop fetching continuations it fetches today — a silent regression
   * for exactly the users who have been on the hub longest. So assembly may
   * WIDEN a plan and may reorder it; it may never shrink it below the one
   * machine's list a pull already reads.
   */
  assembledCoversSource: boolean;
  /**
   * Every record any machine lists for this thread that this machine neither
   * already holds nor is about to fetch — what the pull is leaving where it is.
   *
   * The disclosure layer's input, and the reason it is computed HERE rather
   * than restated at the call site: "already holds" is the receipt rule, and a
   * second hand-written copy of that rule is how a disclosure comes to name a
   * bundle the user received months ago.
   */
  outstanding: SourcedBundle[];
}

/**
 * The plan a pull of one thread would fetch from a named source copy.
 *
 * Ordering comes from `assembleChain` — links only, never `pushedAt` — and the
 * plan may span machines, which is the whole of #35. What it never does is
 * write back: `assembled.chain` is a separate structure and no machine's stored
 * `bundles` array is touched (§4.4.2), because that list being one machine's own
 * pushes in push order is what the `basedOn` merge-ancestor walk relies on.
 */
export function planThreadPull(args: {
  thread: ResolvedThread;
  /** The copy this pull RESOLVED to — the fallback's list, and nothing else. */
  source: ThreadCopy;
  state: SyncState;
  machineId: string;
  targetProjectDir: string;
}): ThreadPullPlan {
  const { thread, source, state, machineId, targetProjectDir } = args;
  const ctx = { machineId, targetProjectDir };
  const exists = (id: string): boolean => existsSync(join(targetProjectDir, `${id}.jsonl`));

  const assembled = assembleChain({
    copies: thread.copies,
    localHeadEntryUuid: thread.copies.find((c) => c.machineId === machineId)?.headEntryUuid,
  });
  const inChain = new Set(
    assembled.chain.map((s) => sourcedKey(s.machineId, s.record.bundleId))
  );
  const sourceOnly = selectNeededBundles(
    source.bundles,
    state.peers[source.machineId]?.received,
    exists
  );
  const assembledCoversSource = sourceOnly.every((r) =>
    inChain.has(sourcedKey(source.machineId, r.bundleId))
  );
  const needed = assembledCoversSource
    ? assembled.chain.filter((s) => !sourcedRecordIsHere(s, state, ctx))
    : sourceOnly.map((record) => ({ machineId: source.machineId, record }));

  const fetching = new Set(needed.map((s) => sourcedKey(s.machineId, s.record.bundleId)));
  const outstanding: SourcedBundle[] = [];
  for (const copy of thread.copies) {
    for (const record of copy.bundles) {
      const s: SourcedBundle = { machineId: copy.machineId, record };
      if (fetching.has(sourcedKey(copy.machineId, record.bundleId))) continue;
      if (sourcedRecordIsHere(s, state, ctx)) continue;
      outstanding.push(s);
    }
  }
  return { assembled, assembledCoversSource, needed, outstanding };
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
 * already local", or a bare "nothing to pull") drops the answer the user
 * just gave for a bundle that is still sitting on the hub, unreceived.
 *
 * It only ever fires when `t.latest` is THIS machine, so it cannot change which
 * copy an ordinary pull resolves to, and it never merges two machines' bundle
 * records into one list (that linearity is what the `basedOn` chain walk rests
 * on).
 *
 * #35 WIDENED THE CANDIDATE TEST, not the rule. A copy qualifies when its own
 * list still offers something unreceived (#44's test, kept verbatim so a
 * pre-assembly hub behaves exactly as it does today) OR when the assembled
 * chain reaches an unreceived record of that machine's — the case where the
 * thread's history only becomes fetchable once the links are followed. `OR`
 * rather than a replacement: dropping the first clause would stop this branch
 * finding a machine whose bundles predate `anchorEntryUuid`.
 *
 * `newerThreadCopy` for the preference so the choice is a strict total order over the
 * candidate set rather than index-file iteration order.
 */
export function alternateSource(
  t: ResolvedThread,
  st: SyncState,
  ctx: { machineId: string; targetProjectDir: string }
): ThreadCopy | undefined {
  const assembled = assembleChain({
    copies: t.copies,
    localHeadEntryUuid: t.copies.find((c) => c.machineId === ctx.machineId)?.headEntryUuid,
  });
  const viaChain = new Set(
    assembled.chain.filter((s) => !sourcedRecordIsHere(s, st, ctx)).map((s) => s.machineId)
  );
  const candidates = t.copies.filter(
    (c) =>
      c.machineId !== ctx.machineId &&
      (viaChain.has(c.machineId) ||
        selectNeededBundles(c.bundles, st.peers[c.machineId]?.received, (id) =>
          existsSync(join(ctx.targetProjectDir, `${id}.jsonl`))
        ).length > 0)
  );
  return candidates.length === 0 ? undefined : candidates.reduce(newerThreadCopy);
}

/**
 * The copy a pull of this thread would fetch from, or `undefined` when a pull
 * would fetch nothing — the ONE question every selector asks (#44).
 *
 * `--latest` used to ask a different one: head equality against the resolved
 * latest copy. The two answer differently whenever a thread is head-current
 * with the machine it resolves to while that machine still lists a bundle this
 * machine never received, and there `--latest` said "all threads are current"
 * for a thread `--thread <id>` fetched from the same hub state. Receipts are
 * the honest half of that pair: a head can arrive by a route that recorded no
 * bundle, and `selectNeededBundles` already trusts a receipt only while the
 * local file it points at still exists.
 *
 * THE LOCAL-MACHINE BRANCH IS LOAD-BEARING, not tidiness. Re-gating
 * unconditionally would run the receipt filter over THIS machine's own bundle
 * list, where a missing receipt is ordinary — a `--target-path` pull keys its
 * bookkeeping off the other path, and a corrupt state file is renamed aside and
 * starts empty — so `--latest` would start re-fetching this machine's own
 * pushes. `alternateSource` is the answer for that case and already excludes
 * our own copy by construction; `selectNeededFromChain` drops our own records
 * for the same reason, one level down.
 *
 * #35 CLOSED THE OTHER HALF, and it did so by changing this function's body
 * rather than by adding a fifth selector. The question is now "is the ASSEMBLED
 * chain fully received here?" instead of "is the resolved machine's own list
 * fully received here?", so a thread whose remaining bundles are listed by a
 * machine this pull does not resolve to answers `true` — and both `pull`
 * selectors and `whereis`'s `pullNeeded` follow automatically, because all
 * three call this. That was #44's stated scope note and this is it coming off.
 */
export function pullSourceFor(
  t: ResolvedThread,
  st: SyncState,
  ctx: { machineId: string; targetProjectDir: string }
): ThreadCopy | undefined {
  const source =
    t.latest.machineId === ctx.machineId ? alternateSource(t, st, ctx) : t.latest;
  if (!source) return undefined;
  const plan = planThreadPull({
    thread: t,
    source,
    state: st,
    machineId: ctx.machineId,
    targetProjectDir: ctx.targetProjectDir,
  });
  return plan.needed.length > 0 ? source : undefined;
}

// ---- Chain assembly (#35) -------------------------------------------------

/** Why the walk stopped where it did. Four different facts, never merged. */
export type ChainStop =
  /** Nothing anchors on the last record's head: whole, as far as the hub shows. */
  | "end"
  /** That head is `""`, so no successor can ever be matched to it (§4.3). */
  | "empty-head"
  /** The next record was already in this chain — a damaged or hostile index. */
  | "cycle"
  /** No record could start a chain at all, so there is nothing to walk. */
  | "no-root";

/** How a branch or a root was picked when more than one was available. */
export type ChainChoice =
  /** Only one candidate existed. */
  | "sole"
  /** Exactly one candidate reaches the head this machine's own copy sits at. */
  | "local-base"
  /** No local base to go on, so the candidate reaching the most bundles won. */
  | "longest"
  /** Even that tied; broken on bundle id ascending — arbitrary, but stable. */
  | "bundle-id"
  /** Nothing to choose between: there were no candidates. */
  | "none";

/** A record whose anchor names a head no record in this thread ships. */
export interface ChainGap {
  /**
   * The anchor that matched nothing. `""` is one of them: it can never match,
   * by the empty-head rule, so a record carrying it is stranded exactly as if
   * its predecessor were missing (no writer of ours emits it — see
   * `HubBundleRecord.anchorEntryUuid`).
   */
  anchorEntryUuid: string;
  /** The machine listing the stranded record, and the record itself. */
  machineId: string;
  bundleId: string;
  /**
   * That record plus everything that chains onto it — what this one gap
   * strands. Its length is the "N later bundles unreachable" count.
   */
  strandedBundleIds: string[];
}

/** A branch not taken at a fork, with everything behind it. */
export interface ChainBranch {
  machineId: string;
  bundleId: string;
  /** The branch's first record and every record reachable from it. */
  bundleIds: string[];
}

/** Two or more records claiming to continue one head. */
export interface ChainFork {
  /** The head they share. Never `""` — that is a gap, not a fork. */
  anchorEntryUuid: string;
  /** The branch this plan follows, by its first bundle id. */
  followedBundleId: string;
  /** Why that one. Never `"sole"`/`"none"`: a fork has at least two branches. */
  reason: ChainChoice;
  /** Every branch this plan parked, stated order (bundle id ascending). */
  parked: ChainBranch[];
}

/** A record that starts a chain. Several per thread is ORDINARY — see below. */
export interface ChainRoot {
  machineId: string;
  bundleId: string;
  /**
   * Everything reachable from this root, this record included, bundle id
   * ascending. For a root whose chain forks this covers BOTH branches, so it is
   * "what this starting point could reach", not "what the plan applies".
   */
  bundleIds: string[];
  /** True for the one root `chain` starts at. */
  followed: boolean;
  /**
   * A record carrying no `anchorEntryUuid` key at all: pushed before chain
   * assembly existed. Still a root — `type` is what says so — but nothing can
   * ever be proven to chain onto it, so its chain ends where its head does.
   */
  preAssembly: boolean;
}

/**
 * A CONTINUATION naming no anchor at all, and so unlinkable by construction.
 *
 * Deliberately not a `ChainGap`. "This bundle was pushed before chain assembly
 * existed" and "a bundle is missing" are different sentences, and only one of
 * them describes something that could be repaired by finding it (spec §0b).
 *
 * Deliberately not a root either. A `continuation` is a delta; starting a chain
 * at one hands the plan a transcript that begins mid-conversation, which
 * `tryAppendContinuation`'s chain guard would refuse anyway.
 */
export interface UnanchoredBundle {
  machineId: string;
  bundleId: string;
  /**
   * `true` for the ordinary case — no `anchorEntryUuid` key, i.e. pushed before
   * chain assembly existed. `false` means the index declares an explicit `null`
   * anchor on a `continuation`, which is a contradiction no writer of ours can
   * emit and which is therefore a damaged or hostile index, not old data.
   */
  preAssembly: boolean;
}

/** A machine whose advertised thread head matches no bundle anyone pushed. */
export interface AdvertisedHead {
  machineId: string;
  headEntryUuid: string;
}

export interface AssembleChainInput {
  /** Every machine's copy of ONE thread, exactly as `resolveThreads` built it. */
  copies: ThreadCopy[];
  /**
   * The head of this machine's own copy of the thread, when it holds one — the
   * only input that can decide a fork or pick among roots by something other
   * than size. `""`/`null`/absent all mean "no local base to go on" (the empty
   * head rule applies here too: an empty local head matches nothing).
   */
  localHeadEntryUuid?: string | null;
}

/** An ordered fetch plan for one thread, plus everything it could not reach. */
export interface AssembledChain {
  /**
   * The plan: root first, each record chaining onto the one before it. Ordered
   * by LINKS alone — never by `pushedAt`, which is the pushing machine's wall
   * clock (§4.4.1) — and it may span machines, which is the whole point.
   *
   * Empty only when no record could start a chain (`stoppedBecause: "no-root"`).
   * Everything else about this result describes what is NOT in here.
   */
  chain: SourcedBundle[];
  stoppedBecause: ChainStop;
  /** How the root `chain` starts at was picked out of `roots`. */
  rootChoice: ChainChoice;
  /**
   * Every starting point this thread has, bundle id ascending. More than one is
   * ORDINARY, not an anomaly: `computeIncrementalPlan` re-sends a session whole
   * whenever the recorded head is empty or has gone (compaction, truncation, a
   * rollback), and `push.ts` files that `full` record under the SAME thread id.
   * Each root's chain is its own linked list and the two are never merged.
   */
  roots: ChainRoot[];
  /** Forks met while walking the followed chain, in the order they were met. */
  forks: ChainFork[];
  /** Anchors naming a head nobody ships, bundle id ascending. */
  gaps: ChainGap[];
  /** Pre-assembly continuations, bundle id ascending. */
  unanchored: UnanchoredBundle[];
  /**
   * Machines advertising a thread head no bundle record ships — "M advertises
   * work it has not pushed", which is a machine's local state running ahead of
   * what it uploaded, not a bundle missing from the hub. Tested against EVERY
   * record, not just the followed chain: a head on a parked branch was pushed.
   * A machine advertising `""` advertises nothing and is never listed.
   */
  advertisedUnshipped: AdvertisedHead[];
  /**
   * Every record NOT in `chain`, by bundle id, deduped and ascending — the
   * union of everything the disclosures above name, in one list. Membership is
   * by record, not by id, so a bundle id two machines both list still appears
   * here if either machine's record was not applied.
   */
  unreachableBundleIds: string[];
}

/** Internal walk node: a sourced record plus its two link fields, read once. */
interface ChainNode {
  sourced: SourcedBundle;
  /** Identity, because two machines may list the same bundle id. */
  at: number;
  /**
   * Three-valued, read once: absent (pre-assembly, anchor unknown), `null` (no
   * anchor exists), or a string (the predecessor's head — `""` included, which
   * is a string that can never match).
   */
  anchor: string | null | undefined;
  head: string;
}

function byBundleThenMachine(a: ChainNode, b: ChainNode): number {
  const ai = a.sourced.record.bundleId;
  const bi = b.sourced.record.bundleId;
  if (ai !== bi) return ai < bi ? -1 : 1;
  if (a.sourced.machineId !== b.sourced.machineId) {
    return a.sourced.machineId < b.sourced.machineId ? -1 : 1;
  }
  return a.at - b.at;
}

function ascending(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Read the three-valued anchor off a record.
 *
 * `in` rather than `?? null`, because absent and `null` are two different
 * facts: `null` is "no anchor exists, this is a full bundle", absent is "this
 * bundle predates chain assembly and its anchor is unrecoverable". The walk
 * treats them alike (neither links), so what a collapse would destroy is the
 * REPORT: every `preAssembly` flag on a root and on an unanchored record turns
 * into a claim that the index is damaged, when in fact it is merely old — the
 * one distinction spec §0b exists to preserve. Reading the value out (rather
 * than stopping at the `in` test) also folds an explicit `{anchorEntryUuid:
 * undefined}` — which a hand-built record can carry and JSON cannot — into the
 * absent case, which is the same fact.
 */
function anchorOf(record: HubBundleRecord): string | null | undefined {
  return "anchorEntryUuid" in record ? record.anchorEntryUuid : undefined;
}

/**
 * Order every bundle every machine lists for one thread into a fetch plan, and
 * name everything that could not be reached (#35, spec §4.3).
 *
 * PURE: no filesystem, no backend, no sync-state, and NO CLOCK. Ordering comes
 * from the link structure alone. `pushedAt` is read nowhere in this function —
 * the hub stamps nothing, so it is the pushing machine's wall clock, and
 * ordering two machines' records by it reinstated a measured silent revert
 * under skew (§4.4.1). The fixtures make `pushedAt` DESCEND in link order so
 * that an implementation which sorts by it fails rather than passing by luck.
 *
 * IT LINKS ON `anchorEntryUuid`, NEVER ON `fromEntryUuid`. Measured: `diff.ts`
 * writes `fromEntryUuid` as `entries[headIndex + 1].uuid`, the first entry the
 * delta SHIPS — the anchor's child, which equals no record's head, ever. A
 * head-keyed map walked over `fromEntryUuid` finds zero links on any real hub;
 * that is the whole of spec §0b and the reason the anchor field exists.
 * `fromEntryUuid` is not read here at all.
 *
 * THE OUTPUT IS A SEPARATE STRUCTURE and stays one (§4.4.2): nothing here
 * writes back into any `ThreadCopy.bundles`, because a machine's stored bundle
 * list being its OWN pushes in push order is what the `basedOn` merge-ancestor
 * walk relies on.
 *
 * THAT BAN IS NECESSARY AND WAS NOT SUFFICIENT. The `chain` this returns is
 * itself a cross-machine, link-ordered list, and `hub/pull.ts` walks it — so the
 * ancestor walk sees several machines' `basedOn` claims interleaved whether or
 * not any stored list was mutated. It reads them per machine
 * (`ChainWorkspaceBase`); before it did, an earlier bundle's base from one
 * machine was used as the merge ancestor for a later bundle's payload from
 * another, and the local tree was silently overwritten. Anything else that
 * consumes this chain and assumes one machine's monotonic history needs the
 * same treatment.
 *
 * WHAT IT DOES NOT DO. It does not know what this machine has already received
 * — `selectNeededBundles` is still the per-record receipt filter and runs over
 * this plan. It does not resolve hub-vs-LOCAL divergence either: that is
 * `hub.onDivergence`, it is per bundle, it is evaluated in the apply stage
 * against a local transcript this function cannot see, and it is not an input
 * here. Branch-vs-branch (below) is a different question with the same shape,
 * which is exactly why the two must not be confused.
 */
export function assembleChain(input: AssembleChainInput): AssembledChain {
  const { copies, localHeadEntryUuid } = input;

  const nodes: ChainNode[] = [];
  for (const copy of copies) {
    for (const record of copy.bundles) {
      nodes.push({
        sourced: { machineId: copy.machineId, record },
        at: nodes.length,
        anchor: anchorOf(record),
        head: record.headEntryUuid,
      });
    }
  }

  // A SET of heads, not a map: two records may legitimately ship the same head
  // (the same session pushed twice, a damaged index), and a head->record map
  // would silently drop one of them. Nothing here needs to go from a head back
  // to its record — the walk goes forward, from a head to the records that
  // anchor ON it.
  const shippedHeads = new Set<string>();
  for (const n of nodes) if (isLinkUuid(n.head)) shippedHeads.add(n.head);

  const successors = new Map<string, ChainNode[]>();
  for (const n of nodes) {
    if (!isLinkUuid(n.anchor)) continue; // `""` and a missing anchor link nothing
    successors.set(n.anchor, [...(successors.get(n.anchor) ?? []), n]);
  }
  // Stated order, never index-file iteration order: this decides which branch a
  // fork tie picks, and that reaches a user.
  for (const list of successors.values()) list.sort(byBundleThenMachine);

  const reachFrom = (start: ChainNode): ChainNode[] => {
    const seen = new Set<number>([start.at]);
    const out = [start];
    for (let i = 0; i < out.length; i++) {
      const cur = out[i];
      if (!isLinkUuid(cur.head)) continue;
      for (const next of successors.get(cur.head) ?? []) {
        if (seen.has(next.at)) continue;
        seen.add(next.at);
        out.push(next);
      }
    }
    return out;
  };

  // A root is a record that names no anchor AND is a full bundle. `type` is the
  // deciding half and the reason is spec §0b's correction: a pre-assembly FULL
  // record has no `anchorEntryUuid` key either, so absence alone cannot tell a
  // starting point from an orphan. Both spellings of "no anchor" are admitted
  // (`null` = none exists, absent = unknown) because for a full bundle they say
  // the same thing; a CONTINUATION spelling either is not promoted, since
  // starting a chain at a delta hands the plan a transcript that begins
  // mid-conversation.
  const rootNodes = nodes
    .filter((n) => n.anchor == null && n.sourced.record.type === "full")
    .sort(byBundleThenMachine);

  const localHead = isLinkUuid(localHeadEntryUuid) ? localHeadEntryUuid : null;
  const sitsOnLocalBase = (candidate: ChainNode): boolean =>
    localHead !== null && reachFrom(candidate).some((n) => n.head === localHead);

  /**
   * Pick one of several candidates, and say why.
   *
   * Preference order, and the order is the spec's: the branch this machine's
   * own copy already sits on (so the pull continues the transcript it has),
   * then the branch that reaches the most bundles, then bundle id ascending.
   * "Longest", never "newest" — any notion of newest here would have to come
   * from `pushedAt`. The candidate list arrives bundle-id ascending, so the
   * final tiebreak is `[0]`: arbitrary as a preference and stable, which is the
   * property being bought (the same one `newerThreadCopy`'s last key buys).
   */
  const choose = (candidates: ChainNode[]): { node: ChainNode; reason: ChainChoice } => {
    if (candidates.length === 0) throw new Error("assembleChain: no candidate to choose");
    if (candidates.length === 1) return { node: candidates[0], reason: "sole" };
    const onBase = candidates.filter(sitsOnLocalBase);
    // Exactly one: two branches both carrying the local head is ambiguous
    // rather than decisive, so it falls through to size like any other unknown.
    if (onBase.length === 1) return { node: onBase[0], reason: "local-base" };
    const sized = candidates.map((node) => ({ node, size: reachFrom(node).length }));
    const max = Math.max(...sized.map((s) => s.size));
    const longest = sized.filter((s) => s.size === max);
    return { node: longest[0].node, reason: longest.length === 1 ? "longest" : "bundle-id" };
  };

  const branchOf = (node: ChainNode): ChainBranch => ({
    machineId: node.sourced.machineId,
    bundleId: node.sourced.record.bundleId,
    bundleIds: ascending(reachFrom(node).map((n) => n.sourced.record.bundleId)),
  });

  const forks: ChainFork[] = [];
  const chain: ChainNode[] = [];
  let stoppedBecause: ChainStop = "no-root";
  let rootChoice: ChainChoice = "none";
  let followedRoot: ChainNode | undefined;

  if (rootNodes.length > 0) {
    const picked = choose(rootNodes);
    followedRoot = picked.node;
    rootChoice = picked.reason;

    const visited = new Set<number>([followedRoot.at]);
    chain.push(followedRoot);
    let cur = followedRoot;
    for (;;) {
      if (!isLinkUuid(cur.head)) {
        // Unlinkable FORWARD by construction. Not "the chain ended": a
        // successor may well exist and no walk can ever match it, which is the
        // head-equality trap in another costume if it is called a clean end.
        stoppedBecause = "empty-head";
        break;
      }
      const next = successors.get(cur.head) ?? [];
      if (next.length === 0) {
        stoppedBecause = "end";
        break;
      }
      let chosen: ChainNode;
      if (next.length === 1) {
        chosen = next[0];
      } else {
        // BRANCH-VS-BRANCH, on the hub. Not `hub.onDivergence`: that policy is
        // per bundle, resolves a hub bundle against a LOCAL transcript, lives
        // in the apply stage, and is not an input here. A bundle from the
        // branch picked here that then fails to chain onto the local file still
        // meets it there — two stages, two different questions.
        const pick = choose(next);
        chosen = pick.node;
        forks.push({
          anchorEntryUuid: cur.head,
          followedBundleId: chosen.sourced.record.bundleId,
          reason: pick.reason,
          parked: next.filter((n) => n.at !== chosen.at).map(branchOf),
        });
      }
      if (visited.has(chosen.at)) {
        // Only a damaged or hostile index reaches this: transcript uuids do not
        // form a loop. Our own writers cannot, but this walks peer-authored
        // data, and the alternative to the guard is an unbounded loop inside a
        // pull.
        stoppedBecause = "cycle";
        break;
      }
      visited.add(chosen.at);
      chain.push(chosen);
      cur = chosen;
    }
  }

  const inChain = new Set(chain.map((n) => n.at));

  const gaps: ChainGap[] = nodes
    // A string anchor naming a head nobody ships. `""` is included by
    // construction rather than by a special case: it is never in `shippedHeads`
    // (isLinkUuid keeps it out), so it can only ever be a gap.
    .filter((n) => typeof n.anchor === "string" && !shippedHeads.has(n.anchor))
    .sort(byBundleThenMachine)
    .map((n) => ({
      anchorEntryUuid: n.anchor as string,
      machineId: n.sourced.machineId,
      bundleId: n.sourced.record.bundleId,
      strandedBundleIds: ascending(reachFrom(n).map((x) => x.sourced.record.bundleId)),
    }));

  const unanchored: UnanchoredBundle[] = nodes
    .filter((n) => n.anchor == null && n.sourced.record.type === "continuation")
    .sort(byBundleThenMachine)
    .map((n) => ({
      machineId: n.sourced.machineId,
      bundleId: n.sourced.record.bundleId,
      preAssembly: n.anchor === undefined,
    }));

  const advertisedUnshipped: AdvertisedHead[] = copies
    .filter((c) => isLinkUuid(c.headEntryUuid) && !shippedHeads.has(c.headEntryUuid))
    .map((c) => ({ machineId: c.machineId, headEntryUuid: c.headEntryUuid }))
    .sort((a, b) =>
      a.machineId !== b.machineId
        ? a.machineId < b.machineId
          ? -1
          : 1
        : a.headEntryUuid < b.headEntryUuid
          ? -1
          : a.headEntryUuid > b.headEntryUuid
            ? 1
            : 0
    );

  return {
    chain: chain.map((n) => n.sourced),
    stoppedBecause,
    rootChoice,
    roots: rootNodes.map((n) => ({
      machineId: n.sourced.machineId,
      bundleId: n.sourced.record.bundleId,
      bundleIds: ascending(reachFrom(n).map((x) => x.sourced.record.bundleId)),
      followed: followedRoot !== undefined && n.at === followedRoot.at,
      preAssembly: n.anchor === undefined,
    })),
    forks,
    gaps,
    unanchored,
    advertisedUnshipped,
    unreachableBundleIds: ascending(
      nodes.filter((n) => !inChain.has(n.at)).map((n) => n.sourced.record.bundleId)
    ),
  };
}
