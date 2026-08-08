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
      autoPush: true,
      // Must be present here, not just in the type: setConfigValue only
      // accepts dot-paths that already exist in the defaults, so an absent key
      // makes `configure --set hub.startupNotice=false` fail outright.
      startupNotice: true,
      pullAppend: true,
      onDivergence: "fragment",
      carryDiff: true,
      carryMaxMb: DEFAULT_CARRY_MAX_MB,
      workspaceMaxMb: DEFAULT_WORKSPACE_MAX_MB,
    },
  };
}

/**
 * Default byte budget for a git-diff carry, in MB.
 *
 * It was 5 MB, on the reasoning that a carry is a *diff* where 5 MB already
 * means generated artifacts. That reasoning was wrong about how people actually
 * work: measured on this repository, its own `.superpowers/` working notes are
 * ~12.6 MB of untracked, non-gitignored files — content the owner deliberately
 * wants carried — so the carry declined on the very repository that produced
 * the tool. A hub is a directory with a disk behind it; the budget exists to
 * stop a runaway payload, not to ration ordinary work.
 */
export const DEFAULT_CARRY_MAX_MB = 50;

/** Default byte budget for a whole-project workspace snapshot, in MB. */
export const DEFAULT_WORKSPACE_MAX_MB = 50;

/**
 * Hard ceiling on either budget, in MB.
 *
 * Not a policy number — a memory one, and the only reason there is a ceiling at
 * all. Both payloads are handled whole in memory: `captureCarry` buffers the
 * `git diff` output through `spawnSync`'s `maxBuffer`, and `applyCarry` reads
 * the entire patch back to run the floor and symlink guards over it. Past a
 * gigabyte that stops being a decline and becomes an allocation failure, which
 * is the one outcome neither budget is allowed to have.
 */
export const MAX_BUDGET_MB = 1024;

export interface BudgetResolution {
  /** The budget in BYTES. `0` means "carry nothing" — see `resolveBudgetMb`. */
  bytes: number;
  /** Set only when the configured value was not usable as written. */
  warning: string | null;
}

/**
 * Turn a configured `hub.*MaxMb` value into a byte budget, failing CLOSED.
 *
 * Both budgets decline a whole payload rather than truncating one, and that
 * property has to survive a value a user typed by hand into a JSON file. So:
 *
 * - **`0` means carry nothing.** It is an explicit off switch, not "unlimited"
 *   — the reading that would turn a typo into an unbounded upload on an
 *   unattended session-end push. The payload builders return their ordinary
 *   "declined" result for it, with a detail that names the setting.
 * - **Negative, `NaN`, `Infinity`, or not a number at all** (a JSON string, an
 *   object) is not a size. The default applies and a warning says so, because
 *   silently substituting the default is indistinguishable from the setting
 *   working — and the direction of the mistake is unknowable.
 * - **Above `MAX_BUDGET_MB`** is clamped, with a warning. See that constant:
 *   the ceiling is about buffering the payload in memory, not about policy.
 *
 * Fractions are allowed and rounded down to whole bytes (`0.5` is 512 KB); a
 * value that rounds to zero bytes is reported like an explicit `0`, since that
 * is what it is.
 */
export function resolveBudgetMb(
  raw: unknown,
  key: string,
  defaultMb: number
): BudgetResolution {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return {
      bytes: defaultMb * 1024 * 1024,
      warning:
        `${key} is ${JSON.stringify(raw)}, which is not a size in megabytes — sesh-mover used the ${defaultMb} MB default instead. Set it to a non-negative number (0 means carry nothing).`,
    };
  }
  if (raw > MAX_BUDGET_MB) {
    return {
      bytes: MAX_BUDGET_MB * 1024 * 1024,
      warning:
        `${key} is ${raw} MB, over the ${MAX_BUDGET_MB} MB ceiling — sesh-mover used ${MAX_BUDGET_MB} MB. The payload is held in memory whole, both to capture it and to check it on the machine that receives it, so a larger budget would fail with an allocation error instead of a decline.`,
    };
  }
  return { bytes: Math.floor(raw * 1024 * 1024), warning: null };
}

/** Both hub payload budgets, resolved once, with everything they had to say. */
export interface HubBudgets {
  carryMaxBytes: number;
  workspaceMaxBytes: number;
  warnings: string[];
}

/**
 * Resolve both budgets from an effective config.
 *
 * One function rather than two `resolveBudgetMb` calls at each call site: the
 * SessionEnd auto-push and the manual `hub push` both need them, they take no
 * flags in the automatic case, and a second copy of the wiring is how one of
 * the two ends up reading a key the other does not.
 */
