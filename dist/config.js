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
// Raw partial config from a directory's file, WITHOUT defaults backfilled —
// {} when the file is missing or unreadable. Used by computeEffectiveConfig
// so an absent layer contributes nothing, instead of a full defaults-filled
// object that would clobber a customization set only at another layer (see
// commit adding hub.path: readConfig() alone can't tell "user left this at
// the default" apart from "user explicitly set this to the default").
function readConfigOverrides(configDir) {
    const configPath = join(configDir, "config.json");
    if (!existsSync(configPath))
        return {};
    try {
        return JSON.parse(readFileSync(configPath, "utf-8"));
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
export function mergeConfigs(userConfig, projectConfig, cliOverrides) {
    let merged = deepMerge(userConfig, projectConfig);
    if (cliOverrides) {
        merged = deepMerge(merged, cliOverrides);
    }
    return merged;
}
export function setConfigValue(config, dotPath, value) {
    const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
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