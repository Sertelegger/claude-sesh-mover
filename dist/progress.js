"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.percentThrottle = percentThrottle;
// Throttles byte-level progress to integer-percent changes so onProgress
// callbacks can't become a per-line hot loop.
function percentThrottle(bytesTotal, emit) {
    let last = -1;
    return (bytesProcessed) => {
        const percent = bytesTotal > 0
            ? Math.min(100, Math.floor((bytesProcessed / bytesTotal) * 100))
            : 100;
        if (percent !== last) {
            last = percent;
            emit(percent, bytesProcessed);
        }
    };
}
//# sourceMappingURL=progress.js.map