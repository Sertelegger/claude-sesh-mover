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
  const parts = dotPath.split(".");
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
