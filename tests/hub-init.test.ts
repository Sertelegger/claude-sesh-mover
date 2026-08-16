import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { hubInit } from "../src/hub/init.js";
import { hubStatus } from "../src/hub/status.js";
import { loadOrCreateMachineId } from "../src/machine.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("hub init/status", () => {
  it("creates the layout, registers the machine, writes config", async () => {
    const home = tmp("sesh-hub-home-");
    const hub = tmp("sesh-hub-dir-");
    const restore = overrideHome(home);
    try {
      const result = await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.created).toBe(true);
      const hubJson = JSON.parse(readFileSync(join(hub, "hub.json"), "utf-8"));
      expect(hubJson.schemaVersion).toBe(1);
      const machine = loadOrCreateMachineId();
      expect(existsSync(join(hub, "machines", `${machine.id}.json`))).toBe(true);
      const cfg = JSON.parse(readFileSync(join(home, ".sesh-mover", "config.json"), "utf-8"));
      expect(cfg.hub.path).toBe(hub);
    } finally {
      restore.restore();
      rmSync(home, { recursive: true, force: true });
      rmSync(hub, { recursive: true, force: true });
    }
  });

  it("joining an existing hub keeps its hubId (created=false)", async () => {
    const homeA = tmp("sesh-hub-homeA-");
    const homeB = tmp("sesh-hub-homeB-");
    const hub = tmp("sesh-hub-dir-");
    let restore = overrideHome(homeA);
    try {
      const a = await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      restore.restore();
      restore = overrideHome(homeB);
      const b = await hubInit({ hubPath: hub, configScope: "user", cwd: homeB });
      expect(a.success && b.success).toBe(true);
      if (!(a.success && b.success)) return;
      expect(b.created).toBe(false);
      expect(b.hubId).toBe(a.hubId);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("status reports unconfigured hub without error", async () => {
    const home = tmp("sesh-hub-home-");
    const restore = overrideHome(home);
    try {
      const s = await hubStatus({ cwd: home });
      expect(s.success).toBe(true);
      expect(s.hubPath).toBeNull();
      expect(s.reachable).toBe(false);
    } finally {
      restore.restore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("status reports reachable hub + machine registration + unlinked project", async () => {
    const home = tmp("sesh-hub-home-");
    const hub = tmp("sesh-hub-dir-");
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      const s = await hubStatus({ cwd: home });
      expect(s.reachable).toBe(true);
      expect(s.machineRegistered).toBe(true);
      expect(s.machinesKnown).toBe(1);
      expect(s.project.linked).toBe(false);
    } finally {
      restore.restore();
      rmSync(home, { recursive: true, force: true });
      rmSync(hub, { recursive: true, force: true });
    }
  });

  /**
   * The executable half of init.ts's "Point --path at an empty directory or a
   * valid sesh-mover hub." — the foreclosure question, answered by running it.
   *
   * The refusal a bad `--path` can actually produce is a directory that already
   * holds a `hub.json` this build cannot read (a merely non-empty directory
   * with no `hub.json` is ADOPTED, not refused — hub init writes the file and
   * leaves the neighbours alone). That branch returns before `registerMachine`
   * and before the config write, so nothing is recorded anywhere; `--path` is
   * the invocation's own argument, and the same call at a good path runs from
   * the top. Both halves are asserted: the refusal wrote nothing, and the
   * re-run created a hub.
   */
  it("refuses a directory it cannot use as a hub, and a re-run at a good --path succeeds", async () => {
    const home = tmp("sesh-hub-home-");
    const badHub = tmp("sesh-hub-bad-");
    const goodHub = tmp("sesh-hub-dir-");
    const restore = overrideHome(home);
    try {
      writeFileSync(join(badHub, "hub.json"), "{ this is not json", "utf-8");

      const refused = await hubInit({ hubPath: badHub, configScope: "user", cwd: home });
      expect(refused.success).toBe(false);
      if (refused.success) return;
      expect(refused.error).toMatch(/hub\.json is not readable/i);
      expect(refused.suggestion).toContain("--path");
      // Nothing was written by the refusal: this machine was not registered on
      // the bad hub, and hub.path was not pinned in the user config. That is
      // what makes the re-run below a genuine retry rather than a repair.
      expect(existsSync(join(badHub, "machines"))).toBe(false);
      expect(existsSync(join(home, ".sesh-mover", "config.json"))).toBe(false);

      // The same invocation, with the flag the suggestion named pointed
      // somewhere usable.
      const ok = await hubInit({ hubPath: goodHub, configScope: "user", cwd: home });
      expect(ok.success).toBe(true);
      if (!ok.success) return;
      expect(ok.created).toBe(true);
      expect(existsSync(join(goodHub, "hub.json"))).toBe(true);
      const cfg = JSON.parse(readFileSync(join(home, ".sesh-mover", "config.json"), "utf-8"));
      expect(cfg.hub.path).toBe(goodHub);
    } finally {
      restore.restore();
      for (const d of [home, badHub, goodHub]) rmSync(d, { recursive: true, force: true });
    }
  });
});
