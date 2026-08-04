import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";

describe("sync-state", () => {
  let tempHome: string;
  let homeOverride: HomeOverrideHandle;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-sync-test-"));
    homeOverride = overrideHome(tempHome);
  });

  afterEach(() => {
    homeOverride.restore();
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

  it("readSyncState defaults a missing imported map to {} (pre-0.3.0 files)", async () => {
    const { readSyncState, syncStatePath } = await import("../src/sync-state.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const p = syncStatePath("/Users/sascha/Projects/foo");
    mkdirSync(join(tempHome, ".claude-sesh-mover", "sync-state"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ projectPath: "/Users/sascha/Projects/foo", schemaVersion: 1, peers: {}, lineage: {} }),
      "utf-8"
    );
    const state = readSyncState("/Users/sascha/Projects/foo");
    expect(state.imported).toEqual({});
  });

  it("readSyncState defaults legacy imported entries to registered: true", async () => {
    const { readSyncState, syncStatePath } = await import("../src/sync-state.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const p = syncStatePath("/Users/sascha/Projects/foo");
    mkdirSync(join(tempHome, ".claude-sesh-mover", "sync-state"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        projectPath: "/Users/sascha/Projects/foo",
        schemaVersion: 1,
        peers: {},
        lineage: {},
        imported: { "sha256:legacy": { localSessionId: "x", importedAt: "2026-07-13T00:00:00Z" } },
      }),
      "utf-8"
    );
    const state = readSyncState("/Users/sascha/Projects/foo");
    expect(state.imported["sha256:legacy"].registered).toBe(true);
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

  // Regression (Task 12 integration test): hub pull imports content whose
  // manifest.sourceMachineId is the ORIGINATING machine, never the hub
  // itself — so importSession's own peer bookkeeping (see importer.ts) never
  // credits the hub's symbolic peer id. Without this, a machine's first push
  // back to the hub after a pull always re-uploads the whole session as
  // "full" (hub/push.ts's incremental diff only ever consults
  // state.peers[hubPeerId]?.sent), defeating incremental sync entirely for
  // any machine that joined via pull before ever pushing.
  it("recordSentToPeer marks a freshly-imported local session as already known to a given peer", async () => {
    const { recordSentToPeer, readSyncState } = await import("../src/sync-state.js");
    recordSentToPeer("/p", { id: "hub:abc", name: "hub" }, "local-new", {
      headEntryUuid: "entry-3",
      messageCount: 3,
      sentAsType: "full",
      sentAsSessionId: "orig-session",
    });
    const state = readSyncState("/p");
    expect(state.peers["hub:abc"].sent["local-new"]).toEqual({
      headEntryUuid: "entry-3",
      messageCount: 3,
      sentAsType: "full",
      sentAsSessionId: "orig-session",
    });
  });

  it("recordSentToPeer preserves an existing peer's other bookkeeping (received, prior sent entries)", async () => {
    const { recordSentToPeer, readSyncState, writeSyncState } = await import("../src/sync-state.js");
    const state = readSyncState("/p2");
    state.peers["hub:abc"] = {
      name: "hub", lastSentAt: null, lastReceivedAt: "2026-07-01T00:00:00Z",
      sent: { "other-session": { headEntryUuid: "u1", messageCount: 1, sentAsType: "full", sentAsSessionId: "other-session" } },
      received: { "remote-1": { localSessionId: "local-1", type: "full", importedAt: "2026-07-01T00:00:00Z" } },
    };
    writeSyncState(state);

    recordSentToPeer("/p2", { id: "hub:abc" }, "local-new", {
      headEntryUuid: "entry-3", messageCount: 3, sentAsType: "full", sentAsSessionId: "orig-session",
    });

    const reloaded = readSyncState("/p2");
    expect(reloaded.peers["hub:abc"].sent["other-session"].headEntryUuid).toBe("u1");
    expect(reloaded.peers["hub:abc"].received["remote-1"].localSessionId).toBe("local-1");
    expect(reloaded.peers["hub:abc"].lastReceivedAt).toBe("2026-07-01T00:00:00Z");
    expect(reloaded.peers["hub:abc"].sent["local-new"].headEntryUuid).toBe("entry-3");
  });
});

describe("sync-state v2 (hub)", () => {
  let tempHome: string;
  let homeOverride: HomeOverrideHandle;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-sync-test-"));
    homeOverride = overrideHome(tempHome);
  });

  afterEach(() => {
    homeOverride.restore();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("reads v1 files unchanged and keeps them v1 on write when hub is untouched", async () => {
    const { readSyncState, writeSyncState } = await import("../src/sync-state.js");
    // arrange: use the file's existing temp-home pattern (overrideHome) and
    // write a v1 state file via writeSyncState with no hub key
    const s = readSyncState("/tmp/proj-v2-a");
    expect(s.schemaVersion).toBe(1);
    writeSyncState(s);
    expect(readSyncState("/tmp/proj-v2-a").schemaVersion).toBe(1);
  });

  it("setThreadId initializes hub section, bumps to v2, round-trips", async () => {
    const { readSyncState, writeSyncState, setThreadId, getThreadId } = await import("../src/sync-state.js");
    const s = readSyncState("/tmp/proj-v2-b");
    expect(getThreadId(s, "sess-1")).toBeNull();
    setThreadId(s, "hub-1", "sess-1", "thread-1");
    expect(s.schemaVersion).toBe(2);
    expect(s.hub?.hubId).toBe("hub-1");
    writeSyncState(s);
    const again = readSyncState("/tmp/proj-v2-b");
    expect(again.schemaVersion).toBe(2);
    expect(getThreadId(again, "sess-1")).toBe("thread-1");
  });

  it("setLastWorkspace records the generation and round-trips", async () => {
    const { readSyncState, writeSyncState, setLastWorkspace } = await import("../src/sync-state.js");
    const s = readSyncState("/tmp/proj-lw");
    expect(s.hub?.lastWorkspace).toBeUndefined();
    setLastWorkspace(s, "hub-1", {
      bundleId: "bundle-1",
      file: "projects/p/bundles/m/x.tar.gz",
      pushedAt: "2026-04-11T10:00:00.000Z",
    });
    expect(s.schemaVersion).toBe(2);
    expect(s.hub?.hubId).toBe("hub-1");
    expect(s.hub?.lastWorkspace?.bundleId).toBe("bundle-1");
    // pushedAt dates the GENERATION and is passed in; syncedAt dates our
    // knowledge of it and is stamped here. Both are diagnostics — no decision
    // reads either — but conflating them would destroy the only record of when
    // the bundle was actually published.
    expect(s.hub?.lastWorkspace?.pushedAt).toBe("2026-04-11T10:00:00.000Z");
    expect(s.hub?.lastWorkspace?.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.hub?.lastWorkspace?.syncedAt).not.toBe(s.hub?.lastWorkspace?.pushedAt);
    writeSyncState(s);
    expect(readSyncState("/tmp/proj-lw").hub?.lastWorkspace?.file).toBe(
      "projects/p/bundles/m/x.tar.gz"
    );
  });

  it("setLastWorkspace never disturbs existing thread mappings, and is overwritten by a newer generation", async () => {
    const { readSyncState, writeSyncState, setLastWorkspace, setThreadId, getThreadId } =
      await import("../src/sync-state.js");
    const s = readSyncState("/tmp/proj-lw2");
    setThreadId(s, "hub-1", "sess-1", "thread-1");
    setLastWorkspace(s, "hub-1", {
      bundleId: "bundle-1", file: "projects/p/bundles/m/1.tar.gz",
      pushedAt: "2026-04-11T10:00:00.000Z",
    });
    writeSyncState(s);

    const again = readSyncState("/tmp/proj-lw2");
    expect(getThreadId(again, "sess-1")).toBe("thread-1");
    setLastWorkspace(again, "hub-1", {
      bundleId: "bundle-2", file: "projects/p/bundles/m/2.tar.gz",
      pushedAt: "2026-04-12T10:00:00.000Z",
    });
    writeSyncState(again);

    const final = readSyncState("/tmp/proj-lw2");
    expect(getThreadId(final, "sess-1")).toBe("thread-1");
    expect(final.hub?.lastWorkspace).toEqual({
      bundleId: "bundle-2",
      file: "projects/p/bundles/m/2.tar.gz",
      pushedAt: "2026-04-12T10:00:00.000Z",
      syncedAt: expect.any(String),
    });
    // The head is replaced, but the generation it replaced is REMEMBERED: that
    // history is what lets a pull tell "the peer built on something we held"
    // from "the peer built on a stranger", which the head alone cannot answer.
    expect(final.hub?.workspaceGenerations?.map((g) => g.bundleId))
      .toEqual(["bundle-2", "bundle-1"]);
  });

  it("knownWorkspaceGenerations is most-recent-first, deduped, and bounded", async () => {
    const { readSyncState, setLastWorkspace, knownWorkspaceGenerations, MAX_WORKSPACE_GENERATIONS } =
      await import("../src/sync-state.js");
    const s = readSyncState("/tmp/proj-lw3");
    expect(knownWorkspaceGenerations(s)).toEqual([]);

    for (let n = 1; n <= MAX_WORKSPACE_GENERATIONS + 5; n++) {
      setLastWorkspace(s, "hub-1", {
        bundleId: `b${n}`, file: `projects/p/bundles/m/${n}.tar.gz`,
        pushedAt: `2026-04-11T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
      });
    }
    const known = knownWorkspaceGenerations(s);
    expect(known).toHaveLength(MAX_WORKSPACE_GENERATIONS);
    expect(known[0]!.bundleId).toBe(`b${MAX_WORKSPACE_GENERATIONS + 5}`);
    // Oldest entries fall off the end, never the newest — a forgotten
    // generation costs a merge, a forgotten HEAD would cost the tree's identity.
    expect(known.at(-1)!.bundleId).toBe("b6");

    // Re-applying a generation we already hold moves it to the head instead of
    // taking a second slot.
    setLastWorkspace(s, "hub-1", {
      bundleId: "b40", file: "projects/p/bundles/m/40.tar.gz",
      pushedAt: "2026-04-11T10:00:40.000Z",
    });
    const after = knownWorkspaceGenerations(s);
    expect(after).toHaveLength(MAX_WORKSPACE_GENERATIONS);
    expect(after[0]!.bundleId).toBe("b40");
    expect(after.filter((g) => g.bundleId === "b40")).toHaveLength(1);
  });

  it("knownWorkspaceGenerations leads with lastWorkspace when the list predates it", async () => {
    // A state file written before the list existed (or hand-edited) still has a
    // head, and it must still be offered as a candidate — otherwise a machine
    // upgrading mid-project would silently lose its only known generation.
    const { readSyncState, knownWorkspaceGenerations } = await import("../src/sync-state.js");
    const s = readSyncState("/tmp/proj-lw4");
    s.hub = {
      hubId: "hub-1",
      threadByLocalSession: {},
      lastWorkspace: {
        bundleId: "legacy", file: "projects/p/bundles/m/legacy.tar.gz",
        syncedAt: "2026-04-11T10:00:00.000Z",
      },
    };
    expect(knownWorkspaceGenerations(s).map((g) => g.bundleId)).toEqual(["legacy"]);
  });

  it("v2 files with unknown extra fields still read (forward tolerance)", async () => {
    const { readSyncState, writeSyncState, setThreadId } = await import("../src/sync-state.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { syncStatePath } = await import("../src/sync-state.js");

    // arrange: write a v2 state with hub section
    const s = readSyncState("/tmp/proj-v2-c");
    setThreadId(s, "hub-1", "sess-1", "thread-1");
    writeSyncState(s);

    // act: JSON-edit the file on disk to add unknown field {"future":"x"}
    const p = syncStatePath("/tmp/proj-v2-c");
    const fileContent = readFileSync(p, "utf-8");
    const parsed = JSON.parse(fileContent);
    parsed.future = "x";
    writeFileSync(p, JSON.stringify(parsed, null, 2) + "\n", "utf-8");

    // assert: schemaVersion 2 and thread mapping intact
    const reread = readSyncState("/tmp/proj-v2-c");
    expect(reread.schemaVersion).toBe(2);
    expect(reread.hub?.threadByLocalSession["sess-1"]).toBe("thread-1");
  });
});
