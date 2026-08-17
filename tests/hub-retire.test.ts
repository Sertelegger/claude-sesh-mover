import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import {
  appendEntries, arrangeContinuation, type ContinuationArrangement,
} from "./helpers/hub-fixtures.js";
import { readLastEntryUuid } from "../src/jsonl.js";
import { hubInit } from "../src/hub/init.js";
import { hubRetire, hubDelete, orderForDeletion } from "../src/hub/retire.js";
import { hubPull } from "../src/hub/pull.js";
import { hubPush } from "../src/hub/push.js";
import { RETIREMENT_GRACE_MS, readTombstones } from "../src/hub/tombstone.js";
import { createFsBackend } from "../src/hub/backend.js";
import { listHubProjects, writeLocalProjectId } from "../src/hub/identity.js";
import {
  HUB_JSON, bundleDir, indexPath, projectJsonPath, tombstonePath,
} from "../src/hub/layout.js";
import { loadOrCreateMachineId } from "../src/machine.js";
import { projectJsonFilePath } from "../src/paths.js";

const PROJECT_ID = "hub-project-43";
const PROJECT_NAME = "atlas";

/**
 * A hub with one project this machine created, and a directory linked to it —
 * the arrangement both verbs are about, with no sessions in it.
 *
 * Deliberately hand-written rather than driven through `hubPush`: every test
 * below is about the retirement decision, and a push would make the fixture's
 * `createdByMachine` an artifact of which HOME happened to be active. Here it is
 * the subject, so it is set explicitly.
 */
