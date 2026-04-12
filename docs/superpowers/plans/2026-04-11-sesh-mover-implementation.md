# sesh-mover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that exports, imports, and migrates sessions between machines, platforms, config directories, and project paths.

**Architecture:** Hybrid Node.js core (TypeScript, compiled to `dist/`) + slash command markdown files. The CLI handles all I/O-heavy, deterministic work and outputs structured JSON. Slash commands provide conversational UX by invoking the CLI via Bash and interpreting results.

**Tech Stack:** TypeScript, Node.js (>=18), vitest for testing, commander for CLI arg parsing, tar for archiving, native crypto for sha256 hashing.

**Spec:** `docs/superpowers/specs/2026-04-11-sesh-mover-design.md`

**Amendments (from adversarial review):** The following fixes have been applied inline throughout the plan:

| # | Severity | Issue | Fix Location |
|---|----------|-------|--------------|
| A1 | CRITICAL | `decodeProjectPath` is lossy for hyphenated paths | Task 3: removed `decodeProjectPath`, discovery reads `cwd` from JSONL instead |
| A2 | CRITICAL | `ToolResultEntry` imported in test but undefined | Task 2: removed from imports |
| A3 | CRITICAL | `--no-register` logic inverted (Commander.js) | Task 14: fixed to `!opts.register` |
| A4 | CRITICAL | Migrate `--dry-run` declared but unimplemented | Task 13: added `dryRun` support to `MigrateOptions` and handler |
| A5 | IMPORTANT | `require()` in ESM module | Task 14: replaced with top-level `import` |
| A6 | IMPORTANT | Windows path encoding (`\`, `:` not handled) | Task 3: `encodeProjectPath` normalizes separators and replaces `:` |
| A7 | IMPORTANT | Infinite loop in `applyMappings` | Task 7: replaced `while` loop with `replaceAll` |
| A8 | IMPORTANT | Integrity hash wrong for selective import | Task 5/11/12: per-session hashes in manifest |
| A9 | IMPORTANT | `samePlatformFamily` duplicated | Task 3: exported; Task 7: imports it |
| A10 | IMPORTANT | Shell injection in zstd `execSync` | Task 9: replaced with `execFileSync` |
| A11 | IMPORTANT | No path traversal protection in archive extraction | Task 9: added post-extraction path validation |
| A12 | IMPORTANT | `PLUGIN_ROOT` unresolvable in slash commands | Task 15: commands instruct Claude to discover plugin path |
| A13 | IMPORTANT | `DryRunResult` not in `types.ts` | Task 2: added to types, Task 12: imports it |
| A14 | IMPORTANT | `--prune` declared but unimplemented | Task 14: implemented in browse handler |
| A15 | IMPORTANT | Disk full leaves partial state | Tasks 11/12/13: wrapped in try/catch with cleanup |
| A16 | IMPORTANT | zstd fallback doesn't communicate format change | Task 14: added `actualFormat` to result |
| A17 | IMPORTANT | `plugin.json` unvalidated | Task 1: validated against real plugin structure |
| A18 | IMPORTANT | Memory merge conflict not surfaced for user choice | Task 12: added `memoryConflicts` to result |
| A19 | MINOR | WSL detection edge cases | Task 3: improved detection logic |
| A20 | MINOR | Sensitive data warning | Task 15: SKILL.md warns about sensitive data in exports |
| A21 | TEST | Missing Windows path tests | Task 3: added |
| A22 | TEST | Missing WSL-to-Windows import test | Task 17: added |
| A23 | TEST | Missing paths-with-spaces tests | Task 3: added |
| A24 | TEST | Missing archive browse test | Task 14: added |
| A25 | TEST | Missing configure --set test | Task 14: added |
| A26 | HIGH | Integrity check runs after rewrite, will always fail | Spec + Task 12: integrity verified against exported bundle BEFORE rewriting |
| A27 | HIGH | Registration before validation leaves dangling index entries | Spec + Task 12: validate written files before registering, rollback on failure |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.claude-plugin/plugin.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts` (barrel export)

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "sesh-mover",
  "version": "0.1.0",
  "description": "Claude Code plugin for migrating sessions between machines, platforms, config directories, and project paths",
  "main": "dist/cli.js",
  "bin": {
    "sesh-mover": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "keywords": ["claude-code", "session", "migration", "export", "import"],
  "license": "MIT",
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.1.0",
    "@types/node": "^22.0.0"
  },
  "dependencies": {
    "commander": "^13.0.0",
    "tar": "^7.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create .claude-plugin/plugin.json**

```json
{
  "name": "sesh-mover",
  "description": "Export, import, and migrate Claude Code sessions between machines, platforms, config directories, and project paths",
  "version": "0.1.0",
  "author": {
    "name": "sascha"
  },
  "license": "MIT",
  "keywords": ["session", "migration", "export", "import", "wsl"],
  "commands": [
    "./commands/export.md",
    "./commands/import.md",
    "./commands/migrate.md",
    "./commands/browse.md",
    "./commands/configure.md"
  ]
}
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 6: Create empty barrel export**

Create `src/index.ts`:
```typescript
// sesh-mover core library exports
```

- [ ] **Step 7: Install dependencies and verify build**

Run: `cd ~/Projects/sesh-mover && npm install`
Expected: `node_modules/` created, no errors

Run: `npm run build`
Expected: `dist/` created (mostly empty, just index.js)

- [ ] **Step 8: Verify test runner works**

Create `tests/setup.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

describe("test setup", () => {
  it("vitest is configured correctly", () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `npm test`
Expected: 1 test passes

- [ ] **Step 9: Commit**

```bash
git init
git add package.json tsconfig.json vitest.config.ts .gitignore .claude-plugin/plugin.json src/index.ts tests/setup.test.ts package-lock.json
git commit -m "chore: scaffold sesh-mover project with TypeScript, vitest, and plugin manifest"
```

---

### Task 2: Types & Interfaces

**Files:**
- Create: `src/types.ts`
- Test: `tests/types.test.ts`

- [ ] **Step 1: Write type validation tests**

Create `tests/types.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import type {
  Platform,
  JsonlEntry,
  UserMessageEntry,
  AssistantMessageEntry,
  FileHistorySnapshotEntry,
  SystemEntry,
  ProgressEntry,
  SessionManifest,
  ExportManifest,
  ExportResult,
  ImportResult,
  DryRunResult,
  BrowseResult,
  ConfigureResult,
  SeshMoverConfig,
  VersionAdapter,
} from "../src/types.js";

describe("types", () => {
  it("Platform type accepts valid platforms", () => {
    const platforms: Platform[] = ["darwin", "linux", "wsl1", "wsl2", "win32"];
    expect(platforms).toHaveLength(5);
  });

  it("ExportManifest can be constructed", () => {
    const manifest: ExportManifest = {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: "2026-04-11T14:32:00Z",
      sourcePlatform: "darwin",
      sourceProjectPath: "/Users/sascha/Projects/foo",
      sourceConfigDir: "/Users/sascha/.claude",
      sourceClaudeVersion: "2.1.81",
      sessionScope: "current",
      includedLayers: ["jsonl", "subagents", "memory"],
      sessions: [
        {
          sessionId: "abc-123",
          slug: "test-session",
          summary: "A test session",
          createdAt: "2026-04-11T12:00:00Z",
          lastActiveAt: "2026-04-11T14:00:00Z",
          messageCount: 10,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash: "sha256:abc123",
        },
      ],
    };
    expect(manifest.version).toBe(1);
    expect(manifest.sessions).toHaveLength(1);
  });

  it("SeshMoverConfig has correct shape", () => {
    const config: SeshMoverConfig = {
      export: {
        storage: "user",
        format: "dir",
        exclude: [],
        scope: "current",
        noSummary: false,
      },
      import: {
        dryRunFirst: true,
      },
      migrate: {
        scope: "current",
      },
    };
    expect(config.export.storage).toBe("user");
  });

  it("CLI result types have success field", () => {
    const exportResult: ExportResult = {
      success: true,
      command: "export",
      exportPath: "/path/to/export",
      sessions: [],
      warnings: [],
      archivePath: null,
      collision: false,
    };
    const importResult: ImportResult = {
      success: true,
      command: "import",
      importedSessions: [],
      warnings: [],
      resumable: true,
    };
    expect(exportResult.success).toBe(true);
    expect(importResult.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/types.js`

- [ ] **Step 3: Write types**

Create `src/types.ts`:
```typescript
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
  actualFormat?: ExportFormat; // set when format differs from requested (e.g., zstd fallback to gzip)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all type construction tests pass

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat: add core type definitions for JSONL entries, manifest, config, and CLI results"
```

---

### Task 3: Platform Detection

**Files:**
- Create: `src/platform.ts`
- Create: `tests/platform.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/platform.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Platform } from "../src/types.js";

// We'll test the exported functions after creating them
// For now, define the test structure

describe("platform detection", () => {
  describe("detectPlatform", () => {
    it("returns darwin on macOS", async () => {
      const { detectPlatform } = await import("../src/platform.js");
      // On the current machine (macOS), this should return darwin
      if (process.platform === "darwin") {
        expect(detectPlatform()).toBe("darwin");
      }
    });

    it("returns win32 on Windows", async () => {
      const { detectPlatform } = await import("../src/platform.js");
      if (process.platform === "win32") {
        expect(detectPlatform()).toBe("win32");
      }
    });
  });

  describe("translatePath", () => {
    let translatePath: typeof import("../src/platform.js").translatePath;

    beforeEach(async () => {
      const mod = await import("../src/platform.js");
      translatePath = mod.translatePath;
    });

    it("translates WSL home path to Windows path", () => {
      const result = translatePath(
        "/home/sascha/Projects/foo",
        "wsl2",
        "win32",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("C:\\Users\\sascha\\Projects\\foo");
    });

    it("translates WSL /mnt/d/ path to Windows D:\\ path", () => {
      const result = translatePath(
        "/mnt/d/repos/project",
        "wsl2",
        "win32",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("D:\\repos\\project");
    });

    it("translates Windows path to WSL path", () => {
      const result = translatePath(
        "C:\\Users\\sascha\\Projects\\foo",
        "win32",
        "wsl2",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("/home/sascha/Projects/foo");
    });

    it("translates Windows D:\\ path to WSL /mnt/d/ path", () => {
      const result = translatePath(
        "D:\\repos\\project",
        "win32",
        "wsl2",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("/mnt/d/repos/project");
    });

    it("handles username mapping between platforms", () => {
      const result = translatePath(
        "/home/sascha/Projects/foo",
        "wsl2",
        "win32",
        { sourceUser: "sascha", targetUser: "saschadev" }
      );
      expect(result).toBe("C:\\Users\\saschadev\\Projects\\foo");
    });

    it("translates same-platform path substitution", () => {
      const result = translatePath(
        "/Users/sascha/old-project",
        "darwin",
        "darwin",
        {
          sourceUser: "sascha",
          targetUser: "sascha",
          sourceProjectPath: "/Users/sascha/old-project",
          targetProjectPath: "/Users/sascha/Projects/new-project",
        }
      );
      expect(result).toBe("/Users/sascha/Projects/new-project");
    });

    it("handles same-platform with different usernames", () => {
      const result = translatePath(
        "/home/olduser/project",
        "linux",
        "linux",
        {
          sourceUser: "olduser",
          targetUser: "newuser",
          sourceProjectPath: "/home/olduser/project",
          targetProjectPath: "/home/newuser/project",
        }
      );
      expect(result).toBe("/home/newuser/project");
    });

    it("translates WSL /tmp/ to Windows temp path", () => {
      const result = translatePath(
        "/tmp/somefile",
        "wsl2",
        "win32",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe(
        "C:\\Users\\sascha\\AppData\\Local\\Temp\\somefile"
      );
    });

    it("returns path unchanged when no translation applies", () => {
      const result = translatePath(
        "/usr/local/bin/tool",
        "linux",
        "linux",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("/usr/local/bin/tool");
    });
  });

  describe("encodeProjectPath", () => {
    it("encodes Unix path to directory name", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      expect(encodeProjectPath("/Users/sascha/Projects/foo")).toBe(
        "-Users-sascha-Projects-foo"
      );
    });

    it("encodes root path", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      expect(encodeProjectPath("/Users/sascha")).toBe("-Users-sascha");
    });

    it("encodes Windows path with drive letter", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      expect(encodeProjectPath("C:\\Users\\sascha\\Projects\\foo")).toBe(
        "C-Users-sascha-Projects-foo"
      );
    });

    it("encodes paths with hyphens (one-way, lossy)", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      // This is intentionally lossy — hyphens in path components merge with separators
      expect(encodeProjectPath("/Users/sascha/Projects/tzun-sdk")).toBe(
        "-Users-sascha-Projects-tzun-sdk"
      );
    });
  });

  describe("path encoding is one-way", () => {
    it("no decodeProjectPath exists — encoding is lossy for hyphenated paths", async () => {
      const platform = await import("../src/platform.js");
      expect("decodeProjectPath" in platform).toBe(false);
    });
  });

  describe("translatePath with special characters", () => {
    let translatePath: typeof import("../src/platform.js").translatePath;

    beforeEach(async () => {
      const mod = await import("../src/platform.js");
      translatePath = mod.translatePath;
    });

    it("handles paths with spaces", () => {
      const result = translatePath(
        "/home/sascha/My Projects/foo bar",
        "wsl2",
        "win32",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("C:\\Users\\sascha\\My Projects\\foo bar");
    });

    it("handles Windows Program Files path", () => {
      const result = translatePath(
        "C:\\Program Files (x86)\\MyApp",
        "win32",
        "wsl2",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("/mnt/c/Program Files (x86)/MyApp");
    });
  });

  describe("resolveConfigDir", () => {
    it("uses explicit flag over env var", async () => {
      const { resolveConfigDir } = await import("../src/platform.js");
      const result = resolveConfigDir("/explicit/path", "/env/path");
      expect(result).toBe("/explicit/path");
    });

    it("uses env var when no explicit flag", async () => {
      const { resolveConfigDir } = await import("../src/platform.js");
      const result = resolveConfigDir(undefined, "/env/path");
      expect(result).toBe("/env/path");
    });

    it("falls back to ~/.claude when nothing specified", async () => {
      const { resolveConfigDir } = await import("../src/platform.js");
      const result = resolveConfigDir(undefined, undefined);
      expect(result).toMatch(/\.claude$/);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/platform.test.ts`
Expected: FAIL — cannot resolve `../src/platform.js`

- [ ] **Step 3: Implement platform.ts**

Create `src/platform.ts`:
```typescript
import { readFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Platform } from "./types.js";

export interface TranslateOptions {
  sourceUser: string;
  targetUser: string;
  sourceProjectPath?: string;
  targetProjectPath?: string;
}

export function detectPlatform(): Platform {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";

  // Linux — check for WSL
  if (process.platform === "linux") {
    try {
      if (existsSync("/proc/version")) {
        const procVersion = readFileSync("/proc/version", "utf-8");
        if (/microsoft/i.test(procVersion)) {
          // Detect WSL version
          if (/WSL2/i.test(procVersion)) return "wsl2";
          return "wsl1";
        }
      }
      if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) {
        return "wsl2"; // WSLInterop exists primarily in WSL2
      }
    } catch {
      // If we can't read proc, assume standard Linux
    }
    return "linux";
  }

  return "linux"; // fallback
}

export function translatePath(
  inputPath: string,
  sourcePlatform: Platform,
  targetPlatform: Platform,
  options: TranslateOptions
): string {
  const { sourceUser, targetUser, sourceProjectPath, targetProjectPath } =
    options;

  // Same-platform path substitution
  if (
    samePlatformFamily(sourcePlatform, targetPlatform) &&
    sourceProjectPath &&
    targetProjectPath
  ) {
    if (inputPath.startsWith(sourceProjectPath)) {
      return targetProjectPath + inputPath.slice(sourceProjectPath.length);
    }
    // Also handle username-only changes
    if (sourceUser !== targetUser) {
      return inputPath.replace(
        new RegExp(`(^|/)${escapeRegex(sourceUser)}(/|$)`),
        `$1${targetUser}$2`
      );
    }
    return inputPath;
  }

  const sourceIsWsl = sourcePlatform === "wsl1" || sourcePlatform === "wsl2";
  const targetIsWsl = targetPlatform === "wsl1" || targetPlatform === "wsl2";
  const sourceIsWin = sourcePlatform === "win32";
  const targetIsWin = targetPlatform === "win32";

  // WSL/Linux -> Windows
  if ((sourceIsWsl || sourcePlatform === "linux") && targetIsWin) {
    // /tmp/... -> C:\Users\<user>\AppData\Local\Temp\...
    if (inputPath.startsWith("/tmp/")) {
      const rest = inputPath.slice(5);
      return `C:\\Users\\${targetUser}\\AppData\\Local\\Temp\\${rest}`.replace(
        /\//g,
        "\\"
      );
    }
    // /mnt/<drive>/... -> <DRIVE>:\...
    const mntMatch = inputPath.match(/^\/mnt\/([a-zA-Z])\/(.*)/);
    if (mntMatch) {
      const drive = mntMatch[1].toUpperCase();
      const rest = mntMatch[2];
      return `${drive}:\\${rest.replace(/\//g, "\\")}`;
    }
    // /home/<user>/... -> C:\Users\<user>\...
    const homeMatch = inputPath.match(/^\/home\/([^/]+)\/(.*)/);
    if (homeMatch) {
      const rest = homeMatch[2];
      return `C:\\Users\\${targetUser}\\${rest.replace(/\//g, "\\")}`;
    }
    return inputPath;
  }

  // Windows -> WSL/Linux
  if (sourceIsWin && (targetIsWsl || targetPlatform === "linux")) {
    // Normalize backslashes
    const normalized = inputPath.replace(/\\/g, "/");
    // C:\Users\<user>\... -> /home/<user>/...
    const userMatch = normalized.match(
      /^([A-Za-z]):\/Users\/([^/]+)\/(.*)/
    );
    if (userMatch) {
      const rest = userMatch[3];
      return `/home/${targetUser}/${rest}`;
    }
    // <DRIVE>:\... -> /mnt/<drive>/...
    const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)/);
    if (driveMatch) {
      const drive = driveMatch[1].toLowerCase();
      const rest = driveMatch[2];
      return `/mnt/${drive}/${rest}`;
    }
    return inputPath;
  }

  // Same platform but different users (no project path override)
  if (sourceUser !== targetUser) {
    return inputPath.replace(
      new RegExp(`(^|[/\\\\])${escapeRegex(sourceUser)}([/\\\\]|$)`),
      `$1${targetUser}$2`
    );
  }

  return inputPath;
}

export function samePlatformFamily(a: Platform, b: Platform): boolean {
  const wslOrLinux = (p: Platform) =>
    p === "linux" || p === "wsl1" || p === "wsl2";
  if (a === b) return true;
  if (wslOrLinux(a) && wslOrLinux(b)) return true;
  return false;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function encodeProjectPath(projectPath: string): string {
  // Claude Code encodes project paths by replacing / with -
  // On Windows, normalize backslashes to forward slashes first, remove drive colon
  // "/Users/sascha/Projects/foo" -> "-Users-sascha-Projects-foo"
  // "C:\Users\sascha\Projects\foo" -> "C-Users-sascha-Projects-foo"
  let normalized = projectPath.replace(/\\/g, "/");
  // Remove colon from drive letter (C: -> C)
  normalized = normalized.replace(/^([A-Za-z]):/, "$1");
  return normalized.replace(/\//g, "-");
}

// NOTE: decodeProjectPath is intentionally NOT provided.
// The encoding is lossy — paths containing hyphens (e.g., /my-project)
// cannot be distinguished from path separators in the encoded form.
// Always read the actual project path from JSONL cwd fields or history.jsonl
// instead of trying to decode the directory name.

export function resolveConfigDir(
  explicitFlag?: string,
  envVar?: string
): string {
  if (explicitFlag) return explicitFlag;
  if (envVar) return envVar;
  const envConfigDir = process.env.CLAUDE_CONFIG_DIR;
  if (envConfigDir) return envConfigDir;
  return join(homedir(), ".claude");
}

export function getCurrentUser(): string {
  return userInfo().username;
}

export function extractUserFromPath(
  path: string,
  platform: Platform
): string | null {
  if (platform === "win32") {
    const match = path.replace(/\\/g, "/").match(/^[A-Za-z]:\/Users\/([^/]+)/);
    return match ? match[1] : null;
  }
  // Unix-like
  const homeMatch = path.match(/^\/(home|Users)\/([^/]+)/);
  return homeMatch ? homeMatch[2] : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/platform.test.ts`
Expected: PASS — all platform tests pass

- [ ] **Step 5: Commit**

```bash
git add src/platform.ts tests/platform.test.ts
git commit -m "feat: add platform detection, WSL path translation, and config dir resolution"
```

---

### Task 4: Configuration System

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/config.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-config-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getDefaultConfig", () => {
    it("returns complete default config", async () => {
      const { getDefaultConfig } = await import("../src/config.js");
      const config = getDefaultConfig();
      expect(config.export.storage).toBe("user");
      expect(config.export.format).toBe("dir");
      expect(config.export.exclude).toEqual([]);
      expect(config.export.scope).toBe("current");
      expect(config.export.noSummary).toBe(false);
      expect(config.import.dryRunFirst).toBe(true);
      expect(config.migrate.scope).toBe("current");
    });
  });

  describe("readConfig", () => {
    it("returns default when no config file exists", async () => {
      const { readConfig, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const config = readConfig(join(tempDir, "nonexistent"));
      expect(config).toEqual(getDefaultConfig());
    });

    it("reads and merges partial config file", async () => {
      const { readConfig } = await import("../src/config.js");
      const configDir = join(tempDir, ".claude-sesh-mover");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ export: { storage: "project" } })
      );
      const config = readConfig(configDir);
      expect(config.export.storage).toBe("project");
      expect(config.export.format).toBe("dir"); // default preserved
    });
  });

  describe("writeConfig", () => {
    it("writes config to file", async () => {
      const { writeConfig, readConfig, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const configDir = join(tempDir, ".claude-sesh-mover");
      mkdirSync(configDir, { recursive: true });
      const config = getDefaultConfig();
      config.export.storage = "project";
      writeConfig(configDir, config);
      const readBack = readConfig(configDir);
      expect(readBack.export.storage).toBe("project");
    });
  });

  describe("mergeConfigs", () => {
    it("project config overrides user config", async () => {
      const { mergeConfigs, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const userConfig = getDefaultConfig();
      userConfig.export.storage = "user";
      const projectConfig = getDefaultConfig();
      projectConfig.export.storage = "project";
      const merged = mergeConfigs(userConfig, projectConfig);
      expect(merged.export.storage).toBe("project");
    });

    it("CLI flags override everything", async () => {
      const { mergeConfigs, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const userConfig = getDefaultConfig();
      const projectConfig = getDefaultConfig();
      const cliOverrides = { export: { format: "zstd" as const } };
      const merged = mergeConfigs(userConfig, projectConfig, cliOverrides);
      expect(merged.export.format).toBe("zstd");
    });
  });

  describe("setConfigValue", () => {
    it("sets a nested config value by dot-path", async () => {
      const { setConfigValue, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const config = getDefaultConfig();
      const updated = setConfigValue(config, "export.storage", "project");
      expect(updated.export.storage).toBe("project");
    });

    it("throws on invalid path", async () => {
      const { setConfigValue, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const config = getDefaultConfig();
      expect(() => setConfigValue(config, "nonexistent.key", "value")).toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`

- [ ] **Step 3: Implement config.ts**

Create `src/config.ts`:
```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SeshMoverConfig } from "./types.js";

export function getDefaultConfig(): SeshMoverConfig {
  return {
    export: {
      storage: "user",
      format: "dir",
      exclude: [],
      scope: "current",
      noSummary: false,
    },
    import: {
      dryRunFirst: true,
    },
    migrate: {
      scope: "current",
    },
  };
}

export function readConfig(configDir: string): SeshMoverConfig {
  const configPath = join(configDir, "config.json");
  const defaults = getDefaultConfig();

  if (!existsSync(configPath)) {
    return defaults;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const partial = JSON.parse(raw);
    return deepMerge(defaults, partial) as SeshMoverConfig;
  } catch {
    return defaults;
  }
}

export function writeConfig(
  configDir: string,
  config: SeshMoverConfig
): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function mergeConfigs(
  userConfig: SeshMoverConfig,
  projectConfig: SeshMoverConfig,
  cliOverrides?: Partial<Record<string, unknown>>
): SeshMoverConfig {
  let merged = deepMerge(userConfig, projectConfig) as SeshMoverConfig;
  if (cliOverrides) {
    merged = deepMerge(merged, cliOverrides) as SeshMoverConfig;
  }
  return merged;
}

export function setConfigValue(
  config: SeshMoverConfig,
  dotPath: string,
  value: unknown
): SeshMoverConfig {
  const parts = dotPath.split(".");
  const result = structuredClone(config);

  let current: Record<string, unknown> = result as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
      throw new Error(`Invalid config path: ${dotPath}`);
    }
    current = current[parts[i]] as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1];
  if (!(lastKey in current)) {
    throw new Error(`Invalid config path: ${dotPath}`);
  }

  current[lastKey] = value;
  return result;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add configuration system with user/project scopes and deep merge"
```

---

### Task 5: Manifest

**Files:**
- Create: `src/manifest.ts`
- Create: `tests/manifest.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/manifest.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExportManifest } from "../src/types.js";

describe("manifest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-manifest-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeTestManifest(): ExportManifest {
    return {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: "2026-04-11T14:32:00Z",
      sourcePlatform: "darwin",
      sourceProjectPath: "/Users/sascha/Projects/foo",
      sourceConfigDir: "/Users/sascha/.claude",
      sourceClaudeVersion: "2.1.81",
      sessionScope: "current",
      includedLayers: ["jsonl", "subagents", "memory"],
      sessions: [
        {
          sessionId: "abc-123",
          slug: "test-session",
          summary: "A test session",
          createdAt: "2026-04-11T12:00:00Z",
          lastActiveAt: "2026-04-11T14:00:00Z",
          messageCount: 10,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash: "sha256:abc123",
        },
      ],
    };
  }

  describe("writeManifest / readManifest", () => {
    it("round-trips a manifest to disk", async () => {
      const { writeManifest, readManifest } = await import(
        "../src/manifest.js"
      );
      const manifest = makeTestManifest();
      writeManifest(tempDir, manifest);
      const readBack = readManifest(tempDir);
      expect(readBack).toEqual(manifest);
    });
  });

  describe("computeIntegrityHash", () => {
    it("returns consistent sha256 hash for same content", async () => {
      const { computeIntegrityHash } = await import("../src/manifest.js");
      const hash1 = computeIntegrityHash(["line1\n", "line2\n"]);
      const hash2 = computeIntegrityHash(["line1\n", "line2\n"]);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("returns different hash for different content", async () => {
      const { computeIntegrityHash } = await import("../src/manifest.js");
      const hash1 = computeIntegrityHash(["line1\n"]);
      const hash2 = computeIntegrityHash(["line2\n"]);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("verifyIntegrity", () => {
    it("returns true when hash matches", async () => {
      const { computeIntegrityHash, verifyIntegrity } = await import(
        "../src/manifest.js"
      );
      const content = ["line1\n", "line2\n"];
      const hash = computeIntegrityHash(content);
      expect(verifyIntegrity(content, hash)).toBe(true);
    });

    it("returns false when hash mismatches", async () => {
      const { verifyIntegrity } = await import("../src/manifest.js");
      expect(verifyIntegrity(["line1\n"], "sha256:wrong")).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/manifest.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement manifest.ts**

Create `src/manifest.ts`:
```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExportManifest } from "./types.js";

export function writeManifest(
  exportDir: string,
  manifest: ExportManifest
): void {
  const manifestPath = join(exportDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

export function readManifest(exportDir: string): ExportManifest {
  const manifestPath = join(exportDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json found in ${exportDir}`);
  }
  const raw = readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as ExportManifest;
}

export function computeIntegrityHash(contents: string[]): string {
  const hash = createHash("sha256");
  for (const content of contents) {
    hash.update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function verifyIntegrity(
  contents: string[],
  expectedHash: string
): boolean {
  const actual = computeIntegrityHash(contents);
  return actual === expectedHash;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/manifest.ts tests/manifest.test.ts
git commit -m "feat: add manifest read/write and sha256 integrity hashing"
```

---

### Task 6: Session Discovery

**Files:**
- Create: `src/discovery.ts`
- Create: `tests/discovery.test.ts`
- Create: `tests/fixtures/` (sample session data)

- [ ] **Step 1: Create test fixtures**

Create `tests/fixtures/create-fixtures.ts`:
```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Creates a minimal but realistic Claude session fixture tree.
 */
export function createFixtureTree(baseDir: string): {
  configDir: string;
  projectDir: string;
  sessionId: string;
} {
  const configDir = join(baseDir, ".claude");
  const projectEncoded = "-Users-testuser-Projects-testproject";
  const projectDir = join(configDir, "projects", projectEncoded);
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";

  // Create directory structure
  mkdirSync(join(projectDir, sessionId, "subagents"), { recursive: true });
  mkdirSync(join(projectDir, sessionId, "tool-results"), { recursive: true });
  mkdirSync(join(projectDir, "memory"), { recursive: true });
  mkdirSync(join(configDir, "file-history", sessionId), { recursive: true });
  mkdirSync(join(configDir, "plans"), { recursive: true });

  // Write session JSONL
  const entries = [
    {
      uuid: "entry-1",
      timestamp: "2026-04-10T12:00:00Z",
      sessionId,
      cwd: "/Users/testuser/Projects/testproject",
      version: "2.1.81",
      gitBranch: "main",
      slug: "test-session",
      userType: "external",
      entrypoint: "cli",
      type: "user",
      message: { role: "user", content: "Hello, help me build a REST API" },
    },
    {
      uuid: "entry-2",
      timestamp: "2026-04-10T12:00:05Z",
      sessionId,
      cwd: "/Users/testuser/Projects/testproject",
      version: "2.1.81",
      gitBranch: "main",
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        id: "msg_test",
        content: [{ type: "text", text: "I'll help you build a REST API." }],
      },
      parentUuid: "entry-1",
    },
    {
      uuid: "entry-3",
      timestamp: "2026-04-10T12:01:00Z",
      sessionId,
      cwd: "/Users/testuser/Projects/testproject",
      version: "2.1.81",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_test",
            type: "tool_result",
            content: "file contents at /Users/testuser/Projects/testproject/src/index.ts",
          },
        ],
      },
      toolUseResult: {
        stdout: "/Users/testuser/Projects/testproject/src/index.ts: TypeScript file",
        stderr: "",
      },
    },
  ];

  const jsonlContent = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), jsonlContent);

  // Write subagent files
  writeFileSync(
    join(projectDir, sessionId, "subagents", "agent-sub1.meta.json"),
    JSON.stringify({ agentType: "Explore", description: "Explore codebase" })
  );
  writeFileSync(
    join(projectDir, sessionId, "subagents", "agent-sub1.jsonl"),
    JSON.stringify({
      uuid: "sub-entry-1",
      timestamp: "2026-04-10T12:00:30Z",
      sessionId,
      cwd: "/Users/testuser/Projects/testproject",
      version: "2.1.81",
      type: "user",
      message: { role: "user", content: "Explore the src directory" },
      isSidechain: true,
      agentId: "sub1",
    }) + "\n"
  );

  // Write tool results
  writeFileSync(
    join(projectDir, sessionId, "tool-results", "toolu_test.txt"),
    "file contents at /Users/testuser/Projects/testproject/src/index.ts"
  );

  // Write file history
  writeFileSync(
    join(configDir, "file-history", sessionId, "abc123@v1"),
    "// original file content\n"
  );

  // Write memory
  writeFileSync(
    join(projectDir, "memory", "MEMORY.md"),
    "- [Test memory](test_memory.md) — remembering test patterns\n"
  );
  writeFileSync(
    join(projectDir, "memory", "test_memory.md"),
    "---\nname: Test memory\ndescription: Test patterns\ntype: feedback\n---\n\nUse vitest for testing.\n"
  );

  // Write plan
  writeFileSync(
    join(configDir, "plans", "test-plan.md"),
    "# Test Plan\n\n## Task 1\nDo the thing\n"
  );

  // Write history.jsonl
  writeFileSync(
    join(configDir, "history.jsonl"),
    JSON.stringify({
      display: "Hello, help me build a REST API",
      pastedContents: {},
      timestamp: 1774977600000,
      project: "/Users/testuser/Projects/testproject",
      sessionId,
    }) + "\n"
  );

  return { configDir, projectDir, sessionId };
}
```

- [ ] **Step 2: Write failing discovery tests**

Create `tests/discovery.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

describe("discovery", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-discovery-test-"));
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("discoverSessions", () => {
    it("finds sessions for a project path", async () => {
      const { discoverSessions } = await import("../src/discovery.js");
      const sessions = discoverSessions(
        configDir,
        "/Users/testuser/Projects/testproject"
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(sessionId);
      expect(sessions[0].slug).toBe("test-session");
      expect(sessions[0].messageCount).toBe(3);
      expect(sessions[0].hasSubagents).toBe(true);
      expect(sessions[0].hasToolResults).toBe(true);
      expect(sessions[0].hasFileHistory).toBe(true);
    });

    it("returns empty array for unknown project", async () => {
      const { discoverSessions } = await import("../src/discovery.js");
      const sessions = discoverSessions(configDir, "/nonexistent/path");
      expect(sessions).toHaveLength(0);
    });
  });

  describe("discoverSessionById", () => {
    it("finds a specific session by ID", async () => {
      const { discoverSessionById } = await import("../src/discovery.js");
      const session = discoverSessionById(configDir, sessionId);
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(sessionId);
    });

    it("returns null for unknown ID", async () => {
      const { discoverSessionById } = await import("../src/discovery.js");
      const session = discoverSessionById(configDir, "nonexistent-id");
      expect(session).toBeNull();
    });
  });

  describe("listAllProjects", () => {
    it("lists all project directories", async () => {
      const { listAllProjects } = await import("../src/discovery.js");
      const projects = listAllProjects(configDir);
      expect(projects).toHaveLength(1);
      expect(projects[0].projectPath).toBe(
        "/Users/testuser/Projects/testproject"
      );
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/discovery.test.ts`
Expected: FAIL — cannot resolve `../src/discovery.js`

- [ ] **Step 4: Implement discovery.ts**

Create `src/discovery.ts`:
```typescript
import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { encodeProjectPath } from "./platform.js";
import type { DiscoveredSession } from "./types.js";

export function discoverSessions(
  configDir: string,
  projectPath: string
): DiscoveredSession[] {
  const encoded = encodeProjectPath(projectPath);
  const projectDir = join(configDir, "projects", encoded);

  if (!existsSync(projectDir)) {
    return [];
  }

  const sessions: DiscoveredSession[] = [];

  const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));

  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    const jsonlPath = join(projectDir, file);
    const session = parseSessionJsonl(
      jsonlPath,
      sessionId,
      projectPath,
      encoded,
      configDir
    );
    if (session) {
      sessions.push(session);
    }
  }

  return sessions.sort(
    (a, b) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
  );
}

export function discoverSessionById(
  configDir: string,
  sessionId: string
): DiscoveredSession | null {
  const projectsDir = join(configDir, "projects");
  if (!existsSync(projectsDir)) return null;

  const projectDirs = readdirSync(projectsDir);

  for (const encoded of projectDirs) {
    const jsonlPath = join(projectsDir, encoded, `${sessionId}.jsonl`);
    if (existsSync(jsonlPath)) {
      // Read actual project path from JSONL (encoding is lossy, cannot decode)
      const projectPath = readProjectPathFromJsonl(jsonlPath) ?? encoded;
      const session = parseSessionJsonl(
        jsonlPath,
        sessionId,
        projectPath,
        encoded,
        configDir
      );
      return session;
    }
  }

  return null;
}

export function listAllProjects(
  configDir: string
): Array<{ projectPath: string; encodedDir: string; sessionCount: number }> {
  const projectsDir = join(configDir, "projects");
  if (!existsSync(projectsDir)) return [];

  const dirs = readdirSync(projectsDir);
  const projects: Array<{
    projectPath: string;
    encodedDir: string;
    sessionCount: number;
  }> = [];

  for (const encoded of dirs) {
    const dirPath = join(projectsDir, encoded);
    if (!statSync(dirPath).isDirectory()) continue;

    const jsonlFiles = readdirSync(dirPath).filter((f) =>
      f.endsWith(".jsonl")
    );
    if (jsonlFiles.length > 0) {
      // Read actual project path from first session's JSONL (lossy encoding, cannot decode)
      const firstJsonl = join(dirPath, jsonlFiles[0]);
      const projectPath = readProjectPathFromJsonl(firstJsonl) ?? encoded;
      projects.push({
        projectPath,
        encodedDir: encoded,
        sessionCount: jsonlFiles.length,
      });
    }
  }

  return projects;
}

/**
 * Read the actual project path from a JSONL file by finding the first entry with a cwd field.
 * This is necessary because the directory encoding (/ -> -) is lossy for hyphenated paths.
 */
function readProjectPathFromJsonl(jsonlPath: string): string | null {
  try {
    const raw = readFileSync(jsonlPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.cwd) return entry.cwd;
    }
    return null;
  } catch {
    return null;
  }
}

function parseSessionJsonl(
  jsonlPath: string,
  sessionId: string,
  projectPath: string,
  encodedProjectDir: string,
  configDir: string
): DiscoveredSession | null {
  try {
    const raw = readFileSync(jsonlPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    const entries = lines.map((line) => JSON.parse(line));

    const firstEntry = entries[0];
    const lastEntry = entries[entries.length - 1];

    // Check for subagents
    const sessionSubDir = join(
      configDir,
      "projects",
      encodedProjectDir,
      sessionId,
      "subagents"
    );
    const hasSubagents =
      existsSync(sessionSubDir) && readdirSync(sessionSubDir).length > 0;

    // Check for tool results
    const toolResultsDir = join(
      configDir,
      "projects",
      encodedProjectDir,
      sessionId,
      "tool-results"
    );
    const hasToolResults =
      existsSync(toolResultsDir) && readdirSync(toolResultsDir).length > 0;

    // Check for file history
    const fileHistoryDir = join(configDir, "file-history", sessionId);
    const hasFileHistory =
      existsSync(fileHistoryDir) && readdirSync(fileHistoryDir).length > 0;

    return {
      sessionId,
      projectPath,
      encodedProjectDir,
      jsonlPath,
      slug: firstEntry.slug || sessionId,
      createdAt: firstEntry.timestamp,
      lastActiveAt: lastEntry.timestamp,
      messageCount: entries.length,
      gitBranch: firstEntry.gitBranch || "unknown",
      entrypoint: firstEntry.entrypoint || "cli",
      hasSubagents,
      hasToolResults,
      hasFileHistory,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/discovery.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/discovery.ts tests/discovery.test.ts tests/fixtures/create-fixtures.ts
git commit -m "feat: add session discovery with project enumeration and session metadata parsing"
```

---

### Task 7: JSONL Rewriter

**Files:**
- Create: `src/rewriter.ts`
- Create: `tests/rewriter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/rewriter.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

describe("rewriter", () => {
  describe("buildPathMappings", () => {
    it("builds WSL-to-Windows mappings", async () => {
      const { buildPathMappings } = await import("../src/rewriter.js");
      const mappings = buildPathMappings(
        "wsl2",
        "win32",
        "/home/sascha/Projects/foo",
        "C:\\Users\\sascha\\Projects\\foo",
        "/home/sascha/.claude",
        "C:\\Users\\sascha\\.claude",
        "sascha",
        "sascha"
      );
      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.from.includes("/home/sascha"))).toBe(true);
    });
  });

  describe("rewriteEntry", () => {
    it("rewrites cwd field", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "1",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "user" as const,
        message: { role: "user" as const, content: "hello" },
      };
      const result = rewriteEntry(entry, mappings);
      expect(result.cwd).toBe("/Users/new/project");
    });

    it("rewrites tool_result content paths", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "2",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "user" as const,
        message: {
          role: "user" as const,
          content: [
            {
              tool_use_id: "toolu_1",
              type: "tool_result",
              content: "contents of /Users/old/project/src/index.ts",
            },
          ],
        },
        toolUseResult: {
          stdout: "/Users/old/project/src/index.ts: file",
          stderr: "",
        },
      };
      const result = rewriteEntry(entry, mappings);
      expect(result.toolUseResult?.stdout).toContain("/Users/new/project");
      const content = (result.message as any).content[0].content;
      expect(content).toContain("/Users/new/project");
    });

    it("does NOT rewrite user message text", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "3",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "user" as const,
        message: {
          role: "user" as const,
          content: "please read /Users/old/project/src/index.ts",
        },
      };
      const result = rewriteEntry(entry, mappings);
      expect((result.message as any).content).toBe(
        "please read /Users/old/project/src/index.ts"
      );
    });

    it("does NOT rewrite assistant thinking text", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "4",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "assistant" as const,
        message: {
          model: "claude-opus-4-6",
          id: "msg_1",
          content: [
            { type: "thinking", thinking: "Looking at /Users/old/project/src" },
            { type: "text", text: "I found the file." },
          ],
        },
      };
      const result = rewriteEntry(entry, mappings);
      const thinking = (result.message as any).content[0].thinking;
      expect(thinking).toContain("/Users/old/project");
    });

    it("rewrites file-history-snapshot backup keys", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "5",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "file-history-snapshot" as const,
        messageId: "msg-1",
        snapshot: {
          messageId: "msg-1",
          trackedFileBackups: {
            "/Users/old/project/src/index.ts": {
              backupFileName: "abc@v1",
              version: 1,
              backupTime: "2026-04-11T00:00:00Z",
            },
          },
          timestamp: "2026-04-11T00:00:00Z",
        },
      };
      const result = rewriteEntry(entry, mappings);
      const keys = Object.keys((result as any).snapshot.trackedFileBackups);
      expect(keys[0]).toBe("/Users/new/project/src/index.ts");
    });

    it("rewrites sessionId when newSessionId provided", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "6",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "old-session-id",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "user" as const,
        message: { role: "user" as const, content: "hello" },
      };
      const result = rewriteEntry(entry, mappings, "new-session-id");
      expect(result.sessionId).toBe("new-session-id");
    });
  });

  describe("rewriteJsonl", () => {
    it("rewrites all entries in a JSONL string", async () => {
      const { rewriteJsonl, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const jsonl = [
        JSON.stringify({
          uuid: "1",
          timestamp: "2026-04-11T00:00:00Z",
          sessionId: "test",
          cwd: "/Users/old/project",
          version: "2.1.81",
          type: "user",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          uuid: "2",
          timestamp: "2026-04-11T00:01:00Z",
          sessionId: "test",
          cwd: "/Users/old/project",
          version: "2.1.81",
          type: "assistant",
          message: { model: "test", id: "1", content: [] },
        }),
      ].join("\n");

      const { rewritten, report } = rewriteJsonl(
        jsonl,
        mappings,
        "new-session"
      );
      const lines = rewritten.trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first.cwd).toBe("/Users/new/project");
      expect(first.sessionId).toBe("new-session");
      expect(report.entriesRewritten).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/rewriter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement rewriter.ts**

Create `src/rewriter.ts`:
```typescript
import type { PathMapping, RewriteReport } from "./types.js";
import type { Platform } from "./types.js";
import { translatePath, samePlatformFamily, type TranslateOptions } from "./platform.js";

export function buildPathMappings(
  sourcePlatform: Platform,
  targetPlatform: Platform,
  sourceProjectPath: string,
  targetProjectPath: string,
  sourceConfigDir: string,
  targetConfigDir: string,
  sourceUser: string,
  targetUser: string
): PathMapping[] {
  const mappings: PathMapping[] = [];

  // Project path mapping (most specific first)
  if (sourceProjectPath !== targetProjectPath) {
    mappings.push({
      from: sourceProjectPath,
      to: targetProjectPath,
      description: `Project path: ${sourceProjectPath} -> ${targetProjectPath}`,
    });
  }

  // Config dir mapping
  if (sourceConfigDir !== targetConfigDir) {
    mappings.push({
      from: sourceConfigDir,
      to: targetConfigDir,
      description: `Config dir: ${sourceConfigDir} -> ${targetConfigDir}`,
    });
  }

  // Cross-platform home dir mapping
  const translateOpts: TranslateOptions = {
    sourceUser,
    targetUser,
    sourceProjectPath,
    targetProjectPath,
  };

  // If cross-platform, add the home directory mapping
  if (!samePlatformFamily(sourcePlatform, targetPlatform)) {
    const sourceHome = getHomePath(sourcePlatform, sourceUser);
    const targetHome = getHomePath(targetPlatform, targetUser);
    if (sourceHome !== targetHome) {
      mappings.push({
        from: sourceHome,
        to: targetHome,
        description: `Home dir: ${sourceHome} -> ${targetHome}`,
      });
    }
  } else if (sourceUser !== targetUser) {
    // Same platform, different user
    const sourceHome = getHomePath(sourcePlatform, sourceUser);
    const targetHome = getHomePath(targetPlatform, targetUser);
    if (sourceHome !== targetHome) {
      mappings.push({
        from: sourceHome,
        to: targetHome,
        description: `User home: ${sourceHome} -> ${targetHome}`,
      });
    }
  }

  return mappings;
}

function getHomePath(platform: Platform, user: string): string {
  if (platform === "win32") return `C:\\Users\\${user}`;
  if (platform === "darwin") return `/Users/${user}`;
  return `/home/${user}`;
}

export function rewriteEntry(
  entry: Record<string, unknown>,
  mappings: PathMapping[],
  newSessionId?: string
): Record<string, unknown> {
  const result = structuredClone(entry);

  // Rewrite sessionId
  if (newSessionId) {
    result.sessionId = newSessionId;
  }

  // Rewrite cwd
  if (typeof result.cwd === "string") {
    result.cwd = applyMappings(result.cwd as string, mappings);
  }

  // Rewrite tool result content and toolUseResult
  if (result.type === "user" && result.message) {
    const msg = result.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.map((item: Record<string, unknown>) => {
        if (item.type === "tool_result" && typeof item.content === "string") {
          return { ...item, content: applyMappings(item.content, mappings) };
        }
        return item;
      });
    }
    // Do NOT rewrite plain string user message content

    // Rewrite toolUseResult stdout/stderr
    if (result.toolUseResult) {
      const tr = result.toolUseResult as Record<string, unknown>;
      if (typeof tr.stdout === "string") {
        tr.stdout = applyMappings(tr.stdout as string, mappings);
      }
      if (typeof tr.stderr === "string") {
        tr.stderr = applyMappings(tr.stderr as string, mappings);
      }
    }
  }

  // Rewrite file-history-snapshot trackedFileBackups keys
  if (result.type === "file-history-snapshot" && result.snapshot) {
    const snapshot = result.snapshot as Record<string, unknown>;
    if (snapshot.trackedFileBackups) {
      const backups = snapshot.trackedFileBackups as Record<string, unknown>;
      const newBackups: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(backups)) {
        const newKey = applyMappings(key, mappings);
        newBackups[newKey] = value;
      }
      snapshot.trackedFileBackups = newBackups;
    }
  }

  return result;
}

export function rewriteJsonl(
  jsonlContent: string,
  mappings: PathMapping[],
  newSessionId?: string
): { rewritten: string; report: RewriteReport } {
  const lines = jsonlContent.trim().split("\n").filter(Boolean);
  let entriesRewritten = 0;
  let fieldsRewritten = 0;
  const warnings: string[] = [];

  const rewrittenLines = lines.map((line) => {
    try {
      const entry = JSON.parse(line);
      const original = JSON.stringify(entry);
      const rewritten = rewriteEntry(entry, mappings, newSessionId);
      const rewrittenStr = JSON.stringify(rewritten);
      if (rewrittenStr !== original) {
        entriesRewritten++;
        // Count changed top-level fields
        for (const key of Object.keys(entry)) {
          if (JSON.stringify(entry[key]) !== JSON.stringify((rewritten as any)[key])) {
            fieldsRewritten++;
          }
        }
      }
      return rewrittenStr;
    } catch (e) {
      warnings.push(`Failed to parse JSONL line: ${(e as Error).message}`);
      return line; // preserve unparseable lines
    }
  });

  return {
    rewritten: rewrittenLines.join("\n") + "\n",
    report: {
      mappings,
      entriesRewritten,
      fieldsRewritten,
      warnings,
    },
  };
}

function applyMappings(input: string, mappings: PathMapping[]): string {
  let result = input;
  for (const mapping of mappings) {
    // Use replaceAll to avoid infinite loop when mapping.to contains mapping.from
    result = result.replaceAll(mapping.from, mapping.to);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/rewriter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rewriter.ts tests/rewriter.test.ts
git commit -m "feat: add JSONL rewriter with path translation, field targeting, and dry-run reporting"
```

---

### Task 8: Summary Extraction

**Files:**
- Create: `src/summary.ts`
- Create: `tests/summary.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/summary.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

describe("summary", () => {
  describe("extractSummary", () => {
    it("uses slug when descriptive", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const result = extractSummary("fix-auth-middleware", [
        { type: "user", message: { role: "user", content: "Fix the bug" } },
      ]);
      expect(result).toBe("fix-auth-middleware");
    });

    it("falls back to first user message when slug is generic", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const result = extractSummary("new-session", [
        {
          type: "user",
          message: {
            role: "user",
            content: "Help me build a REST API with Express and TypeScript",
          },
        },
      ]);
      expect(result).toBe(
        "Help me build a REST API with Express and TypeScript"
      );
    });

    it("truncates long first messages to ~100 chars", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const longMsg = "A".repeat(200);
      const result = extractSummary("new-session", [
        { type: "user", message: { role: "user", content: longMsg } },
      ]);
      expect(result.length).toBeLessThanOrEqual(103); // 100 + "..."
    });

    it("skips UUID-like slugs", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const result = extractSummary(
        "550e8400-e29b-41d4-a716-446655440000",
        [
          {
            type: "user",
            message: { role: "user", content: "Hello world" },
          },
        ]
      );
      expect(result).toBe("Hello world");
    });

    it("falls back to assistant response when user message is not a string", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const result = extractSummary("new-session", [
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", content: "..." }],
          },
        },
        {
          type: "assistant",
          message: {
            model: "claude",
            id: "1",
            content: [
              {
                type: "text",
                text: "I'll help you set up the authentication system.",
              },
            ],
          },
        },
      ]);
      expect(result).toBe(
        "I'll help you set up the authentication system."
      );
    });

    it("returns generic fallback when nothing works", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const result = extractSummary("new-session", []);
      expect(result).toBe("(no summary available)");
    });
  });

  describe("extractFirstExchanges", () => {
    it("extracts first N user/assistant exchanges", async () => {
      const { extractFirstExchanges } = await import("../src/summary.js");
      const entries = [
        {
          type: "user",
          message: { role: "user", content: "Build me a CLI" },
        },
        {
          type: "assistant",
          message: {
            model: "claude",
            id: "1",
            content: [{ type: "text", text: "I'll create a CLI tool." }],
          },
        },
        {
          type: "user",
          message: { role: "user", content: "Add tests" },
        },
      ];
      const exchanges = extractFirstExchanges(entries, 2);
      expect(exchanges).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/summary.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement summary.ts**

Create `src/summary.ts`:
```typescript
const GENERIC_SLUGS = new Set(["new-session", "untitled", ""]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUMMARY_LENGTH = 100;

export function extractSummary(
  slug: string,
  entries: Array<Record<string, unknown>>
): string {
  // Try slug first
  if (slug && !GENERIC_SLUGS.has(slug) && !UUID_PATTERN.test(slug)) {
    return slug;
  }

  // Try first user message (string content)
  for (const entry of entries) {
    if (entry.type === "user") {
      const msg = entry.message as Record<string, unknown>;
      if (typeof msg.content === "string" && msg.content.trim()) {
        return truncate(msg.content.trim());
      }
    }
  }

  // Try first assistant text response
  for (const entry of entries) {
    if (entry.type === "assistant") {
      const msg = entry.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            return truncate(b.text.trim());
          }
        }
      }
    }
  }

  return "(no summary available)";
}

export function extractFirstExchanges(
  entries: Array<Record<string, unknown>>,
  maxExchanges: number
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  let exchangeCount = 0;

  for (const entry of entries) {
    if (entry.type === "user" || entry.type === "assistant") {
      result.push(entry);
      if (entry.type === "assistant") {
        exchangeCount++;
        if (exchangeCount >= maxExchanges) break;
      }
    }
  }

  return result;
}

function truncate(text: string): string {
  if (text.length <= MAX_SUMMARY_LENGTH) return text;
  return text.slice(0, MAX_SUMMARY_LENGTH) + "...";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/summary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/summary.ts tests/summary.test.ts
git commit -m "feat: add session summary extraction with slug, first-message, and assistant fallbacks"
```

---

### Task 9: Archiver

**Files:**
- Create: `src/archiver.ts`
- Create: `tests/archiver.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/archiver.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("archiver", () => {
  let tempDir: string;
  let sourceDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-archiver-test-"));
    sourceDir = join(tempDir, "test-export");
    mkdirSync(join(sourceDir, "sessions"), { recursive: true });
    writeFileSync(
      join(sourceDir, "manifest.json"),
      '{"version":1,"plugin":"sesh-mover"}'
    );
    writeFileSync(
      join(sourceDir, "sessions", "test.jsonl"),
      '{"type":"user"}\n'
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createArchive (tar.gz)", () => {
    it("creates a .tar.gz archive of the export directory", async () => {
      const { createArchive } = await import("../src/archiver.js");
      const archivePath = join(tempDir, "test-export.tar.gz");
      await createArchive(sourceDir, archivePath, "gzip");
      expect(existsSync(archivePath)).toBe(true);
    });
  });

  describe("extractArchive (tar.gz)", () => {
    it("round-trips a directory through tar.gz", async () => {
      const { createArchive, extractArchive } = await import(
        "../src/archiver.js"
      );
      const archivePath = join(tempDir, "test-export.tar.gz");
      await createArchive(sourceDir, archivePath, "gzip");

      const extractDir = join(tempDir, "extracted");
      mkdirSync(extractDir);
      await extractArchive(archivePath, extractDir);
      expect(existsSync(join(extractDir, "manifest.json"))).toBe(true);
      expect(existsSync(join(extractDir, "sessions", "test.jsonl"))).toBe(
        true
      );
    });
  });

  describe("detectArchiveFormat", () => {
    it("detects tar.gz", async () => {
      const { detectArchiveFormat } = await import("../src/archiver.js");
      expect(detectArchiveFormat("export.tar.gz")).toBe("gzip");
    });

    it("detects tar.zst", async () => {
      const { detectArchiveFormat } = await import("../src/archiver.js");
      expect(detectArchiveFormat("export.tar.zst")).toBe("zstd");
    });

    it("returns null for directories", async () => {
      const { detectArchiveFormat } = await import("../src/archiver.js");
      expect(detectArchiveFormat("export-dir")).toBeNull();
    });
  });

  describe("isZstdAvailable", () => {
    it("returns a boolean", async () => {
      const { isZstdAvailable } = await import("../src/archiver.js");
      const result = await isZstdAvailable();
      expect(typeof result).toBe("boolean");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/archiver.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement archiver.ts**

Create `src/archiver.ts`:
```typescript
import { createWriteStream, createReadStream, readdirSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { execFileSync, execSync } from "node:child_process";
import { basename, dirname, resolve, relative } from "node:path";
import * as tar from "tar";

export type CompressionType = "gzip" | "zstd";

export async function createArchive(
  sourceDir: string,
  archivePath: string,
  compression: CompressionType
): Promise<void> {
  if (compression === "zstd") {
    await createZstdArchive(sourceDir, archivePath);
  } else {
    await tar.create(
      {
        gzip: true,
        file: archivePath,
        cwd: dirname(sourceDir),
      },
      [basename(sourceDir)]
    );
  }
}

export async function extractArchive(
  archivePath: string,
  targetDir: string
): Promise<void> {
  const format = detectArchiveFormat(archivePath);
  if (format === "zstd") {
    await extractZstdArchive(archivePath, targetDir);
  } else {
    await tar.extract({
      file: archivePath,
      cwd: targetDir,
      strip: 1, // strip the top-level directory
    });
  }

  // Path traversal protection: verify all extracted files are within targetDir
  validateExtractedPaths(targetDir);
}

function validateExtractedPaths(dir: string): void {
  const resolvedDir = resolve(dir);
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(
      entry.parentPath ?? (entry as any).path ?? dir,
      entry.name
    );
    if (!fullPath.startsWith(resolvedDir)) {
      throw new Error(
        `Path traversal detected: ${fullPath} is outside ${resolvedDir}`
      );
    }
  }
}

export function detectArchiveFormat(
  filePath: string
): CompressionType | null {
  if (filePath.endsWith(".tar.gz") || filePath.endsWith(".tgz")) {
    return "gzip";
  }
  if (filePath.endsWith(".tar.zst") || filePath.endsWith(".tar.zstd")) {
    return "zstd";
  }
  return null;
}

export async function isZstdAvailable(): Promise<boolean> {
  try {
    execSync("zstd --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function createZstdArchive(
  sourceDir: string,
  archivePath: string
): Promise<void> {
  // Create tar first, then pipe through zstd
  const tarPath = archivePath.replace(/\.zst$/, "");
  await tar.create(
    {
      file: tarPath,
      cwd: dirname(sourceDir),
    },
    [basename(sourceDir)]
  );
  // Use execFileSync to avoid shell injection
  execFileSync("zstd", ["-f", tarPath, "-o", archivePath], { stdio: "ignore" });
  unlinkSync(tarPath);
}

async function extractZstdArchive(
  archivePath: string,
  targetDir: string
): Promise<void> {
  const tarPath = archivePath.replace(/\.zst$/, ".tar");
  // Use execFileSync to avoid shell injection
  execFileSync("zstd", ["-d", archivePath, "-o", tarPath], { stdio: "ignore" });
  await tar.extract({
    file: tarPath,
    cwd: targetDir,
    strip: 1,
  });
  unlinkSync(tarPath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/archiver.test.ts`
Expected: PASS (zstd test may skip if not installed — that's fine)

- [ ] **Step 5: Commit**

```bash
git add src/archiver.ts tests/archiver.test.ts
git commit -m "feat: add tar.gz and tar.zst archive creation and extraction"
```

---

### Task 10: Version Adapters

**Files:**
- Create: `src/version-adapters.ts`
- Create: `tests/version-adapters.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/version-adapters.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

describe("version-adapters", () => {
  describe("getApplicableAdapters", () => {
    it("returns empty array for same version", async () => {
      const { getApplicableAdapters } = await import(
        "../src/version-adapters.js"
      );
      const adapters = getApplicableAdapters("2.1.81", "2.1.81");
      expect(adapters).toHaveLength(0);
    });

    it("returns adapters between source and target versions", async () => {
      const { getApplicableAdapters } = await import(
        "../src/version-adapters.js"
      );
      // Even if no real adapters exist yet, the function should work
      const adapters = getApplicableAdapters("1.0.0", "99.0.0");
      expect(Array.isArray(adapters)).toBe(true);
    });
  });

  describe("applyAdapters", () => {
    it("passes through entries when no adapters apply", async () => {
      const { applyAdapters } = await import("../src/version-adapters.js");
      const entry = {
        uuid: "1",
        type: "user",
        message: { role: "user", content: "hello" },
      };
      const { entry: result, applied } = applyAdapters(entry, []);
      expect(result).toEqual(entry);
      expect(applied).toHaveLength(0);
    });

    it("preserves unknown entry types", async () => {
      const { applyAdapters } = await import("../src/version-adapters.js");
      const entry = {
        uuid: "1",
        type: "future-unknown-type",
        data: { something: "new" },
      };
      const { entry: result } = applyAdapters(entry, []);
      expect(result).toEqual(entry);
    });
  });

  describe("compareVersions", () => {
    it("returns 0 for equal versions", async () => {
      const { compareVersions } = await import("../src/version-adapters.js");
      expect(compareVersions("2.1.81", "2.1.81")).toBe(0);
    });

    it("returns negative when first is older", async () => {
      const { compareVersions } = await import("../src/version-adapters.js");
      expect(compareVersions("2.0.0", "2.1.0")).toBeLessThan(0);
    });

    it("returns positive when first is newer", async () => {
      const { compareVersions } = await import("../src/version-adapters.js");
      expect(compareVersions("3.0.0", "2.1.81")).toBeGreaterThan(0);
    });
  });

  describe("classifyVersionDifference", () => {
    it("returns same for identical versions", async () => {
      const { classifyVersionDifference } = await import(
        "../src/version-adapters.js"
      );
      expect(classifyVersionDifference("2.1.81", "2.1.81")).toBe("same");
    });

    it("returns source-newer when export is from newer version", async () => {
      const { classifyVersionDifference } = await import(
        "../src/version-adapters.js"
      );
      expect(classifyVersionDifference("3.0.0", "2.1.81")).toBe(
        "source-newer"
      );
    });

    it("returns target-newer when target is newer", async () => {
      const { classifyVersionDifference } = await import(
        "../src/version-adapters.js"
      );
      expect(classifyVersionDifference("2.0.0", "2.1.81")).toBe(
        "target-newer"
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/version-adapters.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement version-adapters.ts**

Create `src/version-adapters.ts`:
```typescript
import type { VersionAdapter } from "./types.js";

/**
 * Registry of version adapters. Add new adapters here as Claude Code
 * evolves its session format. Keep them ordered by fromVersion.
 */
const ADAPTER_REGISTRY: VersionAdapter[] = [
  // No adapters yet — this is the initial release.
  // Example adapter for future use:
  // {
  //   fromVersion: "2.1.0",
  //   toVersion: "2.2.0",
  //   description: "Rename thinkingMetadata to thinkingMeta",
  //   applies(entry) {
  //     return entry.type === "assistant" && "thinkingMetadata" in entry;
  //   },
  //   transform(entry) {
  //     const { thinkingMetadata, ...rest } = entry as any;
  //     return { ...rest, thinkingMeta: thinkingMetadata };
  //   },
  // },
];

export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

export function classifyVersionDifference(
  sourceVersion: string,
  targetVersion: string
): "same" | "source-newer" | "target-newer" {
  const cmp = compareVersions(sourceVersion, targetVersion);
  if (cmp === 0) return "same";
  if (cmp > 0) return "source-newer";
  return "target-newer";
}

export function getApplicableAdapters(
  sourceVersion: string,
  targetVersion: string
): VersionAdapter[] {
  if (compareVersions(sourceVersion, targetVersion) >= 0) {
    // Source is same or newer — no upgrade adapters needed
    return [];
  }

  // Source is older — find adapters between source and target
  return ADAPTER_REGISTRY.filter(
    (adapter) =>
      compareVersions(adapter.fromVersion, sourceVersion) >= 0 &&
      compareVersions(adapter.toVersion, targetVersion) <= 0
  );
}

export function applyAdapters(
  entry: Record<string, unknown>,
  adapters: VersionAdapter[]
): { entry: Record<string, unknown>; applied: string[] } {
  let current = entry;
  const applied: string[] = [];

  for (const adapter of adapters) {
    try {
      if (adapter.applies(current as any)) {
        current = adapter.transform(current as any) as Record<string, unknown>;
        applied.push(adapter.description);
      }
    } catch {
      // Best-effort: skip adapter if it fails
    }
  }

  return { entry: current, applied };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/version-adapters.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/version-adapters.ts tests/version-adapters.test.ts
git commit -m "feat: add version adapter chain with semver comparison and best-effort transforms"
```

---

### Task 11: Exporter

**Files:**
- Create: `src/exporter.ts`
- Create: `tests/exporter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/exporter.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

describe("exporter", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-exporter-test-"));
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("exportSession", () => {
    it("exports a single session with all layers", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-output");
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "test-export",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessions).toHaveLength(1);

      // Verify exported files
      const exportPath = result.exportPath;
      expect(existsSync(join(exportPath, "manifest.json"))).toBe(true);
      expect(existsSync(join(exportPath, "sessions", `${sessionId}.jsonl`))).toBe(true);
      expect(existsSync(join(exportPath, "memory", "MEMORY.md"))).toBe(true);
      expect(existsSync(join(exportPath, "memory", "test_memory.md"))).toBe(true);

      // Verify manifest
      const manifest = JSON.parse(
        readFileSync(join(exportPath, "manifest.json"), "utf-8")
      );
      expect(manifest.version).toBe(1);
      expect(manifest.plugin).toBe("sesh-mover");
      expect(manifest.sessions[0].sessionId).toBe(sessionId);
      expect(manifest.sessions[0].integrityHash).toMatch(/^sha256:/);
    });

    it("respects layer exclusions", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-no-history");
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "no-history",
        excludeLayers: ["file-history", "plans"],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        existsSync(join(result.exportPath, "file-history"))
      ).toBe(false);
      expect(existsSync(join(result.exportPath, "plans"))).toBe(false);
      expect(
        existsSync(join(result.exportPath, "sessions", `${sessionId}.jsonl`))
      ).toBe(true);
    });

    it("detects name collision", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-collision");

      // First export
      await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "same-name",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      // Second export with same name
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "same-name",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        collisionCheck: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.collision).toBe(true);
    });
  });

  describe("exportAllSessions", () => {
    it("exports all sessions for a project", async () => {
      const { exportAllSessions } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-all");
      const result = await exportAllSessions({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "all-sessions",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/exporter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement exporter.ts**

Create `src/exporter.ts`:
```typescript
import {
  mkdirSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import { writeManifest, computeIntegrityHash } from "./manifest.js";
import { discoverSessions } from "./discovery.js";
import { detectPlatform, encodeProjectPath } from "./platform.js";
import { extractSummary } from "./summary.js";
import type {
  ExportManifest,
  ExportLayer,
  ExportResult,
  ErrorResult,
  SessionManifest,
} from "./types.js";

export interface ExportOptions {
  configDir: string;
  projectPath: string;
  sessionId?: string;
  outputDir: string;
  name: string;
  excludeLayers: ExportLayer[];
  claudeVersion: string;
  collisionCheck?: boolean;
  summaryOverrides?: Record<string, string>; // sessionId -> summary
}

export async function exportSession(
  options: ExportOptions
): Promise<ExportResult | ErrorResult> {
  const {
    configDir,
    projectPath,
    sessionId,
    outputDir,
    name,
    excludeLayers,
    claudeVersion,
    collisionCheck,
    summaryOverrides,
  } = options;

  const exportPath = join(outputDir, name);

  // Collision check
  if (collisionCheck && existsSync(exportPath)) {
    return {
      success: true,
      command: "export",
      exportPath,
      sessions: [],
      warnings: [],
      archivePath: null,
      collision: true,
      existingPath: exportPath,
    };
  }

  // Find the session
  const sessions = discoverSessions(configDir, projectPath);
  const target = sessionId
    ? sessions.find((s) => s.sessionId === sessionId)
    : sessions[0];

  if (!target) {
    return {
      success: false,
      command: "export",
      error: sessionId
        ? `Session ${sessionId} not found`
        : "No sessions found for this project",
    };
  }

  return exportSessions(
    [target],
    configDir,
    projectPath,
    exportPath,
    excludeLayers,
    claudeVersion,
    "current",
    summaryOverrides
  );
}

export async function exportAllSessions(
  options: Omit<ExportOptions, "sessionId">
): Promise<ExportResult | ErrorResult> {
  const {
    configDir,
    projectPath,
    outputDir,
    name,
    excludeLayers,
    claudeVersion,
    summaryOverrides,
  } = options;

  const sessions = discoverSessions(configDir, projectPath);
  if (sessions.length === 0) {
    return {
      success: false,
      command: "export",
      error: "No sessions found for this project",
    };
  }

  const exportPath = join(outputDir, name);
  return exportSessions(
    sessions,
    configDir,
    projectPath,
    exportPath,
    excludeLayers,
    claudeVersion,
    "all",
    summaryOverrides
  );
}

async function exportSessions(
  sessions: Array<{
    sessionId: string;
    slug: string;
    jsonlPath: string;
    createdAt: string;
    lastActiveAt: string;
    messageCount: number;
    gitBranch: string;
    entrypoint: string;
    encodedProjectDir: string;
  }>,
  configDir: string,
  projectPath: string,
  exportPath: string,
  excludeLayers: ExportLayer[],
  claudeVersion: string,
  scope: "current" | "all",
  summaryOverrides?: Record<string, string>
): Promise<ExportResult | ErrorResult> {
  const includedLayers = getAllLayers().filter(
    (l) => !excludeLayers.includes(l)
  );
  const warnings: string[] = [];

  // Create export directory structure
  mkdirSync(join(exportPath, "sessions"), { recursive: true });

  const sessionManifests: SessionManifest[] = [];

  for (const session of sessions) {
    // Copy JSONL
    const jsonlContent = readFileSync(session.jsonlPath, "utf-8");

    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(exportPath, "sessions", `${session.sessionId}.jsonl`),
      jsonlContent
    );

    // Copy subagents
    if (includedLayers.includes("subagents")) {
      const subagentsDir = join(
        configDir,
        "projects",
        session.encodedProjectDir,
        session.sessionId,
        "subagents"
      );
      if (existsSync(subagentsDir)) {
        const targetSubDir = join(
          exportPath,
          "sessions",
          session.sessionId,
          "subagents"
        );
        mkdirSync(targetSubDir, { recursive: true });
        for (const file of readdirSync(subagentsDir)) {
          copyFileSync(join(subagentsDir, file), join(targetSubDir, file));
        }
      }
    }

    // Copy tool results
    if (includedLayers.includes("tool-results")) {
      const toolResultsDir = join(
        configDir,
        "projects",
        session.encodedProjectDir,
        session.sessionId,
        "tool-results"
      );
      if (existsSync(toolResultsDir)) {
        const targetTrDir = join(
          exportPath,
          "sessions",
          session.sessionId,
          "tool-results"
        );
        mkdirSync(targetTrDir, { recursive: true });
        for (const file of readdirSync(toolResultsDir)) {
          copyFileSync(join(toolResultsDir, file), join(targetTrDir, file));
        }
      }
    }

    // Copy file history
    if (includedLayers.includes("file-history")) {
      const fileHistoryDir = join(
        configDir,
        "file-history",
        session.sessionId
      );
      if (existsSync(fileHistoryDir)) {
        const targetFhDir = join(
          exportPath,
          "file-history",
          session.sessionId
        );
        mkdirSync(targetFhDir, { recursive: true });
        for (const file of readdirSync(fileHistoryDir)) {
          copyFileSync(join(fileHistoryDir, file), join(targetFhDir, file));
        }
      }
    }

    // Generate summary
    const entries = jsonlContent
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const summary =
      summaryOverrides?.[session.sessionId] ??
      extractSummary(session.slug, entries);

    // Per-session integrity hash
    const sessionHash = computeIntegrityHash([jsonlContent]);

    sessionManifests.push({
      sessionId: session.sessionId,
      slug: session.slug,
      summary,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      messageCount: session.messageCount,
      gitBranch: session.gitBranch,
      entrypoint: session.entrypoint,
      integrityHash: sessionHash,
    });
  }

  // Copy memory (shared across sessions in a project)
  if (includedLayers.includes("memory")) {
    const encoded = sessions[0].encodedProjectDir;
    const memoryDir = join(configDir, "projects", encoded, "memory");
    if (existsSync(memoryDir)) {
      const targetMemDir = join(exportPath, "memory");
      mkdirSync(targetMemDir, { recursive: true });
      for (const file of readdirSync(memoryDir)) {
        copyFileSync(join(memoryDir, file), join(targetMemDir, file));
      }
    }
  }

  // Copy plans
  if (includedLayers.includes("plans")) {
    const plansDir = join(configDir, "plans");
    if (existsSync(plansDir)) {
      const planFiles = readdirSync(plansDir).filter((f) =>
        f.endsWith(".md")
      );
      if (planFiles.length > 0) {
        const targetPlansDir = join(exportPath, "plans");
        mkdirSync(targetPlansDir, { recursive: true });
        for (const file of planFiles) {
          copyFileSync(join(plansDir, file), join(targetPlansDir, file));
        }
      }
    }
  }

  // Write manifest (per-session integrity hashes are already in sessionManifests)
  const manifest: ExportManifest = {
    version: 1,
    plugin: "sesh-mover",
    exportedAt: new Date().toISOString(),
    sourcePlatform: detectPlatform(),
    sourceProjectPath: projectPath,
    sourceConfigDir: configDir,
    sourceClaudeVersion: claudeVersion,
    sessionScope: scope,
    includedLayers,
    sessions: sessionManifests,
  };

  writeManifest(exportPath, manifest);

  // Add warnings for excluded layers
  for (const layer of excludeLayers) {
    warnings.push(`${layer} excluded by user request`);
  }

  return {
    success: true,
    command: "export",
    exportPath,
    sessions: sessionManifests.map((s) => ({
      originalId: s.sessionId,
      slug: s.slug,
      summary: s.summary,
      messageCount: s.messageCount,
      exportedLayers: includedLayers,
    })),
    warnings,
    archivePath: null,
    collision: false,
  };
}

function getAllLayers(): ExportLayer[] {
  return [
    "jsonl",
    "subagents",
    "file-history",
    "tool-results",
    "memory",
    "plans",
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/exporter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/exporter.ts tests/exporter.test.ts
git commit -m "feat: add session exporter with layer selection, collision detection, and summary generation"
```

---

### Task 12: Importer

**Files:**
- Create: `src/importer.ts`
- Create: `tests/importer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/importer.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

describe("importer", () => {
  let tempDir: string;
  let sourceConfigDir: string;
  let targetConfigDir: string;
  let sessionId: string;
  let exportPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-importer-test-"));

    // Create source fixture and export it
    const fixture = createFixtureTree(tempDir);
    sourceConfigDir = fixture.configDir;
    sessionId = fixture.sessionId;

    const { exportSession } = await import("../src/exporter.js");
    const exportDir = join(tempDir, "exports");
    const result = await exportSession({
      configDir: sourceConfigDir,
      projectPath: "/Users/testuser/Projects/testproject",
      sessionId,
      outputDir: exportDir,
      name: "test-export",
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });

    if (!result.success) throw new Error("Export failed in test setup");
    exportPath = (result as any).exportPath;

    // Create empty target config dir
    targetConfigDir = join(tempDir, "target-claude");
    mkdirSync(join(targetConfigDir, "projects"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("importSession", () => {
    it("imports a session to a new project path", async () => {
      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.importedSessions).toHaveLength(1);
      expect(result.importedSessions[0].originalId).toBe(sessionId);
      expect(result.importedSessions[0].newId).not.toBe(sessionId);

      // Verify files exist in target
      const encoded = "-Users-newuser-Projects-newproject";
      const newId = result.importedSessions[0].newId;
      expect(
        existsSync(
          join(targetConfigDir, "projects", encoded, `${newId}.jsonl`)
        )
      ).toBe(true);

      // Verify path rewriting
      const jsonl = readFileSync(
        join(targetConfigDir, "projects", encoded, `${newId}.jsonl`),
        "utf-8"
      );
      expect(jsonl).toContain("/Users/newuser/Projects/newproject");
      expect(jsonl).not.toContain("/Users/testuser/Projects/testproject");
    });

    it("dry-run returns report without writing", async () => {
      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: true,
      });

      expect(result.success).toBe(true);
      // Verify nothing was written
      const encoded = "-Users-newuser-Projects-newproject";
      expect(
        existsSync(join(targetConfigDir, "projects", encoded))
      ).toBe(false);
    });

    it("imports specific sessions from multi-session export", async () => {
      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
        sessionIds: [sessionId],
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.importedSessions).toHaveLength(1);
    });

    it("merges memory files without overwriting existing", async () => {
      const { importSession } = await import("../src/importer.js");
      const { writeFileSync } = await import("node:fs");

      // Create pre-existing memory in target
      const encoded = "-Users-newuser-Projects-newproject";
      const targetMemDir = join(
        targetConfigDir,
        "projects",
        encoded,
        "memory"
      );
      mkdirSync(targetMemDir, { recursive: true });
      writeFileSync(
        join(targetMemDir, "existing.md"),
        "---\nname: existing\n---\nExisting memory\n"
      );

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(true);
      // Both existing and imported memory files should be present
      expect(existsSync(join(targetMemDir, "existing.md"))).toBe(true);
      expect(existsSync(join(targetMemDir, "MEMORY.md"))).toBe(true);
    });

    it("verifies integrity hash on import", async () => {
      const { importSession } = await import("../src/importer.js");
      // Corrupt the JSONL file in the export
      const { writeFileSync } = await import("node:fs");
      const jsonlPath = join(
        exportPath,
        "sessions",
        `${sessionId}.jsonl`
      );
      writeFileSync(jsonlPath, "corrupted data\n");

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.warnings.some((w) => w.includes("integrity"))).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/importer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement importer.ts**

Create `src/importer.ts`:
```typescript
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readManifest, verifyIntegrity, computeIntegrityHash } from "./manifest.js";
import {
  rewriteJsonl,
  buildPathMappings,
} from "./rewriter.js";
import {
  encodeProjectPath,
  detectPlatform,
  extractUserFromPath,
  getCurrentUser,
} from "./platform.js";
import { createHash } from "node:crypto";
import {
  getApplicableAdapters,
  applyAdapters,
  classifyVersionDifference,
} from "./version-adapters.js";
import type { ImportResult, DryRunResult, ErrorResult, RewriteReport } from "./types.js";

export interface ImportOptions {
  exportPath: string;
  targetConfigDir: string;
  targetProjectPath: string;
  targetClaudeVersion: string;
  dryRun: boolean;
  sessionIds?: string[];
  noRegister?: boolean;
}

export async function importSession(
  options: ImportOptions
): Promise<ImportResult | DryRunResult | ErrorResult> {
  const {
    exportPath,
    targetConfigDir,
    targetProjectPath,
    targetClaudeVersion,
    dryRun,
    sessionIds,
    noRegister,
  } = options;

  const warnings: string[] = [];

  // Step 1: Read manifest
  let manifest;
  try {
    manifest = readManifest(exportPath);
  } catch (e) {
    return {
      success: false,
      command: "import",
      error: `Failed to read manifest: ${(e as Error).message}`,
    };
  }

  // Filter sessions if specific IDs requested
  const targetSessions = sessionIds
    ? manifest.sessions.filter((s) => sessionIds.includes(s.sessionId))
    : manifest.sessions;

  if (targetSessions.length === 0) {
    return {
      success: false,
      command: "import",
      error: "No matching sessions found in export",
    };
  }

  // Step 1.5: Version reconciliation
  const versionDiff = classifyVersionDifference(
    manifest.sourceClaudeVersion,
    targetClaudeVersion
  );
  const adapters = getApplicableAdapters(
    manifest.sourceClaudeVersion,
    targetClaudeVersion
  );
  const versionAdaptations: string[] = [];

  if (versionDiff === "source-newer") {
    warnings.push(
      `Export from newer Claude Code (${manifest.sourceClaudeVersion}) than target (${targetClaudeVersion}). Unknown entry types will be preserved.`
    );
  }

  // Step 2: Build path mappings
  const targetPlatform = detectPlatform();
  const sourceUser =
    extractUserFromPath(manifest.sourceProjectPath, manifest.sourcePlatform) ??
    "unknown";
  const targetUser = getCurrentUser();

  const mappings = buildPathMappings(
    manifest.sourcePlatform,
    targetPlatform,
    manifest.sourceProjectPath,
    targetProjectPath,
    manifest.sourceConfigDir,
    targetConfigDir,
    sourceUser,
    targetUser
  );

  // Verify per-session integrity
  for (const session of targetSessions) {
    const jsonlPath = join(
      exportPath,
      "sessions",
      `${session.sessionId}.jsonl`
    );
    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, "utf-8");
      if (!verifyIntegrity([content], session.integrityHash)) {
        warnings.push(
          `Integrity check failed for session "${session.slug}" (${session.sessionId}): JSONL content doesn't match manifest hash. Data may be corrupted.`
        );
      }
    }
  }

  // For dry-run, return the report
  const importedSessions: Array<{
    originalId: string;
    newId: string;
    slug: string;
    messageCount: number;
  }> = [];

  // Generate new session IDs
  const sessionIdMap = new Map<string, string>();
  for (const session of targetSessions) {
    sessionIdMap.set(session.sessionId, randomUUID());
    importedSessions.push({
      originalId: session.sessionId,
      newId: sessionIdMap.get(session.sessionId)!,
      slug: session.slug,
      messageCount: session.messageCount,
    });
  }

  if (dryRun) {
    // Run rewrite on first session to get report
    let rewriteReport: RewriteReport | undefined;
    if (jsonlContents.length > 0) {
      const { report } = rewriteJsonl(
        jsonlContents[0],
        mappings,
        sessionIdMap.get(targetSessions[0].sessionId)
      );
      rewriteReport = report;
    }

    return {
      success: true,
      command: "import",
      importedSessions,
      warnings,
      resumable: true,
      rewriteReport,
      versionAdaptations: adapters.map((a) => a.description),
    };
  }

  // Step 3: Write session files
  const encodedTargetPath = encodeProjectPath(targetProjectPath);
  const targetProjectDir = join(
    targetConfigDir,
    "projects",
    encodedTargetPath
  );
  mkdirSync(targetProjectDir, { recursive: true });

  for (const session of targetSessions) {
    const newSessionId = sessionIdMap.get(session.sessionId)!;

    // Rewrite and write JSONL
    const jsonlPath = join(
      exportPath,
      "sessions",
      `${session.sessionId}.jsonl`
    );
    if (existsSync(jsonlPath)) {
      const jsonlContent = readFileSync(jsonlPath, "utf-8");

      // Apply version adapters
      let processedContent = jsonlContent;
      if (adapters.length > 0) {
        const lines = jsonlContent.trim().split("\n").filter(Boolean);
        const adaptedLines = lines.map((line) => {
          try {
            const entry = JSON.parse(line);
            const { entry: adapted, applied } = applyAdapters(
              entry,
              adapters
            );
            versionAdaptations.push(...applied);
            return JSON.stringify(adapted);
          } catch {
            return line;
          }
        });
        processedContent = adaptedLines.join("\n") + "\n";
      }

      const { rewritten } = rewriteJsonl(
        processedContent,
        mappings,
        newSessionId
      );
      writeFileSync(
        join(targetProjectDir, `${newSessionId}.jsonl`),
        rewritten
      );
    }

    // Copy subagents
    const subagentsDir = join(
      exportPath,
      "sessions",
      session.sessionId,
      "subagents"
    );
    if (existsSync(subagentsDir)) {
      const targetSubDir = join(
        targetProjectDir,
        newSessionId,
        "subagents"
      );
      mkdirSync(targetSubDir, { recursive: true });
      for (const file of readdirSync(subagentsDir)) {
        if (file.endsWith(".jsonl")) {
          // Rewrite subagent JSONL too
          const content = readFileSync(join(subagentsDir, file), "utf-8");
          const { rewritten } = rewriteJsonl(content, mappings, newSessionId);
          writeFileSync(join(targetSubDir, file), rewritten);
        } else {
          copyFileSync(join(subagentsDir, file), join(targetSubDir, file));
        }
      }
    }

    // Copy tool results
    const toolResultsDir = join(
      exportPath,
      "sessions",
      session.sessionId,
      "tool-results"
    );
    if (existsSync(toolResultsDir)) {
      const targetTrDir = join(
        targetProjectDir,
        newSessionId,
        "tool-results"
      );
      mkdirSync(targetTrDir, { recursive: true });
      for (const file of readdirSync(toolResultsDir)) {
        copyFileSync(join(toolResultsDir, file), join(targetTrDir, file));
      }
    }

    // Copy file history
    const fileHistoryDir = join(
      exportPath,
      "file-history",
      session.sessionId
    );
    if (existsSync(fileHistoryDir)) {
      const targetFhDir = join(
        targetConfigDir,
        "file-history",
        newSessionId
      );
      mkdirSync(targetFhDir, { recursive: true });
      for (const file of readdirSync(fileHistoryDir)) {
        copyFileSync(join(fileHistoryDir, file), join(targetFhDir, file));
      }
    }
  }

  // Merge memory files, tracking conflicts for user resolution
  const memoryConflicts: Array<{
    filename: string;
    existingHash: string;
    incomingHash: string;
  }> = [];
  const memoryDir = join(exportPath, "memory");
  if (existsSync(memoryDir)) {
    const targetMemDir = join(targetProjectDir, "memory");
    mkdirSync(targetMemDir, { recursive: true });
    for (const file of readdirSync(memoryDir)) {
      const targetFile = join(targetMemDir, file);
      if (existsSync(targetFile)) {
        const existingContent = readFileSync(targetFile, "utf-8");
        const newContent = readFileSync(join(memoryDir, file), "utf-8");
        if (existingContent !== newContent) {
          const existingHash = computeIntegrityHash([existingContent]);
          const incomingHash = computeIntegrityHash([newContent]);
          memoryConflicts.push({ filename: file, existingHash, incomingHash });
          warnings.push(
            `Memory file "${file}" exists with different content — kept existing version. Use memoryConflicts in result to resolve.`
          );
        }
        // Skip — keep existing (skill can overwrite if user chooses incoming)
      } else {
        copyFileSync(join(memoryDir, file), targetFile);
      }
    }
  }

  // Copy plans
  const plansDir = join(exportPath, "plans");
  if (existsSync(plansDir)) {
    const targetPlansDir = join(targetConfigDir, "plans");
    mkdirSync(targetPlansDir, { recursive: true });
    for (const file of readdirSync(plansDir)) {
      const targetFile = join(targetPlansDir, file);
      if (!existsSync(targetFile)) {
        copyFileSync(join(plansDir, file), targetFile);
      }
    }
  }

  // Step 5: Validate written files before registering
  let validationPassed = true;
  for (const session of targetSessions) {
    const newSessionId = sessionIdMap.get(session.sessionId)!;
    const jsonlPath = join(targetProjectDir, `${newSessionId}.jsonl`);
    try {
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      // Verify each line is valid JSON
      for (const line of lines) {
        JSON.parse(line);
      }
    } catch (e) {
      validationPassed = false;
      warnings.push(
        `Validation failed for session ${newSessionId}: ${(e as Error).message}. Cleaning up.`
      );
      // Rollback: clean up all written files for this import
      try {
        rmSync(targetProjectDir, { recursive: true, force: true });
        for (const s of targetSessions) {
          const nid = sessionIdMap.get(s.sessionId)!;
          const fhDir = join(targetConfigDir, "file-history", nid);
          if (existsSync(fhDir)) rmSync(fhDir, { recursive: true, force: true });
        }
      } catch { /* best effort cleanup */ }
      return {
        success: false as const,
        command: "import",
        error: `Import validation failed: ${(e as Error).message}`,
        details: "Written files have been cleaned up. No indexes were modified.",
        suggestion: "Check the export bundle for corruption, or try --no-register to import as read-only.",
      };
    }
  }

  // Step 6: Register in indexes (only after successful validation)
  if (!noRegister && validationPassed) {
    const historyPath = join(targetConfigDir, "history.jsonl");
    for (const session of targetSessions) {
      const newSessionId = sessionIdMap.get(session.sessionId)!;
      const historyEntry = {
        display: session.summary || session.slug,
        pastedContents: {},
        timestamp: Date.now(),
        project: targetProjectPath,
        sessionId: newSessionId,
      };
      appendFileSync(
        historyPath,
        JSON.stringify(historyEntry) + "\n",
        "utf-8"
      );
    }
  }

  return {
    success: true,
    command: "import",
    importedSessions,
    warnings,
    resumable: !noRegister && validationPassed,
    memoryConflicts: memoryConflicts.length > 0 ? memoryConflicts : undefined,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/importer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/importer.ts tests/importer.test.ts
git commit -m "feat: add session importer with path rewriting, version adapters, memory merge, and index registration"
```

---

### Task 13: Migrator

**Files:**
- Create: `src/migrator.ts`
- Create: `tests/migrator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/migrator.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

describe("migrator", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-migrator-test-"));
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("migrateSession", () => {
    it("moves a session to a new project path on same config dir", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/newproject",
        scope: "current",
        sessionId,
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.cleanedUp).toBe(true);

      // Source should be cleaned up
      const sourceEncoded = "-Users-testuser-Projects-testproject";
      expect(
        existsSync(
          join(configDir, "projects", sourceEncoded, `${sessionId}.jsonl`)
        )
      ).toBe(false);

      // Target should exist
      const targetEncoded = "-Users-testuser-Projects-newproject";
      const newId = result.importedSessions[0].newId;
      expect(
        existsSync(
          join(configDir, "projects", targetEncoded, `${newId}.jsonl`)
        )
      ).toBe(true);
    });

    it("migrates between config directories", async () => {
      const { migrateSession } = await import("../src/migrator.js");
      const targetConfig = join(tempDir, "other-claude");
      mkdirSync(join(targetConfig, "projects"), { recursive: true });

      const result = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: targetConfig,
        sourceProjectPath: "/Users/testuser/Projects/testproject",
        targetProjectPath: "/Users/testuser/Projects/testproject",
        scope: "current",
        sessionId,
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.cleanedUp).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/migrator.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement migrator.ts**

Create `src/migrator.ts`:
```typescript
import {
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { exportSession, exportAllSessions } from "./exporter.js";
import { importSession } from "./importer.js";
import { encodeProjectPath } from "./platform.js";
import type {
  MigrateResult,
  ErrorResult,
  ExportLayer,
  SessionScope,
} from "./types.js";

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
}

export async function migrateSession(
  options: MigrateOptions
): Promise<MigrateResult | ErrorResult> {
  const {
    sourceConfigDir,
    targetConfigDir,
    sourceProjectPath,
    targetProjectPath,
    scope,
    sessionId,
    excludeLayers,
    claudeVersion,
    dryRun,
  } = options;

  // Create temp directory for the intermediate export
  const tempExportDir = mkdtempSync(
    join(tmpdir(), "sesh-mover-migrate-")
  );

  try {
    // Step 1: Export
    const exportOpts = {
      configDir: sourceConfigDir,
      projectPath: sourceProjectPath,
      outputDir: tempExportDir,
      name: "migrate-temp",
      excludeLayers,
      claudeVersion,
    };

    const exportResult =
      scope === "current" && sessionId
        ? await exportSession({ ...exportOpts, sessionId })
        : await exportAllSessions(exportOpts);

    if (!exportResult.success) {
      return exportResult as ErrorResult;
    }

    const exportPath = (exportResult as any).exportPath;

    // Step 2: Import to target (or dry-run)
    const importResult = await importSession({
      exportPath,
      targetConfigDir,
      targetProjectPath,
      targetClaudeVersion: claudeVersion,
      dryRun: !!dryRun,
    });

    if (!importResult.success) {
      return importResult as ErrorResult;
    }

    // If dry-run, return preview without cleanup
    if (dryRun) {
      return {
        success: true,
        command: "migrate",
        importedSessions: (importResult as any).importedSessions,
        cleanedUp: false,
        sourcePath: sourceProjectPath,
        targetPath: targetProjectPath,
        warnings: [
          ...(importResult as any).warnings,
          "DRY RUN: no files were modified or deleted",
        ],
      };
    }

    // Step 3: Clean up source
    const sourceEncoded = encodeProjectPath(sourceProjectPath);
    const sourceProjectDir = join(
      sourceConfigDir,
      "projects",
      sourceEncoded
    );
    let cleanedUp = false;

    if (scope === "current" && sessionId) {
      // Remove just this session's files
      const jsonlPath = join(sourceProjectDir, `${sessionId}.jsonl`);
      if (existsSync(jsonlPath)) {
        rmSync(jsonlPath);
      }
      // Remove session subdirectory (subagents, tool-results)
      const sessionSubDir = join(sourceProjectDir, sessionId);
      if (existsSync(sessionSubDir)) {
        rmSync(sessionSubDir, { recursive: true });
      }
      // Remove file history
      const fileHistoryDir = join(
        sourceConfigDir,
        "file-history",
        sessionId
      );
      if (existsSync(fileHistoryDir)) {
        rmSync(fileHistoryDir, { recursive: true });
      }
      cleanedUp = true;
    } else {
      // Remove all sessions for this project
      if (existsSync(sourceProjectDir)) {
        // Keep memory directory if target is different project
        const files = readdirSync(sourceProjectDir);
        for (const file of files) {
          const filePath = join(sourceProjectDir, file);
          if (file === "memory") continue; // memory was merged, keep original
          rmSync(filePath, { recursive: true });
        }
        cleanedUp = true;
      }
    }

    return {
      success: true,
      command: "migrate",
      importedSessions: (importResult as any).importedSessions,
      cleanedUp,
      sourcePath: sourceProjectPath,
      targetPath: targetProjectPath,
      warnings: (importResult as any).warnings || [],
    };
  } finally {
    // Clean up temp export
    rmSync(tempExportDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/migrator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/migrator.ts tests/migrator.test.ts
git commit -m "feat: add session migrator with export-import-cleanup pipeline"
```

---

### Task 14: CLI Entry Point

**Files:**
- Create: `src/cli.ts`
- Create: `tests/cli.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/cli.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

describe("cli", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-cli-test-"));
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runCli(args: string): string {
    const cliPath = join(__dirname, "..", "dist", "cli.js");
    return execSync(`node "${cliPath}" ${args}`, {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    });
  }

  describe("export command", () => {
    it("exports current session as JSON output", () => {
      const outputDir = join(tempDir, "cli-export");
      mkdirSync(outputDir, { recursive: true });
      const output = runCli(
        `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --storage user --format dir --name cli-test --output "${outputDir}"`
      );
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.command).toBe("export");
    });
  });

  describe("browse command", () => {
    it("lists exports as JSON", () => {
      // First create an export
      const outputDir = join(tempDir, "cli-browse");
      mkdirSync(outputDir, { recursive: true });
      runCli(
        `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --storage user --format dir --name browse-test --output "${outputDir}"`
      );

      const output = runCli(`browse --storage all --json`);
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.command).toBe("browse");
    });
  });

  describe("configure command", () => {
    it("shows current config", () => {
      const output = runCli("configure --show --json");
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.config.export.storage).toBe("user");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/cli.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement cli.ts**

Create `src/cli.ts`:
```typescript
#!/usr/bin/env node

import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolveConfigDir, detectPlatform } from "./platform.js";
import { getDefaultConfig, readConfig, writeConfig, mergeConfigs, setConfigValue } from "./config.js";
import { exportSession, exportAllSessions } from "./exporter.js";
import { importSession } from "./importer.js";
import { migrateSession } from "./migrator.js";
import { readManifest } from "./manifest.js";
import { createArchive, extractArchive, detectArchiveFormat, isZstdAvailable } from "./archiver.js";
import { discoverSessionById } from "./discovery.js";
import type { ExportLayer, SessionScope, StorageScope, ExportFormat, BrowseResult, ErrorResult, ConfigureResult } from "./types.js";
import { readdirSync, readFileSync } from "node:fs";

const program = new Command();

program
  .name("sesh-mover")
  .description("Export, import, and migrate Claude Code sessions")
  .version("0.1.0");

// --- Export ---
program
  .command("export")
  .description("Export session(s) from the current project")
  .option("--scope <scope>", "current or all", "current")
  .option("--storage <storage>", "user or project", "user")
  .option("--format <format>", "dir, archive, or zstd", "dir")
  .option("--exclude <layers...>", "Layers to exclude")
  .option("--source-config-dir <path>", "Override Claude config dir")
  .option("--session-id <id>", "Export specific session by ID")
  .option("--name <name>", "Export name")
  .option("--output <path>", "Override output path")
  .option("--no-summary", "Skip Claude-generated summary")
  .option("--overwrite", "Overwrite existing export")
  .option("--suffix", "Auto-suffix on name collision")
  .action(async (opts) => {
    try {
      const configDir = resolveConfigDir(opts.sourceConfigDir);
      const config = loadEffectiveConfig(configDir, process.cwd());
      const scope = (opts.scope ?? config.export.scope) as SessionScope;
      const storage = (opts.storage ?? config.export.storage) as StorageScope;
      const format = (opts.format ?? config.export.format) as ExportFormat;
      const excludeLayers = (opts.exclude ?? config.export.exclude) as ExportLayer[];
      const claudeVersion = getClaudeVersion();

      // Determine output directory
      let outputDir: string;
      if (opts.output) {
        outputDir = opts.output;
      } else if (storage === "project") {
        outputDir = join(process.cwd(), ".claude-sesh-mover");
      } else {
        outputDir = join(homedir(), ".claude-sesh-mover");
      }
      mkdirSync(outputDir, { recursive: true });

      // Generate name
      const name = opts.name ?? generateExportName(configDir, opts.sessionId);

      // Check collision
      const exportPath = join(outputDir, name);
      if (existsSync(exportPath) && !opts.overwrite) {
        if (opts.suffix) {
          // Find next available suffix
          let suffix = 2;
          while (existsSync(join(outputDir, `${name}-${suffix}`))) {
            suffix++;
          }
          const suffixedName = `${name}-${suffix}`;
          const result = await doExport(configDir, scope, opts.sessionId, outputDir, suffixedName, excludeLayers, claudeVersion);
          output(result);
          return;
        }
        // Report collision
        output({
          success: true,
          command: "export",
          exportPath,
          sessions: [],
          warnings: [],
          archivePath: null,
          collision: true,
          existingPath: exportPath,
        });
        return;
      }

      const result = await doExport(configDir, scope, opts.sessionId, outputDir, name, excludeLayers, claudeVersion);

      // Handle archive
      if (result.success && (format === "archive" || format === "zstd")) {
        let compression: "gzip" | "zstd" = format === "zstd" ? "zstd" : "gzip";
        if (compression === "zstd" && !(await isZstdAvailable())) {
          (result as any).warnings.push("zstd not found on system, falling back to gzip");
          compression = "gzip";
          (result as any).actualFormat = "archive"; // signal fallback to skill
        }
        const ext = compression === "zstd" ? ".tar.zst" : ".tar.gz";
        const archivePath = (result as any).exportPath + ext;
        await createArchive((result as any).exportPath, archivePath, compression);
        (result as any).archivePath = archivePath;
      }

      output(result);
    } catch (e) {
      outputError("export", e as Error);
    }
  });

// --- Import ---
program
  .command("import")
  .description("Import session(s) from an export")
  .requiredOption("--from <path>", "Path to export directory or archive")
  .option("--session-id <ids...>", "Import specific sessions")
  .option("--target-project-path <path>", "Target project path", process.cwd())
  .option("--target-config-dir <path>", "Target Claude config dir")
  .option("--dry-run", "Show changes without applying")
  .option("--no-register", "Skip session index registration")
  .option("--force", "Skip confirmation")
  .action(async (opts) => {
    try {
      let fromPath = opts.from;

      // If archive, extract first
      const archiveFormat = detectArchiveFormat(fromPath);
      if (archiveFormat) {
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const extractDir = mkdtempSync(join(tmpdir(), "sesh-mover-extract-"));
        await extractArchive(fromPath, extractDir);
        fromPath = extractDir;
      }

      const targetConfigDir = resolveConfigDir(opts.targetConfigDir);
      const claudeVersion = getClaudeVersion();

      const result = await importSession({
        exportPath: fromPath,
        targetConfigDir,
        targetProjectPath: opts.targetProjectPath,
        targetClaudeVersion: claudeVersion,
        dryRun: !!opts.dryRun,
        sessionIds: opts.sessionId,
        noRegister: !opts.register, // Commander.js --no-register sets opts.register to false
      });

      output(result);
    } catch (e) {
      outputError("import", e as Error);
    }
  });

// --- Migrate ---
program
  .command("migrate")
  .description("Move session(s) to a new path (same machine)")
  .requiredOption("--target-project-path <path>", "Destination project path")
  .option("--scope <scope>", "current or all", "current")
  .option("--source-config-dir <path>", "Source Claude config dir")
  .option("--target-config-dir <path>", "Target Claude config dir")
  .option("--exclude <layers...>", "Layers to exclude")
  .option("--session-id <id>", "Migrate specific session")
  .option("--dry-run", "Show changes without applying")
  .action(async (opts) => {
    try {
      const sourceConfigDir = resolveConfigDir(opts.sourceConfigDir);
      const targetConfigDir = resolveConfigDir(opts.targetConfigDir);
      const claudeVersion = getClaudeVersion();

      // Source project path is the current working directory
      const sourceProjectPath = process.cwd();

      const result = await migrateSession({
        sourceConfigDir,
        targetConfigDir,
        sourceProjectPath,
        targetProjectPath: opts.targetProjectPath,
        scope: opts.scope as SessionScope,
        sessionId: opts.sessionId,
        excludeLayers: (opts.exclude ?? []) as ExportLayer[],
        claudeVersion,
        dryRun: !!opts.dryRun,
      });

      output(result);
    } catch (e) {
      outputError("migrate", e as Error);
    }
  });

// --- Browse ---
program
  .command("browse")
  .description("List available exports")
  .option("--storage <storage>", "user, project, or all", "all")
  .option("--source-config-dir <path>", "Override config dir")
  .option("--json", "Output raw JSON")
  .option("--prune", "Delete old exports interactively")
  .action(async (opts) => {
    try {
      const exports: BrowseResult["exports"] = [];

      const searchDirs: Array<{ dir: string; storage: StorageScope }> = [];

      if (opts.storage === "user" || opts.storage === "all") {
        const userDir = join(homedir(), ".claude-sesh-mover");
        if (existsSync(userDir)) {
          searchDirs.push({ dir: userDir, storage: "user" });
        }
      }

      if (opts.storage === "project" || opts.storage === "all") {
        const projectDir = join(process.cwd(), ".claude-sesh-mover");
        if (existsSync(projectDir)) {
          searchDirs.push({ dir: projectDir, storage: "project" });
        }
      }

      for (const { dir, storage } of searchDirs) {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const manifestPath = join(dir, entry, "manifest.json");
          if (existsSync(manifestPath)) {
            try {
              const manifest = readManifest(join(dir, entry));
              exports.push({
                name: entry,
                path: join(dir, entry),
                exportedAt: manifest.exportedAt,
                sourcePlatform: manifest.sourcePlatform,
                sourceProjectPath: manifest.sourceProjectPath,
                sessionCount: manifest.sessions.length,
                sessions: manifest.sessions,
                storage,
              });
            } catch {
              // Skip malformed exports
            }
          }
        }
      }

      // Also look for archives
      for (const { dir, storage } of searchDirs) {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (entry.endsWith(".tar.gz") || entry.endsWith(".tar.zst")) {
            // We can't read manifests from archives without extracting
            // Just list them with minimal info
            exports.push({
              name: entry,
              path: join(dir, entry),
              exportedAt: "",
              sourcePlatform: detectPlatform(),
              sourceProjectPath: "",
              sessionCount: 0,
              sessions: [],
              storage,
            });
          }
        }
      }

      // Handle --prune: output exports with a prunable flag for the skill to act on
      if (opts.prune) {
        // In non-interactive mode, list exports that can be pruned
        // The skill will present options and invoke delete via rm
        for (const exp of exports) {
          (exp as any).prunable = true;
        }
      }

      const result: BrowseResult = {
        success: true,
        command: "browse",
        exports: exports.sort(
          (a, b) =>
            new Date(b.exportedAt || 0).getTime() -
            new Date(a.exportedAt || 0).getTime()
        ),
      };

      output(result);
    } catch (e) {
      outputError("browse", e as Error);
    }
  });

// --- Configure ---
program
  .command("configure")
  .description("Set defaults for sesh-mover commands")
  .option("--scope <scope>", "user or project", "user")
  .option("--set <keyvalue>", "Set a config value (key=value)")
  .option("--show", "Show current effective config")
  .option("--reset", "Reset config to defaults")
  .option("--json", "Output raw JSON")
  .action(async (opts) => {
    try {
      const configDir =
        opts.scope === "project"
          ? join(process.cwd(), ".claude-sesh-mover")
          : join(homedir(), ".claude-sesh-mover");

      if (opts.reset) {
        writeConfig(configDir, getDefaultConfig());
        const result: ConfigureResult = {
          success: true,
          command: "configure",
          config: getDefaultConfig(),
          scope: opts.scope as StorageScope,
          message: "Config reset to defaults",
        };
        output(result);
        return;
      }

      if (opts.set) {
        const [key, value] = opts.set.split("=");
        if (!key || value === undefined) {
          outputError("configure", new Error("--set requires key=value format"));
          return;
        }
        let config = readConfig(configDir);
        // Parse value
        let parsedValue: unknown = value;
        if (value === "true") parsedValue = true;
        else if (value === "false") parsedValue = false;
        else if (value.startsWith("[")) parsedValue = JSON.parse(value);

        config = setConfigValue(config, key, parsedValue);
        writeConfig(configDir, config);
        const result: ConfigureResult = {
          success: true,
          command: "configure",
          config,
          scope: opts.scope as StorageScope,
          message: `Set ${key} = ${value}`,
        };
        output(result);
        return;
      }

      if (opts.show) {
        const config = loadEffectiveConfig(
          resolveConfigDir(),
          process.cwd()
        );
        const result: ConfigureResult = {
          success: true,
          command: "configure",
          config,
          scope: opts.scope as StorageScope,
          message: "Current effective config",
        };
        output(result);
        return;
      }

      // Default: show config
      const config = readConfig(configDir);
      const result: ConfigureResult = {
        success: true,
        command: "configure",
        config,
        scope: opts.scope as StorageScope,
        message: `Config for ${opts.scope} scope`,
      };
      output(result);
    } catch (e) {
      outputError("configure", e as Error);
    }
  });

// --- Helpers ---

async function doExport(
  configDir: string,
  scope: SessionScope,
  sessionId: string | undefined,
  outputDir: string,
  name: string,
  excludeLayers: ExportLayer[],
  claudeVersion: string
) {
  // Detect project path from cwd
  const projectPath = process.cwd();

  if (scope === "all") {
    return exportAllSessions({
      configDir,
      projectPath,
      outputDir,
      name,
      excludeLayers,
      claudeVersion,
    });
  }

  return exportSession({
    configDir,
    projectPath,
    sessionId,
    outputDir,
    name,
    excludeLayers,
    claudeVersion,
  });
}

function loadEffectiveConfig(configDir: string, projectDir: string) {
  const userConfigDir = join(homedir(), ".claude-sesh-mover");
  const projectConfigDir = join(projectDir, ".claude-sesh-mover");
  const userConfig = readConfig(userConfigDir);
  const projectConfig = readConfig(projectConfigDir);
  return mergeConfigs(userConfig, projectConfig);
}

function generateExportName(
  configDir: string,
  sessionId?: string
): string {
  const date = new Date().toISOString().split("T")[0];
  if (sessionId) {
    const session = discoverSessionById(configDir, sessionId);
    if (session && session.slug) {
      return `${date}-${session.slug}`;
    }
  }
  return `${date}-export`;
}

function getClaudeVersion(): string {
  try {
    const version = execSync("claude --version", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    // Extract version number
    const match = version.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : "unknown";
  } catch {
    return "unknown";
  }
}

function output(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function outputError(command: string, error: Error): void {
  const result: ErrorResult = {
    success: false,
    command,
    error: error.message,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(1);
}

program.parse();
```

- [ ] **Step 4: Build and run tests**

Run: `cd ~/Projects/sesh-mover && npm run build`
Expected: Compiles to `dist/`

Run: `npm test -- tests/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: add CLI entry point with export, import, migrate, browse, and configure commands"
```

---

### Task 15: Slash Commands & Skill

**Files:**
- Create: `commands/export.md`
- Create: `commands/import.md`
- Create: `commands/migrate.md`
- Create: `commands/browse.md`
- Create: `commands/configure.md`
- Create: `skills/session-porter/SKILL.md`

- [ ] **Step 1: Create export command**

Create `commands/export.md`:
```markdown
---
name: export
description: Export the current Claude Code session or all sessions for this project
---

You are running the sesh-mover export command. Follow these steps:

1. Detect the current session ID from the conversation context (look at the sessionId in any recent tool result, or use `sesh-mover browse` to find sessions for the current project path).

2. Ask the user (unless they specified in their command):
   - Export this session only, or all sessions for this project?
   - Store at user level (~/.claude-sesh-mover/) or project level (.claude-sesh-mover/)?
   - Exclude any layers? (file-history, tool-results, memory, plans, subagents) — default is include all
   - Directory or archive format? (dir, archive/tar.gz, zstd/tar.zst)

3. Generate a one-line summary of the session by reading the first few exchanges, then describe it in ~100 characters.

4. Run the CLI command:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" export --scope <scope> --session-id <id> --storage <storage> --format <format> [--exclude <layers>] --name "<name>" --source-config-dir "<config-dir>"
   ```

5. Parse the JSON output. If `collision` is true, ask the user:
   - Keep both (append suffix)
   - Overwrite
   - Cancel

6. If archive was requested and the result has `archivePath`, report both the directory and archive locations.

7. Report what was exported: session name, summary, layers included, destination path.

To find the plugin root, search for the sesh-mover plugin directory by running:
```bash
find ~/.claude-tzun/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Or check common locations: `~/.claude-tzun/plugins/cache/*/sesh-mover/*/` or `~/.claude/plugins/cache/*/sesh-mover/*/`. Cache the path for the duration of the conversation.
```

- [ ] **Step 2: Create import command**

Create `commands/import.md`:
```markdown
---
name: import
description: Import a previously exported Claude Code session
---

You are running the sesh-mover import command. Follow these steps:

1. List available exports:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" browse --storage all --json
   ```

2. Present the list to the user with: date, name, summary, source platform, source project path, session count. Format as a numbered table.

3. Ask which export to import.

4. If the chosen export contains multiple sessions, present the individual sessions (ID, summary, date, message count) and ask:
   - Import all sessions?
   - Import specific ones? (let user pick by number)

5. Run a dry-run first:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" import --from "<path>" [--session-id <ids>] --target-project-path "<cwd>" --target-config-dir "<config-dir>" --dry-run
   ```

6. Present the dry-run results: path rewrites that will be applied, version adaptations, integrity status, any warnings.

7. Ask the user to confirm.

8. Execute the import:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" import --from "<path>" [--session-id <ids>] --target-project-path "<cwd>" --target-config-dir "<config-dir>"
   ```

9. Report the result. If `resumable` is true, tell the user they can continue the session with `claude --resume <newSessionId>`. If not resumable, offer to read the imported JSONL and inject it as context into the current conversation.

Replace PLUGIN_ROOT with the actual path to this plugin's installation directory.
```

- [ ] **Step 3: Create migrate command**

Create `commands/migrate.md`:
```markdown
---
name: migrate
description: Move session(s) to a new project path or config directory (same machine only)
---

You are running the sesh-mover migrate command. This is a same-machine operation that moves sessions (export + import + cleanup). Follow these steps:

1. Ask the user:
   - What is the target project path?
   - (If applicable) What is the target config directory?
   - Migrate this session only, or all sessions for the current project?

2. Detect the current platform. If WSL is involved (source or target paths suggest it), auto-detect the path translation and present the mapping for the user to confirm before proceeding.

3. Run a dry-run:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" migrate --target-project-path "<path>" [--target-config-dir "<path>"] --scope <scope> [--session-id <id>] --dry-run
   ```

4. Present what will happen:
   - Sessions that will be moved
   - Path translations that will be applied
   - Source files that will be cleaned up after successful import
   - Any warnings

5. Ask the user to confirm. Emphasize that this will delete the source session files after import.

6. Execute:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" migrate --target-project-path "<path>" [--target-config-dir "<path>"] --scope <scope> [--session-id <id>]
   ```

7. Report: sessions moved, new session IDs, whether cleanup succeeded.

Replace PLUGIN_ROOT with the actual path to this plugin's installation directory.
```

- [ ] **Step 4: Create browse command**

Create `commands/browse.md`:
```markdown
---
name: browse
description: List all exported sessions with identifying information
---

You are running the sesh-mover browse command. Follow these steps:

1. List all exports:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" browse --storage all --json
   ```

2. Present the results as a formatted table:
   ```
   #  Date        Name                   Summary                                          Platform  Sessions  Storage
   1  2026-04-11  sesh-mover-design      Designing a session migration plugin             darwin    1         user
   2  2026-04-09  fix-auth-middleware     Debugging JWT token expiry in auth middleware    wsl2      3         project
   ```

3. If the user asks about a specific export, read its manifest for more details (individual sessions, layers, source info).

4. If the user wants to import one, invoke the import command flow.

5. If the user wants to delete old exports, use the --prune flag or delete the directory directly.

Replace PLUGIN_ROOT with the actual path to this plugin's installation directory.
```

- [ ] **Step 5: Create configure command**

Create `commands/configure.md`:
```markdown
---
name: configure
description: Set user or project level defaults for sesh-mover commands
---

You are running the sesh-mover configure command. Follow these steps:

1. Show current effective config:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" configure --show --json
   ```

2. Present the current settings grouped by command:
   - **Export defaults:** storage (user/project), format (dir/archive/zstd), excluded layers, scope (current/all), summary generation
   - **Import defaults:** dry-run first (true/false)
   - **Migrate defaults:** scope (current/all)

3. Ask the user which settings they want to change.

4. For each change, apply it:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" configure --scope <user|project> --set "<key>=<value>"
   ```

5. Confirm what was saved and at which scope level.

Configurable keys:
- `export.storage` — "user" or "project"
- `export.format` — "dir", "archive", or "zstd"
- `export.exclude` — JSON array like `["file-history","plans"]`
- `export.scope` — "current" or "all"
- `export.noSummary` — true or false
- `import.dryRunFirst` — true or false
- `migrate.scope` — "current" or "all"

Replace PLUGIN_ROOT with the actual path to this plugin's installation directory.
```

- [ ] **Step 6: Create the main SKILL.md**

Create `skills/session-porter/SKILL.md`:
```markdown
---
name: session-porter
description: Full context for Claude Code session export/import/migration operations via sesh-mover CLI
---

# sesh-mover Session Porter Skill

This skill provides background knowledge for all sesh-mover slash commands. It is not invoked directly by users — the individual commands (export, import, migrate, browse, configure) reference this knowledge.

## CLI Location

The sesh-mover CLI is at `PLUGIN_ROOT/dist/cli.js`. To find PLUGIN_ROOT, run:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Cache this path for the duration of the conversation. Then invoke:
```bash
node "<PLUGIN_ROOT>/dist/cli.js" <command> [options]
```

All commands output structured JSON to stdout. Parse it with JSON.parse().

## Sensitive Data Warning

Exported sessions may contain API keys, tokens, passwords, or other sensitive data from the conversation or tool results. Always warn the user:
- When exporting to a project-level directory (it might get committed to git)
- When creating archives for transfer (the archive contains raw conversation data)
- Recommend adding `.claude-sesh-mover/` to `.gitignore` for project-level exports

## Detecting the Current Session

The current session ID can be found by:
1. Looking at the `sessionId` field in any JSONL entry visible in the conversation
2. Checking `~/.claude/history.jsonl` for the most recent entry matching the current project path
3. Running: `node "PLUGIN_ROOT/dist/cli.js" browse --json` and finding the session for the current path

## Config Directory Detection

The Claude config directory is resolved in order:
1. `--source-config-dir` / `--target-config-dir` flags
2. `CLAUDE_CONFIG_DIR` environment variable
3. `~/.claude/` default

The user may have multiple config dirs (e.g., `~/.claude` and `~/.claude-tzun`). Always detect or ask rather than assuming.

## Error Handling

When a CLI command returns `{"success": false, ...}`:
- Read the `error` and `details` fields
- If `suggestion` is present, offer it to the user
- Common errors:
  - "No sessions found" — wrong project path or config dir
  - "Session validation failed" — version mismatch, suggest `--no-register`
  - "Integrity check failed" — data corruption during transfer

When import registration fails (session not resumable):
- Offer to read the imported JSONL and inject the conversation as context into a new session
- This is the fallback for when Claude Code's internal validation rejects the imported session

## Platform Notes

- WSL paths: `/home/user/...` and `/mnt/c/...`
- Windows paths: `C:\Users\user\...`
- macOS paths: `/Users/user/...`
- Linux paths: `/home/user/...`

The CLI auto-detects the current platform and translates paths during import. For WSL <-> Windows, it shows the mapping and asks for confirmation.
```

- [ ] **Step 7: Commit**

```bash
git add commands/ skills/
git commit -m "feat: add slash commands (export, import, migrate, browse, configure) and session-porter skill"
```

---

### Task 16: Update Barrel Export and Plugin Manifest

**Files:**
- Modify: `src/index.ts`
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Update barrel export**

Update `src/index.ts` to export all modules:
```typescript
// sesh-mover core library exports
// NOTE: decodeProjectPath intentionally not provided — encoding is lossy for hyphenated paths.
// Use readProjectPathFromJsonl in discovery.ts or read cwd from JSONL entries instead.
export * from "./types.js";
export * from "./platform.js";
export * from "./config.js";
export * from "./manifest.js";
export * from "./discovery.js";
export * from "./summary.js";
export * from "./rewriter.js";
export * from "./archiver.js";
export * from "./version-adapters.js";
export * from "./exporter.js";
export * from "./importer.js";
export * from "./migrator.js";
```

- [ ] **Step 2: Verify full build passes**

Run: `cd ~/Projects/sesh-mover && npm run build`
Expected: Clean compilation to `dist/`

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/index.ts .claude-plugin/plugin.json
git commit -m "chore: update barrel export and finalize plugin manifest"
```

---

### Task 17: Integration Test — Full Export/Import Cycle

**Files:**
- Create: `tests/integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `tests/integration.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

describe("integration: full export/import cycle", () => {
  let tempDir: string;
  let sourceConfigDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-integration-"));
    const fixture = createFixtureTree(tempDir);
    sourceConfigDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exports, archives, extracts, and imports a session to a new path", async () => {
    const { exportSession } = await import("../src/exporter.js");
    const { createArchive, extractArchive } = await import(
      "../src/archiver.js"
    );
    const { importSession } = await import("../src/importer.js");

    // 1. Export
    const exportDir = join(tempDir, "exports");
    const exportResult = await exportSession({
      configDir: sourceConfigDir,
      projectPath: "/Users/testuser/Projects/testproject",
      sessionId,
      outputDir: exportDir,
      name: "integration-test",
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });
    expect(exportResult.success).toBe(true);
    const exportPath = (exportResult as any).exportPath;

    // 2. Archive
    const archivePath = join(tempDir, "integration-test.tar.gz");
    await createArchive(exportPath, archivePath, "gzip");
    expect(existsSync(archivePath)).toBe(true);

    // 3. Extract (simulating transfer to another machine)
    const extractDir = join(tempDir, "extracted");
    mkdirSync(extractDir);
    await extractArchive(archivePath, extractDir);
    expect(existsSync(join(extractDir, "manifest.json"))).toBe(true);

    // 4. Import to a new config dir and project path
    const targetConfigDir = join(tempDir, "target-claude");
    mkdirSync(join(targetConfigDir, "projects"), { recursive: true });

    const importResult = await importSession({
      exportPath: extractDir,
      targetConfigDir,
      targetProjectPath: "/home/devuser/projects/testproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    });
    expect(importResult.success).toBe(true);
    const imported = (importResult as any).importedSessions[0];
    expect(imported.originalId).toBe(sessionId);
    expect(imported.newId).not.toBe(sessionId);

    // 5. Verify rewritten content
    const targetEncoded = "-home-devuser-projects-testproject";
    const newJsonl = readFileSync(
      join(
        targetConfigDir,
        "projects",
        targetEncoded,
        `${imported.newId}.jsonl`
      ),
      "utf-8"
    );

    // Paths should be rewritten
    expect(newJsonl).toContain("/home/devuser/projects/testproject");
    expect(newJsonl).not.toContain("/Users/testuser/Projects/testproject");

    // Session ID should be rewritten
    expect(newJsonl).toContain(imported.newId);

    // Memory should be copied
    expect(
      existsSync(
        join(
          targetConfigDir,
          "projects",
          targetEncoded,
          "memory",
          "MEMORY.md"
        )
      )
    ).toBe(true);

    // File history should be under new session ID
    expect(
      existsSync(
        join(targetConfigDir, "file-history", imported.newId, "abc123@v1")
      )
    ).toBe(true);

    // History.jsonl should have the new entry
    const history = readFileSync(
      join(targetConfigDir, "history.jsonl"),
      "utf-8"
    );
    expect(history).toContain(imported.newId);
    expect(history).toContain("/home/devuser/projects/testproject");
  });

  it("imports with correct path rewriting when source and target paths differ significantly", async () => {
    const { exportSession } = await import("../src/exporter.js");
    const { importSession } = await import("../src/importer.js");

    // Export
    const exportDir = join(tempDir, "exports-rewrite");
    const exportResult = await exportSession({
      configDir: sourceConfigDir,
      projectPath: "/Users/testuser/Projects/testproject",
      sessionId,
      outputDir: exportDir,
      name: "rewrite-test",
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });
    expect(exportResult.success).toBe(true);

    // Import to a path that simulates WSL-like target
    const targetConfigDir = join(tempDir, "wsl-target-claude");
    mkdirSync(join(targetConfigDir, "projects"), { recursive: true });

    const importResult = await importSession({
      exportPath: (exportResult as any).exportPath,
      targetConfigDir,
      targetProjectPath: "/home/devuser/projects/testproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    });

    expect(importResult.success).toBe(true);
    const imported = (importResult as any).importedSessions[0];

    // Verify tool result paths were rewritten
    const targetEncoded = "-home-devuser-projects-testproject";
    const jsonl = readFileSync(
      join(targetConfigDir, "projects", targetEncoded, `${imported.newId}.jsonl`),
      "utf-8"
    );
    // Tool result stdout should be rewritten
    expect(jsonl).toContain("/home/devuser/projects/testproject");
    // Original paths should NOT be present in tool results
    expect(jsonl).not.toContain("/Users/testuser/Projects/testproject");
  });

  it("migrates a session to a new path and cleans up source", async () => {
    const { migrateSession } = await import("../src/migrator.js");

    const result = await migrateSession({
      sourceConfigDir,
      targetConfigDir: sourceConfigDir,
      sourceProjectPath: "/Users/testuser/Projects/testproject",
      targetProjectPath: "/Users/testuser/Projects/newlocation",
      scope: "current",
      sessionId,
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Source cleaned up
    expect(
      existsSync(
        join(
          sourceConfigDir,
          "projects",
          "-Users-testuser-Projects-testproject",
          `${sessionId}.jsonl`
        )
      )
    ).toBe(false);

    // Target exists
    const targetEncoded = "-Users-testuser-Projects-newlocation";
    const newId = result.importedSessions[0].newId;
    expect(
      existsSync(
        join(
          sourceConfigDir,
          "projects",
          targetEncoded,
          `${newId}.jsonl`
        )
      )
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npm test -- tests/integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite one final time**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: add full export/import/migrate integration tests"
```

---

### Task 18: Final Cleanup & README

**Files:**
- Remove: `tests/setup.test.ts` (no longer needed)
- Verify: full build + test

- [ ] **Step 1: Remove scaffolding test**

```bash
rm tests/setup.test.ts
```

- [ ] **Step 2: Full build and test**

Run: `cd ~/Projects/sesh-mover && npm run build && npm test`
Expected: Clean build, all tests pass

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: remove scaffolding test, finalize v0.1.0"
```
