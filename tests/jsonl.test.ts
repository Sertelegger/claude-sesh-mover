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
    const oversized = "x".repeat(1024 * 1024 + 100);
    const p = write("huge-first.jsonl", oversized + '\n{"uuid":"u2"}\n');
    expect(readFirstJsonlLine(p)).toBeNull();
  });

  it("readLastJsonlLine returns null when the last line exceeds 1MB", async () => {
    const { readLastJsonlLine } = await import("../src/jsonl.js");
    const oversized = "y".repeat(1024 * 1024 + 100);
    const p = write("huge-last.jsonl", '{"uuid":"u1"}\n' + oversized + "\n");
    expect(readLastJsonlLine(p)).toBeNull();
  });

  it("readLastJsonlLine returns null for missing and empty files", async () => {
    const { readLastJsonlLine } = await import("../src/jsonl.js");
    expect(readLastJsonlLine(join(tempDir, "missing.jsonl"))).toBeNull();
    const p = write("empty2.jsonl", "");
    expect(readLastJsonlLine(p)).toBeNull();
  });

  // Bookkeeping shapes Claude Code appends around conversation entries. Keys
  // are taken verbatim from live transcripts under ~/.claude/projects (measured
  // 2026-08-04): none carries a `uuid`, and `pr-link` / `queue-operation` /
  // `file-history-delta` DO carry a `timestamp` that is later than the
  // conversation entry beneath them.
  function bookkeeping(sessionId: string): unknown[] {
    return [
      { type: "last-prompt", lastPrompt: "ship it", leafUuid: "c2", sessionId },
      { type: "mode", mode: "normal", sessionId },
      { type: "permission-mode", permissionMode: "auto", sessionId },
      { type: "ai-title", aiTitle: "Fix head derivation", sessionId },
      { type: "agent-name", agentName: "Fix head derivation", sessionId },
      {
        type: "pr-link",
        sessionId,
        prNumber: 9,
        prUrl: "https://example.test/9",
        prRepository: "o/r",
        timestamp: "2026-08-02T23:59:59.000Z",
      },
      {
        type: "file-history-snapshot",
        messageId: "c2",
        snapshot: { files: {} },
        isSnapshotUpdate: false,
        sessionId,
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-08-03T00:00:00.000Z",
        sessionId,
        content: "next",
      },
    ];
  }

  const CONV_1 = {
    uuid: "c1",
    parentUuid: null,
    type: "user",
    sessionId: "s1",
    cwd: "/Users/x/proj",
    gitBranch: "main",
    entrypoint: "cli",
    slug: "the-slug",
    timestamp: "2026-08-02T10:00:00.000Z",
    message: { role: "user", content: "hello" },
  };
  const CONV_2 = {
    uuid: "c2",
    parentUuid: "c1",
    type: "assistant",
    sessionId: "s1",
    cwd: "/Users/x/proj",
    timestamp: "2026-08-02T10:00:05.000Z",
    message: { role: "assistant", content: "hi" },
  };

  function jsonl(objs: unknown[], trailing = "\n"): string {
    return objs.map((o) => JSON.stringify(o)).join("\n") + trailing;
  }

  describe("readLastConversationEntry", () => {
    it("skips a stack of uuid-less bookkeeping and returns the conversation entry beneath", async () => {
      const { readLastConversationEntry, readLastEntryUuid } = await import("../src/jsonl.js");
      const p = write("bk-tail.jsonl", jsonl([CONV_1, CONV_2, ...bookkeeping("s1")]));
      const e = readLastConversationEntry(p);
      expect(e?.uuid).toBe("c2");
      // NOT the pr-link / queue-operation timestamps sitting above it.
      expect(e?.timestamp).toBe("2026-08-02T10:00:05.000Z");
      expect(readLastEntryUuid(p)).toBe("c2");
    });

    it("returns the last line when it IS a conversation entry", async () => {
      const { readLastConversationEntry } = await import("../src/jsonl.js");
      const p = write("conv-tail.jsonl", jsonl([CONV_1, ...bookkeeping("s1"), CONV_2]));
      expect(readLastConversationEntry(p)?.uuid).toBe("c2");
    });

    it("returns null when the transcript holds no conversation entry at all", async () => {
      const { readLastConversationEntry, readLastEntryUuid } = await import("../src/jsonl.js");
      const p = write("bk-only.jsonl", jsonl(bookkeeping("s1")));
      expect(readLastConversationEntry(p)).toBeNull();
      expect(readLastEntryUuid(p)).toBeNull();
    });

    it("ignores trailing and interior blank lines", async () => {
      const { readLastConversationEntry } = await import("../src/jsonl.js");
      const p = write(
        "blank.jsonl",
        JSON.stringify(CONV_2) + "\n\n" + JSON.stringify(bookkeeping("s1")[0]) + "\n\n\n"
      );
      expect(readLastConversationEntry(p)?.uuid).toBe("c2");
    });

    it("rejects an empty-string uuid (the index's 'unknown head' sentinel)", async () => {
      const { readLastConversationEntry } = await import("../src/jsonl.js");
      const p = write("emptyuuid.jsonl", jsonl([CONV_1, { ...CONV_2, uuid: "" }]));
      expect(readLastConversationEntry(p)?.uuid).toBe("c1");
    });

    it("returns null rather than a stale head when a line past the head is unparseable", async () => {
      const { readLastConversationEntry } = await import("../src/jsonl.js");
      const p = write("torn.jsonl", jsonl([CONV_1, CONV_2]) + '{"type":"mode","ses\n');
      expect(readLastConversationEntry(p)).toBeNull();
    });

    it("returns null rather than a stale head when a line past the head exceeds 1MB", async () => {
      const { readLastConversationEntry } = await import("../src/jsonl.js");
      const huge = JSON.stringify({
        type: "file-history-snapshot",
        messageId: "c2",
        snapshot: "z".repeat(1024 * 1024 + 100),
      });
      const p = write("hugebk.jsonl", jsonl([CONV_1, CONV_2]) + huge + "\n");
      expect(readLastConversationEntry(p)).toBeNull();
    });

    it("finds a head far beyond the read-chunk window", async () => {
      const { readLastConversationEntry } = await import("../src/jsonl.js");
      const pad = { type: "file-history-snapshot", messageId: "c2", snapshot: "p".repeat(60_000) };
      const p = write("farhead.jsonl", jsonl([CONV_1, CONV_2, pad, pad, pad, ...bookkeeping("s1")]));
      expect(readLastConversationEntry(p)?.uuid).toBe("c2");
    });

    it("gives up (null) once the bounded scan passes MAX_ENTRY_SCAN_BYTES", async () => {
      const { readLastConversationEntry, MAX_ENTRY_SCAN_BYTES } = await import("../src/jsonl.js");
      const pad = JSON.stringify({
        type: "file-history-snapshot",
        messageId: "c2",
        snapshot: "p".repeat(100_000),
      });
      const filler: string[] = [];
      let bytes = 0;
      while (bytes < MAX_ENTRY_SCAN_BYTES + 200_000) {
        filler.push(pad);
        bytes += pad.length + 1;
      }
      const p = write("capped.jsonl", jsonl([CONV_1, CONV_2]) + filler.join("\n") + "\n");
      expect(readLastConversationEntry(p)).toBeNull();
    });

    it("returns null for missing and empty files", async () => {
      const { readLastConversationEntry } = await import("../src/jsonl.js");
      expect(readLastConversationEntry(join(tempDir, "nope.jsonl"))).toBeNull();
      expect(readLastConversationEntry(write("empty3.jsonl", ""))).toBeNull();
    });

    // The backward scan's `pos === 0 && carry.length > 0` tail: a file whose
    // FIRST line has no preceding newline is never closed by the `lastIndexOf`
    // loop, so it is only classified once the scan reaches offset 0. The
    // forward reader's equivalent case is covered below; this is its mirror.
    it("returns a single unterminated conversation line", async () => {
      const { readLastConversationEntry, readLastEntryUuid } = await import("../src/jsonl.js");
      const p = write("nonl-last.jsonl", JSON.stringify(CONV_1));
      expect(readLastConversationEntry(p)?.uuid).toBe("c1");
      expect(readLastEntryUuid(p)).toBe("c1");
    });

    // Same tail, taken the other way: reaching offset 0 must not resurrect an
    // unterminated FIRST line that is bookkeeping, and must not report the
    // conversation entry above it either (nothing is above it).
    it("returns null for a single unterminated bookkeeping line", async () => {
      const { readLastConversationEntry } = await import("../src/jsonl.js");
      const p = write("nonl-bk.jsonl", JSON.stringify(bookkeeping("s1")[0]));
      expect(readLastConversationEntry(p)).toBeNull();
    });
  });

  describe("readFirstConversationEntry", () => {
    it("skips leading uuid-less bookkeeping and returns the first conversation entry", async () => {
      const { readFirstConversationEntry } = await import("../src/jsonl.js");
      const p = write("bk-head.jsonl", jsonl([...bookkeeping("s1"), CONV_1, CONV_2]));
      const e = readFirstConversationEntry(p);
      expect(e?.uuid).toBe("c1");
      expect(e?.cwd).toBe("/Users/x/proj");
      expect(e?.timestamp).toBe("2026-08-02T10:00:00.000Z");
    });

    it("returns null when the transcript holds no conversation entry", async () => {
      const { readFirstConversationEntry } = await import("../src/jsonl.js");
      expect(readFirstConversationEntry(write("bk-only2.jsonl", jsonl(bookkeeping("s1"))))).toBeNull();
    });

    it("returns a single unterminated conversation line", async () => {
      const { readFirstConversationEntry } = await import("../src/jsonl.js");
      expect(readFirstConversationEntry(write("nonl2.jsonl", JSON.stringify(CONV_1)))?.uuid).toBe("c1");
    });

    it("returns null rather than a later entry when a leading line is unparseable", async () => {
      const { readFirstConversationEntry } = await import("../src/jsonl.js");
      const p = write("torn-head.jsonl", '{"type":"mode","ses\n' + jsonl([CONV_1]));
      expect(readFirstConversationEntry(p)).toBeNull();
    });

    it("finds a first conversation entry beyond the read-chunk window", async () => {
      const { readFirstConversationEntry } = await import("../src/jsonl.js");
      const pad = { type: "file-history-snapshot", messageId: "m", snapshot: "p".repeat(60_000) };
      const p = write("far-head.jsonl", jsonl([pad, pad, pad, CONV_1]));
      expect(readFirstConversationEntry(p)?.uuid).toBe("c1");
    });
  });

  describe("isConversationEntry", () => {
    it("keys off a non-empty string uuid, not off an entry-type list", async () => {
      const { isConversationEntry } = await import("../src/jsonl.js");
      expect(isConversationEntry({ uuid: "x", type: "user" })).toBe(true);
      // A type nobody has seen yet still counts, as long as it is in the chain.
      expect(isConversationEntry({ uuid: "x", type: "some-future-type" })).toBe(true);
      expect(isConversationEntry({ type: "mode", mode: "normal" })).toBe(false);
      expect(isConversationEntry({ uuid: "" })).toBe(false);
      expect(isConversationEntry({ uuid: 42 })).toBe(false);
      expect(isConversationEntry(null)).toBe(false);
    });
  });

  describe("readEntryUuids", () => {
    it("returns one {uuid} per line, empty string for unparseable lines", async () => {
      const { readEntryUuids } = await import("../src/jsonl.js");
      const p = write("uuids.jsonl", '{"uuid":"a"}\n{bad\n{"uuid":"c"}\n');
      expect(await readEntryUuids(p)).toEqual([{ uuid: "a" }, { uuid: "" }, { uuid: "c" }]);
    });

    it("skips empty lines", async () => {
      const { readEntryUuids } = await import("../src/jsonl.js");
      const p = write("uuids-blank.jsonl", '{"uuid":"a"}\n\n{"uuid":"b"}\n');
      expect(await readEntryUuids(p)).toEqual([{ uuid: "a" }, { uuid: "b" }]);
    });
  });

  describe("findEntryOffsetByUuid", () => {
    it("returns the byte offset just past the matching line", async () => {
      const { findEntryOffsetByUuid } = await import("../src/jsonl.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-offset-"));
      try {
        const file = join(dir, "s.jsonl");
        const l1 = JSON.stringify({ uuid: "a", type: "user" });
        const l2 = JSON.stringify({ uuid: "b", type: "user" });
        const l3 = JSON.stringify({ uuid: "c", type: "user" });
        writeFileSync(file, `${l1}\n${l2}\n${l3}\n`, "utf-8");
        const expected = Buffer.byteLength(`${l1}\n${l2}\n`, "utf8");
        expect(await findEntryOffsetByUuid(file, "b")).toBe(expected);
        expect(await findEntryOffsetByUuid(file, "a")).toBe(Buffer.byteLength(`${l1}\n`, "utf8"));
        expect(await findEntryOffsetByUuid(file, "c")).toBe(
          Buffer.byteLength(`${l1}\n${l2}\n${l3}\n`, "utf8")
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns null when the uuid is absent or a line is unparseable", async () => {
      const { findEntryOffsetByUuid } = await import("../src/jsonl.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-offset-"));
      try {
        const file = join(dir, "s.jsonl");
        writeFileSync(file, `{"uuid":"a"}\n{bad json\n{"uuid":"c"}\n`, "utf-8");
        expect(await findEntryOffsetByUuid(file, "zzz")).toBeNull();
        expect(await findEntryOffsetByUuid(file, "c")).toBeGreaterThan(0); // unparseable line skipped, scan continues
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("handles multi-byte content correctly (byte offsets, not char offsets)", async () => {
      const { findEntryOffsetByUuid } = await import("../src/jsonl.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-offset-"));
      try {
        const file = join(dir, "s.jsonl");
        const l1 = JSON.stringify({ uuid: "a", text: "héllo — ünicode" });
        const l2 = JSON.stringify({ uuid: "b" });
        writeFileSync(file, `${l1}\n${l2}\n`, "utf-8");
        expect(await findEntryOffsetByUuid(file, "a")).toBe(Buffer.byteLength(`${l1}\n`, "utf8"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
