import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, createReadStream,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFsBackend } from "./backend.js";
import { bundleDir, bundleFileName, type HubBundleRecord, type HubJson } from "./layout.js";
import { acquireProjectLock, describeLockSteal, LockBusyError } from "./lock.js";
import {
  resolveProjectIdentity, mintHubProject, readHubProjectAsLocal, writeLocalProjectId,
  readLocalProjectId, removeLocalProjectIdIfMatches, type LocalProjectId,
} from "./identity.js";
import { scanGitRemotes, type GitRemoteScan } from "../payload/git-scan.js";
import { capturePayload } from "../payload/capture.js";
import { registerMachine } from "./init.js";
import { hubUnreachableRefusal, preflightHub } from "./preflight.js";
import { HubIoTimeoutError } from "./io-timeout.js";
import { buildIndexFile, readMachineIndex, writeMachineIndex } from "./index-file.js";
import type { CarryMeta } from "../payload/carry.js";
import { exportAllSessions } from "../exporter.js";
import { createArchive } from "../archiver.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { readManifest } from "../manifest.js";
import { readLastEntryUuid } from "../jsonl.js";
import {
  readSyncState, writeSyncState, recordSentFromBundle, getThreadId, setThreadId, setLastWorkspace,
  setPeerMemoryDigest, forgetSentToPeer,
} from "../sync-state.js";
import type {
  ErrorResult, HubLockBusyResult, HubNoSuchProjectResult, HubPushFailedResult, HubPushResult,
  HubUnlinkedResult, HubUnreachableResult, ProgressEvent,
} from "../types.js";

export interface HubPushOptions {
  configDir: string;
  projectPath: string;
  hubPath: string;
  sessionIds?: string[];
  /**
   * Send every session in scope WHOLE, by forgetting what this machine believes
   * the hub already holds (`peers["hub:<hubId>"]`) before planning the export.
   *
   * The escape hatch for a hub that can no longer serve what its ledger claims
   * — bundles deleted, or (once encryption lands) encrypted to a key that is
   * gone. Without it the next push ships a delta anchored on a base nobody can
   * read, which is an unreconstructable thread for every other machine. See
   * `forgetSentToPeer` for the exact set of ledgers this covers and the ones it
   * pointedly does not.
   *
   * Three things it is not:
   *
   * - **Not a config key, and never reachable from the SessionEnd auto-push.**
   *   A config key would arm the unattended push to re-upload every session in
   *   the project at every session end, with no channel to disclose it. This is
   *   flag-only, and the flag is on the verb that does the re-uploading, so the
   *   forget and the repair are one operation under one project lock rather
   *   than a cleared ledger waiting for whatever push happens next.
   * - **Not persisted.** The forget is applied to this push's in-memory state
   *   and never written; the ledger on disk is restamped from the bundle that
   *   actually lands (`recordSentFromBundle`). So a `--full` push that dies
   *   before its bundle commits leaves the ledger exactly as it found it.
   * - **Not destructive.** A push copies — nothing local is deleted and nothing
   *   on the hub is overwritten — so the whole cost is bytes and time, which is
   *   why there is no confirmation here. Disclosure is `commands/push.md`'s job.
   *
   * Narrowed by `sessionIds` when both are given: forgetting is scoped to the
   * sessions this push is actually sending.
   */
  full?: boolean;
  noWorkspace?: boolean;
  /**
   * Skip the git-diff carry (design §6.1). Off by default: for a project with
   * a git remote the carry is the only thing that moves work-in-progress, and
   * it never copies a gitignored UNTRACKED file unless `.sesh-mover-include` names it.
   * (A gitignored file that git TRACKS is a different matter: the patch carries
   * its changes and no carry rule filters the patch — see `trackedIgnored`.)
   */
  noCarry?: boolean;
  /**
   * Byte budgets for the two optional payloads, resolved from `hub.carryMaxMb`
   * and `hub.workspaceMaxMb`, plus whatever resolving them had to say.
   *
   * Resolved by the CALLER rather than read here, for the same reason
   * `noWorkspace`/`noCarry` are: this module is handed a decision, not a config
   * directory, and there is exactly one resolver (`resolveHubBudgets`) so the
   * SessionEnd auto-push and the manual push cannot drift. Absent means "use
   * the module defaults", which is what a programmatic caller gets.
   */
  budgets?: { carryMaxBytes: number; workspaceMaxBytes: number; warnings: string[] };
  /**
   * Stamp the manifest's per-session `summary` with the session SLUG instead of
   * an excerpt of the conversation, resolved from `export.noSummary`.
   *
   * The setting is documented as FUNCTIONAL rather than cosmetic — it skips
   * parsing the transcript for a summary at all, so no conversation text reaches
   * the manifest — and the hub is the transport where that matters most: a
   * bundle manifest is uploaded to a shared directory by the default-on,
   * unattended SessionEnd auto-push, which has no channel to disclose what it
   * just sent. It was honoured by `export` and `migrate` and silently dropped
   * here, so every hub bundle carried the excerpt regardless of the setting.
   *
   * Resolved by the CALLER, for the reason `budgets` states: this module is
   * handed a decision, not a config directory. Both callers — the manual `push`
   * and the SessionEnd hook — read it from the same `computeEffectiveConfig`
   * result they already read `hub.noWorkspace`/`hub.carryDiff` from, so the
   * two cannot drift and the user-scope-only setting is not reset by an absent
   * project file (57cd7b7).
   *
   * There is deliberately no `--no-summary` flag on `push` to override it: the
   * push that matters most takes no flags at all, and the summary rides a bundle
   * — an immediate re-push answers `upToDate`, so a flag on the retry would be
   * inert in the one situation you would reach for it.
   */
  noSummary?: boolean;
  projectIdOverride?: string;
  createProject?: boolean;
  claudeVersion: string;
  /**
   * Suppress everything whose only purpose is to be read by a human. Set by the
   * SessionEnd auto-push hook, whose contract is that session exit is never
   * interrupted or narrated (design §4.2) — today that means skipping the
   * `ignoredNotCarried` discovery scan, which also spares an unattended push a
   * `git ls-files` walk of the whole working tree.
   */
  quiet?: boolean;
  onProgress?: (ev: ProgressEvent) => void;
}

