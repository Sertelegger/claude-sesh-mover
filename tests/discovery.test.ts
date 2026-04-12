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
