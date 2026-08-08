import type { SeshMoverConfig } from "./types.js";
export declare function getDefaultConfig(): SeshMoverConfig;
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
export declare const DEFAULT_CARRY_MAX_MB = 50;
/** Default byte budget for a whole-project workspace snapshot, in MB. */
export declare const DEFAULT_WORKSPACE_MAX_MB = 50;
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
export declare const MAX_BUDGET_MB = 1024;
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
export declare function resolveBudgetMb(raw: unknown, key: string, defaultMb: number): BudgetResolution;
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
export declare function resolveHubBudgets(config: SeshMoverConfig): HubBudgets;
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
export declare function configValueKind(dotPath: string): string | null;
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