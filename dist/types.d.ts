import type { WorkspaceMergeReport } from "./hub/merge.js";
import type { ApplyResult, CarryMeta } from "./hub/carry.js";
export type Platform = "darwin" | "linux" | "wsl1" | "wsl2" | "win32";
export type JsonlEntryType = "user" | "assistant" | "file-history-snapshot" | "system" | "progress";
export interface JsonlEntryBase {
    uuid: string;
    timestamp: string;
    sessionId: string;
    cwd: string;
    version: string;
    gitBranch?: string;
    slug?: string;
    userType?: string;
    entrypoint?: string;
    parentUuid?: string;
    isSidechain?: boolean;
    agentId?: string;
}
export interface UserMessageContent {
    role: "user";
    content: string | Array<Record<string, unknown>>;
}
export interface UserMessageEntry extends JsonlEntryBase {
    type: "user";
    message: UserMessageContent;
    promptId?: string;
    permissionMode?: string;
    toolUseResult?: {
        stdout?: string;
        stderr?: string;
        interrupted?: boolean;
        isImage?: boolean;
    };
    sourceToolAssistantUUID?: string;
}
export interface AssistantMessageEntry extends JsonlEntryBase {
    type: "assistant";
    message: {
        model: string;
        id: string;
        content: Array<Record<string, unknown>>;
        usage?: Record<string, unknown>;
    };
    requestId?: string;
}
export interface FileHistorySnapshotEntry extends JsonlEntryBase {
    type: "file-history-snapshot";
    messageId: string;
    snapshot: {
        messageId: string;
        trackedFileBackups: Record<string, {
            backupFileName: string;
            version: number;
            backupTime: string;
        }>;
        timestamp: string;
    };
    isSnapshotUpdate?: boolean;
}
export interface SystemEntry extends JsonlEntryBase {
    type: "system";
    subtype?: string;
    durationMs?: number;
    messageCount?: number;
    isMeta?: boolean;
}
export interface ProgressEntry extends JsonlEntryBase {
    type: "progress";
    data: Record<string, unknown>;
    parentToolUseID?: string;
}
export type JsonlEntry = UserMessageEntry | AssistantMessageEntry | FileHistorySnapshotEntry | SystemEntry | ProgressEntry;
export type ExportLayer = "jsonl" | "subagents" | "file-history" | "tool-results" | "memory" | "plans";
export type SessionScope = "current" | "all";
export type StorageScope = "user" | "project";
export type ExportFormat = "dir" | "archive" | "zstd";
export interface SessionContinuation {
    continuesLocalSessionId: string;
    continuesPeerSessionId?: string;
    fromEntryIndex: number;
    fromEntryUuid: string;
}
export interface SessionLineage {
    sourceMachineId: string;
    sourceSessionId: string;
}
export interface SessionManifest {
    sessionId: string;
    slug: string;
    summary: string;
    createdAt: string;
    lastActiveAt: string;
    messageCount: number;
    gitBranch: string;
    entrypoint: string;
    integrityHash: string;
    type?: "full" | "continuation";
    lineage?: SessionLineage;
    continuation?: SessionContinuation;
    /**
     * One aggregate digest per auxiliary layer directory this session carries —
     * `subagents`, `tool-results`, `file-history`. Until 0.6.0 only the session
     * JSONL was hashed, so a corrupted `file-history` backup rode through
     * silently and was later restored over the user's own file.
     *
     * A key is present only when the bundle actually contains that directory, and
     * the whole field is absent on bundles written before it existed — see
     * `computeLayerDigest` for the format and for why this is one digest per
     * layer rather than one per file.
     */
    layerDigests?: Partial<Record<"subagents" | "tool-results" | "file-history", string>>;
}
export interface ExportBaseline {
    targetMachineId: string;
    targetMachineName?: string;
    lastSyncAt?: string;
    referenceExport?: string;
}
export interface ExportManifest {
    version: number;
    plugin: "sesh-mover";
    exportedAt: string;
    sourcePlatform: Platform;
    sourceProjectPath: string;
    sourceConfigDir: string;
    sourceClaudeVersion: string;
    sessionScope: SessionScope;
    includedLayers: ExportLayer[];
    sessions: SessionManifest[];
    /**
     * Digest over the session inventory above — see `computeSessionsDigest` for
     * what it covers, what it deliberately does not, and why it is damage
     * detection rather than attestation. Optional: pre-0.6.0 bundles carry none
     * and are verified as they always were.
     */
    sessionsDigest?: string;
    sourceMachineId?: string;
    sourceMachineName?: string;
    incremental?: boolean;
    baseline?: ExportBaseline;
    projectId?: string;
    workspace?: {
        fileCount: number;
        byteSize: number;
        snapshotAt: string;
        /**
         * The workspace generation the pushing machine's tree descended from when
         * this snapshot was taken — i.e. its own `hub.lastWorkspace` at that
         * moment. `null` when it had none (this was its first workspace push).
         *
         * **Only `bundleId` is ever acted on.** A puller looks that id up in its own
         * `hub.workspaceGenerations`; a hit proves the generation is common to both
         * trees and makes it a legal merge base, and the puller then uses ITS OWN
         * record of that generation. `file` and `pushedAt` are diagnostics: the
         * first never becomes a path on the puller (a forged one therefore cannot
         * reach the filesystem at all), and the second is the pusher's wall clock,
         * so it is not comparable with anything of ours.
         *
         * Without this field a puller can only assume its own generation is common,
         * which silently reverts its newer work to the pusher's older copy whenever
         * the two machines pushed without pulling in between — something auto-push
         * makes routine. Optional because bundles written before this field existed
         * do not carry it; those declare no common generation, so the payload
         * degrades to no-ancestor mode (§5.4) rather than being merged against a
         * guess.
         */
        basedOn?: {
            bundleId: string;
            file: string;
            pushedAt?: string;
        } | null;
    };
    /**
     * Uncommitted work captured beside the sessions (design §6.1), for a project
     * with a git remote. Absent when the tree was clean, when the payload was
     * over budget, or when carry was off — and absent on every bundle written
     * before this field existed, which is why the apply side must treat it as
     * optional rather than as a promise the `carry/` directory is well-formed.
     */
    carry?: CarryMeta;
}
export interface SeshMoverConfig {
    export: {
        storage: StorageScope;
        format: ExportFormat;
        exclude: ExportLayer[];
        scope: SessionScope;
        noSummary: boolean;
    };
    import: {
        dryRunFirst: boolean;
    };
    migrate: {
        scope: SessionScope;
    };
    hub: {
        path: string;
        noWorkspace: boolean;
        autoPush: boolean;
        startupNotice: boolean;
        pullAppend: boolean;
        onDivergence: OnDivergenceMode;
        carryDiff: boolean;
        carryMaxMb: number;
        workspaceMaxMb: number;
    };
}
/**
 * How `pull` resolves a thread that diverged (local and hub both extended the
 * same anchor, so the chain guard refuses to splice):
 * - `fragment` (default): keep both, import the hub's branch as its own
 *   session. Nothing local is touched — the Slice-1 behavior.
 * - `adopt-hub`: make the hub's branch canonical in the local session and
 *   preserve the local branch as a second, complete session.
 * - `skip`: change nothing at all and leave the bundle unrecorded, so the same
 *   pull can be re-run with a different decision.
 */
