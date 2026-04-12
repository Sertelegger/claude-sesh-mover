import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Creates a minimal but realistic Claude session fixture tree.
 */
export function createFixtureTree(baseDir: string): {
  configDir: string;
  projectDir: string;
  sessionId: string;
} {
  const configDir = join(baseDir, ".claude");
  const projectEncoded = "-Users-testuser-Projects-testproject";
  const projectDir = join(configDir, "projects", projectEncoded);
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";

  // Create directory structure
  mkdirSync(join(projectDir, sessionId, "subagents"), { recursive: true });
  mkdirSync(join(projectDir, sessionId, "tool-results"), { recursive: true });
  mkdirSync(join(projectDir, "memory"), { recursive: true });
  mkdirSync(join(configDir, "file-history", sessionId), { recursive: true });
  mkdirSync(join(configDir, "plans"), { recursive: true });

  // Write session JSONL
  const entries = [
    {
      uuid: "entry-1",
      timestamp: "2026-04-10T12:00:00Z",
      sessionId,
      cwd: "/Users/testuser/Projects/testproject",
      version: "2.1.81",
      gitBranch: "main",
      slug: "test-session",
      userType: "external",
      entrypoint: "cli",
      type: "user",
      message: { role: "user", content: "Hello, help me build a REST API" },
    },
    {
      uuid: "entry-2",
      timestamp: "2026-04-10T12:00:05Z",
      sessionId,
      cwd: "/Users/testuser/Projects/testproject",
      version: "2.1.81",
      gitBranch: "main",
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        id: "msg_test",
        content: [{ type: "text", text: "I'll help you build a REST API." }],
      },
      parentUuid: "entry-1",
    },
    {
      uuid: "entry-3",
      timestamp: "2026-04-10T12:01:00Z",
      sessionId,
      cwd: "/Users/testuser/Projects/testproject",
      version: "2.1.81",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_test",
            type: "tool_result",
            content: "file contents at /Users/testuser/Projects/testproject/src/index.ts",
          },
        ],
      },
      toolUseResult: {
        stdout: "/Users/testuser/Projects/testproject/src/index.ts: TypeScript file",
        stderr: "",
      },
    },
  ];

  const jsonlContent = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), jsonlContent);

  // Write subagent files
  writeFileSync(
    join(projectDir, sessionId, "subagents", "agent-sub1.meta.json"),
    JSON.stringify({ agentType: "Explore", description: "Explore codebase" })
  );
  writeFileSync(
    join(projectDir, sessionId, "subagents", "agent-sub1.jsonl"),
    JSON.stringify({
      uuid: "sub-entry-1",
      timestamp: "2026-04-10T12:00:30Z",
      sessionId,
      cwd: "/Users/testuser/Projects/testproject",
      version: "2.1.81",
      type: "user",
      message: { role: "user", content: "Explore the src directory" },
      isSidechain: true,
      agentId: "sub1",
    }) + "\n"
  );

  // Write tool results
  writeFileSync(
    join(projectDir, sessionId, "tool-results", "toolu_test.txt"),
    "file contents at /Users/testuser/Projects/testproject/src/index.ts"
  );

  // Write file history
  writeFileSync(
    join(configDir, "file-history", sessionId, "abc123@v1"),
    "// original file content\n"
  );

  // Write memory
  writeFileSync(
    join(projectDir, "memory", "MEMORY.md"),
    "- [Test memory](test_memory.md) — remembering test patterns\n"
  );
  writeFileSync(
    join(projectDir, "memory", "test_memory.md"),
    "---\nname: Test memory\ndescription: Test patterns\ntype: feedback\n---\n\nUse vitest for testing.\n"
  );

  // Write plan
  writeFileSync(
    join(configDir, "plans", "test-plan.md"),
    "# Test Plan\n\n## Task 1\nDo the thing\n"
  );

  // Write history.jsonl
  writeFileSync(
    join(configDir, "history.jsonl"),
    JSON.stringify({
      display: "Hello, help me build a REST API",
      pastedContents: {},
      timestamp: 1774977600000,
      project: "/Users/testuser/Projects/testproject",
      sessionId,
    }) + "\n"
  );

  return { configDir, projectDir, sessionId };
}
