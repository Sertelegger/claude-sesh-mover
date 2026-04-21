import { describe, it, expect } from "vitest";

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
        newSessionId: "new-session",
        sourceSessionId: "orig-session",
        sourceMachineId: "peer-id",
        sourceMachineName: "peer-name",
        targetProjectPath: "/Users/a/proj",
        claudeVersion: "2.1.114",
      })
    ).toThrow(/out of range/i);
  });
});
