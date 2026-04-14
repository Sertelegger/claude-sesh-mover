"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultConfig = getDefaultConfig;
exports.readConfig = readConfig;
exports.writeConfig = writeConfig;
exports.mergeConfigs = mergeConfigs;
exports.setConfigValue = setConfigValue;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
function getDefaultConfig() {
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
function readConfig(configDir) {
    const configPath = (0, node_path_1.join)(configDir, "config.json");
    const defaults = getDefaultConfig();
    if (!(0, node_fs_1.existsSync)(configPath)) {
        return defaults;
    }
    try {
        const raw = (0, node_fs_1.readFileSync)(configPath, "utf-8");
        const partial = JSON.parse(raw);
        return deepMerge(defaults, partial);
    }
    catch {
        return defaults;
    }
}
function writeConfig(configDir, config) {
    if (!(0, node_fs_1.existsSync)(configDir)) {
        (0, node_fs_1.mkdirSync)(configDir, { recursive: true });
    }
    const configPath = (0, node_path_1.join)(configDir, "config.json");
    (0, node_fs_1.writeFileSync)(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
function mergeConfigs(userConfig, projectConfig, cliOverrides) {
    let merged = deepMerge(userConfig, projectConfig);
    if (cliOverrides) {
        merged = deepMerge(merged, cliOverrides);
    }
    return merged;
}
function setConfigValue(config, dotPath, value) {
    const parts = dotPath.split(".");
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