describe("hub retire / hub delete", () => {
  let root: string;
  let home: HomeOverrideHandle;
  let hubDir: string;
  let projectPath: string;
  let configDir: string;
  let meId: string;

  function writeHubFile(rel: string, body: unknown): void {
    const p = join(hubDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf-8");
  }

  function readHubFile(rel: string): unknown {
    return JSON.parse(readFileSync(join(hubDir, rel), "utf-8"));
  }

  /** Every file under the hub root, relative and POSIX-spelled, sorted. */
  function hubFiles(dir = hubDir, prefix = ""): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...hubFiles(join(dir, e.name), rel));
      else out.push(rel);
    }
    return out.sort();
  }

  function writeProjectRecord(createdByMachine: string): void {
    writeHubFile(projectJsonPath(PROJECT_ID), {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      name: PROJECT_NAME,
      matchers: { gitRemotes: [] },
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByMachine,
    });
  }

  /** Some bytes under the project, so a delete has something to remove. */
  function writeProjectContent(): void {
    writeHubFile(indexPath(PROJECT_ID, meId), {
      schemaVersion: 1,
      agent: "claude-code",
      projectId: PROJECT_ID,
      machineId: meId,
      updatedAt: "2026-08-01T00:00:00.000Z",
      projectPath,
      threads: {},
    });
    const bundle = join(hubDir, bundleDir(PROJECT_ID, meId), "2026-08-01T00-00-00.000Z-b1.tar.gz");
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, "not-a-real-archive");
  }

  /** Pretend the tombstone was written `ms` in the past. */
  function backdateTombstone(ms: number): void {
    const rel = tombstonePath(PROJECT_ID, meId);
    const t = readHubFile(rel) as Record<string, unknown>;
    t.retiredAt = new Date(Date.now() - ms).toISOString();
    writeHubFile(rel, t);
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "sm-retire-"));
    mkdirSync(join(root, "home"), { recursive: true });
    home = overrideHome(join(root, "home"));
    hubDir = join(root, "hub");
    projectPath = join(root, "proj");
    configDir = join(root, "home", ".claude");
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    await hubInit({ hubPath: hubDir, configScope: "user", cwd: join(root, "home") });
    meId = loadOrCreateMachineId().id;
    writeProjectRecord(meId);
    writeProjectContent();
    writeLocalProjectId(projectPath, {
      projectId: PROJECT_ID,
      name: PROJECT_NAME,
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByMachine: meId,
    });
  });

  afterEach(() => {
    home.restore();
    rmSync(root, { recursive: true, force: true });
  });

  // ---- phase 1: the assertion ---------------------------------------------

  it("writes a tombstone under this machine's own id and removes nothing", async () => {
    const before = hubFiles();
    const out = await hubRetire({ projectPath, hubPath: hubDir, reason: "moved to the new repo" });

    expect(out.success, JSON.stringify(out)).toBe(true);
    if (!out.success) return;
    expect(out.command).toBe("hub-retire");
    expect(out.retired).toBe(true);
    expect(out.wasRetired).toBe(false);
    expect(out.reason).toBe("moved to the new repo");
    // The grace window is stated up front, in the result that starts it.
    expect(Date.parse(out.deleteEligibleAt!) - Date.parse(out.retiredAt!)).toBe(RETIREMENT_GRACE_MS);

    // Per-machine ownership: the ONLY new file is this machine's own tombstone,
    // and nothing that was there is gone.
    expect(hubFiles()).toEqual([...before, `projects/${PROJECT_ID}/tombstones/${meId}.json`].sort());
    const tombstones = await readTombstones(createFsBackend(hubDir), PROJECT_ID);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].machineId).toBe(meId);
  });

  it("keeps the original retiredAt when the same machine retires twice", async () => {
    const first = await hubRetire({ projectPath, hubPath: hubDir });
    expect(first.success).toBe(true);
    if (!first.success) return;
    backdateTombstone(RETIREMENT_GRACE_MS / 2);
    const backdated = (readHubFile(tombstonePath(PROJECT_ID, meId)) as { retiredAt: string }).retiredAt;

    const second = await hubRetire({ projectPath, hubPath: hubDir, reason: "second thoughts" });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.wasRetired).toBe(true);
    // Re-asserting must not restart the clock the delete is waiting on —
    // otherwise `hub retire` run twice by a nervous user postpones the delete
    // it was meant to bring closer.
    expect(second.retiredAt).toBe(backdated);
    expect(second.reason).toBe("second thoughts");
  });

  it("refuses an unlinked directory, and --project-id names the project on the re-run", async () => {
    const bare = join(root, "unlinked");
    mkdirSync(bare, { recursive: true });

    const refused = await hubRetire({ projectPath: bare, hubPath: hubDir });
    expect(refused.success).toBe(false);
    if (refused.success) return;
    expect(refused.reason).toBe("unlinked");
    expect(existsSync(join(hubDir, tombstonePath(PROJECT_ID, meId)))).toBe(false);

    // The refusal is before every read and write, so the same invocation plus
    // the id runs from the top — which is the orphan case #43 is about: a hub
    // project no directory links to can only be named this way.
    const retried = await hubRetire({
      projectPath: bare, hubPath: hubDir, projectIdOverride: PROJECT_ID,
    });
    expect(retried.success, JSON.stringify(retried)).toBe(true);
    expect(existsSync(join(hubDir, tombstonePath(PROJECT_ID, meId)))).toBe(true);
  });

  it("refuses to retire a project this machine did not create", async () => {
    writeProjectRecord("some-other-machine");
    const before = hubFiles();

    const out = await hubRetire({ projectPath, hubPath: hubDir });

    expect(out.success).toBe(false);
    if (out.success) return;
    expect(out.reason).toBe("not-owner");
    if (out.reason !== "not-owner") return;
    expect(out.ownerMachineId).toBe("some-other-machine");
    // Nothing was written — a machine that may not retire a project may not
    // leave a trace on it either.
    expect(hubFiles()).toEqual(before);
  });

  it("withdraws this machine's own assertion with --undo", async () => {
    await hubRetire({ projectPath, hubPath: hubDir });
    const withTombstone = hubFiles();

    const out = await hubRetire({ projectPath, hubPath: hubDir, undo: true });

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.retired).toBe(false);
    expect(out.wasRetired).toBe(true);
    expect(existsSync(join(hubDir, tombstonePath(PROJECT_ID, meId)))).toBe(false);
    expect(withTombstone.length - hubFiles().length).toBe(1);
  });

  // ---- phase 2: the deletion ----------------------------------------------

  it("refuses to delete a project that was never retired", async () => {
    const before = hubFiles();
    const out = await hubDelete({ projectPath, hubPath: hubDir });

    expect(out.success).toBe(false);
    if (out.success) return;
    expect(out.reason).toBe("not-retired");
    expect(hubFiles()).toEqual(before);
  });

  it("refuses to delete inside the grace window", async () => {
    await hubRetire({ projectPath, hubPath: hubDir });
    const before = hubFiles();

    const out = await hubDelete({ projectPath, hubPath: hubDir });

    expect(out.success, JSON.stringify(out)).toBe(false);
    if (out.success) return;
    expect(out.reason).toBe("grace-period");
    if (out.reason !== "grace-period") return;
    // The window is the point: it is measured in DAYS, against how long a
    // synced hub takes to reach a machine that is switched off.
    expect(out.remainingSeconds).toBeGreaterThan((RETIREMENT_GRACE_MS - 60_000) / 1000);
    expect(out.remainingSeconds).toBeLessThanOrEqual(RETIREMENT_GRACE_MS / 1000);
    expect(hubFiles()).toEqual(before);
    // ...and the link is untouched, so the project is still fully usable.
    expect(existsSync(projectJsonFilePath(projectPath))).toBe(true);
  });

  it("refuses to delete while the tombstone's own timestamp is unreadable", async () => {
    await hubRetire({ projectPath, hubPath: hubDir });
    const rel = tombstonePath(PROJECT_ID, meId);
    writeHubFile(rel, { ...(readHubFile(rel) as object), retiredAt: "whenever" });
    const before = hubFiles();

    const out = await hubDelete({ projectPath, hubPath: hubDir });

    expect(out.success).toBe(false);
    if (out.success) return;
    // An unknown age is NOT an elapsed one: the only safe reading of a
    // timestamp nobody can parse is "keep refusing".
    expect(out.reason).toBe("grace-period");
    if (out.reason !== "grace-period") return;
    expect(out.remainingSeconds).toBeNull();
    expect(out.deleteEligibleAt).toBeNull();
    expect(hubFiles()).toEqual(before);
  });

  it("refuses to delete a project this machine did not create, even when a tombstone exists", async () => {
    // The foreign owner's own tombstone, aged well past the window: the ONLY
    // thing standing between this machine and someone else's data is the
    // ownership check.
    writeProjectRecord("some-other-machine");
    writeHubFile(tombstonePath(PROJECT_ID, "some-other-machine"), {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      machineId: "some-other-machine",
      retiredAt: new Date(Date.now() - RETIREMENT_GRACE_MS * 10).toISOString(),
      reason: null,
    });
    const before = hubFiles();

    const out = await hubDelete({ projectPath, hubPath: hubDir });

    expect(out.success).toBe(false);
    if (out.success) return;
    expect(out.reason).toBe("not-owner");
    expect(hubFiles()).toEqual(before);
  });

  it("deletes the project once its tombstone is older than the grace window", async () => {
    await hubRetire({ projectPath, hubPath: hubDir });
    backdateTombstone(RETIREMENT_GRACE_MS + 60_000);

    const out = await hubDelete({ projectPath, hubPath: hubDir });

    expect(out.success, JSON.stringify(out)).toBe(true);
    if (!out.success) return;
    expect(out.deletedFiles).toBeGreaterThan(0);
    expect(out.failed).toEqual([]);
    // Every FILE under the project is gone (empty directories may remain — the
    // backend removes files, never directories).
    expect(hubFiles().filter((f) => f.startsWith(`projects/${PROJECT_ID}/`))).toEqual([]);
    // ...and nothing outside it was touched.
    expect(hubFiles()).toContain(HUB_JSON);
    // The local link goes too: it is the session-end auto-push's consent gate,
    // and left behind it would re-create the project on the next session end.
    expect(out.localLinkRemoved).toBe(true);
    expect(existsSync(projectJsonFilePath(projectPath))).toBe(false);
  });

  it("does not offer a deleted project as a link candidate again", async () => {
    await hubRetire({ projectPath, hubPath: hubDir });
    backdateTombstone(RETIREMENT_GRACE_MS + 60_000);
    const backend = createFsBackend(hubDir);
    expect((await listHubProjects(backend)).map((p) => p.projectId)).toEqual([PROJECT_ID]);

    await hubDelete({ projectPath, hubPath: hubDir });

    expect(await listHubProjects(backend)).toEqual([]);
    // The pick list a pull offers is built from exactly that listing, so this is
    // the same fact seen from the surface the user meets it on.
    const fresh = join(root, "fresh");
    mkdirSync(fresh, { recursive: true });
    const pulled = await hubPull({
      configDir, projectPath: fresh, hubPath: hubDir, latest: true, claudeVersion: "2.1.81",
    });
    expect(pulled.success).toBe(false);
    if (pulled.success) return;
    expect("reason" in pulled && pulled.reason).toBe("unlinked");
    if (!("linkCandidates" in pulled)) return;
    expect(pulled.linkCandidates).toEqual([]);
  });

  it("removes project.json first and the tombstone last, so an interrupted run is re-runnable", () => {
    // The ordering is a pure function precisely so it can be asserted without
    // arranging a share to vanish mid-delete. What it protects: a run that dies
    // half way leaves a project that is no longer LINKABLE (project.json went
    // first) but is still gated and still authorized for a second attempt (the
    // tombstone is still there).
    const files = [
      `projects/${PROJECT_ID}/tombstones/${meId}.json`,
      `projects/${PROJECT_ID}/bundles/${meId}/2026-08-01T00-00-00.000Z-b1.tar.gz`,
      `projects/${PROJECT_ID}/project.json`,
      `projects/${PROJECT_ID}/index/${meId}.json`,
    ];

    const ordered = orderForDeletion(PROJECT_ID, files);

    expect(ordered[0]).toBe(`projects/${PROJECT_ID}/project.json`);
    expect(ordered[ordered.length - 1]).toBe(`projects/${PROJECT_ID}/tombstones/${meId}.json`);
    // Nothing dropped and nothing duplicated — this is a reordering, not a filter.
    expect([...ordered].sort()).toEqual([...files].sort());
  });

  // ---- the pull gate ------------------------------------------------------

  it("refuses a pull of a retired project before it links the directory", async () => {
    await hubRetire({ projectPath, hubPath: hubDir });
    const fresh = join(root, "fresh-link");
    mkdirSync(fresh, { recursive: true });

    const out = await hubPull({
      configDir, projectPath: fresh, hubPath: hubDir,
      projectIdOverride: PROJECT_ID, latest: true, claudeVersion: "2.1.81",
    });

    expect(out.success).toBe(false);
    if (out.success) return;
    expect("reason" in out && out.reason).toBe("project-retired");
    // THE REORDERING THIS PINS: `--project-id` used to link the directory
    // before anything else could refuse, which would have armed the session-end
    // auto-push for a project being retired.
    expect(existsSync(projectJsonFilePath(fresh))).toBe(false);
  });

  it("counts a tombstone from any machine as a reason to refuse a pull", async () => {
    // The gate deliberately does not verify that the asserting machine had the
    // authority to write one: refusing costs nothing, and the check that
    // matters guards the DELETE. Pinning it so the cheap read is not "fixed"
    // into an expensive one by accident.
    writeHubFile(tombstonePath(PROJECT_ID, "some-other-machine"), {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      machineId: "some-other-machine",
      retiredAt: new Date().toISOString(),
      reason: null,
    });

    const out = await hubPull({
      configDir, projectPath, hubPath: hubDir, latest: true, claudeVersion: "2.1.81",
    });

    expect(out.success).toBe(false);
    if (out.success) return;
    expect("reason" in out && out.reason).toBe("project-retired");
    if (!("retiredByThisMachine" in out)) return;
    expect(out.retiredByThisMachine).toBe(false);
    expect(out.retiredByMachineId).toBe("some-other-machine");
  });

  it("stops refusing once the assertion is withdrawn", async () => {
    await hubRetire({ projectPath, hubPath: hubDir });
    const refused = await hubPull({
      configDir, projectPath, hubPath: hubDir, latest: true, claudeVersion: "2.1.81",
    });
    expect("reason" in refused && refused.reason).toBe("project-retired");

    await hubRetire({ projectPath, hubPath: hubDir, undo: true });

    const after = await hubPull({
      configDir, projectPath, hubPath: hubDir, latest: true, claudeVersion: "2.1.81",
    });
    // Whatever this pull's outcome is, it is no longer the retirement: the hub
    // holds no threads for this project, which is a different answer entirely.
    expect("reason" in after && after.reason).not.toBe("project-retired");
  });
});

