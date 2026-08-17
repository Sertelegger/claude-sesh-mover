import { type HubBundleRecord } from "./layout.js";
import { type ApplyState } from "./pull-apply-state.js";
import type { ErrorResult, ExportManifest, OnDivergenceMode, ProgressEvent, SessionManifest } from "../types.js";
export interface ThreadBaseCandidate {
    localSessionId: string;
    /** Uuid of the session's last entry, or null when it can't be read. */
    headEntryUuid: string | null;
    /** Timestamp of that last entry, or null when it can't be read. */
    lastActiveAt: string | null;
}
/**
 * Pick which of a thread's local sessions a continuation should splice onto.
 *
 * A thread maps to MORE THAN ONE local session as a matter of course: every
 * time a splice is declined (a live-looking base, a chain that doesn't line
 * up, `--no-append`) the fragment import mints a new session and maps it onto
 * the same thread, while the older mapping stays. "Whichever key comes first"
 * therefore returns the OLDEST session forever, and since the continuation
 * chain has moved on, every subsequent pull chain-mismatches and forks off
 * another fragment — a state `--force-append` cannot rescue, because force
 * never skips the chain guard. index-file.ts:30-41 refuses the mirror-image
 * shortcut in the forward direction for the same reason.
 *
 * So: the delta's anchor decides. The session whose head IS the entry this
 * continuation follows is the one it belongs on, whatever the map's insertion
 * order says — which is also what makes a poisoned map self-healing, since
 * the fragment that stranded the thread is exactly the session carrying the
 * anchor next time round.
 *
 * Order of preference:
 *   1. sessions whose head uuid equals `anchorUuid` (when it's known and any
 *      candidate matches) — otherwise every candidate stays in the running,
 *      so the caller still gets a sensible base to name in the decline;
 *   2. `preferred` (the session THIS pull already landed content in) if it
 *      survived step 1;
 *   3. most recent `lastActiveAt`, ties broken by lexically greatest session
 *      id — a strict total order, so the answer never depends on map or
 *      directory iteration order.
 */
export declare function selectThreadBase(candidates: ThreadBaseCandidate[], anchorUuid: string | null, preferred: string | null): string | null;
/**
 * The argument `pull.ts`'s `recordSplice` takes. Declared here so the callback
 * can be typed without importing anything back out of `pull.ts` — that import
 * would make the two modules circular.
 */
export interface RecordSpliceInput {
    projectPath: string;
    basePath: string;
    baseSessionId: string;
    /**
     * The peer whose ledger this splice credits: the machine that supplied
     * `record`, i.e. `bundleMachineId`. Never the pull's resolved machine — see
     * that field.
     */
    peerId: string;
    hubPeerId: string;
    manifest: ExportManifest;
    record: HubBundleRecord;
    bundleSession: SessionManifest;
    newHeadUuid: string;
}
/**
 * What the caller's loop must do next. `StageOutcome` cannot express this
 * stage: the moved code has FOUR loop-control escapes and one function exit,
 * and a function cannot return from its caller.
 *
 * - `next` — the two `continue`s (bundle handled by a splice or an adoption)
 *   AND the ordinary fall-through past the fragment import. The caller carries
 *   on with the next bundle either way; the distinction was never observable.
 * - `stop-chain` — the two divergence `break`s. **The caller must translate
 *   this into a real `break` of the per-bundle loop**, not a `continue` and not
 *   a return. Two things ride on it: a skip promises that nothing was applied
 *   or recorded for this bundle OR ANY LATER ONE (see `divergenceAborted` in
 *   pull-apply-state.ts), and the workspace gate is evaluated at the TOP of
 *   each iteration, so breaking at bundle `j` is also what keeps a payload on
 *   bundle `k > j` from being applied by a pull the user is about to re-run.
 * - `fail` — the fragment import failed. `result` is the importer's own
 *   `ErrorResult` and the caller returns it VERBATIM. It carries
 *   `command: "import"` on a pull failure, which is deliberate: the object is
 *   the importer's diagnosis with the importer's `suggestion`, and re-stamping
 *   `command: "pull"` would leave a suggestion phrased for another command.
 */
