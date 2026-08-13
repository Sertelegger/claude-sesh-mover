/**
 * Shared HubIndexJson fixture builders for hub tests (moved out of
 * hub-threads.test.ts in Task 9 so hub-whereis.test.ts can reuse the same
 * shorthand instead of copy-pasting it).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchive } from "../../src/archiver.js";
import { computeIntegrityHashFromFile, writeManifest } from "../../src/manifest.js";
import { bundleDir, bundleFileName } from "../../src/hub/layout.js";
import type { HubBackend } from "../../src/hub/backend.js";
import type { HubBundleRecord, HubIndexJson } from "../../src/hub/layout.js";
import type { ExportManifest, SyncState, SyncStatePeer } from "../../src/types.js";
import type { ThreadCopy } from "../../src/hub/threads.js";

export function idx(machineId: string, threads: HubIndexJson["threads"]): HubIndexJson {
  return {
    schemaVersion: 1,
    agent: "claude-code",
    projectId: "p",
    machineId,
    updatedAt: "t",
    projectPath: "/x",
    threads,
  };
}

export function entry(over: Partial<HubIndexJson["threads"][string]>): HubIndexJson["threads"][string] {
  return {
    localSessionId: "s",
    slug: "slug",
    summary: "sum",
    headEntryUuid: "u",
    messageCount: 1,
    lastActiveAt: "2026-07-21T00:00:00Z",
    bundles: [],
    ...over,
  };
}

/** One bundle record as a machine's index lists it. */
export function bundle(over: Partial<HubBundleRecord> = {}): HubBundleRecord {
  const bundleId = over.bundleId ?? "b";
  return {
    bundleId,
    file: `projects/p/bundles/m/${bundleId}.tar.gz`,
    type: "continuation",
    sessionIdInBundle: "s",
    fromEntryUuid: null,
    headEntryUuid: `head-${bundleId}`,
    messageCount: 1,
    pushedAt: "2026-07-21T00:00:00Z",
    hasWorkspace: false,
    ...over,
  };
}

/** One machine's copy of a thread, as resolveThreads produces it. */
export function copy(machineId: string, over: Partial<ThreadCopy> = {}): ThreadCopy {
  return {
    machineId,
    localSessionId: `local-${machineId}`,
    slug: "slug",
    summary: "sum",
    headEntryUuid: "u",
    messageCount: 1,
    lastActiveAt: "2026-07-21T00:00:00Z",
    bundles: [],
    ...over,
  };
}

export function peer(over: Partial<SyncStatePeer> = {}): SyncStatePeer {
  return { name: "p", lastSentAt: null, lastReceivedAt: null, sent: {}, received: {}, ...over };
}

export function syncState(peers: SyncState["peers"] = {}): SyncState {
  return { projectPath: "/x", schemaVersion: 1, peers, lineage: {}, imported: {} };
}

/**
 * A minimal valid `SyncState` with no threads recorded — schemaVersion 1 and no
 * `hub` block at all, i.e. exactly what `readSyncState` hands back for a project
 * that has never pushed or pulled (`defaultState` in src/sync-state.ts).
 * `getThreadId` returns null for every session against it.
 *
 * Kept as a named alias of `syncState()` rather than a second literal so there
 * is one shape: the name is the point, at the call sites (pull's select stage)
 * where "no thread bookkeeping yet" is the thing under test.
 */
export function emptySyncState(projectPath = "/x"): SyncState {
  return { ...syncState(), projectPath };
}

/**
 * Indexes for a project where EVERY thread is already current on `machineId`
 * (default `m1`) — the arrangement a pull has nothing to do with.
 *
 * Deliberately one machine's index and no other: "current" is decided by head
 * equality against the resolved latest copy (`isCurrent` in hub/pull.ts), and a
 * second machine listing bundles of its own would hand the selection an
 * `alternateSource` to fetch from, which is the opposite of what this fixture
 * claims. Adding a peer machine here means adding one whose bundle list is
 * empty.
 */
