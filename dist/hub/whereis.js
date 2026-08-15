import { join } from "node:path";
import { createFsBackend } from "./backend.js";
import { machinePath } from "./layout.js";
import { resolveProjectIdentity } from "./identity.js";
import { readAllIndexes } from "./index-file.js";
// #44: `pullNeeded` is the same question `pull` asks, so it goes through the
// same function. The import direction makes this module and pull-select
// mutually referential (pull-select takes `shapeThreads` and
// `createMachineNameLookup` from here), which is safe and deliberate rather
// than accidental: both sides are hoisted `export function` declarations and
// neither module calls the other while its own body is evaluating, so the ESM
// cycle resolves before either is invoked. The alternative was a fourth copy
// of a selection rule that has already disagreed with itself once.
import { pullSourceFor } from "./threads.js";
import { resolveThreads, findUnfetchableBundles } from "./threads.js";
import { loadOrCreateMachineId } from "../machine.js";
import { encodeProjectPath } from "../platform.js";
import { peekSyncState } from "../sync-state.js";
/**
 * Memoized `machines/<id>.json` name lookup, `null` for anything unreadable.
 *
 * SECURITY (Task 6 review, binding): the machineId field INSIDE a parsed index
 * file is never validated by readMachineIndex — only ids used in ITS OWN path
 * building (derived from the filename) are. A hostile index file can therefore
 * declare an internal machineId that is unsafe as a path component (e.g.
 * "../evil"). resolveThreads copies that internal field verbatim into
 * ThreadCopy.machineId, so this helper — which calls machinePath(id) — must be
 * the one to contain the resulting throw (machinePath asserts and throws on
 * unsafe ids), not let it escape and wedge the whole command. Every caller
 * that turns a hub-supplied machine id into a display name goes through here.
 */
export function createMachineNameLookup(backend) {
    const names = new Map();
    return async (id) => {
        if (!names.has(id)) {
            try {
                const raw = await backend.read(machinePath(id));
                names.set(id, JSON.parse(raw.toString()).name);
            }
            catch {
                names.set(id, null);
            }
        }
        return names.get(id);
    };
}
// Shared thread-shaping used by both whereis and pull's list mode (pull needs
// the identical WhereisThread[] shape when it returns a HubPullListResult).
//
// `state` is this machine's peer bookkeeping for the project, and it is what
// keeps `unfetchableBundles` from crying wolf: without it every thread whose
// history this machine already holds in full would still look split. Read it
// with peekSyncState — whereis must not write.
//
// `targetProjectDir` (`<configDir>/projects/<encoded project path>`) is the
// second half of that bookkeeping and arrived with #44: `pullSourceFor` trusts
// a receipt only while the local session file it names still exists, so
// answering "would a pull fetch anything" needs to know where a local session
// file WOULD be. It is only ever probed for existence; nothing is read or
// written there.
export async function shapeThreads(backend, resolved, meId, state, targetProjectDir) {
    const machineName = createMachineNameLookup(backend);
    const threads = [];
    for (const t of resolved) {
        const localEntry = t.copies.find((c) => c.machineId === meId) ?? null;
        // HEAD EQUALITY, AND ONLY AS A DISPLAY FIELD. It says "the newest head the
        // hub knows of is the one my local file ends at" — a true and useful thing
        // to show, and NOT the question of whether a pull would fetch something
        // (#44). It fed `pullNeeded` until this fix, which is how `whereis` came to
        // report `pullNeeded: false` for a thread `pull --thread <id>` fetched.
        const current = localEntry !== null && localEntry.headEntryUuid === t.latest.headEntryUuid;
        // Asked of the copy a pull would actually resolve to (`latest`), so this
        // answers the same question `pull` answers, before the user runs it.
        const unfetchable = findUnfetchableBundles({
            copies: t.copies,
            sourceMachineId: t.latest.machineId,
            localMachineId: meId,
            state,
        });
        threads.push({
            threadId: t.threadId,
            slug: t.slug,
            summary: t.summary,
            latest: {
                machineId: t.latest.machineId,
                machineName: await machineName(t.latest.machineId),
                lastActiveAt: t.latest.lastActiveAt,
                messageCount: t.latest.messageCount,
            },
            copies: await Promise.all(t.copies.map(async (c) => ({
                machineId: c.machineId,
                machineName: await machineName(c.machineId),
                localSessionId: c.localSessionId,
                lastActiveAt: c.lastActiveAt,
                messageCount: c.messageCount,
                headEntryUuid: c.headEntryUuid,
            }))),
            localCopy: localEntry
                ? { localSessionId: localEntry.localSessionId, headEntryUuid: localEntry.headEntryUuid, current }
                : null,
            // The pull's own selector, not a restatement of it: this is the field the
            // SessionStart notice filters on and the field the skill layer turns into
            // "run /sesh-mover:pull", so it has to be true exactly when a pull of
            // this thread would fetch a bundle. `pullSourceFor` covers the case where
            // the newest copy is ours too (a peer can still list something we never
            // received), so no `machineId` test is needed alongside it.
            pullNeeded: pullSourceFor(t, state, { machineId: meId, targetProjectDir }) !== undefined,
            unfetchableBundles: unfetchable.length > 0
                ? await Promise.all(unfetchable.map(async (u) => ({
                    machineId: u.machineId,
                    machineName: await machineName(u.machineId),
                    bundleIds: u.bundleIds,
                })))
                : undefined,
        });
    }
    return threads;
}
// Read-only cross-machine thread view. Never mints a hub project and never
// links this project directory to one — linking happens on push/pull, not
// on a read. An unresolved identity (no local link, or only a git-remote
// "match") reports linked:false with candidates instead of guessing.
export async function hubWhereis(opts) {
    const backend = createFsBackend(opts.hubPath);
    const warnings = [];
    const resolution = await resolveProjectIdentity(backend, opts.projectPath);
    if (resolution.kind !== "linked") {
        const candidates = resolution.kind === "match"
            ? [
                {
                    projectId: resolution.hubProject.projectId,
                    name: resolution.hubProject.name,
                    gitRemotes: resolution.hubProject.matchers.gitRemotes,
                },
            ]
            : resolution.candidates;
        if (resolution.kind === "match") {
            warnings.push(`This project's git remote matches hub project "${resolution.hubProject.name}" — run push or pull to link it.`);
        }
        return {
            success: true,
            command: "whereis",
            linked: false,
            projectId: null,
            linkCandidates: candidates,
            threads: [],
            warnings,
        };
    }
    const projectId = resolution.local.projectId;
    const { indexes, warnings: indexWarnings } = await readAllIndexes(backend, projectId);
    warnings.push(...indexWarnings);
    const resolved = resolveThreads(indexes);
    const me = loadOrCreateMachineId();
    // The same path `hubPull` builds for the project it is about (pull.ts's
    // `targetProjectDir`), so `pullNeeded` and the pull agree about which local
    // session files exist. `configDir` was already on this options object and
    // unused; this is what it is for.
    const targetProjectDir = join(opts.configDir, "projects", encodeProjectPath(opts.projectPath));
    const threads = await shapeThreads(backend, resolved, me.id, peekSyncState(opts.projectPath), targetProjectDir);
    return { success: true, command: "whereis", linked: true, projectId, threads, warnings };
}
//# sourceMappingURL=whereis.js.map