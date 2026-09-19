import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  /**
   * #108 — stage 1 had NO leading guard at all, and that is a different defect
   * from the stage-2 one the block below pins.
   *
   * Stage 2 matches a SHAPE (`/seg/seg`) and a character class can guard it.
   * Stage 1 substitutes a known LITERAL wherever it appears, so no class can
   * express the rule — the guard has to look at what precedes the match. The
   * consequence was that a mapped project path inside a URL was rewritten, and
   * crucially **this was not gated on a cross-platform move**: every
   * export/import/push/pull runs stage 1, so a same-family Linux→Linux
   * migration corrupted URLs in captured tool output too.
   *
   * The existing `file://` pin below passes for an unrelated reason — its path
   * is outside every mapping, so it never reaches stage 1 at all.
   */
  describe("URL guard (#108): a MAPPED path inside a URL is left alone", () => {
    /** Same family, so nothing here depends on cross-platform translation. */
    function sameFamilyCtx() {
      return {
        mappings: [{ from: "/home/sascha/proj", to: "/home/dev/app", description: "project" }],
        sourcePlatform: "linux" as const,
        targetPlatform: "linux" as const,
        sourceUser: "sascha",
        targetUser: "dev",
      };
    }

    it("leaves a mapped path inside an https URL alone, same family", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = sameFamilyCtx();
      // The dangerous shape: the result would still be a well-formed URL,
      // pointing somewhere else. Nothing about it looks corrupted.
      expect(rewriteString("https://example.com/home/sascha/proj/x", ctx)).toBe(
        "https://example.com/home/sascha/proj/x"
      );
      expect(rewriteString("http://localhost:5173/home/sascha/proj/index.html", ctx)).toBe(
        "http://localhost:5173/home/sascha/proj/index.html"
      );
    });

    it("still translates the same mapped path when it is NOT in a URL", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = sameFamilyCtx();
      // The control that makes the test above mean something: a guard that
      // simply stopped stage 1 working would pass the URL cases and fail here.
      expect(rewriteString("see /home/sascha/proj/src/a.ts for details", ctx)).toBe(
        "see /home/dev/app/src/a.ts for details"
      );
    });

    it("leaves a mapped path inside a URL alone cross-family, where it mangled outright", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = {
        mappings: [{ from: "/home/sascha/proj", to: "E:\\proj", description: "project" }],
        sourcePlatform: "linux" as const,
        targetPlatform: "win32" as const,
        sourceUser: "sascha",
        targetUser: "sascha",
      };
      // Measured before the fix: "http://localhost:5173E:\\proj/index.html".
      expect(rewriteString("http://localhost:5173/home/sascha/proj/index.html", ctx)).toBe(
        "http://localhost:5173/home/sascha/proj/index.html"
      );
    });

    it("guards any scheme, not a hardcoded http/https list", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = sameFamilyCtx();
      for (const url of [
        "file:///home/sascha/proj/x",
        "ws://host/home/sascha/proj/sock",
        "vscode-remote://ssh/home/sascha/proj/f.ts",
      ]) {
        expect(rewriteString(url, ctx), url).toBe(url);
      }
    });
  });

  /**
   * #16's guard/token asymmetry: `_ @ ~ +` were legal INSIDE a stage-2 token
   * and invisible in FRONT of one, so a token could start immediately after a
   * character it was allowed to contain. Both classes now derive from one
   * constant — except `+`, carved out by owner ruling because `+/path` is a
   * unified-diff added line and this codebase's own domain is carry patches.
   */
  describe("guard/token symmetry (#16)", () => {
    it("does not start a token after a character a token may contain", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      // Measured before the fix: "cd ~C:\\Users\\sascha\\AppData\\Local\\Temp\\build"
      // and "~E:\\x". A tilde is not a domain character, so no URL rule was
      // protecting these — the asymmetry alone was the bug.
      for (const input of ["cd ~/tmp/build", "~/mnt/e/x", "~/a@/tmp/x", "foo_/tmp/x"]) {
        expect(rewriteString(input, ctx), input).toBe(input);
      }
    });

    it("KEEPS translating a `+`-prefixed path — the deliberate exception", async () => {
      const { rewriteString } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      // A unified-diff added line. Full symmetry would leave the SOURCE
      // machine's path in the transcript, which is wrong in a way a reader
      // cannot see is wrong. Pinned so "finishing" the symmetry fails here.
      //
      // **The path must be one STAGE 2 translates, not a mapped one.** The
      // first version of this test used `+/mnt/e/GitHub/proj/...`, which is a
      // stage-1 mapping match — and stage 1 never consulted the guard class,
      // so the test passed with the carve-out REMOVED. Caught by mutation, and
      // it is exactly this file's own recurring defect: a guard that passes for
      // a reason unrelated to what it claims.
      expect(rewriteString("+/tmp/scratch", ctx)).toBe(
        "+C:\\Users\\sascha\\AppData\\Local\\Temp\\scratch"
      );
      expect(rewriteString("+/mnt/e/other/x", ctx)).toBe("+E:\\other\\x");
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

  describe("rewriteJsonlStream", () => {
    function makeJsonl(lines: Array<Record<string, unknown> | string>): string {
      return (
        lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n"
      );
    }

    it("output is byte-identical to rewriteJsonl and reports match", async () => {
      const { rewriteJsonl, rewriteJsonlStream } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      const content = makeJsonl([
        { type: "user", cwd: "/mnt/e/GitHub/proj", message: { role: "user", content: "hi" } },
        {
          type: "user",
          cwd: "/mnt/e/GitHub/proj",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "at /mnt/e/GitHub/proj/src/a.ts" }],
          },
          toolUseResult: { stdout: "/tmp/out.log", stderr: "" },
        },
        "{unparseable",
        { type: "file-history-snapshot", snapshot: { trackedFileBackups: { "/mnt/e/GitHub/proj/a.ts": { v: 1 } } } },
      ]);
      const dir = mkdtempSync(join(tmpdir(), "sesh-stream-"));
      try {
        const input = join(dir, "in.jsonl");
        const output = join(dir, "out.jsonl");
        writeFileSync(input, content, "utf-8");

        const stringResult = rewriteJsonl(content, ctx, "new-id");
        const streamReport = await rewriteJsonlStream(input, output, ctx, {
          newSessionId: "new-id",
          computeHash: true,
        });

        expect(readFileSync(output, "utf-8")).toBe(stringResult.rewritten);
        expect(streamReport.entriesRewritten).toBe(stringResult.report.entriesRewritten);
        expect(streamReport.fieldsRewritten).toBe(stringResult.report.fieldsRewritten);
        expect(streamReport.warnings).toEqual(stringResult.report.warnings);
        expect(streamReport.parseFailures).toBe(1);

        const { computeIntegrityHash } = await import("../src/manifest.js");
        expect(streamReport.outputHash).toBe(computeIntegrityHash([stringResult.rewritten]));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("report-only mode (null output) writes nothing and still reports", async () => {
      const { rewriteJsonlStream } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      const dir = mkdtempSync(join(tmpdir(), "sesh-stream-"));
      try {
        const input = join(dir, "in.jsonl");
        writeFileSync(
          input,
          JSON.stringify({ type: "user", cwd: "/mnt/e/GitHub/proj", message: { role: "user", content: "x" } }) + "\n",
          "utf-8"
        );
        const report = await rewriteJsonlStream(input, null, ctx, {});
        expect(report.entriesRewritten).toBe(1);
        expect(readFileSync(input, "utf-8")).toContain("/mnt/e/GitHub/proj"); // input untouched
        expect(existsSync(join(dir, "out.jsonl"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("emits monotonically non-decreasing progress ending at the file size", async () => {
      const { rewriteJsonlStream } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      const dir = mkdtempSync(join(tmpdir(), "sesh-stream-"));
      try {
        const input = join(dir, "in.jsonl");
        const lines = Array.from({ length: 500 }, (_, i) =>
          JSON.stringify({ type: "user", uuid: `u${i}`, cwd: "/mnt/e/GitHub/proj", message: { role: "user", content: `msg ${i}` } })
        );
        const content = lines.join("\n") + "\n";
        writeFileSync(input, content, "utf-8");
        const calls: Array<[number, number]> = [];
        await rewriteJsonlStream(input, join(dir, "out.jsonl"), ctx, {
          onProgress: (b, t) => calls.push([b, t]),
        });
        expect(calls.length).toBe(500);
        for (let i = 1; i < calls.length; i++) {
          expect(calls[i][0]).toBeGreaterThanOrEqual(calls[i - 1][0]);
        }
        expect(calls[calls.length - 1][0]).toBe(Buffer.byteLength(content, "utf8"));
        expect(calls[0][1]).toBe(Buffer.byteLength(content, "utf8"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("handles a large synthetic session correctly (10k lines incl. a long line)", async () => {
      const { rewriteJsonl, rewriteJsonlStream } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      const dir = mkdtempSync(join(tmpdir(), "sesh-stream-"));
      try {
        const input = join(dir, "in.jsonl");
        const big = "x".repeat(512 * 1024); // one 512KB line
        const lines = Array.from({ length: 10_000 }, (_, i) =>
          JSON.stringify({
            type: "user",
            uuid: `u${i}`,
            cwd: "/mnt/e/GitHub/proj",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: `t${i}`, content: i === 5000 ? big : `out /mnt/e/GitHub/proj/f${i}.ts` }],
            },
          })
        );
        const content = lines.join("\n") + "\n";
        writeFileSync(input, content, "utf-8");
        const output = join(dir, "out.jsonl");
        const report = await rewriteJsonlStream(input, output, ctx, { newSessionId: "big-new" });
        expect(report.entriesRewritten).toBe(10_000);
        expect(readFileSync(output, "utf-8")).toBe(rewriteJsonl(content, ctx, "big-new").rewritten);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects on unreadable input (error propagation)", async () => {
      const { rewriteJsonlStream } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      await expect(
        rewriteJsonlStream("/definitely/not/a/real/path.jsonl", null, ctx, {})
      ).rejects.toThrow();
    });

    /**
     * #16 asked for a post-open input-error pin, and the reason it gave is
     * right: the test above never reaches the readline path. It passes a path
     * that does not exist, so it dies at `statSync(inputPath)` (src/rewriter.ts
     * :492) before a byte is read — which pins the PRE-open failure and nothing
     * else.
     *
     * A directory is the cheapest input that gets past that line: `statSync`
     * succeeds on one, so the failure arrives from the read stream itself,
     * inside the `for await`, which is the path with no coverage.
     */
    it("rejects on an input error raised AFTER the stat succeeds", async () => {
      const { rewriteJsonlStream } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      const dir = mkdtempSync(join(tmpdir(), "sesh-stream-postopen-"));
      try {
        // The input IS the directory: stattable, not readable as a file.
        await expect(rewriteJsonlStream(dir, join(dir, "out.jsonl"), ctx, {})).rejects.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /**
     * #16 also asked for a drain-race pin "with an input large enough to force
     * `write() === false`", saying the existing error test never backpressures.
     *
     * **The premise needed retargeting and the measurement is why.** A probe of
     * the write half showed the existing small fixture DOES reach the drain
     * branch — but only 39 times in 40, with the fall-through landing on the
     * `finished(out)` race instead. So the bullet was not wrong, it was FLAKY:
     * a pin built on the small input would pass almost always and fail roughly
     * once in forty runs, which is worse than no pin.
     *
     * One line larger than the stream's 64 KiB high-water mark makes entry
     * deterministic (40/40 measured), which is what a pin needs. This asserts
     * the content survives the backpressure round trip — the failure it guards
     * against is a dropped or truncated chunk after an awaited drain, not a
     * throw.
     */
    it("round-trips a line larger than the write high-water mark, through the drain path", async () => {
      const { rewriteJsonlStream } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      const dir = mkdtempSync(join(tmpdir(), "sesh-stream-drain-"));
      try {
        const input = join(dir, "in.jsonl");
        const output = join(dir, "out.jsonl");
        // ~70 KiB of payload in ONE line, comfortably past the 64 KiB default,
        // so `out.write()` returns false and the await is entered every run.
        const big = "x".repeat(70 * 1024);
        writeFileSync(
          input,
          JSON.stringify({ uuid: "u1", type: "user", cwd: "/mnt/e/GitHub/proj", pad: big }) + "\n",
          "utf-8"
        );
        await rewriteJsonlStream(input, output, ctx, {});

        const written = readFileSync(output, "utf-8");
        const parsed = JSON.parse(written.trim());
        // The payload survived intact...
        expect(parsed.pad).toHaveLength(big.length);
        // ...and the rewrite still happened on the same line, so the drain
        // round trip did not cost the transformation.
        expect(parsed.cwd).toBe("E:\\GitHub\\proj");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Pins the error latch END TO END, through this verb. The latch itself now
    // lives in `src/latched-write.ts` and is pinned directly there — which is
    // the stronger test, because this one asserts only that the call rejects
    // and so cannot see WHICH error survived or whether a healthy stream ever
    // finishes. Measured: a last-error-wins latch and a `finish()` that forgets
    // `end()` both leave this test green.
    //
    // What it still earns is the half a unit test cannot reach — that this
    // verb's real stream, opened on a real path, is actually wired to the
    // latch. Without it, an output-stream open failure either crashes the
    // process on an unhandled 'error' or hangs forever on a missed 'drain'.
    it("rejects (does not crash or hang) when the output stream errors", async () => {
      const { rewriteJsonlStream } = await import("../src/rewriter.js");
      const ctx = await wslToWinCtx();
      const dir = mkdtempSync(join(tmpdir(), "sesh-stream-"));
      try {
        const input = join(dir, "in.jsonl");
        writeFileSync(
          input,
          JSON.stringify({ type: "user", cwd: "/mnt/e/GitHub/proj", message: { role: "user", content: "x" } }) + "\n",
          "utf-8"
        );
        await expect(
          rewriteJsonlStream(input, join(dir, "no-such-subdir", "out.jsonl"), ctx, {})
        ).rejects.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * # The fields Claude Code 2.1.27x writes that the rewriter used to miss (#127)
 *
 * Every fixture below is the real on-disk shape, keys taken verbatim from live
 * transcripts, values redacted. None of these had a test before, because the
 * rewriter never wrote them — so "the suite is green" said nothing here.
 *
 * The rule these encode: **a field is rewritten if its value is a LOCATION and
 * left verbatim if it is CONTENT**, with the tie-breaker "does a second copy of
 * these bytes travel in this bundle?".
 *
 * Linux-provable: string mapping only, no platform-specific behaviour.
 */
describe("rewriter — 2.1.27x path fields (#127)", () => {
  const ctxFor = async (): Promise<import("../src/rewriter.js").RewriteContext> => {
    const { buildPathMappings, encodeProjectPathForTest } = await import("../src/rewriter.js").then(
      async (m) => ({ ...m, encodeProjectPathForTest: (await import("../src/platform.js")).encodeProjectPath })
    );
    const src = "/home/dev/repos/proj";
    const tgt = "/tgt/proj";
    return {
      mappings: buildPathMappings("linux", "linux", src, tgt, "/home/dev/.claude", "/tgt/cfg", "dev", "tgtuser"),
      sourcePlatform: "linux",
      targetPlatform: "linux",
      sourceUser: "dev",
      targetUser: "tgtuser",
      sessionIdMap: new Map([["old-session", "new-session"]]),
      encodedProject: [encodeProjectPathForTest(src), encodeProjectPathForTest(tgt)] as const,
    };
  };

  /**
   * `attachment` is about a third of all lines and roughly half of all
   * CONVERSATION entries, and had no branch at all. `snapshot.workingDirectory`
   * is a second, parallel cwd — the top-level one was rewritten while this was
   * not, so a resumed session was told it sits somewhere that does not exist.
   */
  it("rewrites an attachment's environment snapshot, including the rendered reminder", async () => {
    const { rewriteEntry } = await import("../src/rewriter.js");
    const ctx = await ctxFor();
    const out = rewriteEntry(
      {
        type: "attachment",
        uuid: "a1",
        cwd: "/home/dev/repos/proj",
        attachment: {
          type: "environment",
          snapshot: {
            workingDirectory: "/home/dev/repos/proj",
            additionalWorkingDirectories: ["/home/dev/repos/proj/sub"],
            scratchpadDirectory: "/tmp/claude-1000/-home-dev-repos-proj/old-session/scratchpad",
          },
          changes: [{ field: "workingDirectory", from: "/home/dev/repos/proj", to: "/home/dev/repos/proj/x" }],
          filename: "/home/dev/repos/proj/tests/a.test.ts",
          files: [{ path: "/home/dev/.claude/CLAUDE.md" }],
        },
        rendered: [{ content: "- Primary working directory: /home/dev/repos/proj\n" }],
      },
      ctx,
      "new-session"
    );
    const att = out.attachment as Record<string, Record<string, unknown>>;
    expect(att.snapshot.workingDirectory).toBe("/tgt/proj");
    expect(att.snapshot.additionalWorkingDirectories).toEqual(["/tgt/proj/sub"]);
    // The scratchpad embeds BOTH the encoded project name and the session id,
    // mid-path, where no prefix mapping reaches.
    expect(att.snapshot.scratchpadDirectory).toBe("/tmp/claude-1000/-tgt-proj/new-session/scratchpad");
    expect((att.changes as Array<Record<string, string>>)[0].from).toBe("/tgt/proj");
    expect(att.filename).toBe("/tgt/proj/tests/a.test.ts");
    expect((att.files as Array<Record<string, string>>)[0].path).toBe("/tgt/cfg/CLAUDE.md");
    expect((out.rendered as Array<Record<string, string>>)[0].content).toContain("/tgt/proj");
  });

  /**
   * The key and its own value are the same fact. Before #127 only the key moved,
   * so one object named the target machine in its key and the source machine in
   * `realParentDir` — the field a `/rewind` restore consults to re-create a
   * parent directory, which makes it the highest write-side risk in the set.
   */
  it("rewrites file-history backup VALUES, not only their keys", async () => {
    const { rewriteEntry } = await import("../src/rewriter.js");
    const ctx = await ctxFor();
    const out = rewriteEntry(
      {
        type: "file-history-snapshot",
        snapshot: {
          trackedFileBackups: {
            "/home/dev/repos/proj/a.md": {
              backupFileName: "df0f7abe@v2",
              realParentDir: "/home/dev/repos/proj",
            },
          },
        },
      },
      ctx
    );
    const backups = (out.snapshot as Record<string, Record<string, Record<string, unknown>>>).trackedFileBackups;
    expect(Object.keys(backups)).toEqual(["/tgt/proj/a.md"]);
    expect(backups["/tgt/proj/a.md"].realParentDir).toBe("/tgt/proj");
  });

  it("rewrites the file-history-delta entry type, which had no branch at all", async () => {
    const { rewriteEntry } = await import("../src/rewriter.js");
    const ctx = await ctxFor();
    const out = rewriteEntry(
      {
        type: "file-history-delta",
        trackingPath: "/home/dev/repos/proj/a.md",
        backup: { backupFileName: "x@v1", realParentDir: "/home/dev/repos/proj" },
      },
      ctx
    );
    expect(out.trackingPath).toBe("/tgt/proj/a.md");
    expect((out.backup as Record<string, unknown>).realParentDir).toBe("/tgt/proj");
  });

  /**
   * We carry the `tool-results` layer AND rename its directory to the new
   * session id, then left the pointer naming the source machine. The cleanest
   * "moved the data, broke the link" case in the corpus.
   */
  it("rewrites toolUseResult pointers, including the string-valued form", async () => {
    const { rewriteEntry } = await import("../src/rewriter.js");
    const ctx = await ctxFor();
    const out = rewriteEntry(
      {
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "x" },
        toolUseResult: {
          persistedOutputPath: "/home/dev/.claude/projects/-home-dev-repos-proj/old-session/tool-results/b5.txt",
          filePath: "/home/dev/repos/proj/a.ts",
          file: { filePath: "/home/dev/repos/proj/b.ts" },
          bashEditDiff: { changedFiles: ["/home/dev/repos/proj/c.rs"], files: [{ filePath: "/home/dev/repos/proj/d.rs" }] },
          backgroundCwdHint: "Session cwd remains /home/dev/repos/proj; ...",
          // CONTENT despite the name — measured file bytes, left verbatim.
          originalFile: "#!/usr/bin/env bash\ncd /home/dev/repos/proj\n",
        },
      },
      ctx,
      "new-session"
    );
    const tr = out.toolUseResult as Record<string, Record<string, unknown>>;
    expect(tr.persistedOutputPath).toBe("/tgt/cfg/projects/-tgt-proj/new-session/tool-results/b5.txt");
    expect(tr.filePath).toBe("/tgt/proj/a.ts");
    expect(tr.file.filePath).toBe("/tgt/proj/b.ts");
    expect(tr.bashEditDiff.changedFiles).toEqual(["/tgt/proj/c.rs"]);
    expect((tr.bashEditDiff.files as Array<Record<string, string>>)[0].filePath).toBe("/tgt/proj/d.rs");
    expect(tr.backgroundCwdHint).toContain("/tgt/proj");
    expect(tr.originalFile).toContain("/home/dev/repos/proj");

    const asString = rewriteEntry(
      { type: "user", uuid: "u2", message: { role: "user", content: "x" }, toolUseResult: "wrote /home/dev/repos/proj/e.ts" },
      ctx
    );
    expect(asString.toolUseResult).toBe("wrote /tgt/proj/e.ts");
  });

  /**
   * There was no `assistant` branch, which is the structural reason every tool
   * INPUT survived a move. The wire triple is bound by an equation Claude Code
   * re-checks on resume — rewriting one leg is strictly worse than doing
   * nothing, so `command` is RE-DERIVED rather than rewritten in place.
   */
  it("rewrites tool inputs and keeps the wire equation intact", async () => {
    const { rewriteEntry } = await import("../src/rewriter.js");
    const ctx = await ctxFor();
    const out = rewriteEntry(
      {
        type: "assistant",
        uuid: "a2",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/home/dev/repos/proj/a.ts" } },
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls /home/dev/repos/proj" } },
            // CONTENT: a script body, not a location, despite the key's name.
            { type: "tool_use", id: "t3", name: "Workflow", input: { script: "const p='/home/dev/repos/proj'" } },
          ],
        },
        wireIngestContext: { t2: { cwd: "/home/dev/repos/proj" } },
        wireToolInputs: { t2: { command: "cd /home/dev/repos/proj && ls /home/dev/repos/proj" } },
      },
      ctx
    );
    const blocks = (out.message as Record<string, Array<Record<string, Record<string, unknown>>>>).content;
    expect(blocks[0].input.file_path).toBe("/tgt/proj/a.ts");
    expect(blocks[1].input.command).toBe("ls /tgt/proj");
    expect(blocks[2].input.script).toBe("const p='/home/dev/repos/proj'"); // untouched
    const wic = out.wireIngestContext as Record<string, Record<string, string>>;
    const wti = out.wireToolInputs as Record<string, Record<string, string>>;
    expect(wic.t2.cwd).toBe("/tgt/proj");
    // THE EQUATION: wire === "cd " + wic.cwd + " && " + input.command
    expect(wti.t2.command).toBe(`cd ${wic.t2.cwd} && ${blocks[1].input.command as string}`);
  });

  /**
   * The OTHER wire shape. The fixture above uses the `cd <cwd> && <cmd>` form;
   * this one is `wire === input` verbatim, which is the majority case measured
   * (134 of 135 pairs in one real transcript). Found by mutation: disabling the
   * plain branch left every test green, because nothing exercised it.
   */
  it("re-derives the wire command in its plain form too", async () => {
    const { rewriteEntry } = await import("../src/rewriter.js");
    const ctx = await ctxFor();
    const out = rewriteEntry(
      {
        type: "assistant",
        uuid: "a3",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "cat /home/dev/repos/proj/a.ts" } }],
        },
        wireToolInputs: { t9: { command: "cat /home/dev/repos/proj/a.ts" } },
      },
      ctx
    );
    const blocks = (out.message as Record<string, Array<Record<string, Record<string, unknown>>>>).content;
    const wti = out.wireToolInputs as Record<string, Record<string, string>>;
    expect(blocks[0].input.command).toBe("cat /tgt/proj/a.ts");
    expect(wti.t9.command).toBe(blocks[0].input.command);
  });

  /**
   * A wire form whose relation did NOT hold before the rewrite is left exactly
   * as it was — Claude Code's own check already fails for it, so reproducing
   * that is correct and manufacturing agreement would not be.
   */
  it("leaves a wire command alone when the relation never held", async () => {
    const { rewriteEntry } = await import("../src/rewriter.js");
    const ctx = await ctxFor();
    const out = rewriteEntry(
      {
        type: "assistant",
        uuid: "a4",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tX", name: "Bash", input: { command: "ls /home/dev/repos/proj" } }],
        },
        wireToolInputs: { tX: { command: "something else entirely" } },
      },
      ctx
    );
    expect((out.wireToolInputs as Record<string, Record<string, string>>).tX.command).toBe("something else entirely");
  });

  /**
   * The encoded project name inside FREE TEXT — which `rewritePathValue`'s
   * interior segment pass never sees, because that only runs on whole-path
   * fields. This is what the mapping added to `buildPathMappings` is for, and
   * without it a rewritten stdout line comes out half target and half source.
   * Found by mutation: deleting that mapping left every test green.
   */
  it("rewrites the encoded project name inside free text", async () => {
    const { rewriteEntry } = await import("../src/rewriter.js");
    const ctx = await ctxFor();
    const out = rewriteEntry(
      {
        type: "user",
        uuid: "u9",
        message: { role: "user", content: "x" },
        toolUseResult: {
          stdout: "wrote /tgt/cfg/projects/-home-dev-repos-proj/old-session/tool-results/z.txt",
        },
      },
      ctx
    );
    const stdout = (out.toolUseResult as Record<string, string>).stdout;
    // The half-rewritten shape is the bug: target config dir, source project.
    expect(stdout).not.toContain("-home-dev-repos-proj");
    expect(stdout).toContain("-tgt-proj");
  });

  /**
   * `session_id` is WHO WROTE the entry, not which file it is in. It is mapped
   * when the referent travels in this bundle and left byte-identical when it
   * does not — never assigned, because a measured ~24% of them name a run with
   * no transcript at all, and stamping the new id over those fabricates
   * authorship.
   */
  it("MAPS session_id when the referent travels, and leaves it alone when it does not", async () => {
    const { rewriteEntry } = await import("../src/rewriter.js");
    const ctx = await ctxFor();
    const mapped = rewriteEntry(
      { type: "user", uuid: "u3", session_id: "old-session", message: { role: "user", content: "x" } },
      ctx,
      "new-session"
    );
    expect(mapped.sessionId).toBe("new-session"); // the file
    expect(mapped.session_id).toBe("new-session"); // the run, mapped

    const stranger = rewriteEntry(
      { type: "user", uuid: "u4", session_id: "a-run-not-in-this-bundle", message: { role: "user", content: "x" } },
      ctx,
      "new-session"
    );
    expect(stranger.sessionId).toBe("new-session");
    expect(stranger.session_id).toBe("a-run-not-in-this-bundle");
  });

  it("leaves every session reference byte-identical when no map was supplied", async () => {
    const { rewriteEntry, buildPathMappings } = await import("../src/rewriter.js");
    const ctx = {
      mappings: buildPathMappings("linux", "linux", "/a", "/b", "/c", "/d", "u", "v"),
      sourcePlatform: "linux" as const,
      targetPlatform: "linux" as const,
      sourceUser: "u",
      targetUser: "v",
    };
    const out = rewriteEntry(
      { type: "user", uuid: "u5", session_id: "old-session", continuedInSessionId: "old-session", message: { role: "user", content: "x" } },
      ctx,
      "new-session"
    );
    expect(out.session_id).toBe("old-session");
    expect(out.continuedInSessionId).toBe("old-session");
  });
});
