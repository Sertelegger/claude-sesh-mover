import { mkdirSync, copyFileSync, readdirSync, existsSync, createReadStream, createWriteStream, statSync, } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { writeManifest, computeLayerDigest } from "./manifest.js";
import { discoverSessions } from "./discovery.js";
import { detectPlatform } from "./platform.js";
import { extractSummaryFromFile } from "./summary.js";
import { buildContinuationStream } from "./continuation.js";
import { computeIncrementalPlan } from "./diff.js";
import { readEntryUuids } from "./jsonl.js";
import { percentThrottle } from "./progress.js";
import { readLocalProjectId } from "./hub/identity.js";
/**
 * Digest every auxiliary layer directory this session actually landed in the
 * bundle. Hashes the BUNDLE's copies, never the source tree: the manifest
 * describes the bundle, so a copy that silently truncated (a full disk, a
 * hostile filesystem) must produce a digest that no longer matches its own
 * source — which is exactly what the importer will then catch.
 *
 * Returns `undefined` rather than an empty object when the session carries no
 * layers, so the manifest keeps its pre-0.6.0 shape for a bundle with none.
 */
async function computeSessionLayerDigests(exportPath, manifestSessionId) {
    const dirs = {
        subagents: join(exportPath, "sessions", manifestSessionId, "subagents"),
        "tool-results": join(exportPath, "sessions", manifestSessionId, "tool-results"),
        "file-history": join(exportPath, "file-history", manifestSessionId),
    };
    const out = {};
    for (const [layer, dir] of Object.entries(dirs)) {
        const digest = await computeLayerDigest(dir);
        if (digest !== null)
            out[layer] = digest;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
/**
 * Returns whether the layer LANDED in the bundle — i.e. whether `destDir` now
 * exists. That is deliberately "the source directory existed", not "at least one
 * file was copied": an empty layer directory is a layer the bundle carries (and
 * `computeLayerDigest` will hash it as such), so the two must agree. The whole
 * point of the return value is that `includedLayers` is derived from what is on
 * disk rather than from what was asked for — see `ExportManifest.includedLayers`.
 */
function copyDirIfExists(srcDir, destDir) {
    if (!existsSync(srcDir))
        return false;
    mkdirSync(destDir, { recursive: true });
    for (const file of readdirSync(srcDir)) {
        copyFileSync(join(srcDir, file), join(destDir, file));
    }
    return true;
}
// Stream copy with a sha256 tee: the copy and the manifest hash in one pass,
// O(chunk) memory. onBytes reports cumulative bytes for progress.
async function copyFileWithHash(src, dest, onBytes) {
    const hash = createHash("sha256");
    const input = createReadStream(src);
    const output = createWriteStream(dest);
    let bytes = 0;
    // Same error-latch hardening as rewriter.ts's rewriteJsonlStream and
    // continuation.ts's buildContinuationStream: without racing a latched
    // 'error' promise at both await points, a write failure (bad dest dir,
    // disk full, EACCES) either crashes the process (unhandled 'error' event)
    // or hangs forever (once(output, "drain") missing an 'error' that fired
    // before the wait began).
    const outputErrored = new Promise((_, reject) => output.once("error", reject));
    outputErrored.catch(() => { });
    try {
        for await (const chunk of input) {
            const buf = chunk;
            hash.update(buf);
            bytes += buf.length;
            if (!output.write(buf)) {
                await Promise.race([once(output, "drain"), outputErrored]);
            }
            onBytes?.(bytes);
        }
        output.end();
        await Promise.race([finished(output), outputErrored]);
    }
    catch (e) {
        output.destroy();
        throw e;
    }
    finally {
        input.destroy();
    }
    return `sha256:${hash.digest("hex")}`;
}
export async function exportSession(options) {
    const { configDir, projectPath, sessionId, outputDir, name, excludeLayers, claudeVersion, collisionCheck, summaryOverrides, incremental, noSummary, onProgress, } = options;
    const exportPath = join(outputDir, name);
    // Collision check
    if (collisionCheck && existsSync(exportPath)) {
        return {
            success: true,
            command: "export",
            exportPath,
            sessions: [],
            warnings: [],
            archivePath: null,
            collision: true,
            existingPath: exportPath,
        };
    }
    // Find the session
    const sessions = discoverSessions(configDir, projectPath);
    const target = sessionId
        ? sessions.find((s) => s.sessionId === sessionId)
        : sessions[0];
    if (!target) {
        return {
            success: false,
            command: "export",
            error: sessionId
                ? `Session ${sessionId} not found`
                : "No sessions found for this project",
        };
    }
    return exportSessions([target], configDir, projectPath, exportPath, excludeLayers, claudeVersion, "current", summaryOverrides, noSummary, incremental, onProgress);
}
export async function exportAllSessions(options) {
    const { configDir, projectPath, sessionIds, outputDir, name, excludeLayers, claudeVersion, summaryOverrides, incremental, noSummary, onProgress, } = options;
    let sessions = discoverSessions(configDir, projectPath);
    if (sessions.length === 0) {
        return {
            success: false,
            command: "export",
            error: "No sessions found for this project",
        };
    }
    if (sessionIds && sessionIds.length > 0) {
        const discovered = new Set(sessions.map((s) => s.sessionId));
        const missing = sessionIds.filter((id) => !discovered.has(id));
        if (missing.length > 0) {
            return {
                success: false,
                command: "export",
                error: missing.map((id) => `Session ${id} not found`).join("; "),
            };
        }
        const wanted = new Set(sessionIds);
        sessions = sessions.filter((s) => wanted.has(s.sessionId));
    }
    const exportPath = join(outputDir, name);
    return exportSessions(sessions, configDir, projectPath, exportPath, excludeLayers, claudeVersion, "all", summaryOverrides, noSummary, incremental, onProgress);
}
async function exportSessions(sessions, configDir, projectPath, exportPath, excludeLayers, claudeVersion, scope, summaryOverrides, noSummary, incremental, onProgress) {
    // POLICY: the layers this export is permitted to carry. It gates each copy
    // below and is never stamped into the manifest — see `landedLayers`.
    const requestedLayers = getAllLayers().filter((l) => !excludeLayers.includes(l));
    const warnings = [];
    // CONTENT: the layers this bundle actually ends up carrying, accumulated as
    // each payload lands. `includedLayers` is derived from this at the bottom
    // rather than from `requestedLayers`, because a layer can be requested and
    // still not travel — the source has none, or (for `memory`/`plans`) a rule
    // below declines to re-ship it. Stamping policy as content is what let every
    // hub bundle declare `memory` and `plans` while carrying neither (#53).
    const landedLayers = new Set();
    // Per manifest-session-id, so `ExportResult.sessions[].exportedLayers` can be
    // the honest per-session slice. Keyed by the id the layer directories were
    // written under, which for a continuation is its freshly minted id.
    const landedBySession = new Map();
    const record = (manifestSessionId, layers) => {
        landedBySession.set(manifestSessionId, layers);
        for (const l of layers)
            landedLayers.add(l);
    };
    const layerList = (set) => getAllLayers().filter((l) => set.has(l));
    mkdirSync(join(exportPath, "sessions"), { recursive: true });
    const sessionManifests = [];
    let toFull = sessions;
    let toContinuation = [];
    if (incremental) {
        const uuidsBySession = new Map();
        for (const session of sessions) {
            uuidsBySession.set(session.sessionId, await readEntryUuids(session.jsonlPath));
        }
        const plan = computeIncrementalPlan(sessions, incremental.peerSent, (session) => uuidsBySession.get(session.sessionId));
        warnings.push(...plan.warnings);
        toFull = plan.full;
        toContinuation = plan.continuation;
    }
    for (const [sessionIndex, session] of toFull.entries()) {
        const destJsonl = join(exportPath, "sessions", `${session.sessionId}.jsonl`);
        const bytesTotal = statSync(session.jsonlPath).size;
        const throttled = onProgress
            ? percentThrottle(bytesTotal, (percent, bytesProcessed) => onProgress({
                phase: "export-copy",
                sessionId: session.sessionId,
                sessionIndex,
                sessionCount: toFull.length,
                bytesProcessed,
                bytesTotal,
                percent,
            }))
            : undefined;
        // copyFileWithHash returns "sha256:<hex>" — used directly as the manifest hash
        const sessionHash = await copyFileWithHash(session.jsonlPath, destJsonl, throttled);
        const sessionBase = join(configDir, "projects", session.encodedProjectDir, session.sessionId);
        const sessionLayers = new Set(["jsonl"]);
        if (requestedLayers.includes("subagents") &&
            copyDirIfExists(join(sessionBase, "subagents"), join(exportPath, "sessions", session.sessionId, "subagents"))) {
            sessionLayers.add("subagents");
        }
        if (requestedLayers.includes("tool-results") &&
            copyDirIfExists(join(sessionBase, "tool-results"), join(exportPath, "sessions", session.sessionId, "tool-results"))) {
            sessionLayers.add("tool-results");
        }
        if (requestedLayers.includes("file-history") &&
            copyDirIfExists(join(configDir, "file-history", session.sessionId), join(exportPath, "file-history", session.sessionId))) {
            sessionLayers.add("file-history");
        }
        record(session.sessionId, sessionLayers);
        const summary = noSummary
            ? session.slug
            : summaryOverrides?.[session.sessionId] ??
                (await extractSummaryFromFile(session.slug, session.jsonlPath));
        sessionManifests.push({
            sessionId: session.sessionId,
            slug: session.slug,
            summary,
            createdAt: session.createdAt,
            lastActiveAt: session.lastActiveAt,
            messageCount: session.messageCount,
            gitBranch: session.gitBranch,
            entrypoint: session.entrypoint,
            integrityHash: sessionHash,
            type: incremental ? "full" : undefined,
            layerDigests: await computeSessionLayerDigests(exportPath, session.sessionId),
        });
    }
    for (const [contIndex, item] of toContinuation.entries()) {
        const newSessionId = randomUUID();
        onProgress?.({
            phase: "export-copy",
            sessionId: newSessionId,
            sessionIndex: contIndex,
            sessionCount: toContinuation.length,
        });
        const prevLocal = incremental?.peerSent[item.session.sessionId]?.sentAsSessionId;
        const contDest = join(exportPath, "sessions", `${newSessionId}.jsonl`);
        const { entryCount, integrityHash } = await buildContinuationStream({
            sourceJsonlPath: item.session.jsonlPath,
            outputPath: contDest,
            fromEntryIndex: item.fromEntryIndex,
            fromEntryUuid: item.fromEntryUuid,
            newSessionId,
            sourceSessionId: item.session.sessionId,
            sourceMachineId: incremental.sourceMachineId,
            sourceMachineName: incremental.sourceMachineName,
            previousLocalSessionId: prevLocal,
            targetProjectPath: projectPath,
            claudeVersion,
        });
        const contBase = join(configDir, "projects", item.session.encodedProjectDir, item.session.sessionId);
        const contLayers = new Set(["jsonl"]);
        if (requestedLayers.includes("subagents") &&
            copyDirIfExists(join(contBase, "subagents"), join(exportPath, "sessions", newSessionId, "subagents"))) {
            contLayers.add("subagents");
        }
        if (requestedLayers.includes("tool-results") &&
            copyDirIfExists(join(contBase, "tool-results"), join(exportPath, "sessions", newSessionId, "tool-results"))) {
            contLayers.add("tool-results");
        }
        if (requestedLayers.includes("file-history") &&
            copyDirIfExists(join(configDir, "file-history", item.session.sessionId), join(exportPath, "file-history", newSessionId))) {
            contLayers.add("file-history");
        }
        record(newSessionId, contLayers);
        sessionManifests.push({
            sessionId: newSessionId,
            slug: item.session.slug,
            summary: `continuation of ${item.session.slug}`,
            createdAt: new Date().toISOString(),
            lastActiveAt: item.session.lastActiveAt,
            messageCount: entryCount,
            gitBranch: item.session.gitBranch,
            entrypoint: item.session.entrypoint,
            integrityHash,
            type: "continuation",
            // Keyed by the CONTINUATION's freshly minted id — that is the name the
            // layer directories were copied under a few lines above, and the name
            // the importer will look for in the bundle.
            layerDigests: await computeSessionLayerDigests(exportPath, newSessionId),
            continuation: {
                continuesLocalSessionId: item.session.sessionId,
                continuesPeerSessionId: incremental?.peerSent[item.session.sessionId]?.sentAsSessionId,
                fromEntryIndex: item.fromEntryIndex,
                fromEntryUuid: item.fromEntryUuid,
                // The head this delta was diffed against — the only field in this block
                // that can link the bundle to its predecessor on a hub. `fromEntryUuid`
                // above is its CHILD and links nothing; the two are carried side by
                // side rather than one being derived from the other.
                anchorEntryUuid: item.anchorEntryUuid,
            },
        });
    }
    // ## The two shared-namespace layers, and why they get different rules
    //
    // `memory/` and `plans/` are unlike the three layers above: those are written
    // under a session id the import mints seconds earlier, so they cannot collide
    // and need no policy. These two are written into a directory the TARGET
    // already owns — per-project `memory/`, config-global `plans/` — so each needs
    // a stated rule, and their rules differ.
    //
    // Both used to sit behind a single `if (!incremental)` gate. That gate was
    // DELIBERATE, not an oversight: the 2026-04-21 incremental-sync plan carried
    // the line "Memory / plans: only include on a full export (incremental is
    // session-level)" and the implementation (3a695cf) dropped the comment while
    // keeping the code. What was never decided is what it does on the HUB, which
    // arrived three months later: `hub/push.ts` always passes an `incremental`
    // object — truthy even on a first push, where the sessions themselves fall
    // back to full — so the gate quietly meant that **memory has never once
    // crossed a hub**, and the importer's memory step is a structural no-op on
    // every pull (#53). The rationale survives for `plans`; it does not survive
    // for `memory`.
    const bundleLayers = new Set();
    let memoryDigest;
    if (requestedLayers.includes("memory") && sessions.length > 0) {
        // MEMORY — ships on an incremental bundle too, skipped only when the peer
        // demonstrably holds this exact directory already.
        //
        // A whole-file layer has no delta representation, so "incremental" can only
        // mean "do not re-send an identical copy". That is what the digest
        // comparison buys, for one hash of a handful of small markdown files.
        //
        // The DECISION is made against the source directory; the value RECORDED is
        // the digest of the bundle's own copy (stamped into the manifest, and from
        // there into `SyncStatePeer.memoryDigest` by whoever delivers the bundle).
        // Same reasoning as `computeSessionLayerDigests`: the ledger has to describe
        // the bytes that actually travelled, so a copy truncated in flight hashes to
        // something the source no longer matches and the next push re-sends it.
        //
        // Nothing known — a first push, a `--since` export, a reset state file —
        // means ship. Every unknown fails toward sending the memory, because the
        // opposite failure is invisible: the user is not told that their memories
        // stayed home.
        //
        // Deletion does not propagate, and cannot: this ships a directory, the
        // importer reconciles into a directory the target owns, and no bundle has
        // ever expressed "remove this file". A memory deleted here simply stops
        // being re-sent.
        const encoded = sessions[0].encodedProjectDir;
        const memoryDir = join(configDir, "projects", encoded, "memory");
        const sourceDigest = await computeLayerDigest(memoryDir);
        const peerAlreadyHasIt = sourceDigest !== null &&
            incremental?.peerMemoryDigest != null &&
            incremental.peerMemoryDigest === sourceDigest;
        if (!peerAlreadyHasIt && copyDirIfExists(memoryDir, join(exportPath, "memory"))) {
            bundleLayers.add("memory");
            memoryDigest = (await computeLayerDigest(join(exportPath, "memory"))) ?? undefined;
        }
    }
    if (!incremental && requestedLayers.includes("plans")) {
        // PLANS — still full-export only, and that is a deliberate deferral rather
        // than the old gate surviving by inertia.
        //
        // `<configDir>/plans` is config-dir-GLOBAL and this copy applies no project
        // filter, so it ships every plan on the machine, for every project the user
        // has ever worked on. On a plain export that is the user's own call, made
        // interactively, landing in their own `~/.sesh-mover/`. Widening it to the
        // incremental path would put it on the hub — a SHARED directory — via the
        // default-on SessionEnd auto-push, which is unattended by contract and has
        // no channel to disclose what it just uploaded.
        //
        // So the payload-scope defect gets fixed before the transport does, not
        // after. Until `plans/` is scoped to the project being pushed, an
        // incremental bundle carries none — and now SAYS it carries none, which is
        // the half of #53 that was actually costing anything.
        const plansDir = join(configDir, "plans");
        if (existsSync(plansDir)) {
            const planFiles = readdirSync(plansDir).filter((f) => f.endsWith(".md"));
            if (planFiles.length > 0) {
                const targetPlansDir = join(exportPath, "plans");
                mkdirSync(targetPlansDir, { recursive: true });
                for (const file of planFiles) {
                    copyFileSync(join(plansDir, file), join(targetPlansDir, file));
                }
                bundleLayers.add("plans");
            }
        }
    }
    for (const l of bundleLayers)
        landedLayers.add(l);
    const includedLayers = layerList(landedLayers);
    const manifest = {
        version: 1,
        plugin: "sesh-mover",
        exportedAt: new Date().toISOString(),
        sourcePlatform: detectPlatform(),
        sourceProjectPath: projectPath,
        sourceConfigDir: configDir,
        sourceClaudeVersion: claudeVersion,
        sessionScope: scope,
        includedLayers,
        sessions: sessionManifests,
        // sessionsDigest is deliberately absent here: writeManifest stamps it over
        // the finished list, so there is exactly one place that computes it and no
        // way for a manifest to be written with a stale one. It is a hash of the
        // per-session hashes and layer digests above, never a second pass over
        // content — see computeSessionsDigest for its scope and its limits.
        //
        // memoryDigest sits OUTSIDE that digest, like workspace/carry/projectId, so
        // adding it invalidates no bundle that predates it.
        memoryDigest,
        sourceMachineId: incremental?.sourceMachineId,
        sourceMachineName: incremental?.sourceMachineName,
        projectId: readLocalProjectId(projectPath)?.projectId,
        incremental: incremental ? true : undefined,
        baseline: incremental?.targetMachineId
            ? {
                targetMachineId: incremental.targetMachineId,
                targetMachineName: incremental.targetMachineName,
                lastSyncAt: incremental.lastSyncAt,
                referenceExport: incremental.referenceExport,
            }
            : undefined,
    };
    writeManifest(exportPath, manifest);
    for (const layer of excludeLayers) {
        warnings.push(`${layer} excluded by user request`);
    }
    return {
        success: true,
        command: "export",
        exportPath,
        sessions: sessionManifests.map((s) => ({
            originalId: s.sessionId,
            slug: s.slug,
            summary: s.summary,
            messageCount: s.messageCount,
            // This session's own landed layers, plus the bundle-level ones the bundle
            // carries at all. Two sessions in one bundle can differ here, which is the
            // honest answer — it used to be the same policy list for every session.
            exportedLayers: layerList(new Set([...(landedBySession.get(s.sessionId) ?? []), ...bundleLayers])),
        })),
        warnings,
        archivePath: null,
        collision: false,
    };
}
function getAllLayers() {
    return [
        "jsonl",
        "subagents",
        "file-history",
        "tool-results",
        "memory",
        "plans",
    ];
}
//# sourceMappingURL=exporter.js.map