/**
 * # `hub compact` — consolidate a thread, retire the chain behind it (#92)
 *
 * A thread that has been pushed from two machines for a month is a root bundle
 * plus a long tail of continuations, every one of which has to be fetched and
 * applied in order for a fresh machine to read the conversation. This verb
 * replaces that tail with a single full bundle and then removes the tail.
 *
 * ---------------------------------------------------------------------------
 * ## Consolidation is not a fourth implementation, and that is the point
 *
 * "Produce a fresh full bundle for these sessions and push it" already exists,
 * in exactly one place, with four callers waiting for it: `push --full`,
 * key-loss recovery, and the four fallbacks in `diff.ts` that degrade an
 * incremental push to a whole one. This verb becomes the next CALLER of that,
 * not a second copy — it invokes `hubPush({ sessionIds, full: true })` and adds
 * nothing to the push path. Encryption, the upload seam, the workspace
 * artifact, `.age` naming and the un-keyed refusal all come along for free
 * because none of them ever knew about `full` in the first place.
 *
 * ## Two phases, deliberately across invocations
 *
 * The wait between them is measured in days, so it cannot be a wait *inside*
 * one run: the same-machine lock is stolen from a live holder at 60 minutes,
 * and the victim is not told. So each run takes the lock, does the phase it
 * can, and releases.
 *
 * 1. **Consolidate.** Push a full bundle. Nothing is deleted, nothing is even
 *    promised. If the run dies here the hub holds an unreferenced orphan, which
 *    is the shape `push` already discloses and the larger state.
 * 2. **Retire**, on a later run, once every machine has acknowledged AND the
 *    consolidated bundle has sat for `COMPACTION_GRACE_MS`. Write the marker,
 *    remove our own index records, then delete the files.
 *
 * A run that finds phase 1 already done goes straight to phase 2, so the verb
 * is idempotent and re-runnable — the same property `rekey` has, for the same
 * reason: the interesting failures are partial ones.
 *
 * ## The ordering is the failure contract
 *
 * New bytes before any reference to them; references removed before the bytes
 * they point at. Every interruption therefore leaves the LARGER state, which is
 * #92's criterion verbatim:
 *
 *   upload consolidated bundle → add its record (old records still live)
 *   → [days] → write marker → remove old records → delete old files
 *
 * The marker goes first among the removals because it is the bookkeeping that
 * makes an interrupted run finishable, exactly as `orderForDeletion` puts
 * tombstones last for the mirror-image reason. It is not deleted at the end:
 * unlike a tombstone it has a second job that outlives the operation, telling
 * other machines' readers why a file they still reference is gone.
 *
 * ## What this verb cannot do, stated rather than discovered
 *
 * - **It retires only THIS machine's bundles** (owner ruling). A chain can span
 *   machines and bundle files live in per-machine directories, so retiring all
 *   of it would mean deleting another machine's files — which per-machine
 *   ownership forbids for everything except `hub delete`'s owner-only,
 *   two-phase, whole-project path. Each machine reclaims its own share. The
 *   result says so rather than reporting a partial job as a complete one.
 * - **It cannot stop a pull that is already in flight.** Nothing can; the
 *   alternative is aborting a half-applied transcript splice. A reader that
 *   loses a file mid-chain fails loudly, typed, with earlier bundles already
 *   applied and recorded, and its retry lands on the consolidated bundle. That
 *   is the failure budget `COMPACTION_GRACE_MS` is sized against.
 * - **It trusts what other machines published**, exactly as everything else on
 *   this hub does. Acknowledgement is a self-report. #86 is the answer to that,
 *   for all of it at once.
 */

import { createFsBackend, type HubBackend } from "./backend.js";
import {
  compactionDirPath,
  compactionPath,
  type HubBundleRecord,
  type HubCompactionEntry,
  type HubCompactionJson,
  type HubIndexJson,
} from "./layout.js";
import { buildIndexFile, readAllIndexes, readMachineIndex, writeMachineIndex } from "./index-file.js";
import { acquireProjectLock } from "./lock.js";
import { deleteHubFile } from "./retire.js";
import { readLocalProjectId } from "./identity.js";
import { hubUnreachableRefusal, probeHubReachable } from "./preflight.js";
import { COMPACTION_GRACE_MS, planAck, planRetirement } from "./compact-plan.js";
import { hubPush } from "./push.js";
import { errorMessage } from "../errors.js";
import { discoverSessions } from "../discovery.js";
import { readLastEntryUuid } from "../jsonl.js";
import { loadOrCreateMachineId } from "../machine.js";
import { forgetSentToPeer, peekSyncState, readSyncState, writeSyncState } from "../sync-state.js";
import type {
  ErrorResult,
  HubCompactPendingResult,
  HubCompactResult,
  HubCompactRefusedResult,
  HubLockBusyResult,
  HubUnreachableResult,
  SyncState,
} from "../types.js";

