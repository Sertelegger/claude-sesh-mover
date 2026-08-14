import type { HubBundleRecord } from "./layout.js";
import type { WorkspaceMergeReport } from "./merge.js";
import type { CarryMeta } from "./carry.js";
import type { ExportManifest, HubPullDivergence, HubPullResult } from "../types.js";

/**
 * The newest carry payload seen in a chain, and where it came from.
 *
 * `bundleIndex` is load-bearing rather than bookkeeping — see the carry gate
 * in `pull.ts`, which distinguishes a payload out of a bundle this pull already
 * recorded from one out of a bundle a divergence abort deferred.
 */
export interface PulledCarry {
  dir: string;
  meta: CarryMeta;
  bundleFile: string;
  bundleIndex: number;
}

export interface InitApplyStateInput {
  /**
   * The chain of bundles this pull will walk, in order — only read here to
   * locate the workspace-carrying bundle. Nothing in the state keeps a
   * reference to it.
   */
  needed: readonly HubBundleRecord[];
}

/**
 * Everything `hubPull`'s per-bundle loop accumulates, in one object.
 *
 * **This object is mutable and is passed by reference on purpose.**
 * `threadLandedSessionId` and `ourWritesFrom` are read in iteration *n* from
 * writes made in iterations `< n`, and `describeApplied` closes over the live
 * `appended` / `importedSessions` / `skippedSessions` containers. Anything that
 * snapshots or copies this state at loop entry changes behavior invisibly: the
 * closures would report an empty pull in exactly the warnings that exist to say
 * what was already applied.
 *
 * The container fields are `readonly` for that reason — they may be mutated in
 * place (push/set), never reassigned, or the closures stop observing them.
 */
export interface ApplyState {
  workspaceUnpacked: HubPullResult["workspaceUnpacked"];
  workspaceMerge: WorkspaceMergeReport | undefined;
  workspaceRefused: string[] | undefined;
  /**
   * Set when a manifest declares a workspace payload the bundle does not
   * contain. A FIELD, not just the warning — see the declaration comment in
   * `initApplyState`.
   */
  workspaceDeclaredMissing: boolean | undefined;
  /** Which bundle in this chain carries the workspace generation to apply. */
  readonly workspaceBundleIndex: number;
  readonly chainWorkspaceBases: Array<string | null>;
  readonly importedSessions: HubPullResult["importedSessions"];
  readonly skippedSessions: HubPullResult["skippedSessions"];
  readonly appended: NonNullable<HubPullResult["appended"]>;
  lastImportedNewId: string | null;
  lastBundleManifest: ExportManifest | null;
  threadLandedSessionId: string | null;
  lastDivergence: HubPullDivergence | undefined;
  skippedByDivergence: boolean;
  divergenceAborted: boolean;
  deferredBundles: number;
  abortIndex: number;
  readonly ourWritesFrom: Map<string, number>;
  lastCarry: PulledCarry | null;
  lastAppliedIndex: number;
  /** See the doc comment on the closure in `initApplyState`. */
  describeApplied(upTo: number): string;
  /** Earliest wins: our writes to a transcript start at the first of them. */
  rememberOurWrite(path: string, from: number): void;
}

/**
 * Build the per-pull apply state. Called once, immediately before the
 * per-bundle loop; every accumulator starts here at its "nothing has happened
 * yet" value.
 */
