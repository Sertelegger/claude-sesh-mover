import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { overrideHome } from "./helpers/env.js";
import {
  FIXTURE_HEAD_UUID,
  FIXTURE_SESSION_ID,
  ageOutOfLiveWindow,
  appendEntries,
  createRealProject,
  localEntries,
} from "./helpers/hub-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPull, type HubPullOptions } from "../src/hub/pull.js";
import { hubPush } from "../src/hub/push.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { readLastEntryUuid } from "../src/jsonl.js";
import { encodeProjectPath } from "../src/platform.js";
import type { HubPullResult } from "../src/types.js";

/**
 * #137 — #127's session-id map never reached a continuation bundle.
 *
 * A continuation's lines are the SENDER's lines, verbatim: they carry the
 * sender's local session id in `session_id` wherever the sender's own run wrote
 * the entry, and inside every `<configDir>/projects/<enc>/<id>/tool-results/…`
 * pointer. The bundle's own session id is a fresh uuid stamped only on the
 * synthetic header, and the manifest names the sender's id as
 * `continuation.continuesLocalSessionId`. Before the fix neither apply path put
 * that id in the map — the splice passed no map at all and the importer keyed
 * only the bundle's ids — so both left `session_id` naming a run that is not on
 * this machine and a pointer naming a directory that does not exist, while the
 * file it points at sat in the sibling directory the layer copy put it in.
 *
 * The issue's repro, at pull level: A pushes the fixture session, B pulls it
 * (landing as S1b), B appends a persisted tool output and pushes the
 * continuation, and A pulls it — spliced, adopted, and with `--no-append`.
 */