/**
 * Every entry uuid in a set of local transcripts.
 *
 * Read from the LOCAL files rather than from the bundle that was just uploaded,
 * because they are the same bytes — a full export is a byte copy — and reading
 * the local one needs no download, no decryption and no temp directory. The
 * cost is one pass per session; a long transcript is a few thousand short
 * strings, which is nothing beside the upload this verb has already done.
 *
 * A file that cannot be read contributes NOTHING rather than failing the run,
 * and the effect of that is to keep bundles: `planRetirement` deletes only what
 * this set positively contains. An unreadable transcript therefore retires
 * nothing, which is the direction to fail in.
 */
async function collectEntryUuids(jsonlPaths: readonly string[]): Promise<Set<string>> {
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const uuids = new Set<string>();
  for (const path of jsonlPaths) {
    try {
      const rl = createInterface({
        input: createReadStream(path, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (line === "") continue;
        try {
          const uuid = (JSON.parse(line) as { uuid?: unknown }).uuid;
          // The same structural test `isConversationEntry` applies: a non-empty
          // string uuid, never a type allowlist, which would go stale on the
          // next Claude Code release. A bookkeeping line has none and is simply
          // absent from the set — correct, since no bundle head points at one.
          if (typeof uuid === "string" && uuid !== "") uuids.add(uuid);
        } catch {
          // One unparseable line is not a reason to abandon the file. It
          // contributes no uuid, so it can only cause a bundle to be KEPT.
        }
      }
    } catch {
      // Unreadable file: contributes nothing, retires nothing. See above.
    }
  }
  return uuids;
}

/** The local session ids this machine has mapped to a thread. */
export function localSessionsForThread(state: SyncState, threadId: string): string[] {
  const map = state.hub?.threadByLocalSession ?? {};
  return Object.keys(map).filter((localId) => map[localId] === threadId);
}

/**
 * The consolidated bundle for a thread: the NEWEST full record this machine
 * lists for it.
 *
 * Newest by position rather than by `pushedAt`, deliberately. `pushedAt` is the
 * pushing machine's wall clock and is a diagnostic only — ordering hub state by
 * it reinstates a measured silent-revert bug under clock skew. Index order is
 * append order, written by this machine, and this is this machine's own index.
 */
export function findConsolidated(records: readonly HubBundleRecord[]): HubBundleRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === "full") return records[i];
  }
  return null;
}

/** Strip records from one thread of a prior index, leaving everything else. */
function withoutRecords(
  index: HubIndexJson,
  threadId: string,
  removeBundleIds: ReadonlySet<string>
): HubIndexJson {
  const entry = index.threads[threadId];
  if (!entry) return index;
  return {
    ...index,
    threads: {
      ...index.threads,
      [threadId]: {
        ...entry,
        bundles: entry.bundles.filter((r) => !removeBundleIds.has(r.bundleId)),
      },
    },
  };
}

async function readCompactionFile(
  backend: HubBackend,
  projectId: string,
  machineId: string
): Promise<HubCompactionJson> {
  const p = compactionPath(projectId, machineId);
  const empty: HubCompactionJson = {
    schemaVersion: 1,
    projectId,
    machineId,
    compactions: [],
  };
  if (!(await backend.exists(p))) return empty;
  try {
    const parsed = JSON.parse((await backend.read(p)).toString()) as HubCompactionJson;
    // Shape-checked rather than trusted: this is a file read off a shared
    // directory, and a malformed one must not make the verb throw. An
    // unreadable marker degrades to "no prior compactions recorded", which
    // costs a stale entry rather than a deletion.
    if (!Array.isArray(parsed?.compactions)) return empty;
    return { ...empty, compactions: parsed.compactions.filter((c) => Array.isArray(c?.retiredBundleIds)) };
  } catch {
    return empty;
  }
}