export function initApplyState(input: InitApplyStateInput): ApplyState {
  const { needed } = input;

  // Which bundle in this chain carries the workspace generation to apply:
  // the NEWEST one that has a payload, not needed[0].
  //
  // A chain is pulled in one pass and every bundle is recorded as received
  // by the end of it, so any generation that isn't applied now is never
  // offered again. Applying the OLDEST would therefore leave the tree
  // permanently behind the hub after two unpulled pushes — and, worse, would
  // record that stale generation as this machine's ancestor. Falls back to
  // index 0 when NO record claims a payload, which keeps the manifest check
  // in the loop the sole authority in that case (Slice-1 behavior).
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
    if (needed[i].hasWorkspace) { workspaceBundleIndex = i; break; }
  }
  // Every generation the bundles in this chain declare they descend from,
  // oldest first — the peer's half of the "common to both trees" test that
  // `chooseMergeAncestor` intersects with our own generation history.
  const chainWorkspaceBases: Array<string | null> = [];
  const importedSessions: HubPullResult["importedSessions"] = [];
  const skippedSessions: HubPullResult["skippedSessions"] = [];
  const appended: NonNullable<HubPullResult["appended"]> = [];
  /**
   * Where THIS pull's own writes to a given local transcript begin: the file's
   * byte size immediately before the first splice or adoption it performed
   * there. Absent for a transcript this pull has not written to.
   *
   * Used to keep `localEntriesSinceAnchor` honest. That field answers "how far
   * has the user's own copy run past the shared anchor", and a later bundle in
   * the same chain measures it on a file an EARLIER bundle of the same pull
   * just appended to — so without this the pull counts its own delivery as the
   * user's divergence and reports a fork twice as wide as the real one.
   */
  const ourWritesFrom = new Map<string, number>();

  /**
   * What this pull had ALREADY applied and recorded when a divergence stopped
   * the chain at bundle `upTo`. Empty at `upTo === 0`, where the abort really
   * does mean nothing happened.
   *
   * Measured on an aborted `--on-divergence skip` pull at `upTo === 1`: the
   * base transcript went 5 -> 7 lines, `peers[...].received` gained an entry,
   * the hub-peer ledger recorded a new head and this machine's index file was
   * republished — while the shipped warning said "skipped, nothing changed".
   * The skill layer repeats these sentences verbatim, so they have to be true
   * on both sides of the boundary.
   *
   * Closes over the LIVE containers above, not over copies of them: it is
   * called from inside the loop, after those have been pushed to.
   */
  const describeApplied = (upTo: number): string => {
    if (upTo <= 0) return "";
    const bits: string[] = [];
    const entries = appended.reduce((n, a) => n + a.entriesAppended, 0);
    if (entries > 0) {
      const targets = [...new Set(appended.map((a) => a.baseSessionId))];
      bits.push(
        `${entries} entr${entries === 1 ? "y" : "ies"} spliced into session${targets.length === 1 ? "" : "s"} ${targets.join(", ")}`
      );
    }
    if (importedSessions.length > 0) {
      bits.push(`${importedSessions.length} session${importedSessions.length === 1 ? "" : "s"} imported`);
    }
    if (skippedSessions.length > 0) {
      bits.push(
        `${skippedSessions.length} session${skippedSessions.length === 1 ? "" : "s"} already present`
      );
    }
    const what = bits.length > 0 ? bits.join(", ") : "no session content landed from them";
    return `the ${upTo} earlier bundle${upTo === 1 ? "" : "s"} in this chain ${upTo === 1 ? "was" : "were"} already applied and recorded (${what})`;
  };

  /** Earliest wins: our writes to a transcript start at the first of them. */
  const rememberOurWrite = (path: string, from: number): void => {
    const prior = ourWritesFrom.get(path);
    ourWritesFrom.set(path, prior === undefined ? from : Math.min(prior, from));
  };

  return {
    workspaceUnpacked: null,
    workspaceMerge: undefined,
    workspaceRefused: undefined,
    // Set when a manifest declares a workspace payload the bundle does not
    // contain (see the guard in the loop). A FIELD, not just the warning,
    // because it is field-indistinguishable from the routine no-ancestor skip
    // otherwise — same null workspaceUnpacked, same absent workspaceMerge —
    // and the two want opposite advice (that skip's remedies cannot deliver a
    // payload that was never in the bundle).
    workspaceDeclaredMissing: undefined,
    workspaceBundleIndex,
    chainWorkspaceBases,
    importedSessions,
    skippedSessions,
    appended,
    lastImportedNewId: null,
    lastBundleManifest: null,
    // The local session THIS pull has landed content in (imported or extended)
    // — null until something lands. It is both the thread mapping written at
    // the end and the preferred splice target for later bundles in the same
    // chain, since the mapping itself isn't written until the loop is done.
    threadLandedSessionId: null,
    // The last two-sided fork this pull ran into, and whether a bundle was
    // deliberately left unapplied because of one. A chain is pulled in order,
    // so a later bundle's divergence supersedes an earlier one's.
    lastDivergence: undefined,
    skippedByDivergence: false,
    /**
     * A divergence left this thread undecided, so the WHOLE chain stops here.
     *
     * Skipping only the diverged bundle and carrying on was the eighth
     * foreclosure of this milestone, and the second to survive a guard built
     * for the class. The mechanism: the next bundle in the chain is anchored on
     * the head the skipped one would have installed, so it can never chain onto
     * the local session either — it reaches the divergence branch with
     * `adoptAvailable: false`, is fragment-imported, and IS recorded. That
     * flips `appliedNothing`, the index is republished, `divergence.resolution`
     * (one field for the whole pull) is overwritten "skip" -> "fragment", and
     * the user who asked to adopt silently gets a third transcript with no
     * indication their answer was dropped. Every remedy is then foreclosed:
     * "Nothing to pull" / "the latest copy is already local".
     *
     * A skip is a promise that this pull applied and recorded NOTHING for this
     * thread. That promise is only keepable at the granularity of the thread,
     * because the bundles in a chain are not independent — so the loop breaks.
     */
    divergenceAborted: false,
    /** How many bundles of the chain were left unfetched by that break. */
    deferredBundles: 0,
    /**
     * Which bundle the break landed on, or -1 for "the chain ran to the end".
     *
     * The abort is thread-wide, but it is NOT a rollback, and the difference is
     * the whole reason this index exists. A chain is walked in order, so bundles
     * `0..abortIndex - 1` were spliced or imported AND RECORDED before the fork
     * was discovered; only `abortIndex` onward is still on offer. Everything
     * that phrases the abort — the warnings, the carry gate, the thread mapping
     * — has to split on that boundary instead of treating the whole thread as
     * untouched, which is only true at `abortIndex === 0`.
     */
    abortIndex: -1,
    ourWritesFrom,
    // The newest carry payload in this chain, if any — see the loop.
    lastCarry: null,
    /**
     * The index of the last bundle this pull actually finished handling, and its
     * manifest (`lastBundleManifest`). Distinct from "the last bundle in
     * `needed`" once a divergence can stop the chain early — see the
     * thread-mapping block at the end, which used to name a bundle that was
     * never fetched.
     */
    lastAppliedIndex: -1,
    describeApplied,
    rememberOurWrite,
  };
}
