import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("sync-state", () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-sync-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("syncStatePath uses encoded project path under ~/.claude-sesh-mover/sync-state/", async () => {
    const { syncStatePath } = await import("../src/sync-state.js");
    const p = syncStatePath("/Users/sascha/Projects/foo");
    expect(p).toBe(
      join(tempHome, ".claude-sesh-mover", "sync-state", "-Users-sascha-Projects-foo.json")
    );
  });

  it("readSyncState returns an empty default when file is absent", async () => {
    const { readSyncState } = await import("../src/sync-state.js");
    const state = readSyncState("/Users/sascha/Projects/foo");
    expect(state.projectPath).toBe("/Users/sascha/Projects/foo");
    expect(state.schemaVersion).toBe(1);
    expect(state.peers).toEqual({});
    expect(state.lineage).toEqual({});
  });

  it("writeSyncState + readSyncState round-trip", async () => {
    const { readSyncState, writeSyncState } = await import("../src/sync-state.js");
    const state = readSyncState("/Users/sascha/Projects/foo");
    state.peers["peer-1"] = {
      name: "peer-one",
      lastSentAt: "2026-04-21T00:00:00.000Z",
      lastReceivedAt: null,
      sent: {
        "local-session-1": {
          headEntryUuid: "uuid-42",
          messageCount: 10,
          sentAsType: "full",
          sentAsSessionId: "local-session-1",
        },
      },
      received: {},
    };
    writeSyncState(state);
    const reloaded = readSyncState("/Users/sascha/Projects/foo");
    expect(reloaded.peers["peer-1"].sent["local-session-1"].headEntryUuid).toBe("uuid-42");
  });

  it("writeSyncState is atomic (tmp + rename)", async () => {
    const { readSyncState, writeSyncState, syncStatePath } = await import("../src/sync-state.js");
    const state = readSyncState("/Users/sascha/Projects/foo");
    writeSyncState(state);
    const p = syncStatePath("/Users/sascha/Projects/foo");
    expect(existsSync(p)).toBe(true);
    expect(existsSync(p + ".tmp")).toBe(false);
  });

  it("readSyncState rejects a file with null peers and recovers to default", async () => {
    const { readSyncState, syncStatePath } = await import("../src/sync-state.js");
    const p = syncStatePath("/Users/sascha/Projects/foo");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".claude-sesh-mover", "sync-state"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ projectPath: "/Users/sascha/Projects/foo", schemaVersion: 1, peers: null, lineage: {} }),
      "utf-8"
    );
    const state = readSyncState("/Users/sascha/Projects/foo");
    expect(state.peers).toEqual({});
    expect(existsSync(p)).toBe(false); // renamed aside
  });

  it("readSyncState recovers from a corrupt file by renaming and returning default", async () => {
    const { readSyncState, syncStatePath } = await import("../src/sync-state.js");
    const p = syncStatePath("/Users/sascha/Projects/foo");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".claude-sesh-mover", "sync-state"), { recursive: true });
    writeFileSync(p, "{not json", "utf-8");
    const state = readSyncState("/Users/sascha/Projects/foo");
    expect(state.peers).toEqual({});
    const renamed = existsSync(p) ? false : true;
    expect(renamed).toBe(true);
  });

  it("recordSentFromBundle records head uuids from the bundle snapshot, not the live file", async () => {
    const { recordSentFromBundle, readSyncState } = await import("../src/sync-state.js");
    const { writeManifest } = await import("../src/manifest.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");

    const bundleDir = join(tempHome, "bundle");
    mkdirSync(join(bundleDir, "sessions"), { recursive: true });
    writeFileSync(
      join(bundleDir, "sessions", "sess-1.jsonl"),
      '{"uuid":"snap-head"}\n'
    );
    writeManifest(bundleDir, {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: "2026-07-13T00:00:00Z",
      sourcePlatform: "linux",
      sourceProjectPath: "/p",
      sourceConfigDir: "/c",
      sourceClaudeVersion: "2.1.114",
      sessionScope: "all",
      includedLayers: ["jsonl"],
      sessions: [
        {
          sessionId: "sess-1",
          slug: "s",
          summary: "",
          createdAt: "",
          lastActiveAt: "",
          messageCount: 1,
          gitBranch: "",
          entrypoint: "cli",
          integrityHash: "sha256:x",
          type: "full",
        },
      ],
      sourceMachineId: "me",
      sourceMachineName: "me-name",
      incremental: true,
      baseline: { targetMachineId: "peer-1", targetMachineName: "peer-one" },
    });

    // Simulate the live session having grown AFTER the snapshot was taken:
    // recordSentFromBundle must NOT see this (old code read the live file).
    recordSentFromBundle("/p", { id: "peer-1", name: "peer-one" }, bundleDir);

    const state = readSyncState("/p");
    expect(state.peers["peer-1"].sent["sess-1"].headEntryUuid).toBe("snap-head");
    expect(state.peers["peer-1"].sent["sess-1"].sentAsSessionId).toBe("sess-1");
    expect(state.peers["peer-1"].lastSentAt).not.toBeNull();
  });

  it("recordSentFromBundle maps continuation entries back to the local session id", async () => {
    const { recordSentFromBundle, readSyncState } = await import("../src/sync-state.js");
    const { writeManifest } = await import("../src/manifest.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");

    const bundleDir = join(tempHome, "bundle-cont");
    mkdirSync(join(bundleDir, "sessions"), { recursive: true });
    writeFileSync(
      join(bundleDir, "sessions", "cont-9.jsonl"),
      '{"uuid":"header"}\n{"uuid":"tail-uuid"}\n'
    );
    writeManifest(bundleDir, {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: "2026-07-13T00:00:00Z",
      sourcePlatform: "linux",
      sourceProjectPath: "/p",
      sourceConfigDir: "/c",
      sourceClaudeVersion: "2.1.114",
      sessionScope: "all",
      includedLayers: ["jsonl"],
      sessions: [
        {
          sessionId: "cont-9",
          slug: "s",
          summary: "continuation of s",
          createdAt: "",
          lastActiveAt: "",
          messageCount: 2,
          gitBranch: "",
          entrypoint: "cli",
          integrityHash: "sha256:y",
          type: "continuation",
          continuation: {
            continuesLocalSessionId: "local-orig",
            fromEntryIndex: 5,
            fromEntryUuid: "tail-uuid",
          },
        },
      ],
      sourceMachineId: "me",
      incremental: true,
      baseline: { targetMachineId: "peer-1" },
    });

    recordSentFromBundle("/p", { id: "peer-1" }, bundleDir);
    const state = readSyncState("/p");
    // Keyed by the LOCAL session id, sentAs the bundle's continuation id
    expect(state.peers["peer-1"].sent["local-orig"].sentAsSessionId).toBe("cont-9");
    expect(state.peers["peer-1"].sent["local-orig"].headEntryUuid).toBe("tail-uuid");
  });
});