/**
 * Drop marker entries no index anywhere still references.
 *
 * The marker exists to answer a reader holding a stale record. Once no machine
 * lists any of a retired bundle's ids, that entry has no reader left and is
 * pure growth. Pruned here rather than on a timer, because "is anyone still
 * pointing at this" is exactly the question the indexes answer and a clock is
 * not.
 */
export function pruneCompactions(
  compactions: readonly HubCompactionEntry[],
  indexes: readonly HubIndexJson[]
): HubCompactionEntry[] {
  const referenced = new Set<string>();
  for (const index of indexes) {
    for (const entry of Object.values(index.threads)) {
      for (const r of entry.bundles) referenced.add(r.bundleId);
    }
  }
  return compactions.filter((c) => c.retiredBundleIds.some((id) => referenced.has(id)));
}

export interface HubCompactOptions {
  configDir: string;
  projectPath: string;
  hubPath: string;
  /** Which thread to compact. Required — see `cli.ts` for the listing mode. */
  threadId: string;
  claudeVersion: string;
  /** Test seam. Real runs leave it unset and take the wall clock. */
  nowMs?: number;
}

export { COMPACTION_GRACE_MS };

export type HubCompactOutcome =
  | HubCompactResult
  | HubCompactPendingResult
  | HubCompactRefusedResult
  | HubLockBusyResult
  | HubUnreachableResult
  | ErrorResult;

/**
 * The verb.
 *
 * Preflight order is `hub rekey`'s, and for its reasons: the local link first
 * (a read of the user's own project, whose answer cannot be wrong because the
 * hub is unmounted), then reachability BEFORE the lock — so a wedged concurrent
 * operation cannot turn "unmounted share" into "lock busy".
 *
 * The lock is taken only for the RETIRE half. Phase 1 delegates to `hubPush`,
 * which takes it itself; taking it here as well would deadlock against our own
 * push, and holding it across the days-long wait between phases would lose it
 * to the 60-minute live-holder ceiling anyway — silently, since the thief does
 * not tell the victim.
 */
