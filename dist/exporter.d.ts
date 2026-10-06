import type { ExportLayer, ExportResult, ExportPayloadPlanResult, ErrorResult, DiscoveredSession, SyncStateSessionSent, ProgressEvent } from "./types.js";
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
    /**
     * The sessions to choose from, already discovered by the caller — taken in
     * place of this export's own `discoverSessions(configDir, projectPath)`, and
     * then narrowed by `sessionId`/`sessionIds` exactly as a discovered list is.
     *
     * `migrate` passes it, because it has to know which FOLDER each session came
     * from on both sides of the export: before it, to leave out the sessions
     * already in the folder the import will write (#126's remedy — re-importing
     * one there only changes its id), and after the import, to delete each moved
     * session from the folder it was found in. Discovery reads two folders for
     * one path, so that folder is not derivable from the path, and one discovery
     * handed through is the only way all three steps see the same sessions.
     */
    discovered?: DiscoveredSession[];
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
    /**
     * Who reads this export's per-session warnings (#124, #140), which decides
     * their SHAPE — never whether they are made. Two of them are per session:
     * the walk-past disclosure, and the incremental planner's reason for sending
     * a session whole instead of as a delta.
     *
     * `"export"` (the default, and what `export` and `migrate` get): one warning
     * per uncarried entry per session, worded for a bundle the user is holding
     * and for `migrate`'s cleanup, which leaves the entry in place; and one per
     * session the planner sends whole.
     *
     * `"hub"` (`hub push`): ONE warning for each of the two, however many
     * sessions and entries — the walk-past one naming each entry and how many
     * sessions hold it, the planner's naming each session — appended after every
     * other warning this export produces. The SessionEnd auto-push has no channel
     * but `hub status`'s `lastAutoPush`, which keeps only its first
     * `MAX_AUTO_PUSH_NOTES` notes, so what an export contributes there has to be
     * BOUNDED: a sentence per session is unbounded, and five of them were enough
     * to cut the unsigned-push warning out of that breadcrumb. (Push also
     * forwards them after its own warnings; the two rules together are what
     * keep a push's own disclosures in.) The per-bundle wording also drops what
     * does not fit a push — there is no `migrate` here, and no bundle in the
     * user's hands to copy from.
     */
    warningsFor?: "export" | "hub";
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