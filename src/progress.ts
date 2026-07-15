// Throttles byte-level progress to integer-percent changes so onProgress
// callbacks can't become a per-line hot loop.
export function percentThrottle(
  bytesTotal: number,
  emit: (percent: number, bytesProcessed: number) => void
): (bytesProcessed: number) => void {
  let last = -1;
  return (bytesProcessed: number) => {
    const percent =
      bytesTotal > 0
        ? Math.min(100, Math.floor((bytesProcessed / bytesTotal) * 100))
        : 100;
    if (percent !== last) {
      last = percent;
      emit(percent, bytesProcessed);
    }
  };
}
