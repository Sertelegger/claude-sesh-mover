import type { ErrorResult } from "../types.js";

/**
 * The contract every pull stage returns.
 *
 * The four statuses differ in exactly two ways that matter to the caller: did
 * this stage's work land, and may the pull carry on past it?
 *
 * - `applied` — the stage did its work; `value` carries it. May STILL carry
 *   reasons: the pull's failure contract is apply-safe-and-name-the-gap, so a
 *   stage that did its work while something was unreachable reports both. An
 *   empty `reasons` on an applied outcome is the only "nothing to disclose"
 *   signal. Caller: use `value`, surface any reasons as warnings.
 * - `skipped` — there was nothing for this stage to do. Not a failure and not
 *   a degradation; the pull is no worse off. Reasons are 0..k, because the
 *   common no-op (no payload in the chain at all) is not a story worth telling
 *   while a skip the user *would* want explained (no common merge ancestor)
 *   needs several sentences. Caller: carry on, surface any reasons.
 * - `refused` — the stage declined to do its part, and says why. Apply-safe:
 *   the rest of the pull is still correct without it, so the pull CONTINUES
 *   and the reasons become user-facing warnings. Caller: carry on, surface the
 *   reasons.
 * - `aborted` — the opposite of `refused`. This stage is NOT apply-safe: the
 *   operation must stop here, before anything further is applied or recorded.
 *   `terminal` carries the `ErrorResult` `hubPull` returns verbatim. Caller:
 *   `if (r.status === "aborted") return r.terminal!;` — never continue past it,
 *   because continuing would import sessions and record the bundle for a pull
 *   the user must be able to retry.
 */
export type StageStatus = "applied" | "skipped" | "refused" | "aborted";

export interface StageOutcome<T> {
  status: StageStatus;
  /**
   * The stage's work product. Always present on "applied"; a "skipped" stage
   * may also carry one when its no-op still has a shape to hand back. Always
   * null on "refused" and "aborted".
   */
  value: T | null;
  /**
   * User-facing sentences. Possible on every status, including "applied" —
   * see the status list above for what an empty list means for each.
   */
  reasons: string[];
  /**
   * The ErrorResult `hubPull` returns verbatim. Present ONLY on "aborted",
   * where it means: this stage is NOT apply-safe, the operation stops here.
   */
  terminal?: ErrorResult;
}

export function stageOk<T>(value: T, reasons: string[] = []): StageOutcome<T> {
  return { status: "applied", value, reasons };
}

/**
 * `reasons` takes a bare string as the one-reason shorthand, or a list for the
 * 0..k cases: an empty list is a silent no-op, several is a degradation that
 * needs more than one sentence to explain.
 */
export function stageSkip<T>(reasons: string | string[], value: T | null = null): StageOutcome<T> {
  return { status: "skipped", value, reasons: typeof reasons === "string" ? [reasons] : [...reasons] };
}

export function stageRefuse<T>(reason: string): StageOutcome<T> {
  return { status: "refused", value: null, reasons: [reason] };
}

/**
 * A terminal return: the pull stops here and `terminal` is what `hubPull`
 * returns. Use this — never `stageRefuse` — whenever the stage's failure means
 * the rest of the pull must NOT proceed.
 */
export function stageAbort<T>(terminal: ErrorResult): StageOutcome<T> {
  return { status: "aborted", value: null, reasons: [terminal.error], terminal };
}
