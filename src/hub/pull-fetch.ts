import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import type { HubBackend } from "./backend.js";
import type { HubBundleRecord } from "./layout.js";
import type { ApplyState } from "./pull-apply-state.js";
import { stageAbort, stageOk, type StageOutcome } from "./pull-stages.js";
import { extractArchive } from "../archiver.js";
import { readManifest, verifySessionsDigest } from "../manifest.js";
import type { ExportManifest, ProgressEvent } from "../types.js";

export interface FetchStageInput {
  backend: HubBackend;
  record: HubBundleRecord;
  /**
   * The machine whose index listed THIS record (`SourcedBundle.machineId`), not
   * the machine the pull resolved to. It is stamped onto the workspace
   * generation this stage records, and the merge-ancestor rule is only sound
   * because of it — see `ChainWorkspaceBase`.
   */
  machineId: string;
  /**
   * This bundle's position in the chain. Load-bearing rather than bookkeeping:
   * it is stamped onto `state.lastCarry` so the carry gate after the loop can
   * tell a payload out of a bundle this pull already recorded from one out of a
   * bundle a divergence abort deferred.
   */
  bundleIndex: number;
  /**
   * How many bundles this pull's chain has — the denominator of the `hub-pull`
   * percent below, and the only thing this stage uses it for.
   */
  chainLength: number;
  /** Private temp dir for this pull; the archive and its extraction land here. */
  tempRoot: string;
  /**
   * MUTATED — this stage writes `chainWorkspaceBases` and `lastCarry` in place
   * rather than returning them. See the doc on `runFetchStage`.
   */
  state: ApplyState;
  /**
   * `hubPull`'s own callback, forwarded (#74). Optional and usually absent —
   * only `--progress` supplies one — so everything below is a no-op by default.
   */
  onProgress?: (ev: ProgressEvent) => void;
}

/**
 * What a fetched bundle hands to the rest of the loop.
 *
 * The contract this stage establishes is deliberately NOT "verified".
 * `verifySessionsDigest` hashes the manifest's canonicalized session list and
 * its length and **nothing else** — not the JSONL bytes, not `workspace/`, not
 * `carry/` — so content damage alone passes it. What is true on return is only
 * that *the manifest is internally self-consistent and the transcript it
 * declares is on disk*. The append path's own re-hash of the delta against
 * `bundleSession.integrityHash` is therefore NOT redundant with anything here;
 * treating it as redundant welds a corrupt delta into a transcript the user
 * already owns.
 */
export interface FetchStageResult {
  /** Where the bundle was unpacked — `manifest.json`, `sessions/`, and friends sit directly under it. */
  extractDir: string;
  manifest: ExportManifest;
}

/**
 * Retrieve one bundle of the chain, unpack it, and read its manifest.
 *
 * **This stage mutates `state`; it deliberately does not return the two values
 * it writes.**
 *
 * - `state.chainWorkspaceBases` is read by `chooseMergeAncestor` in the SAME
 *   loop iteration, so what is load-bearing is *timing*: this bundle's
 *   generation must be present before the workspace gate runs. A
 *   return-and-assign design invites a caller that pushes after the gate,
 *   silently dropping the newest and most-likely-shared generation.
 * - `state.lastCarry` is *newest-wins-**only if present***. Returning an
 *   optional carry invites `st.lastCarry = value.carry ?? null` at the call
 *   site, which CLEARS an earlier bundle's carry when a later bundle has none —
 *   silently discarding another machine's uncommitted work. The
 *   `if (manifest.carry)` guard stays welded to the assignment in here so that
 *   shape is not available to write.
 *
 * Two `aborted` outcomes, and the caller's only correct handling of either is
 * `return fetched.terminal!` immediately. `break` falls through to the carry
 * gate, the thread mapping and the index write and then reports `success: true`
 * — a refusal turned into a successful pull. `continue` violates the chain
 * invariant (bundle N+1 is anchored on N's head) and fragment-imports *and
 * records* the next bundle, foreclosing the remedy.
 */
