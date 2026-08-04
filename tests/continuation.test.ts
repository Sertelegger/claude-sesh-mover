import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ORIGINAL = [
  {
    uuid: "entry-1",
    timestamp: "2026-04-10T12:00:00Z",
    sessionId: "orig-session",
    cwd: "/Users/a/proj",
    version: "2.1.114",
    type: "user",
    message: { role: "user", content: "hi" },
  },
  {
    uuid: "entry-2",
    timestamp: "2026-04-10T12:00:05Z",
    sessionId: "orig-session",
    cwd: "/Users/a/proj",
    version: "2.1.114",
    type: "assistant",
    message: { model: "x", id: "m1", content: [{ type: "text", text: "hello" }] },
  },
  {
    uuid: "entry-3",
    timestamp: "2026-04-10T12:01:00Z",
    sessionId: "orig-session",
    cwd: "/Users/a/proj",
    version: "2.1.114",
    type: "user",
    message: { role: "user", content: "continue" },
  },
];

const ORIGINAL_JSONL = ORIGINAL.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("continuation", () => {
  it("buildContinuationJsonl emits header + sliced entries", async () => {
    const { buildContinuationJsonl } = await import("../src/continuation.js");
    const out = buildContinuationJsonl({
      originalJsonl: ORIGINAL_JSONL,
      fromEntryIndex: 2,
      fromEntryUuid: "entry-3",
      newSessionId: "new-session",
      sourceSessionId: "orig-session",
      sourceMachineId: "peer-id",
      sourceMachineName: "peer-name",
      previousLocalSessionId: "local-prev",
      targetProjectPath: "/Users/a/proj",
      claudeVersion: "2.1.114",
    });
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].type).toBe("user");
    expect(lines[0].message.content).toContain("[sesh-mover continuation]");
    expect(lines[0].message.content).toContain("`orig-session`");
    expect(lines[0].message.content).toContain("`peer-name`");
    expect(lines[0].message.content).toContain("`local-prev`");
    expect(lines[0].sessionId).toBe("new-session");
    expect(lines[1].uuid).toBe("entry-3");
  });

  it("header mentions 'not present' when previousLocalSessionId is absent", async () => {
    const { buildContinuationJsonl } = await import("../src/continuation.js");
    const out = buildContinuationJsonl({
      originalJsonl: ORIGINAL_JSONL,
      fromEntryIndex: 1,
      fromEntryUuid: "entry-2",
      newSessionId: "new-session",
      sourceSessionId: "orig-session",
      sourceMachineId: "peer-id",
      sourceMachineName: "peer-name",
      targetProjectPath: "/Users/a/proj",
      claudeVersion: "2.1.114",
    });
    const firstLine = JSON.parse(out.trim().split("\n")[0]);
    expect(firstLine.message.content).toContain("not present on this machine");
  });

  it("throws if fromEntryIndex is out of range", async () => {
    const { buildContinuationJsonl } = await import("../src/continuation.js");
    expect(() =>
      buildContinuationJsonl({
        originalJsonl: ORIGINAL_JSONL,
        fromEntryIndex: 99,
        fromEntryUuid: "entry-1",
        newSessionId: "new-session",
        sourceSessionId: "orig-session",
        sourceMachineId: "peer-id",
        sourceMachineName: "peer-name",
        targetProjectPath: "/Users/a/proj",
        claudeVersion: "2.1.114",
      })
    ).toThrow(/out of range/i);
  });

  it("throws when fromEntryUuid does not match the entry at fromEntryIndex", async () => {
    const { buildContinuationJsonl } = await import("../src/continuation.js");
    expect(() =>
      buildContinuationJsonl({
        originalJsonl: ORIGINAL_JSONL,
        fromEntryIndex: 2,
        fromEntryUuid: "entry-1", // wrong: index 2 is entry-3
        newSessionId: "new-session",
        sourceSessionId: "orig-session",
        sourceMachineId: "peer-id",
        sourceMachineName: "peer-name",
        targetProjectPath: "/Users/a/proj",
        claudeVersion: "2.1.114",
      })
    ).toThrow(/uuid mismatch/i);
  });

  describe("buildContinuationStream", () => {
    const common = {
      fromEntryIndex: 3,
      fromEntryUuid: "u3",
      newSessionId: "cont-id",
      sourceSessionId: "orig-id",
      sourceMachineId: "m1",
      sourceMachineName: "machine-one",
      claudeVersion: "2.1.81",
      targetProjectPath: "/target/path",
    };

    function writeSixEntrySource(dir: string): string {
      const lines = Array.from({ length: 6 }, (_, i) =>
        JSON.stringify({ uuid: `u${i}`, type: "user", message: { role: "user", content: `m${i}` } })
      );
      const src = join(dir, "src.jsonl");
      writeFileSync(src, lines.join("\n") + "\n", "utf-8");
      return src;
    }

    it("output matches buildContinuationJsonl byte-for-byte after the header", async () => {
      const { buildContinuationJsonl, buildContinuationStream } = await import(
        "../src/continuation.js"
      );
      const dir = mkdtempSync(join(tmpdir(), "sesh-cont-"));
      try {
        const lines = Array.from({ length: 6 }, (_, i) =>
          JSON.stringify({ uuid: `u${i}`, type: "user", message: { role: "user", content: `m${i}` } })
        );
        const original = lines.join("\n") + "\n";
        const src = join(dir, "src.jsonl");
        writeFileSync(src, original, "utf-8");
        const outPath = join(dir, "cont.jsonl");

        const { entryCount, integrityHash } = await buildContinuationStream({
          ...common,
          sourceJsonlPath: src,
          outputPath: outPath,
        });
        const stringVersion = buildContinuationJsonl({ ...common, originalJsonl: original });

        expect(entryCount).toBe(4); // header + 3 tail entries
        // Header contains a random uuid + timestamp — compare tails and header SHAPE
        const streamLines = readFileSync(outPath, "utf-8").trim().split("\n");
        const stringLines = stringVersion.trim().split("\n");
        expect(streamLines.slice(1)).toEqual(stringLines.slice(1));
        const streamHeader = JSON.parse(streamLines[0]);
        const stringHeader = JSON.parse(stringLines[0]);
        expect(streamHeader.message.content).toBe(stringHeader.message.content);
        expect(streamHeader.sessionId).toBe("cont-id");
        expect(streamHeader.cwd).toBe("/target/path");
        // Hash covers exactly the written bytes
        const { computeIntegrityHashFromFile } = await import("../src/manifest.js");
        expect(integrityHash).toBe(await computeIntegrityHashFromFile(outPath));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects on uuid mismatch", async () => {
      const { buildContinuationStream } = await import("../src/continuation.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-cont-"));
      try {
        const src = writeSixEntrySource(dir);
        const outPath = join(dir, "cont.jsonl");
        await expect(
          buildContinuationStream({
            ...common,
            fromEntryUuid: "wrong",
            sourceJsonlPath: src,
            outputPath: outPath,
          })
        ).rejects.toThrow(/uuid mismatch/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Pins the error-latch pattern shared with rewriteJsonlStream and
    // copyFileWithHash: an output-stream open failure must reject, not crash
    // the process (unhandled 'error' event) or hang on a missed 'drain'.
    it("rejects (does not crash or hang) when the output stream errors", async () => {
      const { buildContinuationStream } = await import("../src/continuation.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-cont-"));
      try {
        const src = writeSixEntrySource(dir);
        await expect(
          buildContinuationStream({
            ...common,
            sourceJsonlPath: src,
            outputPath: join(dir, "no-such-subdir", "cont.jsonl"),
          })
        ).rejects.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects when fromEntryIndex is out of range", async () => {
      const { buildContinuationStream } = await import("../src/continuation.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-cont-"));
      try {
        const src = writeSixEntrySource(dir);
        const outPath = join(dir, "cont.jsonl");
        await expect(
          buildContinuationStream({
            ...common,
            fromEntryIndex: 99,
            fromEntryUuid: "u0",
            sourceJsonlPath: src,
            outputPath: outPath,
          })
        ).rejects.toThrow(/out of range/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  // Task 6b. The head recorded for a peer is now the last CONVERSATION entry,
  // so the very next line in the live transcript is usually uuid-less
  // bookkeeping — Claude Code writes `last-prompt` / `mode` / `permission-mode`
  // straight after each assistant turn. That makes `fromEntryIndex` land on a
  // uuid-less line, which is the whole incremental-push path end to end:
  // readEntryUuids -> computeIncrementalPlan -> buildContinuationStream ->
  // readDeltaChainInfo -> tryAppendContinuation.
  describe("incremental push over a bookkeeping-interleaved transcript", () => {
    const SID = "orig-session";
    const conv = (uuid: string, parentUuid: string | null) => ({
      uuid,
      parentUuid,
      timestamp: "2026-08-02T10:00:00.000Z",
      sessionId: SID,
      cwd: "/Users/a/proj",
      version: "2.1.114",
      type: "user",
      message: { role: "user", content: `m ${uuid}` },
    });
    const bookkeeping = [
      { type: "last-prompt", lastPrompt: "go", leafUuid: "c2", sessionId: SID },
      { type: "mode", mode: "normal", sessionId: SID },
      { type: "permission-mode", permissionMode: "auto", sessionId: SID },
    ];

    it("slices a delta that starts on bookkeeping and still chains onto the recorded head", async () => {
      const { readEntryUuids } = await import("../src/jsonl.js");
      const { computeIncrementalPlan } = await import("../src/diff.js");
      const { buildContinuationStream } = await import("../src/continuation.js");
      const { readDeltaChainInfo } = await import("../src/hub/append.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-cont-bk-"));
      try {
        // Snapshot at the previous push: c1, c2 (head = c2, the last
        // conversation entry). Then bookkeeping, then new conversation.
        const src = join(dir, `${SID}.jsonl`);
        const all = [
          conv("c1", null),
          conv("c2", "c1"),
          ...bookkeeping,
          conv("c3", "c2"),
          conv("c4", "c3"),
          { type: "mode", mode: "plan", sessionId: SID },
        ];
        writeFileSync(src, all.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

        const session = {
          sessionId: SID,
          projectPath: "/Users/a/proj",
          encodedProjectDir: "-Users-a-proj",
          jsonlPath: src,
          slug: "s",
          createdAt: "2026-08-02T10:00:00.000Z",
          lastActiveAt: "2026-08-02T10:00:00.000Z",
          messageCount: all.length,
          gitBranch: "main",
          entrypoint: "cli",
          hasSubagents: false,
          hasToolResults: false,
          hasFileHistory: false,
        };
        const uuids = await readEntryUuids(src);
        const plan = computeIncrementalPlan(
          [session],
          {
            [SID]: {
              headEntryUuid: "c2",
              messageCount: 2,
              sentAsType: "full",
              sentAsSessionId: SID,
            },
          },
          () => uuids
        );
        expect(plan.warnings).toEqual([]);
        expect(plan.continuation).toHaveLength(1);
        const item = plan.continuation[0];
        // Lossless: the slice starts at the first UNSENT line, bookkeeping included.
        expect(item.fromEntryIndex).toBe(2);

        const out = join(dir, "cont.jsonl");
        await buildContinuationStream({
          sourceJsonlPath: src,
          outputPath: out,
          fromEntryIndex: item.fromEntryIndex,
          fromEntryUuid: item.fromEntryUuid,
          newSessionId: "new-session",
          sourceSessionId: SID,
          sourceMachineId: "peer-id",
          sourceMachineName: "peer-name",
          targetProjectPath: "/Users/a/proj",
          claudeVersion: "2.1.114",
        });

        const written = readFileSync(out, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        expect(written).toHaveLength(7); // header + 6 unsent lines
        expect(written[1].type).toBe("last-prompt"); // bookkeeping carried, not dropped

        // The anchor the append chain guard checks must be the recorded head,
        // even though the delta's first non-header line has no uuid at all.
        const info = await readDeltaChainInfo(out);
        expect(info.headerPresent).toBe(true);
        expect(info.firstEntryParentUuid).toBe("c2");
        expect(info.lastEntryUuid).toBe("c4");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports a transcript whose only new lines are bookkeeping as unchanged", async () => {
      const { readEntryUuids } = await import("../src/jsonl.js");
      const { computeIncrementalPlan } = await import("../src/diff.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-cont-bk-"));
      try {
        const src = join(dir, `${SID}.jsonl`);
        const all = [conv("c1", null), conv("c2", "c1"), ...bookkeeping];
        writeFileSync(src, all.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
        const session = {
          sessionId: SID,
          projectPath: "/Users/a/proj",
          encodedProjectDir: "-Users-a-proj",
          jsonlPath: src,
          slug: "s",
          createdAt: "2026-08-02T10:00:00.000Z",
          lastActiveAt: "2026-08-02T10:00:00.000Z",
          messageCount: all.length,
          gitBranch: "main",
          entrypoint: "cli",
          hasSubagents: false,
          hasToolResults: false,
          hasFileHistory: false,
        };
        const uuids = await readEntryUuids(src);
        const plan = computeIncrementalPlan(
          [session],
          {
            [SID]: { headEntryUuid: "c2", messageCount: 2, sentAsType: "full", sentAsSessionId: SID },
          },
          () => uuids
        );
        // A delta of pure bookkeeping has no chain entry: it could never be
        // appended, and would land as a content-free fragment session.
        expect(plan.continuation).toEqual([]);
        expect(plan.unchanged.map((s) => s.sessionId)).toEqual([SID]);
        expect(plan.full).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
