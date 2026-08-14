export function stageOk(value, reasons = []) {
    return { status: "applied", value, reasons };
}
/**
 * `reasons` takes a bare string as the one-reason shorthand, or a list for the
 * 0..k cases: an empty list is a silent no-op, several is a degradation that
 * needs more than one sentence to explain.
 */
export function stageSkip(reasons, value = null) {
    return { status: "skipped", value, reasons: typeof reasons === "string" ? [reasons] : [...reasons] };
}
export function stageRefuse(reason) {
    return { status: "refused", value: null, reasons: [reason] };
}
/**
 * A terminal return: the pull stops here and `terminal` is what `hubPull`
 * returns. Use this — never `stageRefuse` — whenever the stage's failure means
 * the rest of the pull must NOT proceed.
 */
export function stageAbort(terminal) {
    return { status: "aborted", value: null, reasons: [terminal.error], terminal };
}
//# sourceMappingURL=pull-stages.js.map