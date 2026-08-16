// The two imports in this module, and deliberately type-only: the merge report
// and the carry metadata are hub-module concepts with their own documentation,
// and duplicating their shapes here to keep this file import-free would
// guarantee the copies drift apart. Type-only means nothing is imported at
// runtime, so neither creates a module cycle.
import type { WorkspaceMergeReport } from "./hub/merge.js";
import type { ApplyResult, CarryMeta } from "./hub/carry.js";

// --- Platform ---

export type Platform = "darwin" | "linux" | "wsl1" | "wsl2" | "win32";

// --- JSONL Entry Types ---

export type JsonlEntryType =
  | "user"
  | "assistant"
  | "file-history-snapshot"
  | "system"
  | "progress";

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
    trackedFileBackups: Record<
      string,
      {
        backupFileName: string;
        version: number;
        backupTime: string;
      }
    >;
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

export type JsonlEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | FileHistorySnapshotEntry
  | SystemEntry
  | ProgressEntry;

// --- Manifest ---

export type ExportLayer =
  | "jsonl"
  | "subagents"
  | "file-history"
  | "tool-results"
  | "memory"
  | "plans";

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
    basedOn?: { bundleId: string; file: string; pushedAt?: string } | null;
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

// --- Config ---

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
    path: string; // "" = not configured
    noWorkspace: boolean;
    // Push this project to the hub from the Claude Code SessionEnd hook.
    // Defaults true, but inert until a hub is configured AND the project is
    // linked — linking is the consent gate (see src/hub/hooks.ts).
    autoPush: boolean;
    // Announce, from the Claude Code SessionStart hook, that a newer copy of
    // one of this project's threads lives on another machine. Same consent
    // model as autoPush: default true, inert until hub + link.
    startupNotice: boolean;
    // Splice a pulled continuation onto the local session it continues,
    // instead of importing it as a standalone fragment. Set false (or pass
    // --no-append) to keep the Slice-1 fragment behavior.
    pullAppend: boolean;
    // What to do when a thread was extended on BOTH machines from the same
    // anchor, so neither branch continues the other. See OnDivergenceMode.
    onDivergence: OnDivergenceMode;
    // Carry uncommitted work (a `git diff HEAD` patch plus untracked files)
    // alongside the sessions, for a project with a git remote. Set false (or
    // pass --no-carry) to push sessions only. Never carries a gitignored
    // UNTRACKED file unless .sesh-mover-include names it — but a
    // gitignored file that git TRACKS has its changes carried in the patch
    // regardless, since no carry rule filters the patch (reported back as
    // `carry.trackedIgnored`).
    carryDiff: boolean;
    // Byte budget for the git-diff carry, in MB (default 50). Over it the WHOLE
    // payload is declined with a warning, never partially sent. `0` means carry
    // nothing; a negative, non-finite or non-numeric value falls back to the
    // default with a warning; anything over 1024 MB is clamped. See
    // `resolveBudgetMb` in config.ts for why each of those is what it is.
    //
    // Worth knowing before raising it: the carry rides a bundle pushed on EVERY
    // session end, unattended, and the hub keeps every bundle — so a 50 MB
    // carry on a synced folder is 50 MB of sync traffic per session end.
    carryMaxMb: number;
    // The same, for the whole-project workspace snapshot a project with no git
    // remotes pushes instead of a carry (default 50).
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

// --- CLI Results ---

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
    // Archive entries whose manifest could not be read report null for every
    // manifest-derived field rather than a fabricated value (the browsing
    // machine's platform, "", 0). `metadataAvailable` says which case it is.
    exportedAt: string | null;
    sourcePlatform: Platform | null;
    sourceProjectPath: string | null;
    sessionCount: number | null;
    sessions: SessionManifest[]; // [] when unavailable
    storage: StorageScope;
    metadataAvailable: boolean;
    metadataError?: string; // set iff metadataAvailable is false
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

// --- Hub ---

export interface HubInitResult {
  success: true;
  command: "hub-init";
  hubPath: string;
  hubId: string;
  created: boolean; // false when joining an existing hub
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
  project: { linked: boolean; projectId: string | null };
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
  lastAutoPush?: { at: string; ok: boolean; notes: string[]; noteCount: number };
  warnings: string[];
}

