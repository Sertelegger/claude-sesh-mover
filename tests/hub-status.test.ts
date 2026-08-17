import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { hubInit } from "../src/hub/init.js";
import { hubStatus } from "../src/hub/status.js";
import { hubPush } from "../src/hub/push.js";
import { readSyncState, setLastAutoPush, writeSyncState } from "../src/sync-state.js";
import { loadOrCreateMachineId } from "../src/machine.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Point this machine's user-scope config at `hubPath` without creating it. */
function configureHubPath(home: string, hubPath: string): void {
  const dir = join(home, ".sesh-mover");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ hub: { path: hubPath } }, null, 2));
}

/**
 * `machinesKnown` counts machines, not files (#28).
 *
 * It used to be `(await backend.list("machines")).length`, and `backend.list`
 * walks RECURSIVELY and filters only a `.tmp-` marker in a basename. The hub is
 * documented as a shared or synced directory, so foreign entries beside the
 * machine records are the EXPECTED case rather than an exotic one — which made
 * a displayed count claim more machines had joined the hub than ever had, with
 * nothing to tell the reader otherwise.
 *
 * `readAllIndexes` already solved the identical problem for `index/` (immediate
 * `.json` children, deduped); this asserts `machines/` now answers it the same
 * way. Both directions are covered: litter must not inflate the count, and a
 * genuine second machine must still raise it.
 */
