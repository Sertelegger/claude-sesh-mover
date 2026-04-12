import { describe, it, expect } from "vitest";

describe("rewriter", () => {
  describe("buildPathMappings", () => {
    it("builds WSL-to-Windows mappings", async () => {
      const { buildPathMappings } = await import("../src/rewriter.js");
      const mappings = buildPathMappings(
        "wsl2",
        "win32",
        "/home/sascha/Projects/foo",
        "C:\\Users\\sascha\\Projects\\foo",
        "/home/sascha/.claude",
        "C:\\Users\\sascha\\.claude",
        "sascha",
        "sascha"
      );
      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.from.includes("/home/sascha"))).toBe(true);
    });
  });

  describe("rewriteEntry", () => {
    it("rewrites cwd field", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "1",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "user" as const,
        message: { role: "user" as const, content: "hello" },
      };
      const result = rewriteEntry(entry, mappings);
      expect(result.cwd).toBe("/Users/new/project");
    });

    it("rewrites tool_result content paths", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "2",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "user" as const,
        message: {
          role: "user" as const,
          content: [
            {
              tool_use_id: "toolu_1",
              type: "tool_result",
              content: "contents of /Users/old/project/src/index.ts",
            },
          ],
        },
        toolUseResult: {
          stdout: "/Users/old/project/src/index.ts: file",
          stderr: "",
        },
      };
      const result = rewriteEntry(entry, mappings);
      expect(result.toolUseResult?.stdout).toContain("/Users/new/project");
      const content = (result.message as any).content[0].content;
      expect(content).toContain("/Users/new/project");
    });

    it("does NOT rewrite user message text", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "3",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "user" as const,
        message: {
          role: "user" as const,
          content: "please read /Users/old/project/src/index.ts",
        },
      };
      const result = rewriteEntry(entry, mappings);
      expect((result.message as any).content).toBe(
        "please read /Users/old/project/src/index.ts"
      );
    });

    it("does NOT rewrite assistant thinking text", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "4",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "assistant" as const,
        message: {
          model: "claude-opus-4-6",
          id: "msg_1",
          content: [
            { type: "thinking", thinking: "Looking at /Users/old/project/src" },
            { type: "text", text: "I found the file." },
          ],
        },
      };
      const result = rewriteEntry(entry, mappings);
      const thinking = (result.message as any).content[0].thinking;
      expect(thinking).toContain("/Users/old/project");
    });

    it("rewrites file-history-snapshot backup keys", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "5",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "file-history-snapshot" as const,
        messageId: "msg-1",
        snapshot: {
          messageId: "msg-1",
          trackedFileBackups: {
            "/Users/old/project/src/index.ts": {
              backupFileName: "abc@v1",
              version: 1,
              backupTime: "2026-04-11T00:00:00Z",
            },
          },
          timestamp: "2026-04-11T00:00:00Z",
        },
      };
      const result = rewriteEntry(entry, mappings);
      const keys = Object.keys((result as any).snapshot.trackedFileBackups);
      expect(keys[0]).toBe("/Users/new/project/src/index.ts");
    });

    it("rewrites sessionId when newSessionId provided", async () => {
      const { rewriteEntry, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const entry = {
        uuid: "6",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "old-session-id",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "user" as const,
        message: { role: "user" as const, content: "hello" },
      };
      const result = rewriteEntry(entry, mappings, "new-session-id");
      expect(result.sessionId).toBe("new-session-id");
    });
  });

  describe("rewriteJsonl", () => {
    it("rewrites all entries in a JSONL string", async () => {
      const { rewriteJsonl, buildPathMappings } = await import(
        "../src/rewriter.js"
      );
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/Users/old/project",
        "/Users/new/project",
        "/Users/old/.claude",
        "/Users/new/.claude",
        "old",
        "new"
      );
      const jsonl = [
        JSON.stringify({
          uuid: "1",
          timestamp: "2026-04-11T00:00:00Z",
          sessionId: "test",
          cwd: "/Users/old/project",
          version: "2.1.81",
          type: "user",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          uuid: "2",
          timestamp: "2026-04-11T00:01:00Z",
          sessionId: "test",
          cwd: "/Users/old/project",
          version: "2.1.81",
          type: "assistant",
          message: { model: "test", id: "1", content: [] },
        }),
      ].join("\n");

      const { rewritten, report } = rewriteJsonl(
        jsonl,
        mappings,
        "new-session"
      );
      const lines = rewritten.trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first.cwd).toBe("/Users/new/project");
      expect(first.sessionId).toBe("new-session");
      expect(report.entriesRewritten).toBeGreaterThan(0);
    });
  });
});
