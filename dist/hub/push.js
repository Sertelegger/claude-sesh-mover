import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, createReadStream, } from "node:fs";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFsBackend } from "./backend.js";
import { bundleDir, bundleFileName } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import { resolveProjectIdentity, mintHubProject, readHubProjectAsLocal, writeLocalProjectId, scanGitRemotes, readLocalProjectId, localProjectIdPath, } from "./identity.js";
import { registerMachine } from "./init.js";
import { hubUnreachableRefusal, preflightHub } from "./preflight.js";
import { HubIoTimeoutError } from "./io-timeout.js";
import { buildIndexFile, readMachineIndex, writeMachineIndex } from "./index-file.js";
import { snapshotWorkspace, isNeverIncludable } from "./workspace.js";
import { captureCarry, gitChildEnv } from "./carry.js";
import { exportAllSessions } from "../exporter.js";
import { createArchive } from "../archiver.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { readManifest } from "../manifest.js";
import { readLastEntryUuid } from "../jsonl.js";
import { readSyncState, writeSyncState, recordSentFromBundle, getThreadId, setThreadId, setLastWorkspace, setPeerMemoryDigest, } from "../sync-state.js";
import { includeFilePath } from "../paths.js";
/** Cap on `ignoredNotCarried`: a sample the user can recognize, not an inventory. */
const MAX_IGNORED_REPORTED = 10;
/**
 * Top-level gitignored paths, as `git` spells them — `docs/` for a wholly
 * ignored directory, `src/generated.ts` for a single ignored file inside a
 * carried one. Each is a valid `.sesh-mover-include` pattern for exactly that thing.
 *
 * `-z` is not a nicety: without it git applies `core.quotePath`, so a name with
 * a space, a quote, a newline or any non-ASCII character comes back C-quoted
 * and octal-escaped, and a newline in a filename would split one entry into
 * two. This list is shown to a user and offered as a pattern to paste, so it
 * has to be the real bytes.
 *
 * Every failure — no git, not a repo, timeout, output past `maxBuffer` — is the
 * same answer: no discovery aid this time. It is a hint, never a gate.
 */
function listTopLevelIgnored(projectPath) {
    try {
        const out = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
            cwd: projectPath, encoding: "utf-8", timeout: 5000,
            // Not the inherited environment (see `gitChildEnv`): these paths are
            // offered to the user as `.sesh-mover-include` lines to paste, so they have to
            // come from the project's own repository and its own ignore rules.
            env: gitChildEnv(),
            stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024,
        });
        const paths = new Set();
        for (const entry of out.split("\0")) {
            // No trimming: with -z the bytes between separators ARE the path, and a
            // name may legitimately begin or end with a space.
            if (!entry)
                continue;
            if (isNeverIncludable(entry))
                continue; // can never be carried, so never suggest it
            paths.add(entry);
            if (paths.size >= MAX_IGNORED_REPORTED)
                break;
        }
        return [...paths];
    }
    catch {
        return [];
    }
}
/**
 * Undo the LOCAL half of a link this push made.
 *
 * Only the local half: there is no `backend.delete` call anywhere in src/, so a
 * hub project a failed push created stays on the hub and in every machine's
 * `linkCandidates` (recorded as out of scope — hub-side deletion needs
 * ownership semantics this slice doesn't have). That asymmetry is why the
 * caller REPORTS what is left rather than claiming a clean rollback.
 *
 * Re-reads before removing: the file is only ours to delete while it still
 * names the project id this push wrote. Anything else means something changed
 * it underneath us, and a link the user (or a concurrent operation) put there
 * is not collateral for our failure.
 *
 * It removes the FILE and nothing else — no rmdir of the parent. There used to
 * be one, and it was safe on the day it was written because the link then lived
 * at `<project>/.claude-sesh-mover/project.json`, so its parent was a directory
 * this plugin owned. Since 0.8.0 the link is the root dotfile
 * `<project>/.sesh-mover-project.json`, whose parent is the USER'S PROJECT
 * DIRECTORY — and `rmdirSync` succeeds on an empty one. A push into an empty
 * (or not-yet-existing) `--project-path` therefore deleted the directory it was
 * asked to push. Nothing needs cleaning up now: this push creates no directory
 * of its own inside the project.
 */
