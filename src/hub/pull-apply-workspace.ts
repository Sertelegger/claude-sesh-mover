import { existsSync, mkdirSync, mkdtempSync, createWriteStream, readdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { type HubBackend } from "./backend.js";
import { type HubBundleRecord } from "./layout.js";
import { unpackWorkspace, WorkspaceTargetNotEmptyError } from "./workspace.js";
import { mergeWorkspaceTrees, type WorkspaceMergeReport } from "./merge.js";
import { isReadableDir } from "./fs-probe.js";
import { stageAbort, stageOk, stageSkip, type StageOutcome } from "./pull-stages.js";
import { extractArchive } from "../archiver.js";
import {
  readSyncState, writeSyncState, setLastWorkspace, knownWorkspaceGenerations,
} from "../sync-state.js";
import { isPluginStateName } from "../paths.js";
import type { WorkspaceGenerationRef } from "../types.js";

export interface ApplyWorkspaceStageInput {
  backend: HubBackend;
  extractDir: string;
  effectiveProjectPath: string;
  targetPathGiven: boolean;
  forceWorkspace: boolean;
  bundleDeclaresWorkspace: boolean;
  chainWorkspaceBases: ReadonlyArray<string | null>;
  hubId: string;
  record: Pick<HubBundleRecord, "bundleId" | "file" | "pushedAt">;
  tempRoot: string;
}

export interface WorkspaceStageValue {
  unpacked: { path: string; fileCount: number } | null;
  merge?: WorkspaceMergeReport;
  refused?: string[];
  declaredMissing?: true;
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
async function fetchAncestorWorkspace(
  backend: HubBackend,
  ref: { bundleId: string; file: string },
  tempRoot: string
): Promise<{ dir: string | null; warning?: string }> {
  const degraded = (why: string): { dir: null; warning: string } => ({
    dir: null,
    warning:
      `The workspace generation ${ref.bundleId}, which this pull would have merged against, ` +
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
    if (!existsSync(tree)) return degraded("carries no workspace tree");
    return { dir: tree };
  } catch (e) {
    return degraded(`could not be read back (${(e as Error).message})`);
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
async function chooseMergeAncestor(
  backend: HubBackend,
  /**
   * Bundle ids the incoming chain declares it descends from, oldest first.
   * Only the id is consulted: the peer's `file` never becomes a path here (we
   * use OUR record of the same generation), so a forged one cannot reach the
   * filesystem at all.
   */
  chainBaseBundleIds: ReadonlyArray<string | null>,
  known: WorkspaceGenerationRef[],
  tempRoot: string
): Promise<{ dir: string | null; warnings: string[] }> {
  let idx = -1;
  for (const bundleId of chainBaseBundleIds) {
    if (!bundleId) continue; // the peer's first workspace push declares none
    const j = known.findIndex((g) => g.bundleId === bundleId);
    if (j >= 0 && (idx === -1 || j < idx)) idx = j;
  }
  if (idx === -1) return { dir: null, warnings: [] };

  const warnings: string[] = [];
  const candidates = known.slice(idx);
  const tried = new Set<string>();
  for (const [n, ref] of candidates.entries()) {
    if (tried.has(ref.file)) continue;
    tried.add(ref.file);
    const attempt = await fetchAncestorWorkspace(backend, ref, tempRoot);
    if (attempt.dir !== null) {
      if (n > 0) {
        warnings.push(
          `Merged against an older workspace generation (${ref.bundleId}) than the closest one shared with the other machine, which could not be fetched — so files that changed here since then may be reported as conflicts even where the other machine left them alone.`
        );
      }
      return { dir: attempt.dir, warnings };
    }
    if (attempt.warning) warnings.push(attempt.warning);
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
function describeWorkspaceMerge(r: WorkspaceMergeReport): string[] {
  const out: string[] = [];
  const names = (paths: string[]): string =>
    paths.slice(0, 5).join(", ") + (paths.length > 5 ? `, and ${paths.length - 5} more` : "");
  const count = (n: number): string => `${n} workspace file${n === 1 ? "" : "s"}`;
  // Agreement helpers: `count()` produces a singular subject at n = 1, so every
  // verb and pronoun downstream of it has to agree or the sentence reads as
  // broken English on the most common case of all ("1 workspace file were…").
  const were = (n: number): string => (n === 1 ? "was" : "were");
  const they = (n: number): string => (n === 1 ? "It is" : "They are");

  if (r.conflicted.length > 0) {
    out.push(
      `${count(r.conflicted.length)} ${were(r.conflicted.length)} merged with conflict markers and need resolving by hand — search for "<<<<<<< local": ${names(r.conflicted)}. Conflicts are normal here: edits on adjacent lines conflict, and a file added independently on both machines conflicts over its whole length.`
    );
  }
  if (r.gitUnavailable) {
    out.push(
      "No usable `git merge-file` on this machine, so files edited on both machines could not be merged — your copies were left exactly as they are and the other machine's versions were parked beside them. Install git (or put it on PATH) to have future pulls merge them automatically."
    );
  }
  if (r.sidecars.length > 0) {
    out.push(
      `${count(r.sidecars.length)} could not be merged, so your ${r.sidecars.length === 1 ? "copy was" : "copies were"} kept and the other machine's saved alongside as ${r.sidecars.length === 1 ? "a *.theirs-* file" : "*.theirs-* files"}: ${names(r.sidecars.map((s) => s.path))}. Delete ${r.sidecars.length === 1 ? "the sidecar" : "the sidecars"} once you've reconciled ${r.sidecars.length === 1 ? "it" : "them"} — they are ordinary files and will be pushed to the hub otherwise.`
    );
  }
  if (r.skipped.length > 0) {
    out.push(
      `${count(r.skipped.length)} ${were(r.skipped.length)} not applied at all and nothing was written near ${r.skipped.length === 1 ? "it" : "them"} (${[...new Set(r.skipped.map((s) => s.reason))].join(", ")}): ${names(r.skipped.map((s) => s.path))}. The incoming ${r.skipped.length === 1 ? "copy is" : "copies are"} still on the hub.`
    );
  }
  if (r.upstreamDeleted.length > 0) {
    out.push(
      `${count(r.upstreamDeleted.length)} ${were(r.upstreamDeleted.length)} deleted on the other machine but kept here (this merge never deletes your files): ${names(r.upstreamDeleted)}.`
    );
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
    out.push(
      `${count(r.localDeleted.length)} that ${were(r.localDeleted.length)} in the last generation shared with the other machine ${r.localDeleted.length === 1 ? "is" : "are"} gone here and ${were(r.localDeleted.length)} not restored: ${names(r.localDeleted)}. ${they(r.localDeleted.length)} unchanged on the other machine, so this is what you asked for if you deleted ${r.localDeleted.length === 1 ? "it" : "them"} here — but an earlier sync that could not write ${r.localDeleted.length === 1 ? "that path" : "those paths"} (a symlink or a permissions failure it warned about at the time) looks identical from here. Nothing will offer ${r.localDeleted.length === 1 ? "it" : "them"} again on its own. If you did not delete ${r.localDeleted.length === 1 ? "it" : "them"}: the non-destructive route is to re-pull the next workspace payload with --target-path <fresh-dir> and copy ${r.localDeleted.length === 1 ? "that file" : "those files"} across by hand. Passing --force-workspace instead unpacks the hub's copy over THIS directory, OVERWRITING any file of the same name — including local edits this merge has been preserving for you.`
    );
  }
  if (r.restored.length > 0) {
    out.push(
      `${count(r.restored.length)} that you had deleted here ${were(r.restored.length)} changed on the other machine, so ${r.restored.length === 1 ? "it came" : "they came"} back rather than losing that work: ${names(r.restored)}. Delete ${r.restored.length === 1 ? "it" : "them"} again if you still don't want ${r.restored.length === 1 ? "it" : "them"}.`
    );
  }
  return out;
}

/**
 * Apply the chain's workspace payload — by merging it, unpacking it, or
 * declining to do either.
 *
 * Runs inside the per-bundle loop, once per bundle, and self-gates: the caller
 * passes `bundleDeclaresWorkspace` (`i === state.workspaceBundleIndex &&
 * !!manifest.workspace`), and every other bundle is a zero-reason skip. It must
 * NOT be hoisted out of the loop even though it does its work at most once —
 * `chainWorkspaceBases` is written by `fetch` in the same iteration and read
 * here mid-accumulation, and an earlier bundle's integrity abort has to be able
 * to stop the pull before this ever runs.
 *
 * Five outcomes, and the difference between the last two is the whole reason
 * this returns an outcome rather than a value:
 *
 * | situation | outcome |
 * |---|---|
 * | no payload on this bundle | `skipped`, zero reasons, no value |
 * | manifest declares one the bundle lacks | `skipped`, one reason, `declaredMissing` |
 * | merged, or unpacked | `applied`, `unpacked` plus `merge`/`refused` |
 * | no generation common to both trees | `skipped`, the ancestor reasons PLUS the no-common-point sentence |
 * | explicit --target-path, not empty, no force | `aborted` — see below |
 *
 * **The abort is not a refusal.** `WorkspaceTargetNotEmptyError` returns an
 * `ErrorResult` the caller must return VERBATIM, stopping the pull before this
 * bundle's sessions are imported and before anything is recorded. Modelling it
 * as `refused` (apply-safe, pull continues) records the bundle and forecloses
 * the `--force-workspace` re-run its own message promises — and the registry in
 * `tests/hub-warning-flags.test.ts` classifies that message `retry-works` on
 * exactly this premise, while being unable to detect a change to it.
 *
 * `WorkspaceStageValue.unpacked` is a sum over five merge-report arrays on the
 * merge path and `unpackWorkspace`'s own count on the unpack path — a union of
 * the two engines' reports would lose it, along with `refused` and
 * `declaredMissing`, which are `HubPullResult` fields with no other source.
 *
 * Workspace gate (the chain's newest workspace-carrying bundle only).
 * Slice 1's four branches are preserved; what changed is that the
 * APPLICATION step is now a 3-way merge whenever a generation COMMON TO
 * BOTH TREES can be named (design §5.5, and see `chooseMergeAncestor` for
 * why nothing weaker will do):
 *
 * - target absent, empty, or
 *   metadata-only                -> unpack (bootstrap; no force needed).
 *                                   NEVER merge: with an empty tree every
 *                                   file reads as "deleted here" and the
 *                                   merge would write nothing at all.
 * - common generation found,
 *   target has real content,
 *   no --force-workspace         -> 3-way MERGE. No force needed: merging
 *                                   cannot lose local work, so requiring
 *                                   a destructive-sounding flag for it
 *                                   would be backwards.
 * - --force-workspace, target has
 *   real content                 -> unpack with force, i.e.
 *                                   OVERWRITE-ON-COLLISION (§5.4), merge
 *                                   or no merge. The flag keeps ONE
 *                                   meaning — "overwrite, don't combine"
 *                                   — and it is deliberately not made
 *                                   inert by having a generation on
 *                                   record: it is the only way to ask for
 *                                   the hub's copy wholesale, and the only
 *                                   remedy for a file a merge withheld.
 * - no common generation, explicit
 *   --target-path, has real
 *   content, no force            -> let unpackWorkspace throw, surface
 *                                   an ErrorResult with the
 *                                   --force-workspace suggestion (the
 *                                   user asked for that destination;
 *                                   refuse loudly)
 * - no common generation, no
 *   explicit --target-path,
 *   project dir has real content,
 *   no force                     -> SKIP with a warning (routine repeat
 *                                   pulls of non-git projects must not
 *                                   start erroring)
 *
 * Plugin state counts as non-content on BOTH sides: identity linking
 * above may have just planted `.sesh-mover-project.json` into an
 * otherwise fresh directory (the in-place bootstrap flow, --project-id
 * with no --target-path), and that metadata alone must neither trigger
 * the routine-skip branch nor trip unpackWorkspace's own emptiness check
 * — hence force is also set when the dir holds nothing but our metadata.
 * `isPluginStateName` rather than one literal name: since 0.7.0 the
 * metadata is a directory AND three root dotfiles, and the pre-0.7.0
 * directory is still recognized, so a single `!==` would read a freshly
 * linked project as having real content and skip the merge.
 */
export async function runApplyWorkspaceStage(
  input: ApplyWorkspaceStageInput
): Promise<StageOutcome<WorkspaceStageValue>> {
  const {
    backend, extractDir, effectiveProjectPath, targetPathGiven, forceWorkspace,
    bundleDeclaresWorkspace, chainWorkspaceBases, hubId, record, tempRoot,
  } = input;
  const reasons: string[] = [];

  const incomingDir = join(extractDir, "workspace");

  // First, a payload the manifest declares and the bundle does not contain.
  // Both application paths below start by READING that directory, so an
  // absent one threw ENOENT straight out of hubPull: no sessions imported,
  // nothing recorded, and therefore the identical crash on every retry —
  // the optional half taking down the transcripts that are the point of the
  // operation. Every sesh-mover before the accompanying snapshotWorkspace
  // fix wrote exactly this bundle whenever a snapshot carried no files (an
  // empty project, or an ignore list broad enough to drop the whole tree), so
  // those bundles are on hubs now; a hand-made or truncated one says the
  // same thing. Deliberately the same shape as the carry's own "declares it
  // but does not contain it" guard further down.
  // `isDirectory`, not `existsSync`: a bundle whose `workspace` entry is a
  // FILE reaches the same `readdirSync` and throws ENOTDIR out of hubPull
  // before the session import — the identical terminal shape this guard
  // exists to close. No sesh-mover produces that, but the sentence below
  // claims to cover a hand-made bundle, so the check has to mean it.
  if (bundleDeclaresWorkspace && !isReadableDir(incomingDir)) {
    reasons.push(
      "The bundle's manifest declares a workspace payload but the bundle does not contain one, so there was nothing to apply and this project's files were left untouched. It was written by an older sesh-mover whose snapshot carried no files, damaged in transit, or not produced by sesh-mover at all."
    );
    return stageSkip<WorkspaceStageValue>(reasons, { unpacked: null, declaredMissing: true });
  } else if (bundleDeclaresWorkspace) {
    const entries = existsSync(effectiveProjectPath) ? readdirSync(effectiveProjectPath) : [];
    const hasRealContent = entries.some((n) => !isPluginStateName(n));

    // Ancestor lookup is keyed off the EFFECTIVE project path, like every
    // other piece of local bookkeeping here — a pull into a fresh
    // --target-path has no sync-state there and therefore no generation
    // history, which is correct: that tree shares nothing with the hub.
    const known = knownWorkspaceGenerations(readSyncState(effectiveProjectPath));
    let ancestorDir: string | null = null;
    // --force-workspace is an explicit "overwrite, don't combine", so it
    // skips the ancestor hunt entirely rather than fetching a tree nothing
    // will read.
    if (hasRealContent && !forceWorkspace) {
      const ancestor = await chooseMergeAncestor(
        backend, chainWorkspaceBases, known, tempRoot
      );
      ancestorDir = ancestor.dir;
      reasons.push(...ancestor.warnings);
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
      const unpacked = {
        path: effectiveProjectPath,
        fileCount:
          report.taken.length + report.created.length + report.restored.length +
          report.merged.length + report.conflicted.length,
      };
      // Record the new ancestor IMMEDIATELY, before the session half of
      // this pull can fail. The tree already reflects this generation; if a
      // later fault sent us back to the old one, the next pull would merge
      // an already-merged (possibly conflict-marked) file against a stale
      // base and manufacture conflicts out of work that was already done.
      const stateWs = readSyncState(effectiveProjectPath);
      setLastWorkspace(stateWs, hubId, {
        bundleId: record.bundleId, file: record.file, pushedAt: record.pushedAt,
      });
      writeSyncState(stateWs);
      reasons.push(...describeWorkspaceMerge(report));
      return stageOk<WorkspaceStageValue>({ unpacked, merge: report }, reasons);
    } else if (hasRealContent && !forceWorkspace && !targetPathGiven) {
      // The two flags are named for the NEXT payload, never as a re-run of
      // this pull: this bundle is recorded as received by the end of it, so
      // an immediate repeat answers "already up to date" without reaching
      // the files. This branch also records NO generation (recording one
      // this tree never received is how the next merge reads the whole
      // payload as "deleted here"), so nothing about it self-heals. Every
      // payload from that machine skips exactly like this until one is
      // applied, and every workspace bundle written before 0.6.0 declares
      // no ancestor at all, which is precisely how a first 0.6.0 pull lands
      // here.
      //
      // THE TWO FLAGS ARE NOT INTERCHANGEABLE and the old text said they
      // were ("whichever you use, that machine and this one then share a
      // generation"). Every piece of local bookkeeping here — including
      // `setLastWorkspace` — is keyed off `effectiveProjectPath`, which IS
      // the --target-path when one is given, so the generation an unpack
      // there records belongs to the FRESH directory's sync-state. This
      // project directory still has none, and its next payload produces a
      // byte-identical skip. Only --force-workspace ends the repetition
      // HERE. Measured: skip -> --target-path <fresh> -> zero
      // workspaceGenerations under the project's own key -> identical skip.
      reasons.push(
        "Bundle carries a workspace payload but the project directory already has content and no workspace generation is shared between this machine and the payload, so there is no common point to merge from and NOTHING was written. The sessions imported normally, and the payload is still in the bundle on the hub. This pull cannot be re-run to get it — its bundles are recorded now — and it will not resolve itself: no generation is recorded for a payload that was not applied, so the next payload from that machine skips for the same reason. Only one thing ends that repetition for THIS directory: --force-workspace on a LATER pull, which unpacks the hub's copy over it, OVERWRITING any file of the same name, after which the two machines share a generation and later payloads merge 3-way. --target-path <fresh-dir> on a later pull is the non-destructive way to SEE a payload — it unpacks elsewhere and touches nothing here — but the generation it records belongs to that fresh directory, so pulls into this one go on skipping exactly like this."
      );
      return stageSkip<WorkspaceStageValue>(reasons);
    } else {
      try {
        const ws = await unpackWorkspace(
          incomingDir,
          effectiveProjectPath,
          { force: forceWorkspace || !hasRealContent }
        );
        const unpacked = { path: effectiveProjectPath, fileCount: ws.fileCount };
        let refused: string[] | undefined;
        if (ws.symlinksSkipped > 0) {
          reasons.push(`${ws.symlinksSkipped} symlink(s) skipped while unpacking the workspace.`);
        }
        if (ws.refused.length > 0) {
          refused = ws.refused;
          // Deliberately does NOT accuse the sender. A bundle written by a
          // sesh-mover older than this guard, on a case-insensitive
          // filesystem, legitimately carried a `.GIT` store — the very leak
          // the guard closed — so "hand-made or damaged" would be a false
          // accusation in the commonest case that reaches here.
          reasons.push(
            `${ws.refused.length} path(s) in the workspace payload were refused because they name plugin or VCS internals that never travel (${ws.refused.slice(0, 5).join(", ")}). Nothing from them was written here. Current sesh-mover versions never put those in a bundle, so this one came from an older version, was damaged in transit, or was not produced by sesh-mover at all.`
          );
        }
        if (ws.blocked.length > 0) {
          reasons.push(
            `${ws.blocked.length} workspace file(s) were not unpacked because of what already occupies their path here (${[...new Set(ws.blocked.map((b) => b.reason))].join(", ")}): ${ws.blocked.slice(0, 5).map((b) => b.path).join(", ")}. Nothing was written near them; the incoming copies are still on the hub.`
          );
        }
        if (hasRealContent) {
          reasons.push(
            forceWorkspace && known.length > 0
              ? "The workspace payload was unpacked over the existing directory, overwriting any file of the same name, because --force-workspace was passed — no 3-way merge was attempted even though this machine has workspace generations on record. Anything of yours that the payload does not contain is still here."
              : "The workspace payload was unpacked over the existing directory, overwriting any file of the same name — no workspace generation is shared between this machine and the payload, so there was no common point to combine them from."
          );
        }
        // Both application paths record the generation: whatever was
        // overwritten now matches it, and anything only this machine has is
        // absent from it, which is exactly how the next merge should read
        // this tree.
        const stateWs = readSyncState(effectiveProjectPath);
        setLastWorkspace(stateWs, hubId, {
          bundleId: record.bundleId, file: record.file, pushedAt: record.pushedAt,
        });
        writeSyncState(stateWs);
        return stageOk<WorkspaceStageValue>({ unpacked, refused }, reasons);
      } catch (e) {
        if (e instanceof WorkspaceTargetNotEmptyError) {
          // TERMINAL, not a refusal: the caller returns this verbatim and the
          // pull stops here, before this bundle's sessions are imported and
          // before anything is recorded. That is what keeps the
          // --force-workspace re-run below honest.
          return stageAbort<WorkspaceStageValue>({
            success: false, command: "pull",
            error: e.message,
            // Not "merge": this branch is only reached when
            // chooseMergeAncestor found NO generation common to both trees,
            // so a merge is impossible here by construction — and
            // --force-workspace would skip the merge even if one were
            // available. Recommending a merge at the exact point the code
            // has ruled one out is how a user consents to an overwrite
            // thinking their local files will be combined.
            suggestion:
              "Nothing was written. To use this destination anyway, re-run with --force-workspace: it unpacks the hub's copy over the existing (non-empty) directory, OVERWRITING any file of the same name — it does not combine the two. To keep that directory untouched, point --target-path at an empty one instead.",
          });
        }
        throw e;
      }
    }
  }
  // No payload on this bundle: the common case, and not a story worth telling.
  return stageSkip<WorkspaceStageValue>([]);
}
