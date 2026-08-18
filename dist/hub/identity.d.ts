import type { HubBackend } from "./backend.js";
import { type HubProjectJson } from "./layout.js";
export interface LocalProjectId {
    projectId: string;
    name: string;
    createdAt: string;
    createdByMachine: string;
}
export declare function localProjectIdPath(projectPath: string): string;
export declare function readLocalProjectId(projectPath: string): LocalProjectId | null;
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
export declare function removeLocalProjectIdIfMatches(projectPath: string, projectId: string): {
    removed: boolean;
    detail: string;
};
export declare function writeLocalProjectId(projectPath: string, id: LocalProjectId): void;
export declare function listHubProjects(backend: HubBackend): Promise<HubProjectJson[]>;
export type IdentityResolution = {
    kind: "linked";
    local: LocalProjectId;
} | {
    kind: "match";
    hubProject: HubProjectJson;
    matchedRemote: string;
} | {
    kind: "unlinked";
    candidates: Array<{
        projectId: string;
        name: string;
        gitRemotes: string[];
    }>;
};
export declare function resolveProjectIdentity(backend: HubBackend, projectPath: string): Promise<IdentityResolution>;
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
export declare function mintHubProject(backend: HubBackend, projectPath: string, machineId: string): Promise<LocalProjectId>;
export declare function createHubProject(backend: HubBackend, projectPath: string, machineId: string): Promise<LocalProjectId>;
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
export declare function readHubProjectAsLocal(backend: HubBackend, projectId: string): Promise<LocalProjectId>;
export declare function linkToHubProject(backend: HubBackend, projectPath: string, projectId: string): Promise<LocalProjectId>;
//# sourceMappingURL=identity.d.ts.map