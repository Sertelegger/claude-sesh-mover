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
