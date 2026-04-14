import type { MigrateResult, ErrorResult, ExportLayer, SessionScope } from "./types.js";
export interface MigrateOptions {
    sourceConfigDir: string;
    targetConfigDir: string;
    sourceProjectPath: string;
    targetProjectPath: string;
    scope: SessionScope;
    sessionId?: string;
    excludeLayers: ExportLayer[];
    claudeVersion: string;
    dryRun?: boolean;
    renameDir?: boolean;
    /** When set, a warning is emitted if this path is inside `sourceProjectPath`
     *  (self-migration: the caller is running inside the directory being moved). */
    currentCwd?: string;
}
export declare function migrateSession(options: MigrateOptions): Promise<MigrateResult | ErrorResult>;
//# sourceMappingURL=migrator.d.ts.map