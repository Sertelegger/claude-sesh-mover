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
    /**
     * Uuid of the FIRST entry this delta ships — `entries[fromEntryIndex].uuid`,
     * i.e. one PAST the head it was diffed against (`src/diff.ts`). Its consumer
     * is the continuation header written by `continuation.ts`, which re-reads the
     * entry at `fromEntryIndex` and refuses the slice if the uuid moved.
     *
     * It is NOT a link to the previous bundle and never was — see
     * `anchorEntryUuid`. It is also routinely `""`: `readEntryUuids` maps every
     * uuid-less or unparseable line to `""`, and the first unsent line of a live
     * transcript is usually a uuid-less bookkeeping entry.
     */
    fromEntryUuid: string;
    /**
     * The head this delta was built AGAINST: the `headEntryUuid` of the last
     * bundle the peer is recorded as holding, i.e. the parent of the first entry
     * shipped here. This is the field a chain walk links on — a bundle whose
     * `headEntryUuid` equals it is this one's predecessor.
     *
     * Optional, and the absence is meaningful rather than a default: a manifest
     * written before chain assembly existed carries no anchor and its bundle is
     * therefore **unlinkable by construction**. Never substitute `fromEntryUuid`
     * for a missing value — the two have never been equal, and mixing them in one
     * map manufactures chains that look assembled and are not.
     *
     * When present it is a non-empty uuid: `computeIncrementalPlan` falls back to
     * a full push whenever the recorded head is `""` or is no longer in the
     * transcript, so no continuation is ever planned against an empty head.
     */
    anchorEntryUuid?: string;
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
    /**
     * The layers this bundle ACTUALLY CARRIES — content, never policy.
     *
     * A layer is listed iff its payload is on disk in the bundle: `jsonl` iff at
     * least one session file was written, the three per-session layers iff at
     * least one session directory for them exists (which is exactly when that
     * session declares a `layerDigests` key for it), `memory`/`plans` iff their
     * bundle-root directory exists. Nothing is listed because it was merely
     * *requested*.
     *
     * It used to be `getAllLayers()` minus `--exclude`, computed once and stamped
     * regardless of what the export then did — so every hub bundle declared
     * `memory` and `plans` while carrying neither (#53), and any export from a
     * source with no subagents declared `subagents`. `commands/browse.md` offers
     * this field to a human as the answer to "what is in this export", so the
     * distance between the two readings was a lie with a reader.
     *
     * It is OUTSIDE `sessionsDigest` (that digest covers `sessions` only), so
     * changing what is declared here can never invalidate an existing bundle.
     */
    includedLayers: ExportLayer[];
    sessions: SessionManifest[];
    /**
     * Digest over the session inventory above — see `computeSessionsDigest` for
     * what it covers, what it deliberately does not, and why it is damage
     * detection rather than attestation. Optional: pre-0.6.0 bundles carry none
     * and are verified as they always were.
     */
    sessionsDigest?: string;
    /**
     * `computeLayerDigest` over the bundle's own `memory/` directory — present
     * iff the bundle carries one, so it is the machine-readable twin of
     * `includedLayers` containing `"memory"`.
     *
     * Its job is the incremental skip: a push records this value against the peer
     * it sent to (`SyncStatePeer.memoryDigest`), and the next export to that peer
     * ships `memory/` again only when the source directory no longer hashes to
     * it. Taken over the BUNDLE's copies rather than the source tree, for the same
     * reason `computeSessionLayerDigests` is — the recorded value has to describe
     * the bytes that actually travelled, or a truncated copy would suppress the
     * re-send that repairs it.
     *
     * Outside `sessionsDigest`, like `workspace`/`carry`/`projectId`.
     */
    memoryDigest?: string;
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
        /**
         * What the bundle carries FOR THIS SESSION, plus the bundle-level layers
         * (`memory`/`plans`) it carries at all. Content, never policy — same rule as
         * `ExportManifest.includedLayers`, of which this is the per-session slice,
         * so two sessions in one bundle can legitimately differ (one had subagents,
         * the other did not).
         */
        exportedLayers: ExportLayer[];
    }>;
    warnings: string[];
    archivePath: string | null;
    actualFormat?: ExportFormat;
    collision: boolean;
    existingPath?: string;
}
/**
 * A shared-namespace auxiliary file that exists on both sides with different
 * content. This is tier 3's entry point as well as tier 2's report: it gives
 * the skill layer the FACT of the conflict and two hashes, never the contents —
 * the contents come from disk, which is what `parkedAs` is for. By the time a
 * caller reads this the bundle may be gone (`cli.ts` deletes an archive's
 * extract dir before returning), so a reader that goes back to the bundle for
 * the incoming text is reading a directory that no longer exists.
 */
