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
});
