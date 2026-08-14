import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageOk, stageSkip, stageRefuse, stageAbort } from "../src/hub/pull-stages.js";
import type { ErrorResult } from "../src/types.js";
import { initApplyState } from "../src/hub/pull-apply-state.js";
import { createFsBackend } from "../src/hub/backend.js";
import { readMachineIndex } from "../src/hub/index-file.js";
import { localProjectIdPath, writeLocalProjectId } from "../src/hub/identity.js";
import { HUB_JSON, indexPath, projectJsonPath } from "../src/hub/layout.js";
import { runRecordStage, type RecordApplyView } from "../src/hub/pull-record.js";
import { runResolveStage } from "../src/hub/pull-resolve.js";
import { encodeProjectPath } from "../src/platform.js";
import { readSyncState, writeSyncState } from "../src/sync-state.js";
import { bundle, entry, idx, peer, syncState } from "./helpers/hub-fixtures.js";
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

  /**
   * The workspace stage's no-ancestor skip emits `chooseMergeAncestor`'s 0..k
   * degradation reasons PLUS the no-common-point sentence — a list, in order,
   * from two sources.
   */
  it("stageSkip accepts a list of reasons and keeps their order", () => {
    const s = stageSkip<{ count: number }>([
      "bundle b1 was not fetchable",
      "no workspace generation is common to both trees",
    ]);
    expect(s.status).toBe("skipped");
    expect(s.value).toBeNull();
    expect(s.reasons).toEqual([
      "bundle b1 was not fetchable",
      "no workspace generation is common to both trees",
    ]);
  });

  /**
   * The common gate-false no-op — no workspace payload in the chain at all —
   * is not a story worth telling the user, so it must emit ZERO reasons.
   */
  it("stageSkip accepts an empty reason list", () => {
    const s = stageSkip<{ count: number }>([]);
    expect(s.status).toBe("skipped");
    expect(s.value).toBeNull();
    expect(s.reasons).toEqual([]);
  });

  it("stageSkip can carry a value for a skip that still has a shape to hand back", () => {
    const s = stageSkip<{ count: number }>([], { count: 0 });
    expect(s.status).toBe("skipped");
    expect(s.value).toEqual({ count: 0 });
    expect(s.reasons).toEqual([]);
  });

  it("stageSkip does not mutate a caller's reason array", () => {
    const reasons = ["one"];
    const s = stageSkip<{ count: number }>(reasons);
    s.reasons.push("two");
    expect(reasons).toEqual(["one"]);
  });

  /**
   * `aborted` is the opposite of `refused`: the pull STOPS and `terminal` is
   * the ErrorResult hubPull returns verbatim. Conflating the two would let a
   * caller continue past a workspace abort, importing sessions and recording
   * the bundle.
   */
  it("stageAbort carries the terminal ErrorResult and echoes its message as the reason", () => {
    const terminal: ErrorResult = {
      success: false,
      command: "hub-pull",
      error: "target project directory is not empty",
      suggestion: "re-run with --force-workspace",
    };
    const a = stageAbort<{ count: number }>(terminal);
    expect(a.status).toBe("aborted");
    expect(a.value).toBeNull();
    expect(a.reasons).toEqual(["target project directory is not empty"]);
    expect(a.terminal).toBe(terminal);
  });

  it("only an aborted outcome carries a terminal ErrorResult", () => {
    expect(stageOk({ count: 1 }).terminal).toBeUndefined();
    expect(stageSkip<{ count: number }>("nothing to do").terminal).toBeUndefined();
    expect(stageRefuse<{ count: number }>("target not empty").terminal).toBeUndefined();
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

describe("resolve stage", () => {
  let root: string;
  let home: HomeOverrideHandle;
  let hubDir: string;
  let projectPath: string;

  const HUB_ID = "hub-1";
  const PROJECT_ID = "hub-project-1";
  const CANDIDATE = { projectId: PROJECT_ID, name: "atlas", gitRemotes: ["github.com/acme/atlas"] };

  /** Write one hub-relative file, creating its directories. */
  function writeHubFile(rel: string, body: unknown): void {
    const p = join(hubDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf-8");
  }

  function input(over: { projectIdOverride?: string } = {}) {
    return {
      backend: createFsBackend(hubDir),
      projectPath,
      hubPath: hubDir,
      ...over,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sm-resolve-"));
    mkdirSync(join(root, "home"), { recursive: true });
    home = overrideHome(join(root, "home"));
    hubDir = join(root, "hub");
    projectPath = join(root, "proj");
    mkdirSync(projectPath, { recursive: true });
    writeHubFile(HUB_JSON, { schemaVersion: 1, hubId: HUB_ID, createdAt: "2026-08-01T00:00:00.000Z" });
    writeHubFile(projectJsonPath(PROJECT_ID), {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      name: CANDIDATE.name,
      matchers: { gitRemotes: CANDIDATE.gitRemotes },
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByMachine: "m2",
    });
  });

  afterEach(() => {
    home.restore();
    rmSync(root, { recursive: true, force: true });
  });

  /** One other machine's index, listing a single thread. */
  function writePeerIndex(machineId = "m2", threadId = "t-1"): void {
    writeHubFile(
      indexPath(PROJECT_ID, machineId),
      idx(machineId, {
        [threadId]: entry({
          localSessionId: `local-${machineId}`,
          headEntryUuid: "head-b0",
          bundles: [bundle({ bundleId: "b0" })],
        }),
      })
    );
  }

  /**
   * THE reason this stage does not use `StageOutcome`.
   *
   * `stageRefuse` carries `value: null` and a list of strings, so routing the
   * unlinked escape through it destroys `linkCandidates` — the structured list
   * `/sesh-mover:pull` reads to offer the user a hub project to link to. The
   * assertion is deliberately `toEqual` on the whole result: the stage hands
   * back the FINISHED `HubUnlinkedResult`, not ingredients for the caller to
   * rebuild one out of.
   */
  it("returns the finished HubUnlinkedResult, candidates intact, when the project is unlinked", async () => {
    const out = await runResolveStage(input());

    expect(out.kind).toBe("return");
    if (out.kind !== "return") return;
    expect(out.result).toEqual({
      success: false,
      command: "pull",
      reason: "unlinked",
      linkCandidates: [CANDIDATE],
      suggestion: "Pass --project-id <id> to link to an existing hub project.",
    });
    // The escape happens BEFORE registerMachine, and it links nothing.
    expect(existsSync(join(hubDir, "machines"))).toBe(false);
    expect(existsSync(localProjectIdPath(projectPath))).toBe(false);
  });

  /**
   * `hub` and `hubPeerId` are read at seven sites below the extracted range
   * (thread mapping, workspace generations, the hub-peer receipt ledger), so a
   * value of just `{ local, resolved }` would not compile at the call site.
   */
  it("proceeds with the linked identity, the hub record, its peer id and the resolved threads", async () => {
    writeLocalProjectId(projectPath, {
      projectId: PROJECT_ID, name: CANDIDATE.name,
      createdAt: "2026-08-01T00:00:00.000Z", createdByMachine: "m2",
    });
    writePeerIndex();

    const out = await runResolveStage(input());

    expect(out.kind).toBe("proceed");
    if (out.kind !== "proceed") return;
    expect(out.reasons).toEqual([]);
    expect(out.value.local.projectId).toBe(PROJECT_ID);
    expect(out.value.hub.hubId).toBe(HUB_ID);
    expect(out.value.hubPeerId).toBe(`hub:${HUB_ID}`);
    expect(out.value.resolved.map((t) => t.threadId)).toEqual(["t-1"]);
    expect(out.value.resolved[0].latest.machineId).toBe("m2");
    // registerMachine runs on this path only — one file, this machine's.
    expect(readdirSync(join(hubDir, "machines"))).toHaveLength(1);
  });

  it("links via --project-id without consulting the identity resolver", async () => {
    writePeerIndex();

    const out = await runResolveStage(input({ projectIdOverride: PROJECT_ID }));

    expect(out.kind).toBe("proceed");
    if (out.kind !== "proceed") return;
    expect(out.value.local).toMatchObject({ projectId: PROJECT_ID, name: CANDIDATE.name });
    expect(existsSync(localProjectIdPath(projectPath))).toBe(true);
    expect(out.value.resolved).toHaveLength(1);
  });

  /**
   * `readAllIndexes`'s warnings are the stage's `reasons` — the caller spreads
   * them into `warnings` at the point the old inline `warnings.push` sat, so a
   * corrupt peer index still reaches the user.
   */
  it("folds readAllIndexes warnings into reasons", async () => {
    writeLocalProjectId(projectPath, {
      projectId: PROJECT_ID, name: CANDIDATE.name,
      createdAt: "2026-08-01T00:00:00.000Z", createdByMachine: "m2",
    });
    writePeerIndex();
    mkdirSync(dirname(join(hubDir, indexPath(PROJECT_ID, "m3"))), { recursive: true });
    writeFileSync(join(hubDir, indexPath(PROJECT_ID, "m3")), "{ not json", "utf-8");

    const out = await runResolveStage(input());

    expect(out.kind).toBe("proceed");
    if (out.kind !== "proceed") return;
    expect(out.reasons).toEqual([
      "index file for machine m3 is unreadable (corrupt or not yet synced) — skipped.",
    ]);
    expect(out.value.resolved).toHaveLength(1);
  });

  /**
   * No `try`/`catch` anywhere in the stage: "the hub path is not a hub" must
   * keep escaping to cli.ts, which is what turns it into an ErrorResult. A
   * stage that swallowed it would report `unlinked` for a mistyped hub path.
   */
  it("lets a non-hub path throw instead of reporting it as unlinked", async () => {
    writeLocalProjectId(projectPath, {
      projectId: PROJECT_ID, name: CANDIDATE.name,
      createdAt: "2026-08-01T00:00:00.000Z", createdByMachine: "m2",
    });
    rmSync(join(hubDir, HUB_JSON));

    await expect(runResolveStage(input())).rejects.toThrow();
  });
});
