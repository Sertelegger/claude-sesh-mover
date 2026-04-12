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

export interface SessionManifest {
  sessionId: string;
  slug: string;
  summary: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  gitBranch: string;
  entrypoint: string;
  integrityHash: string; // per-session sha256 hash of JSONL content
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
  importedSessions: Array<{
    originalId: string;
    newId: string;
    slug: string;
    messageCount: number;
  }>;
  warnings: string[];
  resumable: boolean;
  memoryConflicts?: Array<{
    filename: string;
    existingHash: string;
    incomingHash: string;
  }>;
}

export interface DryRunResult {
  success: true;
  command: "import";
  importedSessions: ImportResult["importedSessions"];
  warnings: string[];
  resumable: boolean;
  rewriteReport?: RewriteReport;
  versionAdaptations?: string[];
}

export interface MigrateResult {
  success: true;
  command: "migrate";
  importedSessions: ImportResult["importedSessions"];
  cleanedUp: boolean;
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

export type CliResult =
  | ExportResult
  | ImportResult
  | MigrateResult
  | BrowseResult
  | ConfigureResult
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
