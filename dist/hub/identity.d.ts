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
export declare function writeLocalProjectId(projectPath: string, id: LocalProjectId): void;
export declare function normalizeGitRemote(url: string): string | null;
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
export declare function createHubProject(backend: HubBackend, projectPath: string, machineId: string): Promise<LocalProjectId>;
export declare function linkToHubProject(backend: HubBackend, projectPath: string, projectId: string): Promise<LocalProjectId>;
//# sourceMappingURL=identity.d.ts.map