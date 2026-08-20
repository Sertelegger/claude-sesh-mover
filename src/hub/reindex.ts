import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend } from "./backend.js";
import { bundleDir, type HubBundleRecord } from "./layout.js";
import { fetchBundleArchive } from "./bundle-io.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import { readLocalProjectId } from "./identity.js";
import { hubUnreachableRefusal, probeHubReachable } from "./preflight.js";
import { registerMachine } from "./init.js";
import {
  buildIndexFile, readMachineIndex, writeMachineIndex, type PriorIndexView, type PriorThreadEntry,
} from "./index-file.js";
import { extractArchive } from "../archiver.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { readManifest } from "../manifest.js";
import { readLastEntryUuid } from "../jsonl.js";
import { readSyncState, getThreadId } from "../sync-state.js";
import type {
  HubLockBusyResult, HubReindexFailedResult, HubReindexResult, HubUnreachableResult,
} from "../types.js";

export interface HubReindexOptions {
  configDir: string;
  projectPath: string;
  hubPath: string;
}

// bundleFileName (layout.ts) writes `${sanitizedIso}-${bundleId}.tar.gz`,
// where ':' in the ISO timestamp was replaced with '-' for filesystem/sort
// safety. Both halves can contain '-' (date/time separators on the left,
// UUID dashes on the right), so splitting on '-' generically is ambiguous —
// anchor on the sanitized-ISO's fixed shape (YYYY-MM-DDTHH-MM-SS.mmmZ)
// instead; everything between that and ".tar.gz" is the bundleId.
// The optional `.age` tail is the ENCRYPTED spelling (layout.ts's
// `ENCRYPTED_BUNDLE_SUFFIX`). Both spellings are parsed here because a hub is
// permanently mixed — enabling encryption never rewrites an existing bundle —
// so a rebuild that recognised only one of them would silently drop half a
// machine's own history from the index it is repairing.
const BUNDLE_FILE_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-(.+)\.tar\.gz(?:\.age)?$/;

// Reverse bundleFileName's ':' -> '-' sanitization. An ISO timestamp from
// Date#toISOString() contains exactly two ':', both inside the
// "THH:MM:SS" section, so this regex swap recovers the original exactly.
// Falls back to the sanitized prefix itself if the result doesn't parse as
// a date (defensive — never throws on a foreign/corrupt file name).
function recoverPushedAt(sanitizedIso: string): string {
  const recovered = sanitizedIso.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  return Number.isNaN(Date.parse(recovered)) ? sanitizedIso : recovered;
}

function parseBundleFileName(fileName: string): { pushedAt: string; bundleId: string } | null {
  const m = BUNDLE_FILE_RE.exec(fileName);
  if (!m) return null;
  return { pushedAt: recoverPushedAt(m[1]), bundleId: m[2] };
}

// Rebuild this machine's own index file for the CURRENT project from its
// bundles on the hub (never another machine's) — the derivability
// invariant made executable: everything an index file records (thread ->
// bundle history) is reconstructible from the bundles themselves plus this
// machine's local sync-state (which thread each local session belongs to).
// A repair tool for a lost/corrupt index.json, not a sync primitive.
//
// Every refusal below carries a machine-readable `reason` (#29). They were plain
// `ErrorResult`s, so the only way to tell "wait for the other operation" from
// "this project was never pushed" — two failures whose remedies share nothing —
// was to regex the prose, which `skills/session-porter/SKILL.md` forbids for
// exactly this reason.
//
// `hub-unreachable` is the third, and reindex takes the same PLAIN REFUSAL push
// and pull take rather than the reporting treatment `hub status` and `whereis`
// get, because reindex is on their side of the line: it is a repair verb that
// WRITES. There is nothing diagnostic for it to salvage from an unreachable hub
// — an index rebuilt from bundles it could not read is not a degraded answer,
// it is a wrong one — and the write it would otherwise reach is the sharp part
// (see `hubUnreachableRefusal`'s note on `registerMachine` mkdir -p'ing a
// phantom hub into an unmounted mount point).
export async function hubReindex(
  opts: HubReindexOptions
): Promise<
  HubReindexResult | HubReindexFailedResult | HubLockBusyResult | HubUnreachableResult
