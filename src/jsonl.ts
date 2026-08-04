import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "node:fs";
import { createInterface } from "node:readline";

const CHUNK = 4096;
// A single JSONL line larger than this is treated as unreadable (return null)
// rather than ballooning memory — same fallback the callers already handle.
const MAX_LINE_BYTES = 1024 * 1024;

/** Chunk size for the bounded conversation-entry scans (fewer syscalls than CHUNK). */
const SCAN_CHUNK = 64 * 1024;

/**
 * How far from either end of a transcript the conversation-entry scans will
 * read before giving up and returning `null`.
 *
 * Sessions grow without bound (250 MB transcripts exist), so "walk until you
 * find a conversation entry" needs a ceiling. Measured across every real
 * transcript in this machine's `~/.claude/projects` (2026-08-04): the longest
 * unbroken run of uuid-less bookkeeping anywhere was 15 entries / 17 KB, the
 * longest such run at the END of a file was 2 entries / 7.5 KB, and the largest
 * single line was 124 KB. 4 MB is ~500x the worst observed run and — the reason
 * for this exact value — a whole multiple of `MAX_LINE_BYTES`, so the scan can
 * always cross several maximum-size lines before the window, rather than the
 * per-line cap, is what ends it.
 */
export const MAX_ENTRY_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * True for an entry that participates in the conversation's parent chain.
 *
 * The discriminator is deliberately STRUCTURAL — a non-empty string `uuid` —
 * and not a list of known bookkeeping `type`s. Claude Code adds entry types
 * between releases (`last-prompt`, `mode`, `permission-mode`, `ai-title`,
 * `agent-name`, `pr-link`, `queue-operation`, `file-history-snapshot`,
 * `file-history-delta` are only the ones observed so far), and a denylist would
 * go stale the next time it ships one. What does not change is that `uuid` is
 * the chain identity: `parentUuid` only ever points at an entry that has one,
 * which makes "the last entry with a uuid" exactly "the entry a continuation
 * can chain onto".
 *
 * The empty string is rejected on purpose: `""` is the sentinel hub index files
 * and sync-state records write for "head unknown", so accepting it would let
 * that sentinel masquerade as a real head and satisfy a chain guard.
 */
export function isConversationEntry(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const uuid = (value as { uuid?: unknown }).uuid;
  return typeof uuid === "string" && uuid.length > 0;
}

type LineRead =
  /** A conversation entry — the scan's answer. */
  | { kind: "entry"; entry: Record<string, unknown> }
  /** Blank formatting, or a parseable non-conversation (bookkeeping) entry. */
  | { kind: "skip" }
  /**
   * Non-empty but unreadable (oversized, malformed JSON, or not an object).
   * Fatal to a scan rather than skippable: we cannot tell whether it WAS a
   * conversation entry, so continuing past it could report a stale head as
   * current. Matches what `readLastEntryUuid` did before the scan existed —
   * an unparseable final line yielded `null`.
   */
  | { kind: "unreadable" };

function classifyLine(line: Buffer): LineRead {
  if (line.length === 0) return { kind: "skip" };
  if (line.length > MAX_LINE_BYTES) return { kind: "unreadable" };
  const text = line.toString("utf-8");
  if (text.trim().length === 0) return { kind: "skip" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable" };
  }
  return isConversationEntry(parsed)
    ? { kind: "entry", entry: parsed as Record<string, unknown> }
    : { kind: "skip" };
}

export function readFirstJsonlLine(path: string): string | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(CHUNK);
    let acc = Buffer.alloc(0);
    let pos = 0;
    for (;;) {
      const bytes = readSync(fd, chunk, 0, CHUNK, pos);
      if (bytes === 0) break;
      acc = Buffer.concat([acc, chunk.subarray(0, bytes)]);
      pos += bytes;
      const nl = acc.indexOf(0x0a);
      if (nl !== -1) {
        return nl > MAX_LINE_BYTES ? null : acc.subarray(0, nl).toString("utf-8");
      }
      if (acc.length > MAX_LINE_BYTES) return null;
    }
    return acc.length > 0 ? acc.toString("utf-8") : null;
  } finally {
    closeSync(fd);
  }
}

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
export function readLastJsonlLine(path: string): string | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size === 0) return null;
  const fd = openSync(path, "r");
  try {
    let end = size;
    let acc = Buffer.alloc(0);
    let trimmed = false;
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, end - start, start);
      acc = Buffer.concat([chunk, acc]);
      end = start;
      if (!trimmed) {
        let len = acc.length;
        while (len > 0 && (acc[len - 1] === 0x0a || acc[len - 1] === 0x0d)) len--;
        acc = acc.subarray(0, len);
        if (acc.length > 0) trimmed = true;
        else continue; // tail was all newlines; keep reading backwards
      }
      const nl = acc.lastIndexOf(0x0a);
      if (nl !== -1) {
        const line = acc.subarray(nl + 1);
        return line.length > MAX_LINE_BYTES ? null : line.toString("utf-8");
      }
      if (acc.length > MAX_LINE_BYTES) return null;
    }
    return acc.length > 0 ? acc.toString("utf-8") : null;
  } finally {
    closeSync(fd);
  }
}