/**
 * The cross-machine half, on the real two-machine arrangement: A owns the
 * project (its push minted it) and B is a second machine linked to it.
 */
describe("hub retire — across two machines", () => {
  let arranged: ContinuationArrangement;

  beforeEach(async () => {
    arranged = await arrangeContinuation(undefined, {
      machineNames: { a: "sesh-machine-a", b: "sesh-machine-b" },
    });
  });

  afterEach(() => {
    arranged.cleanup();
  });

  it("refuses a pull of a retired project, and --ignore-retirement pulls it anyway", async () => {
    // HOME is machine A here (arrangeContinuation leaves it that way), and A
    // created the hub project, so A is the owner. B has pushed a continuation
    // that A has not yet pulled — real work, sitting on the hub.
    const retired = await hubRetire({
      projectPath: arranged.projectA, hubPath: arranged.hub, reason: "archiving atlas",
    });
    expect(retired.success, JSON.stringify(retired)).toBe(true);

    const refused = await hubPull({
      configDir: arranged.configDirA, projectPath: arranged.projectA, hubPath: arranged.hub,
      latest: true, claudeVersion: "2.1.81",
    });
    expect(refused.success).toBe(false);
    if (refused.success) return;
    expect("reason" in refused && refused.reason).toBe("project-retired");
    if (!("retiredByThisMachine" in refused)) return;
    expect(refused.retiredByThisMachine).toBe(true);
    expect(refused.retirementReason).toBe("archiving atlas");
    expect(refused.suggestion).toContain("--ignore-retirement");

    const forced = await hubPull({
      configDir: arranged.configDirA, projectPath: arranged.projectA, hubPath: arranged.hub,
      latest: true, ignoreRetirement: true, claudeVersion: "2.1.81",
    });

    // The refused pull applied and recorded NOTHING, which is what makes the
    // re-run reach the same continuation — the claim `hub-warning-flags`'
    // retry-works entry makes about this message.
    expect(forced.success, JSON.stringify(forced)).toBe(true);
    if (!forced.success || !("importedSessions" in forced)) return;
    // B's continuation is SPLICED onto A's existing transcript, so it lands in
    // `appended` rather than `importedSessions` — the point of the assertion is
    // that the re-run applied the very work the refusal withheld.
    const applied =
      forced.importedSessions.length +
      forced.skippedSessions.length +
      (forced.appended?.length ?? 0);
    expect(applied, JSON.stringify(forced)).toBeGreaterThan(0);
  });

  it("tells a machine that did not retire it who did, and what it can still do", async () => {
    await hubRetire({ projectPath: arranged.projectA, hubPath: arranged.hub });

    const asB = overrideHome(arranged.homeB);
    try {
      const out = await hubPull({
        configDir: arranged.configDirB, projectPath: arranged.projectB, hubPath: arranged.hub,
        latest: true, claudeVersion: "2.1.81",
      });

      expect(out.success).toBe(false);
      if (out.success) return;
      expect("reason" in out && out.reason).toBe("project-retired");
      if (!("retiredByMachineName" in out)) return;
      expect(out.retiredByThisMachine).toBe(false);
      // Who, by NAME — "another machine" is not an answer a user can act on.
      expect(out.retiredByMachineName).toBe("sesh-machine-a");
      // ...and the three things this user can still do, none of which is
      // "un-retire it": retraction is asymmetric.
      expect(out.suggestion).toContain("--ignore-retirement");
      expect(out.suggestion).toContain("hub unlink");
      expect(out.suggestion).toContain(out.deleteEligibleAt!.slice(0, 10));
    } finally {
      asB.restore();
    }
  });

  it("does not stop a push, and says so", async () => {
    // A deliberate scope line, pinned so it is a decision rather than a
    // discovery: the ruling gates PULL. A machine still linked to a retired
    // project keeps uploading to it — including through the unattended
    // session-end auto-push — so the retire result has to say that out loud.
    const retired = await hubRetire({ projectPath: arranged.projectA, hubPath: arranged.hub });
    expect(retired.success).toBe(true);
    if (!retired.success) return;
    expect(retired.warnings.join(" ")).toContain("Pushes are NOT blocked");

    const anchor = readLastEntryUuid(arranged.basePath)!;
    appendEntries(arranged.basePath, [
      {
        uuid: "a-after-retire-1", parentUuid: anchor, timestamp: "2026-08-17T09:00:00Z",
        sessionId: arranged.baseSessionId, cwd: arranged.projectA, version: "2.1.81", type: "user",
        message: { role: "user", content: "one more thing" },
      },
    ]);

    const pushed = await hubPush({
      configDir: arranged.configDirA, projectPath: arranged.projectA, hubPath: arranged.hub,
      noWorkspace: true, claudeVersion: "2.1.81",
    });

    expect(pushed.success, JSON.stringify(pushed)).toBe(true);
    if (!pushed.success || !("pushedSessions" in pushed)) return;
    expect(pushed.pushedSessions.length).toBeGreaterThan(0);
  });
});

