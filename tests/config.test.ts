import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-config-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getDefaultConfig", () => {
    it("returns complete default config", async () => {
      const { getDefaultConfig } = await import("../src/config.js");
      const config = getDefaultConfig();
      expect(config.export.storage).toBe("user");
      expect(config.export.format).toBe("dir");
      expect(config.export.exclude).toEqual([]);
      expect(config.export.scope).toBe("current");
      expect(config.export.noSummary).toBe(false);
      expect(config.import.dryRunFirst).toBe(true);
      expect(config.migrate.scope).toBe("current");
    });
  });

  describe("readConfig", () => {
    it("returns default when no config file exists", async () => {
      const { readConfig, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const config = readConfig(join(tempDir, "nonexistent"));
      expect(config).toEqual(getDefaultConfig());
    });

    it("reads and merges partial config file", async () => {
      const { readConfig } = await import("../src/config.js");
      const configDir = join(tempDir, ".claude-sesh-mover");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ export: { storage: "project" } })
      );
      const config = readConfig(configDir);
      expect(config.export.storage).toBe("project");
      expect(config.export.format).toBe("dir"); // default preserved
    });
  });

  describe("writeConfig", () => {
    it("writes config to file", async () => {
      const { writeConfig, readConfig, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const configDir = join(tempDir, ".claude-sesh-mover");
      mkdirSync(configDir, { recursive: true });
      const config = getDefaultConfig();
      config.export.storage = "project";
      writeConfig(configDir, config);
      const readBack = readConfig(configDir);
      expect(readBack.export.storage).toBe("project");
    });
  });

  describe("mergeConfigs", () => {
    it("project config overrides user config", async () => {
      const { mergeConfigs, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const userConfig = getDefaultConfig();
      userConfig.export.storage = "user";
      const projectConfig = getDefaultConfig();
      projectConfig.export.storage = "project";
      const merged = mergeConfigs(userConfig, projectConfig);
      expect(merged.export.storage).toBe("project");
    });

    it("CLI flags override everything", async () => {
      const { mergeConfigs, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const userConfig = getDefaultConfig();
      const projectConfig = getDefaultConfig();
      const cliOverrides = { export: { format: "zstd" as const } };
      const merged = mergeConfigs(userConfig, projectConfig, cliOverrides);
      expect(merged.export.format).toBe("zstd");
    });
  });

  describe("setConfigValue", () => {
    it("sets a nested config value by dot-path", async () => {
      const { setConfigValue, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const config = getDefaultConfig();
      const updated = setConfigValue(config, "export.storage", "project");
      expect(updated.export.storage).toBe("project");
    });

    it("throws on invalid path", async () => {
      const { setConfigValue, getDefaultConfig } = await import(
        "../src/config.js"
      );
      const config = getDefaultConfig();
      expect(() => setConfigValue(config, "nonexistent.key", "value")).toThrow();
    });
  });
});
