import type { HubBackend } from "./backend.js";
import { type HubBundleRecord, type HubIndexJson } from "./layout.js";
import type { SyncState } from "../types.js";
export interface IndexBuildInputs {
    projectId: string;
    machineId: string;
    projectPath: string;
    sessions: Array<{
        sessionId: string;
        slug: string;
        summary: string;
        headEntryUuid: string;
        messageCount: number;
        lastActiveAt: string;
    }>;
    state: SyncState;
    priorIndex: HubIndexJson | null;
    newBundles: Array<{
        threadId: string;
        record: HubBundleRecord;
    }>;
    now: string;
}
export declare function buildIndexFile(inputs: IndexBuildInputs): HubIndexJson;
export declare function readMachineIndex(backend: HubBackend, projectId: string, machineId: string): Promise<HubIndexJson | null>;
export declare function writeMachineIndex(backend: HubBackend, index: HubIndexJson): Promise<void>;
export declare function readAllIndexes(backend: HubBackend, projectId: string): Promise<{
    indexes: HubIndexJson[];
    warnings: string[];
}>;
//# sourceMappingURL=index-file.d.ts.map