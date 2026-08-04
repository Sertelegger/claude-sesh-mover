import { type RewriteContext } from "../rewriter.js";
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
 */
export declare function identityRewriteContext(): RewriteContext;
export interface AppendAttempt {
    basePath: string;
    /** Session id every appended entry is rewritten to. */
    baseSessionId: string;
    deltaPath: string;
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
export type AppendDeclineReason = "chain-mismatch" | "recently-active" | "no-delta-entries" | "rolled-back";
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
 * truncated fragment. Strips the synthetic continuation header and rewrites
 * every appended entry's `sessionId` onto the base session.
 *
 * Two guards, in order:
 * 1. **Chain** (never skippable, not even with `force`): the delta's anchor
 *    (`parentUuid` of its first real entry) must equal the base's current head
 *    uuid. Without this the splice would fabricate a broken parent chain.
 * 2. **Liveness** (`force` skips it): declines when the base was modified
 *    inside `APPEND_LIVE_WINDOW_MS`, unless the modification came from this
 *    very operation (`mtime >= opNowMs`) — that exemption is what lets one
 *    pull write a fresh base and then splice its own continuations onto it.
 *
 * The base is only ever EXTENDED, so rollback is a truncate back to the
 * pre-append byte length — byte-exact by construction. Rollback also
 * re-verifies the restored head uuid.
 *
 * Every anticipated failure is reported as a `declined` outcome. Raw IO faults
 * still throw: an unreadable delta path, and — loudest of all — a rollback that
 * itself failed, which is the one case where the base may be left corrupt.
 */
export declare function tryAppendContinuation(a: AppendAttempt): Promise<AppendOutcome>;
//# sourceMappingURL=append.d.ts.map