export function currentThreadIndexes(
  over: { machineId?: string; projectId?: string; threadIds?: string[] } = {}
): HubIndexJson[] {
  const machineId = over.machineId ?? "m1";
  const projectId = over.projectId ?? "p";
  const threadIds = over.threadIds ?? ["t1", "t2"];
  const threads: HubIndexJson["threads"] = {};
  const base = Date.parse("2026-07-21T00:00:00Z");
  threadIds.forEach((threadId, i) => {
    threads[threadId] = entry({
      localSessionId: `local-${threadId}`,
      headEntryUuid: `head-${threadId}`,
      // Distinct per thread, and arithmetic rather than string interpolation so
      // a caller passing more than a handful of ids still gets real timestamps
      // (resolveThreads orders on this).
      lastActiveAt: new Date(base + i * 60_000).toISOString(),
      bundles: [
        bundle({
          bundleId: `b-${threadId}`,
          file: `projects/${projectId}/bundles/${machineId}/b-${threadId}.tar.gz`,
          type: "full",
          sessionIdInBundle: `sess-${threadId}`,
          // The thread's head IS this bundle's head — nothing was pushed after
          // the copy this machine holds.
          headEntryUuid: `head-${threadId}`,
        }),
      ],
    });
  });
  return [{ ...idx(machineId, threads), projectId }];
}

// ---- Corrupt bundle fixture ----

/** Session id of the transcript inside `writeCorruptBundle`'s bundle. */
export const CORRUPT_BUNDLE_SESSION_ID = "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";
/** Uuid of that transcript's last conversation entry. */
export const CORRUPT_BUNDLE_HEAD_UUID = "entry-3";

/**
 * A long ASCII run inside the transcript's assistant text. The byte flip lands
 * in here on purpose (see `flipOneByteInPadding`).
 */
const CORRUPTION_PADDING = "x".repeat(256);

function corruptBundleEntries(sessionId: string): unknown[] {
  const common = {
    sessionId,
    cwd: "/Users/testuser/Projects/testproject",
    version: "2.1.81",
    gitBranch: "main",
  };
  return [
    {
      ...common,
      uuid: "entry-1",
      timestamp: "2026-04-10T12:00:00Z",
      slug: "corrupt-bundle",
      userType: "external",
      entrypoint: "cli",
      type: "user",
      message: { role: "user", content: "Hello, help me build a REST API" },
    },
    {
      ...common,
      uuid: "entry-2",
      timestamp: "2026-04-10T12:00:05Z",
      parentUuid: "entry-1",
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        id: "msg_corrupt",
        content: [{ type: "text", text: `I'll help you build a REST API. ${CORRUPTION_PADDING}` }],
      },
    },
    {
      ...common,
      uuid: CORRUPT_BUNDLE_HEAD_UUID,
      timestamp: "2026-04-10T12:01:00Z",
      parentUuid: "entry-2",
      type: "user",
      message: { role: "user", content: "Thanks" },
    },
  ];
}

/**
 * One byte, flipped in place — modelled on `flipMiddleByte()` in
 * tests/archiver.test.ts, with two deliberate differences: it flips the low bit
 * rather than `^ 0xff`, and it aims at the middle of the ASCII padding run
 * rather than the middle of the file ('x' -> 'y'). Both exist so the damaged
 * JSONL stays valid UTF-8 and valid JSON — this fixture has to produce a bundle
 * that FAILS ITS HASH CHECK, not one that fails to parse.
 */
function flipOneByteInPadding(path: string): void {
  const buf = readFileSync(path);
  const at = buf.indexOf(CORRUPTION_PADDING);
  if (at === -1) throw new Error("hub-fixtures: padding run not found in the session JSONL");
  buf[at + Math.floor(CORRUPTION_PADDING.length / 2)] ^= 0x01;
  writeFileSync(path, buf);
}

/**
 * Flip one byte of the declared `integrityHash` in a written manifest.json,
 * keeping it a hex digit so the file stays valid JSON.
 *
 * Written with a raw `writeFileSync` on purpose: `writeManifest` restamps
 * `sessionsDigest` over whatever session list it is handed (see its doc), which
 * would heal exactly the damage this is creating.
 */
function flipDeclaredHashByte(manifestPath: string, declaredHash: string): void {
  const buf = readFileSync(manifestPath);
  const at = buf.indexOf(declaredHash);
  if (at === -1) throw new Error("hub-fixtures: declared integrityHash not found in manifest.json");
  const target = at + declaredHash.length - 1;
  buf[target] = buf[target] === 0x30 /* '0' */ ? 0x31 /* '1' */ : 0x30;
  writeFileSync(manifestPath, buf);
}