describe("hub status: machinesKnown", () => {
  it("ignores sync litter and nested version history in machines/", async () => {
    const home = tmp("sesh-status-home-");
    const hub = tmp("sesh-status-hub-");
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const machine = loadOrCreateMachineId();

      const machinesDir = join(hub, "machines");
      // Exactly the shapes index-file.ts names for `index/`, plus the two the
      // `.tmp-` filter deliberately does not catch.
      writeFileSync(join(machinesDir, ".DS_Store"), "\0\0");
      writeFileSync(join(machinesDir, "Thumbs.db"), "x");
      writeFileSync(join(machinesDir, "~syncthing~aaaa.tmp"), "{}");
      writeFileSync(join(machinesDir, "README"), "put machine records here\n");
      // Syncthing parks superseded copies of the SAME record here. The old
      // recursive count added one per retained version.
      const stversions = join(machinesDir, ".stversions");
      mkdirSync(stversions, { recursive: true });
      for (const n of ["20260101", "20260102", "20260103"]) {
        writeFileSync(join(stversions, `${machine.id}~${n}.json`), "{}");
      }
      // A Dropbox conflict directory holding a copy of the same record.
      const conflict = join(machinesDir, "desktop's conflicted copy 2026-08-03");
      mkdirSync(conflict, { recursive: true });
      writeFileSync(join(conflict, `${machine.id}.json`), "{}");

      const s = await hubStatus({ cwd: home });
      expect(s.reachable).toBe(true);
      expect(s.machineRegistered).toBe(true);
      // One machine has joined this hub. Eight files live under machines/.
      expect(s.machinesKnown).toBe(1);
    } finally {
      restore.restore();
      for (const d of [home, hub]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("still counts a genuine second machine record", async () => {
    const home = tmp("sesh-status-home2-");
    const hub = tmp("sesh-status-hub2-");
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      writeFileSync(
        join(hub, "machines", "3f2b1c44-0000-4000-8000-abcdefabcdef.json"),
        JSON.stringify({ machineId: "3f2b1c44-0000-4000-8000-abcdefabcdef", name: "other" })
      );
      const s = await hubStatus({ cwd: home });
      expect(s.machinesKnown).toBe(2);
    } finally {
      restore.restore();
      for (const d of [home, hub]) rmSync(d, { recursive: true, force: true });
    }
  });
});

/**
 * `hub status` REPORTS an unreachable hub; it does not refuse on one.
 *
 * The gate #75 added (`src/hub/preflight.ts`) turns an unreachable `hub.path`
 * into a typed `hub-unreachable` refusal for push, pull and — since this change
 * — `hub reindex`. Extending that to `hub status` would have been backwards:
 * the user runs this command *to find out* whether the hub is reachable, and a
 * `success: false` whose only content is "the hub is unreachable" would take
 * `hubPath`, `machineRegistered`, `project.linked` and `lastAutoPush` down with
 * it — every one of them still knowable, and three of them the answers a user
 * needs precisely then.
 *
 * So what status takes from the gate is the CLASSIFICATION, not the refusal.
 * That half is not cosmetic: `reachable` used to mean "hub.json exists", which
 * disagreed with the gate about the file a sync client mid-copy actually leaves
 * behind.
 */
describe("hub status: an unreachable hub is reported, not refused", () => {
  it("answers no-directory for a path this machine cannot see, and builds nothing there", async () => {
    const home = tmp("sesh-status-gone-home-");
    const restore = overrideHome(home);
    try {
      const gone = join(home, "not-mounted");
      configureHubPath(home, gone);

      const s = await hubStatus({ cwd: home });

      // The whole point: a normal result, not a refusal.
      expect(s.success).toBe(true);
      expect(s.command).toBe("hub-status");
      expect(s.reachable).toBe(false);
      expect(s.hubState).toBe("no-directory");
      // ...and the fields that are still knowable are still answered.
      expect(s.hubPath).toBe(gone);
      expect(s.hubId).toBeNull();
      expect(s.machineRegistered).toBe(false);
      expect(s.machinesKnown).toBe(0);
      expect(s.warnings.join(" ")).toContain("cannot see");
      // `hub status` is documented read-only, and this is the path where that
      // is easiest to lose: everything else in this module writes through a
      // backend whose writeAtomic mkdir -p's its way to its target.
      expect(existsSync(gone)).toBe(false);
    } finally {
      restore.restore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("answers not-a-hub for a directory carrying no hub.json, and leaves it alone", async () => {
    const home = tmp("sesh-status-nothub-home-");
    const notAHub = tmp("sesh-status-nothub-dir-");
    const restore = overrideHome(home);
    try {
      writeFileSync(join(notAHub, "notes.txt"), "not a hub\n");
      configureHubPath(home, notAHub);

      const s = await hubStatus({ cwd: home });

      expect(s.success).toBe(true);
      expect(s.reachable).toBe(false);
      // Distinct from the case above, because the remedies differ: mount the
      // share versus point hub.path somewhere else / wait for a first sync.
      expect(s.hubState).toBe("not-a-hub");
      expect(s.hubPath).toBe(notAHub);
      expect(s.warnings.join(" ")).toContain("no usable hub.json");
      // The old wording sent the user to `hub init` for BOTH states. Following
      // it at an unmounted mount point mints a competing hub there.
      expect(s.warnings.join(" ")).not.toContain("hub init");
    } finally {
      restore.restore();
      for (const d of [home, notAHub]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * THE ONE THAT WAS WRONG BEFORE, and the reason status shares the gate's
   * probe rather than keeping its own rule.
   *
   * `reachable` was `await backend.exists(HUB_JSON)` — file present, question
   * answered. A `hub.json` that parses but carries no `hubId` therefore came
   * back `reachable: true` with `hubId: undefined` (a field typed
   * `string | null`, and one `JSON.stringify` drops entirely), while `hubPush`
   * refused the very same directory as `not-a-hub`. That is not a hypothetical
   * file: it is what a sync client mid-copy leaves behind, which is exactly when
   * a user runs `hub status`.
   *
   * Asserted against a real `hubPush` in the same fixture rather than against a
   * remembered constant — the claim is that the two verbs agree, so both have to
   * be in the test.
   */
  it("agrees with push about a hub.json that carries no hubId", async () => {
    const home = tmp("sesh-status-nohubid-home-");
    const hub = tmp("sesh-status-nohubid-hub-");
    const project = tmp("sesh-status-nohubid-proj-");
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      // Parses, is one of ours by shape, names no hub.
      writeFileSync(join(hub, "hub.json"), JSON.stringify({ schemaVersion: 1 }, null, 2));

      const s = await hubStatus({ cwd: home });
      expect(s.reachable).toBe(false);
      expect(s.hubState).toBe("not-a-hub");
      // Never `undefined`: the field is declared `string | null`, and an absent
      // key is what a caller reads as "this build does not report it".
      expect(s.hubId).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(s, "hubId")).toBe(true);

      const pushed = await hubPush({
        configDir: home, projectPath: project, hubPath: hub, claudeVersion: "2.1.81",
      });
      expect(pushed.success).toBe(false);
      expect("reason" in pushed && pushed.reason).toBe("hub-unreachable");
      expect("hubState" in pushed && pushed.hubState).toBe(s.hubState);
    } finally {
      restore.restore();
      for (const d of [home, hub, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * No hub configured is a FOURTH state, and `null` rather than `no-directory`
   * is the whole of it: a user who has simply never run `hub init` must not be
   * told to check whether a network share is mounted.
   */
  it("reports hubState null — not no-directory — when no hub is configured", async () => {
    const home = tmp("sesh-status-unconfigured-home-");
    const restore = overrideHome(home);
    try {
      const s = await hubStatus({ cwd: home });

      expect(s.success).toBe(true);
      expect(s.hubPath).toBeNull();
      expect(s.reachable).toBe(false);
      expect(s.hubState).toBeNull();
      // Nothing to diagnose, so nothing is diagnosed.
      expect(s.warnings).toEqual([]);
    } finally {
      restore.restore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * The executable form of the argument for not refusing.
   *
   * `lastAutoPush` is the ONLY surviving trace of a SessionEnd push (its stdout
   * is closed and a clean exit hides its stderr), and an unreachable hub is the
   * commonest reason one fails. A `hub status` that declined on an unreachable
   * hub would withhold the record of the failure that unreachable hub caused —
   * from the one command that reports it.
   */
  it("still reports lastAutoPush when the hub cannot be reached", async () => {
    const home = tmp("sesh-status-breadcrumb-home-");
    const project = tmp("sesh-status-breadcrumb-proj-");
    const restore = overrideHome(home);
    try {
      const gone = join(home, "not-mounted");
      configureHubPath(home, gone);
      const state = readSyncState(project);
      // `setLastAutoPush` is a no-op without a hub block, exactly as it is in
      // production: the auto-push mints a thread id before it gets there.
      state.hub = { hubId: "hub-1", threadByLocalSession: {} };
      setLastAutoPush(state, {
        at: "2026-08-16T10:00:00.000Z",
        ok: false,
        notes: ["The push was refused (hub-unreachable: no-directory)."],
      });
      writeSyncState(state);

      const s = await hubStatus({ cwd: project });

      expect(s.success).toBe(true);
      expect(s.reachable).toBe(false);
      expect(s.lastAutoPush?.ok).toBe(false);
      expect(s.lastAutoPush?.notes[0]).toContain("hub-unreachable");
      // ...and surfaced as a warning too, which is the field's whole purpose.
      expect(s.warnings.join(" ")).toContain("last automatic push");
    } finally {
      restore.restore();
      for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
    }
  });
});