export async function hubCompact(opts: HubCompactOptions): Promise<HubCompactOutcome> {
  const local = readLocalProjectId(opts.projectPath);
  if (!local) {
    return {
      success: false,
      command: "hub-compact",
      reason: "unlinked",
      error: "This project is not linked to a hub project — it has no chain to compact.",
      suggestion: "Run push (with --create-project or --project-id) to link and publish this project first.",
    };
  }

  const backend = createFsBackend(opts.hubPath);
  const probe = await probeHubReachable(opts.hubPath, backend);
  if (probe.state !== "ok") return hubUnreachableRefusal("hub-compact", probe.state);

  const me = loadOrCreateMachineId();
  const projectId = local.projectId;
  const warnings: string[] = [];
  const nowMs = opts.nowMs ?? Date.now();

  const ownIndex = await readMachineIndex(backend, projectId, me.id, warnings);
  const entry = ownIndex?.threads[opts.threadId];
  if (!ownIndex || !entry) {
    return {
      success: false,
      command: "hub-compact",
      error: `This machine's index lists no thread ${opts.threadId} for this project.`,
      suggestion:
        "Compaction consolidates from the machine that holds the thread. Run `sesh-mover whereis` to see which machine that is, and compact there — this one has nothing of its own to retire.",
    };
  }

  // PHASE 1 — is there a full bundle with nothing after it? Anything after the
  // newest full record is history the consolidation would not contain, so a
  // consolidated bundle is owed. This is also the re-run case: a thread worked
  // on since the last compaction simply consolidates again.
  const lastFullAt = entry.bundles.map((r) => r.type).lastIndexOf("full");
  if (lastFullAt === -1 || lastFullAt < entry.bundles.length - 1) {
    const sessionIds = localSessionsForThread(peekSyncState(opts.projectPath), opts.threadId);
    if (sessionIds.length === 0) {
      return {
        success: false,
        command: "hub-compact",
        error: `No local session on this machine is mapped to thread ${opts.threadId}.`,
        suggestion:
          "A consolidated bundle is a fresh FULL export of the transcript, so it can only be produced by a machine that holds one. Pull the thread here first, or compact on the machine that has it.",
      };
    }

    // DROP THE MEMORY CREDIT FIRST, and persist it — this is the one thing
    // consolidation needs that `push --full` does not do for itself.
    //
    // The credit means "the hub already holds this exact memory directory", and
    // it is true only while the bundle carrying that copy is still there. This
    // run intends to delete exactly those bundles, so left standing it makes
    // the consolidated bundle omit `memory/` while the only hub copy of it goes
    // away — and a machine bootstrapping from the consolidated root then never
    // receives the project's memory at all, silently.
    //
    // `hubPush` re-reads sync-state from disk, so this has to be written rather
    // than mutated in memory. Persisting it is a deliberate divergence from
    // what push does with its own `--full` forget, which it leaves unpersisted
    // so a failed run retries as a full one. The asymmetry is safe in this
    // direction and only this one: the worst a forgotten credit costs is
    // re-sending a memory directory the hub already had, which is the failure
    // direction `forgetSentToPeer` is explicitly allowed to take.
    const hub = peekSyncState(opts.projectPath).hub;
    if (hub?.hubId) {
      const state = readSyncState(opts.projectPath);
      forgetSentToPeer(state, { id: `hub:${hub.hubId}` }, {
        localSessionIds: sessionIds,
        memoryDigest: true,
      });
      writeSyncState(state);
    }

    // The one call. Consolidation IS `push --full` narrowed to this thread's
    // sessions — not a second implementation of it — so encryption, the upload
    // seam, the workspace artifact and the un-keyed refusal all apply
    // unchanged, none of them having ever known about `full`.
    const pushed = await hubPush({
      configDir: opts.configDir,
      projectPath: opts.projectPath,
      hubPath: opts.hubPath,
      claudeVersion: opts.claudeVersion,
      sessionIds,
      full: true,
    });
    if (!pushed.success) return pushed as HubCompactOutcome;

    const after = await readMachineIndex(backend, projectId, me.id, warnings);
    const consolidated = findConsolidated(after?.threads[opts.threadId]?.bundles ?? []);
    warnings.push(...pushed.warnings);
    warnings.push(
      "Nothing has been deleted. The consolidated bundle is on the hub and is already what a reader fetches; the chain behind it stays until every machine has demonstrably got the content and the grace window has passed. Re-run this command later to finish the job."
    );
    return {
      success: true,
      command: "hub-compact",
      phase: "consolidated",
      threadId: opts.threadId,
      consolidatedBundleId: consolidated?.bundleId ?? "",
      warnings,
    };
  }

  // PHASE 2 — retire.
  const consolidated = entry.bundles[lastFullAt];
  const suggestionForPending =
    "Nothing is broken while this is the answer: the consolidated bundle is on the hub and is already what a reader fetches. Re-run this command when the machines below have pulled.";

  if (consolidated.headEntryUuid === "") {
    // Nothing can ever chain onto or acknowledge an empty head, so the wait
    // would never end. Say so rather than reporting an empty outstanding list
    // and looking like a bug.
    return {
      success: false,
      command: "hub-compact",
      reason: "compaction-pending",
      threadId: opts.threadId,
      consolidatedBundleId: consolidated.bundleId,
      outstanding: [],
      warnings: [
        "The consolidated bundle advertises no head entry, which happens when the transcript ends in a run of uuid-less bookkeeping lines. No machine can acknowledge content it cannot name, so this can never become eligible as it stands — continue the conversation and push again, then re-run.",
      ],
      suggestion: suggestionForPending,
    };
  }

  const eligibleAtMs = Date.parse(consolidated.pushedAt) + COMPACTION_GRACE_MS;
  const { indexes, warnings: indexWarnings } = await readAllIndexes(backend, projectId);
  warnings.push(...indexWarnings);

  const sessions = discoverSessions(opts.configDir, opts.projectPath);
  const threadSessions = new Set(
    localSessionsForThread(peekSyncState(opts.projectPath), opts.threadId)
  );
  const uuids = await collectEntryUuids(
    sessions.filter((s) => threadSessions.has(s.sessionId)).map((s) => s.jsonlPath)
  );
  const retirement = planRetirement({
    ownRecords: entry.bundles,
    consolidatedBundleId: consolidated.bundleId,
    coversUuid: (u) => uuids.has(u),
  });

  const ack = planAck({
    indexes,
    threadId: opts.threadId,
    machineId: me.id,
    consolidatedHead: consolidated.headEntryUuid,
    retiringBundleIds: retirement.deletable.map((r) => r.bundleId),
  });

  if (ack.outstanding.length > 0 || nowMs < eligibleAtMs) {
    const { createMachineNameLookup } = await import("./whereis.js");
    const nameOf = createMachineNameLookup(backend);
    if (nowMs < eligibleAtMs) {
      warnings.push(
        `The consolidated bundle is younger than the ${Math.round(COMPACTION_GRACE_MS / 3_600_000)}-hour grace window. That window is not about propagation — acknowledgement already proves receipt — it is the only defence against a pull that is in flight RIGHT NOW, and against a machine whose interrupted pull left it holding content it never published.`
      );
    }
    return {
      success: false,
      command: "hub-compact",
      reason: "compaction-pending",
      threadId: opts.threadId,
      consolidatedBundleId: consolidated.bundleId,
      outstanding: await Promise.all(
        ack.outstanding.map(async (o) => ({
          machineId: o.machineId,
          machineName: await nameOf(o.machineId),
          reason: o.reason,
          advertisedHead: o.advertisedHead,
        }))
      ),
      eligibleAt: new Date(eligibleAtMs).toISOString(),
      warnings,
      suggestion: suggestionForPending,
    };
  }

  if (retirement.deletable.length === 0) {
    return {
      success: true,
      command: "hub-compact",
      phase: "retired",
      threadId: opts.threadId,
      consolidatedBundleId: consolidated.bundleId,
      retiredBundleIds: [],
      retained: retirement.retained,
      warnings: [
        ...warnings,
        "Nothing to retire: every record this machine lists for the thread is either the consolidated bundle itself or one the consolidated transcript does not contain. The second kind is kept deliberately — see `retained`.",
      ],
    };
  }

  return await retirePhase({
    backend, opts, me, projectId, ownIndex, consolidated, retirement, warnings, nowMs,
  });
}

