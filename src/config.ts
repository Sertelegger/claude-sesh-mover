import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SeshMoverConfig } from "./types.js";

export function getDefaultConfig(): SeshMoverConfig {
  return {
    export: {
      storage: "user",
      format: "dir",
      exclude: [],
      scope: "current",
      noSummary: false,
    },
    import: {
      dryRunFirst: true,
    },
    migrate: {
      scope: "current",
    },
    hub: {
      path: "",
      noWorkspace: false,
    },
  };
}

export function readConfig(configDir: string): SeshMoverConfig {
  const configPath = join(configDir, "config.json");
  const defaults = getDefaultConfig();

  if (!existsSync(configPath)) {
    return defaults;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const partial = JSON.parse(raw);
    return deepMerge(defaults as unknown as Record<string, unknown>, partial) as unknown as SeshMoverConfig;
  } catch {
    return defaults;
  }
}

// Raw partial config from a directory's file, WITHOUT defaults backfilled —
// {} when the file is missing or unreadable. Used by computeEffectiveConfig
// so an absent layer contributes nothing, instead of a full defaults-filled
// object that would clobber a customization set only at another layer (see
// commit adding hub.path: readConfig() alone can't tell "user left this at
// the default" apart from "user explicitly set this to the default").
function readConfigOverrides(configDir: string): Partial<SeshMoverConfig> {
  const configPath = join(configDir, "config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as Partial<SeshMoverConfig>;
  } catch {
    return {};
  }
}

// Resolve the effective config across the user/project two-tier hierarchy by
// layering raw file overrides directly onto defaults (defaults -> user file
// -> project file), rather than merging two independently defaults-backfilled
// SeshMoverConfig objects. The latter is what mergeConfigs(readConfig(a),
// readConfig(b)) does, and it is only safe when both directories actually
// have a config.json (each already a complete, self-consistent snapshot per
// configure's writeConfig) — if a directory has no file at all, readConfig
// backfills a full default object indistinguishable from "explicitly set to
// default", so merging it in would silently overwrite the other layer's
// customizations. This is the deterministic core's "give me the config that
// actually applies right now" entry point; every command that needs to read
// (not write) an effective, cross-scope config should go through here.
export function computeEffectiveConfig(
  userConfigDir: string,
  projectConfigDir: string
): SeshMoverConfig {
  const defaults = getDefaultConfig() as unknown as Record<string, unknown>;
  const withUser = deepMerge(
    defaults,
    readConfigOverrides(userConfigDir) as Record<string, unknown>
  );
  const withProject = deepMerge(
    withUser,
    readConfigOverrides(projectConfigDir) as Record<string, unknown>
  );
  return withProject as unknown as SeshMoverConfig;
}

export function writeConfig(
  configDir: string,
  config: SeshMoverConfig
): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function mergeConfigs(
  userConfig: SeshMoverConfig,
  projectConfig: SeshMoverConfig,
  cliOverrides?: Partial<Record<string, unknown>>
): SeshMoverConfig {
  let merged = deepMerge(userConfig as unknown as Record<string, unknown>, projectConfig as unknown as Record<string, unknown>) as unknown as SeshMoverConfig;
  if (cliOverrides) {
    merged = deepMerge(merged as unknown as Record<string, unknown>, cliOverrides) as unknown as SeshMoverConfig;
  }
  return merged;
}

export function setConfigValue(
  config: SeshMoverConfig,
  dotPath: string,
  value: unknown
): SeshMoverConfig {
  const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
  const parts = dotPath.split(".");
  if (parts.some((p) => FORBIDDEN_SEGMENTS.has(p))) {
    throw new Error(`Invalid config path: ${dotPath}`);
  }
  const result = structuredClone(config);

  let current: Record<string, unknown> = result as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
      throw new Error(`Invalid config path: ${dotPath}`);
    }
    current = current[parts[i]] as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1];
  if (!(lastKey in current)) {
    throw new Error(`Invalid config path: ${dotPath}`);
  }

  current[lastKey] = value;
  return result;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
