import { type RewriteContext } from "../rewriter.js";
import type { VersionAdapter } from "../types.js";
/**
 * How recently a base session must have been written for the append to be
 * treated as "a live Claude Code session is probably still appending to it".
 */
export declare const APPEND_LIVE_WINDOW_MS: number;
export interface DeltaChainInfo {
    /** First line is the synthetic `[sesh-mover continuation]` header. */
    headerPresent: boolean;
    /** Anchor: the parentUuid of the first REAL (non-header) entry. */
    firstEntryParentUuid: string | null;
    lastEntryUuid: string | null;
}
/**
 * Bounded read of a continuation bundle's chain endpoints: the leading lines up
 * to and including the first CONVERSATION entry (capped at
 * `MAX_ENTRY_SCAN_BYTES`), plus one cheap tail read.
 *
 * `buildContinuationStream` slices the tail of a session from a known index, so
 * the first entry after the cut carries a `parentUuid` equal to the uuid the
 * slice was cut after — that value is the chain guard's input.
 *
 * The cut lands on the first line the peer has not seen, which is usually a
 * uuid-less bookkeeping entry (`last-prompt` / `mode` / …, written right after
 * each assistant turn). Those lines carry no `parentUuid` at all, so the anchor
 * is taken from the first entry that is actually IN the chain, not from
 * whatever line happens to sit under the header.
 */
export declare function readDeltaChainInfo(deltaPath: string): Promise<DeltaChainInfo>;
/**
 * Rewrite context for a same-machine session copy: identical platform and user,
 * and no path mappings (source and target paths are equal, so
 * `buildPathMappings` emits none). `rewriteEntry` therefore touches ONLY the
 * `sessionId` — cwd, tool results and snapshot keys pass through untouched.
 *
 * NOTE — no production caller. Every real splice comes off the hub, i.e. from
 * another machine, and goes through `buildImportRewriteContext` (see
 * `AppendAttempt.ctx`). This exists for tests and for a hypothetical
 * same-machine splice; if you reach for it against bundle content, you are
 * almost certainly about to embed another machine's paths in a local
 * transcript.
 */
export declare function identityRewriteContext(): RewriteContext;
export interface AppendAttempt {
    basePath: string;
    /** Session id every appended entry is rewritten to. */
    baseSessionId: string;
    deltaPath: string;
    /**
     * Source -> target rewrite context for the bundle the delta came out of.
     * REQUIRED, and deliberately not defaulted: the delta is another machine's
     * bytes, and splicing it in raw would embed that machine's `cwd`, tool
     * result paths and file-history keys into a local transcript. Build it with
     * `buildImportRewriteContext(manifest, targetProjectPath, targetConfigDir)`
     * — the same call importer.ts makes, so a spliced continuation and an
     * imported fragment come out identical. Pass `identityRewriteContext()`
     * only for a genuinely same-machine splice.
     */
    ctx: RewriteContext;
    /**
     * Version adapters for source -> target Claude Code versions, from
     * `getApplicableAdapters`. Same rationale as `ctx`: an un-migrated schema
     * spliced into a local transcript is as wrong as a foreign path.
     */
    adapters?: VersionAdapter[];
    /** Pull-operation start time — enables the self-write mtime exemption. */
    opNowMs: number;
    /** `--force-append`: skips the mtime guard ONLY, never the chain guard. */
    force: boolean;
    /**
     * Test seam: forced failure after the delta has been appended but before head
     * verification — the only window in which rollback has real bytes to undo.
     * Never set in production code.
     */
    __injectFailure?: () => never;
}
export type AppendDeclineReason = 
/** The base's head uuid is not the delta's anchor (checked twice: before and after the O(delta) prep). */
"chain-mismatch"
/** The base looks like a live session and `force` was not set. */
 | "recently-active"
/** The bundle carries nothing appendable (empty, or a full session with no anchor). */
 | "no-delta-entries"
/** The bundle itself is unusable. Aborted BEFORE the base was touched — it is byte- and mtime-identical. */
 | "delta-unusable"
/** Bytes were appended, then something failed and the base was truncated back. */
 | "rolled-back";
export type AppendOutcome = {
    kind: "appended";
    entriesAppended: number;
    newHeadUuid: string;
} | {
    kind: "declined";
    reason: AppendDeclineReason;
    detail: string;
};
/**
 * Splices a continuation bundle onto the end of an existing local session so
 * the conversation stays ONE resumable transcript instead of a base plus a
 * truncated fragment. Strips the synthetic continuation header, applies
 * `a.adapters` and `a.ctx` to every appended entry (identical treatment to
 * what importer.ts gives a fragment, so the two paths can't diverge), and
 * rewrites each entry's `sessionId` onto the base session.
 *
 * Two guards, in order:
 * 1. **Chain** (never skippable, not even with `force`): the delta's anchor
 *    (`parentUuid` of its first real entry) must equal the base's current head
 *    uuid. Without this the splice would fabricate a broken parent chain. It is
 *    checked TWICE — once up front, and again immediately before the write,
 *    because the preparation between them is O(delta) and Claude Code (which
 *    the project lock does not cover) may append to the base in that window.
 * 2. **Liveness** (`force` skips it): declines when the base was modified
 *    inside `APPEND_LIVE_WINDOW_MS`, unless the modification came from this
 *    very operation (`mtime >= opNowMs`) — that exemption is what lets one
 *    pull write a fresh base and then splice its own continuations onto it.
 *
 * The base is only ever EXTENDED, so rollback is a truncate back to its byte
 * length as re-measured at that second check — byte-exact by construction, and
 * measured late enough that it can never discard a concurrent writer's bytes.
 * Rollback also re-verifies the restored head uuid, and is skipped entirely
 * when nothing was written (so a decline never even bumps the base's mtime —
 * Claude Code orders `/resume` by mtime).
 *
 * Every anticipated failure is reported as a `declined` outcome. Raw IO faults
 * still throw: an unreadable delta path, a fault before any byte was written,
 * and — loudest of all — a rollback that itself failed, which is the one case
 * where the base may be left corrupt.
 */