export interface AuxiliaryConflict {
    filename: string;
    existingHash: string;
    incomingHash: string;
}
export interface MemoryConflict extends AuxiliaryConflict {
    /**
     * Tier 2: the file the incoming copy was parked as, relative to the memory
     * directory (`<stem>.incoming.md`, uniquified). Absent only when parking was
     * impossible, in which case the incoming text is NOT on this machine.
     */
    parkedAs?: string;
}
/** What the `MEMORY.md` union did. `MEMORY.md` is an outcome, not a conflict. */
export interface MemoryIndexReport {
    /** Link targets appended to the local index, in incoming order. */
    added: string[];
    /** Incoming pointers deduped away because the local index already had them. */
    alreadyPresent: number;
    /** Incoming headings/prose discarded — the union merges entries, not documents. */
    droppedProse: boolean;
    /**
     * Memory files the bundle carried that no index line points at after the
     * union. These landed on disk unreachable — usually because they were already
     * orphaned on the SOURCE machine, which the union cannot fix: it is a union
     * over index lines, and a file no line points at contributes no line.
     */
    unindexed: string[];
}
/** One line of the dry run's memory preview. Same function as the real run. */
export interface MemoryPlanEntry {
    filename: string;
    /**
     * - `copy` — absent locally, will be written verbatim
     * - `identical` — present, bytes equal, no write
     * - `index-union` — this is `MEMORY.md` and it differs; entries will be appended
     * - `park` — prose conflict; local kept, incoming parked as `parkedAs`
     * - `keep-local` — conflict that could not be parked or read; local kept
     * - `skip` — not a regular file, ignored
     */
    verdict: "copy" | "identical" | "index-union" | "park" | "keep-local" | "skip";
    /** `index-union`: the link targets that would be appended. */
    added?: string[];
    /** `index-union`: incoming pointers that would be deduped away. */
    alreadyPresent?: number;
    /** `park`: the name that would be used, absent an unresolved earlier copy. */
    parkedAs?: string;
    note?: string;
}
/**
 * What a run did to the two **shared-namespace** auxiliary layers — `memory/`
 * (into the target project dir) and `plans/` (into the target config dir).
 * Produced by `reconcileSharedLayers` in `src/importer.ts`, which is the single
 * implementation every path shares.
 *
 * ONE DECLARATION, mixed into `ImportResult`, `MigrateResult` and
 * `HubPullResult`, for the same reason `HubPullFindings` is one declaration: an
 * import is reachable through three commands, and a hand-written second copy of
 * these fields on one of them is exactly how a field ends up readable on `import`
 * and absent on `pull` — which is what it did (#59 item 3), and what #49 was
 * before it. A field added here reaches all three shapes with no edit.
 *
 * **Warnings are not a substitute for these fields.** `pull` and `migrate` both
 * folded the importer's `warnings` into their own and stopped there, so the
 * skill layer got the sentence "…saved theirs as notes.incoming.md…" and no
 * machine-readable path to act on. `commands/import.md` branches on the typed
 * fields and uses the warning only for wording; `commands/pull.md` and
 * `commands/migrate.md` now do the same.
 */
