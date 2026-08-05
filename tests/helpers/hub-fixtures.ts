/**
 * Shared HubIndexJson fixture builders for hub tests (moved out of
 * hub-threads.test.ts in Task 9 so hub-whereis.test.ts can reuse the same
 * shorthand instead of copy-pasting it).
 */
import type { HubBundleRecord, HubIndexJson } from "../../src/hub/layout.js";
import type { SyncState, SyncStatePeer } from "../../src/types.js";
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