export declare function tryAppendContinuation(a: AppendAttempt): Promise<AppendOutcome>;
export interface AdoptHubInput {
    basePath: string;
    /** Session id the adopted (hub) entries are rewritten to — the base's own. */
    baseSessionId: string;
    deltaPath: string;
    /**
     * Byte offset just past the common anchor entry, from
     * `findEntryOffsetByUuid`. Verified to sit on a line boundary before
     * anything is truncated (see `isLineBoundary`).
     */
    anchorOffset: number;
    /** Caller-minted uuid for the copy of the local branch. */
    preservedSessionId: string;
    /**
     * `<projectDir>/<preservedSessionId>.jsonl` — must not exist yet, and is
     * checked: the failure path deletes this file, so adopting onto an existing
     * one would let a rollback destroy something that was never ours.
     */
    preservedPath: string;
    /**
     * Source -> target rewrite context for the bundle the delta came out of.
     * REQUIRED for exactly the reason `AppendAttempt.ctx` is: the delta is
     * another machine's bytes. Build it with `buildImportRewriteContext`. The
     * PRESERVED copy is local bytes and is deliberately NOT run through this —
     * it only gets a new session id.
     */
    ctx: RewriteContext;
    /** Version adapters for source -> target Claude Code versions. */
    adapters?: VersionAdapter[];
    /**
     * Test seam: forced failure after the base has been rewritten but before
     * head verification — the window in which restore has real bytes to undo.
     * Never set in production code.
     */
    __injectFailure?: () => never;
}
export type AdoptOutcome = {
    kind: "adopted";
    entriesAppended: number;
    newHeadUuid: string;
    preservedSessionId: string;
}
/**
 * Nothing was kept. Either the base was never touched (every refusal before
 * the truncate, including the concurrent-modification re-check), or it was
 * restored byte-for-byte from the snapshot this call took at its start.
 *
 * The distinction matters under a live writer: "restored" means restored to
 * THE SNAPSHOT, so a restore can only ever be byte-for-byte with respect to
 * the file as it was when adoption began. That is exactly why the re-check
 * exists — it makes the untouched case the only one a concurrent writer can
 * reach.
 */
 | {
    kind: "failed";
    detail: string;
};
/**
 * Divergence adoption: make the hub's branch canonical WITHOUT losing local
 * work. Two branches hang off a common anchor; this cuts the local one off at
 * that anchor, splices the hub's on instead, and keeps the local branch as a
 * second, complete session (common history + local branch — a transcript that
 * starts mid-conversation is the fragment problem this whole path exists to
 * avoid).
 *
 * Order is the design:
 * 1. the full base is copied to a temp backup BEFORE any mutation, so a
 *    failure is a RESTORE rather than a reconstruction from two half-written
 *    files;
 * 2. every cheap refusal (no delta entries, an offset that isn't a line
 *    boundary, a preserved path that already exists) and all the O(delta)
 *    preparation happen while the base is still untouched, so the mutation
 *    window is a truncate plus one append;
 * 3. the base is re-measured immediately before the truncate and the adoption
 *    is abandoned if it moved — see below;
 * 4. the preserved session is materialised only AFTER the splice verifies —
 *    on failure there is no orphan file, and (because the caller registers it
 *    in `history.jsonl` only once this returns `adopted`) nothing to
 *    un-register either.
 *
 * Step 3 is the same defense `tryAppendContinuation` runs at its own step 3,
 * and it matters MORE here. No lock of ours covers Claude Code, the
 * preparation in step 2 is O(delta), and a live session may append in that
 * window. An append that raced would merely be spliced after entries it does
 * not chain to; a truncate that races DESTROYS those entries — and they would
 * not be in the backup either, because the backup was taken before they were
 * written. So the base's size and head uuid are captured from the BACKUP (the
 * snapshot that is actually restorable) and re-checked against the live file
 * just before the cut; any difference abandons the adoption with nothing
 * written, leaving the concurrent writer's bytes exactly where they are.
 *
 * No entry is injected into either transcript; the "preserved" labelling is
 * the caller's `history.jsonl` display name, not content.
 *
 * Anticipated failures come back as `failed`. The one case that throws is a
 * restore that itself failed — the only situation where the base may be left
 * inconsistent, and the temp backup is then deliberately NOT deleted so the
 * error can name a full copy of the user's session.
 */
export declare function adoptHubBranch(input: AdoptHubInput): Promise<AdoptOutcome>;
//# sourceMappingURL=append.d.ts.map