export function resolveHubBudgets(config: SeshMoverConfig): HubBudgets {
  const carry = resolveBudgetMb(config.hub.carryMaxMb, "hub.carryMaxMb", DEFAULT_CARRY_MAX_MB);
  const workspace = resolveBudgetMb(
    config.hub.workspaceMaxMb, "hub.workspaceMaxMb", DEFAULT_WORKSPACE_MAX_MB
  );
  return {
    carryMaxBytes: carry.bytes,
    workspaceMaxBytes: workspace.bytes,
    warnings: [carry.warning, workspace.warning].filter((w): w is string => w !== null),
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
/**
 * A sparse override file: every section optional, and every key WITHIN a
 * section optional too. `Partial<SeshMoverConfig>` only makes the sections
 * optional, which understated what these files hold the moment writes became
 * sparse — a project file may legitimately be `{"hub":{"autoPush":false}}`.
 */
export type ConfigOverrides = {
  [K in keyof SeshMoverConfig]?: Partial<SeshMoverConfig[K]>;
};

export function readConfigOverrides(configDir: string): ConfigOverrides {
  const configPath = join(configDir, "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as ConfigOverrides;
    // An empty `hub.path` is the ABSENCE of a setting, not a setting — which is
    // exactly how resolveHubPath already treats it. Dropping it here is what
    // heals installs written before the sparse write landed: every 0.5.x
    // `configure --set --scope project` persisted a fully defaults-backfilled
    // object including `"path": ""`, and that empty string then shadowed a
    // perfectly good user-scope hub path, leaving `hub status` reporting no hub
    // for that one project. Writing sparsely fixes new files; this fixes the
    // ones already on disk, on first read, without discarding the other
    // settings a `configure --reset` would take with it.
    if (raw.hub && raw.hub.path === "") {
      const { path: _dropped, ...rest } = raw.hub;
      raw.hub = rest;
    }
    return raw;
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

/**
 * Persist ONE SCOPE'S OVERRIDES — the keys that scope actually sets, nothing
 * else. This is the write-side counterpart of `computeEffectiveConfig`, and it
 * exists for the same reason.
 *
 * `writeConfig` serializes a complete, defaults-backfilled `SeshMoverConfig`.
 * That is materially wrong for a scope-targeted write: a file holding every
 * default is indistinguishable from a file whose author meant every one of
 * those values, so the project layer then wins on keys the user only ever set
 * at the user layer. The measured shape: `hub init --scope user` sets
 * `hub.path`, then `configure --set hub.autoPush=false --scope project` writes
 * `"path": ""` into the project file, and the project's hub is silently
 * unconfigured (`hub status` -> hubPath null, `push` -> "No hub configured").
 *
 * Anything that writes a config file for a SPECIFIC scope must go through
 * here. `writeConfig` remains for callers that genuinely hold a whole
 * effective config (published library surface).
 */
export function writeConfigOverrides(
  configDir: string,
  overrides: ConfigOverrides
): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify(overrides, null, 2) + "\n", "utf-8");
}

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validate a `--set` dot-path against the DEFAULTS and return its segments.
 *
 * The defaults are the schema: a key absent from `getDefaultConfig()` is not a
 * config key, and accepting one would write a setting nothing ever reads.
 * (That is also why every new key has to be added to the defaults — see the
 * note on `hub.startupNotice` there.)
 */
function assertKnownConfigPath(dotPath: string): string[] {
  const parts = dotPath.split(".");
  if (parts.some((p) => FORBIDDEN_SEGMENTS.has(p))) {
    throw new Error(`Invalid config path: ${dotPath}`);
  }
  let current: Record<string, unknown> = getDefaultConfig() as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = current[parts[i]];
    if (!(parts[i] in current) || typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new Error(`Invalid config path: ${dotPath}`);
    }
    current = next as Record<string, unknown>;
  }
  if (!(parts[parts.length - 1] in current)) {
    throw new Error(`Invalid config path: ${dotPath}`);
  }
  return parts;
}

/**
 * What TYPE the defaults declare for a `--set` dot-path, or `null` if the path
 * is not a config key at all.
 *
 * `configure --set` parses `true`/`false` and a leading `[` as JSON and leaves
 * everything else a string, which was fine while every key was a string, a
 * boolean or a list. It is not fine for a NUMBER: `hub.carryMaxMb=100` would
 * persist `"100"`, and a string is not a size — the budget would silently fall
 * back to its default on every push afterwards, with a warning about a value
 * the user typed correctly. The defaults are already the schema (see
 * `assertKnownConfigPath`), so they can say which keys are numeric too.
 */
export function configValueKind(dotPath: string): string | null {
  const parts = dotPath.split(".");
  if (parts.some((p) => FORBIDDEN_SEGMENTS.has(p))) return null;
  let current: unknown = getDefaultConfig();
  for (const part of parts) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
    if (!(part in (current as Record<string, unknown>))) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return Array.isArray(current) ? "array" : typeof current;
}

/**
 * Set one key in a scope's OVERRIDES, creating only the containers on the way
 * to it. Same validation and same error text as `setConfigValue` (the path has
 * to exist in the defaults), but the result stays sparse: `{"hub":{"autoPush":
 * false}}`, never a snapshot of every default.
 */
export function setConfigOverride(
  overrides: ConfigOverrides,
  dotPath: string,
  value: unknown
): Partial<SeshMoverConfig> {
  const parts = assertKnownConfigPath(dotPath);
  const result = structuredClone(overrides) as unknown as Record<string, unknown>;
  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = current[parts[i]];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return result as unknown as Partial<SeshMoverConfig>;
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

/**
 * Set one key in a WHOLE config object (defaults backfilled). Note what this
 * does NOT do: it does not know which scope the result is destined for, so
 * writing its output with `writeConfig` persists every default alongside the
 * one changed key. For a scope-targeted write use
 * `setConfigOverride` + `writeConfigOverrides`.
 */
export function setConfigValue(
  config: SeshMoverConfig,
  dotPath: string,
  value: unknown
): SeshMoverConfig {
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