> {
  const local = readLocalProjectId(opts.projectPath);
  if (!local) {
    return {
      success: false,
      command: "hub-reindex",
      reason: "unlinked",
      error: "This project is not linked to a hub project — there is nothing to reindex from.",
      suggestion: "Run push (with --create-project or --project-id) to link and publish this project to the hub first.",
    };
  }

  // AFTER the unlinked check and BEFORE the lock, and both halves of that
  // position are deliberate.
  //
  // After: push and pull run their reachability gate first because on an
  // unreachable hub their identity read fails too, so `no-such-project` there
  // would be a confident wrong diagnosis. That argument does not transfer —
  // reindex's identity check is `readLocalProjectId`, a read of a file in the
  // user's own project directory, whose answer is unaffected by whether the hub
  // is mounted. It can never be the wrong diagnosis, so the narrower fact keeps
  // its place at the front.
  //
  // Before: the lock is this machine's, but taking it to discover the hub is
  // gone means a wedged concurrent operation turns an "unmounted share" answer
  // into a `lock-busy` one, which sends the user to wait for something that
  // would not have helped. Being before `registerMachine` is the load-bearing
  // half — that call writes.
  const probe = await probeHubReachable(opts.hubPath, createFsBackend(opts.hubPath));
  if (probe.state !== "ok") {
    return hubUnreachableRefusal("hub-reindex", probe.state);
  }

  // Reindex only ever (re)writes THIS machine's own index file, but a
  // concurrent push (or another reindex) could be rebuilding/writing that
  // same file at the same moment — take the project lock for consistency
  // with push/pull, even though reindex never touches bundle data itself.
  let lock;
  try {
    lock = acquireProjectLock(opts.projectPath);
  } catch (e) {
    if (e instanceof LockBusyError) {
      // The same structured refusal push, pull and `hub unlink` give — and the
      // same FIELDS: `holderPid`/`ageSeconds` are what let a caller decide
      // whether to wait, and this arm used to discard both while its three
      // siblings surfaced them.
      return {
        success: false,
        command: "hub-reindex",
        reason: "lock-busy",
        holderPid: e.holderPid,
        ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
        error: e.message,
        suggestion: "Another sesh-mover hub operation is running for this project — wait for it or retry.",
      };
    }
    throw e;
  }

  let tempRoot: string | null = null;
  try {
    tempRoot = mkdtempSync(join(tmpdir(), "sesh-hub-reindex-"));
    const backend = createFsBackend(opts.hubPath);
    const warnings: string[] = [];
    // The two non-fatal conditions below, typed alongside their warning rather
    // than only inside it. `droppedBundles` in particular is data loss — the
    // rebuilt index does not reference those bundles, so no other machine can
    // see them — and a caller must be able to notice that without matching
    // prose.
    const unrecognizedBundleFiles: string[] = [];
    const droppedBundles: Array<{ sessionId: string; file: string }> = [];
    let droppedFromPriorIndex: string[] | undefined;
    const machine = loadOrCreateMachineId();
    await registerMachine(opts.hubPath);

    const dir = bundleDir(local.projectId, machine.id);
    // The sortable timestamp prefix (bundleFileName) exists for exactly
    // this: lexical sort of the file names is chronological push order.
    const files = (await backend.list(dir)).sort();

    const state = readSyncState(opts.projectPath);
    const records: Array<{ threadId: string; record: HubBundleRecord }> = [];
    // Per-thread metadata reconstructed from bundle manifests, keyed by
    // threadId and overwritten as we scan chronologically (last bundle
    // wins). Used below to build a synthetic priorIndex so a thread whose
    // local session has since vanished (JSONL deleted) still survives the
    // rebuild — see the comment at its use site.
    //
    // `PriorThreadEntry`, not `HubThreadEntry`: it has no `summary`, and that is
    // the point. This map used to carry `SessionManifest.summary` — a real
    // excerpt of the first user message for any untitled session — and it was
    // the one thread-entry field on the hub that was not a slug. Only a thread
    // whose local session had vanished reached it (a live one is rebuilt from
    // `sessionsNow` below), and only when its latest bundle was `full`, since a
    // continuation manifest's summary is `continuation of <slug>`. But once
    // written it stuck: the next ordinary push or pull read it back as its own
    // priorIndex and copied it forward. `buildIndexFile` now derives the field
    // from the slug at both doors, and the missing key here is what stops it
    // being re-supplied.
    const threadMeta = new Map<string, PriorThreadEntry>();

    for (const [i, file] of files.entries()) {
      const fileName = file.split("/").pop() ?? file;
      const parsed = parseBundleFileName(fileName);
      if (!parsed) {
        warnings.push(`bundle file ${file} has an unrecognized name — skipped.`);
        unrecognizedBundleFiles.push(file);
        continue;
      }

      const tarPath = join(tempRoot, `bundle-${i}.tar.gz`);
      // Suffix-driven decryption, exactly as the pull's fetch does it: this
      // machine's own bundle list is MIXED the moment the hub's switch is
      // flipped, since enabling encryption never rewrites what is already
      // there, so the format is a per-file fact and never a policy lookup.
      //
      // THROWS rather than skipping, on the same rule the narrow catch below
      // states for the download and the extract: a bundle this machine cannot
      // open is an environment fact (here, a lost or replaced
      // `~/.sesh-mover/identity.age`), and quietly skipping every one of them
      // would publish a rebuilt index referencing none of this machine's work —
      // which is how a repair tool makes the damage worse and invisible. The
      // whole rebuild refuses instead, and nothing is written.
      const got = await fetchBundleArchive({ backend, file, destPath: tarPath });
      if (!got.ok) throw new Error(`${file}: ${got.failure.message}`);
      const extractDir = join(tempRoot, `extract-${i}`);
      mkdirSync(extractDir, { recursive: true });
      // All bundles here are this machine's own pushes (bundleDir is keyed
      // by machineId), but we still run the standard extract path — same
      // tar-entry validation (assertSafeEntries) as pull's cross-machine
      // download, no special-casing "trusted" archives.
      await extractArchive(tarPath, extractDir);
      // DEGRADE, do not throw (#72). `readManifest` throws for a missing or
      // unparseable manifest.json, an unsafe session id, and — since #72 — a
      // manifest that is not one of ours at all. Every one of those is a
      // property of THIS FILE, and reindex is the repair tool for a lost index:
      // letting one file abort the rebuild leaves the index lost, which is the
      // condition the command exists to end. Same rule `readMachineIndex`
      // already states for a poisoned index record — the blast radius of a bad
      // record must be that record.
      //
      // Narrow on purpose: only the manifest read is caught. The download and
      // the extract above still throw, because those fail for ENVIRONMENT
      // reasons (an unreachable share, a full temp dir) that would otherwise
      // silently drop every bundle and then publish an index referencing none
      // of them — this machine's work would go invisible to every other
      // machine, which is exactly what `droppedBundles` is typed to disclose.
      //
      // Without this, `sessions: "abc"` (the one wrong shape that used to pass
      // both manifest checks silently) iterated three characters, and each one
      // reported `sessionId: undefined` into `droppedBundles` — three fabricated
      // entries in a TYPED data-loss field, for a bundle declaring no sessions.
      let manifest;
      try {
        manifest = readManifest(extractDir);
      } catch (e) {
        warnings.push(`bundle file ${file} has no readable sesh-mover manifest (${(e as Error).message}) — skipped.`);
        unrecognizedBundleFiles.push(file);
        continue;
      }
      const hasWorkspace = !!manifest.workspace;

      for (const s of manifest.sessions) {
        // Same mapping as push's index-projection step: a continuation
        // bundles under the LOCAL session id it continues, not its own
        // (bundle-scoped) session id.
        const localSessionId =
          s.type === "continuation" && s.continuation ? s.continuation.continuesLocalSessionId : s.sessionId;
        const threadId = getThreadId(state, localSessionId);
        if (!threadId) {
          warnings.push(`no local thread mapping for bundled session ${s.sessionId} (bundle ${file}) — dropped.`);
          droppedBundles.push({ sessionId: s.sessionId, file });
          continue;
        }
        const headEntryUuid = readLastEntryUuid(join(extractDir, "sessions", `${s.sessionId}.jsonl`)) ?? "";
        records.push({
          threadId,
          record: {
            bundleId: parsed.bundleId,
            file,
            type: s.type === "continuation" ? "continuation" : "full",
            sessionIdInBundle: s.sessionId,
            fromEntryUuid: s.continuation?.fromEntryUuid ?? null,
            // Recovered from the bundle's OWN manifest, which is why a rebuild
            // does not silently unlink a hub: every bundle whose manifest
            // carries the anchor gets its link back. A bundle pushed before the
            // field existed carries none, so the rebuilt record carries none
            // either — `undefined`, not `null`. Reindex reproduces the hub as it
            // is; inventing a value here would be a repair tool fabricating the
            // one fact it cannot derive. Same `s.type` discriminator as the
            // record's `type`, for the reason push.ts states.
            anchorEntryUuid: s.type === "continuation" ? s.continuation?.anchorEntryUuid : null,
            headEntryUuid,
            messageCount: s.messageCount,
            pushedAt: parsed.pushedAt,
            hasWorkspace,
          },
        });
        threadMeta.set(threadId, {
          localSessionId,
          slug: s.slug,
          headEntryUuid,
          messageCount: s.messageCount,
          lastActiveAt: s.lastActiveAt,
          bundles: [],
        });
      }
    }

    // No `summary` here: `buildIndexFile` derives the thread entry's from the
    // slug, and is the only thing that writes it (see index-file.ts).
    const sessionsNow = discoverSessions(opts.configDir, opts.projectPath).map((s) => ({
      sessionId: s.sessionId,
      slug: s.slug,
      headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
      messageCount: s.messageCount,
      lastActiveAt: s.lastActiveAt,
    }));

    // buildIndexFile's `threads` map is seeded from `sessions` (live
    // discovery) first, falling back to `priorIndex.threads` only for
    // thread ids NOT already found live. With priorIndex: null, a thread
    // whose local session was deleted after it was pushed would vanish
    // from the rebuilt index — a real regression vs. the original (which
    // carried it forward from ITS priorIndex). We can't ask the hub for
    // that (index files are exactly what we're rebuilding), but we CAN
    // reconstruct equivalent thread metadata from the bundle manifests
    // scanned above (slug/headEntryUuid/messageCount/lastActiveAt all live
    // in SessionManifest). Feeding that as a synthetic priorIndex
    // (bundles: [] — the real bundle history is supplied separately via
    // `newBundles`, same as a live thread's) carries vanished threads
    // forward without disturbing live ones: for a thread that IS live,
    // buildIndexFile only ever takes `bundles` from priorIndex (which we
    // set to [] here, same as the `?? []` it'd use for a genuine null), so
    // this can never diverge from a true no-prior rebuild for live
    // threads — only adds back what a strict `priorIndex: null` would
    // have dropped.
    //
    // `PriorIndexView` is exactly the part of a prior index the projection
    // reads, so the synthetic one is the `threads` map and nothing else — no
    // index envelope invented here to be kept in step with the real writer's.
    const syntheticPrior: PriorIndexView = { threads: Object.fromEntries(threadMeta) };

    const built = buildIndexFile({
      projectId: local.projectId,
      machineId: machine.id,
      projectPath: opts.projectPath,
      sessions: sessionsNow,
      state,
      priorIndex: syntheticPrior,
      newBundles: records,
      now: new Date().toISOString(),
    });
    // WHAT THE REBUILD COULD NOT REPRODUCE (spec §6 Q9).
    //
    // `reindex` replaces this machine's index wholesale, and until now it did
    // so silently: a bundle record present in the old index and absent from the
    // rebuild simply stopped existing, and no other machine could ever see it
    // again. That is the wrong kind of quiet for a REPAIR tool — the command a
    // user reaches for when something already looks wrong is the last one that
    // should discard history without saying so.
    //
    // It is a disclosure, not a merge: the rebuilt index is still exactly what
    // the bundles on disk plus this machine's sync-state say, because that
    // derivability is the invariant `reindex` exists to enforce. Copying a
    // record forward because the old file had it would defeat the whole point —
    // an index that cannot be re-derived is precisely the state being repaired.
    //
    // The usual cause is benign and worth naming in the message: a bundle file
    // that has been removed from the hub. The alarming cause is not, which is
    // why the count is reported rather than the reasoning.
    const priorIndex = await readMachineIndex(backend, local.projectId, machine.id, warnings);
    if (priorIndex !== null) {
      const rebuilt = new Set(
        Object.values(built.threads).flatMap((t) => t.bundles.map((b) => b.bundleId))
      );
      const lost = Object.values(priorIndex.threads)
        .flatMap((t) => t.bundles.map((b) => b.bundleId))
        .filter((id) => !rebuilt.has(id));
      if (lost.length > 0) {
        droppedFromPriorIndex = [...new Set(lost)];
        warnings.push(
          `The rebuilt index no longer references ${droppedFromPriorIndex.length} bundle(s) the previous index listed (${droppedFromPriorIndex.slice(0, 5).join(", ")}${droppedFromPriorIndex.length > 5 ? ", …" : ""}). A rebuild is derived from the bundles on this machine's hub directory plus its own sync-state, so a record disappears when its bundle file is gone or can no longer be read. Those bundles are now invisible to every other machine. If you did not remove them, stop and check the hub directory before pushing again — a push republishes this index.`
        );
      }
    }
    await writeMachineIndex(backend, built);

    return {
      success: true,
      command: "hub-reindex",
      projects: [
        { projectId: local.projectId, threads: Object.keys(built.threads).length, bundlesScanned: files.length },
      ],
      // Absent on an ordinary rebuild rather than present-and-empty, matching
      // `unfetchableBundles`: a field that only appears when there is something
      // to say cannot be read as "checked, nothing found" by a caller of an
      // older build that never set it.
      ...(unrecognizedBundleFiles.length > 0 ? { unrecognizedBundleFiles } : {}),
      ...(droppedBundles.length > 0 ? { droppedBundles } : {}),
      ...(droppedFromPriorIndex ? { droppedFromPriorIndex } : {}),
      warnings,
    };
  } finally {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    lock.release();
  }
}
