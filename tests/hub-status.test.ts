import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { hubInit } from "../src/hub/init.js";
import { hubStatus } from "../src/hub/status.js";
import { loadOrCreateMachineId } from "../src/machine.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
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
