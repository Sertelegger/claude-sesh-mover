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
/**
 * How many workspace generations this machine remembers having held.
 *
 * The list is what makes a merge base provably common to both trees (see
 * `knownWorkspaceGenerations`), so this bound is the one place that guarantee
 * degrades: a peer more than this many generations behind us declares a base we
 * have forgotten, and the pull then finds no common generation and falls to
 * no-ancestor mode — a loud skip — rather than merging against a guess. That is
 * the safe direction to degrade in, and 50 (fifty workspace pushes or pulls on
 * THIS machine with no sync from that peer in between) is deep enough that
 * reaching it means the peer has effectively stopped syncing. It is bounded at
 * all because each entry is ~200 bytes of a file rewritten on every hub
 * operation.
 */
export const MAX_WORKSPACE_GENERATIONS = 50;
/**
 * Record a workspace generation this machine's tree now reflects — pushed or
 * applied — as the new head of its generation history.
 *
 * A generation is a POINTER at a bundle on the hub, never a copy of the tree,
 * because every workspace payload is a full snapshot and the hub already stores
 * it.
 *
 * Three rules the callers depend on:
 *
 * - **Write it only for a generation this machine's tree actually reflects.**
 *   Recording a generation that was never applied (a skipped payload, say)
 *   would make the NEXT merge read "present in the ancestor, absent locally"
 *   as a deliberate local deletion, so files the user never received would be
 *   silently withheld rather than delivered.
 * - **The history matters, not just the head.** `lastWorkspace` alone answers
 *   "what does our tree look like now"; choosing a legal merge base needs "did
 *   we ever hold the generation the peer says it built on", which only the list
 *   can answer. Keeping the head alone is what let a pull merge against a
 *   generation one of the two trees had never held.
 * - `generation.pushedAt` dates the BUNDLE and is DIAGNOSTIC ONLY: it is the
 *   pushing machine's wall clock — the hub is a passive filesystem and stamps
 *   nothing — so it must never be compared with another machine's stamp to
 *   order two generations.
 *
 * Same v1/v2 discipline as `setThreadId`: the hub block (and with it
 * schemaVersion 2) appears only once hub data is first written.
 */
export function setLastWorkspace(state, hubId, generation) {
    if (!state.hub) {
        state.hub = { hubId, threadByLocalSession: {} };
        state.schemaVersion = 2;
    }
    const ref = {
        bundleId: generation.bundleId,
        file: generation.file,
        pushedAt: generation.pushedAt,
        syncedAt: new Date().toISOString(),
    };
    const rest = knownWorkspaceGenerations(state).filter((g) => g.bundleId !== ref.bundleId);
    state.hub.lastWorkspace = ref;
    // Re-applying a generation we already hold moves it back to the head instead
    // of duplicating it: the list is a SET ordered by recency, and a duplicate
    // would burn one of the bounded slots for no information.
    state.hub.workspaceGenerations = [ref, ...rest].slice(0, MAX_WORKSPACE_GENERATIONS);
}
/**
 * Every workspace generation this machine's tree has passed through, most
 * recent first.
 *
 * This is one half of the "common to both trees" test that a 3-way merge base
 * must pass. The other half is what the incoming bundle chain declares it
 * descends from (`manifest.workspace.basedOn`); the intersection is the set of
 * legal bases, and `hub/pull.ts`'s `chooseMergeAncestor` takes the newest of
 * them.
 *
 * No timestamp is involved in that decision, deliberately. `pushedAt` is the
 * pushing machine's clock, so ordering two machines' generations by it is
 * meaningless — and a machine whose clock ran fast could otherwise talk a peer
 * into merging against the peer's OWN newest generation, which is precisely the
 * shape that silently reverts the peer's work.
 *
 * `lastWorkspace` leads whenever it is not already the head, so a state file
 * written before the list existed — or hand-edited — still contributes it.
 */
export function knownWorkspaceGenerations(state) {
    const hub = state.hub;
    if (!hub)
        return [];
    const list = hub.workspaceGenerations ?? [];
    const head = hub.lastWorkspace;
    if (head && list[0]?.bundleId !== head.bundleId) {
        return [head, ...list.filter((g) => g.bundleId !== head.bundleId)];
    }
    return list.slice(); // never hand out the live array: callers only read
}
//# sourceMappingURL=sync-state.js.map