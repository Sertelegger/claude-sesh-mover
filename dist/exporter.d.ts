import type { ExportLayer, ExportResult, ErrorResult } from "./types.js";
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
}
export declare function exportSession(options: ExportOptions): Promise<ExportResult | ErrorResult>;
export declare function exportAllSessions(options: Omit<ExportOptions, "sessionId">): Promise<ExportResult | ErrorResult>;
//# sourceMappingURL=exporter.d.ts.map