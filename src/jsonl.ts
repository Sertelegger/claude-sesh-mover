import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const CHUNK = 4096;
// A single JSONL line larger than this is treated as unreadable (return null)
// rather than ballooning memory — same fallback the callers already handle.
const MAX_LINE_BYTES = 1024 * 1024;

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

export function readLastEntryUuid(path: string): string | null {
  const line = readLastJsonlLine(path);
  if (!line) return null;
  try {
    return (JSON.parse(line) as { uuid?: string }).uuid ?? null;
  } catch {
    return null;
  }
}
