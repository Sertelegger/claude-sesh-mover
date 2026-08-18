import type { ExportLayer, ExportResult, ExportPayloadPlanResult, ErrorResult, SyncStateSessionSent, ProgressEvent } from "./types.js";
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
    /**
     * Capture the whole-project workspace snapshot beside the sessions
     * (`--include-workspace`), for a project git says has NO remote.
     *
     * **OFF unless the caller says otherwise, and that is the security decision
     * (#47) rather than a default someone picked.** `hub push` builds its payload
     * unless told not to, because linking a project is the hub's consent gate and
     * the bundle lands in a directory the user configured. An export bundle has
     * no such gate — `--output` names any path, and the artifact gets scp'd,
     * emailed or handed to someone — so the destination is unknown at capture
     * time and the user chooses. Positive spelling for the same reason
     * `includePlans` is positive on the import side: a field whose ABSENCE means
     * "on" invites a caller to omit it and ship files nobody asked to ship.
     */
    includeWorkspace?: boolean;
    /** The same, for the git-diff carry (`--include-carry`), for a project WITH a remote. */
    includeCarry?: boolean;
    /**
     * Byte budgets for those two, resolved from `export.workspaceMaxMb` /
     * `export.carryMaxMb` by the caller — same contract as `HubPushOptions.budgets`
     * and for the same reason: this module is handed a decision, not a config
     * directory, and `resolvePayloadBudgets` is the one resolver.
     */
    payloadBudgets?: {
        workspaceMaxBytes: number;
        carryMaxBytes: number;
    };
    onProgress?: (ev: ProgressEvent) => void;
}
/**
 * Measure the file payload and report it, writing NOTHING (#47).
 *
 * The pre-write half of `commands/export.md`'s new confirm gate. It runs the
 * SAME `capturePayload` the real export runs, in `measureOnly` mode, so the
 * numbers a user consents to and the payload that then lands come off one
 * decision — the rule `reconcileSharedLayers`'s plan mode already establishes on
 * the import side, applied here for the same reason.
 *
 * It exports no session and creates no bundle, so there is nothing to clean up
 * if the user declines.
 */
export declare function planExportPayload(options: {
    projectPath: string;
    includeWorkspace?: boolean;
    includeCarry?: boolean;
    payloadBudgets?: {
        workspaceMaxBytes: number;
        carryMaxBytes: number;
    };
}): Promise<ExportPayloadPlanResult>;
export declare function exportSession(options: ExportOptions): Promise<ExportResult | ErrorResult>;
export declare function exportAllSessions(options: Omit<ExportOptions, "sessionId">): Promise<ExportResult | ErrorResult>;
//# sourceMappingURL=exporter.d.ts.map