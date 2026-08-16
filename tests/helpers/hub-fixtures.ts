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
import { createFsBackend } from "../../src/hub/backend.js";
import { readAllIndexes } from "../../src/hub/index-file.js";
import { resolveThreads } from "../../src/hub/threads.js";
import { hubInit } from "../../src/hub/init.js";
import { hubPull } from "../../src/hub/pull.js";
import { hubPush } from "../../src/hub/push.js";
import { hubWhereis } from "../../src/hub/whereis.js";
import { writeLocalProjectId } from "../../src/hub/identity.js";
import { readMachineId, setMachineName } from "../../src/machine.js";
import { readLastEntryUuid } from "../../src/jsonl.js";
import { encodeProjectPath } from "../../src/platform.js";
import type { HubBackend } from "../../src/hub/backend.js";
import type { HubBundleRecord, HubIndexJson, HubThreadEntry } from "../../src/hub/layout.js";
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

// ---- Linked-chain index fixtures (#35) ----
//
// WHY THIS EXISTS. `bundle()` above hardcodes `fromEntryUuid: null` and no call
// site in tests/ overrides it, so until this builder the LINKED shape — the
// thing chain assembly walks — had zero coverage at the index level. That is
// also why #35 could sit undetected: nothing ever asserted over a chain of
// records. Everything below is pure; no filesystem, no hub, no push.
//
// It builds ONE thread spread across N machines, which is the shape every
// assembly case needs. A fixture wanting two threads composes two calls and
// merges the maps.

/**
 * The `headEntryUuid` `chainIndexes` gives a record with this id — the same
 * spelling `bundle()` uses, so records from the two builders live in one uuid
 * namespace instead of two.
 *
 * Exported because a GAP must be spelled out. `from: "b1"` resolves against the
 * DECLARED records and throws on an unknown id, on purpose: an anchor typo
 * would otherwise silently manufacture the exact anomaly under test and the
 * test would pass for the wrong reason. So "anchored on a bundle that no
 * machine's index lists" is written `fromUuid: chainHead("b1")`, with `b1`
 * deliberately absent from the spec — the absence is then visible in the call.
 */
export function chainHead(bundleId: string): string {
  return `head-${bundleId}`;
}

/**
 * The `fromEntryUuid` `chainIndexes` gives a linked record under
 * `linkStyle: "push"` — the uuid of the FIRST line of that bundle's own delta.
 *
 * MEASURED, AND IT CONTRADICTS THE SPEC. `src/diff.ts` sets
 * `fromEntryUuid: entries[headIndex + 1].uuid` — one PAST the recorded head —
 * and both index writers copy that value through unchanged
 * (`src/hub/push.ts`, `src/hub/reindex.ts`, both `s.continuation?.fromEntryUuid
 * ?? null`). So on a real hub a continuation's `fromEntryUuid` is the child of
 * the previous bundle's `headEntryUuid`, never equal to it, and a head-keyed
 * map (spec §4.2) links NOTHING. `arrangeThreeMachines` produces the real
 * thing, and the selfcheck pins the measurement.
 *
 * A SECOND correction rides along, and it matters for the empty-head rule:
 * spec §4.3 says `""` is "representable in the type even though no current
 * writer produces it". It does. `diff.ts` reads its uuids through
 * `readEntryUuids`, which maps every uuid-less or unparseable line to `""`
 * (`src/jsonl.ts`), and the first unsent line of a live transcript is USUALLY a
 * uuid-less bookkeeping entry — `continuation.ts`'s `boundaryUuid` doc says so
 * outright and exists because of it. So a real continuation record's
 * `fromEntryUuid` is `""` routinely, not never.
 *
 * `linkStyle: "anchor"` — the default — is the shape the spec assumed and the
 * only one in which "gap", "fork" and "advertised-but-unshipped" are index-level
 * conditions at all. Keep both: the anchor style is what an assembler needs, the
 * push style is what the writers currently emit, and the two must not be
 * silently conflated in a fixture.
 */
export function chainDeltaStart(bundleId: string): string {
  return `delta-${bundleId}`;
}

