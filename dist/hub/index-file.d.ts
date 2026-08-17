import type { HubBackend } from "./backend.js";
import { type HubBundleRecord, type HubIndexJson, type HubThreadEntry } from "./layout.js";
import type { SyncState } from "../types.js";
/**
 * What this projection reads out of a prior index: every `HubThreadEntry` field
 * EXCEPT `summary`.
 *
 * The omission is the enforcement, not documentation of one. `summary` is
 * derived from `slug` inside `buildIndexFile` and nowhere else, so a caller that
 * wants to hand one in — `hub reindex`'s synthetic prior did, straight out of a
 * bundle manifest, which is where the message excerpt lived — has no field to
 * hand it in through.
 *
 * A real `HubIndexJson` read off the hub satisfies this structurally, so
 * `readMachineIndex`'s return value is passed unchanged.
 */
export type PriorThreadEntry = Omit<HubThreadEntry, "summary">;
/**
 * The prior index as a projection INPUT.
 *
 * Only `threads` is read, which is also why `hub reindex` can hand over a
 * synthetic one without inventing an index envelope (`machineId`, `updatedAt`,
 * …) that the rebuild would then have to keep consistent with the real thing.
 */
export interface PriorIndexView {
    threads: Record<string, PriorThreadEntry>;
}
export interface IndexBuildInputs {
    projectId: string;
    machineId: string;
    projectPath: string;
    /**
     * The project's live local sessions.
     *
     * NO `summary` FIELD, deliberately — see the block above `buildIndexFile`.
     * Every caller used to pass `summary: s.slug` here, three copies of one
     * decision, and the fourth writer (through `priorIndex`) passed something
     * else entirely.
     */
    sessions: Array<{
        sessionId: string;
        slug: string;
        headEntryUuid: string;
        messageCount: number;
        lastActiveAt: string;
    }>;
    state: SyncState;
    priorIndex: PriorIndexView | null;
    newBundles: Array<{
        threadId: string;
        record: HubBundleRecord;
    }>;
    now: string;
}
export declare function buildIndexFile(inputs: IndexBuildInputs): HubIndexJson;
/**
 * Read one machine's index file.
 *
 * `null` means the file is absent or structurally unusable (missing, not JSON,
 * wrong schemaVersion, no threads map, or an identity that disagrees with its
 * own filename — see below). Everything finer-grained DEGRADES: a record whose
 * ids or `file` path are unsafe is dropped and reported through `warnings`, and
 * the rest of the index survives.
 *
 * That degradation is the point. `file` was never validated at all, so a single
 * poisoned record reached `backend.exists(record.file)` in hub/pull.ts and threw
 * `assertHubRelPath`'s raw internal message straight out of `hubPull` — one bad
 * record killed the pull and took every other bundle in the index with it. And
 * the ids that WERE checked did not degrade either: `assertSafeHubId` threw
 * inside the try, the catch returned null, and the whole index was discarded as
 * "unreadable". Both are the same mistake — the blast radius of a poisoned
 * record must be that record.
 *
 * THE FILENAME IS THE IDENTITY; A DISAGREEING `machineId` FIELD IS DAMAGE
 * (#28). Two things encode which machine wrote an index — the path
 * `index/<machineId>.json` and the `machineId` INSIDE it — and they could
 * disagree. The filename wins: it is what this machine controls, what
 * `indexPath` builds, what `readAllIndexes` dedupes on, and the only one of the
 * two that has passed `assertSafeHubId` (via `indexPath`) by the time the file
 * is read. Per-machine ownership is what makes that a rule rather than a
 * preference — `index/<id>.json` is BY CONSTRUCTION the file machine `<id>`
 * owns and the only one it ever writes, so a content field naming someone else
 * is a copied, hand-edited or corrupt file, never a legitimate state.
 *
 * SKIP-AND-WARN, not fatal, and not a repair. Not fatal because a sync client's
 * conflict copy must not turn into a failed pull, and because it is the same
 * degradation this reader already applies to hostile input — the difference is
 * that here the poisoned unit is the whole FILE, since its identity is what is
 * in question. Not a repair (overwriting the field from the filename) because
 * this machine does not own that file, and a silent rewrite in memory would
 * publish an id no writer stands behind. Fatal-on-mismatch is the right answer
 * once a second person's machine can write to this hub; that is not today.
 *
 * WHAT IT BUYS DOWNSTREAM: `HubIndexJson.machineId`, and therefore
 * `ThreadCopy.machineId` in threads.ts, is filename-reconciled for every index
 * that reached a consumer through this function — which is every one of them in
 * production (`readAllIndexes` is the only door). Two copies of one thread can
 * no longer carry the same `machineId` from two different files, and an
 * internal `machineId` can no longer be a path-unsafe string. Both of those had
 * accommodations built for them; see the notes in threads.ts, which say why
 * they stay.
 *
 * `warnings` is optional so the existing callers (pull.ts, push.ts, reindex.ts)
 * that only want the index need no change; readAllIndexes passes its own array.
 */
export declare function readMachineIndex(backend: HubBackend, projectId: string, machineId: string, warnings?: string[]): Promise<HubIndexJson | null>;
export declare function writeMachineIndex(backend: HubBackend, index: HubIndexJson): Promise<void>;
export declare function readAllIndexes(backend: HubBackend, projectId: string): Promise<{
    indexes: HubIndexJson[];
    warnings: string[];
}>;
//# sourceMappingURL=index-file.d.ts.map