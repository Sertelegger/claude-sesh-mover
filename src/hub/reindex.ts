import { mkdtempSync, rmSync, mkdirSync, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBackend } from "./backend.js";
import { bundleDir, type HubBundleRecord } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import { readLocalProjectId } from "./identity.js";
import { registerMachine } from "./init.js";
import {
  buildIndexFile, writeMachineIndex, type PriorIndexView, type PriorThreadEntry,
} from "./index-file.js";
import { extractArchive } from "../archiver.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { readManifest } from "../manifest.js";
import { readLastEntryUuid } from "../jsonl.js";
import { readSyncState, getThreadId } from "../sync-state.js";
import type {
  HubLockBusyResult, HubReindexFailedResult, HubReindexResult,
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
const BUNDLE_FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-(.+)\.tar\.gz$/;

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
// Both refusals below carry a machine-readable `reason` (#29). They were plain
// `ErrorResult`s, so the only way to tell "wait for the other operation" from
// "this project was never pushed" — two failures whose remedies share nothing —
// was to regex the prose, which `skills/session-porter/SKILL.md` forbids for
// exactly this reason.
export async function hubReindex(
  opts: HubReindexOptions
): Promise<HubReindexResult | HubReindexFailedResult | HubLockBusyResult> {
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
      await pipeline(await backend.readStream(file), createWriteStream(tarPath));
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
      warnings,
    };
  } finally {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    lock.release();
  }
}
