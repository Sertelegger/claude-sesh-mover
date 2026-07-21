export declare const DEFAULT_WORKSPACE_EXCLUDES: string[];
export declare class WorkspaceTargetNotEmptyError extends Error {
    readonly targetPath: string;
    constructor(targetPath: string);
}
export declare function readHubignore(projectPath: string): string[];
export declare function isExcluded(name: string, patterns: string[]): boolean;
export declare function snapshotWorkspace(projectPath: string, destDir: string): Promise<{
    fileCount: number;
    byteSize: number;
    symlinksSkipped: number;
}>;
export declare function unpackWorkspace(srcDir: string, targetPath: string, opts: {
    force: boolean;
}): Promise<{
    fileCount: number;
}>;
//# sourceMappingURL=workspace.d.ts.map