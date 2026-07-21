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
  sourceMachineId?: string;
  sourceMachineName?: string;
  incremental?: boolean;
  baseline?: ExportBaseline;
  projectId?: string;
  workspace?: { fileCount: number; byteSize: number; snapshotAt: string };
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
  };
}

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
  importedSessions: ImportResult["importedSessions"];
  skippedSessions: Array<{
    originalId: string;
    reason: "duplicate" | "already-received";
  }>;
  cleanedUp: boolean;
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
    exportedAt: string;
    sourcePlatform: Platform;
    sourceProjectPath: string;
    sessionCount: number;
    sessions: SessionManifest[];
    storage: StorageScope;
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
  pullNeeded: boolean; // latest is on another machine AND (no local copy or local head != latest head)
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

export interface HubUnlinkedResult {
  success: false;
  command: "push" | "pull" | "whereis";
  reason: "unlinked";
  linkCandidates: Array<{ projectId: string; name: string; gitRemotes: string[] }>;
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
  localSessionId: string; // the thread's local session after pull
  workspaceUnpacked: { path: string; fileCount: number } | null;
  warnings: string[];
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
  | WhereisResult
  | HubUnlinkedResult
  | HubLockBusyResult
  | HubPullResult
  | HubPullListResult
  | NotYetSyncedResult
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

export interface SyncState {
  projectPath: string;
  schemaVersion: 1 | 2;
  peers: Record<string, SyncStatePeer>;
  lineage: Record<string, SyncStateLineage>;
  imported: Record<string, SyncStateImported>;
  hub?: {
    hubId: string;
    threadByLocalSession: Record<string, string>;
  };
}
