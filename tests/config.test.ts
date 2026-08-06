import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
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

    it("rejects prototype-polluting path segments", async () => {
      const { setConfigValue, getDefaultConfig } = await import("../src/config.js");
      const config = getDefaultConfig();
      expect(() => setConfigValue(config, "__proto__.polluted", "x")).toThrow(/invalid config path/i);
      expect(() => setConfigValue(config, "export.__proto__", "x")).toThrow(/invalid config path/i);
      expect(() => setConfigValue(config, "constructor.prototype.x", "x")).toThrow(/invalid config path/i);
    });

    it("defaults include the hub section so setConfigValue accepts hub.path", async () => {
      const { getDefaultConfig, setConfigValue } = await import("../src/config.js");
      const cfg = getDefaultConfig();
      expect(cfg.hub).toEqual({
        path: "", noWorkspace: false, autoPush: true, startupNotice: true,
        pullAppend: true, onDivergence: "fragment", carryDiff: true,
      });
      const updated = setConfigValue(cfg, "hub.path", "/mnt/share/hub");
      expect(updated.hub.path).toBe("/mnt/share/hub");
      // setConfigValue only accepts keys that already exist in the defaults,
      // so this is also the guard that hub.autoPush/hub.startupNotice/
      // hub.pullAppend/hub.onDivergence are settable at all. Before
      // hub.startupNotice was added here, `configure --set
      // hub.startupNotice=false` threw "Invalid config path" — the flag the
      // SessionStart hook gates on was documented but unsettable.
      expect(setConfigValue(cfg, "hub.autoPush", false).hub.autoPush).toBe(false);
      expect(setConfigValue(cfg, "hub.startupNotice", false).hub.startupNotice).toBe(false);
      expect(setConfigValue(cfg, "hub.pullAppend", false).hub.pullAppend).toBe(false);
      expect(setConfigValue(cfg, "hub.onDivergence", "adopt-hub").hub.onDivergence).toBe(
        "adopt-hub"
      );
      // hub.carryDiff is the only way to opt the SessionEnd auto-push out of
      // uploading uncommitted work: the hook takes no flags.
      expect(setConfigValue(cfg, "hub.carryDiff", false).hub.carryDiff).toBe(false);
    });
  });

  describe("computeEffectiveConfig", () => {
    it("preserves a user-scope-only value when the project directory has no config file", async () => {
      const { computeEffectiveConfig, readConfig, writeConfig, setConfigValue } = await import(
        "../src/config.js"
      );
      const userDir = join(tempDir, "user-scope");
      const projectDir = join(tempDir, "project-scope"); // never written to
      writeConfig(userDir, setConfigValue(readConfig(userDir), "hub.path", "/mnt/share/hub"));

      const effective = computeEffectiveConfig(userDir, projectDir);
      expect(effective.hub.path).toBe("/mnt/share/hub");
    });

    it("still lets an existing project config file override the user's value", async () => {
      const { computeEffectiveConfig, readConfig, writeConfig, setConfigValue } = await import(
        "../src/config.js"
      );
      const userDir = join(tempDir, "user-scope2");
      const projectDir = join(tempDir, "project-scope2");
      writeConfig(userDir, setConfigValue(readConfig(userDir), "export.storage", "user"));
      writeConfig(projectDir, setConfigValue(readConfig(projectDir), "export.storage", "project"));

      const effective = computeEffectiveConfig(userDir, projectDir);
      expect(effective.export.storage).toBe("project");
    });
  });

  // The WRITE side of the same defect computeEffectiveConfig exists for. A
  // scope-targeted write that serializes a whole defaults-backfilled config
  // turns every default into an explicit setting at that scope, and the project
  // layer then beats the user layer on keys the user only ever set once.
  describe("scope-targeted overrides", () => {
    it("setConfigOverride keeps the object sparse", async () => {
      const { setConfigOverride } = await import("../src/config.js");
      expect(setConfigOverride({}, "hub.autoPush", false)).toEqual({ hub: { autoPush: false } });
      // Second key in the same section, and an existing one is not disturbed.
      const two = setConfigOverride(
        setConfigOverride({}, "hub.autoPush", false),
        "export.storage",
        "project"
      );
      expect(two).toEqual({ hub: { autoPush: false }, export: { storage: "project" } });
      // Critically: no `hub.path` key at all. An empty-string path written here
      // is what unconfigured the hub for the project.
      expect(JSON.stringify(two)).not.toContain("path");
    });

    it("setConfigOverride validates against the defaults, like setConfigValue", async () => {
      const { setConfigOverride } = await import("../src/config.js");
      expect(() => setConfigOverride({}, "hub.notAKey", 1)).toThrow(/Invalid config path/);
      expect(() => setConfigOverride({}, "nope.thing", 1)).toThrow(/Invalid config path/);
      expect(() => setConfigOverride({}, "__proto__.polluted", 1)).toThrow(/Invalid config path/);
      // and the prototype was not touched by the attempt
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("a project-scope override leaves the user scope's OTHER keys effective", async () => {
      const { computeEffectiveConfig, readConfigOverrides, writeConfigOverrides, setConfigOverride } =
        await import("../src/config.js");
      const userDir = join(tempDir, "u3");
      const projectDir = join(tempDir, "p3");
      writeConfigOverrides(
        userDir,
        setConfigOverride(readConfigOverrides(userDir), "hub.path", "/mnt/share/hub")
      );
      // What `configure --set hub.autoPush=false --scope project` now writes.
      writeConfigOverrides(
        projectDir,
        setConfigOverride(readConfigOverrides(projectDir), "hub.autoPush", false)
      );

      const effective = computeEffectiveConfig(userDir, projectDir);
      expect(effective.hub.autoPush).toBe(false); // the project's own setting wins
      expect(effective.hub.path).toBe("/mnt/share/hub"); // and the hub is still configured
      expect(effective.export.storage).toBe("user"); // untouched keys fall through to defaults
    });

    it("the old defaults-backfilled write still produces the bad FILE — the read is what disarms it", async () => {
      // Originally a negative control asserting the broken effective config.
      // The read-side heal makes that assertion false by design, so what it
      // pins now is the split: the old write is still the cause (the file it
      // leaves really does carry `"path": ""`), and the fix is that reading no
      // longer honours that key. Both halves matter — the first is why the
      // write had to change, the second is why installs that already ran it
      // recover without the user doing anything.
      const { computeEffectiveConfig, readConfig, writeConfig, setConfigValue, readConfigOverrides } =
        await import("../src/config.js");
      const userDir = join(tempDir, "u4");
      const projectDir = join(tempDir, "p4");
      writeConfig(userDir, setConfigValue(readConfig(userDir), "hub.path", "/mnt/share/hub"));
      // Exactly what cli.ts used to do for --scope project.
      writeConfig(projectDir, setConfigValue(readConfig(projectDir), "hub.autoPush", false));

      // The file on disk is still the defaults-backfilled one, empty path and all.
      const onDisk = JSON.parse(
        readFileSync(join(projectDir, "config.json"), "utf-8")
      ) as { hub: { path: string } };
      expect(onDisk.hub.path).toBe("");
      // But nothing downstream sees it any more.
      expect(readConfigOverrides(projectDir).hub?.path).toBeUndefined();
      expect(computeEffectiveConfig(userDir, projectDir).hub.path).toBe("/mnt/share/hub");
    });

    it("heals a legacy backfilled project file already on disk, without discarding it", async () => {
      const { computeEffectiveConfig, readConfig, writeConfig, setConfigValue, readConfigOverrides } =
        await import("../src/config.js");
      const userDir = join(tempDir, "u5");
      const projectDir = join(tempDir, "p5");
      writeConfig(userDir, setConfigValue(readConfig(userDir), "hub.path", "/mnt/share/hub"));
      // The file a 0.5.x `configure --set --scope project` left behind: fully
      // defaults-backfilled, `"path": ""` and all. Writing sparsely fixes new
      // files; these are the ones users already have, and `configure --reset`
      // would take every other project setting with it.
      writeConfig(
        projectDir,
        setConfigValue(setConfigValue(readConfig(projectDir), "hub.autoPush", false), "export.format", "zstd")
      );

      const effective = computeEffectiveConfig(userDir, projectDir);
      expect(effective.hub.path).toBe("/mnt/share/hub"); // the empty string no longer shadows it
      expect(effective.hub.autoPush).toBe(false); // and the project's real settings survive
      expect(effective.export.format).toBe("zstd");
      // Only the empty hub.path is dropped — a deliberately-set path stays.
      writeConfig(projectDir, setConfigValue(readConfig(projectDir), "hub.path", "/other/hub"));
      expect(readConfigOverrides(projectDir).hub?.path).toBe("/other/hub");
      expect(computeEffectiveConfig(userDir, projectDir).hub.path).toBe("/other/hub");
    });
  });
});
