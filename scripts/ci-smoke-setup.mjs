// Creates a minimal Claude config-dir fixture for the CI shell smoke test.
// Layout mirrors tests/fixtures/create-fixtures.ts but is dependency-free.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base = process.env.RUNNER_TEMP;
if (!base) throw new Error("RUNNER_TEMP not set (this script runs in CI)");

const configDir = join(base, "smoke-config", ".claude");
const projectEncoded = "-Users-testuser-Projects-testproject";
const projectDir = join(configDir, "projects", projectEncoded);
const sessionId = "550e8400-e29b-41d4-a716-446655440000";
mkdirSync(projectDir, { recursive: true });

const entries = [
  {
    uuid: "entry-1",
    timestamp: "2026-07-14T12:00:00Z",
    sessionId,
    cwd: "/Users/testuser/Projects/testproject",
    version: "2.1.81",
    gitBranch: "main",
    slug: "smoke-session",
    entrypoint: "cli",
    type: "user",
    message: { role: "user", content: "smoke test with spaces & quotes \"quoted\"" },
  },
  {
    uuid: "entry-2",
    timestamp: "2026-07-14T12:00:05Z",
    sessionId,
    cwd: "/Users/testuser/Projects/testproject",
    version: "2.1.81",
    gitBranch: "main",
    type: "assistant",
    message: {
      model: "claude-opus-4-6",
      id: "msg_smoke",
      content: [{ type: "text", text: "ok — /Users/testuser/Projects/testproject/src/a.ts" }],
    },
    parentUuid: "entry-1",
  },
];
writeFileSync(
  join(projectDir, `${sessionId}.jsonl`),
  entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
);
console.log(`fixture written to ${configDir}`);
