import { type HubMachineJson } from "./layout.js";
import type { ErrorResult, HubInitResult, SeshMoverConfig } from "../types.js";
export declare function resolveHubPath(config: SeshMoverConfig): string | null;
export declare function registerMachine(hubPath: string): Promise<HubMachineJson>;
export declare function hubInit(opts: {
    hubPath: string;
    configScope: "user" | "project";
    cwd: string;
}): Promise<HubInitResult | ErrorResult>;
//# sourceMappingURL=init.d.ts.map