import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { finished, pipeline } from "node:stream/promises";
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
 * FIVE `aborted` outcomes — one per untrusted-input call, in the order they
 * run: the download, the unpack, the manifest parse, the manifest's own digest,
 * and the transcript that manifest declares. The count is worth stating because
 * it only moves in one direction: every call in this stage is handed bytes off
 * the hub, so a new one without a `try` is a new way for the stage to leave
 * `hubPull` as a throw — which is exactly what the download and the unpack were
 * until now.
 *
 * The caller's only correct handling of any of them is
 * `return fetched.terminal!` immediately. `break` falls through to the carry
 * gate, the thread mapping and the index write and then reports `success: true`
 * — a refusal turned into a successful pull. `continue` violates the chain
 * invariant (bundle N+1 is anchored on N's head) and fragment-imports *and
 * records* the next bundle, foreclosing the remedy.
 */

/**
 * Tear a stream down and swallow whatever it reports on the way.
 *
 * Used only on a failure path where the real diagnosis is already in hand. A
 * stream that has lost its `pipeline` has no error listener left, so an error
 * still in flight becomes an unhandled one — a run-failing event under vitest,
 * and in production a crash on the path whose whole job is to fail politely.
 */
async function absorbLateError(s: NodeJS.ReadableStream | NodeJS.WritableStream): Promise<void> {
  (s as { destroy?: () => void }).destroy?.();
  await finished(s as NodeJS.ReadableStream).catch(() => {});
}

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
  // Declared out here so the catch can reach it: whichever end fails first,
  // the OTHER one still has an error in flight that nobody is listening for.
  let src: NodeJS.ReadableStream | undefined;
  /**
   * The download is a GUARD, for the same reason the manifest parse below is:
   * this is hub-fetched input and the failure is the user's to act on, not an
   * internal fault. #78 typed the parse in the middle of this stage and left
   * the two calls either side of it throwing — uncaught, they leave `hubPull`
   * for the CLI's outer catch (exit 1, no `suggestion`), and since that catch
   * builds its `ErrorResult` from the exception alone they also discard every
   * disclosure the bundles already applied in this chain collected.
   *
   * The `pipeline` is inside the `try` and not merely the call that looks
   * risky: `createFsBackend`'s `readStream` is `createReadStream`, which is
   * lazy, so an ENOENT never comes out of `readStream` at all — it arrives as a
   * stream error and surfaces as the `pipeline` rejection.
   *
   * **Deliberately not worded as `not-yet-synced`**, which models a neighbouring
   * condition for a different code path. That result is decided by the select
   * stage's `backend.exists` sweep BEFORE anything is applied, lists the files,
   * and means "these have not arrived on this machine yet". This one is reached
   * only after that sweep saw the file, so it means the opposite: it was here,
   * and mid-chain — with earlier bundles applied and recorded — it is not
   * readable now. The suggestion says so, and names the overlap explicitly,
   * because a user who meets both inside a minute would otherwise read one
   * arriving file as two faults.
   */
  try {
    // record.file is hub-sourced (read out of another machine's index
    // file) and used as a path immediately below — the backend's
    // assertHubRelPath (hub/layout.ts, enforced inside every HubBackend
    // method, see hub/backend.ts) is the containment that rejects
    // traversal/absolute paths before anything touches the filesystem.
    src = await backend.readStream(record.file);
    await pipeline(src, out);
  } catch (e) {
    // ABSORB THE DESTINATION'S LATE ERROR before returning, or it lands on a
    // stream nobody is listening to any more and Node reports it as an
    // unhandled error — which vitest fails the whole run for, and which in
    // production is a crash on a path whose entire purpose is to fail politely.
    //
    // `createWriteStream` opens lazily and ASYNCHRONOUSLY, and `out` is created
    // above the `try` (it has to be — `pipeline` needs it). So when the SOURCE
    // errors first, which is the common case here because a missing hub file
    // fails fast, `pipeline` rejects and detaches while `out`'s `open()` is
    // still in flight. That open then resolves against a temp directory the
    // caller may already have torn down. Observed as an intermittent
    // `ENOENT … temp/<bundleId>.tar.gz` on a loaded CI runner, never locally.
    //
    // Same shape, same reason as `FsBackend.abort()`: destroy, then AWAIT the
    // close, swallowing whatever it reports. The error being discarded here is
    // never the one worth reporting — `e` already describes why the download
    // failed, and this one only says the scratch copy could not be finished.
    // BOTH ENDS, not just the destination — macOS proved the asymmetry was a
    // bug. `pipeline` settles on whichever stream fails FIRST and then detaches
    // its listeners; the other one's error arrives afterwards with nobody
    // listening. Absorbing only `out` covered the case where the source lost
    // the race (the common one on Linux, where a missing hub file fails fast)
    // and left the mirror image uncovered, which is exactly what macOS hit when
    // the destination's ENOTDIR won instead.
    //
    // Destroy-then-await, the shape `FsBackend.abort()` already uses. The
    // errors discarded here are never the ones worth reporting: `e` already
    // says why the download failed, and these two only say that a stream being
    // torn down was torn down.
    await absorbLateError(out);
    if (src !== undefined) await absorbLateError(src);
    return stageAbort({
      success: false,
      command: "pull",
      error: `Bundle ${record.bundleId} could not be read from the hub (${record.file}): ${(e as Error).message}`,
      suggestion:
        "Nothing from this bundle was applied. The file was listed in the hub's index and was still there when this pull checked, so something made it unreadable in between: the share went away mid-pull, a synced folder replaced or de-hydrated it, another machine removed it, or this machine could not write the temporary copy. Retry — the bundles applied before it in this chain are recorded and will not be refetched. A retry that answers with a not-yet-synced refusal naming this same file is that file still arriving, not a second fault.",
    });
  }
  const extractDir = join(tempRoot, record.bundleId);
  mkdirSync(extractDir, { recursive: true });
  /**
   * And the same for the unpack, whose two failure modes are not the same
   * situation and must not be answered as one.
   *
   * The archive is DAMAGED — gzip's CRC32 makes both a truncated and a
   * bit-flipped `.tar.gz` throw out of node-tar, which is measured and is the
   * whole reason this call is loud (see archiver.ts) — or it holds an entry
   * `assertSafeEntries` REFUSES: an absolute path, a `..` segment, a symlink or
   * a hard link. The first is fixed by a re-push (or, on a synced folder, by
   * waiting for the rest of the file); the second is not fixed by anything,
   * because no bundle this plugin produced contains such an entry.
   *
   * One abort rather than two, and not because the difference is small: telling
   * them apart here means matching on node-tar's and the archiver's message
   * text, which is the branching-on-prose that this codebase bans everywhere
   * else. So the thrown message is kept whole — it is the discriminator — and
   * the suggestion names both remedies and says which sentence answers which.
   */
  // NO progress reporting across this call, and it is a gap rather than an
  // omission (#74): `extractArchive` (src/archiver.ts) takes no callback at
  // all, so there is no seam to report from — and on a large bundle over a
  // network share the download above and this extraction are most of the wall
  // clock. `hub push`'s `createArchive` has the identical hole. Giving the
  // archiver a progress callback is a bigger change than this one and wants
  // deciding on its own merits, so it is stated here rather than smuggled in.
  try {
    await extractArchive(tarPath, extractDir);
  } catch (e) {
    return stageAbort({
      success: false,
      command: "pull",
      error: `Bundle ${record.bundleId} could not be unpacked (${record.file}): ${(e as Error).message}`,
      suggestion:
        "Nothing from this bundle was applied. Either the archive on the hub is damaged or was only partially written — a truncated or bit-flipped .tar.gz fails gzip's own checksum, which is what makes this loud — or it holds an entry sesh-mover refuses to extract: an absolute path, a `..` segment, a symlink or a hard link. The message above says which. For the first, if the hub is a synced folder give it a moment and retry, otherwise ask the machine that pushed it to push again; for the second no retry and no re-push helps, because no bundle sesh-mover produces contains such an entry. The bundles applied before it in this chain are recorded and will not be refetched.",
    });
  }
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