/**
 * The deleting half, under the project lock.
 *
 * **The order is the failure contract**, and each step is chosen by what an
 * interruption immediately after it leaves behind:
 *
 * 1. **Re-verify acknowledgement under the lock.** Cheap — one index sweep —
 *    and it narrows the window between deciding and deleting. It cannot CLOSE
 *    it: the lock is same-machine only and nothing on a shared directory can
 *    exclude another machine's reader. Narrowing is still worth doing.
 * 2. **Write the marker.** It names the doomed bundles before any of them is
 *    gone, so an interrupted run is finishable and, more importantly, a peer
 *    that meets a missing file has something true to read. Crash here: nothing
 *    deleted, one marker naming files that all still exist — harmless, and the
 *    next run rewrites it.
 * 3. **Remove the records from THIS machine's index.** After this, nothing we
 *    publish points a reader at a file we are about to delete. Crash here: the
 *    files are unreferenced by us and still present — the larger state, and the
 *    marker enumerates them so a re-run finishes.
 * 4. **Delete the bundle files, oldest first.** Oldest first because the chain
 *    is dead the moment any link in it is gone, so the only question left is
 *    what a racing reader sees: a missing BASE fails it at the pre-flight
 *    existence sweep, before anything is applied, which is the cleanest of the
 *    typed failures. A missing head fails it mid-chain, after work.
 * 5. **Delete the workspace artifacts last.** Losing one degrades a peer's
 *    3-way merge to no-ancestor — keep-local plus visible conflicts — where
 *    losing a bundle breaks a chain outright. The gentler loss survives longer
 *    under interruption.
 *
 * A file that will not delete is recorded and the run continues, exactly as
 * `rekey` does: a bundle that survived is a file that still exists, which is
 * the harmless direction, and re-running finishes the job.
 */
