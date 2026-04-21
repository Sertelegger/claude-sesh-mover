import type { ExportLayer, ExportResult, ErrorResult, SyncStateSessionSent } from "./types.js";
export interface IncrementalExportOptions {
    sourceMachineId: string;
    sourceMachineName: string;
    targetMachineId?: string;
    targetMachineName?: string;
    referenceExport?: string;
    lastSyncAt?: string;
    peerSent: Record<string, SyncStateSessionSent>;
}
export interface ExportOptions {
    configDir: string;
    projectPath: string;
    sessionId?: string;
    outputDir: string;
    name: string;
    excludeLayers: ExportLayer[];
    claudeVersion: string;
    collisionCheck?: boolean;
    summaryOverrides?: Record<string, string>;
    incremental?: IncrementalExportOptions;
}
export declare function exportSession(options: ExportOptions): Promise<ExportResult | ErrorResult>;
export declare function exportAllSessions(options: Omit<ExportOptions, "sessionId">): Promise<ExportResult | ErrorResult>;
//# sourceMappingURL=exporter.d.ts.map