export declare function readFirstJsonlLine(path: string): string | null;
export declare function readLastJsonlLine(path: string): string | null;
export declare function countJsonlLines(path: string): number;
export declare function readLastEntryUuid(path: string): string | null;
export declare function readEntryUuids(jsonlPath: string): Promise<Array<{
    uuid: string;
}>>;
/**
 * Byte offset just PAST the line whose entry carries `uuid`, or `null` if the
 * uuid never appears. Used by divergence adoption to find the common anchor so
 * the base can be truncated exactly there. Streams line-by-line (bounded
 * memory) and stops at the first match; unparseable lines are skipped, not
 * fatal. Offsets are BYTE offsets — the caller truncates a file with them.
 *
 * Assumes LF-terminated lines. Two caveats for truncating callers:
 * - If the final line has no trailing newline the offset is 1 past EOF, and
 *   `truncateSync()` EXTENDS the file with a NUL byte rather than erroring.
 * - CRLF files undercount 1 byte/line, so truncating would strip the `\n`.
 *
 * Before truncating, verify the byte at `offset - 1` is `0x0A` — that one check
 * catches both cases (past EOF there is no such byte; on CRLF it is `0x0D`).
 *
 * Throws ENOENT if the file is missing — `null` means "uuid not found", nothing
 * else.
 */
export declare function findEntryOffsetByUuid(jsonlPath: string, uuid: string): Promise<number | null>;
//# sourceMappingURL=jsonl.d.ts.map