async function retirePhase(args: {
  backend: HubBackend;
  opts: HubCompactOptions;
  me: { id: string };
  projectId: string;
  ownIndex: HubIndexJson;
  consolidated: HubBundleRecord;
  retirement: { deletable: HubBundleRecord[]; retained: Array<{ bundleId: string; why: string }> };
  warnings: string[];
  nowMs: number;
}): Promise<HubCompactOutcome> {
  const { backend, opts, me, projectId, ownIndex, consolidated, retirement, warnings } = args;

  let lock;
  try {
    lock = acquireProjectLock(opts.projectPath);
  } catch (e) {
    const { LockBusyError } = await import("./lock.js");
    if (e instanceof LockBusyError) {
      return {
        success: false,
        command: "hub-compact",
        reason: "lock-busy",
        holderPid: e.holderPid,
        ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
        error: e.message,
        suggestion:
          "Another sesh-mover hub operation is running for this project — wait for it and re-run. There is deliberately no override here: what it would be racing is a push writing new bundles into the very thread being compacted.",
      };
    }
    throw e;
  }

  try {
    const doomed = retirement.deletable;
    const doomedIds = new Set(doomed.map((r) => r.bundleId));

    // 1. Re-verify under the lock. A machine that fell behind between the check
    //    and here is a machine we must not delete out from under.
    const { indexes } = await readAllIndexes(backend, projectId);
    const recheck = planAck({
      indexes,
      threadId: opts.threadId,
      machineId: me.id,
      consolidatedHead: consolidated.headEntryUuid,
      retiringBundleIds: [...doomedIds],
    });
    if (recheck.outstanding.length > 0) {
      return {
        success: false,
        command: "hub-compact",
        reason: "compaction-pending",
        threadId: opts.threadId,
        consolidatedBundleId: consolidated.bundleId,
        outstanding: recheck.outstanding.map((o) => ({
          machineId: o.machineId,
          machineName: null,
          reason: o.reason,
          advertisedHead: o.advertisedHead,
        })),
        warnings: [
          ...warnings,
          "A machine's index changed between this run's check and its lock, so nothing was deleted. That is the check doing its job, not an error — re-run.",
        ],
        suggestion: "Re-run once the machines listed have pulled.",
      };
    }

    // 2. The marker, before anything is gone.
    const existing = await readCompactionFile(backend, projectId, me.id);
    const marker: HubCompactionJson = {
      schemaVersion: 1,
      projectId,
      machineId: me.id,
      compactions: [
        ...pruneCompactions(existing.compactions, indexes),
        {
          threadId: opts.threadId,
          consolidatedBundleId: consolidated.bundleId,
          retiredBundleIds: [...doomedIds],
          compactedAt: new Date(args.nowMs).toISOString(),
        } satisfies HubCompactionEntry,
      ],
    };
    await backend.writeAtomic(
      compactionPath(projectId, me.id),
      JSON.stringify(marker, null, 2) + "\n"
    );

    // 3. Our own index, without them. Through `buildIndexFile` rather than a
    //    bespoke write, so the projection stays the single definition of what an
    //    index contains — this call differs from a push's only in the prior
    //    index it is handed.
    const sessions = discoverSessions(opts.configDir, opts.projectPath);
    await writeMachineIndex(
      backend,
      buildIndexFile({
        projectId,
        machineId: me.id,
        projectPath: opts.projectPath,
        // The same projection `push` feeds it, field for field — including
        // `readLastEntryUuid` rather than anything off `DiscoveredSession`,
        // because a transcript is bracketed by uuid-less bookkeeping entries and
        // the literal last line is routinely one of them. No `summary`:
        // `buildIndexFile` derives it from the slug and is the only writer.
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          slug: s.slug,
          headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
          messageCount: s.messageCount,
          lastActiveAt: s.lastActiveAt,
        })),
        state: peekSyncState(opts.projectPath),
        priorIndex: withoutRecords(ownIndex, opts.threadId, doomedIds),
        newBundles: [],
        now: new Date(args.nowMs).toISOString(),
      })
    );

    // 4/5. Bytes. Oldest first, bundles before workspace artifacts.
    const failed: Array<{ file: string; error: string }> = [];
    const removeFile = async (file: string): Promise<void> => {
      try {
        await deleteHubFile(backend, file);
      } catch (e) {
        failed.push({ file, error: errorMessage(e) });
      }
    };
    for (const r of doomed) await removeFile(r.file);
    for (const r of doomed) {
      if (!r.hasWorkspace) continue;
      // Derived, not recorded: since #91 a workspace artifact is named by the
      // same `bundleFileName` grammar as its bundle, in this machine's own
      // `workspaces/` directory. Probed first because `hasWorkspace` is also
      // true for a PRE-#91 bundle, whose tree lived inside the archive and has
      // no separate file — deleting a name that was never written would report
      // a failure for a file that never existed.
      const { workspaceDir, bundleFileName, isEncryptedBundleFile } = await import("./layout.js");
      const artifact = `${workspaceDir(projectId, me.id)}/${bundleFileName(r.pushedAt, r.bundleId, { encrypted: isEncryptedBundleFile(r.file) })}`;
      if (await backend.exists(artifact)) await removeFile(artifact);
    }

    if (failed.length > 0) {
      warnings.push(
        `${failed.length} file(s) could not be removed and are listed in \`failed\`. They are no longer referenced by this machine's index, so nothing reads them; re-run to finish the job.`
      );
    }
    warnings.push(
      "Only THIS machine's bundles were retired. If this thread's history was pushed from more than one machine, each machine reclaims its own share by running this command there — one machine deleting another's files is what per-machine ownership forbids, and it is what makes concurrent push and pull safe with no distributed lock."
    );

    return {
      success: true,
      command: "hub-compact",
      phase: "retired",
      threadId: opts.threadId,
      consolidatedBundleId: consolidated.bundleId,
      retiredBundleIds: [...doomedIds],
      retained: retirement.retained,
      ...(failed.length > 0 ? { failed } : {}),
      warnings,
    };
  } finally {
    lock.release();
  }
}

