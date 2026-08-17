import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  makeLookLive,
  plainEntries,
} from "./helpers/hub-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPull, type HubPullOptions } from "../src/hub/pull.js";
import { hubPush } from "../src/hub/push.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { readLastEntryUuid } from "../src/jsonl.js";
import { encodeProjectPath } from "../src/platform.js";
import type { HubPullResult } from "../src/types.js";

/**
 * #63 — the shared layers on the paths that do NOT import a session.
 *
 * `reconcileSharedLayers` runs inside `importSession`. A pull that SPLICES a
 * continuation onto an existing transcript — or adopts the hub's branch over a
 * diverged one — handles the bundle and returns before that call, so for the
 * whole of Slice 2 the bundle's `memory/` was extracted and then deleted with
 * the extract dir.
 *
 * It never healed. The pushing machine credits its own hub ledger with the
 * digest of the memory it sent (`hub/push.ts` -> `setPeerMemoryDigest`), so the
 * exporter does not ship that memory again: after a machine's first pull of a
 * thread, memory updates reached it only on the paths where the splice was
 * DECLINED. That is also why it hid — inside the 5-minute liveness window the
 * splice declines and the fragment import applies the memory, so an interactive
 * test right after a push shows it working. The failure needs the quiet path,
 * which is the common one.
 *
 * Every assertion below is on the typed fields #59 added (`memoryDir`,
 * `memoryIndex`, `memoryConflicts[].parkedAs`) plus the files on disk — never on
 * warning prose.
 */