/**
 * Write a DAMAGED bundle to the hub and return the `HubBundleRecord` that
 * points at it.
 *
 * The bundle is structurally intact end to end: a real `.tar.gz` built by
 * `createArchive`, whose gzip CRC is valid, which extracts cleanly, and whose
 * manifest.json parses and lists a session file that is actually there. Only the
 * hashes disagree — a reader has to VERIFY to notice, which is the whole point.
 *
 * Damage is planted at both layers a bundle can be checked at, because they
 * cover different things and a caller may consult either:
 *
 * - **Content vs. declared hash.** One byte of the session JSONL is flipped
 *   after the manifest was stamped, so `computeIntegrityHashFromFile` over the
 *   extracted transcript no longer equals the manifest's `integrityHash`.
 * - **The manifest's own session inventory.** `sessionsDigest` deliberately
 *   covers only the manifest's session list, never the content beside it (see
 *   `computeSessionsDigest`), so the content flip alone leaves
 *   `verifySessionsDigest` passing. One byte of the declared `integrityHash` is
 *   flipped too — the "a hash edited" damage shape that digest exists to catch,
 *   and the check `hub/pull.ts` runs immediately after extraction today.
 *
 * Only the archive is written; no index or project.json is created, so the
 * record is the caller's to place wherever their arrangement needs it.
 */
export async function writeCorruptBundle(
  backend: HubBackend,
  projectId: string,
  over: {
    machineId?: string;
    bundleId?: string;
    sessionId?: string;
    pushedAt?: string;
    type?: HubBundleRecord["type"];
  } = {}
): Promise<HubBundleRecord> {
  const machineId = over.machineId ?? "m1";
  const bundleId = over.bundleId ?? "corrupt-bundle";
  const sessionId = over.sessionId ?? CORRUPT_BUNDLE_SESSION_ID;
  const pushedAt = over.pushedAt ?? "2026-07-21T00:00:00.000Z";

  const staging = mkdtempSync(join(tmpdir(), "sesh-corrupt-bundle-"));
  try {
    // "bundle" as the staging directory name for the same reason push.ts uses
    // it: createArchive tars one top-level entry named after the directory and
    // extractArchive strips exactly that segment.
    const bundleStaging = join(staging, "bundle");
    mkdirSync(join(bundleStaging, "sessions"), { recursive: true });

    const jsonlPath = join(bundleStaging, "sessions", `${sessionId}.jsonl`);
    const entries = corruptBundleEntries(sessionId);
    writeFileSync(jsonlPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    const integrityHash = await computeIntegrityHashFromFile(jsonlPath);
    const manifest: ExportManifest = {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: pushedAt,
      sourcePlatform: "linux",
      sourceProjectPath: "/x",
      sourceConfigDir: "/x/.claude",
      sourceClaudeVersion: "2.1.81",
      sessionScope: "current",
      includedLayers: ["jsonl"],
      projectId,
      sourceMachineId: machineId,
      sessions: [
        {
          sessionId,
          slug: "corrupt-bundle",
          summary: "a bundle whose bytes no longer match its manifest",
          createdAt: "2026-04-10T12:00:00Z",
          lastActiveAt: "2026-04-10T12:01:00Z",
          messageCount: entries.length,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash,
          type: over.type ?? "full",
        },
      ],
    };
    // Stamped by the real writer first, so what lands on the hub is a valid
    // bundle damaged afterwards — never a bundle that was never valid.
    writeManifest(bundleStaging, manifest);

    flipOneByteInPadding(jsonlPath);
    flipDeclaredHashByte(join(bundleStaging, "manifest.json"), integrityHash);

    const archivePath = join(staging, "bundle.tar.gz");
    await createArchive(bundleStaging, archivePath, "gzip");
    const file = `${bundleDir(projectId, machineId)}/${bundleFileName(pushedAt, bundleId)}`;
    await backend.writeAtomic(file, readFileSync(archivePath));

    return {
      bundleId,
      file,
      type: over.type ?? "full",
      sessionIdInBundle: sessionId,
      fromEntryUuid: null,
      headEntryUuid: CORRUPT_BUNDLE_HEAD_UUID,
      messageCount: entries.length,
      pushedAt,
      hasWorkspace: false,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
