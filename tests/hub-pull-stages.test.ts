import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageOk, stageSkip, stageRefuse } from "../src/hub/pull-stages.js";
import { initApplyState } from "../src/hub/pull-apply-state.js";
import { createFsBackend } from "../src/hub/backend.js";
import { readMachineIndex } from "../src/hub/index-file.js";
import { runRecordStage, type RecordApplyView } from "../src/hub/pull-record.js";
import { encodeProjectPath } from "../src/platform.js";
import { readSyncState, writeSyncState } from "../src/sync-state.js";
import { bundle, peer, syncState } from "./helpers/hub-fixtures.js";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";

describe("stage outcome constructors", () => {
  it("stageOk carries the value and defaults to no reasons", () => {
    const o = stageOk({ count: 2 });
    expect(o.status).toBe("applied");
    expect(o.value).toEqual({ count: 2 });
    expect(o.reasons).toEqual([]);
  });

  it("stageOk keeps reasons alongside an applied value", () => {
    const o = stageOk({ count: 2 }, ["1 bundle unreachable"]);
    expect(o.status).toBe("applied");
    expect(o.reasons).toEqual(["1 bundle unreachable"]);
  });

  it("stageSkip and stageRefuse carry no value and exactly one reason", () => {
    const s = stageSkip<{ count: number }>("nothing to do");
    const r = stageRefuse<{ count: number }>("target not empty");
    expect(s.status).toBe("skipped");
    expect(s.value).toBeNull();
    expect(s.reasons).toEqual(["nothing to do"]);
    expect(r.status).toBe("refused");
    expect(r.value).toBeNull();
    expect(r.reasons).toEqual(["target not empty"]);
  });
});

describe("initApplyState", () => {
  it("starts every accumulator empty", () => {
    const st = initApplyState({ needed: [bundle({ bundleId: "b0" })] });
    expect(st.appended).toEqual([]);
    expect(st.importedSessions).toEqual([]);
    expect(st.skippedSessions).toEqual([]);
    expect(st.chainWorkspaceBases).toEqual([]);
    expect(st.ourWritesFrom.size).toBe(0);
    expect(st.lastAppliedIndex).toBe(-1);
    expect(st.abortIndex).toBe(-1);
    expect(st.deferredBundles).toBe(0);
    expect(st.divergenceAborted).toBe(false);
    expect(st.skippedByDivergence).toBe(false);
    expect(st.lastCarry).toBeNull();
    expect(st.lastImportedNewId).toBeNull();
    expect(st.lastBundleManifest).toBeNull();
    expect(st.threadLandedSessionId).toBeNull();
    expect(st.lastDivergence).toBeUndefined();
    expect(st.workspaceUnpacked).toBeNull();
    expect(st.workspaceMerge).toBeUndefined();
    expect(st.workspaceRefused).toBeUndefined();
    expect(st.workspaceDeclaredMissing).toBeUndefined();
  });

  it("points workspaceBundleIndex at the NEWEST bundle carrying a payload", () => {
    const st = initApplyState({
      needed: [
        bundle({ bundleId: "b0", hasWorkspace: true }),
        bundle({ bundleId: "b1", hasWorkspace: true }),
        bundle({ bundleId: "b2", hasWorkspace: false }),
      ],
    });
    expect(st.workspaceBundleIndex).toBe(1);
  });

  it("falls back to index 0 when no bundle in the chain claims a payload", () => {
    const st = initApplyState({
      needed: [bundle({ bundleId: "b0" }), bundle({ bundleId: "b1" })],
    });
    expect(st.workspaceBundleIndex).toBe(0);
  });

  /**
   * The whole point of the extraction: one MUTABLE object passed by reference.
   * `describeApplied` must see pushes made after construction — a value-copy
   * refactor would still typecheck and would silently report "nothing landed"
   * in the divergence warnings.
   */
  it("is mutable state whose closures observe writes made after construction", () => {
    const st = initApplyState({ needed: [bundle()] });
    expect(st.describeApplied(0)).toBe("");
    st.importedSessions.push({ originalId: "a", newId: "b", slug: "s", messageCount: 1 });
    expect(st.describeApplied(1)).toBe(
      "the 1 earlier bundle in this chain was already applied and recorded (1 session imported)"
    );
    st.appended.push({ threadId: "t", baseSessionId: "s1", entriesAppended: 2 });
    st.skippedSessions.push({ originalId: "c", reason: "duplicate" });
    expect(st.describeApplied(2)).toBe(
      "the 2 earlier bundles in this chain were already applied and recorded " +
        "(2 entries spliced into session s1, 1 session imported, 1 session already present)"
    );
  });

  it("describeApplied names the gap when the earlier bundles landed nothing", () => {
    const st = initApplyState({ needed: [bundle()] });
    expect(st.describeApplied(3)).toBe(
      "the 3 earlier bundles in this chain were already applied and recorded (no session content landed from them)"
    );
  });

  it("rememberOurWrite keeps the earliest offset per path", () => {
    const st = initApplyState({ needed: [bundle()] });
    st.rememberOurWrite("/a.jsonl", 500);
    st.rememberOurWrite("/a.jsonl", 120);
    st.rememberOurWrite("/a.jsonl", 900);
    st.rememberOurWrite("/b.jsonl", 7);
    expect(st.ourWritesFrom.get("/a.jsonl")).toBe(120);
    expect(st.ourWritesFrom.get("/b.jsonl")).toBe(7);
  });
});