describe("hub pull — a spliced bundle's memory reaches the machine", () => {
  const BRAND_NEW = "---\nname: Brand new\n---\n\nLearned on the other machine.\n";
  const CLAUDE_VERSION = "2.1.81";

  interface SpliceArrangement {
    /** Machine A's memory directory — where the pulled memory must land. */
    memDirA: string;
    /** A's local transcript for the thread; the splice target. */
    basePath: string;
    /** A's project path — the `cwd` a locally-forked entry has to carry. */
    projectA: string;
    pull(over?: Partial<HubPullOptions>): Promise<Awaited<ReturnType<typeof hubPull>>>;
    cleanup(): void;
  }

  /**
   * The reproduction from the issue, with the roles as `arrangeContinuation`
   * assigns them (B pushes the continuation, A is the machine that splices):
   *
   *   1. A pushes the fixture session — a full bundle carrying A's `memory/`.
   *   2. B pulls it, so B holds the same memory and the same conversation.
   *   3. B adds `brand_new.md`, points its `MEMORY.md` at it, appends two
   *      transcript entries and pushes the resulting CONTINUATION bundle. The
   *      changed memory rides along: B has never pushed, so its hub-peer
   *      memory ledger is unknown and every unknown ships.
   *   4. A's base is aged out of the append liveness window, so A's pull takes
   *      the splice rather than declining into a fragment import.
   *
   * It is built here rather than on `arrangeContinuation` because the memory
   * edit has to happen between B's pull and B's push, which that helper performs
   * back to back.
   */
  async function arrangeSplice(label: string): Promise<SpliceArrangement> {
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

      const projectDirB = join(configDirB, "projects", encodeProjectPath(projectB));
      const memDirB = join(projectDirB, "memory");
      if (!existsSync(join(memDirB, "test_memory.md"))) {
        throw new Error("arrange: A's memory did not reach B on the first pull");
      }
      // Step 2 of the issue: a brand new memory, and the index edit that makes
      // it reachable. Both have to travel; the index is what #49 is about and
      // the file is what #53 is about.
      writeFileSync(join(memDirB, "brand_new.md"), BRAND_NEW);
      writeFileSync(
        join(memDirB, "MEMORY.md"),
        readFileSync(join(memDirB, "MEMORY.md"), "utf-8") +
          "- [Brand new](brand_new.md) — learned on machine B\n"
      );

      const bJsonl = join(projectDirB, `${localB}.jsonl`);
      const anchor = readLastEntryUuid(bJsonl);
      if (!anchor) throw new Error("arrange: B's session has no head entry");
      appendEntries(bJsonl, plainEntries(anchor, localB, projectB));
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
        memDirA: join(projectDirA, "memory"),
        basePath,
        projectA,
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

  it("applies the bundle's memory when the continuation is SPLICED, not imported", async () => {
    const f = await arrangeSplice("sesh-splice-mem1");
    try {
      const pull = await f.pull();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      // The path under test really is the splice: two entries welded onto the
      // existing transcript, and NO session imported. Without this the test
      // would pass on the fragment path, which never had the defect.
      expect(p.appended).toHaveLength(1);
      expect(p.appended![0].entriesAppended).toBe(2);
      expect(p.importedSessions).toEqual([]);

      // The issue's measured result was `memoryDir: undefined` and no file.
      expect(p.memoryDir).toBe(f.memDirA);
      expect(existsSync(join(f.memDirA, "brand_new.md"))).toBe(true);
      expect(readFileSync(join(f.memDirA, "brand_new.md"), "utf-8")).toBe(BRAND_NEW);

      // …and the index edit that makes it reachable, which is the half a copy
      // of the file alone would not deliver (#49).
      expect(p.memoryIndex).toBeDefined();
      expect(p.memoryIndex!.added).toEqual(["brand_new.md"]);
      expect(p.memoryIndex!.unindexed).toEqual([]);
      expect(readFileSync(join(f.memDirA, "MEMORY.md"), "utf-8")).toContain("(brand_new.md)");

      // Non-destructive, as everywhere else in this step: A's own memory and
      // its existing index line are untouched, and nothing was parked.
      expect(readFileSync(join(f.memDirA, "test_memory.md"), "utf-8")).toContain(
        "Use vitest for testing."
      );
      expect(readFileSync(join(f.memDirA, "MEMORY.md"), "utf-8")).toContain("(test_memory.md)");
      expect(p.memoryConflicts).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  it("applies the bundle's memory when the hub's branch is ADOPTED over a fork", async () => {
    // The adopt path has the same shape — it lands the hub's branch and returns
    // before the fragment import — and the memory it drops is just as
    // un-resendable, so it gets the same answer. Withholding it here would make
    // `--on-divergence adopt-hub` the one way to receive a thread's transcript
    // without the memory that came with it.
    const f = await arrangeSplice("sesh-splice-mem2");
    try {
      // Fork A's side from the very entry B's continuation is anchored on, then
      // age it back out of the live window (appending just moved its mtime),
      // so this is a divergence story and not a liveness one.
      appendEntries(
        f.basePath,
        localEntries(FIXTURE_HEAD_UUID, FIXTURE_SESSION_ID, f.projectA)
      );
      ageOutOfLiveWindow(f.basePath);

      const pull = await f.pull({ onDivergence: "adopt-hub" });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      expect(p.divergence?.resolution).toBe("adopt-hub");
      expect(p.divergence?.preservedSessionId).toBeDefined();
      expect(p.appended).toHaveLength(1);
      expect(p.importedSessions).toEqual([]);

      expect(p.memoryDir).toBe(f.memDirA);
      expect(existsSync(join(f.memDirA, "brand_new.md"))).toBe(true);
      expect(p.memoryIndex!.added).toEqual(["brand_new.md"]);
      expect(readFileSync(join(f.memDirA, "MEMORY.md"), "utf-8")).toContain("(brand_new.md)");
    } finally {
      f.cleanup();
    }
  });

  it("reconciles a bundle ONCE when the splice is declined and it falls through to import", async () => {
    // The third thing #63 says to decide: a refused splice falls through to
    // `importSession`, which reconciles the same bundle. Whatever the splice
    // path adds must not make that a second run.
    //
    // `alreadyPresent` is the discriminator, deliberately. The accumulator
    // dedupes `memoryConflicts` by VALUE and `added` by target, so a double-run
    // is invisible in both — but `alreadyPresent` is SUMMED across bundles, so
    // reconciling one bundle twice counts the incoming pointers twice. That is
    // also why the fix must not lean on the value-dedupe: it makes a double-run
    // harmless, not correct.
    //
    // The extra LOCAL index line below is what makes that discriminator work,
    // and it was measured: without it, A's index after one union is BYTE-
    // IDENTICAL to the incoming one, so a second run takes the `identical`
    // branch, reports `alreadyPresent: 0`, and the sum is 1 either way. With a
    // local-only line the union result can never equal the incoming text, so a
    // second run really does re-count both incoming pointers (1 -> 3).
    const f = await arrangeSplice("sesh-splice-mem3");
    try {
      const indexA = join(f.memDirA, "MEMORY.md");
      writeFileSync(
        indexA,
        readFileSync(indexA, "utf-8") + "- [Local note](local-note.md) — only on A\n"
      );
      makeLookLive(f.basePath);

      const pull = await f.pull();
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      // The splice really was declined and the bundle really was imported.
      expect(p.appended ?? []).toEqual([]);
      expect(p.importedSessions).toHaveLength(1);

      // One reconciliation: A's index already lists `test_memory.md`, so the
      // union sees exactly one pointer it already had. Two runs report 3.
      expect(p.memoryIndex).toBeDefined();
      expect(p.memoryIndex!.alreadyPresent).toBe(1);
      expect(p.memoryIndex!.added).toEqual(["brand_new.md"]);
      expect(existsSync(join(f.memDirA, "brand_new.md"))).toBe(true);
      // The local-only line is still there, still first — the union never
      // reorders or drops a local line, and a second run would not either.
      expect(readFileSync(join(f.memDirA, "MEMORY.md"), "utf-8")).toContain(
        "- [Local note](local-note.md) — only on A\n"
      );
    } finally {
      f.cleanup();
    }
  });
});