function rollbackLocalLink(projectPath, local) {
    try {
        const still = readLocalProjectId(projectPath);
        if (!still)
            return { removed: true, detail: "" };
        if (still.projectId !== local.projectId) {
            return { removed: false, detail: "it now names a different hub project" };
        }
        rmSync(localProjectIdPath(projectPath), { force: true });
        return { removed: true, detail: "" };
    }
    catch (e) {
        return { removed: false, detail: e.message };
    }
}
/**
 * The result for a push that threw after the identity was resolved.
 *
 * Typed rather than thrown, like every other refusal in this file, because the
 * one thing the user has to be told is not in the exception: whether this
 * project is linked now. A link means the SessionEnd auto-push will run
 * unattended, and for a git-less project that push uploads the whole working
 * tree. It is also the ONLY way an unattended push's outcome is recorded at all
 * — the hook endpoint calls `recordAutoPushOutcome` on a returned result and a
 * throw skips it (cli.ts).
 *
 * Every branch reports the same facts twice: as `details`/`suggestion` prose for
 * a human, and as the fields of `HubPushFailedResult` for a caller that has to
 * branch on them. See that type for why the prose alone was not enough.
 */
function failedAfterLink(projectPath, commits, error) {
    const cause = error instanceof Error ? error.message : String(error);
    const projectId = commits.local.projectId;
    // The bundle is atomic (`writeStreamAtomic`), so it is either on the hub or
    // it never existed — but the index that makes it findable is written after
    // it, and a failure in between leaves a real bundle no machine can see.
    const orphanBundle = commits.bundleCommitted
        ? " The bundle itself did reach the hub before the failure, but this machine's index was not updated to reference it, so no other machine can see it."
        : "";
    // Named once here so every branch's `suggestion` agrees: a minted hub project
    // outlives this push whatever happened locally.
    const orphanHubProject = commits.mintedHubProjectId;
    const base = {
        success: false,
        command: "push",
        reason: "failed-after-link",
        projectId,
        orphanHubProjectId: orphanHubProject,
        orphanBundle: commits.bundleCommitted,
    };
    const relinkSuggestion = orphanHubProject
        ? `Hub project ${orphanHubProject} was created before the failure and nothing removes a hub project, so pass --project-id ${orphanHubProject} on a later push to link to that one instead of minting a second.`
        : "Fix the cause above and push again; the project links again once a push gets past this point.";
    if (commits.preExisting) {
        return {
            ...base,
            linked: true,
            linkRolledBack: false,
            error: `The push failed: ${cause}`,
            details: `This project was already linked to hub project ${projectId} before this push, ` +
                `so it stays linked and nothing about the link changed.${orphanBundle}`,
            suggestion: "Fix the cause above and push again — the project stays linked either way.",
        };
    }
    if (!commits.linkWritten) {
        // The ordinary shape now that the local link is written only once the
        // bundle is on the hub: the failure landed before that, so there is no link
        // to undo and nothing arms the auto-push. The disk is still consulted
        // rather than assumed — a concurrent operation (a `pull --project-id`, a
        // second push) can have linked this directory while we worked, and claiming
        // "not linked" over the top of that is the exact mistake this result exists
        // to stop.
        const linkedNow = readLocalProjectId(projectPath) !== null;
        return {
            ...base,
            linked: linkedNow,
            linkRolledBack: false,
            error: `The push failed: ${cause}`,
            details: linkedNow
                ? `This push wrote no link — it commits one only after the bundle reaches the hub — but this ` +
                    `directory IS linked to the hub right now (something else linked it while this push ran), ` +
                    `so the SessionEnd auto-push is armed for it.${orphanBundle}`
                : `Nothing was linked: this push commits the local link only after the bundle reaches the hub, ` +
                    `so this project is NOT linked and the SessionEnd auto-push stays off for it.${orphanBundle}`,
            suggestion: relinkSuggestion,
        };
    }
    const rollback = rollbackLocalLink(projectPath, commits.local);
    return {
        ...base,
        linked: !rollback.removed,
        linkRolledBack: rollback.removed,
        error: `The push failed after this project was linked to the hub: ${cause}`,
        details: rollback.removed
            ? `The link this push created was removed, so this project is NOT linked to the hub ` +
                `and the SessionEnd auto-push stays off for it.${orphanBundle}`
            : `The link this push created could NOT be removed (${rollback.detail}), so this project IS ` +
                `linked to hub project ${projectId} and the SessionEnd auto-push is armed for it — ` +
                `run \`sesh-mover hub unlink\` (or delete .sesh-mover-project.json) to unlink it.${orphanBundle}`,
        suggestion: relinkSuggestion,
    };
}
/**
 * `onProgress`'s contract, which is invisible from any single call site — the
 * same note `hubPull` carries, and deliberately the same shape (#74, #78).
 *
 * **`{percent: 0}` is emitted as the first statement inside the outer `try`,
 * and `{percent: 100}` from the inner `finally` that wraps the whole body.**
 * Before that pairing, three exits emitted `0` and never `100` — the export's
 * own failure return, the `failedAfterLink` disclosure, and the rethrow above
 * it — so a consumer waiting for the terminal event waited forever. The close
 * therefore also fires on a typed refusal, on a failed push and on a thrown
 * exception, and `percent: 100` accordingly means *"the operation is over"*,
 * never *"it succeeded"*; the returned result says which.
 *
 * **The exits BEFORE the lock emit nothing at all, and that is the contract
 * rather than an oversight**: `lock-busy` — and a non-busy throw out of
 * `acquireProjectLock` — return above the `try`, so there is no `finally` to
 * close a pair they never opened. A consumer gets either no events or a matched
 * pair. The opening event moved here from just after `registerMachine` for the
 * same reason it moved in `hubPull`: it used to sit below the preflight, so the
 * two refusals that gate a push before it does anything (`hub-unreachable`,
 * `no-such-project`) emitted nothing while the failures emitted an unclosed `0`.
 *
 * **Where push DIFFERS from pull, and why it is not drift.** `hubPull` wraps its
 * terminal emit in a bare `catch` and swallows a throwing callback outright. It
 * has to: it has no `catch` of its own, so a throw from that `finally` would
 * escape as an untyped crash and destroy the typed refusal it was returning.
 * `hubPush` does have one, and that `catch` is the whole disclosure machinery —
 * `failedAfterLink`, which answers the only question that matters after a failed
 * push (*is this directory linked now, and whose link is it?*). So the terminal
 * emit sits INSIDE the region that `catch` guards, and a throw out of the
 * callback is routed through it rather than swallowed. Two things follow, both
 * intended:
 *
 * - It is consistent. Every other progress emission in this function is already
 *   able to fail a push that way — the `0` above, and every event
 *   `exportAllSessions` forwards — so swallowing the terminal one would make it
 *   the single special event rather than the rule.
 * - It preserves a documented, load-bearing behaviour: a callback that throws
 *   right after the link is committed is the deterministic seam
 *   `tests/hub-push.test.ts`'s "refuses to remove a link that now names a
 *   different project" uses to reproduce the concurrent-link-modification race.
 *   The obvious pull-shaped fix (swallow in a `finally`) silently deletes it,
 *   which is why this went unfixed once already.
 *
 * The one case that IS swallowed is a callback throwing while the body is
 * already failing — see the inner `finally`.
 *
 * Between the two events, granularity comes from `exportAllSessions`, which is
 * handed this same callback. The archive step is the hole: `createArchive` takes
 * no callback at all, the same gap `runFetchStage` documents on the pull side.
 */
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
    // Declared out here so the catch below can see it (a `catch` cannot see the
    // `try`'s own bindings). `commits` stays null until `resolveIdentity()`
    // returns, which is the line that divides "a throw leaves NOTHING behind, so
    // rethrow as before" from "a throw has something to disclose". Each field is
    // set at the exact moment the thing it describes becomes true — see
    // `PushCommits`.
    let commits = null;
    try {
        opts.onProgress?.({ phase: "hub-push", percent: 0 }); // see the doc above
        // Written by the inner `catch` and read by the inner `finally`, and that is
        // its whole job: it is how the terminal event knows whether a failure is
        // already in flight that a throwing callback must not be allowed to
        // replace. See the doc above for why push does not simply swallow.
        let bodyThrew = false;
        try {
            staging = mkdtempSync(join(tmpdir(), "sesh-hub-push-"));
            const backend = createFsBackend(opts.hubPath);
            // BEFORE the identity decision, the export and every hub write: is there a
            // hub here at all, and does `--project-id` name a project on it? Both
            // refusals are worth having only because nothing has happened yet (#75).
            const pre = await preflightHub({
                command: "push", hubPath: opts.hubPath, backend,
                projectIdOverride: opts.projectIdOverride,
            });
            if (pre.kind === "refuse")
                return pre.result;
            const warnings = [];
            // A budget that could not be read as written. Said once, up front, rather
            // than folded into the decline it causes — the two are different facts, and
            // on an unattended session-end push this is the only trace of the typo.
            warnings.push(...(opts.budgets?.warnings ?? []));
            if (lock.stoleStale) {
                warnings.push("Stole a stale project lock left by a previous sesh-mover hub operation (likely crashed or was killed) — proceeding, but verify no other push/pull is genuinely in progress.");
            }
            const machine = loadOrCreateMachineId();
            let pendingIdentity;
            if (opts.projectIdOverride) {
                pendingIdentity = { kind: "link", projectId: opts.projectIdOverride };
            }
            else if (opts.createProject && !readLocalProjectId(opts.projectPath)) {
                pendingIdentity = { kind: "create" };
            }
            else {
                const resolution = await resolveProjectIdentity(backend, opts.projectPath);
                if (resolution.kind === "linked")
                    pendingIdentity = { kind: "linked", local: resolution.local };
                else if (resolution.kind === "match") {
                    pendingIdentity = {
                        kind: "link",
                        projectId: resolution.hubProject.projectId,
                        note: `Linked to hub project ${resolution.hubProject.name} via git remote ${resolution.matchedRemote}.`,
                    };
                }
                else {
                    return {
                        success: false, command: "push", reason: "unlinked",
                        linkCandidates: resolution.candidates,
                        suggestion: "Pass --project-id <id> to link to an existing hub project, or --create-project to mint a new one.",
                    };
                }
            }
            /**
             * Do the HUB-side half of the identity and hand back the id everything
             * downstream is keyed by. Writes NOTHING under the project directory.
             *
             * The hub write stays here, before the payloads, on purpose. Under
             * `--create-project` the hub `projects/<id>/project.json` must exist before
             * any bundle path under that id is used, or the push leaves bytes on the
             * hub under an id `listHubProjects` skips — undiscoverable residue, and
             * worse than the orphan project this reports. In the link case the read is
             * a real existence gate on `--project-id`.
             */
            const resolveIdentity = async () => {
                if (pendingIdentity.kind === "linked") {
                    return {
                        local: pendingIdentity.local, preExisting: true,
                        linkWritten: false, mintedHubProjectId: null, bundleCommitted: false,
                    };
                }
                if (pendingIdentity.kind === "create") {
                    const minted = await mintHubProject(backend, opts.projectPath, machine.id);
                    // Recorded HERE, not after a helper that also writes the local link:
                    // a throw in between used to leave `committedLink` null, which made the
                    // catch rethrow bare and the orphaned hub project go unmentioned.
                    return {
                        local: minted, preExisting: false,
                        linkWritten: false, mintedHubProjectId: minted.projectId, bundleCommitted: false,
                    };
                }
                if (pendingIdentity.note)
                    warnings.push(pendingIdentity.note);
                return {
                    local: await readHubProjectAsLocal(backend, pendingIdentity.projectId),
                    preExisting: false, linkWritten: false, mintedHubProjectId: null, bundleCommitted: false,
                };
            };
            /**
             * Write the local link — the consent gate itself, and the last thing this
             * push commits.
             *
             * Called from exactly two places, both of them a point where this push HAS
             * delivered: the up-to-date early return (nothing to send, so the link is
             * the whole result — `tests/hub-push.test.ts` pins that deliberate
             * exception), and immediately after the bundle lands on the hub. Everything
             * between the export and the upload — the workspace snapshot, the carry,
             * the archive, the transfer itself — can now fail without arming anything.
             *
             * A pre-existing link is never rewritten: it is already the state this
             * would produce, and rewriting it would put a failed push's fingerprints on
             * a file the user committed to their repository.
             */
            const commitLocalLink = () => {
                if (!commits || commits.linkWritten || commits.preExisting)
                    return;
                writeLocalProjectId(opts.projectPath, commits.local);
                commits.linkWritten = true;
            };
            await registerMachine(opts.hubPath);
            // Read once, by the preflight above — a second read here would put back the
            // very `ENOENT` the `hub-unreachable` refusal replaces (#75).
            const hub = pre.hub;
            const hubPeerId = `hub:${hub.hubId}`;
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
                noSummary: opts.noSummary,
                incremental: {
                    sourceMachineId: machine.id,
                    sourceMachineName: machine.name,
                    targetMachineId: hubPeerId,
                    targetMachineName: "hub",
                    peerSent: state.peers[hubPeerId]?.sent ?? {},
                    // The memory layer's "already has it" ledger, the whole-file
                    // counterpart of `peerSent`. Absent on a first push, which is exactly
                    // when the memory must travel — see the memory block in exporter.ts.
                    // The hub is the peer here, so this is per-hub bookkeeping like the
                    // rest of `state.peers[hubPeerId]`.
                    peerMemoryDigest: state.peers[hubPeerId]?.memoryDigest ?? null,
                },
                onProgress: opts.onProgress,
            });
            if (!exportResult.success) {
                // Nothing is linked at this point — see `commitIdentity`. The `command`
                // is restated as this command's own: every CLI result is keyed by the
                // command the user ran (CLAUDE.md), and a `push` answering
                // `"command": "export"` sends a caller that branches on it down a path
                // that does not exist for push.
                return { ...exportResult, command: "push" };
            }
            const bundleStaging = exportResult.exportPath;
            const manifest = readManifest(bundleStaging);
            // The export produced something (even if it is "nothing new"), so this push
            // has earned an identity. Everything above this line leaves an unlinked
            // project unlinked AND has nothing to disclose, so it still rethrows;
            // everything BELOW it is covered by the catch at the bottom of this try
            // (see `PushCommits`).
            commits = await resolveIdentity();
            const local = commits.local;
            // ...and the exporter ran BEFORE any link existed, and it reads the
            // project id off disk (`readLocalProjectId` in exporter.ts). On a
            // `--create-project` push the staged manifest therefore carries no
            // `projectId`, and importer.ts's identity-planting step is what leaves a
            // machine bootstrapping from that bundle linked. Stamp it now — the same
            // in-place manifest patch the workspace and carry blocks below already use.
            if (manifest.projectId !== local.projectId) {
                const manifestPath = join(bundleStaging, "manifest.json");
                const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
                m.projectId = local.projectId;
                writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
                manifest.projectId = local.projectId;
            }
            if (manifest.sessions.length === 0) {
                // Every discovered session's head already matches what the hub has
                // recorded as sent — nothing to push. Return before any hub write
                // (no bundle archive, no index rewrite); the outer finally cleans up
                // staging.
                //
                // The deliberate exception to deferring the link until the bundle is on
                // the hub: this push has nothing to send and so will never reach that
                // point, yet it is a successful push of a project whose `projectId` is
                // part of the result below. A user who lost the committed
                // `.sesh-mover-project.json` gets it back from a no-op push.
                commitLocalLink();
                return {
                    success: true, command: "push", projectId: local.projectId,
                    bundleId: null, pushedSessions: [], upToDate: true, hasWorkspace: false, warnings,
                };
            }
            // Memoized: `git remote -v` gates both the workspace payload and the
            // ignored-path discovery aid below, and neither runs on the up-to-date
            // early return above — so a quiet auto-push with no workspace still spawns
            // nothing, and a manual push of a git project spawns it once, not twice.
            let gitScanCache = null;
            const gitScan = () => (gitScanCache ??= scanGitRemotes(opts.projectPath));
            // Neither payload is built when git could not be asked about this project's
            // remotes (see `GitRemoteScan`). The workspace snapshot copies the whole
            // project directory WITHOUT reading .gitignore, so taking that path on a
            // repository whose remotes are merely unknown uploads secrets a git project
            // never intended to publish — and this push may be the unattended SessionEnd
            // one. The carry needs a working `git` by definition. Say so instead, in the
            // shape the declined-carry warning already uses: no remedy is named that
            // this invocation has already foreclosed.
            if (gitScan().kind === "unknown" &&
                (!opts.noWorkspace || !opts.noCarry) &&
                existsSync(opts.projectPath)) {
                const scan = gitScan();
                warnings.push(`No project files or uncommitted work were included in this push: ${scan.detail}, so whether this project has a git remote could not be established. A full copy of the working tree is only safe for a project that genuinely has none — it does not read .gitignore — and the git-diff carry needs a working \`git\` of its own. The sessions pushed normally; once git can answer here, the files travel with the next push that has new session content.`);
            }
            // Workspace payload — projects with no git remotes (including
            // remote-less git repositories), since there's no remote to reconstruct
            // the working tree from otherwise.
            let hasWorkspace = false;
            if (!opts.noWorkspace && gitScan().kind === "none" && existsSync(opts.projectPath)) {
                const ws = await snapshotWorkspace(opts.projectPath, join(bundleStaging, "workspace"), {
                    maxBytes: opts.budgets?.workspaceMaxBytes,
                });
                if (ws.symlinksSkipped > 0)
                    warnings.push(`${ws.symlinksSkipped} symlink(s) skipped in workspace snapshot.`);
                // Rule-level diagnostics (an include list past a cap, an exclude set that
                // swallowed the whole tree, a payload over the snapshot budget). Every
                // one of them fails CLOSED — fewer files — which is invisible from the
                // outside without this.
                warnings.push(...ws.warnings);
                // `skipped` = over the snapshot budget, nothing copied. The sessions
                // still push; there is simply no payload to declare and — critically —
                // no generation to record. Recording an un-applied generation is the one
                // way this feature loses data quietly: the next merge would read the
                // whole un-sent tree as "deleted here".
                if (!ws.skipped) {
                    const manifestPath = join(bundleStaging, "manifest.json");
                    const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
                    // Declare what this snapshot descends from — read BEFORE the new
                    // generation is recorded below. A puller intersects this id with its own
                    // generation history, and only a hit makes a 3-way merge legal: it is the
                    // proof that a generation was held by both trees, which neither side can
                    // establish alone (see the field's doc in types.ts). `file` and
                    // `pushedAt` ride along as diagnostics only — the puller resolves the
                    // generation through its OWN record, so nothing here becomes a path or a
                    // comparison on the other machine.
                    const basedOnRef = readSyncState(opts.projectPath).hub?.lastWorkspace;
                    m.workspace = {
                        fileCount: ws.fileCount,
                        byteSize: ws.byteSize,
                        snapshotAt: new Date().toISOString(),
                        basedOn: basedOnRef
                            ? { bundleId: basedOnRef.bundleId, file: basedOnRef.file, pushedAt: basedOnRef.pushedAt }
                            : null,
                    };
                    writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
                    hasWorkspace = true;
                }
            }
            // Git-diff carry — the complement of the workspace snapshot: a project WITH
            // a remote reconstructs its committed state from git, so only the
            // uncommitted part has to travel (design §6.1). This is also what finally
            // gives `.sesh-mover-include` an effect on a git project: until this block existed
            // its only reader was `snapshotWorkspace`, which runs exactly when there
            // are NO remotes, so the discovery aid below offered a file that could not
            // do anything for the project being offered it.
            //
            // Gated on `rawCount > 0`, not on the normalized list: a self-hosted
            // `git@gitserver:team/repo.git` is a perfectly real remote that
            // `normalizeGitRemote` declines to canonicalize (no dot in the host), and
            // such a project must get the carry — the payload the .gitignore rules
            // apply to — rather than a whole-tree snapshot.
            let carryMeta;
            if (!opts.noCarry && gitScan().kind === "remotes" && existsSync(opts.projectPath)) {
                const diagnostics = [];
                // Contained deliberately, unlike the workspace snapshot above: this
                // branch runs `git` against a real user repository whose state is
                // unbounded (mid-rebase, submodules, 200k untracked files, a filesystem
                // that refuses a read), and no failure of the OPTIONAL half of a push may
                // cost the user the session bundle that is the point of the operation.
                const cap = await captureCarry(opts.projectPath, join(bundleStaging, "carry"), {
                    diagnostics, maxBytes: opts.budgets?.carryMaxBytes,
                })
                    .catch((e) => ({ captured: false, reason: "git-failed", detail: e.message }));
                warnings.push(...diagnostics);
                if (cap.captured) {
                    carryMeta = cap.meta;
                    const manifestPath = join(bundleStaging, "manifest.json");
                    const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
                    m.carry = cap.meta;
                    writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
                    if (cap.meta.reIncludedCount > 0) {
                        // Say what left the machine. `.gitignore` is where `.env` lives, and
                        // `ignoredNotCarried` exists so this choice is informed — reporting
                        // the opt-in as a silent success would undercut it.
                        const shown = cap.meta.reIncluded.join(", ");
                        const more = cap.meta.reIncludedCount - cap.meta.reIncluded.length;
                        warnings.push(`Carried ${cap.meta.reIncludedCount} gitignored file(s) because .sesh-mover-include names them: ${shown}${more > 0 ? `, and ${more} more` : ""}. They are on the hub now.`);
                    }
                    if (cap.meta.trackedIgnoredCount > 0) {
                        // A different disclosure with a different remedy, which is why it is
                        // not folded into the one above: the include list did not put these on the
                        // hub and removing an include-list line will not take them off it. They
                        // are gitignored files that git TRACKS, so the patch carries their
                        // uncommitted contents and no carry rule filters the patch.
                        const shown = cap.meta.trackedIgnored.join(", ");
                        const more = cap.meta.trackedIgnoredCount - cap.meta.trackedIgnored.length;
                        warnings.push(`The patch carries changes to ${cap.meta.trackedIgnoredCount} gitignored file(s) that git TRACKS, so .gitignore did not keep them off the hub: ${shown}${more > 0 ? `, and ${more} more` : ""}. They are on the hub now and nothing takes them off it; untrack them (git rm --cached) or push with --no-carry to keep the next push from carrying them again.`);
                    }
                    if (cap.meta.inProgress) {
                        warnings.push(`Uncommitted changes were captured during an in-progress ${cap.meta.inProgress}: the patch records the working tree as it stands, conflict markers included, and the ${cap.meta.inProgress} itself does not travel.`);
                    }
                }
                else if (cap.reason !== "clean" && cap.reason !== "not-git") {
                    // "clean" is the ordinary case and "not-git" cannot happen here (this
                    // branch already established a git remote), so everything else is a
                    // capture the user expected and did not get.
                    warnings.push(`Uncommitted changes were not carried: ${cap.detail ?? cap.reason}. They will be picked up by the next push that has new session content.`);
                }
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
                commits.bundleCommitted = true;
            }
            catch (e) {
                await w.abort();
                throw e;
            }
            // The bundle is on the hub, so this push has delivered: link the project.
            // Deferred all the way to here (rather than to just after the export) so
            // that a workspace snapshot that trips over an unreadable file, a carry
            // that cannot be captured, a full disk under the archive or a share that
            // vanished mid-upload all leave this directory unlinked and the SessionEnd
            // auto-push unarmed. Past this line there IS a link, and a later failure
            // rolls it back and says so.
            commitLocalLink();
            // Peer bookkeeping from the staged bundle (snapshot, never live files)
            recordSentFromBundle(opts.projectPath, { id: hubPeerId, name: "hub" }, bundleStaging);
            // The workspace generation this machine's tree now shares with the hub —
            // the ancestor input for the next pull's 3-way merge (design §5.2). Only
            // recorded once the bundle is committed to the hub: a generation the hub
            // does not hold cannot be fetched back as an ancestor.
            //
            // It describes the SNAPSHOT, not the live tree: anything the user edited
            // between snapshotWorkspace above and this line is a local change against
            // this generation, which is exactly what the next merge should see.
            //
            // Read AFTER recordSentFromBundle — that helper rewrites the same file, so
            // mutating a copy read before it would be silently discarded.
            //
            // `manifest.memoryDigest` rides along in the same read/write for the same
            // reason and under the same rule: it is the digest of the `memory/`
            // directory THIS bundle carries, and crediting the hub with it is only
            // truthful once the bundle is on the hub. A push that failed above this
            // line leaves the ledger untouched, so the next push ships the memory
            // again — which is the direction an unknown must fail in (exporter.ts).
            //
            // Note what this does NOT cover: the `manifest.sessions.length === 0`
            // early return above never reaches here, so changed memory with no new
            // session content travels with the next push that has some. That matches
            // the workspace and carry payloads, which the same early return skips.
            if (hasWorkspace || manifest.memoryDigest) {
                const stateWs = readSyncState(opts.projectPath);
                if (hasWorkspace) {
                    setLastWorkspace(stateWs, hub.hubId, { bundleId, file: hubFile, pushedAt });
                }
                if (manifest.memoryDigest) {
                    setPeerMemoryDigest(stateWs, { id: hubPeerId, name: "hub" }, manifest.memoryDigest);
                }
                writeSyncState(stateWs);
            }
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
                        // Three-valued on purpose (see HubBundleRecord): `null` for a full
                        // bundle, the manifest's anchor for a continuation, and `undefined`
                        // — which JSON.stringify drops — for a continuation whose manifest
                        // predates the field. `?? null` here would flatten "unknown" into
                        // "root" and manufacture a second root for the thread.
                        //
                        // Keyed on the same `s.type` test as the record's own `type` two
                        // lines up, so `type: "full"` and `anchorEntryUuid: null` can never
                        // disagree: only a bundle that really is full claims "no anchor
                        // exists". A continuation missing its block is unknown, not a root.
                        anchorEntryUuid: s.type === "continuation" ? s.continuation?.anchorEntryUuid : null,
                        headEntryUuid: readLastEntryUuid(join(bundleStaging, "sessions", `${s.sessionId}.jsonl`)) ?? "",
                        messageCount: s.messageCount, pushedAt, hasWorkspace,
                    },
                });
                pushedSessions.push({ threadId, sessionId: s.sessionId, type: s.type === "continuation" ? "continuation" : "full" });
            }
            // No `summary` here: `buildIndexFile` derives the thread entry's from the
            // slug, and is the only thing that writes it (see index-file.ts).
            const sessionsNow = discoverSessions(opts.configDir, opts.projectPath).map((s) => ({
                sessionId: s.sessionId, slug: s.slug,
                headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
                messageCount: s.messageCount, lastActiveAt: s.lastActiveAt,
            }));
            const prior = await readMachineIndex(backend, local.projectId, machine.id);
            await writeMachineIndex(backend, buildIndexFile({
                projectId: local.projectId, machineId: machine.id, projectPath: opts.projectPath,
                sessions: sessionsNow, state: stateAfter, priorIndex: prior, newBundles: records,
                now: pushedAt,
            }));
            // Discovery aid (design §6.0): name what .gitignore kept out, so the user
            // can opt paths back in via the include list without having to know the file
            // exists. Manual pushes only — the auto-push hook must stay silent — and
            // only until an include list exists, at which point the user has met the
            // mechanism and further nagging is noise. Existence, not pattern count, is
            // the test: a file holding only comments still means "I know about this".
            let ignoredNotCarried;
            if (!opts.quiet && gitScan().kind === "remotes" && !existsSync(includeFilePath(opts.projectPath))) {
                const ignored = listTopLevelIgnored(opts.projectPath);
                if (ignored.length > 0)
                    ignoredNotCarried = ignored;
            }
            return {
                success: true, command: "push", projectId: local.projectId,
                bundleId, pushedSessions, upToDate: false, hasWorkspace, warnings,
                ...(ignoredNotCarried ? { ignoredNotCarried } : {}),
                ...(carryMeta ? { carry: carryMeta } : {}),
            };
        }
        catch (e) {
            bodyThrew = true;
            throw e;
        }
        finally {
            /**
             * The terminal event, and the ONE place it is emitted — see the doc on
             * `hubPush` for the contract and for why a throw out of it is treated as
             * a push failure here while `hubPull` swallows its own.
             *
             * Rethrown only when the body did NOT fail. A caller callback that throws
             * while a real failure is already propagating would otherwise replace it,
             * and `failedAfterLink` would report the consumer's message as the cause
             * of a push that actually died of an `ENOTDIR` at the bundle destination.
             * The push still fails in that case; it fails with its own reason.
             */
            try {
                opts.onProgress?.({ phase: "hub-push", percent: 100 });
            }
            catch (e) {
                if (!bodyThrew)
                    throw e;
            }
        }
    }
    catch (e) {
        // A throw before the identity was resolved leaves nothing behind, so it
        // keeps its existing behavior exactly: rethrow, and cli.ts turns it into an
        // ErrorResult. Past that line there is something to disclose — a link, a
        // minted hub project, a bundle no index references, or simply the fact that
        // none of those happened — and the disclosure is the result, not the
        // exception. It is also what the SessionEnd hook records: it calls
        // `recordAutoPushOutcome` on a RETURNED result, and a throw skips it, so a
        // rethrow here would erase the failure of every unattended push.
        // The hub stopped answering PART WAY THROUGH — it was reachable at the
        // preflight (which is two syscalls earlier) and is not now. Nothing was
        // committed, so it is the same fact `preflightHub` would have reported a
        // moment sooner, and it gets the same typed refusal rather than escaping as
        // an untyped `ErrorResult` (#71). Returning rather than throwing also keeps
        // the unattended path's breadcrumb: `recordAutoPushOutcome` reads a RETURNED
        // result and a throw skips it, so this is the difference between `hub
        // status` explaining a wedged share and saying nothing at all.
        //
        // Past `commits` the disclosure wins instead: which of the link, the hub
        // project and the bundle survived is more urgent than which errno ended it,
        // and `failedAfterLink` carries the message anyway.
        if (e instanceof HubIoTimeoutError && !commits) {
            return hubUnreachableRefusal("push", "unresponsive");
        }
        if (!commits)
            throw e;
        return failedAfterLink(opts.projectPath, commits, e);
    }
    finally {
        if (staging)
            rmSync(staging, { recursive: true, force: true });
        lock.release();
    }
}
//# sourceMappingURL=push.js.map