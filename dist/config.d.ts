import type { SeshMoverConfig } from "./types.js";
export declare function getDefaultConfig(): SeshMoverConfig;
export declare function readConfig(configDir: string): SeshMoverConfig;
/**
 * A sparse override file: every section optional, and every key WITHIN a
 * section optional too. `Partial<SeshMoverConfig>` only makes the sections
 * optional, which understated what these files hold the moment writes became
 * sparse — a project file may legitimately be `{"hub":{"autoPush":false}}`.
 */
export type ConfigOverrides = {
    [K in keyof SeshMoverConfig]?: Partial<SeshMoverConfig[K]>;
};
export declare function readConfigOverrides(configDir: string): ConfigOverrides;
export declare function computeEffectiveConfig(userConfigDir: string, projectConfigDir: string): SeshMoverConfig;
export declare function writeConfig(configDir: string, config: SeshMoverConfig): void;
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
export declare function writeConfigOverrides(configDir: string, overrides: ConfigOverrides): void;
/**
 * Set one key in a scope's OVERRIDES, creating only the containers on the way
 * to it. Same validation and same error text as `setConfigValue` (the path has
 * to exist in the defaults), but the result stays sparse: `{"hub":{"autoPush":
 * false}}`, never a snapshot of every default.
 */
export declare function setConfigOverride(overrides: ConfigOverrides, dotPath: string, value: unknown): Partial<SeshMoverConfig>;
export declare function mergeConfigs(userConfig: SeshMoverConfig, projectConfig: SeshMoverConfig, cliOverrides?: Partial<Record<string, unknown>>): SeshMoverConfig;
/**
 * Set one key in a WHOLE config object (defaults backfilled). Note what this
 * does NOT do: it does not know which scope the result is destined for, so
 * writing its output with `writeConfig` persists every default alongside the
 * one changed key. For a scope-targeted write use
 * `setConfigOverride` + `writeConfigOverrides`.
 */
export declare function setConfigValue(config: SeshMoverConfig, dotPath: string, value: unknown): SeshMoverConfig;
//# sourceMappingURL=config.d.ts.map