export async function runFetchStage(
  input: FetchStageInput
): Promise<StageOutcome<FetchStageResult>> {
  const { backend, record, machineId, bundleIndex: i, chainLength, tempRoot, state: st } = input;

  // Bundles COMPLETED over bundles total, emitted as this one starts: bundle 0
  // reports 0%, and the chain's last bundle reports (n-1)/n rather than 100 —
  // the terminal 100 is `hubPull`'s `finally` and belongs to nobody else. It is
  // the only monotonic denominator available here; a byte-level number would
  // need a size the index does not record.
  input.onProgress?.({
    phase: "hub-pull",
    percent: chainLength > 0 ? Math.round((i / chainLength) * 100) : 0,
  });

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
  // NO progress reporting across this call, and it is a gap rather than an
  // omission (#74): `extractArchive` (src/archiver.ts) takes no callback at
  // all, so there is no seam to report from — and on a large bundle over a
  // network share the download above and this extraction are most of the wall
  // clock. `hub push`'s `createArchive` has the identical hole. Giving the
  // archiver a progress callback is a bigger change than this one and wants
  // deciding on its own merits, so it is stated here rather than smuggled in.
  await extractArchive(tarPath, extractDir);
  // Archiver-rooting reality check: createArchive tars the staging dir
  // with `cwd: dirname(sourceDir)` and a single top-level entry
  // (basename(sourceDir), i.e. "bundle" for push's staging), and
  // extractArchive always calls tar.extract with strip:1 — which
  // removes exactly that one wrapper segment. So manifest.json/sessions/
  // etc. land directly under extractDir, the same way cli.ts's import
  // action treats its own tempExtractDir as the exportPath (no nested
  // "bundle/" to join).
  /**
   * The manifest parse is a GUARD, and it has to answer like one.
   *
   * `readManifest` runs the trust boundary's first two steps (`is this a
   * sesh-mover manifest at all`, `are its ids path-safe`) and THROWS on either,
   * plus on a missing or unparseable `manifest.json`. This is the call that
   * meets those steps with hub-fetched bytes — the hostile-input surface the
   * checks exist for — so failing early here is right; propagating the throw
   * was not. Uncaught it left `hubPull` for the CLI's outer catch, which prints
   * `{error}` and exits 1: no `suggestion`, the exit code of a crash rather
   * than of a refusal, and the same damaged bundle reported in a shape no
   * caller can tell apart from an internal fault.
   *
   * So it is a `stageAbort`, like its two siblings below and for the identical
   * reason: bundle N+1 is anchored on bundle N's head, so an unreadable link
   * cannot be skipped past. The bundles applied before it stay applied and
   * recorded.
   */
  let bundleManifest: ExportManifest;
  try {
    bundleManifest = readManifest(extractDir);
  } catch (e) {
    return stageAbort({
      success: false,
      command: "pull",
      // `record.file` is the hub path the user can actually go and look at; the
      // thrown message is kept whole after it because it is the only thing that
      // distinguishes "no manifest.json" from "not one of ours" from a JSON
      // syntax error.
      error: `Bundle ${record.bundleId} does not carry a readable sesh-mover manifest (${record.file}): ${(e as Error).message}`,
      suggestion:
        "Nothing from this bundle was applied. Its manifest.json is missing, unreadable, or not a sesh-mover bundle manifest — the archive on the hub is damaged, was only partially written, or was not produced by sesh-mover. If the hub is a synced folder, give it a moment and retry; otherwise ask the machine that pushed it to push again. The bundles applied before it in this chain are recorded and will not be refetched.",
    });
  }

  /**
   * Nothing in this bundle is trusted until the manifest is shown to be the
   * one the pushing machine's exporter wrote, and nothing it declares is
   * trusted until the file is actually there.
   *
   * Both checks have to happen HERE rather than being left to
   * `importSession` at the bottom of the loop, because everything between
   * the two reads the manifest as fact: the workspace merge and the carry
   * are keyed off it, and the append path splices a continuation into a
   * transcript the user already owns after checking the delta against
   * `bundleSession.integrityHash` — a hash out of this same manifest. A
   * damaged session list makes that comparison meaningless, and a
   * `sessionIdInBundle` with no file behind it used to fall through the
   * append path's `existsSync(deltaPath)` guard into an import that counted
   * it as imported anyway.
   *
   * A damaged bundle stops the whole chain rather than being skipped: bundle
   * N+1 is anchored on bundle N's head (ledger: "a chain is not a set of
   * independent items"), so there is no such thing as carrying on past a
   * missing link. Aborting here means earlier bundles in this pull stay
   * applied and recorded — the same shape `importSession`'s own hard failure
   * has always had at this call site.
   */
  const bundleDigestProblem = verifySessionsDigest(bundleManifest);
  if (bundleDigestProblem) {
    return stageAbort({
      success: false,
      command: "pull",
      error: `Bundle ${record.bundleId} failed its integrity check: ${bundleDigestProblem}`,
      suggestion:
        "Nothing from this bundle was applied. The hub's copy is damaged or was edited after it was written — this check detects damage, not tampering. Ask the machine that pushed it to push again; the bundles applied before it in this chain are recorded and will not be refetched.",
    });
  }
  const declaredJsonl = join(extractDir, "sessions", `${record.sessionIdInBundle}.jsonl`);
  if (!existsSync(declaredJsonl)) {
    return stageAbort({
      success: false,
      command: "pull",
      error: `Bundle ${record.bundleId} declares session ${record.sessionIdInBundle} but does not contain it (${record.file}).`,
      suggestion:
        "Nothing from this bundle was applied. The archive on the hub is truncated or was only partially written — if the hub is a synced folder, give it a moment and retry; otherwise ask the machine that pushed it to push again.",
    });
  }

  // Attributed, never bare. `basedOn` is a claim about ONE machine's own
  // generation history, and since #35 the chain around it may be assembled from
  // several — so a base recorded without its machine is indistinguishable from
  // a base of the machine whose payload will actually be merged. See
  // `ChainWorkspaceBase` and `chooseMergeAncestor`.
  if (bundleManifest.workspace) {
    st.chainWorkspaceBases.push({
      machineId,
      bundleId: bundleManifest.workspace.basedOn?.bundleId ?? null,
    });
  }

  // The carry is applied AFTER the whole chain, and the newest one wins:
  // each payload is a full `git diff HEAD` of the sender's tree at that
  // moment, so an older one in the same chain describes a superseded
  // working tree. Recorded here because the extraction directories only
  // live until this function returns.
  // `bundleIndex` is load-bearing, not bookkeeping: a divergence abort
  // suppresses the carry, and that suppression is only correct for a
  // payload the user will actually be offered again. A carry out of a
  // bundle EARLIER than the abort belongs to a bundle this pull already
  // recorded — the re-run will never see it, and dropping it deleted the
  // only reachable copy of someone's uncommitted work while the warning
  // said it had been "left in its bundle". See the gate after the loop.
  // Stored as the manifest wrote it. `CarryMeta` is what `ExportManifest`
  // DECLARES this to be, not what a hub-fetched manifest is checked to hold —
  // `normalizeCarryMeta` in `pull-apply-carry.ts` is where it becomes true, and
  // it is done there rather than here so the fields it had to repair can be
  // disclosed (this stage's `reasons` are not spread into the pull's warnings).
  if (bundleManifest.carry) {
    st.lastCarry = {
      dir: join(extractDir, "carry"),
      meta: bundleManifest.carry,
      bundleFile: record.file,
      bundleIndex: i,
    };
  }

  return stageOk({ extractDir, manifest: bundleManifest });
}