/** One bundle record in a `chainIndexes` spec, long form. */
export interface ChainRecordSpec {
  /** Bundle id. Must be unique across the whole spec — `from` resolves by it. */
  id: string;
  /**
   * Id of the record this one chains onto. Must name a record declared
   * somewhere in the spec; how it becomes a `fromEntryUuid` is `linkStyle`.
   *
   * Under the default `"anchor"` style it is the anchor's head, and it is NOT
   * repaired when that anchor ships an empty head: `b4<-b3` where b3 has
   * `head: ""` yields `fromEntryUuid: ""`, which is precisely the shape the
   * empty-head rule exists to reject ("two empty strings are not a match",
   * src/hub/threads.ts). A builder that quietly fixed it would delete the case.
   */
  from?: string;
  /**
   * Raw `fromEntryUuid`, used verbatim — the escape hatch `from` deliberately
   * refuses. `null` is a root. Use with `chainHead("x")` for a gap.
   */
  fromUuid?: string | null;
  /** This record's `headEntryUuid`. `""` is legal and is its own test case. */
  head?: string;
  /** Defaults to "full" for a root and "continuation" for a linked record. */
  type?: HubBundleRecord["type"];
  /** `sessionIdInBundle`; defaults per MACHINE, since that is what a push writes. */
  sessionId?: string;
  messageCount?: number;
  pushedAt?: string;
  hasWorkspace?: boolean;
}

/** A record is either `"<id>"` (root) or `"<id><-<anchorId>"` (linked), or the long form. */
export type ChainRecordInput = string | ChainRecordSpec;

/**
 * How `from` is rendered into `fromEntryUuid`. See `chainDeltaStart` — the two
 * are different by MEASUREMENT, not by taste.
 *
 * - `"anchor"` (default): the anchor record's `headEntryUuid`, i.e. what spec
 *   §4.2's head-keyed walk needs and what the plan's `b1<-b0` notation says.
 * - `"push"`: what `src/diff.ts` actually writes — the first uuid of this
 *   record's own delta, which equals no record's head. Every linked record in a
 *   `"push"`-style fixture therefore dangles, which is the defect, reproduced
 *   synthetically.
 */
export type ChainLinkStyle = "anchor" | "push";

export interface ChainIndexesOptions {
  threadId?: string;
  projectId?: string;
  projectPath?: string;
  linkStyle?: ChainLinkStyle;
  /**
   * Per-machine overrides for the THREAD-level fields — the projection of local
   * state that sits beside the bundle list (`push.ts` builds the two in
   * separate loops, which is what makes them able to disagree).
   *
   * This is how "advertised-but-unshipped" is built: give a machine a
   * `headEntryUuid` no record ships. It is also the deliberate pin for
   * resolution, `lastActiveAt` being `newerThreadCopy`'s FIRST key.
   *
   * `bundles` is excluded — that is what the spec argument is for.
   */
  advertise?: Record<string, Omit<Partial<HubThreadEntry>, "bundles">>;
}

/**
 * Every machine's thread entry carries this `lastActiveAt` unless `advertise`
 * says otherwise, so the resolver's first key is a deliberate TIE by default
 * and a fixture that cares about the winner has to say so. Exported so a test
 * can pin a machine relative to it without re-guessing the constant.
 */
export const CHAIN_LAST_ACTIVE_AT = "2026-07-21T00:00:00.000Z";

/** Thread-level `messageCount` default — equal for every machine, same reason. */
const CHAIN_MESSAGE_COUNT = 1;

const CHAIN_PUSHED_AT_BASE = Date.parse("2026-07-21T12:00:00.000Z");

function parseChainRecord(input: ChainRecordInput): ChainRecordSpec {
  if (typeof input !== "string") return input;
  const parts = input.split("<-");
  if (parts.length > 2) {
    throw new Error(`chainIndexes: more than one "<-" in ${JSON.stringify(input)}`);
  }
  const id = parts[0].trim();
  if (!id) throw new Error(`chainIndexes: empty bundle id in ${JSON.stringify(input)}`);
  if (parts.length === 1) return { id };
  const from = parts[1].trim();
  if (!from) throw new Error(`chainIndexes: empty anchor id in ${JSON.stringify(input)}`);
  return { id, from };
}

