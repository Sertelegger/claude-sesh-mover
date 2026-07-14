import { describe, it, expect } from "vitest";

function wslToWinCtx() {
  return (async () => {
    const { buildPathMappings } = await import("../src/rewriter.js");
    const mappings = buildPathMappings(
      "wsl2", "win32",
      "/mnt/e/GitHub/proj", "E:\\GitHub\\proj",
      "/home/sascha/.claude", "C:\\Users\\sascha\\.claude",
      "sascha", "sascha"
    );
    return {
      mappings,
      sourcePlatform: "wsl2" as const,
      targetPlatform: "win32" as const,
      sourceUser: "sascha",
      targetUser: "sascha",
    };
  })();
}

function winToWslCtx() {
  return (async () => {
    const { buildPathMappings } = await import("../src/rewriter.js");
    const mappings = buildPathMappings(
      "win32", "wsl2",
      "E:\\GitHub\\proj", "/mnt/e/GitHub/proj",
      "C:\\Users\\sascha\\.claude", "/home/sascha/.claude",
      "sascha", "sascha"
    );
    return {
      mappings,
      sourcePlatform: "win32" as const,
      targetPlatform: "wsl2" as const,
      sourceUser: "sascha",
      targetUser: "sascha",
    };
  })();
}

describe("rewriter", () => {
  describe("two-stage rewriteString", () => {
    it("normalizes separators in the tail after an exact mapping fires", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      expect(rewriteString("/mnt/e/GitHub/proj/src/index.ts", ctx)).toBe(
        "E:\\GitHub\\proj\\src\\index.ts"
      );
    });

    it("translates unmapped /mnt paths via token translation", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      expect(rewriteString("read /mnt/e/other/repo/file.ts now", ctx)).toBe(
        "read E:\\other\\repo\\file.ts now"
      );
    });

    it("translates /tmp paths via token translation", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      expect(rewriteString("see /tmp/scratch.txt", ctx)).toBe(
        "see C:\\Users\\sascha\\AppData\\Local\\Temp\\scratch.txt"
      );
    });

    it("stops path tokens at line-reference colons", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      expect(rewriteString("error at /mnt/e/GitHub/proj/src/a.ts:12:5", ctx)).toBe(
        "error at E:\\GitHub\\proj\\src\\a.ts:12:5"
      );
    });

    it("skips token translation entirely for same-family transfers", async () => {
      const { rewriteString, buildPathMappings } = await import("../src/rewriter.js");
      const mappings = buildPathMappings(
        "linux", "linux",
        "/home/a/proj", "/home/a/proj2",
        "/home/a/.claude", "/home/a/.claude",
        "a", "a"
      );
      const ctx = {
        mappings,
        sourcePlatform: "linux" as const,
        targetPlatform: "linux" as const,
        sourceUser: "a",
        targetUser: "a",
      };
      // Generic system path untouched; project path still mapped.
      expect(rewriteString("/usr/local/bin/tool ran in /home/a/proj/src", ctx)).toBe(
        "/usr/local/bin/tool ran in /home/a/proj2/src"
      );
    });

    it("rewrites array-form tool_result text blocks", async () => {
      const { rewriteEntry } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      const entry = {
        uuid: "a1",
        timestamp: "2026-07-13T00:00:00Z",
        sessionId: "s",
        cwd: "/mnt/e/GitHub/proj",
        version: "2.1.114",
        type: "user" as const,
        message: {
          role: "user" as const,
          content: [
            {
              tool_use_id: "t1",
              type: "tool_result",
              content: [{ type: "text", text: "path /mnt/e/GitHub/proj/a.ts" }],
            },
          ],
        },
      };
      const result = rewriteEntry(entry, ctx);
      const block = (result.message as any).content[0].content[0];
      expect(block.text).toBe("path E:\\GitHub\\proj\\a.ts");
    });
  });

  describe("rewriteWholePath", () => {
    it("normalizes separators AND preserves spaces in the tail after an exact mapping fires (win32 -> linux)", async () => {
      const { rewriteWholePath, buildPathMappings } = await import("../src/rewriter.js");
      const mappings = buildPathMappings(
        "win32", "linux",
        "E:\\GitHub\\proj", "/mnt/e/GitHub/proj",
        "C:\\Users\\sascha\\.claude", "/home/sascha/.claude",
        "sascha", "sascha"
      );
      const ctx = {
        mappings,
        sourcePlatform: "win32" as const,
        targetPlatform: "linux" as const,
        sourceUser: "sascha",
        targetUser: "sascha",
      };
      expect(
        rewriteWholePath("E:\\GitHub\\proj\\sub dir\\nested", ctx)
      ).toBe("/mnt/e/GitHub/proj/sub dir/nested");
    });

    it("falls back to translatePath when no project mapping matches (darwin -> win32)", async () => {
      const { rewriteWholePath, buildPathMappings } = await import("../src/rewriter.js");
      const mappings = buildPathMappings(
        "darwin", "win32",
        "/Users/sascha/Projects/other", "C:\\Users\\sascha\\Projects\\other",
        "/Users/sascha/.claude", "C:\\Users\\sascha\\.claude",
        "sascha", "sascha"
      );
      const ctx = {
        mappings,
        sourcePlatform: "darwin" as const,
        targetPlatform: "win32" as const,
        sourceUser: "sascha",
        targetUser: "sascha",
      };
      expect(
        rewriteWholePath("/Users/sascha/My Documents/notes", ctx)
      ).toBe("C:\\Users\\sascha\\My Documents\\notes");
    });

    it("preserves the tail verbatim (no normalization) for same-family transfers", async () => {
      const { rewriteWholePath, buildPathMappings } = await import("../src/rewriter.js");
      const mappings = buildPathMappings(
        "linux", "linux",
        "/home/a/proj", "/home/a/proj2",
        "/home/a/.claude", "/home/a/.claude",
        "a", "a"
      );
      const ctx = {
        mappings,
        sourcePlatform: "linux" as const,
        targetPlatform: "linux" as const,
        sourceUser: "a",
        targetUser: "a",
      };
      expect(
        rewriteWholePath("/home/a/proj/sub dir/nested\\odd", ctx)
      ).toBe("/home/a/proj2/sub dir/nested\\odd");
    });
  });

  describe("rewriteEntry uses rewriteWholePath for cwd and trackedFileBackups keys", () => {
    it("rewrites a cwd field with spaces in the tail through the full translation path", async () => {
      const { rewriteEntry, buildPathMappings } = await import("../src/rewriter.js");
      const mappings = buildPathMappings(
        "win32", "linux",
        "E:\\GitHub\\proj", "/mnt/e/GitHub/proj",
        "C:\\Users\\sascha\\.claude", "/home/sascha/.claude",
        "sascha", "sascha"
      );
      const ctx = {
        mappings,
        sourcePlatform: "win32" as const,
        targetPlatform: "linux" as const,
        sourceUser: "sascha",
        targetUser: "sascha",
      };
      const entry = {
        uuid: "1",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "E:\\GitHub\\proj\\sub dir\\nested",
        version: "2.1.81",
        type: "user" as const,
        message: { role: "user" as const, content: "hello" },
      };
      const result = rewriteEntry(entry, ctx);
      expect(result.cwd).toBe("/mnt/e/GitHub/proj/sub dir/nested");
    });

    it("rewrites a file-history-snapshot backup key with a space fully", async () => {
      const { rewriteEntry, buildPathMappings } = await import("../src/rewriter.js");
      const mappings = buildPathMappings(
        "win32", "linux",
        "E:\\GitHub\\proj", "/mnt/e/GitHub/proj",
        "C:\\Users\\sascha\\.claude", "/home/sascha/.claude",
        "sascha", "sascha"
      );
      const ctx = {
        mappings,
        sourcePlatform: "win32" as const,
        targetPlatform: "linux" as const,
        sourceUser: "sascha",
        targetUser: "sascha",
      };
      const entry = {
        uuid: "2",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "E:\\GitHub\\proj",
        version: "2.1.81",
        type: "file-history-snapshot" as const,
        messageId: "msg-1",
        snapshot: {
          messageId: "msg-1",
          trackedFileBackups: {
            "E:\\GitHub\\proj\\sub dir\\file.ts": {
              backupFileName: "abc@v1",
              version: 1,
              backupTime: "2026-04-11T00:00:00Z",
            },
          },
          timestamp: "2026-04-11T00:00:00Z",
        },
      };
      const result = rewriteEntry(entry, ctx);
      const keys = Object.keys((result as any).snapshot.trackedFileBackups);
      expect(keys[0]).toBe("/mnt/e/GitHub/proj/sub dir/file.ts");
    });
  });

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
      const ctx = {
        mappings,
        sourcePlatform: "darwin" as const,
        targetPlatform: "darwin" as const,
        sourceUser: "old",
        targetUser: "new",
      };
      const entry = {
        uuid: "1",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "test",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "user" as const,
        message: { role: "user" as const, content: "hello" },
      };
      const result = rewriteEntry(entry, ctx);
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
      const ctx = {
        mappings,
        sourcePlatform: "darwin" as const,
        targetPlatform: "darwin" as const,
        sourceUser: "old",
        targetUser: "new",
      };
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
      const result = rewriteEntry(entry, ctx);
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
      const ctx = {
        mappings,
        sourcePlatform: "darwin" as const,
        targetPlatform: "darwin" as const,
        sourceUser: "old",
        targetUser: "new",
      };
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
      const result = rewriteEntry(entry, ctx);
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
      const ctx = {
        mappings,
        sourcePlatform: "darwin" as const,
        targetPlatform: "darwin" as const,
        sourceUser: "old",
        targetUser: "new",
      };
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
      const result = rewriteEntry(entry, ctx);
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
      const ctx = {
        mappings,
        sourcePlatform: "darwin" as const,
        targetPlatform: "darwin" as const,
        sourceUser: "old",
        targetUser: "new",
      };
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
      const result = rewriteEntry(entry, ctx);
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
      const ctx = {
        mappings,
        sourcePlatform: "darwin" as const,
        targetPlatform: "darwin" as const,
        sourceUser: "old",
        targetUser: "new",
      };
      const entry = {
        uuid: "6",
        timestamp: "2026-04-11T00:00:00Z",
        sessionId: "old-session-id",
        cwd: "/Users/old/project",
        version: "2.1.81",
        type: "user" as const,
        message: { role: "user" as const, content: "hello" },
      };
      const result = rewriteEntry(entry, ctx, "new-session-id");
      expect(result.sessionId).toBe("new-session-id");
    });
  });

  describe("buildPathMappings ordering", () => {
    it("handles overlapping path prefixes correctly", async () => {
      const { buildPathMappings } = await import("../src/rewriter.js");
      const mappings = buildPathMappings(
        "darwin",
        "darwin",
        "/home/user/project",
        "/new/project",
        "/home/user/.claude",
        "/new/.claude",
        "user",
        "user"
      );
      // Config dir mapping should fire before home dir mapping
      // (This test verifies longest-first ordering)
      expect(mappings[0].from.length).toBeGreaterThanOrEqual(
        mappings[mappings.length - 1].from.length
      );
    });
  });

  describe("stage-1 path-component boundary", () => {
    function sameFamilyCtx(from: string, to: string) {
      return {
        mappings: [{ from, to, description: "" }],
        sourcePlatform: "linux" as const,
        targetPlatform: "linux" as const,
        sourceUser: "me",
        targetUser: "me",
      };
    }

    it("does not rewrite a sibling path sharing the mapping prefix (free text)", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = sameFamilyCtx("/home/me/app", "/home/me/app-new");
      // The mapped path IS rewritten…
      expect(rewriteString("cd /home/me/app/src", ctx)).toBe("cd /home/me/app-new/src");
      // …but a sibling sharing the prefix is left alone.
      expect(rewriteString("cd /home/me/app-backup/x", ctx)).toBe("cd /home/me/app-backup/x");
      expect(rewriteString("/home/me/app", ctx)).toBe("/home/me/app-new");
    });

    it("does not rewrite a sibling whole-path sharing the prefix", async () => {
      const { rewriteWholePath } = await import("../src/rewriter.js");
      const ctx = sameFamilyCtx("/home/me/app", "/home/me/app-new");
      expect(rewriteWholePath("/home/me/appstore", ctx)).toBe("/home/me/appstore");
      expect(rewriteWholePath("/home/me/app", ctx)).toBe("/home/me/app-new");
      expect(rewriteWholePath("/home/me/app/src", ctx)).toBe("/home/me/app-new/src");
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
      const ctx = {
        mappings,
        sourcePlatform: "darwin" as const,
        targetPlatform: "darwin" as const,
        sourceUser: "old",
        targetUser: "new",
      };
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
        ctx,
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

  describe("URL guard (#8): tokens preceded by / are not translated", () => {
    it("leaves http URLs with unix-root hosts untouched", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      expect(rewriteString("fetch http://mnt/e/foo now", ctx)).toBe(
        "fetch http://mnt/e/foo now"
      );
      expect(rewriteString("see http://tmp/abc", ctx)).toBe("see http://tmp/abc");
    });

    it("leaves protocol-relative //root paths untouched", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      expect(rewriteString("src=//tmp/abc", ctx)).toBe("src=//tmp/abc");
    });

    it("leaves file:// URLs untouched", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      expect(rewriteString("open file:///mnt/e/foo.txt", ctx)).toBe(
        "open file:///mnt/e/foo.txt"
      );
    });

    it("still translates bare unix paths (guard does not over-block)", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      expect(rewriteString("read /mnt/e/other/file.ts", ctx)).toBe(
        "read E:\\other\\file.ts"
      );
    });

    it("regression: realistic-hostname URLs stay safe", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      expect(rewriteString("https://example.com/mnt/e/data", ctx)).toBe(
        "https://example.com/mnt/e/data"
      );
    });

    it("mixed text: bare path translates, URL twin does not", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      expect(rewriteString("see /tmp/x and http://tmp/y", ctx)).toBe(
        "see C:\\Users\\sascha\\AppData\\Local\\Temp\\x and http://tmp/y"
      );
    });

    it("win32 source: file://C:\\ URLs untouched, bare C:\\ still translates", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await winToWslCtx();
      expect(rewriteString("open file://C:\\data\\f.txt", ctx)).toBe(
        "open file://C:\\data\\f.txt"
      );
      expect(rewriteString("read D:\\data\\f.txt", ctx)).toBe("read /mnt/d/data/f.txt");
    });
  });

  describe("transformLine", () => {
    it("rewrites a parseable line and reports field changes", async () => {
      const { transformLine } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      const line = JSON.stringify({
        type: "user", cwd: "/mnt/e/GitHub/proj",
        message: { role: "user", content: "hi" },
      });
      const r = transformLine(line, ctx, { newSessionId: "new-id" });
      expect(r.parseFailed).toBe(false);
      expect(r.changed).toBe(true);
      const parsed = JSON.parse(r.line);
      expect(parsed.cwd).toBe("E:\\GitHub\\proj");
      expect(parsed.sessionId).toBe("new-id");
      expect(r.fieldsChanged).toBeGreaterThanOrEqual(1);
    });

    it("applies version adapters before rewriting", async () => {
      const { transformLine } = await import("../src/rewriter.js");
      const ctx = await winToWslCtx();
      const adapter = {
        fromVersion: "2.0.0", toVersion: "2.1.0",
        description: "rename oldField to newField",
        applies: (e: Record<string, unknown>) => "oldField" in e,
        transform: (e: Record<string, unknown>) => {
          const { oldField, ...rest } = e as { oldField: unknown };
          return { ...rest, newField: oldField };
        },
      };
      const line = JSON.stringify({ type: "user", oldField: 1, message: { role: "user", content: "x" } });
      const r = transformLine(line, ctx, { adapters: [adapter as never] });
      expect(r.adaptationsApplied).toEqual(["rename oldField to newField"]);
      expect(JSON.parse(r.line).newField).toBe(1);
    });

    it("returns the input verbatim with parseFailed on bad JSON", async () => {
      const { transformLine } = await import("../src/rewriter.js");
      const ctx = await winToWslCtx();
      const r = transformLine("{not json", ctx);
      expect(r.parseFailed).toBe(true);
      expect(r.line).toBe("{not json");
      expect(r.parseError).toBeTruthy();
      expect(r.changed).toBe(false);
    });
  });
});
