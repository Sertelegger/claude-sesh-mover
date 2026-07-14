import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodeProjectPath } from "./platform.js";
import { readManifest } from "./manifest.js";
import { readLastEntryUuid } from "./jsonl.js";
import type { SyncState } from "./types.js";

export function syncStatePath(projectPath: string): string {
  return join(
    homedir(),
    ".claude-sesh-mover",
    "sync-state",
    `${encodeProjectPath(projectPath)}.json`
  );
}

function defaultState(projectPath: string): SyncState {
  return {
    projectPath,
    schemaVersion: 1,
    peers: {},
    lineage: {},
    imported: {},
  };
}

export function readSyncState(projectPath: string): SyncState {
  const p = syncStatePath(projectPath);
  if (!existsSync(p)) return defaultState(projectPath);
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return defaultState(projectPath);
  }
  try {
    const parsed = JSON.parse(raw) as SyncState;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.peers === null ||
      typeof parsed.peers !== "object" ||
      parsed.lineage === null ||
      typeof parsed.lineage !== "object"
    ) {
      throw new Error("schema mismatch");
    }
    parsed.imported = parsed.imported ?? {};
    return parsed;
  } catch {
    const aside = `${p}.corrupt.${Date.now()}`;
    try {
      renameSync(p, aside);
    } catch {
      /* best effort */
    }
    return defaultState(projectPath);
  }
}

export function writeSyncState(state: SyncState): void {
  const p = syncStatePath(state.projectPath);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
}

export function recordSentFromBundle(
  projectPath: string,
  peer: { id: string; name?: string },
  bundleDir: string
): void {
  const state = readSyncState(projectPath);
  if (!state.peers[peer.id]) {
    state.peers[peer.id] = {
      name: peer.name ?? peer.id,
      lastSentAt: null,
      lastReceivedAt: null,
      sent: {},
      received: {},
    };
  }
  const p = state.peers[peer.id];
  p.lastSentAt = new Date().toISOString();
  if (peer.name) p.name = peer.name;

  const manifest = readManifest(bundleDir);
  for (const s of manifest.sessions) {
    const localSessionId =
      s.type === "continuation" && s.continuation
        ? s.continuation.continuesLocalSessionId
        : s.sessionId;
    // Head uuid comes from the BUNDLE's snapshot, never the live JSONL:
    // entries appended mid-export stay "unsent" and ship next sync.
    const headUuid =
      readLastEntryUuid(join(bundleDir, "sessions", `${s.sessionId}.jsonl`)) ?? "";
    p.sent[localSessionId] = {
      headEntryUuid: headUuid,
      messageCount: s.messageCount,
      sentAsType: s.type === "continuation" ? "continuation" : "full",
      sentAsSessionId: s.sessionId,
    };
  }
  writeSyncState(state);
}