export interface SharedLayerFindings {
    /**
     * Prose memory files that differ on both sides. Never `MEMORY.md` — the index
     * is unioned, so it is reported in `memoryIndex` instead.
     */
    memoryConflicts?: MemoryConflict[];
    memoryIndex?: MemoryIndexReport;
    /**
     * Absolute path of the target project's memory directory, present whenever
     * the bundle carried a `memory/` layer. Every `filename`/`parkedAs` above is
     * relative to it. It is reported rather than left to be derived because
     * deriving it means re-implementing `encodeProjectPath` in markdown — a
     * second copy of an encoding whose own module refuses to invert it.
     */
    memoryDir?: string;
    /**
     * Plans that differ on both sides. Reported only: a plan is a document with
     * no index and no union, and `plans/` is config-dir-global, so nothing is
     * written beside it. The local plan is kept and the incoming one stays in the
     * bundle.
     *
     * Only ever populated when the plans layer was applied at all — see
     * `plansSkipped`.
     */
    planConflicts?: AuxiliaryConflict[];
    /**
     * How many plan files the bundle carried that were **not written**, because
     * `--include-plans` was not passed. Present only when the bundle had some.
     *
     * The plans layer is opt-in on the receive side for the reason CLAUDE.md
     * already gives for keeping it off the hub: `<configDir>/plans` is
     * config-dir-global with no project filter, so applying it writes files every
     * project on this machine shares, on the say-so of a bundle. `memory/` lands
     * in the target project's own directory and stays default-on.
     *
     * A count and not a boolean, because the number is the disclosure: "this
     * bundle wanted to write 14 files into a shared directory" is a different
     * sentence from "it wanted to write 1".
     *
     * REACH, and it is narrower than the "one declaration" note above promises:
     * declaring a field here gives all three shapes the TYPE, not the value. The
     * two projections that build a `MigrateResult` (`migrator.ts`) and a
     * `HubPullResult` (`hub/pull-apply-state.ts`'s `sharedLayerFindings`) are
     * hand-written field lists, so this one is populated on `import` only. That
     * is currently harmless — a pull never writes plans and `plans/` never
     * reaches the hub — and the accompanying warning does cross both, but the
     * field does not follow the type until those two lists name it.
     */
    plansSkipped?: number;
}
export interface ImportResult extends SharedLayerFindings {
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
    /** What the memory step would do, computed by the function that does it. */
    memoryPlan?: MemoryPlanEntry[];
    memoryDir?: string;
    planConflicts?: AuxiliaryConflict[];
    /** Plans the bundle carries that the real run would not write. Same rule. */
    plansSkipped?: number;
}
export interface MigrateResult extends SharedLayerFindings {
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
    /**
     * Dry run only: what the memory step WOULD do, computed by the same function
     * that does it. The mixed-in `memoryConflicts`/`memoryIndex` describe writes
     * that happened, so they are absent on a preview and this is what stands in
     * for them — the same split `DryRunResult` makes for a plain import.
     */
    memoryPlan?: MemoryPlanEntry[];
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
    /**
     * Disclosures collected BEFORE the failure, present only when there are any.
     *
     * A failure is not a reason to withhold what already happened. `hub pull`
     * applies bundles one at a time and accumulates a disclosure per bundle; when
     * bundle 3 aborts, bundles 0-2 are on disk, recorded as received, and will
     * never be offered again — so a result that reports only the abort is not
     * merely terse, it is **untruthful about what this command did**. That is the
     * invariant the failure contract puts first: truthfulness, with completeness
     * best-effort.
     *
     * Absent, never `[]`, when nothing was collected — so a reader can tell "this
     * command disclosed nothing" from "this command had nothing to disclose"
     * without either being a lie.
     */
    warnings?: string[];
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
/**
 * What this machine can see at the configured `hub.path`, as one answer shared
 * by every verb that asks (`src/hub/preflight.ts`'s `probeHubReachable`).
 *
 * The two failing members are the ones `HubUnreachableResult` is built from —
 * they are declared here rather than there so that the diagnostic verbs, which
 * report the state instead of refusing on it, cannot drift into a second,
 * differently-spelled opinion about what "reachable" means. `hub status` saying
 * `reachable: true` for a directory `push` refuses as `not-a-hub` is exactly the
 * disagreement this type exists to make impossible.
 */
export type HubReachabilityState = "ok" | "no-directory" | "not-a-hub";
export interface HubStatusResult {
    success: true;
    command: "hub-status";
    hubPath: string | null;
    /**
     * `hubState === "ok"`, restated as the boolean this result has always carried.
     *
     * It is derived rather than computed separately on purpose: it used to mean
     * "hub.json exists and parsed", which said `true` for a `hub.json` carrying no
     * `hubId` — a file push and pull refuse outright. The two now answer from one
     * probe.
     */
    reachable: boolean;
    /**
     * WHICH of the states above, so a caller can tell an unmounted share from a
     * directory that is not a hub without reading `warnings` — the same enum, and
     * the same distinction of remedy, that `HubUnreachableResult.hubState` carries
     * for the verbs that refuse.
     *
     * `null` — and ONLY then — when `hubPath` is null: no hub is configured, so
     * the question was never asked. That is a different fact from "asked and could
     * not see it", and collapsing it into `no-directory` would send a user who has
     * simply never run `hub init` to check whether a share is mounted.
     *
     * `hub status` is also the one place the configured path IS reported
     * (`hubPath`): the refusals withhold it deliberately, and this is the command
     * they point at instead.
     */
    hubState: HubReachabilityState | null;
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
 * A push that threw AFTER the point where it could have linked this project.
 * Structurally an `ErrorResult` (`success: false`, `command: "push"`, `error`,
 * optional `details`/`suggestion`) with the link state added as FIELDS.
 *
 * The fields are the point. What the user has to be told is not in the
 * exception and never was — whether this directory is linked *right now*,
 * because a link is the consent gate for the default-on SessionEnd auto-push,
 * and for a git-less project that push uploads the whole working tree. Until
 * this shape existed that fact lived only as English prose inside `details`,
 * and `recordAutoPushOutcome` (cli.ts) — the ONLY reader an unattended
 * session-end push has — records `error` and `suggestion` and never looks at
 * `details`. So the one push nobody watches was also the one that lost the
 * disclosure entirely. Branch on the fields; treat `details` as prose.
 *
 * `reason` says "failed-after-link" for every failure past the identity
 * decision, including the ones where no link was written at all (`linked:
 * false`, `linkRolledBack: false`): the discriminator marks the phase, and
 * `linked` — not the reason string — answers the question about state.
 */
export interface HubPushFailedResult {
    success: false;
    command: "push";
    reason: "failed-after-link";
    error: string;
    details?: string;
    suggestion?: string;
    /** TRUE = this directory is linked RIGHT NOW, so SessionEnd auto-push is armed. */
    linked: boolean;
    /** The hub project the link names (or would have named). */
    projectId: string;
    /** This push made the link and removed it again. */
    linkRolledBack: boolean;
    /**
     * A hub project this push minted that nothing removes — retry with
     * `--project-id <it>` rather than minting a second. Null when this push
     * created none.
     */
    orphanHubProjectId: string | null;
    /** Bundle reached the hub but no index references it. */
    orphanBundle: boolean;
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
    /**
     * Would a pull of this thread fetch a bundle that has never arrived here?
     *
     * The pull's OWN selector answers it (`pullSourceFor`), so `whereis`, `pull
     * --latest` and `pull --thread <id>` cannot disagree about it — they did
     * until #44, when this field was head equality (`latest is on another machine
     * AND (no local copy or local head != latest head)`) and the pull was
     * receipts. A head can arrive by a route that recorded no bundle, so the two
     * come apart in both directions: this is true on a thread whose
     * `localCopy.current` is also true, and false on a thread whose `latest` is
     * another machine.
     */
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
    /**
     * Could this machine read the hub at all?
     *
     * **A field on a `success: true` result rather than a refusal, deliberately**
     * — the precedent is this command's own `linked: false`, which reports an
     * unresolved identity in the normal shape because `whereis` is a read (see
     * `HubUnlinkedResult`). An unreachable hub is the same kind of fact and gets
     * the same treatment; `push` and `pull` refuse on it because they were about
     * to write.
     *
     * **Read it before anything else, because it re-reads two other fields.** When
     * it is false: `threads` is `[]` meaning UNKNOWN, never "this project has no
     * threads on the hub"; `linked` is a purely local fact (the presence of
     * `.sesh-mover-project.json`) that says nothing about whether the hub still
     * has that project; and `linkCandidates` is ABSENT rather than empty, because
     * an empty pick list is documented to mean "the hub lists no projects" and the
     * projects listing is exactly what could not be read.
     *
     * Until this field existed all three of those read as confident answers: an
     * unmounted share produced `linked: true, threads: []` — identical to a linked
     * project nobody has ever pushed — with nothing to tell the two apart.
     */
    reachable: boolean;
    /** Which state `reachable` is short for; `"ok"` exactly when it is true. */
    hubState: HubReachabilityState;
    warnings: string[];
}
/**
 * A command that needs a hub project and found this directory linked to none.
 *
 * **Not to be confused with `HubUnlinkResult`** (no "ed"), which is the SUCCESS
 * result of the `hub unlink` verb — the deliberate act of removing a link.
 * This one is a refusal: nothing happened, and `linkCandidates` is the pick
 * list for linking.
 *
 * **`whereis` is deliberately NOT a member** (#29). It is a read, so an
 * unresolved identity is not a refusal for it: it reports the same pick list
 * through `WhereisResult.linked: false` + `linkCandidates` on a `success: true`
 * result, and `hubWhereis` is declared to return `WhereisResult` alone — it
 * *cannot* produce this shape. The member sat here unconstructed from the day
 * it was written, which is worse than absent: `commands/whereis.md` and the
 * skill doc both tell the caller there is no error case to catch, so a third
 * member here invited someone to write a branch that can never run. If a
 * `whereis` refusal is ever wanted, changing `WhereisResult` is the change —
 * re-adding the member alone would not produce one.
 */
export interface HubUnlinkedResult {
    success: false;
    command: "push" | "pull";
    reason: "unlinked";
    linkCandidates: Array<{
        projectId: string;
        name: string;
        gitRemotes: string[];
    }>;
    suggestion: string;
}
/**
 * `--project-id` named a hub project the hub does not have (or whose id is not
 * path-safe). A refusal, and deliberately NOT `HubUnlinkedResult`: this
 * directory may well be linked already — only the *flag* is wrong — so
 * "unlinked" would misdescribe it and its remedy ("pick a project to link to")
 * is only half of this one's.
 *
 * Produced BEFORE the verb does any work, by the shared gate in
 * `src/hub/preflight.ts`, which is the point of it: `hub push` used to discover
 * a bad `--project-id` deep in its own identity resolution — after it had
 * registered this machine on the hub, minted a thread into local sync-state and
 * run a full export — and then throw an `ENOENT` carrying the hub's absolute
 * path out through the generic catch. A validation failure must not happen
 * after side effects.
 *
 * `linkCandidates` is the same pick list `HubUnlinkedResult` carries, so a
 * caller can offer one branch for both; it is empty (never absent) when the hub
 * itself could not be listed.
 *
 * Scope: the guarantee is the LIBRARY's, not just the CLI's. The gate was
 * CLI-level when it was introduced (#29), which left a consumer calling
 * `hubPush`/`hubPull` through `src/index.ts` still getting the throw from
 * `readHubProjectAsLocal`; #75 moved it inward so the two agree.
 *
 * Its exit class is 2, the refusal class — see `exitCodeForResult` below. It
 * exited 1 until #76, argued there as "a bad invocation, the same class as
 * `--on-divergence bogus`"; the owner's mapping moved it, and the more useful
 * line for a shell caller is that the hub was reachable, nothing was written,
 * and the body carries a pick list to correct the flag from.
 */
export interface HubNoSuchProjectResult {
    success: false;
    command: "push" | "pull";
    reason: "no-such-project";
    /** Echoed back verbatim — this is the value the user typed, not a hub value. */
    requestedProjectId: string;
    linkCandidates: Array<{
        projectId: string;
        name: string;
        gitRemotes: string[];
    }>;
    suggestion: string;
}
/**
 * The configured hub could not be used AT ALL: nothing about it was read, so
 * push and pull refuse before touching the project, the hub or their own
 * bookkeeping (#75).
 *
 * Replaces a raw `ENOENT` that escaped both verbs through the CLI's generic
 * catch — untyped, so the skill layer had nothing to branch on while every
 * other hub failure (`unlinked`, `lock-busy`, `not-yet-synced`,
 * `no-such-project`) carried a `reason`, and carrying the hub's absolute path
 * in its message for no benefit. **Nothing here names the path**, deliberately:
 * `hub status` is where a user asks which path is configured.
 *
 * **Not `NotYetSyncedResult`, and the difference is not a shade of meaning.**
 * That one presupposes a fully readable hub — its `hub.json`, its machine
 * indexes, the thread it resolved — and reports that specific *bundle files*
 * those indexes reference have not landed on this machine's copy of a synced
 * folder yet; it can therefore list them (`missing`), and the remedy is to wait
 * for the same sync client to finish. This one is emitted when the hub itself
 * could not be read, so nothing is known about it and there is no file list to
 * give. The two can never both be true: `not-yet-synced` is only reachable
 * after this gate has passed.
 *
 * **Which verbs return it is a judgement per verb, not a rollout.** The three
 * here WRITE (push, pull) or repair by writing (`hub reindex`), so refusing is
 * what keeps the write from happening. The two diagnostic verbs deliberately do
 * NOT: `hub status` exists to answer "what state is this in", so it reports the
 * same `hubState` inside its `success: true` result, and `whereis` follows its
 * own `linked: false` precedent and does the same. `hub unlink` never asks the
 * question at all — it is the disarm path and constructs no backend.
 */
export interface HubUnreachableResult {
    success: false;
    command: "push" | "pull" | "hub-reindex";
    reason: "hub-unreachable";
    /**
     * Which of the two shapes it is — an enum rather than prose, because the
     * remedies differ and `skills/session-porter/SKILL.md` forbids branching on
     * message text.
     *
     * - `no-directory` — the configured path is not a directory this machine can
     *   stat: an unmounted share, a synced folder that has not appeared here, a
     *   path that was never right, or one it may not read.
     * - `not-a-hub` — the directory is there but carries no usable `hub.json`. A
     *   synced folder whose first sync is still in flight looks exactly like a
     *   directory that is simply not a hub, so this arm covers both.
     *
     * Spelled as the non-`ok` half of `HubReachabilityState` rather than as its
     * own pair of literals: the diagnostic verbs report the SAME probe's answer,
     * and one declaration is what stops a renamed (or third) state reaching `hub
     * status` and never reaching here.
     */
    hubState: Exclude<HubReachabilityState, "ok">;
    suggestion: string;
}
export interface HubLockBusyResult {
    success: false;
    command: "push" | "pull" | "hub-unlink" | "hub-reindex";
    reason: "lock-busy";
    holderPid: number | null;
    ageSeconds: number | null;
    /**
     * The lock error's own message (which pid, how old). Set by `hub unlink`,
     * whose refusal a HUMAN reads while deciding whether to wait or to `--force`
     * past it, and by `hub reindex`, which is a manual repair verb read the same
     * way; push and pull leave it absent, because for them a busy lock means
     * another operation is already doing the work and the caller is told to
     * retry, not to adjudicate.
     */
    error?: string;
    suggestion: string;
}
/**
 * A link in a thread's assembled history naming an entry no bundle on the hub
 * carries — something between two bundles is genuinely missing.
 *
 * Deliberately NOT the same condition as `HubPullUnplaceableBundle`: a gap is a
 * bundle that says which entry it continues and names one nobody ships, while an
 * unplaceable bundle never said. Only the first can be repaired by finding
 * something (spec §0b).
 */
export interface HubPullChainGap {
    /**
     * The entry the stranded bundle declares itself a continuation of. `""` is
     * one of them — an empty uuid can never match a head, so a bundle carrying it
     * is stranded exactly as if its predecessor were missing.
     */
    anchorEntryUuid: string;
    machineId: string;
    /** null when the hub has no readable `machines/<id>.json` record. */
    machineName: string | null;
    /** The bundle at the boundary: the first one the walk could not place. */
    bundleId: string;
    /** That bundle and every bundle chaining onto it — what this gap strands. */
    strandedBundleIds: string[];
}
/**
 * A branch of a forked thread this pull did not follow. Nothing is lost: it is
 * still on the hub, and this pull applied the other side of the fork.
 */
export interface HubPullParkedBranch {
    /** The entry both branches continue. Never `""` — that is a gap, not a fork. */
    anchorEntryUuid: string;
    /** The branch this pull DID follow, by its first bundle id. */
    followedBundleId: string;
    machineId: string;
    machineName: string | null;
    /** This branch's first bundle. */
    bundleId: string;
    /** That bundle and everything reachable from it. */
    bundleIds: string[];
}
/** A bundle that cannot be placed in a thread's history at all. */
export interface HubPullUnplaceableBundle {
    machineId: string;
    machineName: string | null;
    bundleId: string;
    /**
     * `true` — pushed before sesh-mover recorded which entry a continuation
     * chains onto, so the link was never written. That bundle is **not missing**,
     * and the machine still holding that session re-links it the next time it
     * pushes. `false` — the index declares a continuation of nothing, which no
     * sesh-mover push can produce: a damaged or hand-edited index.
     */
    preAssembly: boolean;
}
/**
 * A starting point of this thread that the pull did not walk. More than one
 * starting point is ORDINARY rather than damage — a session that was compacted,
 * truncated or rolled back is re-pushed whole under the same thread id — and two
 * of them can never be joined, because a compaction rewrites the very entry
 * uuids a link would need.
 */
export interface HubPullUnwalkedRoot {
    machineId: string;
    machineName: string | null;
    /** The root bundle itself. */
    bundleId: string;
    /** That bundle and everything reachable from it. */
    bundleIds: string[];
}
/**
 * A machine whose index advertises a thread head no bundle record ships — it has
 * work it never pushed.
 *
 * Not a fetch failure: that work is not on the hub at all, so no pull of any
 * kind reaches it. It arrives once that machine pushes, which its SessionEnd
 * auto-push does by default. Present only on a pull that applied nothing, where
 * it is frequently the entire answer to "why"; on a pull that applied something
 * it would be noise about another machine's local state.
 */
export interface HubPullAdvertisedHead {
    machineId: string;
    machineName: string | null;
    headEntryUuid: string;
}
/**
 * The chain-assembly disclosures a pull may attach to its result: what it worked
 * out about a thread's history that it could not deliver. Every field is
 * optional and absent on an ordinary pull, so "nothing to disclose" is the empty
 * object rather than a flag.
 *
 * ONE DECLARATION, mixed into `HubPullResult` below and carried verbatim by the
 * select stage's two applying-something/applied-nothing outcomes
 * (`SelectStageResult.findings` and `SelectReport.findings`, hub/pull-select.ts),
 * which `hubPull` spreads into the result unchanged. A disclosure added here
 * therefore reaches the ordinary pull and the applied-nothing report at the same
 * moment; a second, hand-written copy on the stage side is exactly how a finding
 * ends up reportable on one path and silently dropped on the other.
 *
 * THE PRESENCE RULE, and it is what makes these fields a contract rather than a
 * dump: **a field is present exactly when the warning that describes it was
 * emitted.** The two are computed together in `describeAssembly` for that reason
 * — a field with no sentence leaves a caller guessing at what it means, and a
 * sentence with no field forces the skill layer to branch on wording, which this
 * file's other docs spend a lot of words forbidding.
 */
export interface HubPullFindings {
    /**
     * Bundles for this thread that this pull did not fetch because the assembled
     * chain does not reach them. Absent on every ordinary pull — see
     * `UnfetchableBundleGroup` and, for the reasoning, `findUnfetchableBundles` in
     * hub/threads.ts.
     *
     * It names the MACHINES; which condition put those bundles out of reach is
     * one of the four fields below, and both are always emitted together. A field
     * rather than warning prose because the skill layer has to branch on it:
     * everything else this result reports (`importedSessions`, `appended`, an
     * empty `warnings`) describes a pull that succeeded, and it did — it just did
     * not deliver the whole thread. Warning text is not an interface (see
     * `commands/pull.md`).
     */
    unfetchableBundles?: UnfetchableBundleGroup[];
    /** Links naming an entry no bundle on the hub carries. */
    chainGaps?: HubPullChainGap[];
    /** Branches of a forked thread this pull did not follow. */
    parkedBranches?: HubPullParkedBranch[];
    /** Bundles that can be placed in no chain at all. */
    unplaceableBundles?: HubPullUnplaceableBundle[];
    /** Starting points of this thread this pull did not walk. */
    unwalkedRoots?: HubPullUnwalkedRoot[];
    /** Machines advertising a thread head they never pushed. */
    advertisedUnshipped?: HubPullAdvertisedHead[];
}
/**
 * Why a pull applied nothing, on the one exit where applying nothing is the
 * whole and correct answer rather than a failure. See `HubPullResult`'s
 * `nothingToApply`.
 */
export interface HubPullNothingToApply {
    /**
     * One or more sentences: what was worked out about this thread, and why none
     * of it needed applying. Never empty — an exit with nothing to say is the
     * ordinary "nothing to pull" refusal, not this.
     *
     * Prose, so it is deliberately not an interface. Anything a caller must
     * branch on belongs in `HubPullFindings` instead (see `commands/pull.md` on
     * why warning text is not a contract).
     */
    reason: string;
}
/**
 * `HubPullResult` mixes in `SharedLayerFindings` as well as `HubPullFindings`.
 *
 * A pull applies a CHAIN of bundles, each through its own `importSession` call,
 * all of them into the SAME memory directory — so the shared-layer fields are
 * **aggregated across the chain, not reported per session**. That is not a
 * convenience: `memory/` and `plans/` are not session-scoped at all (they are
 * project- and config-dir-scoped), so "per session" is a category error, and a
 * pull of five bundles that each park a memory file must report five parked
 * paths rather than the last one. The aggregation and its dedup rules live in
 * `hub/pull-apply-state.ts` (`recordSharedLayers` / `sharedLayerFindings`).
 */
export interface HubPullResult extends HubPullFindings, SharedLayerFindings {
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
     * Present exactly when this pull resolved a thread, worked out that there was
     * nothing left to fetch for it, and therefore applied nothing — and that is
     * the complete, correct answer rather than a failure. Alongside it,
     * `importedSessions`/`skippedSessions`/`appended` are empty and
     * `localSessionId` is null, because this run landed nothing and so wrote no
     * thread mapping.
     *
     * WHY IT IS A SUCCESS FIELD AND NOT AN ERROR. The pull's failure contract is
     * apply-safe-and-name-the-gap: truthfulness is the invariant, completeness is
     * best-effort. "Here is this thread's history, here is the part of it I cannot
     * reach, and I correctly changed nothing" satisfies both. Returning it as
     * `success: false` is the nag loop the disclosure fields exist to break, one
     * branch later — an error tells the caller to try again, and every try says
     * the same thing forever.
     *
     * NOT TO BE CONFUSED with `pull-record.ts`'s local `appliedNothing`, which
     * asks a different question of a pull that DID fetch a chain (did any of its
     * bundles land?) and is true on the divergence-skip path, where this field is
     * absent.
     */
    nothingToApply?: HubPullNothingToApply;
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
/**
 * The hub is readable and its indexes resolved a thread, but specific BUNDLE
 * FILES those indexes reference have not landed on this machine's copy of the
 * hub directory yet (a synced folder mid-copy, on-demand hydration).
 *
 * The narrow one of the pair: see `HubUnreachableResult` for why "the hub
 * itself could not be read" is a different result and not a second spelling of
 * this. Reaching this exit means the reachability gate already passed, which is
 * what makes `missing` a real, enumerable list.
 */
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
    /**
     * Bundle files in this machine's own bundle directory whose names the rebuild
     * could not parse, so nothing they contain reached the index. Absent on an
     * ordinary rebuild. Foreign files in that directory are the ordinary cause;
     * a sync client's conflict copy (`… (conflicted copy).tar.gz`) is the one to
     * expect.
     */
    unrecognizedBundleFiles?: string[];
    /**
     * Bundle records the rebuild DROPPED because this machine's sync-state has no
     * thread mapping for the session they carry — the rebuilt index is missing
     * them, and a bundle no index references is invisible to every other machine.
     *
     * Typed rather than left to `warnings` because it is data loss, not advice:
     * `skills/session-porter/SKILL.md` forbids branching on warning text, so
     * without a field the only way to notice was to regex the prose. Absent when
     * nothing was dropped.
     */
    droppedBundles?: Array<{
        sessionId: string;
        file: string;
    }>;
    warnings: string[];
}
/**
 * `hub reindex` refused before it rebuilt anything. Additive (#29): every
 * reindex failure used to be an untyped `ErrorResult`, so a caller could only
 * tell the cases apart by regexing `error`.
 *
 * The busy-lock refusal is NOT here — it is `HubLockBusyResult`, the same shape
 * push, pull and `hub unlink` return, so "wait and retry" stays one branch
 * across every verb that takes the project lock.
 */
export interface HubReindexFailedResult {
    success: false;
    command: "hub-reindex";
    /**
     * `unlinked` — this directory is linked to no hub project, so there is
     * nothing to rebuild from. Deliberately not `HubUnlinkedResult`: reindex
     * returns before a backend exists, so it has no candidate list to offer, and
     * its remedy is "push first", not "pick a project".
     */
    reason: "unlinked";
    error: string;
    suggestion: string;
}
/**
 * The result of the `hub unlink` verb: this directory's hub link was removed
 * (or was already absent).
 *
 * **Not to be confused with `HubUnlinkedResult`** (with the "ed"), which is the
 * REFUSAL a push/pull/whereis returns when it needs a link and finds none.
 * This one is a success: the link is gone because the user asked for it to be.
 *
 * Unlinking is deliberately the narrowest possible act — it removes one file
 * and writes nothing to the hub — so most of what a caller needs to relay is
 * about what was NOT touched. Hence `projectId` (kept so a re-link can pass
 * `--project-id` and keep this project's sync bookkeeping meaningful) and
 * `warnings` (the sync-state that stays behind, a lock that was skipped).
 */
export interface HubUnlinkResult {
    success: true;
    command: "hub-unlink";
    /** false = idempotent no-op: nothing was linked here to begin with. */
    wasLinked: boolean;
    /** The hub project this directory was linked to, so a re-link can name it. */
    projectId: string | null;
    /** The one file that was removed, or null when there was none. */
    removedPath: string | null;
    /**
     * Both Claude Code hooks are inert for this directory now. Linking IS the
     * consent gate (`evaluateHookGate` reads exactly this file), so removing it
     * disarms the SessionEnd auto-push and the SessionStart notice at once —
     * for THIS directory only.
     */
    automationDisarmed: boolean;
    warnings: string[];
}
export type CliResult = ExportResult | ImportResult | DryRunResult | MigrateResult | BrowseResult | ConfigureResult | HubInitResult | HubStatusResult | HubPushResult | HubPushFailedResult | WhereisResult | HubUnlinkedResult | HubNoSuchProjectResult | HubUnreachableResult | HubUnlinkResult | HubLockBusyResult | HubPullResult | HubPullListResult | NotYetSyncedResult | HubReindexResult | HubReindexFailedResult | ErrorResult;
/**
 * The CLI's process exit codes: **one per CLASS of outcome**, so a shell caller
 * can branch on `$?` without parsing the JSON body (#76).
 *
 * Before this existed the split was an accident of which output helper a call
 * site happened to reach — `output()` returned and every typed refusal exited
 * 0, `outputError()` exited 1 — so `success: false` did not imply non-zero and
 * `sesh-mover hub pull || handle_failure` was silently a no-op for the entire
 * refusal class. The classes below are the stated rule; `exitCodeForResult` is
 * the single place a result is mapped onto one.
 *
 * The class list is finite and deliberately small. It is a CONTRACT: adding a
 * fifth class, or moving a result between two of them, is a breaking change for
 * anyone scripting this CLI.
 *
 * **The two hook endpoints (`hub hook-session-end`, `hub hook-session-start`)
 * are outside this scheme entirely and ALWAYS exit 0**, whatever happens. That
 * is Claude Code's hook protocol, not a style choice — see the stdout-contract
 * comments on both endpoints in `src/cli.ts` and the guards in
 * `tests/hub-hooks.test.ts`. Neither endpoint calls the output helpers, which is
 * what keeps the two schemes from meeting.
 */
export declare const EXIT_OK = 0;
/**
 * The command did not run: a bad invocation, or an unexpected failure.
 *
 * Commander's own argument validation already exits 1, and so does every
 * exception that reaches a command's `catch` (`outputError` in `src/cli.ts`).
 * Retrying the same invocation unchanged is not expected to help.
 */
export declare const EXIT_FAILED = 1;
/**
 * The command was understood and declined: nothing was done, and the JSON body
 * says why. `unlinked`, `no-such-project`, "already up to date", and the
 * pick-required listing are this class.
 *
 * A refusal is not an error — the caller is meant to read the shape and decide
 * — but it is emphatically not a success either, which is the whole reason it
 * no longer shares an exit code with one.
 */
export declare const EXIT_REFUSED = 2;
/**
 * The invocation was fine and the machine simply is not ready: an unmounted
 * share, a synced folder mid-copy, another sesh-mover operation holding the
 * project lock.
 *
 * This is exactly the set worth RETRYING, unchanged, in a moment — which is the
 * property that makes it worth a code of its own rather than folding it into
 * the refusals.
 */
export declare const EXIT_NOT_READY = 3;
export type ExitCode = typeof EXIT_OK | typeof EXIT_FAILED | typeof EXIT_REFUSED | typeof EXIT_NOT_READY;
/**
 * The single mapping from a result SHAPE to an exit code.
 *
 * Shape-driven on purpose (#76): the code is a property of what the command
 * produced, not of which helper printed it, so the two cannot drift apart again.
 *
 * Three rules, in order:
 *
 * 1. `success: true` exits 0 — **except** the pick-required listing, which is
 *    the one place a `success: true` result exits non-zero. `sesh-mover pull`
 *    with neither `--thread` nor `--latest` pulls nothing; it answers with the
 *    list of threads and waits to be told which. A caller that treats that as
 *    "the pull happened" is wrong, and `|| handle` catching it is the point of
 *    the whole change. The skill layer reads `pickRequired` from the JSON and is
 *    unaffected.
 * 2. A typed `reason` takes its class from `REASON_EXIT_CODE` above.
 * 3. Anything else that is `success: false` is a REFUSAL (2).
 *
 * Rule 3's default is 2 rather than 1 because of what reaches it: an
 * `ErrorResult` that a command RETURNED as a value, having got far enough to
 * describe the outcome — "already up to date with the source machine", "no
 * thread <id> found", the self-migration block. An exception never reaches here
 * at all; `outputError` handles those and always exits 1. So the line is "a
 * result the code composed" versus "a throw it did not".
 *
 * The imprecision that line leaves, stated rather than hidden: a few untyped
 * `ErrorResult`s are caught exceptions converted to results (`hubInit`'s mkdir
 * failure, `importSession`'s unreadable bundle) and are really class 1. Giving
 * them their right code needs a `reason` discriminator on the producing module,
 * not a smarter classifier here — matching on `error` text is forbidden
 * (`skills/session-porter/SKILL.md`) and would be exactly the fragility this
 * function exists to remove. They exit 2 today: non-zero, one class off.
 */
export declare function exitCodeForResult(result: CliResult): ExitCode;
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
    /**
     * 0-BASED, AND NOT MONOTONIC WITHIN A PHASE (#16/#29). Every emitter derives
     * it from `Array.prototype.entries()`, so a "session i of N" renderer must add
     * one — but it must NOT assume the sequence only ever climbs.
     *
     * `export-copy` is emitted from two consecutive loops over two different
     * arrays — the sessions copied whole and the sessions shipped as
     * continuations (`src/exporter.ts`) — and each numbers from 0 against its
     * OWN length. One export carrying two of each therefore emits `0/2, 1/2,
     * 0/2, 1/2`, which a naive renderer shows as the progress bar restarting
     * mid-phase. `sessionCount` is the size of the current sub-batch, never of
     * the export.
     *
     * Absent entirely on the two hub phases: `hub-push`/`hub-pull` events carry
     * `percent` only, and the per-session detail under them comes from the
     * exporter/importer events the hub verb forwards.
     *
     * THE TERMINAL-EVENT CONTRACT for those two phases (#74), because a consumer
     * that waits for one has to know when it is entitled to it. Once `hubPush`/
     * `hubPull` has acquired the project lock, it emits exactly one
     * `{percent: 0}` and, from its `finally`, exactly one `{percent: 100}` —
     * **on every outcome**, including a typed refusal, a mid-chain abort and a
     * thrown exception. `percent: 100` therefore means "the operation is over",
     * not "everything succeeded"; the returned result says which, and a throw
     * still throws. The one exit BEFORE the lock (`lock-busy`, plus a non-busy
     * throw out of the lock itself) emits nothing at all, which is the contract
     * rather than an oversight: a consumer gets either no events or a matched
     * pair, never an opening event with no close.
     */
    sessionIndex?: number;
    /** See `sessionIndex`: the current sub-batch's size, not the whole phase's. */
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
    /**
     * The `memoryDigest` of the last bundle this machine successfully delivered
     * to this peer — the whole-file counterpart of `sent`, which tracks the same
     * "already has it" question per session.
     *
     * `memory/` has no delta representation, so "incremental" for it can only mean
     * "do not re-send an identical copy". This is that ledger, and it obeys the
     * same rule as `sent`: written only once the bundle has actually reached the
     * peer, never at export time. Recording it early would make the next export
     * skip a directory the peer never received.
     *
     * Absent means "nothing known" and therefore "ship it" — which is what makes
     * the first push to a peer carry memory, and what makes a lost or reset state
     * file fail toward re-sending rather than toward silence.
     *
     * Additive and version-neutral on purpose: it lives on the peer entry rather
     * than in the `hub` block (where the workspace ledger lives) so that a plain
     * `export --incremental --to <peer>` user gains it without their state file
     * being promoted to `schemaVersion` 2 — see `setThreadId` for why that
     * promotion is not free.
     */
    memoryDigest?: string;
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
         * involved. See `hub/pull-apply-workspace.ts`'s `chooseMergeAncestor`, which intersects it
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