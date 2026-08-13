/**
 * The contract every pull stage returns.
 *
 * `applied` may still carry reasons: the pull's failure contract is
 * apply-safe-and-name-the-gap, so a stage that did its work while something
 * was unreachable reports both. An empty `reasons` on an applied outcome is
 * the only "nothing to disclose" signal.
 */
export type StageStatus = "applied" | "skipped" | "refused";

export interface StageOutcome<T> {
  status: StageStatus;
  /** Present only when status is "applied". */
  value: T | null;
  reasons: string[];
}

export function stageOk<T>(value: T, reasons: string[] = []): StageOutcome<T> {
  return { status: "applied", value, reasons };
}

export function stageSkip<T>(reason: string): StageOutcome<T> {
  return { status: "skipped", value: null, reasons: [reason] };
}

export function stageRefuse<T>(reason: string): StageOutcome<T> {
  return { status: "refused", value: null, reasons: [reason] };
}
