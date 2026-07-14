import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";

describe("machine", () => {
  let tempHome: string;
  let homeOverride: HomeOverrideHandle;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-machine-test-"));
    homeOverride = overrideHome(tempHome);
  });

  afterEach(() => {
    homeOverride.restore();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("creates a new machine identity on first call", async () => {
    const { loadOrCreateMachineId } = await import("../src/machine.js");
    const id = loadOrCreateMachineId();
    expect(id.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id.name.length).toBeGreaterThan(0);
    expect(id.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(join(tempHome, ".claude-sesh-mover", "machine-id.json"))).toBe(true);
  });

  it("returns the same identity on second call", async () => {
    const { loadOrCreateMachineId } = await import("../src/machine.js");
    const first = loadOrCreateMachineId();
    const second = loadOrCreateMachineId();
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("readMachineId returns null when absent", async () => {
    const { readMachineId } = await import("../src/machine.js");
    expect(readMachineId()).toBeNull();
  });

  it("setMachineName updates the name without changing the id", async () => {
    const { loadOrCreateMachineId, setMachineName } = await import("../src/machine.js");
    const first = loadOrCreateMachineId();
    const renamed = setMachineName("my-laptop");
    expect(renamed.name).toBe("my-laptop");
    expect(renamed.id).toBe(first.id);
    const raw = JSON.parse(
      readFileSync(join(tempHome, ".claude-sesh-mover", "machine-id.json"), "utf-8")
    );
    expect(raw.name).toBe("my-laptop");
  });
});
