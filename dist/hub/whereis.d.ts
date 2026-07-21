import { type HubBackend } from "./backend.js";
import { type ResolvedThread } from "./threads.js";
import type { WhereisResult, WhereisThread } from "../types.js";
export declare function shapeThreads(backend: HubBackend, resolved: ResolvedThread[], meId: string): Promise<WhereisThread[]>;
export declare function hubWhereis(opts: {
    configDir: string;
    projectPath: string;
    hubPath: string;
}): Promise<WhereisResult>;
//# sourceMappingURL=whereis.d.ts.map