/**
 * `HubIndexJson[]` for one thread whose bundle records are spread across
 * machines, from a compact per-machine description.
 *
 * ```ts
 * chainIndexes({ m1: ["b0"], m2: ["b1<-b0"], m3: ["b2<-b1"] })
 * ```
 *
 * `b1<-b0` is "bundle b1 that chains onto b0", and a bare id is a root
 * (`fromEntryUuid: null`). The arrow is the whole point of the notation: the
 * link is the thing that has never been exercised, so it is the thing the call
 * site states.
 *
 * **How the arrow becomes a field value is `linkStyle`, and the default is NOT
 * what the product writes today** — see `chainDeltaStart`. `"anchor"` (default)
 * renders b0's head into b1's `fromEntryUuid`, which is the spec's reading and
 * the only one under which gap/fork/unshipped are index-level conditions;
 * `"push"` renders what `src/diff.ts` emits.
 *
 * Deliberate properties, each of which a plainer builder would have lost:
 *
 * - **`pushedAt` descends in declaration order** — the REVERSE of link order in
 *   the linear case. The hub stamps nothing, so `pushedAt` is the pushing
 *   machine's wall clock and ordering by it reinstated a measured silent revert
 *   (spec §4.4.1). An implementation that sorts by it therefore fails on these
 *   fixtures instead of passing by accident. Override per record when a test
 *   needs a stated stamp.
 * - **Indexes come back in the spec's own key order**, not sorted. `resolveThreads`
 *   promises an answer independent of index iteration order; handing them back
 *   sorted would hide a violation of that. Write the same spec with the keys
 *   reversed and the resolution must not move.
 * - **Every machine ties on `lastActiveAt` and `messageCount`** unless
 *   `advertise` says otherwise, so nothing is pinned by accident — see
 *   `CHAIN_LAST_ACTIVE_AT`.
 * - **`file` is built by the real `layout.ts` builders**, so a fixture record's
 *   path cannot drift from what a push writes, and an unsafe id throws here
 *   rather than at some later `backend.read`.
 */