export interface HubPushResult {
  success: true;
  command: "push";
  projectId: string;
  bundleId: string | null; // null when nothing to push
  pushedSessions: Array<{ threadId: string; sessionId: string; type: "full" | "continuation" }>;
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
  latest: { machineId: string; machineName: string | null; lastActiveAt: string; messageCount: number };
  copies: Array<{
    machineId: string;
    machineName: string | null;
    localSessionId: string;
    lastActiveAt: string;
    messageCount: number;
    headEntryUuid: string;
  }>;
  localCopy: { localSessionId: string; headEntryUuid: string; current: boolean } | null;
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
  linkCandidates?: Array<{ projectId: string; name: string; gitRemotes: string[] }>;
  threads: WhereisThread[];
  warnings: string[];
}

/**
 * A command that needs a hub project and found this directory linked to none.
 *
 * **Not to be confused with `HubUnlinkResult`** (no "ed"), which is the SUCCESS
 * result of the `hub unlink` verb — the deliberate act of removing a link.
 * This one is a refusal: nothing happened, and `linkCandidates` is the pick
 * list for linking.
 */
export interface HubUnlinkedResult {
  success: false;
  command: "push" | "pull" | "whereis";
  reason: "unlinked";
  linkCandidates: Array<{ projectId: string; name: string; gitRemotes: string[] }>;
  suggestion: string;
}

export interface HubLockBusyResult {
  success: false;
  command: "push" | "pull" | "hub-unlink";
  reason: "lock-busy";
  holderPid: number | null;
  ageSeconds: number | null;
  /**
   * The lock error's own message (which pid, how old). Set by `hub unlink`,
   * whose refusal a HUMAN reads while deciding whether to wait or to `--force`
   * past it; push and pull leave it absent, because for them a busy lock means
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

export interface HubPullResult extends HubPullFindings {
  success: true;
  command: "pull";
  threadId: string;
  sourceMachineId: string;
  importedSessions: ImportResult["importedSessions"];
  skippedSessions: ImportResult["skippedSessions"];
  // The thread's local session after pull. null when every bundle was
  // skipped as a duplicate AND the existing local copy could not be
  // identified through peer bookkeeping or the imported-hash registry —
  // in that case no thread mapping is written (a future push re-maps it).
  localSessionId: string | null;
  workspaceUnpacked: { path: string; fileCount: number } | null;
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
  // Continuations spliced onto an existing local session rather than landing
  // as a new fragment. Absent when nothing was appended. These sessions are
  // NOT in importedSessions — no new session was created.
  appended?: Array<{ threadId: string; baseSessionId: string; entriesAppended: number }>;
  // Present when a thread was extended on BOTH sides of the same anchor.
  // Absent on an ordinary pull — its presence is the signal that the user was
  // asked (or defaulted) into a choice.
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
  projects: Array<{ projectId: string; threads: number; bundlesScanned: number }>;
  warnings: string[];
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

export type CliResult =
  | ExportResult
  | ImportResult
  | DryRunResult
  | MigrateResult
  | BrowseResult
  | ConfigureResult
  | HubInitResult
  | HubStatusResult
  | HubPushResult
  | HubPushFailedResult
  | WhereisResult
  | HubUnlinkedResult
  | HubUnlinkResult
  | HubLockBusyResult
  | HubPullResult
  | HubPullListResult
  | NotYetSyncedResult
  | HubReindexResult
  | ErrorResult;

// --- Version Adapters ---

export interface VersionAdapter {
  fromVersion: string;
  toVersion: string;
  description: string;
  applies(entry: JsonlEntry): boolean;
  transform(entry: JsonlEntry): JsonlEntry;
}

// --- Path Rewrite ---

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

// --- Progress ---

export interface ProgressEvent {
  phase:
    | "export-copy"
    | "import-rewrite"
    | "import-verify"
    | "archive"
    | "extract"
    | "hub-push"
    | "hub-pull";
  sessionId?: string;
  sessionIndex?: number;
  sessionCount?: number;
  bytesProcessed?: number;
  bytesTotal?: number;
  percent?: number;
}

// --- Discovery ---

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

// --- Incremental sync types ---

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
