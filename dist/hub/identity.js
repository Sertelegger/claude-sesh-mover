import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { projectJsonPath, assertSafeHubId } from "./layout.js";
import { localGitRemotes } from "../payload/git-scan.js";
import { projectJsonFilePath } from "../paths.js";
export function localProjectIdPath(projectPath) {
    return projectJsonFilePath(projectPath);
}
export function readLocalProjectId(projectPath) {
    const p = localProjectIdPath(projectPath);
    if (!existsSync(p))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(p, "utf-8"));
        if (!parsed.projectId)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * Remove this directory's hub link, but ONLY while it still names `projectId`.
 *
 * The re-read is the whole point: a link the user (or a concurrent operation)
 * changed underneath us is not ours to remove, so the check and the unlink are
 * as close together as they can be made. Two callers, one rule — `hub/push.ts`
 * rolling back a link its own failed push wrote, and `hub/delete`'s cleanup
 * after the hub project it pointed at has been destroyed. A second hand-written
 * copy of this is how one of them ends up unlinking a directory it did not link.
 *
 * It removes the FILE and nothing else — never an `rmdir` of the parent, which
 * since 0.8.0 is the user's project root (see `rollbackLocalLink`).
 *
 * `removed: true` with an empty `detail` also covers "there was no link", which
 * is the requested state either way.
 */
export function removeLocalProjectIdIfMatches(projectPath, projectId) {
    try {
        const still = readLocalProjectId(projectPath);
        if (!still)
            return { removed: true, detail: "" };
        if (still.projectId !== projectId) {
            return { removed: false, detail: "it now names a different hub project" };
        }
        rmSync(localProjectIdPath(projectPath), { force: true });
        return { removed: true, detail: "" };
    }
    catch (e) {
        return { removed: false, detail: e.message };
    }
}
export function writeLocalProjectId(projectPath, id) {
    const p = localProjectIdPath(projectPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(id, null, 2) + "\n", "utf-8");
}
export async function listHubProjects(backend) {
    const files = await backend.list("projects");
    const projects = [];
    for (const f of files) {
        if (!/^projects\/[^/]+\/project\.json$/.test(f))
            continue;
        try {
            const parsed = JSON.parse((await backend.read(f)).toString());
            assertSafeHubId(parsed.projectId, "projectId");
            // Shape check: a valid-JSON record with missing/malformed matchers would
            // otherwise crash consumers (resolveProjectIdentity's candidate map) —
            // one bad hub file must not break identity resolution for everyone.
            if (!Array.isArray(parsed.matchers?.gitRemotes))
                throw new Error("malformed matchers");
            projects.push(parsed);
        }
        catch {
            // unparseable/unsafe/malformed project.json (possibly mid-sync) — skip, never throw
        }
    }
    return projects;
}
export async function resolveProjectIdentity(backend, projectPath) {
    const local = readLocalProjectId(projectPath);
    if (local)
        return { kind: "linked", local };
    const remotes = localGitRemotes(projectPath);
    const hubProjects = await listHubProjects(backend);
    if (remotes.length > 0) {
        for (const hp of hubProjects) {
            const hit = hp.matchers.gitRemotes.find((r) => remotes.includes(r));
            if (hit)
                return { kind: "match", hubProject: hp, matchedRemote: hit };
        }
    }
    return {
        kind: "unlinked",
        candidates: hubProjects.map((p) => ({
            projectId: p.projectId, name: p.name, gitRemotes: p.matchers.gitRemotes,
        })),
    };
}
/**
 * The HUB-side half of `createHubProject`: mint an id and write
 * `projects/<id>/project.json`. Writes NOTHING under the project directory.
 *
 * Split out because the two halves have different failure semantics and a
 * caller may need them at different moments. The hub write cannot be undone —
 * there is no `backend.delete` call anywhere in src/ — while the local link
 * can, so `hub/push.ts` records "a hub project was minted" the instant this
 * resolves and defers the local link until the bundle is on the hub. Fusing
 * them, as this function's caller below does, means a throw BETWEEN the two
 * writes leaves an orphan hub project no result mentions.
 */
export async function mintHubProject(backend, projectPath, machineId) {
    const local = {
        projectId: randomUUID(),
        name: basename(projectPath),
        createdAt: new Date().toISOString(),
        createdByMachine: machineId,
    };
    const hub = {
        schemaVersion: 1,
        projectId: local.projectId,
        name: local.name,
        matchers: { gitRemotes: localGitRemotes(projectPath) },
        createdAt: local.createdAt,
        createdByMachine: machineId,
    };
    await backend.writeAtomic(projectJsonPath(local.projectId), JSON.stringify(hub, null, 2) + "\n");
    return local;
}
export async function createHubProject(backend, projectPath, machineId) {
    const local = await mintHubProject(backend, projectPath, machineId);
    writeLocalProjectId(projectPath, local);
    return local;
}
/**
 * Read a hub project as the `LocalProjectId` a link to it would carry, WITHOUT
 * writing that link.
 *
 * The read is not a formality: it is the existence gate that keeps a typo'd
 * `--project-id` from linking a directory to a hub project that does not
 * exist, and `assertSafeHubId` is the path-safety chokepoint. Callers that
 * want the gate at one moment and the link at another (see `hub/push.ts`) take
 * this and `writeLocalProjectId` separately; everyone else takes
 * `linkToHubProject`, which is exactly the two in sequence.
 */
export async function readHubProjectAsLocal(backend, projectId) {
    assertSafeHubId(projectId, "projectId");
    const hub = JSON.parse((await backend.read(projectJsonPath(projectId))).toString());
    return {
        projectId: hub.projectId,
        name: hub.name,
        createdAt: hub.createdAt,
        createdByMachine: hub.createdByMachine,
    };
}
export async function linkToHubProject(backend, projectPath, projectId) {
    const local = await readHubProjectAsLocal(backend, projectId);
    writeLocalProjectId(projectPath, local);
    return local;
}
//# sourceMappingURL=identity.js.map