import type { DiscoveredSession } from "./types.js";
export declare function discoverSessions(configDir: string, projectPath: string): DiscoveredSession[];
export declare function discoverSessionById(configDir: string, sessionId: string): DiscoveredSession | null;
export declare function listAllProjects(configDir: string): Array<{
    projectPath: string;
    encodedDir: string;
    sessionCount: number;
}>;
//# sourceMappingURL=discovery.d.ts.map