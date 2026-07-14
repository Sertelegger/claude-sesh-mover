import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("jsonl", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-jsonl-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(tempDir, name);
    writeFileSync(p, content);
    return p;
  }

  it("readFirstJsonlLine returns the first line", async () => {
    const { readFirstJsonlLine } = await import("../src/jsonl.js");
    const p = write("a.jsonl", '{"uuid":"u1"}\n{"uuid":"u2"}\n');
    expect(readFirstJsonlLine(p)).toBe('{"uuid":"u1"}');
  });

  it("readFirstJsonlLine handles a first line larger than 4KB", async () => {
    const { readFirstJsonlLine } = await import("../src/jsonl.js");
    const big = JSON.stringify({ uuid: "u1", pad: "x".repeat(10_000) });
    const p = write("big.jsonl", big + '\n{"uuid":"u2"}\n');
    expect(readFirstJsonlLine(p)).toBe(big);
  });

  it("readFirstJsonlLine returns whole content when file has no newline", async () => {
    const { readFirstJsonlLine } = await import("../src/jsonl.js");
    const p = write("nonl.jsonl", '{"uuid":"only"}');
    expect(readFirstJsonlLine(p)).toBe('{"uuid":"only"}');
  });

  it("readFirstJsonlLine returns null for missing and empty files", async () => {
    const { readFirstJsonlLine } = await import("../src/jsonl.js");
    expect(readFirstJsonlLine(join(tempDir, "missing.jsonl"))).toBeNull();
    const p = write("empty.jsonl", "");
    expect(readFirstJsonlLine(p)).toBeNull();
  });

  it("readLastJsonlLine returns the last line, ignoring trailing newlines", async () => {
    const { readLastJsonlLine } = await import("../src/jsonl.js");
    const p = write("b.jsonl", '{"uuid":"u1"}\n{"uuid":"u2"}\n\n');
    expect(readLastJsonlLine(p)).toBe('{"uuid":"u2"}');
  });

  it("readLastJsonlLine finds a last line beyond the initial 4KB window", async () => {
    const { readLastJsonlLine } = await import("../src/jsonl.js");
    const last = JSON.stringify({ uuid: "last", pad: "y".repeat(10_000) });
    const p = write("bigtail.jsonl", '{"uuid":"u1"}\n' + last + "\n");
    expect(readLastJsonlLine(p)).toBe(last);
  });

  it("readLastJsonlLine returns the only line of a single-line file", async () => {
    const { readLastJsonlLine } = await import("../src/jsonl.js");
    const p = write("single.jsonl", '{"uuid":"solo"}\n');
    expect(readLastJsonlLine(p)).toBe('{"uuid":"solo"}');
  });

  it("countJsonlLines counts non-empty lines regardless of trailing newline", async () => {
    const { countJsonlLines } = await import("../src/jsonl.js");
    expect(countJsonlLines(write("c1.jsonl", "a\nb\nc\n"))).toBe(3);
    expect(countJsonlLines(write("c2.jsonl", "a\nb\nc"))).toBe(3);
    expect(countJsonlLines(write("c3.jsonl", "a\n\nb\n"))).toBe(2);
    expect(countJsonlLines(write("c4.jsonl", ""))).toBe(0);
    expect(countJsonlLines(join(tempDir, "missing.jsonl"))).toBe(0);
  });

  it("readLastEntryUuid parses the uuid of the final entry", async () => {
    const { readLastEntryUuid } = await import("../src/jsonl.js");
    const p = write("d.jsonl", '{"uuid":"u1"}\n{"uuid":"u2"}\n');
    expect(readLastEntryUuid(p)).toBe("u2");
    const bad = write("bad.jsonl", "not json\n");
    expect(readLastEntryUuid(bad)).toBeNull();
  });

  it("readFirstJsonlLine returns null when the first line exceeds 1MB", async () => {
    const { readFirstJsonlLine } = await import("../src/jsonl.js");
    const oversized = "x".repeat(1024 * 1024 + 10_000);
    const p = write("huge-first.jsonl", oversized + '\n{"uuid":"u2"}\n');
    expect(readFirstJsonlLine(p)).toBeNull();
  });

  it("readLastJsonlLine returns null when the last line exceeds 1MB", async () => {
    const { readLastJsonlLine } = await import("../src/jsonl.js");
    const oversized = "y".repeat(1024 * 1024 + 10_000);
    const p = write("huge-last.jsonl", '{"uuid":"u1"}\n' + oversized + "\n");
    expect(readLastJsonlLine(p)).toBeNull();
  });

  it("readLastJsonlLine returns null for missing and empty files", async () => {
    const { readLastJsonlLine } = await import("../src/jsonl.js");
    expect(readLastJsonlLine(join(tempDir, "missing.jsonl"))).toBeNull();
    const p = write("empty2.jsonl", "");
    expect(readLastJsonlLine(p)).toBeNull();
  });
});
