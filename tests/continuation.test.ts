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
});
