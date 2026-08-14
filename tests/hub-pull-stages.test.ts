import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageOk, stageSkip, stageRefuse, stageAbort } from "../src/hub/pull-stages.js";
import type { ErrorResult, ExportManifest } from "../src/types.js";
import { initApplyState, type PulledCarry } from "../src/hub/pull-apply-state.js";
import { runApplyCarryStage } from "../src/hub/pull-apply-carry.js";
import { createFsBackend } from "../src/hub/backend.js";
import type { HubBackend } from "../src/hub/backend.js";
import { readMachineIndex } from "../src/hub/index-file.js";
import { localProjectIdPath, writeLocalProjectId } from "../src/hub/identity.js";
import {
  HUB_JSON, bundleDir, bundleFileName, indexPath, projectJsonPath,
  type HubBundleRecord,
} from "../src/hub/layout.js";
import type { CarryMeta } from "../src/hub/carry.js";
import { runFetchStage } from "../src/hub/pull-fetch.js";
import { runRecordStage, type RecordApplyView } from "../src/hub/pull-record.js";
import { runResolveStage } from "../src/hub/pull-resolve.js";
import { createArchive } from "../src/archiver.js";
import { computeIntegrityHashFromFile, writeManifest } from "../src/manifest.js";
import { encodeProjectPath } from "../src/platform.js";
import { projectSeshMoverDir } from "../src/paths.js";
import { readSyncState, writeSyncState } from "../src/sync-state.js";
import { bundle, entry, idx, peer, syncState, writeCorruptBundle } from "./helpers/hub-fixtures.js";
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
