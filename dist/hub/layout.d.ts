export interface HubJson {
    schemaVersion: 1;
    hubId: string;
    createdAt: string;
}
export interface HubMachineJson {
    id: string;
    name: string;
    platform: string;
    lastSeenAt: string;
}
export interface HubProjectJson {
    schemaVersion: 1;
    projectId: string;
    name: string;
    matchers: {
        gitRemotes: string[];
    };
    createdAt: string;
    createdByMachine: string;
}
export interface HubBundleRecord {
    bundleId: string;
    file: string;
    type: "full" | "continuation";
    sessionIdInBundle: string;
    /**
     * First entry this bundle's delta SHIPS (`null` on a full bundle) — one past
     * the head it was diffed against. NOT a link: it is the anchor's child and
     * equals no bundle's `headEntryUuid`, ever. Keep it for the continuation
     * header's sake and link on `anchorEntryUuid` instead.
     */
    fromEntryUuid: string | null;
    headEntryUuid: string;
    /**
     * The predecessor's head — the bundle this one chains onto. Three-valued, and
     * the three values are three different facts:
     *
     * - **absent** (`undefined`, i.e. no such key in the JSON): written before
     *   chain assembly existed. The anchor is UNKNOWN and unrecoverable from the
     *   index; such a record is unlinkable by construction and a chain through it
     *   must be reported as "pushed before chain assembly", never as a missing
     *   bundle. A pre-assembly bundle whose MANIFEST is still on the hub can be
     *   recovered by `hub reindex` only if that manifest carries the field.
     * - **`null`**: a full/root bundle. No anchor exists, by definition.
     * - **a string**: the `headEntryUuid` of this bundle's predecessor. `""` is
     *   never a link — `threads.ts` states the rule for `findUnfetchableBundles`
     *   and it transfers verbatim ("two empty strings are not a match"). No
     *   current writer emits `""` here (an empty recorded head is a full push,
     *   `src/diff.ts`), but a hostile or damaged index can, so the walk rejects it
     *   rather than trusting the writer.
     */
    anchorEntryUuid?: string | null;
    messageCount: number;
    pushedAt: string;
    hasWorkspace: boolean;
}
export interface HubThreadEntry {
    localSessionId: string;
    slug: string;
    summary: string;
    headEntryUuid: string;
    messageCount: number;
    lastActiveAt: string;
    bundles: HubBundleRecord[];
}
export interface HubIndexJson {
    schemaVersion: 1;
    agent: "claude-code";
    projectId: string;
    machineId: string;
    updatedAt: string;
    projectPath: string;
    threads: Record<string, HubThreadEntry>;
}
/**
 * One machine's assertion that a hub project is retired — a tombstone (#43).
 *
 * **A FILE OF ITS OWN, NOT A FIELD ON `HubIndexJson`**, and the reason is the
 * index's own invariant rather than tidiness: an index file is *derivable* — it
 * is a projection of this machine's bundles plus its local sync-state, and `hub
 * reindex` exists to rebuild one from exactly those two inputs. A retirement is
 * an ASSERTION; nothing on the hub or on this machine can re-derive it. Put it
 * in the index and every writer of that index (a push through `buildIndexFile`,
 * a `hub reindex`) becomes a writer that can silently drop it. Beside the index,
 * owned per machine on the same rule, it cannot be.
 *
 * Per-machine ownership holds unchanged: `tombstones/<machineId>.json` is by
 * construction the file machine `<machineId>` owns, so asserting retirement
 * writes nobody else's file — which is what lets two machines assert (or
 * retract) concurrently with no distributed lock, exactly as with indexes.
 *
 * `retiredAt` is the ASSERTING machine's wall clock. That is safe for the one
 * comparison this codebase makes against it (the delete grace window) because
 * only the asserting machine may delete, so the comparison is that machine's
 * clock against its own earlier reading — unlike `HubBundleRecord.pushedAt`,
 * which is cross-machine and is a diagnostic only.
 */
export interface HubTombstoneJson {
    schemaVersion: 1;
    projectId: string;
    machineId: string;
    /** ISO 8601, the asserting machine's clock. */
    retiredAt: string;
    /** Free text from `hub retire --reason`, or null. Never interpreted. */
    reason: string | null;
}
export declare function assertSafeHubId(id: unknown, what: string): asserts id is string;
export declare function assertHubRelPath(relPath: string): void;
export declare const HUB_JSON = "hub.json";
export declare function machinePath(machineId: string): string;
export declare function projectDir(projectId: string): string;
export declare function projectJsonPath(projectId: string): string;
export declare function indexDirPath(projectId: string): string;
export declare function indexPath(projectId: string, machineId: string): string;
export declare function tombstoneDirPath(projectId: string): string;
export declare function tombstonePath(projectId: string, machineId: string): string;
export declare function bundleDir(projectId: string, machineId: string): string;
export declare function bundleFileName(pushedAtIso: string, bundleId: string): string;
//# sourceMappingURL=layout.d.ts.map