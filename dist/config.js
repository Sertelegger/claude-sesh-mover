import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
export function getDefaultConfig() {
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
        },
    };
}
export function readConfig(configDir) {
    const configPath = join(configDir, "config.json");
    const defaults = getDefaultConfig();
    if (!existsSync(configPath)) {
        return defaults;
    }
    try {
        const raw = readFileSync(configPath, "utf-8");
        const partial = JSON.parse(raw);
        return deepMerge(defaults, partial);
    }
    catch {
        return defaults;
    }
}
export function readConfigOverrides(configDir) {
    const configPath = join(configDir, "config.json");
    if (!existsSync(configPath))
        return {};
    try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
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
    }
    catch {
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
export function computeEffectiveConfig(userConfigDir, projectConfigDir) {
    const defaults = getDefaultConfig();
    const withUser = deepMerge(defaults, readConfigOverrides(userConfigDir));
    const withProject = deepMerge(withUser, readConfigOverrides(projectConfigDir));
    return withProject;
}
export function writeConfig(configDir, config) {
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
export function writeConfigOverrides(configDir, overrides) {
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
function assertKnownConfigPath(dotPath) {
    const parts = dotPath.split(".");
    if (parts.some((p) => FORBIDDEN_SEGMENTS.has(p))) {
        throw new Error(`Invalid config path: ${dotPath}`);
    }
    let current = getDefaultConfig();
    for (let i = 0; i < parts.length - 1; i++) {
        const next = current[parts[i]];
        if (!(parts[i] in current) || typeof next !== "object" || next === null || Array.isArray(next)) {
            throw new Error(`Invalid config path: ${dotPath}`);
        }
        current = next;
    }
    if (!(parts[parts.length - 1] in current)) {
        throw new Error(`Invalid config path: ${dotPath}`);
    }
    return parts;
}
/**
 * Set one key in a scope's OVERRIDES, creating only the containers on the way
 * to it. Same validation and same error text as `setConfigValue` (the path has
 * to exist in the defaults), but the result stays sparse: `{"hub":{"autoPush":
 * false}}`, never a snapshot of every default.
 */
export function setConfigOverride(overrides, dotPath, value) {
    const parts = assertKnownConfigPath(dotPath);
    const result = structuredClone(overrides);
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
        const next = current[parts[i]];
        if (!next || typeof next !== "object" || Array.isArray(next)) {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
    return result;
}
export function mergeConfigs(userConfig, projectConfig, cliOverrides) {
    let merged = deepMerge(userConfig, projectConfig);
    if (cliOverrides) {
        merged = deepMerge(merged, cliOverrides);
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
export function setConfigValue(config, dotPath, value) {
    const parts = dotPath.split(".");
    if (parts.some((p) => FORBIDDEN_SEGMENTS.has(p))) {
        throw new Error(`Invalid config path: ${dotPath}`);
    }
    const result = structuredClone(config);
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
            throw new Error(`Invalid config path: ${dotPath}`);
        }
        current = current[parts[i]];
    }
    const lastKey = parts[parts.length - 1];
    if (!(lastKey in current)) {
        throw new Error(`Invalid config path: ${dotPath}`);
    }
    current[lastKey] = value;
    return result;
}
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] &&
            typeof source[key] === "object" &&
            !Array.isArray(source[key]) &&
            target[key] &&
            typeof target[key] === "object" &&
            !Array.isArray(target[key])) {
            result[key] = deepMerge(target[key], source[key]);
        }
        else {
            result[key] = source[key];
        }
    }
    return result;
}
//# sourceMappingURL=config.js.map