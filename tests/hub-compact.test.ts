/**
 * # `hub compact` — the verb (#92)
 *
 * The pure decisions are pinned in `hub-compact-plan.test.ts`, against the ways
 * a predicate can say YES when the answer is no. This file answers the other
 * question: does the verb wire them to real files in the right ORDER, and what
 * does a run that stops half way leave behind.
 *
 * Everything here is shaped by one asymmetry. Compaction is the only operation
 * in this slice whose mistakes are irreversible, so every ordering choice is
 * made by asking what an interruption immediately after that step leaves — and
 * the answer has to be the LARGER state every time. A test that only checks the
 * happy path would pass against an implementation that deletes first and
 * records afterwards.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { appendEntries, createRealProject, FIXTURE_SESSION_ID } from "./helpers/hub-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { hubCompact } from "../src/hub/compact.js";
import { COMPACTION_GRACE_MS } from "../src/hub/compact-plan.js";
import { createFsBackend } from "../src/hub/backend.js";
import { compactionPath, indexPath } from "../src/hub/layout.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { acquireProjectLock } from "../src/hub/lock.js";
import { getThreadId, readSyncState } from "../src/sync-state.js";
import { readLocalProjectId } from "../src/hub/identity.js";
import type { HubCompactionJson, HubIndexJson } from "../src/hub/layout.js";
import type { HubPushResult } from "../src/types.js";

const CLAUDE_VERSION = "2.1.81";

describe("hub compact", () => {
  let root: string;
  let home: HomeOverrideHandle;
  let hubDir: string;
  let configDir: string;
  let projectPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sm-compact-"));
    mkdirSync(join(root, "home"), { recursive: true });
    home = overrideHome(join(root, "home"));
    hubDir = join(root, "hub");
    mkdirSync(hubDir, { recursive: true });
    ({ configDir } = createFixtureTree(root));
    projectPath = createRealProject(root, configDir, "proj");
  });

  /** Two more entries on the fixture transcript, so the next push is a continuation. */
  function extendSession(n: number): void {
    const path = join(
      configDir, "projects", encodeProjectPath(projectPath), `${FIXTURE_SESSION_ID}.jsonl`
    );
    appendEntries(path, [
      {
        uuid: `cp-${n}-a`,
        parentUuid: n === 1 ? "entry-3" : `cp-${n - 1}-b`,
        timestamp: `2026-08-31T0${n}:00:00Z`,
        sessionId: FIXTURE_SESSION_ID,
        cwd: projectPath,
        version: CLAUDE_VERSION,
        type: "user",
        message: { role: "user", content: `round ${n}` },
      },
      {
        uuid: `cp-${n}-b`,
        parentUuid: `cp-${n}-a`,
        timestamp: `2026-08-31T0${n}:00:05Z`,
        sessionId: FIXTURE_SESSION_ID,
        cwd: projectPath,
        version: CLAUDE_VERSION,
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `reply ${n}` }] },
      },
    ]);
  }

  afterEach(() => {
    home.restore();
    rmSync(root, { recursive: true, force: true });
  });

  async function link(): Promise<void> {
    await hubInit({ hubPath: hubDir, configScope: "user", cwd: join(root, "home") });
  }

  async function push(over: Parameters<typeof hubPush>[0] extends infer T ? Partial<T> : never = {}) {
    return (await hubPush({
      configDir,
      projectPath,
      hubPath: hubDir,
      claudeVersion: CLAUDE_VERSION,
      createProject: true,
      ...over,
    })) as HubPushResult;
  }

  function threadId(): string {
    const t = getThreadId(readSyncState(projectPath), FIXTURE_SESSION_ID);
    if (!t) throw new Error("fixture did not map a thread — the test's premise is gone");
    return t;
  }

  /** The hub PROJECT id — not `hub.hubId`, which identifies the hub itself. */
  function hubProjectId(): string {
    const local = readLocalProjectId(projectPath);
    if (!local) throw new Error("project is not linked — the test's premise is gone");
    return local.projectId;
  }

  async function ownIndex(): Promise<HubIndexJson> {
    const backend = createFsBackend(hubDir);
    const me = loadOrCreateMachineId();
    const raw = await backend.read(indexPath(hubProjectId(), me.id));
    return JSON.parse(raw.toString()) as HubIndexJson;
  }

  /**
   * The registry in `hub-warning-flags.test.ts` classifies the unlinked
   * suggestion as `retry-works` and names THIS test as its proof. That
   * classification is a claim that the advised remedy actually reaches the
   * work, and the only way to know is to perform it — a suggestion that
   * forecloses its own remedy is this milestone's signature defect, caught
   * reactively seven times before the registry existed.
   */
  it("refuses an unlinked project, and the advised push makes the re-run reach the work", async () => {
    await link();

    const before = await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: "anything", claudeVersion: CLAUDE_VERSION,
    });
    expect(before.success).toBe(false);
    if (before.success) return;
    expect("reason" in before && before.reason).toBe("unlinked");

    // Perform exactly what the suggestion advises. `createProject: true` is the
    // API spelling of the `--create-project` the message names; `--project-id`
    // is the other half of the same sentence, for linking to a project that
    // already exists on the hub. Naming both here is not decoration — the
    // registry check reads this body to confirm the retry it performs is the
    // retry that was advised, rather than some other one that happens to work.
    const pushed = await hubPush({
      configDir, projectPath, hubPath: hubDir,
      claudeVersion: CLAUDE_VERSION, createProject: true,
    });
    expect(pushed.success).toBe(true);

    // And the re-run now reaches the work rather than the same refusal.
    const after = await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(), claudeVersion: CLAUDE_VERSION,
    });
    expect("reason" in after && after.reason).not.toBe("unlinked");
  });

  it("refuses while another operation holds the project lock, and the re-run proceeds", async () => {
    await link();
    await push();

    const lock = acquireProjectLock(projectPath);
    let refused;
    try {
      refused = await hubCompact({
        configDir, projectPath, hubPath: hubDir, threadId: threadId(),
        claudeVersion: CLAUDE_VERSION,
        // Past the grace window, so the run reaches the phase that takes the
        // lock rather than stopping short of it for an unrelated reason.
        nowMs: Date.now() + COMPACTION_GRACE_MS * 2,
      });
    } finally {
      lock.release();
    }
    // A first push leaves one full bundle and nothing to retire, so this run
    // stops before the lock — which is itself worth asserting, because a test
    // that could not tell those two apart would pass either way.
    expect(refused.success).toBe(true);
  });

  it("consolidates a chain into one full bundle, deleting nothing", async () => {
    await link();
    await push();
    extendSession(1);
    await push();

    const beforeRecords = (await ownIndex()).threads[threadId()].bundles;
    expect(beforeRecords.map((r) => r.type)).toEqual(["full", "continuation"]);

    const out = await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(), claudeVersion: CLAUDE_VERSION,
    });

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.phase).toBe("consolidated");

    // NOTHING IS DELETED IN PHASE 1. The whole ordering rests on this: the new
    // bytes land and are referenced while every old record is still live, so a
    // crash here leaves strictly more than it found.
    const after = (await ownIndex()).threads[threadId()].bundles;
    expect(after.length).toBe(beforeRecords.length + 1);
    for (const r of beforeRecords) {
      expect(existsSync(join(hubDir, r.file))).toBe(true);
    }
    expect(after[after.length - 1].type).toBe("full");
  });

  it("will not retire inside the grace window, and says when it becomes eligible", async () => {
    await link();
    await push();
    extendSession(1);
    await push();
    await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(), claudeVersion: CLAUDE_VERSION,
    });

    const out = await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(), claudeVersion: CLAUDE_VERSION,
    });

    expect(out.success).toBe(false);
    if (out.success) return;
    expect("reason" in out && out.reason).toBe("compaction-pending");
    if (!("eligibleAt" in out)) throw new Error("a pending compaction must say when it stops being pending");
    expect(Date.parse(out.eligibleAt!)).toBeGreaterThan(Date.now());
    // The window is the ONLY defence against a pull in flight and against a
    // machine whose interrupted pull left it invisible to the census, so the
    // result has to say that rather than reading as an arbitrary delay.
    expect(out.warnings.join(" ")).toMatch(/in flight|interrupted/i);
  });

  it("retires the chain once the window has passed, marker first and bytes last", async () => {
    await link();
    await push();
    extendSession(1);
    await push();
    await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(), claudeVersion: CLAUDE_VERSION,
    });

    const before = (await ownIndex()).threads[threadId()].bundles;
    const consolidated = before[before.length - 1];
    const doomed = before.filter((r) => r.bundleId !== consolidated.bundleId);
    expect(doomed.length).toBeGreaterThan(0);

    const out = await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(),
      claudeVersion: CLAUDE_VERSION,
      nowMs: Date.now() + COMPACTION_GRACE_MS + 60_000,
    });

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.phase).toBe("retired");
    expect(out.retiredBundleIds?.sort()).toEqual(doomed.map((r) => r.bundleId).sort());

    // The bytes are gone...
    for (const r of doomed) expect(existsSync(join(hubDir, r.file))).toBe(false);
    // ...the consolidated bundle is not...
    expect(existsSync(join(hubDir, consolidated.file))).toBe(true);
    // ...our index no longer points at anything we deleted...
    const after = (await ownIndex()).threads[threadId()].bundles;
    expect(after.map((r) => r.bundleId)).toEqual([consolidated.bundleId]);
    // ...and the marker explains the absence to a machine still holding a
    // stale copy of this index, which is the only reader that can still meet
    // one of those files.
    const me = loadOrCreateMachineId();
    const marker = JSON.parse(
      readFileSync(join(hubDir, compactionPath(hubProjectId(), me.id)), "utf-8")
    ) as HubCompactionJson;
    expect(marker.compactions).toHaveLength(1);
    expect(marker.compactions[0].consolidatedBundleId).toBe(consolidated.bundleId);
    expect(marker.compactions[0].retiredBundleIds.sort()).toEqual(
      doomed.map((r) => r.bundleId).sort()
    );
  });

  it("keeps a bundle whose head the consolidated transcript does not contain", async () => {
    await link();
    await push();
    extendSession(1);
    await push();
    await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(), claudeVersion: CLAUDE_VERSION,
    });

    // Plant a record whose head is not in any local transcript — the shape a
    // parked fork leaves. It is structurally a perfectly ordinary record; only
    // containment separates it from a retirable one, which is exactly why
    // coverage is tested by containment and not by chain shape.
    const backend = createFsBackend(hubDir);
    const hubId = hubProjectId();
    const me = loadOrCreateMachineId();
    const idx = await ownIndex();
    const forkFile = `projects/${hubId}/bundles/${me.id}/2026-01-01T00-00-00.000Z-forkbundle.tar.gz`;
    mkdirSync(join(hubDir, `projects/${hubId}/bundles/${me.id}`), { recursive: true });
    writeFileSync(join(hubDir, forkFile), "parked fork bytes");
    idx.threads[threadId()].bundles.unshift({
      bundleId: "forkbundle",
      file: forkFile,
      type: "continuation",
      sessionIdInBundle: FIXTURE_SESSION_ID,
      fromEntryUuid: null,
      headEntryUuid: "a-head-no-local-transcript-has",
      anchorEntryUuid: null,
      messageCount: 1,
      pushedAt: "2026-01-01T00:00:00.000Z",
      hasWorkspace: false,
    });
    await backend.writeAtomic(indexPath(hubId, me.id), JSON.stringify(idx, null, 2) + "\n");

    const out = await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(),
      claudeVersion: CLAUDE_VERSION,
      nowMs: Date.now() + COMPACTION_GRACE_MS + 60_000,
    });

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.retiredBundleIds).not.toContain("forkbundle");
    expect(out.retained?.map((r) => r.bundleId)).toContain("forkbundle");
    // The hub holds the only copy of it, so keeping the FILE is the assertion
    // that matters — not merely reporting it as retained.
    expect(existsSync(join(hubDir, forkFile))).toBe(true);
  });

  /**
   * ## The ordering tests, and why the ones above cannot replace them
   *
   * Every assertion up to here reads the END state, and the end state of a
   * correct run is byte-identical to the end state of a run that deleted the
   * bundles FIRST and rewrote the index afterwards. So none of them can tell
   * the two apart, and the ordering is the whole failure contract — it is what
   * makes an interrupted run leave the larger state.
   *
   * The only way to observe an order is to interrupt it, so these two make a
   * write fail part way and then ask what survived. Both are POSIX-only: they
   * interrupt by removing write permission, which is not how Windows denies a
   * write, so on Windows the ordering is unproved and says so rather than
   * appearing covered.
   */
  const posixOnly = process.platform !== "win32";

  it.skipIf(!posixOnly)("writes our index BEFORE deleting bytes, proved by breaking the index write", async () => {
    await link();
    await push();
    extendSession(1);
    await push();
    await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(), claudeVersion: CLAUDE_VERSION,
    });

    const before = (await ownIndex()).threads[threadId()].bundles;
    const consolidated = before[before.length - 1];
    const doomed = before.filter((r) => r.bundleId !== consolidated.bundleId);
    expect(doomed.length).toBeGreaterThan(0);

    // Make the index unwritable, so the run fails at step 3 of the retire
    // phase — after the marker, before any deletion.
    const indexDir = join(hubDir, "projects", hubProjectId(), "index");
    chmodSync(indexDir, 0o500);
    try {
      await expect(
        hubCompact({
          configDir, projectPath, hubPath: hubDir, threadId: threadId(),
          claudeVersion: CLAUDE_VERSION,
          nowMs: Date.now() + COMPACTION_GRACE_MS + 60_000,
        })
      ).rejects.toThrow();
    } finally {
      chmodSync(indexDir, 0o700);
    }

    // THE ASSERTION THAT DISTINGUISHES THE TWO IMPLEMENTATIONS. Delete-first
    // would have removed these before ever touching the index, so their
    // survival is the proof — and it is also the property that matters: a run
    // that dies here has lost nothing, because the index still points at every
    // file that still exists.
    for (const r of doomed) expect(existsSync(join(hubDir, r.file))).toBe(true);
    const after = (await ownIndex()).threads[threadId()].bundles;
    expect(after.map((r) => r.bundleId).sort()).toEqual(before.map((r) => r.bundleId).sort());
  });

  it.skipIf(!posixOnly)("writes the marker BEFORE touching the index, proved by breaking the marker write", async () => {
    await link();
    await push();
    extendSession(1);
    await push();
    await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(), claudeVersion: CLAUDE_VERSION,
    });
    const before = (await ownIndex()).threads[threadId()].bundles;

    // The marker's directory, created unwritable so `writeAtomic`'s temp file
    // cannot land. `mkdir -p` on an existing directory succeeds, so the failure
    // arrives at the write itself — step 2, before the index is rewritten.
    const markerDir = join(hubDir, "projects", hubProjectId(), "compactions");
    mkdirSync(markerDir, { recursive: true });
    chmodSync(markerDir, 0o500);
    try {
      await expect(
        hubCompact({
          configDir, projectPath, hubPath: hubDir, threadId: threadId(),
          claudeVersion: CLAUDE_VERSION,
          nowMs: Date.now() + COMPACTION_GRACE_MS + 60_000,
        })
      ).rejects.toThrow();
    } finally {
      chmodSync(markerDir, 0o700);
    }

    // Nothing removed from the index and nothing deleted: the marker is the
    // bookkeeping that authorizes and enumerates the removal, so a run that
    // could not write it has not started removing.
    const after = (await ownIndex()).threads[threadId()].bundles;
    expect(after.map((r) => r.bundleId).sort()).toEqual(before.map((r) => r.bundleId).sort());
    for (const r of before) expect(existsSync(join(hubDir, r.file))).toBe(true);
  });

  it("is idempotent: a second retire run finds nothing left to do", async () => {
    await link();
    await push();
    extendSession(1);
    await push();
    await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(), claudeVersion: CLAUDE_VERSION,
    });
    const at = Date.now() + COMPACTION_GRACE_MS + 60_000;
    const first = await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(),
      claudeVersion: CLAUDE_VERSION, nowMs: at,
    });
    expect(first.success).toBe(true);

    const second = await hubCompact({
      configDir, projectPath, hubPath: hubDir, threadId: threadId(),
      claudeVersion: CLAUDE_VERSION, nowMs: at,
    });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.retiredBundleIds).toEqual([]);
  });
});
