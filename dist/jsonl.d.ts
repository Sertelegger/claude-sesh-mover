/**
 * How far from either end of a transcript the conversation-entry scans will
 * read before giving up and returning `null`.
 *
 * Sessions grow without bound (250 MB transcripts exist), so "walk until you
 * find a conversation entry" needs a ceiling. Measured across every real
 * transcript in this machine's `~/.claude/projects` (2026-08-04): the longest
 * unbroken run of uuid-less bookkeeping anywhere was 17,010 bytes (4
 * `queue-operation` entries) — the run with the most ENTRIES was 15, but only
 * 2,103 bytes — the longest such run at the END of a file was 2 entries / 7,497
 * bytes, and the largest single line was 123,612 bytes. Bytes are what this cap
 * is denominated in, so 17,010 is the figure it has to clear: 4 MB is ~240x it.
 * The exact value is a whole multiple of `MAX_LINE_BYTES`, so the scan can
 * always cross several maximum-size lines before the window, rather than the
 * per-line cap, is what ends it.
 */
export declare const MAX_ENTRY_SCAN_BYTES: number;
/**
 * True for an entry that participates in the conversation's parent chain.
 *
 * The discriminator is deliberately STRUCTURAL — a non-empty string `uuid` —
 * and not a list of known bookkeeping `type`s. Claude Code adds entry types
 * between releases (`last-prompt`, `mode`, `permission-mode`, `ai-title`,
 * `agent-name`, `pr-link`, `queue-operation`, `file-history-snapshot`,
 * `file-history-delta` are only the ones observed so far), and a denylist would
 * go stale the next time it ships one. `uuid` is the chain identity —
 * `parentUuid` only ever points at an entry that has one — so this is the
 * predicate for "is this entry part of the conversation", and it was exact on
 * every entry of every real transcript measured (7 files / 6,187 lines / 4,284
 * conversation entries, 2026-08-04).
 *
 * What it is NOT is a chain-successor predicate. "The last entry with a uuid"
 * is not the same thing as "the entry the next one will chain onto", and the
 * difference is measurable rather than theoretical: a transcript is written as
 * a TREE, so 197 of 4,277 consecutive conversation-entry pairs (4.6%) have
 * `next.parentUuid !== prev.uuid`. Mostly sibling fans written back-to-back
 * under one parent (an `attachment` run followed by the `user` entry it belongs
 * to), sometimes a jump as far as 59 entries back; none of the 197 involved
 * `isSidechain`. So a continuation cut at such a boundary still fails
 * `tryAppendContinuation`'s chain guard even though this predicate answered
 * correctly. That residual is pre-existing and out of scope here — see the
 * ledger's Task 7 carry — but do not read this function as closing it.
 *
 * The empty string is rejected on purpose: `""` is the sentinel hub index files
 * and sync-state records write for "head unknown", so accepting it would let
 * that sentinel masquerade as a real head and satisfy a chain guard.
 */
export declare function isConversationEntry(value: unknown): boolean;
export declare function readFirstJsonlLine(path: string): string | null;
/**
 * The last non-empty RAW line of a file, trailing newlines ignored.
 *
 * Deliberately kept, and deliberately distinct from
 * `readLastConversationEntry`: this answers "what is literally at the end of
 * this file", which is a different question from "what is this session's head".
 * Every in-repo caller wanted the latter and has moved, so this now has no
 * production caller — but it is part of the published library surface
 * (`src/index.ts` re-exports this module), so removing it would be a breaking
 * change for a question that is still legitimate to ask.
 */
export declare function readLastJsonlLine(path: string): string | null;
export declare function countJsonlLines(path: string): number;
/**
 * The LAST conversation entry in a transcript — the session's head, i.e. the
 * entry a continuation's `parentUuid` must point at.
 *
 * Reading only the final line (what this used to do) is wrong: Claude Code
 * appends uuid-less bookkeeping entries after conversation entries. "5 of 7
 * sessions end with one" is the snapshot figure, and it is not a stable one —
 * some of those transcripts are live, so their final line changes as they are
 * written. The stable measurement is the share of a transcript's line
 * boundaries whose preceding line is uuid-less, i.e. the fraction of moments at
 * which the old derivation was wrong: 1,903 of 6,187 lines, 31%. A head derived
 * from such a line is `null`, which no chain guard can ever match and which
 * `JSON.stringify` drops out of an index file entirely.
 *
 * Bounded: walks backwards in `SCAN_CHUNK` blocks, holds at most one line plus
 * one block in memory, and reads at most `MAX_ENTRY_SCAN_BYTES` (rounded up to
 * the block size). Returns `null` — never a stale, earlier head — when the
 * window runs out, when a line past the head is unreadable, when the file is
 * missing or empty, or when the transcript holds no conversation entry at all.
 * `null` is the value every caller already handles: chain guards decline, index
 * writers fall back to their `""` sentinel.
 */
export declare function readLastConversationEntry(path: string): Record<string, unknown> | null;
/**
 * The FIRST conversation entry in a transcript — the mirror of
 * `readLastConversationEntry`, and broken in the same way for the same reason:
 * Claude Code also writes uuid-less bookkeeping at the TOP of a transcript
 * (`last-prompt`, `queue-operation` and `ai-title` were the observed first
 * lines of 7 of 7 real sessions on this machine). Session metadata read off the
 * literal first line — `cwd`, `timestamp`, `gitBranch`, `entrypoint` — is
 * therefore absent there.
 *
 * Same bound, same `null` discipline as the backward scan.
 */
export declare function readFirstConversationEntry(path: string): Record<string, unknown> | null;
/**
 * Head uuid of a session: the uuid of its last CONVERSATION entry, skipping
 * trailing bookkeeping. `null` when none can be determined — see
 * `readLastConversationEntry` for the exact cases.
 */
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