describe("hub pull — a continuation's session ids reach the landing session (#137)", () => {
  const CLAUDE_VERSION = "2.1.81";
  const TOOL_RESULT_FILE = "tr1.txt";
  const TOOL_RESULT_BYTES = "a large tool output, persisted by Claude Code\n";
  /** A run that is in no bundle anywhere — the byte-identical control. */
  const STRANGER_RUN = "a-run-not-in-this-bundle";

  interface Arrangement {
    configDirA: string;
    projectA: string;
    projectDirA: string;
    basePath: string;
    /** B's local id for the thread — the id the continuation's lines carry. */
    localB: string;
    pull(over?: Partial<HubPullOptions>): Promise<Awaited<ReturnType<typeof hubPull>>>;
    cleanup(): void;
  }

  /**
   * Three entries B appends, shaped the way Claude Code writes a persisted tool
   * output: the tool_result TEXT quotes the path in a `<persisted-output>`
   * block (the copy the model reads), and `toolUseResult.persistedOutputPath`
   * holds it structurally. Both name B's own session directory.
   */
  function continuationEntries(
    anchor: string,
    localB: string,
    projectB: string,
    persistedPath: string
  ): Array<Record<string, unknown>> {
    return [
      {
        uuid: "b-tool-1", parentUuid: anchor, timestamp: "2026-04-11T09:00:00Z",
        sessionId: localB, session_id: localB, cwd: projectB, version: CLAUDE_VERSION,
        type: "assistant",
        message: {
          model: "claude-opus-4-6", id: "msg_tool", role: "assistant",
          content: [{ type: "tool_use", id: "toolu_b1", name: "Bash", input: { command: "cat big.log" } }],
        },
      },
      {
        uuid: "b-tool-2", parentUuid: "b-tool-1", timestamp: "2026-04-11T09:00:05Z",
        sessionId: localB, session_id: localB, cwd: projectB, version: CLAUDE_VERSION,
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result", tool_use_id: "toolu_b1",
            content: `<persisted-output>\nOutput too large (41.2KB). Full output saved to: ${persistedPath}\n\nPreview (first 2KB):\na large tool output\n</persisted-output>`,
          }],
        },
        toolUseResult: {
          stdout: "a large tool output", stderr: "", interrupted: false, isImage: false,
          persistedOutputPath: persistedPath,
        },
      },
      {
        uuid: "b-tool-3", parentUuid: "b-tool-2", timestamp: "2026-04-11T09:00:10Z",
        sessionId: localB, session_id: STRANGER_RUN, cwd: projectB, version: CLAUDE_VERSION,
        type: "user",
        message: { role: "user", content: "an entry another run authored" },
      },
    ];
  }

  async function arrange(label: string): Promise<Arrangement> {
    const homeA = mkdtempSync(join(tmpdir(), `${label}-homeA-`));
    const homeB = mkdtempSync(join(tmpdir(), `${label}-homeB-`));
    const hub = mkdtempSync(join(tmpdir(), `${label}-hub-`));
    const base = mkdtempSync(join(tmpdir(), `${label}-fix-`));
    let projectB: string | undefined;
    let restore = overrideHome(homeA);
    const cleanup = (): void => {
      restore.restore();
      for (const d of [homeA, homeB, hub, base]) rmSync(d, { recursive: true, force: true });
      if (projectB) rmSync(projectB, { recursive: true, force: true });
    };

    try {
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = createRealProject(base, configDirA, "projA");
      const projectDirA = join(configDirA, "projects", encodeProjectPath(projectA));
      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      const pushA = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      });
      if (!pushA.success) throw new Error(`arrange: A's push failed: ${JSON.stringify(pushA)}`);

      restore.restore();
      restore = overrideHome(homeB);

      const configDirB = join(homeB, ".claude");
      projectB = mkdtempSync(join(tmpdir(), `${label}-projB-`));
      writeLocalProjectId(projectB, {
        projectId: pushA.projectId, name: "projA",
        createdAt: "2026-04-10T00:00:00.000Z", createdByMachine: "machine-a",
      });
      const pullB = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: CLAUDE_VERSION,
      });
      if (!pullB.success) throw new Error(`arrange: B's pull failed: ${JSON.stringify(pullB)}`);
      const localB = (pullB as HubPullResult).localSessionId;
      if (!localB) throw new Error("arrange: B's pull identified no local session");

      // The persisted output, where Claude Code on B put it: inside B's own
      // session directory, which is what the continuation's tool-results layer
      // is copied from.
      const projectDirB = join(configDirB, "projects", encodeProjectPath(projectB));
      const toolResultsB = join(projectDirB, localB, "tool-results");
      mkdirSync(toolResultsB, { recursive: true });
      const persistedB = join(toolResultsB, TOOL_RESULT_FILE);
      writeFileSync(persistedB, TOOL_RESULT_BYTES);

      const bJsonl = join(projectDirB, `${localB}.jsonl`);
      const anchor = readLastEntryUuid(bJsonl);
      if (!anchor) throw new Error("arrange: B's session has no head entry");
      appendEntries(bJsonl, continuationEntries(anchor, localB, projectB, persistedB));
      const pushB = await hubPush({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        noWorkspace: true, claudeVersion: CLAUDE_VERSION,
      });
      if (!pushB.success) throw new Error(`arrange: B's push failed: ${JSON.stringify(pushB)}`);
      if (pushB.pushedSessions[0]?.type !== "continuation") {
        throw new Error("arrange: B pushed a full bundle, not a continuation");
      }

      restore.restore();
      restore = overrideHome(homeA);

      const basePath = join(projectDirA, `${FIXTURE_SESSION_ID}.jsonl`);
      ageOutOfLiveWindow(basePath);

      return {
        configDirA, projectA, projectDirA, basePath, localB,
        pull: (over: Partial<HubPullOptions> = {}) =>
          hubPull({
            configDir: configDirA, projectPath: projectA, hubPath: hub,
            latest: true, claudeVersion: CLAUDE_VERSION, ...over,
          }),
        cleanup,
      };
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  function entriesByUuid(path: string): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line) continue;
      const e = JSON.parse(line) as Record<string, unknown>;
      if (typeof e.uuid === "string") out.set(e.uuid, e);
    }
    return out;
  }

  /**
   * Everything the issue asserts about ONE landed transcript. `landingId` is the
   * session the delta's lines now live in — the base on a splice or an adoption,
   * the freshly minted fragment on `--no-append`.
   */
  function expectLanded(f: Arrangement, transcript: string, landingId: string): void {
    const entries = entriesByUuid(transcript);
    const e1 = entries.get("b-tool-1")!;
    const e2 = entries.get("b-tool-2")!;
    const e3 = entries.get("b-tool-3")!;
    expect(e1).toBeDefined();
    expect(e2).toBeDefined();

    // WHO WROTE IT: the sender's run, whose transcript on this machine is now
    // the landing session. Mapped — and the control, a run in no bundle, is not.
    expect(e1.session_id).toBe(landingId);
    expect(e2.session_id).toBe(landingId);
    expect(e3.session_id).toBe(STRANGER_RUN);
    expect(JSON.stringify([e1, e2])).not.toContain(f.localB);

    // The structured pointer names a file that exists, under the landing id…
    const expected = join(f.projectDirA, landingId, "tool-results", TOOL_RESULT_FILE);
    const tr = e2.toolUseResult as Record<string, unknown>;
    expect(tr.persistedOutputPath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf-8")).toBe(TOOL_RESULT_BYTES);

    // …and so does the copy the model actually reads (#136 on this path).
    const block = ((e2.message as Record<string, unknown>).content as Array<Record<string, unknown>>)[0];
    expect(block.content).toContain(`Full output saved to: ${expected}\n`);
  }

  it("maps the sender's id onto the BASE session when the continuation is spliced", async () => {
    const f = await arrange("sesh-137-splice");
    try {
      const pull = await f.pull();
      expect(pull.success).toBe(true);
      const p = pull as HubPullResult;
      // The path under test really is the splice — no fragment was imported.
      expect(p.appended).toHaveLength(1);
      expect(p.appended![0].baseSessionId).toBe(FIXTURE_SESSION_ID);
      expect(p.importedSessions).toEqual([]);
      expectLanded(f, f.basePath, FIXTURE_SESSION_ID);
    } finally {
      f.cleanup();
    }
  });

  it("maps the sender's id onto the base session when the hub branch is ADOPTED", async () => {
    const f = await arrange("sesh-137-adopt");
    try {
      // Fork A's side from the very entry B's continuation is anchored on.
      appendEntries(f.basePath, localEntries(FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, f.projectA));
      ageOutOfLiveWindow(f.basePath);
      const pull = await f.pull({ onDivergence: "adopt-hub" });
      expect(pull.success).toBe(true);
      const p = pull as HubPullResult;
      expect(p.appended).toHaveLength(1);
      expect(p.divergence?.resolution).toBe("adopt-hub");
      expect(p.importedSessions).toEqual([]);
      expectLanded(f, f.basePath, FIXTURE_SESSION_ID);
    } finally {
      f.cleanup();
    }
  });

  it("maps the sender's id onto the MINTED session when the continuation is imported (--no-append)", async () => {
    const f = await arrange("sesh-137-noappend");
    try {
      const pull = await f.pull({ noAppend: true });
      expect(pull.success).toBe(true);
      const p = pull as HubPullResult;
      expect(p.appended ?? []).toEqual([]);
      expect(p.importedSessions).toHaveLength(1);
      const fragmentId = p.importedSessions[0].newId;
      expect(fragmentId).not.toBe(FIXTURE_SESSION_ID);
      expectLanded(f, join(f.projectDirA, `${fragmentId}.jsonl`), fragmentId);
    } finally {
      f.cleanup();
    }
  });
});
