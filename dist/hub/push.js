import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFsBackend } from "./backend.js";
import { HUB_JSON, bundleDir, bundleFileName } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import { resolveProjectIdentity, createHubProject, linkToHubProject, localGitRemotes, readLocalProjectId, } from "./identity.js";
import { registerMachine } from "./init.js";
import { buildIndexFile, readMachineIndex, writeMachineIndex } from "./index-file.js";
import { snapshotWorkspace } from "./workspace.js";
import { exportAllSessions } from "../exporter.js";
import { createArchive } from "../archiver.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { readManifest } from "../manifest.js";
import { readLastEntryUuid } from "../jsonl.js";
import { readSyncState, writeSyncState, recordSentFromBundle, getThreadId, setThreadId } from "../sync-state.js";
export async function hubPush(opts) {
    // An empty array is programmatically distinct from "omitted" but must mean
    // the same thing here — otherwise it mints zero threads (the filter below
    // matches nothing) while still exporting every session (exportAllSessions
    // treats [] as "no filter" today), silently over-exporting.
    const sessionIds = opts.sessionIds && opts.sessionIds.length > 0 ? opts.sessionIds : undefined;
    let lock;
    try {
        lock = acquireProjectLock(opts.projectPath);
    }
    catch (e) {
        if (e instanceof LockBusyError) {
            return {
                success: false, command: "push", reason: "lock-busy",
                holderPid: e.holderPid, ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
                suggestion: "Another sesh-mover hub operation is running for this project — wait for it or retry.",
            };
        }
        throw e;
    }
    // Staging is created inside the protecting try so a mkdtemp failure still
    // releases the lock in the finally (review fix: post-acquire throw window).
    let staging = null;
    try {
        staging = mkdtempSync(join(tmpdir(), "sesh-hub-push-"));
        const backend = createFsBackend(opts.hubPath);
        const warnings = [];
        if (lock.stoleStale) {
            warnings.push("Stole a stale project lock left by a previous sesh-mover hub operation (likely crashed or was killed) — proceeding, but verify no other push/pull is genuinely in progress.");
        }
        const machine = loadOrCreateMachineId();
        // Identity
        let local;
        if (opts.projectIdOverride) {
            local = await linkToHubProject(backend, opts.projectPath, opts.projectIdOverride);
        }
        else if (opts.createProject && !readLocalProjectId(opts.projectPath)) {
            local = await createHubProject(backend, opts.projectPath, machine.id);
        }
        else {
            const resolution = await resolveProjectIdentity(backend, opts.projectPath);
            if (resolution.kind === "linked")
                local = resolution.local;
            else if (resolution.kind === "match") {
                local = await linkToHubProject(backend, opts.projectPath, resolution.hubProject.projectId);
                warnings.push(`Linked to hub project ${resolution.hubProject.name} via git remote ${resolution.matchedRemote}.`);
            }
            else {
                return {
                    success: false, command: "push", reason: "unlinked",
                    linkCandidates: resolution.candidates,
                    suggestion: "Pass --project-id <id> to link to an existing hub project, or --create-project to mint a new one.",
                };
            }
        }
        await registerMachine(opts.hubPath);
        const hub = JSON.parse((await backend.read(HUB_JSON)).toString());
        const hubPeerId = `hub:${hub.hubId}`;
        opts.onProgress?.({ phase: "hub-push", percent: 0 });
        // Thread minting for every session in scope
        let sessions = discoverSessions(opts.configDir, opts.projectPath);
        if (sessionIds)
            sessions = sessions.filter((s) => sessionIds.includes(s.sessionId));
        const state = readSyncState(opts.projectPath);
        for (const s of sessions) {
            if (!getThreadId(state, s.sessionId))
                setThreadId(state, hub.hubId, s.sessionId, randomUUID());
        }
        writeSyncState(state);
        // Incremental export against the hub pseudo-peer. One export path:
        // exportAllSessions honors sessionIds (undefined = all) and errors on
        // any requested id that doesn't exist.
        const bundleId = randomUUID();
        const exportResult = await exportAllSessions({
            configDir: opts.configDir,
            projectPath: opts.projectPath,
            sessionIds,
            outputDir: staging,
            name: "bundle",
            excludeLayers: [],
            claudeVersion: opts.claudeVersion,
            incremental: {
                sourceMachineId: machine.id,
                sourceMachineName: machine.name,
                targetMachineId: hubPeerId,
                targetMachineName: "hub",
                peerSent: state.peers[hubPeerId]?.sent ?? {},
            },
            onProgress: opts.onProgress,
        });
        if (!exportResult.success)
            return exportResult;
        const bundleStaging = exportResult.exportPath;
        const manifest = readManifest(bundleStaging);
        if (manifest.sessions.length === 0) {
            // Every discovered session's head already matches what the hub has
            // recorded as sent — nothing to push. Return before any hub write
            // (no bundle archive, no index rewrite); the outer finally cleans up
            // staging.
            opts.onProgress?.({ phase: "hub-push", percent: 100 });
            return {
                success: true, command: "push", projectId: local.projectId,
                bundleId: null, pushedSessions: [], upToDate: true, hasWorkspace: false, warnings,
            };
        }
        // Workspace payload — projects with no git remotes (including
        // remote-less git repositories), since there's no remote to reconstruct
        // the working tree from otherwise.
        let hasWorkspace = false;
        if (!opts.noWorkspace && localGitRemotes(opts.projectPath).length === 0 && existsSync(opts.projectPath)) {
            const ws = await snapshotWorkspace(opts.projectPath, join(bundleStaging, "workspace"));
            if (ws.symlinksSkipped > 0)
                warnings.push(`${ws.symlinksSkipped} symlink(s) skipped in workspace snapshot.`);
            const manifestPath = join(bundleStaging, "manifest.json");
            const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
            m.workspace = { fileCount: ws.fileCount, byteSize: ws.byteSize, snapshotAt: new Date().toISOString() };
            writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
            hasWorkspace = true;
        }
        // Archive + stream into hub
        const pushedAt = new Date().toISOString();
        const archiveTmp = join(staging, "bundle.tar.gz");
        await createArchive(bundleStaging, archiveTmp, "gzip");
        const hubFile = `${bundleDir(local.projectId, machine.id)}/${bundleFileName(pushedAt, bundleId)}`;
        const w = await backend.writeStreamAtomic(hubFile);
        try {
            await pipeline(createReadStream(archiveTmp), w.stream);
            await w.commit();
        }
        catch (e) {
            await w.abort();
            throw e;
        }
        // Peer bookkeeping from the staged bundle (snapshot, never live files)
        recordSentFromBundle(opts.projectPath, { id: hubPeerId, name: "hub" }, bundleStaging);
        // Index projection
        const stateAfter = readSyncState(opts.projectPath);
        const records = [];
        const pushedSessions = [];
        for (const s of manifest.sessions) {
            const localSessionId = s.type === "continuation" && s.continuation ? s.continuation.continuesLocalSessionId : s.sessionId;
            const threadId = getThreadId(stateAfter, localSessionId);
            if (!threadId) {
                warnings.push(`no thread mapping for pushed session ${s.sessionId} — index skipped it.`);
                continue;
            }
            records.push({
                threadId,
                record: {
                    bundleId, file: hubFile,
                    type: s.type === "continuation" ? "continuation" : "full",
                    sessionIdInBundle: s.sessionId,
                    fromEntryUuid: s.continuation?.fromEntryUuid ?? null,
                    headEntryUuid: readLastEntryUuid(join(bundleStaging, "sessions", `${s.sessionId}.jsonl`)) ?? "",
                    messageCount: s.messageCount, pushedAt, hasWorkspace,
                },
            });
            pushedSessions.push({ threadId, sessionId: s.sessionId, type: s.type === "continuation" ? "continuation" : "full" });
        }
        const sessionsNow = discoverSessions(opts.configDir, opts.projectPath).map((s) => ({
            sessionId: s.sessionId, slug: s.slug, summary: s.slug,
            headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
            messageCount: s.messageCount, lastActiveAt: s.lastActiveAt,
        }));
        const prior = await readMachineIndex(backend, local.projectId, machine.id);
        await writeMachineIndex(backend, buildIndexFile({
            projectId: local.projectId, machineId: machine.id, projectPath: opts.projectPath,
            sessions: sessionsNow, state: stateAfter, priorIndex: prior, newBundles: records,
            now: pushedAt,
        }));
        opts.onProgress?.({ phase: "hub-push", percent: 100 });
        return {
            success: true, command: "push", projectId: local.projectId,
            bundleId, pushedSessions, upToDate: false, hasWorkspace, warnings,
        };
    }
    finally {
        if (staging)
            rmSync(staging, { recursive: true, force: true });
        lock.release();
    }
}
//# sourceMappingURL=push.js.map