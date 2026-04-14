import type { SeshMoverConfig } from "./types.js";
export declare function getDefaultConfig(): SeshMoverConfig;
export declare function readConfig(configDir: string): SeshMoverConfig;
export declare function writeConfig(configDir: string, config: SeshMoverConfig): void;
export declare function mergeConfigs(userConfig: SeshMoverConfig, projectConfig: SeshMoverConfig, cliOverrides?: Partial<Record<string, unknown>>): SeshMoverConfig;
export declare function setConfigValue(config: SeshMoverConfig, dotPath: string, value: unknown): SeshMoverConfig;
//# sourceMappingURL=config.d.ts.map