export type OnDivergenceMode = "fragment" | "adopt-hub" | "skip";
export interface ExportResult {
    success: true;
    command: "export";
    exportPath: string;
    sessions: Array<{
        originalId: string;
        slug: string;
        summary: string;
        messageCount: number;
        exportedLayers: ExportLayer[];
    }>;
    warnings: string[];
    archivePath: string | null;
    actualFormat?: ExportFormat;
    collision: boolean;
    existingPath?: string;
}
export interface ImportResult {
    success: true;
    command: "import";
    dryRun?: false;
    importedSessions: Array<{
        originalId: string;
        newId: string;
        slug: string;
        messageCount: number;
    }>;
    skippedSessions: Array<{
        originalId: string;
        reason: "duplicate" | "already-received";
    }>;
    warnings: string[];
    resumable: boolean;
    versionAdaptations?: string[];
    memoryConflicts?: Array<{
        filename: string;
        existingHash: string;
        incomingHash: string;
    }>;
}
export interface DryRunResult {
    success: true;
    command: "import";
    dryRun: true;
    importedSessions: ImportResult["importedSessions"];
    skippedSessions: ImportResult["skippedSessions"];
    warnings: string[];
    resumable: boolean;
    rewriteReport?: RewriteReport;
    versionAdaptations?: string[];
}
export interface MigrateResult {
    success: true;
    command: "migrate";
    /**
     * Present and `true` only for `--dry-run`. It is the tense marker for the
     * whole object: on a preview, `cleanedUp` and `directoryRenamed` describe
     * what the real run WOULD do, not what happened (nothing happened).
     *
     * Without it those two booleans are ambiguous between prediction and fact,
     * which is exactly how the preview came to under-report the `--rename-dir`
     * `mv` — it reported the plan's most destructive step as `false` because
     * `false` was true-as-a-fact. Absent on a real run.
     */
    dryRun?: true;
    importedSessions: ImportResult["importedSessions"];
    skippedSessions: Array<{
        originalId: string;
        reason: "duplicate" | "already-received";
    }>;
    /**
     * Real run: source session files were deleted. Dry run: they would be — for
     * every id in `importedSessions[].originalId` and `skippedSessions[]`.
     */
    cleanedUp: boolean;
    /**
     * Real run: the project directory was `mv`-ed from `sourcePath` to
     * `targetPath`. Dry run: it would be. False whenever `--rename-dir` was not
     * passed, the paths are identical, the source is missing, or the target
     * already exists — the last three each carry an explaining `warnings` entry.
     */
    directoryRenamed: boolean;
    sourcePath: string;
    targetPath: string;
    warnings: string[];
}
export interface BrowseResult {
    success: true;
    command: "browse";
    exports: Array<{
        name: string;
        path: string;
        exportedAt: string | null;
        sourcePlatform: Platform | null;
        sourceProjectPath: string | null;
        sessionCount: number | null;
        sessions: SessionManifest[];
        storage: StorageScope;
        metadataAvailable: boolean;
        metadataError?: string;
    }>;
}
export interface ConfigureResult {
    success: true;
    command: "configure";
    config: SeshMoverConfig;
    scope: StorageScope;
    message: string;
}
export interface ErrorResult {
    success: false;
    command: string;
    error: string;
    details?: string;
    suggestion?: string;
}
export interface HubInitResult {
    success: true;
    command: "hub-init";
    hubPath: string;
    hubId: string;
    created: boolean;
    machineRegistered: true;
    configScope: StorageScope;
}
export interface HubStatusResult {
    success: true;
    command: "hub-status";
    hubPath: string | null;
    reachable: boolean;
    hubId: string | null;
    machineRegistered: boolean;
    machinesKnown: number;
    project: {
        linked: boolean;
        projectId: string | null;
    };
    /**
     * What the last SessionEnd auto-push for THIS project reported — the only
     * place its output survives, since that hook's stdout is closed and its
     * stderr is invisible at a clean exit. Absent when no auto-push has run here
     * (or when this project's sync-state predates the field).
     *
     * `notes` are that push's own warnings verbatim (capped), which is where the
     * carry disclosures live: gitignored-but-TRACKED files whose contents rode
     * the patch off this machine, and `.sesh-mover-include` paths that were re-included.
     * On a failed push it is the error instead.
     */
    lastAutoPush?: {
        at: string;
        ok: boolean;
        notes: string[];
        noteCount: number;
    };
    warnings: string[];
}
export interface HubPushResult {
    success: true;
    command: "push";
    projectId: string;
    bundleId: string | null;
    pushedSessions: Array<{
        threadId: string;
        sessionId: string;
        type: "full" | "continuation";
    }>;
    upToDate: boolean;
    hasWorkspace: boolean;
    warnings: string[];
    /**
     * Discovery aid (design §6.0): gitignored paths that this push did NOT carry,
     * as `git` spelled them (a trailing "/" means the whole directory), capped at
     * 10 — a sample to recognize, not an inventory.
     *
     * Present only on a MANUAL push of a project with a git remote that has no
     * `.sesh-mover-include` yet. Absent otherwise, and never emitted by
     * the auto-push hook, whose contract is silence at session exit. Each entry
     * is a valid `.sesh-mover-include` pattern for exactly the thing it names, which is
     * why they are reported as git gives them rather than summarized up to their
     * top-level directory: re-include is the permissive direction, so a broader
     * spelling would carry more than the user pointed at.
     */
    ignoredNotCarried?: string[];
    /**
     * The uncommitted work this push carried (design §6.1), or absent when it
     * carried none.
     *
     * Two separate disclosures, both also surfaced as warnings, and deliberately
     * not merged — they have different causes and different remedies:
     * `reIncluded` names gitignored UNTRACKED paths that travelled only because
     * `.sesh-mover-include` lists them (remedy: edit `.sesh-mover-include`), while `trackedIgnored`
     * names gitignored paths that git TRACKS, whose changes the patch carries
     * because no carry rule filters the patch at all (remedy: `git rm --cached`,
     * or `--no-carry`).
     */
    carry?: CarryMeta;
}
/**
 * One machine's bundles for a thread that a pull resolving to some OTHER
 * machine cannot fetch — the reported shape of `findUnfetchableBundles`
 * (hub/threads.ts), with the hub's display name for the machine attached.
 *
 * Its presence means part of a thread's history is on a machine this pull did
 * not read the bundle list of, and no flag reaches it: a pull fetches exactly
 * one machine's list, and each machine's index lists only its own pushes.
 * Callers must report that plainly and must NOT offer a flag or a re-run —
 * there is none, and a warning whose stated remedy silently does nothing is
 * this milestone's own defect class.
 */