/**
 * What this push has actually committed, kept so a LATER failure knows how much
 * of it is this push's to undo and what it must disclose.
 *
 * Linking is the hub's consent gate (see `commitLocalLink`), so every field
 * here is about one question: is this directory linked when the push gives up,
 * and if so, whose link is it? A bundle upload that throws, an index write that
 * throws, a workspace file that turns out to be unreadable — every one of those
 * used to surface as a bare Error with the project silently left linked and the
 * default-on SessionEnd auto-push armed for a push the user just watched fail
 * (measured twice: an `ENOTDIR` at the bundle destination, and an `EACCES`
 * inside the workspace snapshot).
 */
interface PushCommits {
  /** The identity this push resolved to. Set once the export has succeeded. */
  local: LocalProjectId;
  /** Already linked when this push started — someone else's link, not ours to undo. */
  preExisting: boolean;
  /** WE wrote the local link file, so it is ours to roll back. */
  linkWritten: boolean;
  /**
   * `--create-project` minted a NEW hub project, which nothing can remove.
   * Recorded the instant the hub file lands, NOT after the local link — a throw
   * between the two writes is precisely when this is the only thing left
   * behind, and it used to go unmentioned.
   */
  mintedHubProjectId: string | null;
  /** The bundle reached the hub (the index that references it may not have). */
  bundleCommitted: boolean;
}

/**
 * Undo the LOCAL half of a link this push made.
 *
 * Only the local half: there is no `backend.delete` call anywhere in src/, so a
 * hub project a failed push created stays on the hub and in every machine's
 * `linkCandidates` (recorded as out of scope — hub-side deletion needs
 * ownership semantics this slice doesn't have). That asymmetry is why the
 * caller REPORTS what is left rather than claiming a clean rollback.
 *
 * Re-reads before removing: the file is only ours to delete while it still
 * names the project id this push wrote. Anything else means something changed
 * it underneath us, and a link the user (or a concurrent operation) put there
 * is not collateral for our failure.
 *
 * It removes the FILE and nothing else — no rmdir of the parent. There used to
 * be one, and it was safe on the day it was written because the link then lived
 * at `<project>/.claude-sesh-mover/project.json`, so its parent was a directory
 * this plugin owned. Since 0.8.0 the link is the root dotfile
 * `<project>/.sesh-mover-project.json`, whose parent is the USER'S PROJECT
 * DIRECTORY — and `rmdirSync` succeeds on an empty one. A push into an empty
 * (or not-yet-existing) `--project-path` therefore deleted the directory it was
 * asked to push. Nothing needs cleaning up now: this push creates no directory
 * of its own inside the project.
 */
function rollbackLocalLink(
  projectPath: string,
  local: LocalProjectId
): { removed: boolean; detail: string } {
  // The rule itself lives in identity.ts, shared with `hub delete`'s cleanup of
  // a link whose hub project no longer exists. Everything the doc above says is
  // enforced there; this function is the push's name for it.
  return removeLocalProjectIdIfMatches(projectPath, local.projectId);
}

/**
 * The result for a push that threw after the identity was resolved.
 *
 * Typed rather than thrown, like every other refusal in this file, because the
 * one thing the user has to be told is not in the exception: whether this
 * project is linked now. A link means the SessionEnd auto-push will run
 * unattended, and for a git-less project that push uploads the whole working
 * tree. It is also the ONLY way an unattended push's outcome is recorded at all
 * — the hook endpoint calls `recordAutoPushOutcome` on a returned result and a
 * throw skips it (cli.ts).
 *
 * Every branch reports the same facts twice: as `details`/`suggestion` prose for
 * a human, and as the fields of `HubPushFailedResult` for a caller that has to
 * branch on them. See that type for why the prose alone was not enough.
 */
