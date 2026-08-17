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
export declare function normalizeGitRemote(url: string): string | null;
/**
 * What `git remote -v` established about this project, keeping the three
 * answers that used to collapse into one empty array APART.
 *
 * The distinction is load-bearing, not cosmetic. `push` gates the WORKSPACE
 * SNAPSHOT — a copy of the whole project directory that deliberately does not
 * read `.gitignore` — on "this project has no remotes", and the SessionEnd hook
 * runs that push unattended. Reading "I could not ask git" as "there is no
 * remote" therefore uploads a git project's entire working tree, `.env` and
 * `secrets/` included, with nothing said. Only `kind: "none"` may take that
 * path.
 *
 * - `remotes` — git answered and this project HAS at least one remote.
 *   `normalized` holds the ones `normalizeGitRemote` could canonicalize, which
 *   may be FEWER than `rawCount` (a self-hosted `git@gitserver:team/repo.git`
 *   normalizes to null because the host carries no dot) or even empty. Only
 *   `normalized` is used for hub-project matching; `rawCount > 0` is what
 *   decides the payload.
 * - `none` — git answered with no remotes at all, or there is demonstrably no
 *   repository here (no `.git` at this path or any ancestor). Both are
 *   genuinely "no remote to reconstruct this project from".
 * - `unknown` — a repository exists but git could not be asked (missing
 *   binary, timeout, unreadable/dubious-ownership repo). Not an answer.
 */
export type GitRemoteScan = {
    kind: "remotes";
    normalized: string[];
    rawCount: number;
} | {
    kind: "none";
} | {
    kind: "unknown";
    reason: "git-missing" | "git-failed";
    detail: string;
};
export declare function scanGitRemotes(projectPath: string): GitRemoteScan;
/**
 * The project's remotes in matcher form, for hub-project identity only.
 *
 * Deliberately still collapses "no remotes", "remotes I could not normalize"
 * and "could not ask git" into `[]`: an empty matcher list means "do not link
 * by remote", which is the right answer in all three. Anything deciding what
 * LEAVES the machine must use `scanGitRemotes` instead — see its doc.
 */
export declare function localGitRemotes(projectPath: string): string[];
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