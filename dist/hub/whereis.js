import { createFsBackend } from "./backend.js";
import { machinePath } from "./layout.js";
import { resolveProjectIdentity } from "./identity.js";
import { readAllIndexes } from "./index-file.js";
import { resolveThreads } from "./threads.js";
import { loadOrCreateMachineId } from "../machine.js";
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
    const names = new Map();
    // A ThreadCopy's machineId is copied verbatim from an index file's own
    // (unvalidated-by-readMachineIndex) `machineId` field — see
    // readMachineIndex in index-file.ts and resolveThreads in threads.ts. A
    // hostile index file can declare an internal machineId that is unsafe as
    // a path component (e.g. "../evil"); machinePath(id) asserts and throws
    // on exactly that. The throw is synchronous and happens while evaluating
    // the argument to backend.read(...) — i.e. still inside this function's
    // try block's dynamic extent — so it is caught here and degrades to
    // machineName: null instead of escaping and wedging the whole command.
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
    const me = loadOrCreateMachineId();
    const threads = [];
    for (const t of resolved) {
        const localEntry = t.copies.find((c) => c.machineId === me.id) ?? null;
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
            pullNeeded: t.latest.machineId !== me.id && !current,
        });
    }
    return { success: true, command: "whereis", linked: true, projectId, threads, warnings };
}
//# sourceMappingURL=whereis.js.map