function failedAfterLink(
  projectPath: string,
  commits: PushCommits,
  error: unknown
): HubPushFailedResult {
  const cause = error instanceof Error ? error.message : String(error);
  const projectId = commits.local.projectId;
  // The bundle is atomic (`writeStreamAtomic`), so it is either on the hub or
  // it never existed — but the index that makes it findable is written after
  // it, and a failure in between leaves a real bundle no machine can see.
  const orphanBundle = commits.bundleCommitted
    ? " The bundle itself did reach the hub before the failure, but this machine's index was not updated to reference it, so no other machine can see it."
    : "";
  // Named once here so every branch's `suggestion` agrees: a minted hub project
  // outlives this push whatever happened locally.
  const orphanHubProject = commits.mintedHubProjectId;
  const base = {
    success: false as const,
    command: "push" as const,
    reason: "failed-after-link" as const,
    projectId,
    orphanHubProjectId: orphanHubProject,
    orphanBundle: commits.bundleCommitted,
  };
  const relinkSuggestion = orphanHubProject
    ? `Hub project ${orphanHubProject} was created before the failure and nothing removes a hub project, so pass --project-id ${orphanHubProject} on a later push to link to that one instead of minting a second.`
    : "Fix the cause above and push again; the project links again once a push gets past this point.";

  if (commits.preExisting) {
    return {
      ...base,
      linked: true,
      linkRolledBack: false,
      error: `The push failed: ${cause}`,
      details:
        `This project was already linked to hub project ${projectId} before this push, ` +
        `so it stays linked and nothing about the link changed.${orphanBundle}`,
      suggestion: "Fix the cause above and push again — the project stays linked either way.",
    };
  }

  if (!commits.linkWritten) {
    // The ordinary shape now that the local link is written only once the
    // bundle is on the hub: the failure landed before that, so there is no link
    // to undo and nothing arms the auto-push. The disk is still consulted
    // rather than assumed — a concurrent operation (a `pull --project-id`, a
    // second push) can have linked this directory while we worked, and claiming
    // "not linked" over the top of that is the exact mistake this result exists
    // to stop.
    const linkedNow = readLocalProjectId(projectPath) !== null;
    return {
      ...base,
      linked: linkedNow,
      linkRolledBack: false,
      error: `The push failed: ${cause}`,
      details: linkedNow
        ? `This push wrote no link — it commits one only after the bundle reaches the hub — but this ` +
          `directory IS linked to the hub right now (something else linked it while this push ran), ` +
          `so the SessionEnd auto-push is armed for it.${orphanBundle}`
        : `Nothing was linked: this push commits the local link only after the bundle reaches the hub, ` +
          `so this project is NOT linked and the SessionEnd auto-push stays off for it.${orphanBundle}`,
      suggestion: relinkSuggestion,
    };
  }

  const rollback = rollbackLocalLink(projectPath, commits.local);
  return {
    ...base,
    linked: !rollback.removed,
    linkRolledBack: rollback.removed,
    error: `The push failed after this project was linked to the hub: ${cause}`,
    details: rollback.removed
      ? `The link this push created was removed, so this project is NOT linked to the hub ` +
        `and the SessionEnd auto-push stays off for it.${orphanBundle}`
      : `The link this push created could NOT be removed (${rollback.detail}), so this project IS ` +
        `linked to hub project ${projectId} and the SessionEnd auto-push is armed for it — ` +
        `run \`sesh-mover hub unlink\` (or delete .sesh-mover-project.json) to unlink it.${orphanBundle}`,
    suggestion: relinkSuggestion,
  };
}

/**
 * Everything `hubPush` can answer with, named rather than spelled out inline.
 *
 * A named union is what a library consumer needs in order to write one handler
 * for the verb (`src/index.ts` re-exports this module), and it is the sibling of
 * `HubPullOutcome`. The two refusals at the end arrive from the shared
 * preflight (#75) and are the two that used to be a raw throw.
 */
export type HubPushOutcome =
  | HubPushResult
  | HubUnlinkedResult
  | HubLockBusyResult
  | HubPushFailedResult
  | HubUnreachableResult
  | HubNoSuchProjectResult
  | ErrorResult;

