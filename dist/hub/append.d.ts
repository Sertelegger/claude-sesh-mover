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
 * Bounded read of a continuation bundle's chain endpoints: at most the first
 * two non-empty lines plus one cheap last-line read.
 *
 * `buildContinuationStream` slices the tail of a session from a known index, so
 * the first REAL entry's `parentUuid` is exactly the uuid the slice was cut
 * after — that value is the chain guard's input.
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
//# sourceMappingURL=append.d.ts.map