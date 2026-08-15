/**
 * Shared HubIndexJson fixture builders for hub tests (moved out of
 * hub-threads.test.ts in Task 9 so hub-whereis.test.ts can reuse the same
 * shorthand instead of copy-pasting it).
 */
import {
  appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchive } from "../../src/archiver.js";
import { computeIntegrityHashFromFile, writeManifest } from "../../src/manifest.js";
import { bundleDir, bundleFileName } from "../../src/hub/layout.js";
import { hubInit } from "../../src/hub/init.js";
import { hubPull } from "../../src/hub/pull.js";
import { hubPush } from "../../src/hub/push.js";
import { writeLocalProjectId } from "../../src/hub/identity.js";
import { readLastEntryUuid } from "../../src/jsonl.js";
import { encodeProjectPath } from "../../src/platform.js";
import type { HubBackend } from "../../src/hub/backend.js";
import type { HubBundleRecord, HubIndexJson } from "../../src/hub/layout.js";
import type { ExportManifest, HubPullResult, SyncState, SyncStatePeer } from "../../src/types.js";
import type { ThreadCopy } from "../../src/hub/threads.js";
import { createFixtureTree } from "../fixtures/create-fixtures.js";
import { overrideHome } from "./env.js";

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

// ---- Two-machine continuation arrangements ----
//
// COPIED from tests/hub-pull.test.ts rather than moved: that file is the
// oracle for this behavior and stays untouched. Only the parts the stage tests
// need are here (the default two-entry continuation; no git carry, no win32
// entry maker), so the two copies are deliberately not interchangeable.

/** The fixture project's encoded config-dir folder name. */
export const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";
/** The fixture transcript's session id. */
export const FIXTURE_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
/** Uuid of the fixture session's last entry — every continuation's anchor. */
export const FIXTURE_HEAD_UUID = "entry-3";

/**
 * Identity linking writes `.sesh-mover-project.json` under the real project
 * directory and this sandbox cannot create top-level dirs like "/Users", so
 * every hub test works against a REAL directory with the fixture's session
 * content copied into its encoded config-dir slot.
 */
export function createRealProject(base: string, configDir: string, name: string): string {
  const realProj = join(base, name);
  mkdirSync(realProj, { recursive: true });
  writeFileSync(join(realProj, "README.md"), "hello\n");
  const realEncoded = encodeProjectPath(realProj);
  cpSync(join(configDir, "projects", FIXTURE_ENCODED), join(configDir, "projects", realEncoded), {
    recursive: true,
  });
  return realProj;
}