/**
 * `onProgress`'s contract, which is invisible from any single call site — the
 * same note `hubPull` carries, and deliberately the same shape (#74, #78).
 *
 * **`{percent: 0}` is emitted as the first statement inside the outer `try`,
 * and `{percent: 100}` from the inner `finally` that wraps the whole body.**
 * Before that pairing, three exits emitted `0` and never `100` — the export's
 * own failure return, the `failedAfterLink` disclosure, and the rethrow above
 * it — so a consumer waiting for the terminal event waited forever. The close
 * therefore also fires on a typed refusal, on a failed push and on a thrown
 * exception, and `percent: 100` accordingly means *"the operation is over"*,
 * never *"it succeeded"*; the returned result says which.
 *
 * **The exits BEFORE the lock emit nothing at all, and that is the contract
 * rather than an oversight**: `lock-busy` — and a non-busy throw out of
 * `acquireProjectLock` — return above the `try`, so there is no `finally` to
 * close a pair they never opened. A consumer gets either no events or a matched
 * pair. The opening event moved here from just after `registerMachine` for the
 * same reason it moved in `hubPull`: it used to sit below the preflight, so the
 * two refusals that gate a push before it does anything (`hub-unreachable`,
 * `no-such-project`) emitted nothing while the failures emitted an unclosed `0`.
 *
 * **Where push DIFFERS from pull, and why it is not drift.** `hubPull` wraps its
 * terminal emit in a bare `catch` and swallows a throwing callback outright. It
 * has to: it has no `catch` of its own, so a throw from that `finally` would
 * escape as an untyped crash and destroy the typed refusal it was returning.
 * `hubPush` does have one, and that `catch` is the whole disclosure machinery —
 * `failedAfterLink`, which answers the only question that matters after a failed
 * push (*is this directory linked now, and whose link is it?*). So the terminal
 * emit sits INSIDE the region that `catch` guards, and a throw out of the
 * callback is routed through it rather than swallowed. Two things follow, both
 * intended:
 *
 * - It is consistent. Every other progress emission in this function is already
 *   able to fail a push that way — the `0` above, and every event
 *   `exportAllSessions` forwards — so swallowing the terminal one would make it
 *   the single special event rather than the rule.
 * - It preserves a documented, load-bearing behaviour: a callback that throws
 *   right after the link is committed is the deterministic seam
 *   `tests/hub-push.test.ts`'s "refuses to remove a link that now names a
 *   different project" uses to reproduce the concurrent-link-modification race.
 *   The obvious pull-shaped fix (swallow in a `finally`) silently deletes it,
 *   which is why this went unfixed once already.
 *
 * The one case that IS swallowed is a callback throwing while the body is
 * already failing — see the inner `finally`.
 *
 * Between the two events, granularity comes from `exportAllSessions`, which is
 * handed this same callback. The archive step is the hole: `createArchive` takes
 * no callback at all, the same gap `runFetchStage` documents on the pull side.
 */
