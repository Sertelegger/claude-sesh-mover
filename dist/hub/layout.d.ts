export interface HubJson {
    schemaVersion: 1;
    hubId: string;
    createdAt: string;
}
export interface HubMachineJson {
    id: string;
    name: string;
    platform: string;
    lastSeenAt: string;
}
export interface HubProjectJson {
    schemaVersion: 1;
    projectId: string;
    name: string;
    matchers: {
        gitRemotes: string[];
    };
    createdAt: string;
    createdByMachine: string;
}
export interface HubBundleRecord {
    bundleId: string;
    file: string;
    type: "full" | "continuation";
    sessionIdInBundle: string;
    fromEntryUuid: string | null;
    headEntryUuid: string;
    messageCount: number;
    pushedAt: string;
    hasWorkspace: boolean;
}
export interface HubThreadEntry {
    localSessionId: string;
    slug: string;
    summary: string;
    headEntryUuid: string;
    messageCount: number;
    lastActiveAt: string;
    bundles: HubBundleRecord[];
}
export interface HubIndexJson {
    schemaVersion: 1;
    agent: "claude-code";
    projectId: string;
    machineId: string;
    updatedAt: string;
    projectPath: string;
    threads: Record<string, HubThreadEntry>;
}
export declare function assertSafeHubId(id: unknown, what: string): asserts id is string;
export declare function assertHubRelPath(relPath: string): void;
export declare const HUB_JSON = "hub.json";
export declare function machinePath(machineId: string): string;
export declare function projectDir(projectId: string): string;
export declare function projectJsonPath(projectId: string): string;
export declare function indexDirPath(projectId: string): string;
export declare function indexPath(projectId: string, machineId: string): string;
export declare function bundleDir(projectId: string, machineId: string): string;
export declare function bundleFileName(pushedAtIso: string, bundleId: string): string;
//# sourceMappingURL=layout.d.ts.map