export function countJsonlLines(path: string): number {
  if (!existsSync(path)) return 0;
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pos = 0;
    let count = 0;
    let atLineStart = true;
    for (;;) {
      const bytes = readSync(fd, chunk, 0, chunk.length, pos);
      if (bytes === 0) break;
      for (let i = 0; i < bytes; i++) {
        if (chunk[i] === 0x0a) {
          if (!atLineStart) count++;
          atLineStart = true;
        } else if (chunk[i] !== 0x0d) {
          atLineStart = false;
        }
      }
      pos += bytes;
    }
    if (!atLineStart) count++; // final line without trailing newline
    return count;
  } finally {
    closeSync(fd);
  }
}

/**
 * The LAST conversation entry in a transcript — the session's head, i.e. the
 * entry a continuation's `parentUuid` must point at.
 *
 * Reading only the final line (what this used to do) is wrong: Claude Code
 * appends uuid-less bookkeeping entries after conversation entries, and
 * measured across this machine's real transcripts 5 of 7 sessions end with one.
 * A head derived from such a line is `null`, which no chain guard can ever
 * match and which `JSON.stringify` drops out of an index file entirely.
 *
 * Bounded: walks backwards in `SCAN_CHUNK` blocks, holds at most one line plus
 * one block in memory, and reads at most `MAX_ENTRY_SCAN_BYTES` (rounded up to
 * the block size). Returns `null` — never a stale, earlier head — when the
 * window runs out, when a line past the head is unreadable, when the file is
 * missing or empty, or when the transcript holds no conversation entry at all.
 * `null` is the value every caller already handles: chain guards decline, index
 * writers fall back to their `""` sentinel.
 */
export function readLastConversationEntry(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size === 0) return null;
  const fd = openSync(path, "r");
  try {
    let pos = size;
    // Bytes of a line whose start lies before `pos` — carried into the next
    // (earlier) block so the line can be completed there.
    let carry = Buffer.alloc(0);
    let scanned = 0;
    while (pos > 0 && scanned < MAX_ENTRY_SCAN_BYTES) {
      const start = Math.max(0, pos - SCAN_CHUNK);
      const len = pos - start;
      const chunk = Buffer.alloc(len);
      readSync(fd, chunk, 0, len, start);
      scanned += len;
      pos = start;
      const buf = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let end = buf.length;
      while (end > 0) {
        const nl = buf.lastIndexOf(0x0a, end - 1);
        if (nl === -1) break; // remaining bytes start before this block
        const read = classifyLine(buf.subarray(nl + 1, end));
        if (read.kind === "entry") return read.entry;
        if (read.kind === "unreadable") return null;
        end = nl;
      }
      carry = buf.subarray(0, end);
      if (carry.length > MAX_LINE_BYTES) return null;
    }
    // Only a scan that reached offset 0 holds a complete first line; one that
    // stopped at the window holds a fragment and must not be parsed.
    if (pos === 0 && carry.length > 0) {
      const read = classifyLine(carry);
      if (read.kind === "entry") return read.entry;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

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
export function readFirstConversationEntry(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    let pos = 0;
    let carry = Buffer.alloc(0);
    while (pos < MAX_ENTRY_SCAN_BYTES) {
      const chunk = Buffer.alloc(SCAN_CHUNK);
      const bytes = readSync(fd, chunk, 0, SCAN_CHUNK, pos);
      if (bytes === 0) break;
      pos += bytes;
      const buf =
        carry.length > 0
          ? Buffer.concat([carry, chunk.subarray(0, bytes)])
          : chunk.subarray(0, bytes);
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl === -1) break;
        const read = classifyLine(buf.subarray(start, nl));
        if (read.kind === "entry") return read.entry;
        if (read.kind === "unreadable") return null;
        start = nl + 1;
      }
      carry = buf.subarray(start);
      if (carry.length > MAX_LINE_BYTES) return null;
    }
    // A final line with no trailing newline is still a complete line.
    if (carry.length > 0) {
      const read = classifyLine(carry);
      if (read.kind === "entry") return read.entry;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Head uuid of a session: the uuid of its last CONVERSATION entry, skipping
 * trailing bookkeeping. `null` when none can be determined — see
 * `readLastConversationEntry` for the exact cases.
 */
export function readLastEntryUuid(path: string): string | null {
  const entry = readLastConversationEntry(path);
  return entry ? (entry.uuid as string) : null;
}

// Streaming uuid scan for incremental-plan diffing: one small object per
// line instead of the whole file in memory.
export async function readEntryUuids(
  jsonlPath: string
): Promise<Array<{ uuid: string }>> {
  const uuids: Array<{ uuid: string }> = [];
  const input = createReadStream(jsonlPath, { encoding: "utf-8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      try {
        uuids.push({ uuid: (JSON.parse(line) as { uuid?: string }).uuid ?? "" });
      } catch {
        uuids.push({ uuid: "" });
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return uuids;
}

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
export async function findEntryOffsetByUuid(
  jsonlPath: string,
  uuid: string
): Promise<number | null> {
  const input = createReadStream(jsonlPath, { encoding: "utf-8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let offset = 0;
  try {
    for await (const line of rl) {
      offset += Buffer.byteLength(line, "utf8") + 1; // +1 for the newline
      if (!line) continue;
      try {
        if ((JSON.parse(line) as { uuid?: string }).uuid === uuid) return offset;
      } catch {
        // unparseable line — keep scanning
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return null;
}
