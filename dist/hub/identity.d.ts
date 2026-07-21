export interface LocalProjectId {
    projectId: string;
    name: string;
    createdAt: string;
    createdByMachine: string;
}
export declare function localProjectIdPath(projectPath: string): string;
export declare function readLocalProjectId(projectPath: string): LocalProjectId | null;
//# sourceMappingURL=identity.d.ts.map