/**
 * Every machine's compaction assertions for a project.
 *
 * IMMEDIATE `.json` children only, the same #28 rule `readAllIndexes` applies
 * to `index/` and for the same measured reason: `backend.list` recurses, the
 * hub is a synced directory by design, and sync clients park superseded copies
 * in nested folders (`.stversions/`, "conflicted copy" directories). Recursing
 * would read one machine's stale backup as a second machine's assertion.
 *
 * Never throws and never refuses. A marker that cannot be read simply does not
 * explain anything, which returns the caller to the answer it would have given
 * without this — a worse message, not a wrong action.
 */
export async function readAllCompactions(
  backend: HubBackend,
  projectId: string
): Promise<HubCompactionEntry[]> {
  const dir = compactionDirPath(projectId);
  const prefix = `${dir}/`;
  const out: HubCompactionEntry[] = [];
  let files: string[];
  try {
    files = await backend.list(dir);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const name = file.slice(prefix.length);
    if (name.includes("/") || !name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse((await backend.read(file)).toString()) as HubCompactionJson;
      if (!Array.isArray(parsed?.compactions)) continue;
      for (const c of parsed.compactions) {
        if (Array.isArray(c?.retiredBundleIds)) out.push(c);
      }
    } catch {
      // Unreadable or malformed: explains nothing. See above.
    }
  }
  return out;
}

/**
 * Which of these bundle ids a compaction retired, and what replaced each.
 *
 * The reason this exists: without it, a bundle deliberately retired by another
 * machine is indistinguishable from one that has not finished syncing, and the
 * reader tells the user to "retry in a moment" — from the one result class that
 * exists to mean a retry will work.
 *
 * A retry DOES work here, which is why this refines the message rather than the
 * class: the file is missing because that machine's index and its files reached
 * this one out of order, and the next attempt reads the updated index and
 * fetches the consolidated bundle instead. What was wrong was the cause, never
 * the remedy.
 */
export async function explainRetiredBundles(
  backend: HubBackend,
  projectId: string,
  bundleIds: readonly string[]
): Promise<Map<string, string>> {
  const wanted = new Set(bundleIds);
  const explained = new Map<string, string>();
  if (wanted.size === 0) return explained;
  // NOTHING HERE MAY THROW. This runs only on a path that has already decided
  // to refuse, and its entire job is to make that refusal's wording truer. A
  // throw would convert a clean typed result — with its `missing` list and its
  // exit class — into an exit-1 stack trace, which is strictly worse than the
  // imprecise sentence it was called to improve. `projectDir` asserts on the
  // id, so even path building is inside the guard.
  try {
    for (const c of await readAllCompactions(backend, projectId)) {
      for (const id of c.retiredBundleIds) {
        if (wanted.has(id)) explained.set(id, c.consolidatedBundleId);
      }
    }
  } catch {
    // Explains nothing; the caller falls back to the generic sentence.
  }
  return explained;
}