export interface UnfetchableBundleGroup {
    machineId: string;
    /** null when the hub has no readable `machines/<id>.json` record. */
    machineName: string | null;
    bundleIds: string[];
}
export interface WhereisThread {
    threadId: string;
    slug: string;
    summary: string;
    latest: {
        machineId: string;
        machineName: string | null;
        lastActiveAt: string;
        messageCount: number;
    };
    copies: Array<{
        machineId: string;
        machineName: string | null;
        localSessionId: string;
        lastActiveAt: string;
        messageCount: number;
        headEntryUuid: string;
    }>;
    localCopy: {
        localSessionId: string;
        headEntryUuid: string;
        current: boolean;
    } | null;
    pullNeeded: boolean;
    /**
     * Set when at least one machine other than this one and the latest copy's
     * lists bundles for this thread that a pull cannot fetch. Absent on every
     * ordinary thread.
     *
     * Read it BEFORE `localCopy.current` and `pullNeeded`: when it is present,
     * both of those describe only the half of the thread this machine can see.
     * `current: true` alongside it means "level with the copy a pull would
     * resolve to", NOT "holds the whole conversation".
     */
    unfetchableBundles?: UnfetchableBundleGroup[];
}
export interface WhereisResult {
    success: true;
    command: "whereis";
    linked: boolean;
    projectId: string | null;
    linkCandidates?: Array<{
        projectId: string;
        name: string;
        gitRemotes: string[];
    }>;
    threads: WhereisThread[];
    warnings: string[];
}
export interface HubUnlinkedResult {
    success: false;
    command: "push" | "pull" | "whereis";
    reason: "unlinked";
    linkCandidates: Array<{
        projectId: string;
        name: string;
        gitRemotes: string[];
    }>;
    suggestion: string;
}
export interface HubLockBusyResult {
    success: false;
    command: "push" | "pull";
    reason: "lock-busy";
    holderPid: number | null;
    ageSeconds: number | null;
    suggestion: string;
}
export interface HubPullResult {
    success: true;
    command: "pull";
    threadId: string;
    sourceMachineId: string;
    importedSessions: ImportResult["importedSessions"];
    skippedSessions: ImportResult["skippedSessions"];
    localSessionId: string | null;
    workspaceUnpacked: {
        path: string;
        fileCount: number;
    } | null;
    /**
     * Per-file outcome when the workspace payload was applied as a 3-way merge
     * against this machine's last synced generation (design §5.2-5.5), rather
     * than unpacked. Absent whenever no merge ran — including the bootstrap
     * unpack into an empty tree and every no-ancestor fallback — so its presence
     * is precisely "a merge happened, here is what it decided".
     *
     * `workspaceUnpacked` is set alongside it (the payload WAS applied, at that
     * path); this field is the detail.
     */
    workspaceMerge?: WorkspaceMergeReport;
    /**
     * Paths the workspace payload carried that can NEVER be applied, whatever a
     * pattern says — `.git` and `.sesh-mover` at any depth and in any
     * casing (see `NEVER_INCLUDABLE`). Absent on every ordinary pull.
     *
     * It is a result FIELD rather than warning prose because a skill layer has to
     * be able to branch on it: a payload naming `.sesh-mover-include`
     * is trying to rewrite the list that decides what this machine's NEXT push
     * ships, which is the strongest signal this command produces, and warning
     * text is not an interface (see `commands/pull.md`). Nothing from these paths
     * was written; a directory entry stands for everything under it, which was
     * never opened.
     *
     * Its presence is not by itself proof of an attack — a sesh-mover older than
     * the guard, on a case-insensitive filesystem, legitimately shipped a `.GIT`
     * store — so callers must report it without naming a culprit.
     */
    workspaceRefused?: string[];
    /**
     * `true` when a bundle's manifest declared a workspace payload the bundle
     * does not actually contain, so there was nothing to apply and the project
     * directory was left untouched. Absent otherwise.
     *
     * A field rather than warning prose for the usual reason (warning text is not
     * an interface — see `commands/pull.md`), and here it is the ONLY signal:
     * `workspaceUnpacked` is `null` and `workspaceMerge` is absent in this case
     * exactly as they are for the routine "no shared generation, so the payload
     * was skipped" branch, whose remedies (`--force-workspace`,
     * `--target-path <fresh-dir>`) can do nothing for a payload that is not in
     * the bundle. It is the workspace counterpart of `carryAvailable` present
     * with `carryApplied` absent.
     */
    workspaceDeclaredMissing?: boolean;
    /**
     * The uncommitted work this pull's bundle chain carried (design §6.2), as the
     * SENDING machine described it. Present whenever a bundle declared a carry,
     * whether or not it was applied — `carryApplied` says what happened to it.
     */
    carryAvailable?: CarryMeta;
    /**
     * What became of that payload. Always present alongside `carryAvailable`
     * (except when the bundle declared a carry it did not actually contain):
     * `applied: true` means the working tree was changed, and every other shape
     * carries a `reason` plus the `savedTo` directory holding the payload and its
     * manual steps.
     *
     * A field rather than warning prose because there is a real decision behind
     * it — `reason: "not-requested"` is the routine "you did not pass
     * --apply-carry", while `"unsafe-payload"` means a bundle tried to write
     * `.sesh-mover` or a symbolic link — and warning text is not an
     * interface (see `commands/pull.md`).
     */
    carryApplied?: ApplyResult;
    appended?: Array<{
        threadId: string;
        baseSessionId: string;
        entriesAppended: number;
    }>;
    divergence?: HubPullDivergence;
    /**
     * Bundles for this thread that this pull could not fetch because they are
     * listed only by a machine other than the one it resolved to. Absent on
     * every ordinary pull — see `UnfetchableBundleGroup` and, for the reasoning,
     * `findUnfetchableBundles` in hub/threads.ts.
     *
     * A field rather than warning prose because the skill layer has to branch on
     * it: everything else this result reports (`importedSessions`, `appended`,
     * an empty `warnings`) describes a pull that succeeded, and it did — it just
     * did not deliver the whole thread. Warning text is not an interface (see
     * `commands/pull.md`).
     */
    unfetchableBundles?: UnfetchableBundleGroup[];
    warnings: string[];
}
export interface HubPullDivergence {
    threadId: string;
    /** The last entry both branches share; "" when the bundle carries none. */
    anchorUuid: string;
    /** The local session that diverged — the one the numbers below describe. */
    localSessionId: string;
    localHeadUuid: string;
    /** 0 when the anchor isn't in the local base (nothing to measure from). */
    localEntriesSinceAnchor: number;
    localLastActiveAt: string;
    hubHeadUuid: string;
    hubEntriesSinceAnchor: number;
    hubLastActiveAt: string;
    /**
     * False when the anchor is absent from the local session (compacted or
     * unrelated history) — `adopt-hub` is then refused and falls back to
     * `fragment`, because there is no point to cut the local branch at.
     */
    adoptAvailable: boolean;
    /** What actually happened, which is not always what was asked for. */
    resolution: OnDivergenceMode;
    /**
     * Set only when `resolution === "adopt-hub"`: the new session holding the
     * local branch. It has NO thread mapping, so the next push publishes it as
     * a thread of its own.
     */
    preservedSessionId?: string;
}
export interface HubPullListResult {
    success: true;
    command: "pull";
    pickRequired: true;
    threads: WhereisThread[];
    warnings: string[];
}
export interface NotYetSyncedResult {
    success: false;
    command: "pull";
    reason: "not-yet-synced";
    missing: string[];
    suggestion: string;
}
export interface HubReindexResult {
    success: true;
    command: "hub-reindex";
    projects: Array<{
        projectId: string;
        threads: number;
        bundlesScanned: number;
    }>;
    warnings: string[];
}
export type CliResult = ExportResult | ImportResult | DryRunResult | MigrateResult | BrowseResult | ConfigureResult | HubInitResult | HubStatusResult | HubPushResult | WhereisResult | HubUnlinkedResult | HubLockBusyResult | HubPullResult | HubPullListResult | NotYetSyncedResult | HubReindexResult | ErrorResult;
export interface VersionAdapter {
    fromVersion: string;
    toVersion: string;
    description: string;
    applies(entry: JsonlEntry): boolean;
    transform(entry: JsonlEntry): JsonlEntry;
}
export interface PathMapping {
    from: string;
    to: string;
    description: string;
}
export interface RewriteReport {
    mappings: PathMapping[];
    entriesRewritten: number;
    fieldsRewritten: number;
    warnings: string[];
}
export interface ProgressEvent {
    phase: "export-copy" | "import-rewrite" | "import-verify" | "archive" | "extract" | "hub-push" | "hub-pull";
    sessionId?: string;
    sessionIndex?: number;
    sessionCount?: number;
    bytesProcessed?: number;
    bytesTotal?: number;
    percent?: number;
}
export interface DiscoveredSession {
    sessionId: string;
    projectPath: string;
    encodedProjectDir: string;
    jsonlPath: string;
    slug: string;
    createdAt: string;
    lastActiveAt: string;
    messageCount: number;
    gitBranch: string;
    entrypoint: string;
    hasSubagents: boolean;
    hasToolResults: boolean;
    hasFileHistory: boolean;
}
export interface MachineIdentity {
    id: string;
    name: string;
    createdAt: string;
}
export interface SyncStateSessionSent {
    headEntryUuid: string;
    messageCount: number;
    sentAsType: "full" | "continuation";
    sentAsSessionId: string;
}
export interface SyncStateSessionReceived {
    localSessionId: string;
    type: "full" | "continuation";
    importedAt: string;
}
export interface SyncStatePeer {
    name: string;
    lastSentAt: string | null;
    lastReceivedAt: string | null;
    sent: Record<string, SyncStateSessionSent>;
    received: Record<string, SyncStateSessionReceived>;
}
export interface SyncStateLineage {
    sourceMachineId: string;
    sourceSessionId: string;
    importedAt: string;
    type: "full" | "continuation";
    continuationOf?: string;
    postRewriteHash?: string;
}
export interface SyncStateImported {
    localSessionId: string;
    importedAt: string;
    registered: boolean;
}
/**
 * A pointer at one workspace generation stored on the hub.
 *
 * Only a pointer: the hub keeps the tree, because every workspace payload is a
 * full snapshot generation.
 *
 * Neither timestamp participates in any decision. `syncedAt` is this machine's
 * clock and `pushedAt` is the *pushing* machine's clock — the hub is a passive
 * filesystem and stamps nothing — so no comparison between two machines'
 * generations can be drawn from either. Which generation a merge uses is
 * decided by SET MEMBERSHIP (`knownWorkspaceGenerations`), never by time; the
 * stamps are diagnostics.
 */