export function appendEntries(path: string, entries: Array<Record<string, unknown>>): void {
  appendFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

/** Push a session file out of the append liveness window. */
export function ageOutOfLiveWindow(path: string): void {
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(path, old, old);
}

/**
 * Make a base look like a live Claude Code session: modified inside the
 * liveness window but STRICTLY in the past. Stamping "now" here is a race —
 * hubPull captures its own operation boundary a moment later, and if both land
 * in the same millisecond the self-write exemption fires and the append
 * proceeds instead of declining.
 */
export function makeLookLive(path: string): void {
  const recent = new Date(Date.now() - 30_000);
  utimesSync(path, recent, recent);
}

type EntryMaker = (
  parentUuid: string,
  sessionId: string,
  projectPath: string
) => Array<Record<string, unknown>>;

/** Two plain entries whose only path field is the SOURCE machine's cwd. */
export const plainEntries: EntryMaker = (parentUuid, sessionId, projectPath) => [
  {
    uuid: "b-entry-4", parentUuid, timestamp: "2026-04-11T09:00:00Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "user",
    message: { role: "user", content: "picking this up on the other machine" },
  },
  {
    uuid: "b-entry-5", parentUuid: "b-entry-4", timestamp: "2026-04-11T09:00:05Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "assistant",
    message: { model: "claude-opus-4-6", id: "msg_cont", content: [{ type: "text", text: "On it." }] },
  },
];

/** Two entries machine A adds to its own base, forking the thread locally. */
export const localEntries: EntryMaker = (parentUuid, sessionId, projectPath) => [
  {
    uuid: "a-local-1", parentUuid, timestamp: "2026-04-11T10:00:00Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "user",
    message: { role: "user", content: "meanwhile, back on machine A" },
  },
  {
    uuid: "a-local-2", parentUuid: "a-local-1", timestamp: "2026-04-11T10:00:05Z", sessionId,
    cwd: projectPath, version: "2.1.81", type: "assistant",
    message: { model: "claude-opus-4-6", id: "msg_local", content: [{ type: "text", text: "Carrying on here." }] },
  },
];

export interface ContinuationArrangement {
  hub: string;
  configDirA: string;
  projectA: string;
  projectDirA: string;
  projectB: string;
  configDirB: string;
  projectId: string;
  baseSessionId: string;
  basePath: string;
  cleanup(): void;
}

/**
 * The shared two-machine continuation arrangement:
 *
 *   1. machine A pushes the fixture session (full bundle),
 *   2. machine B pulls it, appends `makeEntries(...)` to its imported copy,
 *      and pushes the resulting continuation bundle,
 *   3. HOME is switched back to A and A's base session file is aged out of the
 *      append liveness window (it was written seconds ago by the fixture copy,
 *      which would otherwise make every test a "recently-active" decline).
 *
 * B's appended entries deliberately carry B's OWN paths — the pull under test
 * is what has to translate them onto A.
 */
export async function arrangeContinuation(
  makeEntries: EntryMaker = plainEntries
): Promise<ContinuationArrangement> {
  const homeA = mkdtempSync(join(tmpdir(), "sesh-stage-homeA-"));
  const homeB = mkdtempSync(join(tmpdir(), "sesh-stage-homeB-"));
  const hub = mkdtempSync(join(tmpdir(), "sesh-stage-hub-"));
  const base = mkdtempSync(join(tmpdir(), "sesh-stage-fix-"));
  let projectB: string | undefined;
  let restore = overrideHome(homeA);
  const cleanup = (): void => {
    restore.restore();
    for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
    if (projectB) rmSync(projectB, { recursive: true, force: true });
  };

  try {
    const { configDir: configDirA } = createFixtureTree(base);
    const projectA = createRealProject(base, configDirA, "projA");
    await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
    const pushA = await hubPush({
      configDir: configDirA, projectPath: projectA, hubPath: hub,
      createProject: true, noWorkspace: true, claudeVersion: "2.1.81",
    });
    if (!pushA.success) throw new Error(`arrange: A's push failed: ${JSON.stringify(pushA)}`);

    restore.restore();
    restore = overrideHome(homeB);

    const configDirB = join(homeB, ".claude");
    projectB = mkdtempSync(join(tmpdir(), "sesh-stage-projB-"));
    writeLocalProjectId(projectB, {
      projectId: pushA.projectId, name: "projA",
      createdAt: "2026-04-10T00:00:00.000Z", createdByMachine: "machine-a",
    });
    const pullB = await hubPull({
      configDir: configDirB, projectPath: projectB, hubPath: hub,
      latest: true, claudeVersion: "2.1.81",
    });
    if (!pullB.success) throw new Error(`arrange: B's pull failed: ${JSON.stringify(pullB)}`);
    const localB = (pullB as HubPullResult).localSessionId;
    if (!localB) throw new Error("arrange: B's pull identified no local session");

    const bJsonl = join(configDirB, "projects", encodeProjectPath(projectB), `${localB}.jsonl`);
    const anchor = readLastEntryUuid(bJsonl);
    if (!anchor) throw new Error("arrange: B's session has no head entry");
    appendEntries(bJsonl, makeEntries(anchor, localB, projectB));
    const pushed = await hubPush({
      configDir: configDirB, projectPath: projectB, hubPath: hub,
      noWorkspace: true, claudeVersion: "2.1.81",
    });
    if (!pushed.success) throw new Error(`arrange: B's push failed: ${JSON.stringify(pushed)}`);
    if (pushed.pushedSessions[0]?.type !== "continuation") {
      throw new Error("arrange: B pushed a full bundle, not a continuation");
    }

    restore.restore();
    restore = overrideHome(homeA);

    const projectDirA = join(configDirA, "projects", encodeProjectPath(projectA));
    const basePath = join(projectDirA, `${FIXTURE_SESSION_ID}.jsonl`);
    ageOutOfLiveWindow(basePath);

    return {
      hub, configDirA, projectA, projectDirA, projectB, configDirB,
      projectId: pushA.projectId, baseSessionId: FIXTURE_SESSION_ID, basePath, cleanup,
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * `arrangeContinuation`, then fork A's side too: A extends its base from the
 * very entry B's continuation is anchored on, without pushing. The base is aged
 * back out of the live window afterwards — appending just moved its mtime to
 * now, which would otherwise make every divergence test a liveness story
 * instead of the one it names.
 */
export async function arrangeDivergence(): Promise<ContinuationArrangement> {
  const a = await arrangeContinuation();
  try {
    appendEntries(a.basePath, localEntries(FIXTURE_HEAD_UUID, a.baseSessionId, a.projectA));
    ageOutOfLiveWindow(a.basePath);
    return a;
  } catch (e) {
    a.cleanup();
    throw e;
  }
}
