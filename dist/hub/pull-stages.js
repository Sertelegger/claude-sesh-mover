export function stageOk(value, reasons = []) {
    return { status: "applied", value, reasons };
}
export function stageSkip(reason) {
    return { status: "skipped", value: null, reasons: [reason] };
}
export function stageRefuse(reason) {
    return { status: "refused", value: null, reasons: [reason] };
}
//# sourceMappingURL=pull-stages.js.map