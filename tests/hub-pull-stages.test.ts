import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageOk, stageSkip, stageRefuse, stageAbort } from "../src/hub/pull-stages.js";
import type {
  ErrorResult, ExportManifest, HubPullFindings, HubPullResult,
} from "../src/types.js";
import { initApplyState, type PulledCarry } from "../src/hub/pull-apply-state.js";
import { runApplyCarryStage } from "../src/hub/pull-apply-carry.js";
import { createFsBackend } from "../src/hub/backend.js";
import type { HubBackend } from "../src/hub/backend.js";
import { readMachineIndex } from "../src/hub/index-file.js";
import { localProjectIdPath, writeLocalProjectId } from "../src/hub/identity.js";
import {
  HUB_JSON, bundleDir, bundleFileName, indexPath, machinePath, projectJsonPath,
  type HubBundleRecord, type HubIndexJson,
} from "../src/hub/layout.js";
import type { CarryMeta } from "../src/hub/carry.js";
import { runFetchStage } from "../src/hub/pull-fetch.js";
import { runRecordStage, type RecordApplyView } from "../src/hub/pull-record.js";
import { runResolveStage } from "../src/hub/pull-resolve.js";
import {
  runSelectStage, type SelectOutcome, type SelectReport, type SourcedBundle,
} from "../src/hub/pull-select.js";
import { resolveThreads } from "../src/hub/threads.js";
import { createArchive } from "../src/archiver.js";
import { computeIntegrityHashFromFile, writeManifest } from "../src/manifest.js";
import { encodeProjectPath } from "../src/platform.js";
import { projectSeshMoverDir } from "../src/paths.js";
import {
  getThreadId, knownWorkspaceGenerations, readSyncState, setLastWorkspace, syncStatePath,
  writeSyncState,
} from "../src/sync-state.js";
import { runApplyWorkspaceStage } from "../src/hub/pull-apply-workspace.js";
import {
  runApplySessionsStage, type RecordSpliceInput,
} from "../src/hub/pull-apply-sessions.js";
import { hubInit } from "../src/hub/init.js";
import { hubPull, reportPullResult } from "../src/hub/pull.js";
import { hubPush } from "../src/hub/push.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { readLastEntryUuid } from "../src/jsonl.js";
import { setThreadId } from "../src/sync-state.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import {
  FIXTURE_ENCODED, FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID,
  arrangeDivergence, bundle, currentThreadIndexes, emptySyncState, entry, idx, makeLookLive, peer,
  syncState, writeCorruptBundle,
} from "./helpers/hub-fixtures.js";
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

  /** A plan entry: the bundle, plus the machine whose index listed it. */
  function sourced(machineId: string, over: Partial<HubBundleRecord> = {}): SourcedBundle {
    return { machineId, record: bundle(over) };
  }

  function input(over: { needed?: SourcedBundle[]; apply?: RecordApplyView } = {}) {
    return {
      backend: createFsBackend(hubDir),
      configDir,
      effectiveProjectPath: projectPath,
      projectId: "p1",
      machineId: "m1",
      hubId: "h1",
      threadId: "t1",
      needed: over.needed ?? [sourced("m2", { bundleId: "b0", sessionIdInBundle: "remote-a" })],
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
          sourced("m2", { bundleId: "b0", sessionIdInBundle: "remote-a" }),
          sourced("m2", { bundleId: "b1", sessionIdInBundle: "remote-b" }),
        ],
        apply: applyView({ lastAppliedIndex: 0, divergenceAborted: true, abortIndex: 1 }),
      })
    );

    expect(out.value?.localSessionId).toBe(SESSION_ID);
  });

  /**
   * THE THIRD SITE OF THE `sourceMachineId` RIPPLE (#35 Task 3).
   *
   * This lookup recovers the thread's local session when nothing landed in this
   * pull, and it has to ask the peer that SUPPLIED the last bundle. A plan drawn
   * from one machine cannot tell the two apart — every record's machine is the
   * pull's resolved machine — so the arrangement here is the one chain assembly
   * produces: the last handled bundle came from `m3` while the pull resolved to
   * `m2`, and `m2` holds a receipt for the SAME `sessionIdInBundle` pointing at
   * a different local session.
   *
   * Reaching for the resolved machine is not a miss here, it is a wrong answer:
   * the thread would be mapped onto `m2`'s session, and every later continuation
   * would splice onto the wrong transcript.
   */
  it("asks the receipt ledger of the machine that supplied the bundle, not the pull's source", async () => {
    writeLocalSession(SESSION_ID, HEAD_UUID);
    writeLocalSession("decoy-session-id", "entry-decoy");
    writeSyncState({
      ...syncState({
        m2: peer({
          received: {
            // Same key, wrong peer: the answer a scalar `sourceMachineId`
            // would have produced.
            "remote-b": {
              localSessionId: "decoy-session-id", type: "continuation",
              importedAt: "2026-08-01T09:00:00.000Z",
            },
          },
        }),
        m3: peer({
          received: {
            "remote-b": {
              localSessionId: SESSION_ID, type: "continuation",
              importedAt: "2026-08-01T09:30:00.000Z",
            },
          },
        }),
      }),
      projectPath,
    });

    const out = await runRecordStage(
      input({
        needed: [
          sourced("m2", { bundleId: "b0", sessionIdInBundle: "remote-a" }),
          sourced("m3", { bundleId: "b1", sessionIdInBundle: "remote-b" }),
        ],
        // Nothing landed in this pull, so `threadLandedSessionId` is null and
        // the receipt ledger is the branch that answers.
        apply: applyView({ lastAppliedIndex: 1 }),
      })
    );

    expect(out.value?.localSessionId).toBe(SESSION_ID);
    expect(getThreadId(readSyncState(projectPath), SESSION_ID)).toBe("t1");
    expect(getThreadId(readSyncState(projectPath), "decoy-session-id")).toBeNull();
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

  /**
   * THE REASON THE SELECT STAGE HAS A FOURTH EXIT INSTEAD OF AN EMPTY `proceed`.
   *
   * The cheap way to express "assembled the chain, found an anomaly, applied
   * nothing" is to relax the empty-plan gate and let `proceed` carry an empty
   * `needed`. Every stage below select tolerates a zero-length chain except this
   * one: `pull-record.ts` indexes the plan unconditionally, and for an empty
   * plan that index is `needed[-1]` (`lastAppliedIndex` starts at -1 and
   * `divergenceAborted` at false, so the expression falls through to
   * `needed.length - 1`).
   *
   * WHICH dereference throws, and the fact that it now throws UNCONDITIONALLY,
   * both moved with #35 Task 3 and the change is in the guard's favour. The
   * `undefined` plan entry used to be dereferenced first at its
   * `sessionIdInBundle`, as the computed KEY of
   * `peers[sourceMachineId]?.received?.[…]` — so it only threw when that peer
   * ledger happened to exist for the optional chain to run through. Strip the
   * receipts and the same empty plan sailed past, reporting a session it could
   * not identify and republishing the index for a pull that fetched nothing.
   *
   * With the plan carrying its own machine per record, the lookup is
   * `peers[last.machineId]`, so the entry is dereferenced to BUILD the key
   * rather than inside it, and no arrangement can short-circuit past it. The
   * `find` predicate above it still cannot fire — nothing sets
   * `lastBundleManifest` when the bundle loop never iterates — so the crash is
   * still this statement, one property earlier.
   *
   * Asserted, so the design note stays measured rather than remembered. If a
   * future guard makes an empty plan safe here, this test is where that is
   * discovered — it does not license removing the fourth arm, which also carries
   * the `success: true` semantics the gate cannot express.
   */
  it("throws on an empty fetch plan, which is why select may never hand one to proceed", async () => {
    writeLocalSession(SESSION_ID, HEAD_UUID);
    writeSyncState({
      ...emptySyncState(projectPath),
      peers: {
        m2: peer({
          received: {
            "remote-a": {
              localSessionId: SESSION_ID, type: "full", importedAt: "2026-08-01T00:00:00.000Z",
            },
          },
        }),
      },
    });

    // The message, not just the class: a bare `TypeError` would also be
    // satisfied by a crash somewhere else entirely, and the point of this test
    // is WHICH dereference fails.
    await expect(runRecordStage(input({ needed: [] }))).rejects.toThrow(
      /Cannot read properties of undefined \(reading 'machineId'\)/
    );

    // ...and with the peer ledger stripped it throws just the same, which is
    // the half that changed. The crash is no longer arrangement-dependent, so
    // an empty plan can no longer reach the index rewrite by accident.
    writeSyncState(emptySyncState(projectPath));
    await expect(runRecordStage(input({ needed: [] }))).rejects.toThrow(
      /Cannot read properties of undefined \(reading 'machineId'\)/
    );
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

describe("fetch stage", () => {
  let root: string;
  let hubDir: string;
  let tempRoot: string;
  let backend: HubBackend;

  const MACHINE_ID = "m2";

  /** A carry payload's metadata — only its presence and identity matter here. */
  const CARRY: CarryMeta = {
    baseCommit: "0".repeat(40),
    branch: "main",
    detached: false,
    inProgress: null,
    capturedAt: "2026-08-01T00:00:00.000Z",
    untrackedCount: 1,
    untrackedBytes: 12,
    patchBytes: 0,
    reIncludedCount: 0,
    reIncluded: [],
    trackedIgnoredCount: 0,
    trackedIgnored: [],
    repoPrefix: "",
  };

  /**
   * An INTACT bundle on the hub — a real `.tar.gz` whose manifest is stamped by
   * the real writer, so it passes every check this stage runs. The knobs are the
   * two things the stage acts on (a declared workspace generation, a carry) plus
   * the one damage shape `writeCorruptBundle` does not cover: a manifest that is
   * perfectly self-consistent while the transcript it names is absent.
   */
  async function writeHealthyBundle(
    over: {
      bundleId?: string;
      sessionId?: string;
      pushedAt?: string;
      basedOn?: string | null;
      carry?: boolean;
      omitSessionFile?: boolean;
    } = {}
  ): Promise<HubBundleRecord> {
    const bundleId = over.bundleId ?? "b0";
    const sessionId = over.sessionId ?? `sess-${bundleId}`;
    const pushedAt = over.pushedAt ?? "2026-08-01T00:00:00.000Z";

    const staging = mkdtempSync(join(root, "staging-"));
    // "bundle" as the top-level name for the same reason push.ts uses it:
    // extractArchive strips exactly one wrapper segment.
    const bundleStaging = join(staging, "bundle");
    mkdirSync(join(bundleStaging, "sessions"), { recursive: true });

    const jsonlPath = join(bundleStaging, "sessions", `${sessionId}.jsonl`);
    const entries = [
      {
        sessionId, cwd: "/x", version: "2.1.81", gitBranch: "main", slug: "fetch-stage",
        uuid: `${bundleId}-1`, parentUuid: null, timestamp: "2026-08-01T10:00:00.000Z",
        type: "user", message: { role: "user", content: "hello" },
      },
    ];
    writeFileSync(jsonlPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    const manifest: ExportManifest = {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: pushedAt,
      sourcePlatform: "linux",
      sourceProjectPath: "/x",
      sourceConfigDir: "/x/.claude",
      sourceClaudeVersion: "2.1.81",
      sessionScope: "current",
      includedLayers: ["jsonl"],
      projectId: "p1",
      sourceMachineId: MACHINE_ID,
      sessions: [
        {
          sessionId,
          slug: "fetch-stage",
          summary: "an intact bundle",
          createdAt: "2026-08-01T10:00:00.000Z",
          lastActiveAt: "2026-08-01T10:00:00.000Z",
          messageCount: entries.length,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash: await computeIntegrityHashFromFile(jsonlPath),
          type: "full",
        },
      ],
    };
    if (over.basedOn !== undefined) {
      mkdirSync(join(bundleStaging, "workspace"), { recursive: true });
      writeFileSync(join(bundleStaging, "workspace", "README.md"), "# hi\n", "utf-8");
      manifest.workspace = {
        fileCount: 1,
        byteSize: 5,
        snapshotAt: pushedAt,
        basedOn: over.basedOn === null ? null : { bundleId: over.basedOn, file: "irrelevant" },
      };
    }
    if (over.carry) {
      mkdirSync(join(bundleStaging, "carry", "untracked"), { recursive: true });
      writeFileSync(join(bundleStaging, "carry", "untracked", "scratch.txt"), "wip\n", "utf-8");
      manifest.carry = CARRY;
    }
    writeManifest(bundleStaging, manifest);

    // AFTER the manifest is stamped: sessionsDigest covers the session list and
    // its hashes, never the files beside it, so removing the transcript leaves a
    // manifest that is internally self-consistent and lying.
    if (over.omitSessionFile) rmSync(jsonlPath);

    const archivePath = join(staging, "bundle.tar.gz");
    await createArchive(bundleStaging, archivePath, "gzip");
    const file = `${bundleDir("p1", MACHINE_ID)}/${bundleFileName(pushedAt, bundleId)}`;
    await backend.writeAtomic(file, readFileSync(archivePath));
    rmSync(staging, { recursive: true, force: true });

    return {
      bundleId,
      file,
      type: "full",
      sessionIdInBundle: sessionId,
      fromEntryUuid: null,
      headEntryUuid: `${bundleId}-1`,
      messageCount: entries.length,
      pushedAt,
      hasWorkspace: over.basedOn !== undefined,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sm-fetch-"));
    hubDir = join(root, "hub");
    tempRoot = join(root, "temp");
    mkdirSync(hubDir, { recursive: true });
    mkdirSync(tempRoot, { recursive: true });
    backend = createFsBackend(hubDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The digest guard, reached the long way round.
   *
   * The assertions on the temp dir are the point: a stage that never downloaded,
   * never extracted, or tripped the *other* guard would also report "aborted",
   * so the test checks that the archive is on disk, that the manifest was
   * extracted and read, and that the transcript the manifest names IS present —
   * leaving the manifest's own damaged session list as the only thing that could
   * have stopped it.
   */
  it("aborts a bundle whose manifest is no longer the one the exporter stamped", async () => {
    const record = await writeCorruptBundle(backend, "p1");
    const st = initApplyState({ needed: [record] });

    const out = await runFetchStage({
      backend, record, bundleIndex: 0, tempRoot, state: st,
    });

    expect(out.status).toBe("aborted");
    expect(out.value).toBeNull();
    expect(out.terminal).toMatchObject({ success: false, command: "pull" });
    expect(out.terminal?.error).toContain(`Bundle ${record.bundleId} failed its integrity check`);
    // Both user-facing fields travel, not just the headline.
    expect(out.terminal?.suggestion).toContain("Nothing from this bundle was applied.");
    expect(out.terminal?.suggestion).toContain("this check detects damage, not tampering");

    // It got all the way through download -> extract -> readManifest...
    const extractDir = join(tempRoot, record.bundleId);
    expect(existsSync(join(tempRoot, `${record.bundleId}.tar.gz`))).toBe(true);
    expect(existsSync(join(extractDir, "manifest.json"))).toBe(true);
    // ...and the OTHER guard cannot be what fired: the declared transcript is there.
    expect(
      existsSync(join(extractDir, "sessions", `${record.sessionIdInBundle}.jsonl`))
    ).toBe(true);

    // A refused bundle contributes no merge ancestor and no carry.
    expect(st.chainWorkspaceBases).toEqual([]);
    expect(st.lastCarry).toBeNull();
  });

  /**
   * Partly redundant with `importSession`'s own check, and deliberately kept
   * here anyway: the append path guards the identical path and silently
   * DECLINES, so without this the bundle would be counted as imported.
   */
  it("aborts when the manifest declares a session the bundle does not contain", async () => {
    const record = await writeHealthyBundle({ omitSessionFile: true, basedOn: "gen-1", carry: true });
    const st = initApplyState({ needed: [record] });

    const out = await runFetchStage({
      backend, record, bundleIndex: 0, tempRoot, state: st,
    });

    expect(out.status).toBe("aborted");
    expect(out.value).toBeNull();
    expect(out.terminal?.error).toContain(
      `declares session ${record.sessionIdInBundle} but does not contain it`
    );
    expect(out.terminal?.suggestion).toContain("Nothing from this bundle was applied.");
    // The manifest passed its own digest check, so this is the second guard.
    expect(out.terminal?.error).not.toContain("integrity check");
    // Refused before either accumulator was written, even though this manifest
    // declares both a workspace generation and a carry.
    expect(st.chainWorkspaceBases).toEqual([]);
    expect(st.lastCarry).toBeNull();
  });

  /**
   * The two writes are MUTATIONS of the shared state, not return values: the
   * generation has to be visible to `chooseMergeAncestor` in this same loop
   * iteration, below the workspace gate that runs right after this stage.
   */
  it("records the chain's workspace base and the newest carry into the shared state", async () => {
    const record = await writeHealthyBundle({ basedOn: "gen-1", carry: true });
    const st = initApplyState({ needed: [record] });

    const out = await runFetchStage({
      backend, record, bundleIndex: 3, tempRoot, state: st,
    });

    expect(out.status).toBe("applied");
    expect(out.reasons).toEqual([]);
    expect(out.value?.extractDir).toBe(join(tempRoot, record.bundleId));
    expect(out.value?.manifest.sessions[0].sessionId).toBe(record.sessionIdInBundle);

    expect(st.chainWorkspaceBases).toEqual(["gen-1"]);
    expect(st.lastCarry).toEqual({
      dir: join(tempRoot, record.bundleId, "carry"),
      meta: CARRY,
      bundleFile: record.file,
      // The caller's index, not a count of anything the stage saw — the carry
      // gate after the loop splits on it.
      bundleIndex: 3,
    });
  });

  /** A first workspace push declares no ancestor, and `null` is that generation. */
  it("records a null generation for a bundle that declares no base", async () => {
    const record = await writeHealthyBundle({ basedOn: null });
    const st = initApplyState({ needed: [record] });

    await runFetchStage({ backend, record, bundleIndex: 0, tempRoot, state: st });

    expect(st.chainWorkspaceBases).toEqual([null]);
  });

  /**
   * Newest-wins **only if present**. A later bundle with no carry must leave the
   * earlier one alone — `st.lastCarry = value.carry ?? null` at a call site would
   * silently discard another machine's uncommitted work, which is why the guard
   * is welded to the assignment inside the stage.
   */
  it("does not clear an earlier bundle's carry when a later bundle has none", async () => {
    const withCarry = await writeHealthyBundle({ bundleId: "b0", carry: true });
    const without = await writeHealthyBundle({
      bundleId: "b1", pushedAt: "2026-08-02T00:00:00.000Z",
    });
    const st = initApplyState({ needed: [withCarry, without] });

    await runFetchStage({ backend, record: withCarry, bundleIndex: 0, tempRoot, state: st });
    expect(st.lastCarry?.bundleFile).toBe(withCarry.file);

    await runFetchStage({ backend, record: without, bundleIndex: 1, tempRoot, state: st });
    expect(st.lastCarry?.bundleFile).toBe(withCarry.file);
    expect(st.lastCarry?.bundleIndex).toBe(0);
  });

  /** A newer carry in the same chain supersedes an older one — that half still holds. */
  it("lets a later bundle's carry supersede an earlier one", async () => {
    const older = await writeHealthyBundle({ bundleId: "b0", carry: true });
    const newer = await writeHealthyBundle({
      bundleId: "b1", pushedAt: "2026-08-02T00:00:00.000Z", carry: true,
    });
    const st = initApplyState({ needed: [older, newer] });

    await runFetchStage({ backend, record: older, bundleIndex: 0, tempRoot, state: st });
    await runFetchStage({ backend, record: newer, bundleIndex: 1, tempRoot, state: st });

    expect(st.lastCarry?.bundleFile).toBe(newer.file);
    expect(st.lastCarry?.bundleIndex).toBe(1);
  });
});

/**
 * The carry stage's whole hazard is that `applyRequested: false` does NOT mean
 * "skip". It means SAVE: the stage still calls `applyCarry` with `saveOnly`,
 * which parks the payload under the project before declining. Short-circuiting
 * to a skip before that call destroys another machine's uncommitted work — this
 * pull records its bundles as received, so a re-run answers "Already up to
 * date", and the extraction directory is removed when `hubPull` returns.
 *
 * So the assertions below are about WHERE the bytes ended up, not only about
 * the status: a stub that returns a plausible-looking outcome without writing
 * anything is exactly the bug.
 */
describe("apply.carry stage", () => {
  let home: string;
  let homeHandle: HomeOverrideHandle;
  const temps: string[] = [];

  const tmp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  };

  beforeEach(() => {
    // `saveCarryPayload` falls back to `~/.sesh-mover/` when the in-project
    // destination is unusable, so an un-overridden HOME lets a failing test
    // write a peer payload into the real user's home directory.
    home = tmp("sm-carry-home-");
    homeHandle = overrideHome(home);
  });

  afterEach(() => {
    homeHandle.restore();
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const meta = (over: Partial<CarryMeta> = {}): CarryMeta => ({
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    branch: "feature/carry",
    detached: false,
    inProgress: null,
    capturedAt: "2026-08-13T10:00:00.000Z",
    untrackedCount: 1,
    untrackedBytes: 10,
    patchBytes: 0,
    reIncludedCount: 0,
    reIncluded: [],
    trackedIgnoredCount: 0,
    trackedIgnored: [],
    repoPrefix: "",
    ...over,
  });

  /** A bundle's extracted `carry/` directory: one untracked file, no patch. */
  const payloadDir = (): string => {
    const dir = tmp("sm-carry-payload-");
    mkdirSync(join(dir, "untracked"), { recursive: true });
    writeFileSync(join(dir, "untracked", "note.txt"), "peer work\n", "utf-8");
    return dir;
  };

  const carried = (over: Partial<PulledCarry> = {}): PulledCarry => ({
    dir: payloadDir(),
    meta: meta(),
    bundleFile: "projects/p1/bundles/b7.tar.gz",
    bundleIndex: 0,
    ...over,
  });

  const declined = (r: unknown): { reason: string; savedTo: string | null } => {
    const result = r as { applied: boolean; reason?: string; savedTo?: string | null };
    if (result === undefined || result.applied !== false) {
      throw new Error(`expected a declined ApplyResult, got ${JSON.stringify(r)}`);
    }
    return { reason: result.reason ?? "", savedTo: result.savedTo ?? null };
  };

  /**
   * The invariant this whole module exists to protect: not asking for the carry
   * still SAVES it. `status === "applied"` and `carryApplied.applied === false`
   * are different claims and this is the case where they disagree.
   */
  it("saves the payload beside the project when --apply-carry was not requested", async () => {
    const proj = tmp("sm-carry-proj-");
    const carry = carried();

    const out = await runApplyCarryStage({
      targetPath: proj,
      applyRequested: false,
      apply: { lastCarry: carry, divergenceAborted: false, abortIndex: -1 },
    });

    expect(out.status).toBe("applied");
    expect(out.value?.carryAvailable).toBe(carry.meta);
    const { reason, savedTo } = declined(out.value?.carryApplied);
    expect(reason).toBe("not-requested");
    expect(savedTo).not.toBeNull();
    // A real directory holding the real bytes — not merely a reported path.
    expect(savedTo?.startsWith(projectSeshMoverDir(proj))).toBe(true);
    expect(existsSync(join(savedTo as string, "untracked", "note.txt"))).toBe(true);
    expect(readFileSync(join(savedTo as string, "untracked", "note.txt"), "utf-8")).toBe(
      "peer work\n"
    );
    expect(out.reasons.join(" ")).toContain(savedTo as string);
    expect(out.reasons.join(" ")).toContain("Pass --apply-carry on a future pull");
  });

  /** The ordinary no-op: no bundle in the chain carried anything. Say nothing. */
  it("skips with zero reasons when the chain carried no payload", async () => {
    const out = await runApplyCarryStage({
      targetPath: tmp("sm-carry-proj-"),
      applyRequested: true,
      apply: { lastCarry: null, divergenceAborted: false, abortIndex: -1 },
    });

    expect(out.status).toBe("skipped");
    expect(out.reasons).toEqual([]);
    expect(out.value).toBeNull();
  });

  /**
   * The suppression gate turns on WHERE the payload came from, never on
   * "did an abort happen". A payload out of a bundle this pull already
   * recorded is not on offer again, so suppressing it deletes the only
   * reachable copy — the measured data loss this gate was rewritten for.
   */
  it("still saves a payload from a bundle the pull already recorded, after a divergence abort", async () => {
    const proj = tmp("sm-carry-proj-");
    const carry = carried({ bundleIndex: 0 });

    const out = await runApplyCarryStage({
      targetPath: proj,
      applyRequested: false,
      apply: { lastCarry: carry, divergenceAborted: true, abortIndex: 1 },
    });

    expect(out.status).toBe("applied");
    const { savedTo } = declined(out.value?.carryApplied);
    expect(existsSync(join(savedTo as string, "untracked", "note.txt"))).toBe(true);
  });

  /** At or past the abort index the bundle is re-offered next pull, so defer. */
  it("defers a payload from the bundle the divergence abort landed on", async () => {
    const proj = tmp("sm-carry-proj-");
    const carry = carried({ bundleIndex: 1 });

    const out = await runApplyCarryStage({
      targetPath: proj,
      applyRequested: false,
      apply: { lastCarry: carry, divergenceAborted: true, abortIndex: 1 },
    });

    expect(out.status).toBe("skipped");
    expect(out.reasons).toEqual([]);
    expect(out.value).toBeNull();
    // Nothing parked anywhere: the re-run is what delivers this one.
    expect(existsSync(projectSeshMoverDir(proj))).toBe(false);
  });

  /**
   * `carryAvailable` is assigned before the readable-dir check, so a damaged
   * bundle reports the payload it DECLARED even though nothing was applied —
   * a skip that still carries a value.
   */
  it("reports the declared payload when the bundle does not contain it", async () => {
    const proj = tmp("sm-carry-proj-");
    const carry: PulledCarry = {
      dir: join(tmp("sm-carry-gone-"), "carry"),
      meta: meta(),
      bundleFile: "projects/p1/bundles/b9.tar.gz",
      bundleIndex: 0,
    };

    const out = await runApplyCarryStage({
      targetPath: proj,
      applyRequested: true,
      apply: { lastCarry: carry, divergenceAborted: false, abortIndex: -1 },
    });

    expect(out.status).toBe("skipped");
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toContain("the bundle does not contain them");
    expect(out.value?.carryAvailable).toBe(carry.meta);
    expect(out.value?.carryApplied).toBeUndefined();
    expect(existsSync(projectSeshMoverDir(proj))).toBe(false);
  });

  /** A plain file where the carry directory belongs reads the same way (ENOTDIR). */
  it("treats a file at the carry path as a bundle that carries nothing", async () => {
    const proj = tmp("sm-carry-proj-");
    const holder = tmp("sm-carry-file-");
    const notADir = join(holder, "carry");
    writeFileSync(notADir, "not a directory", "utf-8");

    const out = await runApplyCarryStage({
      targetPath: proj,
      applyRequested: true,
      apply: {
        lastCarry: { dir: notADir, meta: meta(), bundleFile: "b.tar.gz", bundleIndex: 0 },
        divergenceAborted: false,
        abortIndex: -1,
      },
    });

    expect(out.status).toBe("skipped");
    expect(out.value?.carryApplied).toBeUndefined();
  });
});

describe("apply.workspace stage", () => {
  let root: string;
  let home: HomeOverrideHandle;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sm-ws-"));
    mkdirSync(join(root, "home"), { recursive: true });
    // Sync-state lives under the user's home, and the generation history this
    // stage reads and (must not) write is the whole point of the assertion.
    home = overrideHome(join(root, "home"));
  });

  afterEach(() => {
    home.restore();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The no-common-point skip, reached the only way it can carry TWO reasons.
   *
   * The intersection is deliberately NON-empty — our history names `gen-shared`
   * and the incoming chain declares it — so `chooseMergeAncestor` gets as far as
   * fetching, finds the generation gone from the hub, and degrades to
   * `{ dir: null }` WITH a sentence naming it. The stage then falls into the
   * no-ancestor branch, which adds its own. Both have to survive: the
   * degradation sentence is the only thing that says WHY a machine holding a
   * shared generation still got nothing, and it has no other source.
   *
   * The empty-tree case is NOT this test. An empty project plus an empty
   * intersection gives `hasRealContent === false`, which takes the bootstrap
   * unpack and returns `applied` — asserting "skipped" there would break the
   * bootstrap this stage must keep.
   */
  it("emits the ancestor degradation AND the no-common-point sentence, and records no generation", async () => {
    const hubDir = join(root, "hub");
    const tempRoot = join(root, "temp");
    const project = join(root, "project");
    const extractDir = join(root, "extract");
    mkdirSync(hubDir, { recursive: true });
    mkdirSync(tempRoot, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(join(extractDir, "workspace"), { recursive: true });
    // Real content on both sides: an incoming payload to apply, and a local
    // file that makes `hasRealContent` true so the bootstrap branch cannot fire.
    writeFileSync(join(extractDir, "workspace", "incoming.txt"), "theirs\n", "utf-8");
    writeFileSync(join(project, "local.txt"), "mine\n", "utf-8");

    const backend = createFsBackend(hubDir);

    // Our half of the intersection: one generation on record, whose bundle is
    // NOT on the hub (pruned, or not yet synced to this machine).
    const before = readSyncState(project);
    setLastWorkspace(before, "hub-1", {
      bundleId: "gen-shared",
      file: `${bundleDir("p1", "m-other")}/2026-08-01T00-00-00-000Z_gen-shared.tar.gz`,
      pushedAt: "2026-08-01T00:00:00.000Z",
    });
    writeSyncState(before);

    const out = await runApplyWorkspaceStage({
      backend,
      extractDir,
      effectiveProjectPath: project,
      targetPathGiven: false,
      forceWorkspace: false,
      bundleDeclaresWorkspace: true,
      chainWorkspaceBases: ["gen-shared"],
      hubId: "hub-1",
      record: {
        bundleId: "b1",
        file: `${bundleDir("p1", "m-other")}/2026-08-02T00-00-00-000Z_b1.tar.gz`,
        pushedAt: "2026-08-02T00:00:00.000Z",
      },
      tempRoot,
    });

    expect(out.status).toBe("skipped");
    expect(out.value).toBeNull();
    expect(out.reasons).toHaveLength(2);
    expect(out.reasons[0]).toContain("gen-shared");
    expect(out.reasons[0]).toContain("is no longer on the hub");
    expect(out.reasons[1]).toContain("no common point to merge from and NOTHING was written");

    // Nothing was written: not the payload...
    expect(existsSync(join(project, "incoming.txt"))).toBe(false);
    expect(readFileSync(join(project, "local.txt"), "utf-8")).toBe("mine\n");
    // ...and above all not a generation. Recording one for a payload this tree
    // never received is exactly how the next merge reads the whole payload as
    // "deleted here".
    expect(knownWorkspaceGenerations(readSyncState(project)).map((g) => g.bundleId)).toEqual([
      "gen-shared",
    ]);
  });
});

describe("apply.sessions stage", () => {
  let root: string;
  let home: string;
  let handle: HomeOverrideHandle;
  let configDir: string;
  let projectPath: string;
  let targetProjectDir: string;
  let extractDir: string;

  const THREAD_ID = "t-sessions";
  const HUB_ID = "hub-1";
  const HUB_PEER_ID = "hub:hub-1";
  const SOURCE_MACHINE = "m-source";
  /** A fixed operation boundary — the stage must never read a clock of its own. */
  const OP_NOW_MS = Date.parse("2026-08-14T12:00:00.000Z");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sm-sessions-"));
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    handle = overrideHome(home);
    configDir = join(root, "config");
    projectPath = join(root, "project");
    mkdirSync(projectPath, { recursive: true });
    targetProjectDir = join(configDir, "projects", encodeProjectPath(projectPath));
    mkdirSync(targetProjectDir, { recursive: true });
    extractDir = join(root, "extract");
  });

  afterEach(() => {
    handle.restore();
    rmSync(root, { recursive: true, force: true });
  });

  function conversationEntry(
    over: { uuid: string; parentUuid: string | null; sessionId: string; text: string }
  ): Record<string, unknown> {
    return {
      uuid: over.uuid,
      parentUuid: over.parentUuid,
      timestamp: "2026-08-01T10:00:00.000Z",
      sessionId: over.sessionId,
      cwd: "/source/project",
      version: "2.1.81",
      gitBranch: "main",
      type: "user",
      message: { role: "user", content: over.text },
    };
  }

  /**
   * A bundle already unpacked into `extractDir` — exactly what the fetch stage
   * hands this one, minus the hub round trip it does not care about.
   */
  async function writeBundleDir(over: {
    type: HubBundleRecord["type"];
    sessionId?: string;
    entries: Array<Record<string, unknown>>;
    fromEntryUuid?: string | null;
  }): Promise<{ manifest: ExportManifest; record: HubBundleRecord }> {
    const sessionId = over.sessionId ?? "bundle-session";
    mkdirSync(join(extractDir, "sessions"), { recursive: true });
    const jsonlPath = join(extractDir, "sessions", `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, over.entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    const manifest: ExportManifest = {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: "2026-08-01T00:00:00.000Z",
      sourcePlatform: "linux",
      sourceProjectPath: "/source/project",
      sourceConfigDir: "/source/.claude",
      sourceClaudeVersion: "2.1.81",
      sessionScope: "current",
      includedLayers: ["jsonl"],
      projectId: "p1",
      sourceMachineId: SOURCE_MACHINE,
      sessions: [
        {
          sessionId,
          slug: "apply-sessions",
          summary: "a bundle for the apply.sessions stage",
          createdAt: "2026-08-01T10:00:00.000Z",
          lastActiveAt: "2026-08-01T10:00:00.000Z",
          messageCount: over.entries.length,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash: await computeIntegrityHashFromFile(jsonlPath),
          type: over.type,
        },
      ],
    };
    writeManifest(extractDir, manifest);
    const last = over.entries[over.entries.length - 1] as { uuid: string };
    return {
      manifest,
      record: {
        bundleId: "b0",
        file: `${bundleDir("p1", SOURCE_MACHINE)}/${bundleFileName("2026-08-01T00:00:00.000Z", "b0")}`,
        type: over.type,
        sessionIdInBundle: sessionId,
        fromEntryUuid: over.fromEntryUuid ?? null,
        headEntryUuid: last.uuid,
        messageCount: over.entries.length,
        pushedAt: "2026-08-01T00:00:00.000Z",
        hasWorkspace: false,
      },
    };
  }

  function stageInput(over: {
    manifest: ExportManifest;
    record: HubBundleRecord;
    state: ReturnType<typeof initApplyState>;
    recordSplice?: (b: RecordSpliceInput) => void;
    noAppend?: boolean;
    bundleMachineId?: string;
  }): Parameters<typeof runApplySessionsStage>[0] {
    return {
      extractDir,
      bundleManifest: over.manifest,
      record: over.record,
      bundleIndex: 0,
      chainLength: 1,
      projectPath,
      configDir,
      targetProjectDir,
      claudeVersion: "2.1.81",
      threadId: THREAD_ID,
      bundleMachineId: over.bundleMachineId ?? SOURCE_MACHINE,
      hubPeerId: HUB_PEER_ID,
      noAppend: over.noAppend ?? false,
      forceAppend: false,
      onDivergence: undefined,
      opNowMs: OP_NOW_MS,
      ageNowMs: OP_NOW_MS,
      historyNowDate: "2026-08-14",
      historyNowMs: OP_NOW_MS,
      state: over.state,
      recordSplice: over.recordSplice ?? ((): void => {}),
      countEntriesAfterOffset: async (): Promise<number> => 0,
    };
  }

  it("imports a full bundle as its own session and lets the loop carry on", async () => {
    const { manifest, record } = await writeBundleDir({
      type: "full",
      entries: [
        conversationEntry({ uuid: "f-1", parentUuid: null, sessionId: "bundle-session", text: "hello" }),
        conversationEntry({ uuid: "f-2", parentUuid: "f-1", sessionId: "bundle-session", text: "again" }),
      ],
    });
    const st = initApplyState({ needed: [record] });
    const spliced: RecordSpliceInput[] = [];

    const out = await runApplySessionsStage(
      stageInput({ manifest, record, state: st, recordSplice: (b) => spliced.push(b) })
    );

    expect(out.control).toEqual({ kind: "next" });
    // The state is the caller's object, mutated in place — never a copy.
    expect(st.importedSessions).toHaveLength(1);
    expect(st.threadLandedSessionId).toBe(st.importedSessions[0].newId);
    expect(st.lastImportedNewId).toBe(st.importedSessions[0].newId);
    expect(st.lastAppliedIndex).toBe(0);
    expect(st.lastBundleManifest).toBe(manifest);
    // A full bundle never reaches the splice paths.
    expect(spliced).toHaveLength(0);
    expect(st.appended).toHaveLength(0);
    // The hub ledger is credited so a push back does not re-ship what we took.
    const after = readSyncState(projectPath);
    expect(after.peers[HUB_PEER_ID]?.sent[st.lastImportedNewId!]?.headEntryUuid).toBe("f-2");
  });

  /**
   * A local base this thread already owns, whose head IS the anchor of the
   * continuation built beside it — the arrangement the append path exists for.
   */
  async function arrangeSpliceable(): Promise<{
    baseSessionId: string;
    basePath: string;
    manifest: ExportManifest;
    record: HubBundleRecord;
  }> {
    const baseSessionId = "11111111-2222-3333-4444-555555555555";
    const basePath = join(targetProjectDir, `${baseSessionId}.jsonl`);
    writeFileSync(
      basePath,
      [
        conversationEntry({ uuid: "base-1", parentUuid: null, sessionId: baseSessionId, text: "start" }),
        conversationEntry({ uuid: "base-2", parentUuid: "base-1", sessionId: baseSessionId, text: "carry on" }),
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf-8"
    );
    // Out of append.ts's liveness window: this transcript is not being written
    // to by a live Claude Code session.
    const old = new Date(OP_NOW_MS - 60 * 60 * 1000);
    utimesSync(basePath, old, old);

    const state = readSyncState(projectPath);
    setThreadId(state, HUB_ID, baseSessionId, THREAD_ID);
    writeSyncState(state);

    const built = await writeBundleDir({
      type: "continuation",
      fromEntryUuid: "base-2",
      entries: [
        conversationEntry({ uuid: "c-1", parentUuid: "base-2", sessionId: "bundle-session", text: "more" }),
        conversationEntry({ uuid: "c-2", parentUuid: "c-1", sessionId: "bundle-session", text: "and more" }),
      ],
    });
    return { baseSessionId, basePath, ...built };
  }

  it("splices a chaining continuation onto the thread's local base", async () => {
    const a = await arrangeSpliceable();
    const st = initApplyState({ needed: [a.record] });
    const spliced: RecordSpliceInput[] = [];

    const out = await runApplySessionsStage(
      stageInput({
        manifest: a.manifest, record: a.record, state: st,
        recordSplice: (b) => spliced.push(b),
      })
    );

    expect(out.control).toEqual({ kind: "next" });
    expect(st.appended).toEqual([
      { threadId: THREAD_ID, baseSessionId: a.baseSessionId, entriesAppended: 2 },
    ]);
    expect(st.importedSessions).toHaveLength(0);
    expect(st.threadLandedSessionId).toBe(a.baseSessionId);
    // The splice bookkeeping is the caller's callback, invoked with this pull's
    // own identifiers.
    expect(spliced).toHaveLength(1);
    expect(spliced[0]).toMatchObject({
      projectPath, baseSessionId: a.baseSessionId, peerId: SOURCE_MACHINE,
      hubPeerId: HUB_PEER_ID, newHeadUuid: "c-2",
    });
    // Rewritten before the splice: append.ts does neither the path rewrite nor
    // the version adaptation, so the SPLICED entries must carry this machine's
    // paths and this session's id, not the bundle's.
    const lines = readFileSync(a.basePath, "utf-8")
      .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.uuid)).toEqual(["base-1", "base-2", "c-1", "c-2"]);
    expect(lines.slice(2).map((l) => l.cwd)).toEqual([projectPath, projectPath]);
    expect(lines.slice(2).map((l) => l.sessionId)).toEqual([a.baseSessionId, a.baseSessionId]);
  });

  /**
   * SITES ONE AND TWO OF THE `sourceMachineId` RIPPLE (#35 Task 3).
   *
   * The splice credits `peers[peerId].received` and `peers[peerId].sent`, and
   * the peer it must credit is the machine whose index listed THIS bundle. Two
   * other ids are in the room and both are wrong: the pull's resolved machine
   * (gone from this stage entirely now — there is no parameter left to reach
   * for) and the bundle manifest's `sourceMachineId`, which is the ORIGINATING
   * machine and is what `importSession` credits on the fragment path.
   *
   * So the arrangement makes them disagree: the plan says `m-holder`, the
   * manifest says `m-source`. On a one-machine pull they are the same string
   * and this assertion is untestable, which is exactly why it is written here
   * rather than left to an end-to-end case.
   *
   * The `adopt-hub` site takes its value from the same destructured binding as
   * this one, so the two cannot disagree by construction; hub-pull.test.ts
   * exercises that path end to end.
   */
  it("credits the splice to the machine whose list carried the bundle, not the manifest's originator", async () => {
    const a = await arrangeSpliceable();
    expect(a.manifest.sourceMachineId, "the manifest's originator is the decoy").toBe(SOURCE_MACHINE);
    const st = initApplyState({ needed: [a.record] });
    const spliced: RecordSpliceInput[] = [];

    const out = await runApplySessionsStage(
      stageInput({
        manifest: a.manifest, record: a.record, state: st,
        bundleMachineId: "m-holder",
        recordSplice: (b) => spliced.push(b),
      })
    );

    expect(out.control).toEqual({ kind: "next" });
    expect(spliced).toHaveLength(1);
    expect(spliced[0].peerId).toBe("m-holder");
    expect(spliced[0].peerId).not.toBe(SOURCE_MACHINE);
    // The hub's own ledger is unaffected: it is not machine-derived, and the
    // invariant doc on `recordSentToPeer` is about that one.
    expect(spliced[0].hubPeerId).toBe(HUB_PEER_ID);
  });

  it("imports as a fragment instead of splicing when --no-append is set", async () => {
    const a = await arrangeSpliceable();
    const before = readFileSync(a.basePath, "utf-8");
    const st = initApplyState({ needed: [a.record] });
    const spliced: RecordSpliceInput[] = [];

    const out = await runApplySessionsStage(
      stageInput({
        manifest: a.manifest, record: a.record, state: st, noAppend: true,
        recordSplice: (b) => spliced.push(b),
      })
    );

    expect(out.control).toEqual({ kind: "next" });
    expect(st.appended).toHaveLength(0);
    expect(spliced).toHaveLength(0);
    expect(st.importedSessions).toHaveLength(1);
    expect(readFileSync(a.basePath, "utf-8")).toBe(before);
  });

  /**
   * THE ALIASING REGRESSION.
   *
   * `st.lastDivergence = divergence` shares one object: `.resolution` is
   * rewritten at three points after that assignment and `.preservedSessionId`
   * at one. Assigning a spread, or returning the object for the caller to
   * assign, freezes `resolution` at the mode the user ASKED for and leaves
   * `preservedSessionId` permanently undefined — with no type error, because
   * both shapes satisfy `HubPullDivergence`.
   *
   * Both halves are checked here: the refusal writes "skip" over "adopt-hub",
   * and the forced re-run writes the preserved session id.
   */
  it("keeps the divergence object aliased across its later mutations", async () => {
    const a = await arrangeDivergence();
    try {
      makeLookLive(a.basePath);

      const refused = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", claudeVersion: "2.1.81",
      });
      expect(refused.success).toBe(true);
      if (!refused.success) return;
      const r = refused as HubPullResult;
      // Written AFTER `st.lastDivergence = divergence`. A copy reports the
      // requested "adopt-hub" here and the refusal becomes invisible.
      expect(r.divergence?.resolution).toBe("skip");
      expect(r.divergence?.preservedSessionId).toBeUndefined();
      expect(r.appended ?? []).toHaveLength(0);
      expect(r.importedSessions).toHaveLength(0);

      const forced = await hubPull({
        configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
        latest: true, onDivergence: "adopt-hub", forceAppend: true, claudeVersion: "2.1.81",
      });
      expect(forced.success).toBe(true);
      if (!forced.success) return;
      const f = forced as HubPullResult;
      expect(f.divergence?.resolution).toBe("adopt-hub");
      // The fourth post-assignment write. A copy leaves this undefined and the
      // preserved branch becomes unreportable.
      expect(f.divergence?.preservedSessionId).toBeTruthy();
      expect(existsSync(join(a.projectDirA, `${f.divergence!.preservedSessionId}.jsonl`))).toBe(true);
    } finally {
      a.cleanup();
    }
  });

  /**
   * THE STOP-CHAIN REGRESSION.
   *
   * The divergence escapes are `break`s, not `continue`s, and the workspace
   * gate is evaluated at the TOP of each iteration — so breaking at bundle 0
   * is what keeps a payload sitting on bundle 1 from being applied by a pull
   * the user is about to re-run. Translate `stop-chain` into anything else and
   * the workspace half lands while the session half is still undecided,
   * silently, on a chain length nothing else in the suite exercises.
   */
  it("a divergence break at bundle 0 forecloses bundle 1's workspace payload", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sm-stop-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sm-stop-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sm-stop-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sm-stop-fix-"));
    const projectB = mkdtempSync(join(tmpdir(), "sm-stop-projB-"));
    const wsLines = (edits: Record<number, string> = {}): string =>
      Array.from({ length: 9 }, (_, n) => edits[n + 1] ?? `L${n + 1}`).join("\n") + "\n";
    let restore = overrideHome(homeA);
    try {
      // --- A: a git-less project with one shared file, pushed once ----------
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = join(base, "projA-stop");
      mkdirSync(projectA, { recursive: true });
      writeFileSync(join(projectA, "shared.txt"), wsLines());
      const encodedA = encodeProjectPath(projectA);
      cpSync(join(configDirA, "projects", FIXTURE_ENCODED), join(configDirA, "projects", encodedA), {
        recursive: true,
      });
      const aJsonl = join(configDirA, "projects", encodedA, `${FIXTURE_SESSION_ID}.jsonl`);

      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      const push1 = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(push1.success).toBe(true);
      if (!push1.success) return;
      expect(push1.hasWorkspace).toBe(true);

      // --- B bootstraps off push #1, then forks the thread locally ----------
      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      writeLocalProjectId(projectB, {
        projectId: push1.projectId, name: "projA-stop",
        createdAt: "2026-04-10T00:00:00.000Z", createdByMachine: "machine-a",
      });
      const bootstrap = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(bootstrap.success).toBe(true);
      if (!bootstrap.success) return;
      const bSessionId = (bootstrap as HubPullResult).localSessionId;
      expect(bSessionId).toBeTruthy();
      const bJsonl = join(configDirB, "projects", encodeProjectPath(projectB), `${bSessionId}.jsonl`);
      expect(readFileSync(join(projectB, "shared.txt"), "utf-8")).toBe(wsLines());

      appendFileSync(
        bJsonl,
        JSON.stringify({
          uuid: "b-local-1", parentUuid: FIXTURE_HEAD_UUID, timestamp: "2026-05-01T10:00:00Z",
          sessionId: bSessionId, cwd: projectB, version: "2.1.81", type: "user",
          message: { role: "user", content: "meanwhile, on B" },
        }) + "\n",
        "utf-8"
      );
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(bJsonl, old, old);

      // --- A pushes twice: a two-bundle chain, payload on the NEWER one -----
      restore.restore();
      restore = overrideHome(homeA);
      for (const [n, tree] of [
        [1, wsLines({ 2: "GEN-2" })],
        [2, wsLines({ 2: "GEN-2", 4: "GEN-3" })],
      ] as Array<[number, string]>) {
        writeFileSync(join(projectA, "shared.txt"), tree);
        const anchor = readLastEntryUuid(aJsonl);
        expect(anchor).toBeTruthy();
        appendFileSync(
          aJsonl,
          JSON.stringify({
            uuid: `a-ws-${n}`, parentUuid: anchor,
            timestamp: new Date(Date.parse("2026-04-11T10:00:00Z") + n * 60_000).toISOString(),
            sessionId: FIXTURE_SESSION_ID, cwd: projectA, version: "2.1.81", type: "user",
            message: { role: "user", content: `more work on A (${n})` },
          }) + "\n",
          "utf-8"
        );
        const push = await hubPush({
          configDir: configDirA, projectPath: projectA, hubPath: hub, claudeVersion: "2.1.81",
        });
        expect(push.success, `A's push #${n + 1} must succeed`).toBe(true);
        if (!push.success) return;
        expect(push.hasWorkspace).toBe(true);
      }

      // --- The act: B pulls the chain with --on-divergence skip -------------
      restore.restore();
      restore = overrideHome(homeB);
      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, onDivergence: "skip", claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      // Bundle 0 diverged and stopped the whole chain...
      expect(p.divergence?.resolution).toBe("skip");
      expect(p.importedSessions).toHaveLength(0);
      expect(p.appended ?? []).toHaveLength(0);
      // ...so bundle 1's workspace payload was never reached. A `continue` (or
      // a `return` the caller reads as "carry on") applies it here.
      expect(p.workspaceUnpacked).toBeNull();
      expect(p.workspaceMerge).toBeUndefined();
      expect(readFileSync(join(projectB, "shared.txt"), "utf-8")).toBe(wsLines());
      expect(p.warnings.join(" ")).toContain("1 later bundle in this thread's chain was not fetched");
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base, projectB]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});

// ---- select stage -----------------------------------------------------------

/**
 * SELECT + REPAIR, and the tests are written to the second half as much as the
 * first: `backfillThreadMappings` WRITES sync-state, so two of the seven exits
 * hand back `success: false` over a changed disk. "This exit changed nothing"
 * is therefore only assertable where the arrangement leaves nothing to repair
 * (the all-current case below, which has no peer receipts at all) — everywhere
 * else the assertion is the SPECIFIC repair, or its specific absence.
 *
 * Everything here runs under `overrideHome`: the stage does its own sync-state
 * I/O by design (a passed-in `SyncState` would collapse the peek/read split
 * that decides which branch has earned the right to rename a corrupt file
 * aside), and that file lives under $HOME.
 */
describe("select stage", () => {
  let root: string;
  let home: HomeOverrideHandle;
  let hubDir: string;
  let projectPath: string;
  let targetProjectDir: string;

  const HUB_ID = "hub-1";
  const ME = "m1";

  /** The one bundle a peer offers in these arrangements. */
  const PEER_BUNDLE: HubBundleRecord = bundle({
    bundleId: "b0",
    file: "projects/p/bundles/m2/b0.tar.gz",
    type: "full",
    sessionIdInBundle: "sess-1",
    headEntryUuid: "head-b0",
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sm-select-"));
    mkdirSync(join(root, "home"), { recursive: true });
    home = overrideHome(join(root, "home"));
    hubDir = join(root, "hub");
    mkdirSync(hubDir, { recursive: true });
    projectPath = join(root, "proj");
    targetProjectDir = join(root, "config", "projects", encodeProjectPath(projectPath));
    mkdirSync(targetProjectDir, { recursive: true });
  });

  afterEach(() => {
    home.restore();
    rmSync(root, { recursive: true, force: true });
  });

  function input(
    over: { indexes?: HubIndexJson[]; threadId?: string; latest?: boolean } = {}
  ) {
    return {
      backend: createFsBackend(hubDir),
      resolved: resolveThreads(over.indexes ?? currentThreadIndexes({ machineId: ME })),
      machineId: ME,
      hubId: HUB_ID,
      threadId: over.threadId,
      latest: over.latest,
      effectiveProjectPath: projectPath,
      targetProjectDir,
    };
  }

  /** Only the file's EXISTENCE is what `backend.exists` reports to this stage. */
  function writeBundleFile(rel: string): void {
    const p = join(hubDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "bundle bytes are the fetch stage's problem", "utf-8");
  }

  /** One other machine's index for thread `t-1`, offering `PEER_BUNDLE`. */
  function peerIndex(machineId = "m2"): HubIndexJson {
    return idx(machineId, {
      "t-1": entry({
        localSessionId: `local-${machineId}`,
        headEntryUuid: "head-b0",
        bundles: [PEER_BUNDLE],
      }),
    });
  }

  /**
   * The arrangement that drives all four of the moved closures in one call:
   * every thread's latest copy is this machine's OWN, `alternateSource` finds
   * no other machine to fetch from, `discloseUnfetchable` has nothing to
   * disclose, and `backfillThreadMappings` finds nothing to repair — so this is
   * the one exit where "the state file is untouched" is a true statement rather
   * than a convenient one.
   *
   * It is also the fixture that pins #44's local-machine branch. The sync-state
   * here is EMPTY, so this machine has no receipt for its own pushed bundle: a
   * `pullSourceFor` that re-gated unconditionally would call that bundle
   * "needed" and start re-fetching this machine's own pushes. `alternateSource`
   * excludes our own copy, which is why the branch delegates to it.
   */
  it("--latest with nothing left to fetch stops with the exact reason and repairs nothing", async () => {
    writeSyncState(emptySyncState(projectPath));
    const before = readFileSync(syncStatePath(projectPath), "utf-8");

    const out = await runSelectStage(input({ latest: true }));

    expect(out.kind).toBe("stop");
    if (out.kind !== "stop") return;
    expect(out.result).toEqual({
      success: false,
      command: "pull",
      // No repair fired, so `details` carries nothing.
      details: undefined,
      // RECEIPT-SHAPED since #44: the old "all threads are current on this
      // machine" asserted head equality, which this branch no longer tests.
      error:
        "Nothing to pull: every bundle the machine each thread resolves to lists has already been received here.",
      suggestion: "Run whereis to double-check thread status.",
    });
    expect(readFileSync(syncStatePath(projectPath), "utf-8")).toBe(before);
  });

  /**
   * The pick list is `success: true`, which is why this stage cannot use
   * `stageAbort` — and it carries no `warnings`: the caller owns that list (it
   * already holds the stale-lock warning and the resolve stage's reasons), so
   * handing it in only to get it back would be a detour.
   */
  it("returns the pick list, with no warnings channel, when neither --thread nor --latest is given", async () => {
    const out = await runSelectStage(input());

    expect(out.kind).toBe("pick-list");
    if (out.kind !== "pick-list") return;
    // resolveThreads orders desc by latest activity; t2 is the newer fixture thread.
    expect(out.threads.map((t) => t.threadId)).toEqual(["t2", "t1"]);
    expect("warnings" in out).toBe(false);
  });

  it("stops when --thread names a thread this project does not have on the hub", async () => {
    const out = await runSelectStage(input({ threadId: "nope" }));

    expect(out.kind).toBe("stop");
    if (out.kind !== "stop") return;
    expect(out.result).toEqual({
      success: false,
      command: "pull",
      error: 'No thread "nope" found for this project on the hub.',
      suggestion: "Run whereis to list available threads.",
    });
  });

  /**
   * The narrowing is the point of the result shape: a later stage gets the
   * thread id and the source machine id, never the `ResolvedThread` they came
   * from — `copies` is the field with the iteration-order ban on it, and
   * handing it on is how a later stage re-derives the selection.
   */
  it("proceeds with a narrowed selection and nothing to re-derive it from", async () => {
    writeBundleFile(PEER_BUNDLE.file);

    const out = await runSelectStage(input({ indexes: [peerIndex()], latest: true }));

    expect(out.kind).toBe("proceed");
    if (out.kind !== "proceed") return;
    expect(out.warnings).toEqual([]);
    expect(out.value).toEqual({
      threadId: "t-1",
      sourceMachineId: "m2",
      // Each record carries the machine whose list it came from. One copy's
      // list, so one machine — but stamped per record, not inferred from the
      // scalar above (see `SourcedBundle`).
      needed: [{ machineId: "m2", record: PEER_BUNDLE }],
      unfetchableBundles: undefined,
    });
    expect(Object.keys(out.value).sort()).toEqual([
      "needed", "sourceMachineId", "threadId", "unfetchableBundles",
    ]);
  });

  /**
   * The second exit that cannot be an `ErrorResult`: `NotYetSyncedResult` has
   * no `error` field, so a `stageAbort` synthesizing `reasons: [result.error]`
   * would carry `undefined`.
   */
  it("stops with not-yet-synced, and no error field, when a needed bundle has not landed here yet", async () => {
    const out = await runSelectStage(input({ indexes: [peerIndex()], latest: true }));

    expect(out.kind).toBe("stop");
    if (out.kind !== "stop") return;
    expect(out.result).toEqual({
      success: false,
      command: "pull",
      reason: "not-yet-synced",
      missing: [PEER_BUNDLE.file],
      suggestion: "The hub folder has not finished syncing these files — retry in a moment.",
    });
    expect("error" in out.result).toBe(false);
  });

  /**
   * #28's crash window, on the exit an interrupted `--latest` re-run actually
   * lands in: every bundle is already recorded as received, and the mapping
   * that says which thread the local session belongs to is missing. The repair
   * WRITES, under a `success: false` result.
   *
   * #44 MOVED THIS EXIT, deliberately, and the repair is why it is safe: the
   * same receipts that used to empty `needed` (exit 6, "Already up to date with
   * the source machine") now make `pullSourceFor` yield no source, so `--latest`
   * stops one branch earlier — and that branch backfills across every resolved
   * thread rather than the single one, i.e. strictly more repair for the same
   * arrangement. `--thread <id>` still reaches exit 6; see hub-pull.test.ts's
   * split-fixture cases, which are threadId-driven.
   */
  it("repairs an absent thread mapping on the nothing-to-pull exit and reports it in details", async () => {
    writeFileSync(join(targetProjectDir, "local-1.jsonl"), "{}\n", "utf-8");
    writeSyncState({
      ...emptySyncState(projectPath),
      peers: {
        m2: peer({
          received: {
            "sess-1": {
              localSessionId: "local-1", type: "full", importedAt: "2026-08-01T00:00:00.000Z",
            },
          },
        }),
      },
    });

    const out = await runSelectStage(input({ indexes: [peerIndex()], latest: true }));

    expect(out.kind).toBe("stop");
    if (out.kind !== "stop") return;
    const result = out.result as ErrorResult;
    expect(result.error).toBe(
      "Nothing to pull: every bundle the machine each thread resolves to lists has already been received here."
    );
    expect(result.suggestion).toBe("Run whereis to double-check thread status.");
    expect(result.details).toContain("the mapping has been restored");
    const after = readSyncState(projectPath);
    expect(getThreadId(after, "local-1")).toBe("t-1");
    expect(after.hub?.hubId).toBe(HUB_ID);
  });

  /**
   * Warning push #1 of the two this stage emits. The newest copy is ours, but a
   * peer still lists a bundle we never received — the shape a divergence left
   * undecided plus one auto-push produces.
   */
  it("warns and switches source when the newest copy is ours but a peer lists an unreceived bundle", async () => {
    writeBundleFile(PEER_BUNDLE.file);
    mkdirSync(join(hubDir, "machines"), { recursive: true });
    writeFileSync(
      join(hubDir, machinePath("m2")),
      JSON.stringify({ id: "m2", name: "laptop", platform: "linux", lastSeenAt: "t" }),
      "utf-8"
    );
    const mine = idx(ME, {
      "t-1": entry({
        localSessionId: "local-mine",
        headEntryUuid: "head-mine",
        lastActiveAt: "2026-07-22T00:00:00Z",
        bundles: [],
      }),
    });

    const out = await runSelectStage(input({ indexes: [mine, peerIndex()], latest: true }));

    expect(out.kind).toBe("proceed");
    if (out.kind !== "proceed") return;
    expect(out.value.sourceMachineId).toBe("m2");
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain(
      "The most recent copy of thread t-1 is this machine's own, but laptop still lists bundles this machine has never received"
    );
  });

  /**
   * Warning push #2, plus the typed field the skill layer branches on. A third
   * machine lists a bundle the resolved source does not, and a pull only ever
   * reads one machine's list.
   */
  it("discloses a third machine's unreachable bundles as both a typed field and a warning", async () => {
    writeBundleFile(PEER_BUNDLE.file);
    const third = idx("m3", {
      "t-1": entry({
        localSessionId: "local-m3",
        headEntryUuid: "head-b9",
        lastActiveAt: "2026-07-20T00:00:00Z",
        bundles: [
          bundle({
            bundleId: "b9",
            file: "projects/p/bundles/m3/b9.tar.gz",
            sessionIdInBundle: "sess-9",
            headEntryUuid: "head-b9",
          }),
        ],
      }),
    });

    const out = await runSelectStage(input({ indexes: [peerIndex(), third], latest: true }));

    expect(out.kind).toBe("proceed");
    if (out.kind !== "proceed") return;
    expect(out.value.sourceMachineId).toBe("m2");
    expect(out.value.unfetchableBundles).toEqual([
      { machineId: "m3", machineName: null, bundleIds: ["b9"] },
    ]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain("Thread t-1 could not be pulled whole");
  });

  /**
   * #44: ONE hub state, one answer. The two selectors used to gate on different
   * questions — `--latest` on head equality, `--thread` on what was actually
   * received — so this arrangement (the newest head is already here, and the
   * machine the thread resolves to still lists a bundle that never arrived)
   * answered "Nothing to pull: all threads are current on this machine" for one
   * and fetched for the other.
   *
   * The assertion is AGREEMENT, not a literal, so it survives #35: chain
   * assembly changes what `needed` may contain, not the rule that both
   * selectors have to ask the same question of it.
   *
   * The older `lastActiveAt` on this machine's own entry is load-bearing.
   * `newerThreadCopy`'s last key is machineId ascending, so on a total tie `m1`
   * (this machine) wins resolution, `alternateSource` covers it, and the
   * arrangement tests nothing.
   */
  it("--latest and --thread agree when the head is already here but a bundle never arrived", async () => {
    writeBundleFile(PEER_BUNDLE.file);
    writeSyncState(emptySyncState(projectPath)); // nothing received from m2
    const indexes = [
      idx(ME, {
        "t-1": entry({
          localSessionId: "local-1",
          headEntryUuid: "head-b0", // the head m2's bundle carries: "current"
          lastActiveAt: "2026-07-20T00:00:00Z", // ...but older, so m2 resolves
          bundles: [],
        }),
      }),
      peerIndex(),
    ];

    const viaLatest = await runSelectStage(input({ indexes, latest: true }));
    const viaThread = await runSelectStage(input({ indexes, threadId: "t-1" }));

    expect(viaLatest.kind).toBe(viaThread.kind);
    expect(viaLatest.kind).toBe("proceed");
    if (viaLatest.kind !== "proceed" || viaThread.kind !== "proceed") return;
    expect(viaLatest.value).toEqual(viaThread.value);
    expect(viaLatest.value.sourceMachineId).toBe("m2");
    expect(viaLatest.value.needed).toEqual([{ machineId: "m2", record: PEER_BUNDLE }]);
  });

  /**
   * The stamp is per record and comes from the copy the selection was drawn
   * from — asserted on the branch where the resolved machine is NOT the source
   * (our own copy is newest, so `alternateSource` switches to m2). Same machine
   * in both roles today; the point is which one the records are stamped with,
   * because that is the one three sites downstream credit.
   */
  it("stamps every needed record with the machine whose list it was drawn from", async () => {
    writeBundleFile(PEER_BUNDLE.file);
    const mine = idx(ME, {
      "t-1": entry({
        localSessionId: "local-mine",
        headEntryUuid: "head-mine",
        lastActiveAt: "2026-07-22T00:00:00Z",
        bundles: [],
      }),
    });

    const out = await runSelectStage(input({ indexes: [mine, peerIndex()], latest: true }));

    expect(out.kind).toBe("proceed");
    if (out.kind !== "proceed") return;
    expect(out.value.needed.map((n) => n.machineId)).toEqual(["m2"]);
    expect(out.value.needed.map((n) => n.record.bundleId)).toEqual(["b0"]);
    // ...and never this machine's own id, which is what `target.latest` is on
    // this branch and what a "stamp with the resolved machine" shortcut would
    // have produced.
    expect(out.value.needed.every((n) => n.machineId !== ME)).toBe(true);
  });
});

/**
 * THE FOURTH EXIT, tested from the outcome inward.
 *
 * Nothing in the codebase produces a `report` outcome yet — it becomes reachable
 * when chain assembly lands and an assembled plan can legitimately be empty. So
 * these tests construct the outcome directly and assert the `HubPullResult` it
 * yields, which is the only way an exit with no producer can be shown to be
 * wired rather than merely declared. An unrendered arm is a claim that the
 * result type can express "applied nothing, and here is why", not a fact.
 *
 * The complementary half is in the record stage's "throws on an empty fetch
 * plan" case above: together they say the arm is necessary AND connected.
 */
describe("select report arm (the fourth exit)", () => {
  const REASON =
    "This thread's history was worked out in full and every bundle in it is already here.";

  function report(over: Partial<SelectReport> = {}): SelectReport {
    return { threadId: "t-1", sourceMachineId: "m2", reason: REASON, findings: {}, ...over };
  }

  it("renders a success result that applied nothing and says why", () => {
    const outcome: SelectOutcome = {
      kind: "report", value: report(), warnings: ["the stage's own sentence"],
    };
    expect(outcome.kind).toBe("report");
    if (outcome.kind !== "report") return;

    const result = reportPullResult(outcome.value, ["the caller's own", ...outcome.warnings]);

    expect(result).toEqual({
      success: true,
      command: "pull",
      threadId: "t-1",
      // Still "the machine this pull resolved to" — the report says nothing
      // about how many machines' lists were read to reach it.
      sourceMachineId: "m2",
      importedSessions: [],
      skippedSessions: [],
      // Nothing landed, so no thread mapping was written and none is claimed.
      localSessionId: null,
      workspaceUnpacked: null,
      nothingToApply: { reason: REASON },
      warnings: ["the caller's own", "the stage's own sentence"],
    });
    // Not a refusal wearing a success flag: no `error`, no `suggestion`, and no
    // `reason` discriminator at the top level of the result.
    expect(result.success).toBe(true);
    expect("error" in result).toBe(false);
    expect("suggestion" in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual([
      "command", "importedSessions", "localSessionId", "nothingToApply", "skippedSessions",
      "sourceMachineId", "success", "threadId", "warnings", "workspaceUnpacked",
    ]);
  });

  /**
   * `findings` is spread, not copied field by field, and that is the property
   * the next task depends on: the chain gaps and advertised-but-unshipped heads
   * assembly will report are additions to `HubPullFindings`, so they must reach
   * the result with no edit to the arm or to its renderer. The second assertion
   * proves that mechanically, with a field the type does not declare yet.
   */
  it("spreads the shared findings verbatim, including ones not declared yet", () => {
    const unfetchableBundles = [{ machineId: "m3", machineName: "laptop", bundleIds: ["b9"] }];

    const declared = reportPullResult(report({ findings: { unfetchableBundles } }), []);
    expect(declared.unfetchableBundles).toEqual(unfetchableBundles);

    const future = { unfetchableBundles, chainGaps: [{ afterUuid: "u-7", stranded: 2 }] };
    const widened = reportPullResult(report({ findings: future as HubPullFindings }), []);
    expect(widened).toMatchObject({
      unfetchableBundles,
      chainGaps: [{ afterUuid: "u-7", stranded: 2 }],
    });
  });

  /**
   * An empty `findings` is the ordinary case, and it must not leave the result
   * carrying keys whose presence a caller reads as a disclosure.
   */
  it("adds no disclosure keys when there is nothing to disclose", () => {
    const result = reportPullResult(report(), []);
    expect("unfetchableBundles" in result).toBe(false);
  });

  /**
   * The wiring, asserted against the sequencer's own source because no input
   * reaches this branch yet. Two facts, and the second is the contract the
   * select stage's union doc states: `stop` is dispatched BEFORE the stage's
   * warnings are spread (its results have no `warnings` field to hold them),
   * and `report` after (its result does, and a pull that changed nothing with
   * no account of why is the outcome this exit exists to prevent).
   */
  it("is dispatched by hubPull, after the warnings spread and after every stop", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "src", "hub", "pull.ts"),
      "utf-8"
    ).replace(/\r\n/g, "\n");
    const start = src.indexOf("export async function hubPull(");
    expect(start, "hubPull must exist in src/hub/pull.ts").toBeGreaterThan(-1);
    const body = src.slice(start);

    expect(body).toContain('sel.kind === "report"');
    expect(body).toContain("reportPullResult(sel.value");

    const stopAt = body.indexOf('if (sel.kind === "stop") return sel.result;');
    const spreadAt = body.indexOf("warnings.push(...sel.warnings);");
    const reportAt = body.indexOf('sel.kind === "report"');
    expect(stopAt, "the stop dispatch must still be in hubPull").toBeGreaterThan(-1);
    expect(spreadAt, "the select stage's warnings must be spread after the stop dispatch").toBeGreaterThan(stopAt);
    expect(reportAt, "the report dispatch must come after that spread").toBeGreaterThan(spreadAt);
  });
});

/**
 * THE PER-RECORD SOURCE MACHINE, and the invariance proof that it changed
 * nothing for the shape every hub actually has today.
 *
 * `needed` used to be `HubBundleRecord[]` drawn from exactly ONE machine's
 * bundle list, so one `sourceMachineId` scalar described every record in it.
 * Three sites downstream spend that scalar on a peer ledger, and the moment
 * chain assembly lets `needed` span machines the scalar is wrong for some of
 * the records — silently, with no type error and no throw.
 *
 * Why that is not cosmetic, in the invariant's own words:
 *
 * > Any future transfer path that moves sessions BETWEEN machines without
 * > going through the hub must NOT credit the hub ledger here. Doing so would
 * > make the next push ship only a delta, leaving a continuation chain on the
 * > hub with no base bundle to anchor it — an unreconstructable thread for any
 * > third machine.
 * > — `recordSentToPeer`, src/sync-state.ts
 *
 * The doc is written about the hub's own peer id, but the mechanism is the
 * same for a machine's: `peers[...].received` is `selectNeededBundles`'s dedup
 * input and `peers[...].sent` is the incremental diff's baseline, so crediting
 * machine X for content machine Y supplied makes the next push believe Y holds
 * a base it does not. That is the unreconstructable-thread defect #35 exists to
 * fix, reintroduced by its own fix.
 *
 * So this block is a RATCHET, not a feature test. The end-to-end case below
 * asserts on the sync-state FILE, and it was written and run green against the
 * scalar version of the code before the pairing existed — which is what makes
 * "credits exactly the ledgers it credits today" a measurement rather than a
 * hope. The two unit cases under it are the half a two-machine pull cannot
 * reach: with one machine supplying every bundle, the record's machine and the
 * pull's resolved machine are the same string, so only a plan whose record
 * disagrees with the pull's source can tell which one a site spent.
 */
describe("per-record source machine (the sourceMachineId ripple)", () => {
  const CLAUDE_VERSION = "2.1.81";

  /**
   * A -> hub -> B, twice: a full bundle B imports, then a continuation B
   * SPLICES onto it. The splice matters — it is the only path that reaches
   * `recordSplice`, i.e. the two `peerId:` sites, and a pull that only ever
   * imports fragments would assert nothing about them.
   */
  it("credits exactly the ledgers a two-machine pull credits today", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sm-ledger-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sm-ledger-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sm-ledger-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sm-ledger-fix-"));
    const projectB = mkdtempSync(join(tmpdir(), "sm-ledger-projB-"));
    let restore = overrideHome(homeA);
    try {
      // --- A: a real, git-less project pushed once --------------------------
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = join(base, "projA-ledger");
      mkdirSync(projectA, { recursive: true });
      writeFileSync(join(projectA, "README.md"), "hello\n");
      const encodedA = encodeProjectPath(projectA);
      cpSync(join(configDirA, "projects", FIXTURE_ENCODED), join(configDirA, "projects", encodedA), {
        recursive: true,
      });
      const aJsonl = join(configDirA, "projects", encodedA, `${FIXTURE_SESSION_ID}.jsonl`);

      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      // Both peer ids the assertions below name, read from the real sources
      // rather than guessed: the machine id is a randomUUID and the hub peer
      // is `hub:<hubId>` (pull-resolve.ts).
      const machineA = loadOrCreateMachineId().id;
      const hubId = (JSON.parse(readFileSync(join(hub, HUB_JSON), "utf-8")) as { hubId: string }).hubId;
      const hubPeerId = `hub:${hubId}`;

      const push1 = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(push1.success).toBe(true);
      if (!push1.success) return;

      // --- B: links to the same hub project and bootstraps off push #1 ------
      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      writeLocalProjectId(projectB, {
        projectId: push1.projectId, name: "projA-ledger",
        createdAt: "2026-08-01T00:00:00.000Z", createdByMachine: machineA,
      });
      const pull1 = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(pull1.success).toBe(true);
      if (!pull1.success) return;
      const bSessionId = (pull1 as HubPullResult).localSessionId;
      expect(bSessionId, "B's bootstrap must land a local session").toBeTruthy();
      const bJsonl = join(configDirB, "projects", encodeProjectPath(projectB), `${bSessionId}.jsonl`);
      // State the base's age explicitly rather than leaning on append.ts's
      // self-write exemption (that exemption is a sub-ms clock coincidence,
      // never a fixture) — without it the next pull declines the splice as
      // "recently-active" and this case silently tests the fragment path.
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(bJsonl, old, old);

      // --- A continues the same thread and pushes a continuation ------------
      restore.restore();
      restore = overrideHome(homeA);
      const anchor = readLastEntryUuid(aJsonl);
      expect(anchor, "A's session must have a head entry").toBeTruthy();
      appendFileSync(
        aJsonl,
        JSON.stringify({
          uuid: "a-ledger-1", parentUuid: anchor, timestamp: "2026-08-01T12:00:00.000Z",
          sessionId: FIXTURE_SESSION_ID, cwd: projectA, version: CLAUDE_VERSION, type: "user",
          message: { role: "user", content: "more work on A" },
        }) + "\n",
        "utf-8"
      );
      const push2 = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub, claudeVersion: CLAUDE_VERSION,
      });
      expect(push2.success).toBe(true);
      if (!push2.success) return;

      // --- The act: B pulls the continuation --------------------------------
      restore.restore();
      restore = overrideHome(homeB);
      const pull2 = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      });
      expect(pull2.success).toBe(true);
      if (!pull2.success) return;
      const p2 = pull2 as HubPullResult;
      // Preconditions, so a fixture drift fails HERE rather than leaving the
      // ledger assertions below vacuously true of some other code path.
      expect(p2.appended, "the continuation must SPLICE, which is what runs recordSplice").toHaveLength(1);
      expect(p2.localSessionId).toBe(bSessionId);
      // The pull's resolved machine — still meaningful, and still A's, which is
      // also why a two-machine pull cannot by itself distinguish the scalar
      // from the per-record id. See the unit cases below.
      expect(p2.sourceMachineId).toBe(machineA);

      // --- The invariant, read off the state FILE ---------------------------
      const stateB = readSyncState(projectB);
      // Exactly two ledgers exist: the machine that supplied the bundles, and
      // the hub that mediated them. A mis-credit shows up here as a third key
      // or as a receipt sitting under the wrong one of these two.
      expect(Object.keys(stateB.peers).sort()).toEqual([hubPeerId, machineA].sort());
      const headNow = readLastEntryUuid(bJsonl);
      expect(headNow, "the spliced base must still have a readable head").toBeTruthy();
      // Every receipt A's ledger holds names B's own session — the mapping
      // `selectNeededBundles` dedups the next pull against.
      const receipts = Object.entries(stateB.peers[machineA].received);
      expect(receipts.length).toBeGreaterThan(0);
      for (const [sessionIdInBundle, rec] of receipts) {
        expect(rec.localSessionId, `receipt for ${sessionIdInBundle} must credit B's session`).toBe(bSessionId);
      }
      // ...and both "already has it" ledgers are level with the spliced head.
      // These two are `recordSplice`'s writes, i.e. the site that spends the
      // per-bundle machine id.
      expect(Object.keys(stateB.peers[machineA].sent)).toEqual([bSessionId]);
      expect(stateB.peers[machineA].sent[bSessionId!]).toMatchObject({
        headEntryUuid: headNow, sentAsType: "continuation",
      });
      expect(Object.keys(stateB.peers[hubPeerId].sent)).toEqual([bSessionId]);
      expect(stateB.peers[hubPeerId].sent[bSessionId!]).toMatchObject({
        headEntryUuid: headNow, sentAsType: "continuation",
      });
      expect(getThreadId(stateB, bSessionId!)).toBe(p2.threadId);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base, projectB]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});
