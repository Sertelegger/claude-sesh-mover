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