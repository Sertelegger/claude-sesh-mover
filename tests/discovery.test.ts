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
    /**
     * #126 — a pre-0.12.0 `import` wrote transcripts under the OLD encoding for
     * any path containing a `.`, a `_` or a space, and Claude Code has never
     * read that directory. Discovery scans both names so those sessions are
     * still visible and can be migrated into place; a fix that only corrected
     * the encoder would have looked, to that user, like it deleted their
     * history.
     *
     * This is a READ widening only — nothing here picks a write destination.
     */
    it("also finds sessions left under the pre-0.12.0 directory name", async () => {
      const { discoverSessions } = await import("../src/discovery.js");
      const { encodeProjectPath, legacyEncodeProjectPath } = await import("../src/platform.js");
      const { mkdirSync, writeFileSync, renameSync } = await import("node:fs");

      // A path where the two encoders disagree — the whole class #126 is about.
      const project = "/Users/testuser/Projects/my_app.v2";
      expect(legacyEncodeProjectPath(project)).not.toBe(encodeProjectPath(project));

      const legacyDir = join(configDir, "projects", legacyEncodeProjectPath(project));
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
        JSON.stringify({
          uuid: "e1", timestamp: "2026-04-10T12:00:00Z",
          sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          cwd: project, version: "2.1.81", type: "user",
          message: { role: "user", content: "stranded by the old encoder" },
        }) + "\n"
      );

      const found = discoverSessions(configDir, project);
      expect(found).toHaveLength(1);
      expect(found[0].sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    });

    it("does not scan a second directory when both encoders agree", async () => {
      // The common case, and worth pinning: a plain path must not cause two
      // readdirs of the same directory, nor report its sessions twice.
      const { discoverSessions } = await import("../src/discovery.js");
      const sessions = discoverSessions(configDir, "/Users/testuser/Projects/testproject");
      expect(sessions).toHaveLength(1);
    });

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
  // Task 6b. Claude Code brackets a real transcript with uuid-less bookkeeping
  // at BOTH ends — measured 2026-08-04, the first line of 7 of 7 real sessions
  // on this machine and the last line of 5 of 7 were such an entry. None of
  // them carries cwd/timestamp/gitBranch, so metadata read off the literal
  // first/last line was absent or wrong on essentially every real session.
  describe("bookkeeping-bracketed transcripts", () => {
    const SID = "770e8400-e29b-41d4-a716-446655440000";
    const PROJECT = "/Users/testuser/Projects/testproject";

    async function writeBracketed(): Promise<void> {
      const { writeFileSync } = await import("node:fs");
      const lines = [
        { type: "last-prompt", lastPrompt: "go", leafUuid: "k2", sessionId: SID },
        { type: "ai-title", aiTitle: "A title", sessionId: SID },
        {
          uuid: "k1",
          parentUuid: null,
          timestamp: "2026-08-01T10:00:00.000Z",
          sessionId: SID,
          cwd: PROJECT,
          gitBranch: "feature-x",
          entrypoint: "sdk-cli",
          slug: "bracketed-session",
          type: "user",
          message: { role: "user", content: "hi" },
        },
        {
          uuid: "k2",
          parentUuid: "k1",
          timestamp: "2026-08-01T10:05:00.000Z",
          sessionId: SID,
          cwd: PROJECT,
          type: "assistant",
          message: { role: "assistant", content: "yo" },
        },
        {
          type: "pr-link",
          sessionId: SID,
          prNumber: 9,
          prUrl: "https://example.test/9",
          prRepository: "o/r",
          timestamp: "2026-08-01T23:59:59.000Z",
        },
        { type: "mode", mode: "normal", sessionId: SID },
      ];
      writeFileSync(
        join(configDir, "projects", "-Users-testuser-Projects-testproject", `${SID}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
        "utf-8"
      );
    }

    it("derives metadata from the conversation entries, not the bookkeeping", async () => {
      const { discoverSessionById } = await import("../src/discovery.js");
      await writeBracketed();
      const s = discoverSessionById(configDir, SID);
      expect(s).not.toBeNull();
      expect(s!.slug).toBe("bracketed-session");
      expect(s!.gitBranch).toBe("feature-x");
      expect(s!.entrypoint).toBe("sdk-cli");
      expect(s!.createdAt).toBe("2026-08-01T10:00:00.000Z");
      // The pr-link above it is 14 hours later, and is NOT conversation.
      expect(s!.lastActiveAt).toBe("2026-08-01T10:05:00.000Z");
      // cwd is only on the conversation entries; without it this falls back to
      // the lossy encoded directory name.
      expect(s!.projectPath).toBe(PROJECT);
      expect(s!.messageCount).toBe(6); // every line still counts
    });

    it("never emits an undefined lastActiveAt, even with no timestamps anywhere", async () => {
      const { discoverSessionById } = await import("../src/discovery.js");
      const { writeFileSync } = await import("node:fs");
      const id = "880e8400-e29b-41d4-a716-446655440000";
      writeFileSync(
        join(configDir, "projects", "-Users-testuser-Projects-testproject", `${id}.jsonl`),
        JSON.stringify({ uuid: "n1", sessionId: id, cwd: PROJECT, type: "user" }) + "\n",
        "utf-8"
      );
      const s = discoverSessionById(configDir, id);
      expect(s).not.toBeNull();
      expect(typeof s!.lastActiveAt).toBe("string");
      expect(Number.isNaN(new Date(s!.lastActiveAt).getTime())).toBe(false);
      expect(JSON.parse(JSON.stringify(s))).toHaveProperty("lastActiveAt");
    });

    // The degraded shape that used to publish an impossible pair: the FORWARD
    // scan fails where the backward one succeeds, so `firstEntry` comes from
    // the raw-first-line fallback with no timestamp and `createdAt` fell
    // straight to mtime (now), while `lastActiveAt` came off a real, older
    // conversation entry — created AFTER last active.
    //
    // Provoked here with a leading line that is valid JSON but not an object
    // (the forward scan's "unreadable" rule, which the raw fallback then parses
    // happily). The same asymmetry is reached by a leading bookkeeping run
    // longer than MAX_ENTRY_SCAN_BYTES; this is the cheap stand-in for it.
    it("never reports a createdAt later than lastActiveAt", async () => {
      const { discoverSessionById } = await import("../src/discovery.js");
      const { writeFileSync } = await import("node:fs");
      const id = "770e8400-e29b-41d4-a716-446655440000";
      writeFileSync(
        join(configDir, "projects", "-Users-testuser-Projects-testproject", `${id}.jsonl`),
        "[]\n" +
          JSON.stringify({
            uuid: "old-1",
            parentUuid: null,
            sessionId: id,
            cwd: PROJECT,
            type: "user",
            timestamp: "2020-01-02T03:04:05.000Z",
            message: { role: "user", content: "ancient" },
          }) +
          "\n",
        "utf-8"
      );
      const s = discoverSessionById(configDir, id);
      expect(s).not.toBeNull();
      expect(s!.lastActiveAt).toBe("2020-01-02T03:04:05.000Z");
      expect(s!.createdAt).toBe(s!.lastActiveAt);
      expect(new Date(s!.createdAt).getTime()).toBeLessThanOrEqual(
        new Date(s!.lastActiveAt).getTime()
      );
    });

    it("still lists a transcript that holds no conversation entry at all", async () => {
      const { discoverSessionById } = await import("../src/discovery.js");
      const { writeFileSync } = await import("node:fs");
      const id = "990e8400-e29b-41d4-a716-446655440000";
      writeFileSync(
        join(configDir, "projects", "-Users-testuser-Projects-testproject", `${id}.jsonl`),
        JSON.stringify({ type: "mode", mode: "normal", sessionId: id }) + "\n",
        "utf-8"
      );
      const s = discoverSessionById(configDir, id);
      expect(s).not.toBeNull();
      expect(s!.sessionId).toBe(id);
      expect(s!.projectPath).toBe("-Users-testuser-Projects-testproject"); // no cwd to read
    });
  });
});