export function chainIndexes(
  spec: Record<string, ChainRecordInput[]>,
  opts: ChainIndexesOptions = {}
): HubIndexJson[] {
  const threadId = opts.threadId ?? "t1";
  const projectId = opts.projectId ?? "p";
  const projectPath = opts.projectPath ?? "/x";
  const linkStyle = opts.linkStyle ?? "anchor";

  // Pass 1: normalize, and learn every declared record's head before any
  // anchor is resolved — a chain may legally be declared out of order (and a
  // fork or a second root has no "order" to be in).
  const machines = Object.keys(spec);
  const normalized = new Map<string, ChainRecordSpec[]>();
  const headById = new Map<string, string>();
  for (const machineId of machines) {
    const records = spec[machineId].map(parseChainRecord);
    normalized.set(machineId, records);
    for (const r of records) {
      if (headById.has(r.id)) {
        throw new Error(`chainIndexes: duplicate bundle id ${JSON.stringify(r.id)}`);
      }
      headById.set(r.id, r.head ?? chainHead(r.id));
    }
  }

  // Pass 2: build. `declared` is the GLOBAL declaration index, so pushedAt
  // descends across machines and not just within one.
  let declared = 0;
  const indexes: HubIndexJson[] = [];
  for (const machineId of machines) {
    const records = normalized.get(machineId) ?? [];
    const bundles: HubBundleRecord[] = records.map((r) => {
      if (r.from !== undefined && r.fromUuid !== undefined) {
        throw new Error(`chainIndexes: ${r.id} declares both "from" and "fromUuid"`);
      }
      let fromEntryUuid: string | null;
      if (r.from !== undefined) {
        const anchor = headById.get(r.from);
        if (anchor === undefined) {
          throw new Error(
            `chainIndexes: ${r.id} anchors on undeclared record ${JSON.stringify(r.from)} — ` +
              `for a deliberate gap write fromUuid: chainHead(${JSON.stringify(r.from)})`
          );
        }
        fromEntryUuid = linkStyle === "anchor" ? anchor : chainDeltaStart(r.id);
      } else {
        fromEntryUuid = r.fromUuid ?? null;
      }
      const pushedAt =
        r.pushedAt ?? new Date(CHAIN_PUSHED_AT_BASE - declared * 60_000).toISOString();
      declared++;
      return {
        bundleId: r.id,
        file: `${bundleDir(projectId, machineId)}/${bundleFileName(pushedAt, r.id)}`,
        type: r.type ?? (fromEntryUuid === null ? "full" : "continuation"),
        sessionIdInBundle: r.sessionId ?? `sess-${machineId}`,
        fromEntryUuid,
        headEntryUuid: r.head ?? chainHead(r.id),
        messageCount: r.messageCount ?? 1,
        pushedAt,
        hasWorkspace: r.hasWorkspace ?? false,
      };
    });

    const threadEntry: HubThreadEntry = {
      localSessionId: `local-${machineId}`,
      slug: "chain",
      summary: "a thread whose bundles are spread across machines",
      // What a machine with nothing unpushed advertises: the head of the last
      // bundle it shipped. A machine listing no bundles advertises nothing —
      // "" rather than a borrowed uuid, since an empty head is never a link.
      headEntryUuid: bundles.length > 0 ? bundles[bundles.length - 1].headEntryUuid : "",
      messageCount: CHAIN_MESSAGE_COUNT,
      lastActiveAt: CHAIN_LAST_ACTIVE_AT,
      bundles,
      ...opts.advertise?.[machineId],
    };

    indexes.push({
      ...idx(machineId, { [threadId]: threadEntry }),
      projectId,
      projectPath,
    });
  }
  return indexes;
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
  /**
   * The two machines' HOME roots. Exposed (rather than left implicit in
   * `configDirB = join(homeB, ".claude")`) so a caller that has to run one more
   * step as A or B — `arrangeThreeMachines` does — can re-override HOME without
   * reverse-engineering it out of a config dir path.
   */
  homeA: string;
  homeB: string;
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

/** Options for `arrangeContinuation` beyond the entries B appends. */
export interface ContinuationArrangementOptions {
  /**
   * Machine NAMES for A and B, set before either machine registers on the hub.
   *
   * Off by default, so the existing callers' arrangements are byte-identical to
   * what they were. Worth setting whenever an assertion mentions a machine by
   * name: both temp homes run on one host, so the `hostname()` default gives A
   * and B the SAME name and any such assertion passes vacuously.
   */
  machineNames?: { a?: string; b?: string };
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
  makeEntries: EntryMaker = plainEntries,
  over: ContinuationArrangementOptions = {}
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
    // Before the push, which is what registers the machine on the hub.
    if (over.machineNames?.a) setMachineName(over.machineNames.a);
    const pushA = await hubPush({
      configDir: configDirA, projectPath: projectA, hubPath: hub,
      createProject: true, noWorkspace: true, claudeVersion: "2.1.81",
    });
    if (!pushA.success) throw new Error(`arrange: A's push failed: ${JSON.stringify(pushA)}`);

    restore.restore();
    restore = overrideHome(homeB);

    const configDirB = join(homeB, ".claude");
    if (over.machineNames?.b) setMachineName(over.machineNames.b);
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
      hub, homeA, homeB, configDirA, projectA, projectDirA, projectB, configDirB,
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

// ---- Three-machine arrangement (#35) ----

/** The Claude Code version every machine in these arrangements reports. */
export const FIXTURE_CLAUDE_VERSION = "2.1.81";

export const THREE_MACHINE_NAMES = {
  a: "sesh-machine-a",
  b: "sesh-machine-b",
  c: "sesh-machine-c",
} as const;

/**
 * Two entries machine A adds AFTER pulling B's continuation back — the
 * republish half of `arrangeThreeMachines({ resolvesTo: "A" })`.
 *
 * The TIMESTAMPS are the pin, and they are the reason this is its own maker
 * rather than a reuse of `localEntries`: they are strictly later than the ones
 * B's continuation carries, and `lastActiveAt` in a machine's index entry is
 * the last conversation entry's own timestamp (src/discovery.ts — the file
 * mtime is a floor only degraded transcripts reach). So this append, and
 * nothing else, decides `newerThreadCopy`'s FIRST key.
 *
 * `parentUuid` is B's head, so these EXTEND the thread rather than forking it —
 * the difference from `localEntries`, which anchors back on the base's own head.
 */
export const republishEntries: EntryMaker = (parentUuid, sessionId, projectPath) => [
  {
    uuid: "a-republish-1", parentUuid, timestamp: "2026-04-12T08:00:00Z", sessionId,
    cwd: projectPath, version: FIXTURE_CLAUDE_VERSION, type: "user",
    message: { role: "user", content: "back on A, one more round" },
  },
  {
    uuid: "a-republish-2", parentUuid: "a-republish-1", timestamp: "2026-04-12T08:00:05Z", sessionId,
    cwd: projectPath, version: FIXTURE_CLAUDE_VERSION, type: "assistant",
    message: { model: "claude-opus-4-6", id: "msg_republish", content: [{ type: "text", text: "Republishing." }] },
  },
];

export interface ThreeMachineArrangement extends ContinuationArrangement {
  homeC: string;
  configDirC: string;
  projectC: string;
  /** C's Claude projects folder for `projectC` — nothing is there until C pulls. */
  projectDirC: string;
  machineIdA: string;
  machineIdB: string;
  machineIdC: string;
  machineNameA: string;
  machineNameB: string;
  machineNameC: string;
  /** The single thread every machine's index holds a copy of. */
  threadId: string;
  /** Which machine's copy `resolveThreads` picks — VERIFIED at arrange time. */
  resolvesTo: "A" | "B";
  latestMachineId: string;
  /** The bundle ids each machine's index lists for the thread, in list order. */
  bundleIdsA: string[];
  bundleIdsB: string[];
  /** Run anything with HOME pointed at C. */
  onC<T>(fn: () => Promise<T>): Promise<T>;
  pullC(over?: Partial<Parameters<typeof hubPull>[0]>): ReturnType<typeof hubPull>;
  pushC(over?: Partial<Parameters<typeof hubPush>[0]>): ReturnType<typeof hubPush>;
  whereisC(over?: Partial<Parameters<typeof hubWhereis>[0]>): ReturnType<typeof hubWhereis>;
}

/** The machine id recorded under `home`, read through the real reader. */
function machineIdUnder(home: string, label: string): string {
  const restore = overrideHome(home);
  try {
    const identity = readMachineId();
    if (!identity) throw new Error(`arrange: machine ${label} has no machine-id.json yet`);
    return identity.id;
  } finally {
    restore.restore();
  }
}

/**
 * A REAL three-machine arrangement: one thread whose bundles are split across
 * two machines' indexes, plus a third machine C that has joined the hub and
 * linked the project but pulled nothing yet.
 *
 * Built on `arrangeContinuation` rather than beside it — the two #35 branches
 * differ only in what happens AFTER the ordinary A→B round trip, and none of
 * the three existing three-machine setups was reusable (all inline, all in test
 * files this task may not touch).
 *
 *   resolvesTo: "B"  A: [b0 full]                B: [b1 cont<-b0]
 *   resolvesTo: "A"  A: [b0 full, b2 cont<-b1]   B: [b1 cont<-b0]
 *
 * Either way the chain spans machines and no single index holds it whole, which
 * is the defect: a pull reads exactly one machine's bundle list.
 *
 * HOW THE RESOLUTION IS PINNED, and why it needed pinning at all. After the
 * ordinary round trip A and B hold the same entries, so `newerThreadCopy`'s
 * first three keys (`lastActiveAt`, `messageCount`, `headEntryUuid`) all tie and
 * the winner falls through to `machineId` — a `randomUUID()`, i.e. a coin flip
 * per run. That is why the existing integration test derives its expectation
 * from the result instead of assuming one. Here the resolution IS the subject,
 * so it is pinned on `lastActiveAt`, the FIRST key, through the same path
 * production uses (a conversation entry's own timestamp — see
 * `republishEntries`) and with no test-only seam and no index rewritten after
 * the fact. `messageCount` happens to agree in both branches, so the pin does
 * not depend on which key fires.
 *
 * And it is not merely intended: before returning, this reads the hub back
 * through `readAllIndexes` + `resolveThreads` and THROWS unless the real
 * resolver picked the machine the caller asked for. A fixture that silently
 * arranged the other branch would turn every test built on it green for the
 * wrong reason.
 *
 * Leaves HOME on A (as `arrangeContinuation` does); the `*C` helpers override it
 * per call and put it back.
 */
export async function arrangeThreeMachines(
  over: { resolvesTo?: "A" | "B" } = {}
): Promise<ThreeMachineArrangement> {
  const resolvesTo = over.resolvesTo ?? "B";
  const a = await arrangeContinuation(plainEntries, {
    machineNames: { a: THREE_MACHINE_NAMES.a, b: THREE_MACHINE_NAMES.b },
  });
  const homeC = mkdtempSync(join(tmpdir(), "sesh-3m-homeC-"));
  let projectC: string | undefined;
  const cleanup = (): void => {
    a.cleanup();
    rmSync(homeC, { recursive: true, force: true });
    if (projectC) rmSync(projectC, { recursive: true, force: true });
  };

  try {
    // HOME is A here, and A's base is already aged out of the liveness window.
    if (resolvesTo === "A") {
      const pullA = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, claudeVersion: FIXTURE_CLAUDE_VERSION,
      });
      if (!pullA.success) throw new Error(`arrange: A's pull-back failed: ${JSON.stringify(pullA)}`);
      const appended = (pullA as HubPullResult).appended ?? [];
      if (appended.length !== 1) {
        throw new Error(
          `arrange: A's pull-back did not splice B's continuation into A's own session ` +
            `(appended ${appended.length}) — the republish would then extend the wrong transcript`
        );
      }
      const anchor = readLastEntryUuid(a.basePath);
      if (!anchor) throw new Error("arrange: A's session has no head entry after the pull-back");
      appendEntries(a.basePath, republishEntries(anchor, a.baseSessionId, a.projectA));
      const pushA2 = await hubPush({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        noWorkspace: true, claudeVersion: FIXTURE_CLAUDE_VERSION,
      });
      if (!pushA2.success) throw new Error(`arrange: A's republish failed: ${JSON.stringify(pushA2)}`);
      if (pushA2.pushedSessions[0]?.type !== "continuation") {
        throw new Error("arrange: A republished a full bundle, not a continuation");
      }
    }

    const machineIdA = machineIdUnder(a.homeA, "A");
    const machineIdB = machineIdUnder(a.homeB, "B");

    // C joins: a hub member with the project linked, and nothing else. It has
    // not pulled, so it lists no bundles and writes no index until it does.
    const configDirC = join(homeC, ".claude");
    const restoreC = overrideHome(homeC);
    let machineIdC: string;
    try {
      const initC = await hubInit({ hubPath: a.hub, configScope: "user", cwd: homeC });
      if (!initC.success) throw new Error(`arrange: C's hub init failed: ${JSON.stringify(initC)}`);
      machineIdC = setMachineName(THREE_MACHINE_NAMES.c).id;
      projectC = mkdtempSync(join(tmpdir(), "sesh-3m-projC-"));
      writeLocalProjectId(projectC, {
        projectId: a.projectId, name: "projA",
        createdAt: "2026-04-10T00:00:00.000Z", createdByMachine: machineIdA,
      });
    } finally {
      restoreC.restore();
    }

    // The fixture measured against the real resolver, not against its own
    // construction — the same doctrine hub-fixtures.selfcheck.test.ts states.
    const { indexes } = await readAllIndexes(createFsBackend(a.hub), a.projectId);
    const resolved = resolveThreads(indexes);
    if (resolved.length !== 1) {
      throw new Error(`arrange: expected exactly one thread on the hub, got ${resolved.length}`);
    }
    const thread = resolved[0];
    const bundlesOf = (machineId: string): string[] =>
      (thread.copies.find((c) => c.machineId === machineId)?.bundles ?? []).map((b) => b.bundleId);
    const bundleIdsA = bundlesOf(machineIdA);
    const bundleIdsB = bundlesOf(machineIdB);
    if (bundleIdsA.length === 0 || bundleIdsB.length === 0) {
      throw new Error(
        `arrange: the chain does not span two machines (A: ${bundleIdsA.length}, B: ${bundleIdsB.length})`
      );
    }
    const expectedLatest = resolvesTo === "A" ? machineIdA : machineIdB;
    if (thread.latest.machineId !== expectedLatest) {
      throw new Error(
        `arrange: asked for resolvesTo ${resolvesTo}, but resolveThreads picked ` +
          `${thread.latest.machineId} (A=${machineIdA}, B=${machineIdB}); ` +
          `latest lastActiveAt=${thread.latest.lastActiveAt}`
      );
    }

    const onC = async <T>(fn: () => Promise<T>): Promise<T> => {
      const restore = overrideHome(homeC);
      try {
        return await fn();
      } finally {
        restore.restore();
      }
    };
    const project = projectC;

    return {
      ...a,
      homeC, configDirC, projectC: project,
      projectDirC: join(configDirC, "projects", encodeProjectPath(project)),
      machineIdA, machineIdB, machineIdC,
      machineNameA: THREE_MACHINE_NAMES.a,
      machineNameB: THREE_MACHINE_NAMES.b,
      machineNameC: THREE_MACHINE_NAMES.c,
      threadId: thread.threadId,
      resolvesTo,
      latestMachineId: thread.latest.machineId,
      bundleIdsA, bundleIdsB,
      onC,
      pullC: (o = {}) =>
        onC(() =>
          hubPull({
            configDir: configDirC, projectPath: project, hubPath: a.hub,
            latest: true, claudeVersion: FIXTURE_CLAUDE_VERSION, ...o,
          })
        ),
      pushC: (o = {}) =>
        onC(() =>
          hubPush({
            configDir: configDirC, projectPath: project, hubPath: a.hub,
            noWorkspace: true, claudeVersion: FIXTURE_CLAUDE_VERSION, ...o,
          })
        ),
      whereisC: (o = {}) =>
        onC(() =>
          hubWhereis({ configDir: configDirC, projectPath: project, hubPath: a.hub, ...o })
        ),
      cleanup,
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}
