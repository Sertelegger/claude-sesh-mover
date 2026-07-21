import { createFsBackend } from "./backend.js";
import { machinePath } from "./layout.js";
import { resolveProjectIdentity } from "./identity.js";
import { readAllIndexes } from "./index-file.js";
import { resolveThreads } from "./threads.js";
import { loadOrCreateMachineId } from "../machine.js";
// Shared thread-shaping used by both whereis and pull's list mode (pull needs
// the identical WhereisThread[] shape when it returns a HubPullListResult).
//
// SECURITY (Task 6 review, binding): the machineId field INSIDE a parsed
// index file is never validated by readMachineIndex — only ids used in ITS
// OWN path building (derived from the filename) are. A hostile index file
// can therefore declare an internal machineId that is unsafe as a path
// component (e.g. "../evil"). resolveThreads copies that internal field
// verbatim into ThreadCopy.machineId, so the machineName() helper below —
// which calls machinePath(id) to read machines/<id>.json — must be the one
// to contain the resulting throw (machinePath asserts and throws on unsafe
// ids), not let it escape and wedge the whole command.
export async function shapeThreads(backend, resolved, meId) {
    const names = new Map();
    const machineName = async (id) => {
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
    const threads = [];
    for (const t of resolved) {
        const localEntry = t.copies.find((c) => c.machineId === meId) ?? null;
        const current = localEntry !== null && localEntry.headEntryUuid === t.latest.headEntryUuid;
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
            pullNeeded: t.latest.machineId !== meId && !current,
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
    const threads = await shapeThreads(backend, resolved, me.id);
    return { success: true, command: "whereis", linked: true, projectId, threads, warnings };
}
//# sourceMappingURL=whereis.js.map