import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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
      const cfg = JSON.parse(readFileSync(join(home, ".claude-sesh-mover", "config.json"), "utf-8"));
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
      const s = await hubStatus({ configDir: join(home, ".claude"), cwd: home });
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
      const s = await hubStatus({ configDir: join(home, ".claude"), cwd: home });
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
});