/**
 * "Nothing has happened yet" for the nine accumulators the record stage reads —
 * the shape a pull that applied nothing hands over.
 */
function applyView(over: Partial<RecordApplyView> = {}): RecordApplyView {
  return {
    lastAppliedIndex: -1,
    divergenceAborted: false,
    abortIndex: -1,
    lastBundleManifest: null,
    threadLandedSessionId: null,
    skippedByDivergence: false,
    importedSessions: [],
    skippedSessions: [],
    appended: [],
    ...over,
  };
}

describe("record stage", () => {
  let root: string;
  let home: HomeOverrideHandle;
  let hubDir: string;
  let configDir: string;
  let projectPath: string;

  const SESSION_ID = "11111111-2222-3333-4444-555555555555";
  const HEAD_UUID = "entry-2";

  /** A minimal but realistic local transcript `discoverSessions` will list. */
  function writeLocalSession(sessionId: string, headUuid: string): void {
    const dir = join(configDir, "projects", encodeProjectPath(projectPath));
    mkdirSync(dir, { recursive: true });
    const common = { sessionId, cwd: projectPath, version: "2.1.81", gitBranch: "main", slug: "record-stage" };
    const entries = [
      {
        ...common,
        uuid: "entry-1",
        parentUuid: null,
        timestamp: "2026-08-01T10:00:00.000Z",
        type: "user",
        message: { role: "user", content: "hello" },
      },
      {
        ...common,
        uuid: headUuid,
        parentUuid: "entry-1",
        timestamp: "2026-08-01T10:01:00.000Z",
        type: "assistant",
        message: { model: "claude-opus-4-6", id: "msg_1", content: [{ type: "text", text: "hi" }] },
      },
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  }

  function input(over: { needed?: ReturnType<typeof bundle>[]; apply?: RecordApplyView } = {}) {
    return {
      backend: createFsBackend(hubDir),
      configDir,
      effectiveProjectPath: projectPath,
      projectId: "p1",
      machineId: "m1",
      hubId: "h1",
      threadId: "t1",
      sourceMachineId: "m2",
      needed: over.needed ?? [bundle({ bundleId: "b0", sessionIdInBundle: "remote-a" })],
      apply: over.apply ?? applyView(),
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sm-record-"));
    mkdirSync(join(root, "home"), { recursive: true });
    home = overrideHome(join(root, "home"));
    hubDir = join(root, "hub");
    configDir = join(root, "config");
    mkdirSync(hubDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    projectPath = join(root, "proj");
  });

  afterEach(() => {
    home.restore();
    rmSync(root, { recursive: true, force: true });
  });

  it("maps the thread onto the session this pull landed and republishes the index", async () => {
    writeLocalSession(SESSION_ID, HEAD_UUID);
    const backend = createFsBackend(hubDir);

    const out = await runRecordStage({
      ...input({ apply: applyView({ lastAppliedIndex: 0, threadLandedSessionId: SESSION_ID }) }),
      backend,
    });

    expect(out.status).toBe("applied");
    expect(out.reasons).toEqual([]);
    expect(out.value).toEqual({ localSessionId: SESSION_ID, indexWritten: true });

    // The sync-state mapping is written before the projection reads it, so the
    // published index has to name the thread this pull just landed.
    expect(readSyncState(projectPath).hub?.threadByLocalSession[SESSION_ID]).toBe("t1");
    const written = await readMachineIndex(backend, "p1", "m1");
    expect(written).not.toBeNull();
    expect(written?.threads["t1"]).toMatchObject({
      localSessionId: SESSION_ID,
      headEntryUuid: HEAD_UUID,
    });
  });

  /**
   * `discoverSessions` runs INSIDE the stage, after the apply loop — a session
   * that only exists because this pull imported it must still reach the index.
   */
  it("projects sessions that appeared during the pull, not a caller-hoisted list", async () => {
    const backend = createFsBackend(hubDir);
    // Nothing on disk when the stage's caller would have listed sessions...
    expect(await readMachineIndex(backend, "p1", "m1")).toBeNull();
    // ...and the transcript lands only now, as an apply step would have done.
    writeLocalSession(SESSION_ID, HEAD_UUID);

    const out = await runRecordStage(
      input({ apply: applyView({ lastAppliedIndex: 0, threadLandedSessionId: SESSION_ID }) })
    );

    expect(out.value?.indexWritten).toBe(true);
    const written = await readMachineIndex(backend, "p1", "m1");
    expect(Object.keys(written?.threads ?? {})).toEqual(["t1"]);
  });

  /**
   * The abort index names a bundle nobody opened, so the receipt ledger must be
   * asked about the last bundle this pull really handled.
   */
  it("asks the peer receipt ledger about the last bundle actually fetched", async () => {
    writeLocalSession(SESSION_ID, HEAD_UUID);
    writeSyncState({
      ...syncState({
        m2: peer({
          received: {
            "remote-a": { localSessionId: SESSION_ID, type: "full", importedAt: "2026-08-01T09:00:00.000Z" },
            "remote-b": { localSessionId: "never-this-one", type: "continuation", importedAt: "2026-08-01T09:30:00.000Z" },
          },
        }),
      }),
      projectPath,
    });

    const out = await runRecordStage(
      input({
        needed: [
          bundle({ bundleId: "b0", sessionIdInBundle: "remote-a" }),
          bundle({ bundleId: "b1", sessionIdInBundle: "remote-b" }),
        ],
        apply: applyView({ lastAppliedIndex: 0, divergenceAborted: true, abortIndex: 1 }),
      })
    );

    expect(out.value?.localSessionId).toBe(SESSION_ID);
  });

  /**
   * A pure divergence skip promises this pull applied and recorded NOTHING —
   * the index is part of that promise, and the skip warning is the only story
   * told about it.
   */
  it("leaves the index alone and stays silent on a pure divergence skip", async () => {
    writeLocalSession(SESSION_ID, HEAD_UUID);
    const backend = createFsBackend(hubDir);

    const out = await runRecordStage({
      ...input({ apply: applyView({ skippedByDivergence: true, divergenceAborted: true, abortIndex: 0 }) }),
      backend,
    });

    expect(out.status).toBe("applied");
    expect(out.reasons).toEqual([]);
    expect(out.value).toEqual({ localSessionId: null, indexWritten: false });
    expect(await readMachineIndex(backend, "p1", "m1")).toBeNull();
  });

  it("names the unidentified session when content landed but no id could be found", async () => {
    writeLocalSession(SESSION_ID, HEAD_UUID);

    const out = await runRecordStage(
      input({
        apply: applyView({
          lastAppliedIndex: 0,
          skippedSessions: [{ originalId: "remote-a", reason: "duplicate" }],
        }),
      })
    );

    expect(out.status).toBe("applied");
    expect(out.value?.localSessionId).toBeNull();
    expect(out.value?.indexWritten).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toContain("its session could not be identified");
  });
});