/**
 * `backend.delete` had zero callers before #43 and is supposed to acquire
 * exactly one: retirement. The slice-4 design says so ("physical removal belongs
 * to retirement and compaction"), and prose does not enforce itself — this does.
 *
 * It is a source scan rather than a runtime check because the property is
 * "nothing else in the codebase reaches for this", which no runtime test can
 * observe. A new entry here is cheap and is meant to be: the point is that
 * adding a second deletion path requires editing this allowlist and saying why.
 */
describe("physical removal has exactly one home", () => {
  const ROOT = join(import.meta.dirname, "..");

  const ALLOWED: Record<string, string> = {
    "src/hub/backend.ts": "the HubBackend interface and its one filesystem implementation",
    "src/hub/retire.ts": "hub retire / hub delete — the only caller, funnelled through deleteHubFile",
    "src/hub/pull-select.ts": "Set.prototype.delete on a local Set, not a backend",
    "src/hub/index-file.ts": "delete of a poisoned thread key from a parsed index object",
    "src/hub/carry.ts": "delete of a scrubbed variable from a child process's env, not a file",
  };

  function srcFiles(dir: string, prefix = "src"): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) out.push(...srcFiles(join(dir, e.name), rel));
      else if (e.name.endsWith(".ts")) out.push(rel);
    }
    return out;
  }

  it("keeps every deletion call site in the allowlist", () => {
    const offenders: string[] = [];
    for (const file of srcFiles(join(ROOT, "src"))) {
      const lines = readFileSync(join(ROOT, file), "utf-8").split("\n");
      const hit = lines.some((raw) => {
        const t = raw.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
        return /\.delete\(/.test(t) || /\bdelete\s+\w+(?:\.\w+|\[)/.test(t);
      });
      if (hit && !(file in ALLOWED)) offenders.push(file);
    }
    expect(
      offenders,
      "A new deletion call site. If it deletes a HUB file, it almost certainly should not exist: " +
        "physical removal belongs to retirement (src/hub/retire.ts) and, later, to compaction. " +
        "If it is a Set/Map/property delete, add it to ALLOWED with that reason."
    ).toEqual([]);

    // ...and the allowlist may not rot: an entry naming a file that no longer
    // deletes anything is an entry nobody would notice going stale.
    const stale = Object.keys(ALLOWED).filter((f) => !existsSync(join(ROOT, f)));
    expect(stale).toEqual([]);
  });

  it("routes hub deletion through retire.ts's single funnel", () => {
    const src = readFileSync(join(ROOT, "src/hub/retire.ts"), "utf-8");
    const calls = src
      .split("\n")
      .filter((raw) => {
        const t = raw.trim();
        return !t.startsWith("//") && !t.startsWith("*") && /backend\.delete\(/.test(t);
      })
      .map((l) => l.trim());
    // Exactly one: inside `deleteHubFile`. Every other removal in the file goes
    // through that function.
    expect(calls).toHaveLength(1);
    expect(src).toContain("async function deleteHubFile(");
  });
});
