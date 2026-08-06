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
/**
 * Read one machine's index file.
 *
 * `null` means the file is absent or structurally unusable (missing, not JSON,
 * wrong schemaVersion, no threads map). Everything finer-grained DEGRADES: a
 * record whose ids or `file` path are unsafe is dropped and reported through
 * `warnings`, and the rest of the index survives.
 *
 * That degradation is the point. `file` was never validated at all, so a single
 * poisoned record reached `backend.exists(record.file)` in hub/pull.ts and threw
 * `assertHubRelPath`'s raw internal message straight out of `hubPull` — one bad
 * record killed the pull and took every other bundle in the index with it. And
 * the ids that WERE checked did not degrade either: `assertSafeHubId` threw
 * inside the try, the catch returned null, and the whole index was discarded as
 * "unreadable". Both are the same mistake — the blast radius of a poisoned
 * record must be that record.
 *
 * `warnings` is optional so the existing callers (pull.ts, push.ts, reindex.ts)
 * that only want the index need no change; readAllIndexes passes its own array.
 */
export declare function readMachineIndex(backend: HubBackend, projectId: string, machineId: string, warnings?: string[]): Promise<HubIndexJson | null>;
export declare function writeMachineIndex(backend: HubBackend, index: HubIndexJson): Promise<void>;
export declare function readAllIndexes(backend: HubBackend, projectId: string): Promise<{
    indexes: HubIndexJson[];
    warnings: string[];
}>;
//# sourceMappingURL=index-file.d.ts.map