export interface WorkspaceGenerationRef {
    bundleId: string;
    /** Hub-relative path of the bundle carrying this generation. */
    file: string;
    /** When this machine pushed or applied it (this machine's clock). */
    syncedAt: string;
    /** When the bundle was published (the PUSHING machine's clock). Diagnostic only. */
    pushedAt?: string;
}
export interface SyncState {
    projectPath: string;
    schemaVersion: 1 | 2;
    peers: Record<string, SyncStatePeer>;
    lineage: Record<string, SyncStateLineage>;
    imported: Record<string, SyncStateImported>;
    hub?: {
        hubId: string;
        threadByLocalSession: Record<string, string>;
        /**
         * The workspace generation this machine last pushed or applied — i.e. the
         * head of `workspaceGenerations`, and what a push declares as its
         * `basedOn`.
         *
         * Absent until this project first pushes or pulls a workspace payload,
         * which is why a plain sessions-only hub user never grows the field.
         */
        lastWorkspace?: WorkspaceGenerationRef;
        /**
         * Every workspace generation this machine's tree has passed through, most
         * recent first and bounded (see `MAX_WORKSPACE_GENERATIONS`), with
         * `lastWorkspace` as its head.
         *
         * This is the merge's whole ancestor mechanism: a generation may be used as
         * a 3-way merge base only if it is common to BOTH trees, and membership in
         * this list is exactly the "we held it too" half of that test — no clocks
         * involved. See `hub/pull.ts`'s `chooseMergeAncestor`, which intersects it
         * with what the incoming chain declares it descends from.
         */
        workspaceGenerations?: WorkspaceGenerationRef[];
        /**
         * What the last SessionEnd auto-push had to say for itself.
         *
         * The auto-push runs detached with its stdout closed and its stderr shown
         * only in Claude Code's debug output, so everything it computes for a human
         * is discarded — including the disclosures that exist precisely to be read:
         * `carry.trackedIgnored` (gitignored-but-TRACKED files whose contents left
         * the machine in the patch) and the re-included `.sesh-mover-include` paths. It is
         * also where a chronically failing push (an unmounted share) would
         * otherwise be invisible. This is the durable breadcrumb for both, surfaced
         * by `hub status`.
         *
         * Written only by the auto-push endpoint, and only best-effort: it is a
         * record OF a push, never an input TO one, so nothing reads it back.
         */
        lastAutoPush?: {
            at: string;
            ok: boolean;
            /** Capped at `MAX_AUTO_PUSH_NOTES`; `noteCount` is how many there were. */
            notes: string[];
            noteCount: number;
        };
    };
}
//# sourceMappingURL=types.d.ts.map