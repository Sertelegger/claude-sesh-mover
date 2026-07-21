import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodeProjectPath } from "./platform.js";
import { readManifest } from "./manifest.js";
import { readLastEntryUuid } from "./jsonl.js";
export function syncStatePath(projectPath) {
    return join(homedir(), ".claude-sesh-mover", "sync-state", `${encodeProjectPath(projectPath)}.json`);
}
function defaultState(projectPath) {
    return {
        projectPath,
        schemaVersion: 1,
        peers: {},
        lineage: {},
        imported: {},
    };
}
export function readSyncState(projectPath) {
    const p = syncStatePath(projectPath);
    if (!existsSync(p))
        return defaultState(projectPath);
    let raw;
    try {
        raw = readFileSync(p, "utf-8");
    }
    catch {
        return defaultState(projectPath);
    }
    try {
        const parsed = JSON.parse(raw);
        if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
            parsed.peers === null ||
            typeof parsed.peers !== "object" ||
            parsed.lineage === null ||
            typeof parsed.lineage !== "object") {
            throw new Error("schema mismatch");
        }
        parsed.imported = parsed.imported ?? {};
        for (const entry of Object.values(parsed.imported)) {
            if (typeof entry.registered !== "boolean")
                entry.registered = true;
        }
        return parsed;
    }
    catch {
        const aside = `${p}.corrupt.${Date.now()}`;
        try {
            renameSync(p, aside);
        }
        catch {
            /* best effort */
        }
        return defaultState(projectPath);
    }
}
export function writeSyncState(state) {
    const p = syncStatePath(state.projectPath);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
    renameSync(tmp, p);
}
export function recordSentFromBundle(projectPath, peer, bundleDir) {
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
    if (peer.name)
        p.name = peer.name;
    // readManifest is the validation chokepoint (assertSafeManifestIds runs
    // inside it) — session/continuation ids here are already guaranteed safe,
    // no need to re-validate.
    const manifest = readManifest(bundleDir);
    for (const s of manifest.sessions) {
        const localSessionId = s.type === "continuation" && s.continuation
            ? s.continuation.continuesLocalSessionId
            : s.sessionId;
        // Head uuid comes from the BUNDLE's snapshot, never the live JSONL:
        // entries appended mid-export stay "unsent" and ship next sync.
        const headUuid = readLastEntryUuid(join(bundleDir, "sessions", `${s.sessionId}.jsonl`)) ?? "";
        p.sent[localSessionId] = {
            headEntryUuid: headUuid,
            messageCount: s.messageCount,
            sentAsType: s.type === "continuation" ? "continuation" : "full",
            sentAsSessionId: s.sessionId,
        };
    }
    writeSyncState(state);
}
// Mark a single local session as already-known-to `peer`, without requiring
// a bundle directory on disk (unlike recordSentFromBundle, which derives the
// head uuid + session mapping from a manifest). Used by hub pull: a bundle
// pulled through the hub carries manifest.sourceMachineId set to the
// ORIGINATING machine (see hub/push.ts), so importSession's own peer
// bookkeeping (importer.ts) only ever credits that machine, never the hub
// itself. Without also recording it here, this machine's first push back to
// the hub would see no baseline for the hub's peer id and re-upload the
// whole session as "full" instead of recognizing later edits as a
// continuation (hub/push.ts's incremental diff only consults
// state.peers[hubPeerId]?.sent).
export function recordSentToPeer(projectPath, peer, localSessionId, sent) {
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
    if (peer.name)
        state.peers[peer.id].name = peer.name;
    state.peers[peer.id].sent[localSessionId] = sent;
    writeSyncState(state);
}
export function getThreadId(state, localSessionId) {
    return state.hub?.threadByLocalSession[localSessionId] ?? null;
}
// Files stay schemaVersion 1 until hub data is first written: non-hub users
// keep v1 files readable by older plugin versions. Older versions treat v2
// files as corrupt (rename-aside + fresh state) — that loses only peer
// bookkeeping, never session data.
export function setThreadId(state, hubId, localSessionId, threadId) {
    if (!state.hub) {
        state.hub = { hubId, threadByLocalSession: {} };
        state.schemaVersion = 2;
    }
    state.hub.threadByLocalSession[localSessionId] = threadId;
}
//# sourceMappingURL=sync-state.js.map