import { type ApplyResult, type CarryMeta } from "../payload/carry.js";
import { type PulledCarry } from "./pull-apply-state.js";
import { type StageOutcome } from "./pull-stages.js";
/**
 * Exactly the three apply-loop fields this stage reads — a structural subset of
 * `ApplyState`, so the call site is `apply: st` and nothing here depends on the
 * other twenty accumulators.
 *
 * `deferredBundles` is deliberately ABSENT. It belongs to the divergence-abort
 * disclosure, which is a *sessions* statement (its first clause fires with no
 * carry present at all) and stays out of this module.
 */
export interface CarryApplyView {
    readonly lastCarry: PulledCarry | null;
    readonly divergenceAborted: boolean;
    readonly abortIndex: number;
}
export interface ApplyCarryStageInput {
    /**
     * Where the project lives on THIS machine: the pull's `effectiveProjectPath`
     * (`--target-path` if given, else the project path), never the raw
     * `projectPath`. It decides both where a payload is applied and where a
     * declined one is saved, so the two must not disagree.
     */
    targetPath: string;
    /** Did the invocation ask for carried changes to be applied? See the doc below. */
    applyRequested: boolean;
    readonly apply: CarryApplyView;
}
export interface ApplyCarryStageResult {
    /**
     * The payload the bundle DECLARED. Present even when `carryApplied` is not: a
     * bundle that declares a carry it does not contain still reports what it
     * claimed.
     *
     * Identity, never a copy — for every block a sesh-mover push wrote. It passes
     * through `normalizeCarryMeta`, which hands back the manifest's own object
     * untouched unless a field was not of its declared type; only then is this a
     * repaired copy, and the stage's reasons say which fields were repaired. That
     * is what makes the `CarryMeta` on `HubPullResult` a type rather than a hope
     * (see the module doc below).
     */
    carryAvailable: CarryMeta;
    /** What became of it, or `undefined` when the bundle held nothing to act on. */
    carryApplied: ApplyResult | undefined;
}
/**
 * Deliver the newest carried payload in the chain — by applying it, or by
 * SAVING it.
 *
 * **`applyRequested: false` does not mean skip. It means save.** The
 * not-requested path runs the whole stage and reaches `applyCarry` with
 * `saveOnly: true`, which parks patch, untracked tree, `carry.json` and a
 * README under the project before declining. Short-circuiting to a skip before
 * that call destroys another machine's uncommitted work permanently: by the
 * time this stage runs the pull has already recorded its bundles as received,
 * so a re-run — with or without the flag — answers "Already up to date", and
 * `hubPull`'s `finally` deletes the extraction directory the payload was read
 * from. There is no second chance to take.
 *
 * **Two `applied`s that mean different things.** `StageOutcome.status ===
 * "applied"` says *this stage did its work*; `ApplyResult.applied === true`
 * says *the working tree was written*. The save path is status-applied with
 * `applied: false` — the stage did exactly what it should, and the tree was
 * deliberately untouched. Reviewers read this backwards; the outcomes are:
 *
 * | situation | outcome |
 * |---|---|
 * | nothing in the chain carried a payload | `skipped`, zero reasons, no value |
 * | a divergence abort defers this payload | `skipped`, zero reasons, no value |
 * | the bundle declares a carry it lacks | `skipped`, one reason, value with `carryAvailable` only |
 * | applied, or declined and saved | `applied`, `describeCarryApply`'s reasons |
 *
 * The third row is why the result is not a `StageOutcome<ApplyResult>`:
 * `carryAvailable` is the SENDER's claim, read from the manifest before the
 * bundle is inspected, and it reaches `HubPullResult` even when nothing could
 * be done with it.
 *
 * A `carry` block this version could not read adds ONE reason to whichever of
 * those rows applies and changes none of them — it is not a fifth row, and
 * deliberately not an abort. The argument is the one the third row already
 * makes: "the manifest says something about this bundle that does not hold" is
 * a statement about the bundle, apply-safe by construction, and the sessions
 * and workspace this pull already applied are not made wrong by it. Aborting
 * would also be the one outcome that guarantees data loss — a fetch abort stops
 * the pull *before* this stage runs at all, so the payload would go with the
 * extraction directory. See `normalizeCarryMeta` for how fail-closed is
 * expressed instead: as a `baseCommit` no HEAD can match, which declines the
 * apply and keeps the save.
 *
 * **No `try`/`catch` here, on purpose.** `applyCarry` can reject
 * (`listPayloadFiles` sits outside its own try). Today that propagates past
 * `hubPull`'s `finally`, which still releases the lock and clears the temp
 * dir. Catching it would turn a hard failure into a warning on a pull that
 * then reports `success: true`.
 */
export declare function runApplyCarryStage(input: ApplyCarryStageInput): Promise<StageOutcome<ApplyCarryStageResult>>;
//# sourceMappingURL=pull-apply-carry.d.ts.map