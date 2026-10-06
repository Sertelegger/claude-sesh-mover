import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The two arms of `projectDirectoryState` that no real filesystem reaches.
 *
 * The directory `stat` runs only after `<project>/.sesh-mover/config.json`
 * answered ENOENT — and on a real filesystem, a mount that hangs or refuses the
 * `stat` would have hung or refused that read first, which a sibling arm
 * already covers (tests/hub-joined-evidence-bound.test.ts). So the stat's own
 * "timed out" and "failed some other way" answers are reachable only when the
 * two syscalls disagree, which is exactly the moment a share goes away between
 * them. This file STUBS `stat` for one path to produce that disagreement.
 *
 * It is a mock, flagged as one: it proves the arm's decision (an answer that
 * is not "a directory that answered" leaves the tie undetermined, so the union
 * decides), not that any filesystem produces it. Every other arm is tested
 * against real files.
 */

const stubbed = vi.hoisted(() => ({ path: null as string | null, mode: "real" as "real" | "hang" | "eacces" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    stat: (p: Parameters<typeof real.stat>[0], ...rest: unknown[]) => {
      if (stubbed.path !== null && String(p) === stubbed.path) {
        if (stubbed.mode === "hang") return new Promise(() => {});
        if (stubbed.mode === "eacces") {
          return Promise.reject(Object.assign(new Error(`EACCES: permission denied, stat '${String(p)}'`), { code: "EACCES" }));
        }
      }
      return (real.stat as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

const { overrideHome } = await import("./helpers/env.js");
const { encodeProjectPath } = await import("../src/platform.js");
const { checkJoinedHubIdentity, joinedHubsFilePath } = await import("../src/hub/joined-hubs.js");
const { setConfigOverride, writeConfigOverrides } = await import("../src/config.js");
const { hubInit } = await import("../src/hub/init.js");

const NOW = "2026-09-30T00:00:00.000Z";

function writeSyncState(home: string, projectPath: string, hubId: string): void {
  const dir = join(home, ".sesh-mover", "sync-state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${encodeProjectPath(projectPath)}.json`),
    JSON.stringify({ projectPath, schemaVersion: 2, peers: {}, lineage: {}, imported: {}, hub: { hubId, threadByLocalSession: {} } })
  );
}

describe("the project-directory stat's own unsettled answers force the union (stubbed stat)", () => {
  let home: string;
  let restore: { restore(): void };
  let savedBound: string | undefined;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "sm-evidence-stat-")));
    restore = overrideHome(home);
    savedBound = process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS;
    process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS = "300";
  });
  afterEach(() => {
    stubbed.path = null;
    stubbed.mode = "real";
    if (savedBound === undefined) delete process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS;
    else process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS = savedBound;
    restore.restore();
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * projA ties `hub` to id-a through its own config. projH recorded id-h and
   * has no config file, so its config read answers ENOENT and the directory
   * stat decides. With the stat settled as "a directory", projH inherits the
   * (absent) user-scope hub.path, the tie is complete, and id-a SEEDS — which
   * is what a loosened arm produces.
   */
  function arrange(): { hub: string; fresh: string; projH: string } {
    const hub = join(home, "hub");
    const projA = join(home, "projA");
    const projH = join(home, "projH");
    writeConfigOverrides(join(projA, ".sesh-mover"), setConfigOverride({}, "hub.path", hub));
    writeSyncState(home, projA, "id-a");
    mkdirSync(projH, { recursive: true });
    writeSyncState(home, projH, "id-h");
    return { hub, fresh: join(home, "fresh-hub"), projH };
  }

  it("control — the stat answers for real: projH is settled, and id-a seeds", async () => {
    const { hub } = arrange();
    const seed = await checkJoinedHubIdentity({ hubPath: hub, hubId: "id-a", seed: true, nowIso: NOW });
    expect(seed).toMatchObject({ kind: "match" });
  });

  for (const [mode, cause] of [["hang", "timed-out"], ["eacces", "unreadable"]] as const) {
    it(`a stat that ${mode === "hang" ? "times out" : "fails with EACCES"} leaves the tie undetermined: the seed refuses on the union`, async () => {
      const { hub, projH } = arrange();
      stubbed.path = projH;
      stubbed.mode = mode;
      const seed = await checkJoinedHubIdentity({ hubPath: hub, hubId: "id-a", seed: true, nowIso: NOW });
      expect(seed).toMatchObject({
        kind: "changed",
        change: { currentHubId: "id-a", expectedHubIds: ["id-a", "id-h"], basis: "evidence", evidenceSource: "undetermined" },
      });
      expect(existsSync(joinedHubsFilePath())).toBe(false);
    }, 15_000);

    it(`a stat that ${mode === "hang" ? "times out" : "fails with EACCES"}: hub init refuses at a fresh path and names the project (${cause})`, async () => {
      const { fresh, projH } = arrange();
      stubbed.path = projH;
      stubbed.mode = mode;
      const init = await hubInit({ hubPath: fresh, configScope: "user", cwd: home });
      expect(init).toMatchObject({ success: false, reason: "hub-identity-not-present", basis: "evidence" });
      expect(init).toMatchObject({ unresolvedProjects: [{ projectPath: projH, cause }] });
      expect(existsSync(fresh)).toBe(false);
    }, 15_000);
  }
});
