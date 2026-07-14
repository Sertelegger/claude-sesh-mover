import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

describe("discovery", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-discovery-test-"));
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("discoverSessions", () => {
    it("finds sessions for a project path", async () => {
      const { discoverSessions } = await import("../src/discovery.js");
      const sessions = discoverSessions(
        configDir,
        "/Users/testuser/Projects/testproject"
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(sessionId);
      expect(sessions[0].slug).toBe("test-session");
      expect(sessions[0].messageCount).toBe(3);
      expect(sessions[0].hasSubagents).toBe(true);
      expect(sessions[0].hasToolResults).toBe(true);
      expect(sessions[0].hasFileHistory).toBe(true);
    });

    it("returns empty array for unknown project", async () => {
      const { discoverSessions } = await import("../src/discovery.js");
      const sessions = discoverSessions(configDir, "/nonexistent/path");
      expect(sessions).toHaveLength(0);
    });

    it("parses sessions whose first line exceeds 4KB", async () => {
      const { discoverSessions } = await import("../src/discovery.js");
      const { writeFileSync } = await import("node:fs");
      const bigId = "660e8400-e29b-41d4-a716-446655440000";
      const bigFirst = JSON.stringify({
        uuid: "big-1",
        timestamp: "2026-07-13T00:00:00Z",
        sessionId: bigId,
        cwd: "/Users/testuser/Projects/testproject",
        version: "2.1.114",
        slug: "big-session",
        type: "user",
        message: { role: "user", content: "x".repeat(8000) },
      });
      const last = JSON.stringify({
        uuid: "big-2",
        timestamp: "2026-07-13T00:01:00Z",
        sessionId: bigId,
        cwd: "/Users/testuser/Projects/testproject",
        version: "2.1.114",
        type: "assistant",
        message: { model: "m", id: "1", content: [] },
      });
      writeFileSync(
        join(configDir, "projects", "-Users-testuser-Projects-testproject", `${bigId}.jsonl`),
        bigFirst + "\n" + last + "\n"
      );
      const sessions = discoverSessions(configDir, "/Users/testuser/Projects/testproject");
      const big = sessions.find((s) => s.sessionId === bigId)!;
      expect(big).toBeDefined();
      expect(big.slug).toBe("big-session");
      expect(big.messageCount).toBe(2);
      expect(big.lastActiveAt).toBe("2026-07-13T00:01:00Z");
    });
  });

  describe("discoverSessionById", () => {
    it("finds a specific session by ID", async () => {
      const { discoverSessionById } = await import("../src/discovery.js");
      const session = discoverSessionById(configDir, sessionId);
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(sessionId);
    });

    it("returns null for unknown ID", async () => {
      const { discoverSessionById } = await import("../src/discovery.js");
      const session = discoverSessionById(configDir, "nonexistent-id");
      expect(session).toBeNull();
    });
  });

  describe("listAllProjects", () => {
    it("lists all project directories", async () => {
      const { listAllProjects } = await import("../src/discovery.js");
      const projects = listAllProjects(configDir);
      expect(projects).toHaveLength(1);
      expect(projects[0].projectPath).toBe(
        "/Users/testuser/Projects/testproject"
      );
    });
  });
});
