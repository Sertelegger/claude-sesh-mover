import type { ImportResult, DryRunResult, ErrorResult, ProgressEvent } from "./types.js";
export interface ImportOptions {
    exportPath: string;
    targetConfigDir: string;
    targetProjectPath: string;
    targetClaudeVersion: string;
    dryRun: boolean;
    sessionIds?: string[];
    noRegister?: boolean;
    allowDuplicates?: boolean;
    onProgress?: (ev: ProgressEvent) => void;
}
export declare function importSession(options: ImportOptions): Promise<ImportResult | DryRunResult | ErrorResult>;
//# sourceMappingURL=importer.d.ts.map