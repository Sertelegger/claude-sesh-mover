import type { ExportLayer, ExportResult, ErrorResult, SyncStateSessionSent, ProgressEvent } from "./types.js";
export interface IncrementalExportOptions {
    sourceMachineId: string;
    sourceMachineName: string;
    targetMachineId?: string;
    targetMachineName?: string;
    referenceExport?: string;
    lastSyncAt?: string;
    peerSent: Record<string, SyncStateSessionSent>;
    /**
     * The `memoryDigest` this peer is recorded as already holding
     * (`SyncStatePeer.memoryDigest`), or absent/`null` when nothing is known.
     *
     * The whole-file counterpart of `peerSent`: an input, read-only, resolved by
     * the caller from ITS sync state, exactly like `peerSent`. Absent means ship,
     * which is what makes a first push carry memory. See the memory block in
     * `exportSessions` for the rule and the reasoning.
     */
    peerMemoryDigest?: string | null;
}
export interface ExportOptions {
    configDir: string;
    projectPath: string;
    sessionId?: string;
    /** Restrict an all-sessions export to this subset (exportAllSessions only). */
    sessionIds?: string[];
    outputDir: string;
    name: string;
    excludeLayers: ExportLayer[];
    claudeVersion: string;
    collisionCheck?: boolean;
    summaryOverrides?: Record<string, string>;
    incremental?: IncrementalExportOptions;
    noSummary?: boolean;
    onProgress?: (ev: ProgressEvent) => void;
}
export declare function exportSession(options: ExportOptions): Promise<ExportResult | ErrorResult>;
export declare function exportAllSessions(options: Omit<ExportOptions, "sessionId">): Promise<ExportResult | ErrorResult>;
//# sourceMappingURL=exporter.d.ts.map