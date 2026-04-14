import type { ImportResult, DryRunResult, ErrorResult } from "./types.js";
export interface ImportOptions {
    exportPath: string;
    targetConfigDir: string;
    targetProjectPath: string;
    targetClaudeVersion: string;
    dryRun: boolean;
    sessionIds?: string[];
    noRegister?: boolean;
}
export declare function importSession(options: ImportOptions): Promise<ImportResult | DryRunResult | ErrorResult>;
//# sourceMappingURL=importer.d.ts.map