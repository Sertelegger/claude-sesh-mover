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
