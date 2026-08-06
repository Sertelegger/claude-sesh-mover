import { type HubBackend } from "./backend.js";
import { type ResolvedThread } from "./threads.js";
import type { SyncState, WhereisResult, WhereisThread } from "../types.js";
/**
 * Memoized `machines/<id>.json` name lookup, `null` for anything unreadable.
 *
 * SECURITY (Task 6 review, binding): the machineId field INSIDE a parsed index
 * file is never validated by readMachineIndex — only ids used in ITS OWN path
 * building (derived from the filename) are. A hostile index file can therefore
 * declare an internal machineId that is unsafe as a path component (e.g.
 * "../evil"). resolveThreads copies that internal field verbatim into
 * ThreadCopy.machineId, so this helper — which calls machinePath(id) — must be
 * the one to contain the resulting throw (machinePath asserts and throws on
 * unsafe ids), not let it escape and wedge the whole command. Every caller
 * that turns a hub-supplied machine id into a display name goes through here.
 */
export declare function createMachineNameLookup(backend: HubBackend): (id: string) => Promise<string | null>;
export declare function shapeThreads(backend: HubBackend, resolved: ResolvedThread[], meId: string, state: SyncState): Promise<WhereisThread[]>;
export declare function hubWhereis(opts: {
    configDir: string;
    projectPath: string;
    hubPath: string;
}): Promise<WhereisResult>;
//# sourceMappingURL=whereis.d.ts.map