export async function hubPush(opts: HubPushOptions): Promise<HubPushOutcome> {
  // An empty array is programmatically distinct from "omitted" but must mean
  // the same thing here — otherwise it mints zero threads (the filter below
  // matches nothing) while still exporting every session (exportAllSessions
  // treats [] as "no filter" today), silently over-exporting.
  const sessionIds = opts.sessionIds && opts.sessionIds.length > 0 ? opts.sessionIds : undefined;
  let lock;
  try {
    lock = acquireProjectLock(opts.projectPath);
  } catch (e) {
    if (e instanceof LockBusyError) {
      return {
        success: false, command: "push", reason: "lock-busy",
        holderPid: e.holderPid, ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
        suggestion: "Another sesh-mover hub operation is running for this project — wait for it or retry.",
      };
    }
    throw e;
  }

  // Staging is created inside the protecting try so a mkdtemp failure still
  // releases the lock in the finally (review fix: post-acquire throw window).
  let staging: string | null = null;
  // Declared out here so the catch below can see it (a `catch` cannot see the
  // `try`'s own bindings). `commits` stays null until `resolveIdentity()`
  // returns, which is the line that divides "a throw leaves NOTHING behind, so
  // rethrow as before" from "a throw has something to disclose". Each field is
  // set at the exact moment the thing it describes becomes true — see
  // `PushCommits`.
  let commits: PushCommits | null = null;
  try {
    opts.onProgress?.({ phase: "hub-push", percent: 0 }); // see the doc above
    // Written by the inner `catch` and read by the inner `finally`, and that is
    // its whole job: it is how the terminal event knows whether a failure is
    // already in flight that a throwing callback must not be allowed to
    // replace. See the doc above for why push does not simply swallow.
    let bodyThrew = false;
    try {
      staging = mkdtempSync(join(tmpdir(), "sesh-hub-push-"));
      const backend = createFsBackend(opts.hubPath);
      // BEFORE the identity decision, the export and every hub write: is there a
      // hub here at all, and does `--project-id` name a project on it? Both
      // refusals are worth having only because nothing has happened yet (#75).
      const pre = await preflightHub({
        command: "push", hubPath: opts.hubPath, backend,
        projectIdOverride: opts.projectIdOverride,
      });
      if (pre.kind === "refuse") return pre.result;
      const warnings: string[] = [];
      // A budget that could not be read as written. Said once, up front, rather
      // than folded into the decline it causes — the two are different facts, and
      // on an unattended session-end push this is the only trace of the typo.
      warnings.push(...(opts.budgets?.warnings ?? []));
      if (lock.stoleStale) {
        warnings.push(
          describeLockSteal(lock.steal, "push")
        );
      }
      const machine = loadOrCreateMachineId();

      // Identity — DECIDED here, RESOLVED after the export, LINKED later still.
      //
      // Linking is the hub's consent gate: `.sesh-mover-project.json`
      // existing is what makes `evaluateHookGate` let the default-on SessionEnd
      // auto-push run, and for a git-less project that push uploads the WHOLE
      // project directory. So a link must not be a side effect of a push that
      // then failed. Measured: `push --create-project` in a directory with no
      // sessions returned the exporter's `success: false` ("No sessions found for
      // this project") while having already written project.json and created the
      // hub project — nothing in the result said so, commands/push.md says report
      // and stop, and the next session end uploaded the tree, `.env` included.
      //
      // The write is therefore in three parts, at three different moments:
      //   1. the DECISION (here) — pure, writes nothing at all;
      //   2. `resolveIdentity()`, after the export — the hub-side half, which
      //      `bundleDir()` needs the id from and which the link case's hub read
      //      gates on;
      //   3. `commitLocalLink()`, the local link file, deferred to the two points
      //      where this push has actually delivered something.
      // Every failure before (2) leaves nothing behind; every failure between (2)
      // and (3) leaves an unlinked project (plus, under --create-project, a hub
      // project the result names). Only past (3) is there a link to roll back.
      type PendingIdentity =
        | { kind: "linked"; local: LocalProjectId }
        | { kind: "link"; projectId: string; note?: string }
        | { kind: "create" };
      let pendingIdentity: PendingIdentity;
      if (opts.projectIdOverride) {
        pendingIdentity = { kind: "link", projectId: opts.projectIdOverride };
      } else if (opts.createProject && !readLocalProjectId(opts.projectPath)) {
        pendingIdentity = { kind: "create" };
      } else {
        const resolution = await resolveProjectIdentity(backend, opts.projectPath);
        if (resolution.kind === "linked") pendingIdentity = { kind: "linked", local: resolution.local };
        else if (resolution.kind === "match") {
          pendingIdentity = {
            kind: "link",
            projectId: resolution.hubProject.projectId,
            note: `Linked to hub project ${resolution.hubProject.name} via git remote ${resolution.matchedRemote}.`,
          };
        } else {
          return {
            success: false, command: "push", reason: "unlinked",
            linkCandidates: resolution.candidates,
            suggestion: "Pass --project-id <id> to link to an existing hub project, or --create-project to mint a new one.",
          };
        }
      }
      /**
       * Do the HUB-side half of the identity and hand back the id everything
       * downstream is keyed by. Writes NOTHING under the project directory.
       *
       * The hub write stays here, before the payloads, on purpose. Under
       * `--create-project` the hub `projects/<id>/project.json` must exist before
       * any bundle path under that id is used, or the push leaves bytes on the
       * hub under an id `listHubProjects` skips — undiscoverable residue, and
       * worse than the orphan project this reports. In the link case the read is
       * a real existence gate on `--project-id`.
       */
      const resolveIdentity = async (): Promise<PushCommits> => {
        if (pendingIdentity.kind === "linked") {
          return {
            local: pendingIdentity.local, preExisting: true,
            linkWritten: false, mintedHubProjectId: null, bundleCommitted: false,
          };
        }
        if (pendingIdentity.kind === "create") {
          const minted = await mintHubProject(backend, opts.projectPath, machine.id);
          // Recorded HERE, not after a helper that also writes the local link:
          // a throw in between used to leave `committedLink` null, which made the
          // catch rethrow bare and the orphaned hub project go unmentioned.
          return {
            local: minted, preExisting: false,
            linkWritten: false, mintedHubProjectId: minted.projectId, bundleCommitted: false,
          };
        }
        if (pendingIdentity.note) warnings.push(pendingIdentity.note);
        return {
          local: await readHubProjectAsLocal(backend, pendingIdentity.projectId),
          preExisting: false, linkWritten: false, mintedHubProjectId: null, bundleCommitted: false,
        };
      };

      /**
       * Write the local link — the consent gate itself, and the last thing this
       * push commits.
       *
       * Called from exactly two places, both of them a point where this push HAS
       * delivered: the up-to-date early return (nothing to send, so the link is
       * the whole result — `tests/hub-push.test.ts` pins that deliberate
       * exception), and immediately after the bundle lands on the hub. Everything
       * between the export and the upload — the workspace snapshot, the carry,
       * the archive, the transfer itself — can now fail without arming anything.
       *
       * A pre-existing link is never rewritten: it is already the state this
       * would produce, and rewriting it would put a failed push's fingerprints on
       * a file the user committed to their repository.
       */
      const commitLocalLink = (): void => {
        if (!commits || commits.linkWritten || commits.preExisting) return;
        writeLocalProjectId(opts.projectPath, commits.local);
        commits.linkWritten = true;
      };

      await registerMachine(opts.hubPath);
      // Read once, by the preflight above — a second read here would put back the
      // very `ENOENT` the `hub-unreachable` refusal replaces (#75).
      const hub: HubJson = pre.hub;
      const hubPeerId = `hub:${hub.hubId}`;

      // Thread minting for every session in scope
      let sessions = discoverSessions(opts.configDir, opts.projectPath);
      if (sessionIds) sessions = sessions.filter((s) => sessionIds.includes(s.sessionId));
      const state = readSyncState(opts.projectPath);
      for (const s of sessions) {
        if (!getThreadId(state, s.sessionId)) setThreadId(state, hub.hubId, s.sessionId, randomUUID());
      }
      writeSyncState(state);

      /**
       * `--full`: forget what the hub is believed to already hold, so the export
       * below plans a whole bundle for every session in scope instead of a
       * delta against a base the hub may no longer be able to serve.
       *
       * Applied AFTER the `writeSyncState` above on purpose — that write is the
       * thread minting's, and letting it carry the forget to disk is precisely
       * the persistence `HubPushOptions.full` says this must not have. The
       * mutation lands on the in-memory `state` that the export options below
       * read, so `peerSent` and `peerMemoryDigest` need no `--full` branch of
       * their own: the forget is expressed once, at the ledger, and every
       * reader of it sees the same answer.
       */
      const forgotten = opts.full
        ? forgetSentToPeer(
            state,
            { id: hubPeerId },
            sessionIds ? { localSessionIds: sessionIds } : undefined
          )
        : null;
      const fullResend = forgotten
        ? {
            forgottenSessions: forgotten.forgotten.length,
            forgottenMemoryDigest: forgotten.memoryDigest,
          }
        : undefined;

      // Incremental export against the hub pseudo-peer. One export path:
      // exportAllSessions honors sessionIds (undefined = all) and errors on
      // any requested id that doesn't exist.
      const bundleId = randomUUID();
      const exportResult = await exportAllSessions({
        configDir: opts.configDir,
        projectPath: opts.projectPath,
        sessionIds,
        outputDir: staging,
        name: "bundle",
        excludeLayers: [],
        claudeVersion: opts.claudeVersion,
        noSummary: opts.noSummary,
        incremental: {
          sourceMachineId: machine.id,
          sourceMachineName: machine.name,
          targetMachineId: hubPeerId,
          targetMachineName: "hub",
          peerSent: state.peers[hubPeerId]?.sent ?? {},
          // The memory layer's "already has it" ledger, the whole-file
          // counterpart of `peerSent`. Absent on a first push, which is exactly
          // when the memory must travel — see the memory block in exporter.ts.
          // The hub is the peer here, so this is per-hub bookkeeping like the
          // rest of `state.peers[hubPeerId]`.
          peerMemoryDigest: state.peers[hubPeerId]?.memoryDigest ?? null,
        },
        onProgress: opts.onProgress,
      });
      if (!exportResult.success) {
        // Nothing is linked at this point — see `commitIdentity`. The `command`
        // is restated as this command's own: every CLI result is keyed by the
        // command the user ran (CLAUDE.md), and a `push` answering
        // `"command": "export"` sends a caller that branches on it down a path
        // that does not exist for push.
        return { ...exportResult, command: "push" };
      }
      const bundleStaging = exportResult.exportPath;
      const manifest = readManifest(bundleStaging);
      // The export produced something (even if it is "nothing new"), so this push
      // has earned an identity. Everything above this line leaves an unlinked
      // project unlinked AND has nothing to disclose, so it still rethrows;
      // everything BELOW it is covered by the catch at the bottom of this try
      // (see `PushCommits`).
      commits = await resolveIdentity();
      const local = commits.local;
      // ...and the exporter ran BEFORE any link existed, and it reads the
      // project id off disk (`readLocalProjectId` in exporter.ts). On a
      // `--create-project` push the staged manifest therefore carries no
      // `projectId`, and importer.ts's identity-planting step is what leaves a
      // machine bootstrapping from that bundle linked. Stamp it now — the same
      // in-place manifest patch the workspace and carry blocks below already use.
      if (manifest.projectId !== local.projectId) {
        const manifestPath = join(bundleStaging, "manifest.json");
        const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
        m.projectId = local.projectId;
        writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
        manifest.projectId = local.projectId;
      }
      if (manifest.sessions.length === 0) {
        // Every discovered session's head already matches what the hub has
        // recorded as sent — nothing to push. Return before any hub write
        // (no bundle archive, no index rewrite); the outer finally cleans up
        // staging.
        //
        // The deliberate exception to deferring the link until the bundle is on
        // the hub: this push has nothing to send and so will never reach that
        // point, yet it is a successful push of a project whose `projectId` is
        // part of the result below. A user who lost the committed
        // `.sesh-mover-project.json` gets it back from a no-op push.
        commitLocalLink();
        return {
          success: true, command: "push", projectId: local.projectId,
          bundleId: null, pushedSessions: [], upToDate: true, hasWorkspace: false, warnings,
          // Unreachable under `--full` in practice — a forgotten ledger makes
          // every discovered session a full one, and a project with no sessions
          // at all fails in the exporter above. Reported anyway so the field's
          // contract ("present iff this push reached the ledger with `--full`")
          // holds on every success return rather than on the ones we predicted.
          ...(fullResend ? { fullResend } : {}),
        };
      }

      // Memoized: `git remote -v` is read by the payload capture below AND by
      // the ignored-path discovery aid inside it, and neither runs on the
      // up-to-date early return above — so a quiet auto-push with no workspace
      // still spawns nothing, and a manual push of a git project spawns it once.
      let gitScanCache: GitRemoteScan | null = null;
      const gitScan = (): GitRemoteScan => (gitScanCache ??= scanGitRemotes(opts.projectPath));

      // ONE decision, shared with `sesh-mover export` (#47). Everything about
      // WHICH payload a project takes — including the `unknown` arm that takes
      // neither, which is the security-critical one — lives in
      // `src/payload/capture.ts` so the two transports cannot come to disagree.
      // What stays here is the part that is genuinely the hub's: `basedOn`, the
      // in-place manifest patch, and the generation bookkeeping below.
      const payload = await capturePayload({
        projectPath: opts.projectPath,
        destDir: bundleStaging,
        wantWorkspace: !opts.noWorkspace,
        wantCarry: !opts.noCarry,
        scan: gitScan(),
        scope: "hub",
        workspaceMaxBytes: opts.budgets?.workspaceMaxBytes,
        carryMaxBytes: opts.budgets?.carryMaxBytes,
        // Manual pushes only — the auto-push hook must stay silent at session
        // exit, and the scan is a `git ls-files` walk of the whole tree.
        discoverIgnored: !opts.quiet,
      });
      warnings.push(...payload.warnings);

      const hasWorkspace = payload.workspace !== undefined;
      if (payload.workspace) {
        const manifestPath = join(bundleStaging, "manifest.json");
        const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
        // Declare what this snapshot descends from — read BEFORE the new
        // generation is recorded below. A puller intersects this id with its own
        // generation history, and only a hit makes a 3-way merge legal: it is the
        // proof that a generation was held by both trees, which neither side can
        // establish alone (see the field's doc in types.ts). `file` and
        // `pushedAt` ride along as diagnostics only — the puller resolves the
        // generation through its OWN record, so nothing here becomes a path or a
        // comparison on the other machine.
        //
        // THE ONE FIELD AN EXPORT MUST NOT WRITE. A generation is identified by a
        // hub bundle id, so a `basedOn` minted outside the hub would name an id
        // no hub bundle has, in the set `chooseMergeAncestor` treats as proof
        // that a generation was common to both trees. That is why this stays in
        // push.ts rather than moving into `capturePayload` with the rest.
        const basedOnRef = readSyncState(opts.projectPath).hub?.lastWorkspace;
        m.workspace = {
          ...payload.workspace,
          basedOn: basedOnRef
            ? { bundleId: basedOnRef.bundleId, file: basedOnRef.file, pushedAt: basedOnRef.pushedAt }
            : null,
        };
        writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
      }

      const carryMeta: CarryMeta | undefined = payload.carry;
      if (carryMeta) {
        const manifestPath = join(bundleStaging, "manifest.json");
        const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
        m.carry = carryMeta;
        writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
      }

      // Archive + stream into hub
      const pushedAt = new Date().toISOString();
      const archiveTmp = join(staging, "bundle.tar.gz");
      await createArchive(bundleStaging, archiveTmp, "gzip");
      const hubFile = `${bundleDir(local.projectId, machine.id)}/${bundleFileName(pushedAt, bundleId)}`;
      const w = await backend.writeStreamAtomic(hubFile);
      try {
        await pipeline(createReadStream(archiveTmp), w.stream);
        await w.commit();
        commits.bundleCommitted = true;
      } catch (e) {
        await w.abort();
        throw e;
      }
      // The bundle is on the hub, so this push has delivered: link the project.
      // Deferred all the way to here (rather than to just after the export) so
      // that a workspace snapshot that trips over an unreadable file, a carry
      // that cannot be captured, a full disk under the archive or a share that
      // vanished mid-upload all leave this directory unlinked and the SessionEnd
      // auto-push unarmed. Past this line there IS a link, and a later failure
      // rolls it back and says so.
      commitLocalLink();

      // Peer bookkeeping from the staged bundle (snapshot, never live files)
      recordSentFromBundle(opts.projectPath, { id: hubPeerId, name: "hub" }, bundleStaging);

      // The workspace generation this machine's tree now shares with the hub —
      // the ancestor input for the next pull's 3-way merge (design §5.2). Only
      // recorded once the bundle is committed to the hub: a generation the hub
      // does not hold cannot be fetched back as an ancestor.
      //
      // It describes the SNAPSHOT, not the live tree: anything the user edited
      // between snapshotWorkspace above and this line is a local change against
      // this generation, which is exactly what the next merge should see.
      //
      // Read AFTER recordSentFromBundle — that helper rewrites the same file, so
      // mutating a copy read before it would be silently discarded.
      //
      // `manifest.memoryDigest` rides along in the same read/write for the same
      // reason and under the same rule: it is the digest of the `memory/`
      // directory THIS bundle carries, and crediting the hub with it is only
      // truthful once the bundle is on the hub. A push that failed above this
      // line leaves the ledger untouched, so the next push ships the memory
      // again — which is the direction an unknown must fail in (exporter.ts).
      //
      // Note what this does NOT cover: the `manifest.sessions.length === 0`
      // early return above never reaches here, so changed memory with no new
      // session content travels with the next push that has some. That matches
      // the workspace and carry payloads, which the same early return skips.
      if (hasWorkspace || manifest.memoryDigest) {
        const stateWs = readSyncState(opts.projectPath);
        if (hasWorkspace) {
          setLastWorkspace(stateWs, hub.hubId, { bundleId, file: hubFile, pushedAt });
        }
        if (manifest.memoryDigest) {
          setPeerMemoryDigest(stateWs, { id: hubPeerId, name: "hub" }, manifest.memoryDigest);
        }
        writeSyncState(stateWs);
      }

      // Index projection
      const stateAfter = readSyncState(opts.projectPath);
      const records: Array<{ threadId: string; record: HubBundleRecord }> = [];
      const pushedSessions: HubPushResult["pushedSessions"] = [];
      for (const s of manifest.sessions) {
        const localSessionId =
          s.type === "continuation" && s.continuation ? s.continuation.continuesLocalSessionId : s.sessionId;
        const threadId = getThreadId(stateAfter, localSessionId);
        if (!threadId) { warnings.push(`no thread mapping for pushed session ${s.sessionId} — index skipped it.`); continue; }
        records.push({
          threadId,
          record: {
            bundleId, file: hubFile,
            type: s.type === "continuation" ? "continuation" : "full",
            sessionIdInBundle: s.sessionId,
            fromEntryUuid: s.continuation?.fromEntryUuid ?? null,
            // Three-valued on purpose (see HubBundleRecord): `null` for a full
            // bundle, the manifest's anchor for a continuation, and `undefined`
            // — which JSON.stringify drops — for a continuation whose manifest
            // predates the field. `?? null` here would flatten "unknown" into
            // "root" and manufacture a second root for the thread.
            //
            // Keyed on the same `s.type` test as the record's own `type` two
            // lines up, so `type: "full"` and `anchorEntryUuid: null` can never
            // disagree: only a bundle that really is full claims "no anchor
            // exists". A continuation missing its block is unknown, not a root.
            anchorEntryUuid: s.type === "continuation" ? s.continuation?.anchorEntryUuid : null,
            headEntryUuid: readLastEntryUuid(join(bundleStaging, "sessions", `${s.sessionId}.jsonl`)) ?? "",
            messageCount: s.messageCount, pushedAt, hasWorkspace,
          },
        });
        pushedSessions.push({ threadId, sessionId: s.sessionId, type: s.type === "continuation" ? "continuation" : "full" });
      }
      // No `summary` here: `buildIndexFile` derives the thread entry's from the
      // slug, and is the only thing that writes it (see index-file.ts).
      const sessionsNow = discoverSessions(opts.configDir, opts.projectPath).map((s) => ({
        sessionId: s.sessionId, slug: s.slug,
        headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
        messageCount: s.messageCount, lastActiveAt: s.lastActiveAt,
      }));
      const prior = await readMachineIndex(backend, local.projectId, machine.id);
      await writeMachineIndex(backend, buildIndexFile({
        projectId: local.projectId, machineId: machine.id, projectPath: opts.projectPath,
        sessions: sessionsNow, state: stateAfter, priorIndex: prior, newBundles: records,
        now: pushedAt,
      }));

      // Discovery aid (design §6.0): name what .gitignore kept out, so the user
      // can opt paths back in via the include list without having to know the
      // file exists. Computed by `capturePayload` — same rule, both transports —
      // and reported here.
      const ignoredNotCarried = payload.ignoredNotCarried;

      return {
        success: true, command: "push", projectId: local.projectId,
        bundleId, pushedSessions, upToDate: false, hasWorkspace, warnings,
        ...(ignoredNotCarried ? { ignoredNotCarried } : {}),
        ...(carryMeta ? { carry: carryMeta } : {}),
        ...(fullResend ? { fullResend } : {}),
      };
    } catch (e) {
      bodyThrew = true;
      throw e;
    } finally {
      /**
       * The terminal event, and the ONE place it is emitted — see the doc on
       * `hubPush` for the contract and for why a throw out of it is treated as
       * a push failure here while `hubPull` swallows its own.
       *
       * Rethrown only when the body did NOT fail. A caller callback that throws
       * while a real failure is already propagating would otherwise replace it,
       * and `failedAfterLink` would report the consumer's message as the cause
       * of a push that actually died of an `ENOTDIR` at the bundle destination.
       * The push still fails in that case; it fails with its own reason.
       */
      try {
        opts.onProgress?.({ phase: "hub-push", percent: 100 });
      } catch (e) {
        if (!bodyThrew) throw e;
      }
    }
  } catch (e) {
    // A throw before the identity was resolved leaves nothing behind, so it
    // keeps its existing behavior exactly: rethrow, and cli.ts turns it into an
    // ErrorResult. Past that line there is something to disclose — a link, a
    // minted hub project, a bundle no index references, or simply the fact that
    // none of those happened — and the disclosure is the result, not the
    // exception. It is also what the SessionEnd hook records: it calls
    // `recordAutoPushOutcome` on a RETURNED result, and a throw skips it, so a
    // rethrow here would erase the failure of every unattended push.
    // The hub stopped answering PART WAY THROUGH — it was reachable at the
    // preflight (which is two syscalls earlier) and is not now. Nothing was
    // committed, so it is the same fact `preflightHub` would have reported a
    // moment sooner, and it gets the same typed refusal rather than escaping as
    // an untyped `ErrorResult` (#71). Returning rather than throwing also keeps
    // the unattended path's breadcrumb: `recordAutoPushOutcome` reads a RETURNED
    // result and a throw skips it, so this is the difference between `hub
    // status` explaining a wedged share and saying nothing at all.
    //
    // Past `commits` the disclosure wins instead: which of the link, the hub
    // project and the bundle survived is more urgent than which errno ended it,
    // and `failedAfterLink` carries the message anyway.
    if (e instanceof HubIoTimeoutError && !commits) {
      return hubUnreachableRefusal("push", "unresponsive");
    }
    if (!commits) throw e;
    return failedAfterLink(opts.projectPath, commits, e);
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    lock.release();
  }
}
