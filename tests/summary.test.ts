import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("summary", () => {
  describe("extractSummary", () => {
    it("uses slug when descriptive", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const result = extractSummary("fix-auth-middleware", [
        { type: "user", message: { role: "user", content: "Fix the bug" } },
      ]);
      expect(result).toBe("fix-auth-middleware");
    });

    it("falls back to first user message when slug is generic", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const result = extractSummary("new-session", [
        {
          type: "user",
          message: {
            role: "user",
            content: "Help me build a REST API with Express and TypeScript",
          },
        },
      ]);
      expect(result).toBe(
        "Help me build a REST API with Express and TypeScript"
      );
    });

    it("truncates long first messages to ~100 chars", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const longMsg = "A".repeat(200);
      const result = extractSummary("new-session", [
        { type: "user", message: { role: "user", content: longMsg } },
      ]);
      expect(result.length).toBeLessThanOrEqual(103); // 100 + "..."
    });

    it("skips UUID-like slugs", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const result = extractSummary(
        "550e8400-e29b-41d4-a716-446655440000",
        [
          {
            type: "user",
            message: { role: "user", content: "Hello world" },
          },
        ]
      );
      expect(result).toBe("Hello world");
    });

    it("falls back to assistant response when user message is not a string", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const result = extractSummary("new-session", [
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", content: "..." }],
          },
        },
        {
          type: "assistant",
          message: {
            model: "claude",
            id: "1",
            content: [
              {
                type: "text",
                text: "I'll help you set up the authentication system.",
              },
            ],
          },
        },
      ]);
      expect(result).toBe(
        "I'll help you set up the authentication system."
      );
    });

    it("returns generic fallback when nothing works", async () => {
      const { extractSummary } = await import("../src/summary.js");
      const result = extractSummary("new-session", []);
      expect(result).toBe("(no summary available)");
    });
  });

  describe("extractFirstExchanges", () => {
    it("extracts first N user/assistant exchanges", async () => {
      const { extractFirstExchanges } = await import("../src/summary.js");
      const entries = [
        {
          type: "user",
          message: { role: "user", content: "Build me a CLI" },
        },
        {
          type: "assistant",
          message: {
            model: "claude",
            id: "1",
            content: [{ type: "text", text: "I'll create a CLI tool." }],
          },
        },
        {
          type: "user",
          message: { role: "user", content: "Add tests" },
        },
      ];
      const exchanges = extractFirstExchanges(entries, 2);
      expect(exchanges).toHaveLength(2);
    });
  });

  describe("extractSummaryFromFile", () => {
    it("short-circuits on a meaningful slug without reading the file", async () => {
      const { extractSummaryFromFile } = await import("../src/summary.js");
      // nonexistent path proves no read happens
      expect(await extractSummaryFromFile("real-slug", "/nonexistent/x.jsonl")).toBe(
        "real-slug"
      );
    });

    it("matches extractSummary for generic slugs (first user string message wins)", async () => {
      const { extractSummary, extractSummaryFromFile } = await import("../src/summary.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-sum-"));
      try {
        const entries = [
          { type: "assistant", message: { content: [{ type: "text", text: "assistant first" }] } },
          { type: "user", message: { role: "user", content: "the user message" } },
        ];
        const file = join(dir, "s.jsonl");
        writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
        expect(await extractSummaryFromFile("new-session", file)).toBe(
          extractSummary("new-session", entries)
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("falls back to first assistant text, then placeholder", async () => {
      const { extractSummaryFromFile } = await import("../src/summary.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-sum-"));
      try {
        const assistantOnly = [
          {
            type: "assistant",
            message: {
              model: "claude",
              id: "1",
              content: [{ type: "text", text: "Assistant only reply" }],
            },
          },
        ];
        const assistantFile = join(dir, "assistant-only.jsonl");
        writeFileSync(
          assistantFile,
          assistantOnly.map((e) => JSON.stringify(e)).join("\n") + "\n",
          "utf-8"
        );
        expect(await extractSummaryFromFile("new-session", assistantFile)).toBe(
          "Assistant only reply"
        );

        const emptyFile = join(dir, "empty.jsonl");
        writeFileSync(emptyFile, "", "utf-8");
        expect(await extractSummaryFromFile("new-session", emptyFile)).toBe(
          "(no summary available)"
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
