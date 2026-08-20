export interface HubJson {
    schemaVersion: 1;
    hubId: string;
    createdAt: string;
    /**
     * The plugin version that last wrote HUB-LEVEL state — in practice, the
     * version that created this hub, since `hub.json` is written once by `hub
     * init` and never rewritten by push or pull.
     *
     * **It is a notice mechanism, not an enforcement one, and the distinction is
     * the whole of what it buys.** A plugin predating this field never reads it,
     * so it cannot be a gate against one: push and pull read `hubId` out of
     * `hub.json` and check nothing else, `schemaVersion` included. What it does
     * buy is the other direction — a NEWER plugin meeting a hub stamped by a
     * version above its own can say so instead of silently mis-reading fields it
     * does not know about.
     *
     * The question "is any machine on this hub still running a version that will
     * push plaintext" is answered by `HubMachineJson.pluginVersion`, not by this:
     * that one is refreshed on every push and pull, per machine, while this one is
     * a fact about the hub's creation. They are two different facts and the second
     * is the useful one.
     *
     * **Not refreshed on join.** `hub.json` is the one hub file no single machine
     * owns, and per-machine ownership is what makes concurrent push/pull safe
     * without a distributed lock. Opportunistically rewriting a shared file to
     * advertise a version would trade that for nothing.
     *
     * Optional: every hub written before this field exists, and stays valid.
     */
    pluginVersion?: string;
    /**
     * **The authoritative switch for encryption at rest.** Absent or `false`:
     * bundles are pushed as plaintext archives. `true`: they must be encrypted.
     *
     * It lives here rather than only in local config because a local-only flag has
     * a silent failure — one machine that never set it keeps pushing plaintext
     * into a hub the user believes is sealed. `hub.encrypt` in config is the local
     * *preference*; this field is what a push obeys. `resolveHubEncryption` in
     * `encryption.ts` is the single place that reads the pair, including why a
     * malformed value here resolves toward encryption rather than away from it.
     *
     * Enabling it does not make an existing hub private — it makes it private
     * going forward. The reader branches on the bundle's file SUFFIX, never on
     * this field, so a mixed hub stays readable and flipping the switch never
     * strands your own history.
     */
    encrypt?: boolean;
}
export interface HubMachineJson {
    id: string;
    name: string;
    platform: string;
    lastSeenAt: string;
    /**
     * The plugin version this machine last checked in with, refreshed by
     * `registerMachine` on every push and pull.
     *
     * This is the roster entry that makes "will any machine on this hub push
     * plaintext into it" answerable at all. It is still only a diagnosis: it lets
     * a new plugin NAME a stale machine, and it cannot stop one, because the stale
     * machine is not reading anything we write here.
     *
     * Optional: records written before this field exist on real hubs.
     */
    pluginVersion?: string;
    /**
     * This machine's age recipient (`age1…`) — the PUBLIC half of the X25519
     * identity in `~/.sesh-mover/identity.age`. The private half is never
     * transported, which is the entire point of per-machine identities.
     *
     * Published here rather than distributed, so that the recipient list is
     * derivable from the hub itself and joining a machine is `hub init` plus one
     * re-push from each existing machine — no key exchange, no flag day.
     *
     * **Optional, permanently.** A machine on an older version, or one whose
     * identity file was unreadable when it last checked in, has no key here. Such
     * a machine is reported by `collectHubRecipients` as `unkeyed` and is never
     * silently dropped from the census: encrypting a bundle to a list that omits a
     * machine locks that machine out of it forever, and a filtered list makes that
     * indistinguishable at the call site from the machine not existing.
     *
     * A public key discloses nothing — it sits beside this machine's id, name,
     * platform and last-seen time, all of which the plaintext index already
     * carries.
     */
    ageRecipient?: string;
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
/**
 * Where a machine's WORKSPACE SNAPSHOTS live — beside its bundles rather than
 * inside them (#91).
 *
 * **The split exists because the two payloads have opposite lifetimes.** A
 * transcript is small and is kept forever; a workspace snapshot is the whole
 * project tree and is superseded by the next generation. Welded into one
 * archive, reclaiming a stale snapshot means deleting the transcript that rode
 * with it, so bundle-granularity compaction (#92) has no good move. Split, the
 * snapshot can be retired without touching a byte of history.
 *
 * Three properties this directory inherits rather than re-states:
 *
 * - **Per-machine ownership.** `<machineId>` is the last segment for the same
 *   reason `bundleDir`'s is: a machine writes only its own files, so two
 *   machines never contend and no distributed lock is needed.
 * - **The same naming rule as a bundle** (`bundleFileName`), so
 *   `isEncryptedBundleFile` is the whole of the reader's encryption branch here
 *   too. A workspace artifact goes through `fetchBundleArchive` — the one seam
 *   where hub bytes are decrypted — and needs no reader of its own.
 * - **A separate directory, not a second name inside `bundles/`.** `hub
 *   reindex` lists `bundleDir` and refuses any name `BUNDLE_FILE_RE` does not
 *   parse; parking workspace artifacts there would make every one of them an
 *   "unrecognized bundle file" warning on every rebuild, including on plugin
 *   versions that predate this split. Under `workspaces/` they are simply
 *   invisible to it.
 *
 * Deletion needs no new code: `hub delete` enumerates `backend.list(projectDir(…))`,
 * which recurses, so this subtree is swept with the rest.
 */
export declare function workspaceDir(projectId: string, machineId: string): string;
/**
 * The suffix an ENCRYPTED bundle carries, appended to the plaintext one.
 *
 * **This is the whole of the reader's branch.** A hub is permanently MIXED —
 * enabling encryption never rewrites an existing bundle (that would be one
 * machine rewriting another machine's files, which per-machine ownership
 * forbids outright), so plaintext and ciphertext sit side by side forever. The
 * reader therefore decides per FILE, from the name the index recorded, and
 * never from local config: a reader that consulted `hub.json.encrypt` or the
 * local `hub.encrypt` preference would strand its own history the moment the
 * switch was flipped, and would fail in the other direction on a machine that
 * has not enabled it yet.
 *
 * `.tar.gz` remains the plaintext spelling, so an older plugin's
 * `BUNDLE_FILE_RE` still parses the bundles it can actually read and simply
 * does not recognise the ones it cannot.
 */
export declare const ENCRYPTED_BUNDLE_SUFFIX = ".age";
/**
 * Is this bundle file encrypted? **Suffix only — see `ENCRYPTED_BUNDLE_SUFFIX`.**
 *
 * Takes any hub-relative path or bare file name, because the three readers that
 * ask (the pull fetch, the merge-ancestor fetch, and `hub reindex`) hold it in
 * different shapes and must not each grow their own copy of the rule.
 */
export declare function isEncryptedBundleFile(fileOrPath: string): boolean;
export declare function bundleFileName(pushedAtIso: string, bundleId: string, opts?: {
    encrypted?: boolean;
}): string;
//# sourceMappingURL=layout.d.ts.map