export type ApplySessionsControl = {
    kind: "next";
} | {
    kind: "stop-chain";
} | {
    kind: "fail";
    result: ErrorResult;
};
export interface ApplySessionsOutcome {
    control: ApplySessionsControl;
    /**
     * User-facing sentences, in push order. The caller spreads them into the
     * pull's warnings INSIDE the loop, immediately after this call — these
     * interleave with the workspace stage's reasons for the same and earlier
     * bundles, and a stage-major concatenation reorders them (pinned by
     * tests/hub-pull-invariants.test.ts).
     *
     * On `fail` they are DROPPED, exactly as before: the pull returns the
     * importer's ErrorResult and every warning collected so far goes with it.
     * The importer's own `warnings` are deliberately not folded in here — the
     * failure return happens before that spread in the source and still does.
     */
    reasons: string[];
}
export interface ApplySessionsStageInput {
    /** Where this bundle was unpacked by the fetch stage. */
    extractDir: string;
    /** That bundle's manifest, as the fetch stage read it. */
    bundleManifest: ExportManifest;
    record: HubBundleRecord;
    /** This bundle's position in the chain, and how long the chain is. */
    bundleIndex: number;
    chainLength: number;
    /** The EFFECTIVE project path — `--target-path` when one was given. */
    projectPath: string;
    configDir: string;
    /** `<configDir>/projects/<encoded effective project path>`. */
    targetProjectDir: string;
    claudeVersion: string;
    threadId: string;
    /**
     * The machine whose index lists THIS bundle — the peer a splice credits.
     *
     * PER BUNDLE, never the pull's resolved source, and the two are different
     * questions the moment a chain spans machines. `recordSplice` writes
     * `peers[peerId].received` and `peers[peerId].sent`; the first is
     * `selectNeededBundles`'s dedup input and the second is the incremental
     * diff's baseline, so crediting the resolved machine for a bundle another
     * machine supplied makes the next push ship a delta against a base that peer
     * does not hold — `recordSentToPeer`'s unreconstructable-thread invariant
     * (src/sync-state.ts), reached by the other ledger.
     *
     * It would typecheck either way and throw either way: nothing but the name
     * distinguishes them at the call site, which is why the name is this one.
     */
    bundleMachineId: string;
    /** This hub's synthetic peer id, for the hub-side ledger. */
    hubPeerId: string;
    noAppend: boolean;
    forceAppend: boolean;
    onDivergence: OnDivergenceMode | undefined;
    /**
     * The pull's operation boundary, captured ONCE by `hubPull`: anything whose
     * mtime is at or after it was written by this operation, not by a live
     * Claude Code session. Never re-read here — a per-bundle capture re-arms
     * append.ts's liveness guard against our own writes.
     */
    opNowMs: number;
    /**
     * The "now" the human-readable base age is measured from — `baseAgeMs`, the
     * "modified 37s ago" in three shipped sentences.
     *
     * A SEPARATE parameter from `opNowMs` even though today's caller passes the
     * same value, because they are different KINDS of thing and only one of them
     * may go stale. `opNowMs` is a boundary captured before the lock; this is a
     * duration that wants the clock at the moment of reporting.
     *
     * Passing `opNowMs` therefore UNDER-reports the age by however long the pull
     * has been running — the lock, the resolve stage, the download, the unpack.
     * The effect is one-directional and conservative: a smaller age makes
     * `looksLive` MORE likely true, so `adopt-hub` is refused where a fresh clock
     * would have adopted. It can turn an adoption into a refusal, never a
     * refusal into a truncation. It also makes the three shipped
     * "modified Ns ago" sentences read low by the same amount.
     *
     * (An earlier version of this comment claimed the opposite — that folding
     * them together inflates the age and pushes the heuristic somewhere unsafe.
     * That was backwards, and it was wrong in the plan, in this doc and in the
     * invariants test at once. Restoring exact pre-extraction behavior means
     * taking a fresh wall-clock reading at the call site, which the clock-read
     * allowlist in `tests/hub-pull-invariants.test.ts` would then have to
     * permit. Spelling that call out here is not possible: the stage-file guard
     * greps raw source and does not skip comments, deliberately, so that a real
     * read cannot hide behind one.)
     *
     * The `looksLive` comparison keeps `opNowMs`; only the rendered age uses
     * this.
     */
    ageNowMs: number;
    /** `YYYY-MM-DD` for the preserved branch's history.jsonl display name. */
    historyNowDate: string;
    /** Epoch millis for that same history.jsonl record's `timestamp`. */
    historyNowMs: number;
    /**
     * MUTATED IN PLACE, never copied. `describeApplied` closes over the live
     * containers `initApplyState` created, so a stage that pushed into a copy's
     * arrays would report an EMPTY pull in exactly the two warnings whose job is
     * to say what had already been applied — and it would typecheck.
     */
    state: ApplyState;
    /** `pull.ts`'s splice bookkeeping; called on both splice paths. */
    recordSplice: (b: RecordSpliceInput) => void;
    /** `pull.ts`'s bounded entry count from a byte offset; called twice. */
    countEntriesAfterOffset: (path: string, offset: number) => Promise<number>;
    /**
     * `hubPull`'s own callback, forwarded straight into `importSession` (#74).
     *
     * This is where the pull's only per-SESSION detail comes from — the importer's
     * `import-verify` event and its byte-level, percent-throttled
     * `import-rewrite` — and the call below simply omitted it, so `--progress` on
     * a pull reported nothing between the two hub-pull percents. Nothing here
     * interprets it: the events keep the importer's own phases, which is what
     * `ProgressEvent` already documents the hub phases as being coarse over.
     *
     * The two splice paths (append, adopt-hub) return BEFORE that call and so
     * report nothing — they write bytes directly rather than going through the
     * importer, and there is no seam in `append.ts` either.
     */
    onProgress?: (ev: ProgressEvent) => void;
}
/**
 * Land ONE bundle's session content: splice it onto an existing transcript,
 * adopt the hub's branch over a diverged one, or import it as its own session.
 *
 * Runs inside `hubPull`'s per-bundle loop, after `fetch` and `apply.workspace`
 * for the same bundle. Three things about it are load-bearing and invisible in
 * the signature:
 *
 * 1. **`state` is mutated in place** — see the field doc above.
 * 2. **The `divergence` object is ALIASED into `state.lastDivergence`, not
 *    copied.** `.resolution` is written at three points AFTER the assignment
 *    and `.preservedSessionId` at one. Assigning a spread (`{...divergence}`),
 *    or returning it as a value for the caller to assign, freezes `resolution`
 *    at the requested mode and leaves `preservedSessionId` permanently
 *    undefined — with no type error anywhere. The literal, the alias and all
 *    four later writes have to stay on one binding.
 * 3. **`tryAppendContinuation` and `adoptHubBranch` are NOT wrapped in a
 *    `try`/`catch`, and must not be.** They refuse-and-throw when a
 *    transcript's size is not exactly what our own write accounts for — the
 *    rollback rule that stops us reporting a clean restore over another
 *    writer's bytes. `hubPull`'s outer block has only a `finally`, so that
 *    throw reaches the CLI intact. A catch added "to make the stage total"
 *    turns the loudest safety property in the codebase into a silent decline,
 *    and the fragment import below would then run on top of a base that may
 *    hold another writer's bytes. `try`/`finally` is fine; `try`/`catch` is
 *    not.
 *
 * The `RewriteContext` is built HERE, per bundle, from this bundle's manifest —
 * never handed in. `append.ts` does neither the path rewrite nor the version
 * adaptation, so the delta has to be rewritten before it reaches either splice
 * path; and one context for a whole chain is wrong the moment two bundles come
 * from machines with different source paths.
 */
export declare function runApplySessionsStage(input: ApplySessionsStageInput): Promise<ApplySessionsOutcome>;
//# sourceMappingURL=pull-apply-sessions.d.ts.map