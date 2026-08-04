import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome, homeEnv, type HomeOverrideHandle } from "./helpers/env.js";
import { runCli, cliPath } from "./helpers/run-cli.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";

// The hook endpoints are the ONE sanctioned exception to the "every command
// prints exactly one JSON result" contract. `hub hook-session-end` prints
// nothing to stdout on every path and always exits 0, because a broken hub
// must never surface as a hook error when a user's session ends;
// `hub hook-session-start` prints nothing OR exactly one Claude Code hook-JSON
// object, and also always exits 0. Every CLI test below asserts the relevant
// pair (stdout, status === 0) explicitly.

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

/** A real, git-less project directory with the fixture session copied into its encoded config slot. */
function createRealProject(base: string, configDir: string, name: string): string {
  const proj = join(base, name);
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "README.md"), "hello\n");
  cpSync(
    join(configDir, "projects", FIXTURE_ENCODED),
    join(configDir, "projects", encodeProjectPath(proj)),
    { recursive: true }
  );
  return proj;
}

function writeSeshMoverConfig(dir: string, hub: Record<string, unknown>): void {
  const configDir = join(dir, ".claude-sesh-mover");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ hub }, null, 2) + "\n");
}

/** Pin the machine identity a spawned CLI will read out of `$HOME`. */
function writeMachineId(home: string, id: string, name: string): void {
  const dir = join(home, ".claude-sesh-mover");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "machine-id.json"),
    JSON.stringify({ id, name, createdAt: "2026-07-21T00:00:00Z" }, null, 2) + "\n"
  );
}

function linkProject(projectPath: string, projectId = "11111111-1111-4111-8111-111111111111"): void {
  const dir = join(projectPath, ".claude-sesh-mover");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify(
      { projectId, name: "proj", createdAt: "2026-07-21T00:00:00Z", createdByMachine: "m1" },
      null,
      2
    ) + "\n"
  );
}

describe("readHookPayload", () => {
  it("parses a Claude Code hook payload", async () => {
    const { readHookPayload } = await import("../src/hub/hooks.js");
    const p = readHookPayload(JSON.stringify({ cwd: "/x", session_id: "s", reason: "clear" }));
    expect(p.cwd).toBe("/x");
    expect(p.session_id).toBe("s");
    expect(p.reason).toBe("clear");
  });

  it("returns an empty payload on garbage instead of throwing", async () => {
    const { readHookPayload } = await import("../src/hub/hooks.js");
    expect(readHookPayload("not json")).toEqual({});
    expect(readHookPayload("")).toEqual({});
  });

  it("returns an empty payload for valid JSON that isn't an object", async () => {
    const { readHookPayload } = await import("../src/hub/hooks.js");
    // JSON.parse succeeds for these, so only a shape check catches them —
    // `null` in particular is typeof "object" and would otherwise flow on as
    // a payload whose property access throws.
    expect(readHookPayload("null")).toEqual({});
    expect(readHookPayload("42")).toEqual({});
    expect(readHookPayload('"a string"')).toEqual({});
    expect(readHookPayload("[1,2]")).toEqual({});
  });
});

describe("evaluateHookGate", () => {
  let tempDir: string;
  let home: string;
  let project: string;
  let hubDir: string;
  let restore: HomeOverrideHandle;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-hook-gate-"));
    home = join(tempDir, "home");
    project = join(tempDir, "proj");
    hubDir = join(tempDir, "hub");
    for (const d of [home, project, hubDir]) mkdirSync(d, { recursive: true });
    restore = overrideHome(home);
  });

  afterEach(() => {
    restore.restore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("declines with no-cwd when the payload carries no cwd", async () => {
    const { evaluateHookGate } = await import("../src/hub/hooks.js");
    expect(evaluateHookGate({}, "autoPush")).toEqual({ ok: false, reason: "no-cwd" });
  });

  it("declines with no-cwd for a non-string cwd instead of throwing", async () => {
    const { evaluateHookGate } = await import("../src/hub/hooks.js");
    // A hook payload is attacker-adjacent only in the sense that it is
    // untrusted JSON: a non-string cwd reaches join() and throws
    // ERR_INVALID_ARG_TYPE. evaluateHookGate is documented and consumed as a
    // pure data result (Task 6 calls it too), so it must decline, not throw.
    for (const cwd of [123, {}, ["a"], true, null]) {
      expect(evaluateHookGate({ cwd } as never, "autoPush")).toEqual({
        ok: false,
        reason: "no-cwd",
      });
    }
  });

  it("declines with no-hub when no hub is configured", async () => {
    const { evaluateHookGate } = await import("../src/hub/hooks.js");
    expect(evaluateHookGate({ cwd: project }, "autoPush")).toEqual({ ok: false, reason: "no-hub" });
  });

  it("declines with unlinked when a hub is configured but the project isn't linked", async () => {
    const { evaluateHookGate } = await import("../src/hub/hooks.js");
    writeSeshMoverConfig(home, { path: hubDir });
    expect(evaluateHookGate({ cwd: project }, "autoPush")).toEqual({
      ok: false,
      reason: "unlinked",
    });
  });

  it("declines with disabled when the project turns the flag off", async () => {
    const { evaluateHookGate } = await import("../src/hub/hooks.js");
    writeSeshMoverConfig(home, { path: hubDir });
    writeSeshMoverConfig(project, { autoPush: false });
    linkProject(project);
    expect(evaluateHookGate({ cwd: project }, "autoPush")).toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("declines with disabled when the user scope turns the flag off", async () => {
    const { evaluateHookGate } = await import("../src/hub/hooks.js");
    writeSeshMoverConfig(home, { path: hubDir, autoPush: false });
    linkProject(project);
    expect(evaluateHookGate({ cwd: project }, "autoPush").reason).toBe("disabled");
  });

  it("allows with defaults once a hub is configured and the project is linked", async () => {
    const { evaluateHookGate } = await import("../src/hub/hooks.js");
    writeSeshMoverConfig(home, { path: hubDir });
    linkProject(project);
    // Linking IS the consent gate: hub.autoPush defaults to true, so no extra
    // opt-in file is written here.
    expect(evaluateHookGate({ cwd: project }, "autoPush")).toEqual({
      ok: true,
      hubPath: hubDir,
      projectPath: project,
    });
  });

  it("treats a flag key that has no default as enabled, and honors an explicit false", async () => {
    const { evaluateHookGate } = await import("../src/hub/hooks.js");
    writeSeshMoverConfig(home, { path: hubDir });
    linkProject(project);
    // hub.startupNotice ships with Task 6; the gate must already answer for it
    // (default-on) and must respect an explicit opt-out written today.
    expect(evaluateHookGate({ cwd: project }, "startupNotice").ok).toBe(true);
    writeSeshMoverConfig(project, { startupNotice: false });
    expect(evaluateHookGate({ cwd: project }, "startupNotice")).toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("declines rather than throwing when the project's config file is corrupt", async () => {
    const { evaluateHookGate } = await import("../src/hub/hooks.js");
    const projConfigDir = join(project, ".claude-sesh-mover");
    mkdirSync(projConfigDir, { recursive: true });
    writeFileSync(join(projConfigDir, "config.json"), "{ not json");
    expect(evaluateHookGate({ cwd: project }, "autoPush")).toEqual({ ok: false, reason: "no-hub" });
  });
});

describe("hub hook-session-end (CLI)", () => {
  let tempDir: string;
  let home: string;
  let base: string;
  let hubDir: string;
  let configDir: string;
  let sessionId: string;
  let project: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-hook-cli-"));
    home = join(tempDir, "home");
    base = join(tempDir, "base");
    hubDir = join(tempDir, "hub");
    for (const d of [home, base, hubDir]) mkdirSync(d, { recursive: true });
    const fixture = createFixtureTree(base);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
    project = createRealProject(base, configDir, "proj");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runHook(input: string) {
    return runCli(["hub", "hook-session-end"], {
      env: { ...homeEnv(home), CLAUDE_CONFIG_DIR: configDir },
      input,
    });
  }

  it("exits 0 and prints NOTHING when no hub is configured", () => {
    const r = runHook(JSON.stringify({ cwd: project, session_id: sessionId, reason: "clear" }));
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("exits 0 and prints NOTHING when the stdin payload is malformed or empty", () => {
    const garbage = runHook("not json at all {{{");
    expect(garbage.stdout).toBe("");
    expect(garbage.stderr).toBe("");
    expect(garbage.status).toBe(0);

    const empty = runHook("");
    expect(empty.stdout).toBe("");
    expect(empty.stderr).toBe("");
    expect(empty.status).toBe(0);
  });

  it("exits 0 and prints NOTHING when the hub is configured but the project isn't linked", () => {
    writeSeshMoverConfig(home, { path: hubDir });
    const r = runHook(JSON.stringify({ cwd: project }));
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("exits 0 and prints NOTHING when hub.autoPush is turned off", () => {
    writeSeshMoverConfig(home, { path: hubDir });
    linkProject(project);
    // Project scope first, then user scope — both layers must be able to
    // switch the automation off without the hook making a sound.
    writeSeshMoverConfig(project, { autoPush: false });
    const projectScope = runHook(JSON.stringify({ cwd: project }));
    expect(projectScope.stdout).toBe("");
    expect(projectScope.stderr).toBe("");
    expect(projectScope.status).toBe(0);

    rmSync(join(project, ".claude-sesh-mover", "config.json"));
    writeSeshMoverConfig(home, { path: hubDir, autoPush: false });
    const userScope = runHook(JSON.stringify({ cwd: project }));
    expect(userScope.stdout).toBe("");
    expect(userScope.stderr).toBe("");
    expect(userScope.status).toBe(0);
  });

  it("still exits 0 when its stderr pipe is closed before the diagnostic is written", async () => {
    // SessionEnd fires while the parent Claude Code process is tearing down,
    // which is exactly when the hook's stdio pipes can be closed out from
    // under it. A diagnostic write onto a reader-less pipe EPIPEs
    // asynchronously; unhandled, that terminates the process with exit 1 and
    // breaks the "always exits 0" half of the hook contract.
    const notADir = join(tempDir, "hub-is-a-file-epipe");
    writeFileSync(notADir, "this is a file, not a hub directory\n");
    writeSeshMoverConfig(home, { path: notADir });
    linkProject(project);

    const child = spawn("node", [cliPath(), "hub", "hook-session-end"], {
      env: { ...process.env, ...homeEnv(home), CLAUDE_CONFIG_DIR: configDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    // Destroy the read end now: the endpoint only reaches its diagnostic
    // write after a config read, a lock acquire and a failed hub write, so
    // this always lands first.
    child.stderr.destroy();
    child.stdin.end(JSON.stringify({ cwd: project }));

    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(stdout).toBe("");
    expect(code).toBe(0);
  });

  it("pushes the project to the hub, printing nothing and exiting 0", async () => {
    const restore = overrideHome(home);
    let projectId: string;
    let machineId: string;
    try {
      const { hubInit } = await import("../src/hub/init.js");
      const init = await hubInit({ hubPath: hubDir, configScope: "user", cwd: home });
      expect(init.success).toBe(true);
      const { loadOrCreateMachineId } = await import("../src/machine.js");
      const { createFsBackend } = await import("../src/hub/backend.js");
      const { createHubProject } = await import("../src/hub/identity.js");
      machineId = loadOrCreateMachineId().id;
      // Link without pushing, so the bundle asserted below can only have been
      // written by the hook run itself.
      projectId = (await createHubProject(createFsBackend(hubDir), project, machineId)).projectId;
    } finally {
      restore.restore();
    }

    const r = runHook(JSON.stringify({ cwd: project, session_id: sessionId, reason: "clear" }));
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);

    const { createFsBackend } = await import("../src/hub/backend.js");
    const { bundleDir, indexPath } = await import("../src/hub/layout.js");
    const backend = createFsBackend(hubDir);
    const bundles = await backend.list(bundleDir(projectId, machineId));
    expect(bundles.length).toBeGreaterThan(0);
    expect(await backend.exists(indexPath(projectId, machineId))).toBe(true);
  });

  it("stays completely silent when another hub operation holds the project lock", async () => {
    writeSeshMoverConfig(home, { path: hubDir });
    linkProject(project);
    const restore = overrideHome(home);
    const { acquireProjectLock } = await import("../src/hub/lock.js");
    const lock = acquireProjectLock(project);
    try {
      const r = runHook(JSON.stringify({ cwd: project }));
      expect(r.stdout).toBe("");
      // lock-busy is a NORMAL outcome (another operation is already doing the
      // work), not an error — it must not produce a stderr diagnostic either.
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    } finally {
      lock.release();
      restore.restore();
    }
  });

  it("exits 0 with empty stdout but a stderr diagnostic when the push fails", () => {
    const notADir = join(tempDir, "hub-is-a-file");
    writeFileSync(notADir, "this is a file, not a hub directory\n");
    writeSeshMoverConfig(home, { path: notADir });
    linkProject(project);

    const r = runHook(JSON.stringify({ cwd: project }));
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
    expect(r.stderr.trim()).not.toBe("");
    expect(r.stderr).toMatch(/sesh-mover auto-push/);
  });

  it("exits 0 without waiting forever when stdin is never closed", async () => {
    // Claude Code itself always does `stdin.write(payload); stdin.end()` (both
    // its sync and its async hook paths do), so in the real integration stdin
    // closes immediately. This test pins the OTHER caller: anything that opens
    // the pipe and doesn't close it — a wrapper script, a shell redirect from
    // a long-lived process, an operator experimenting. Reading stdin happens
    // BEFORE the gate, so without a bound this hangs even on a machine with no
    // hub configured at all, and SessionEnd hooks only get a 1.5s budget
    // before Claude Code force-exits the session.
    const started = Date.now();
    const child = spawn("node", [cliPath(), "hub", "hook-session-end"], {
      env: { ...process.env, ...homeEnv(home), CLAUDE_CONFIG_DIR: configDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.resume();
    // Deliberately never write to and never end child.stdin.
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(stdout).toBe("");
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(15000);
  }, 25000);
});

describe("hub hook-session-start (CLI)", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  let tempDir: string;
  let home: string;
  let base: string;
  let hubDir: string;
  let configDir: string;
  let project: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-hook-start-"));
    home = join(tempDir, "home");
    base = join(tempDir, "base");
    hubDir = join(tempDir, "hub");
    for (const d of [home, base, hubDir]) mkdirSync(d, { recursive: true });
    const fixture = createFixtureTree(base);
    configDir = fixture.configDir;
    project = createRealProject(base, configDir, "proj");
    // Pin this machine's identity so the child CLI resolves a known id rather
    // than minting a random one — "is the latest copy mine?" is the whole
    // question this endpoint answers.
    writeMachineId(home, ME, "my-laptop");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runHook(input: string) {
    return runCli(["hub", "hook-session-start"], {
      env: { ...homeEnv(home), CLAUDE_CONFIG_DIR: configDir },
      input,
    });
  }

  /** A hub index file for `machineId` holding exactly one thread. */
  function writeIndex(
    machineId: string,
    threadId: string,
    over: Partial<{
      localSessionId: string;
      slug: string;
      summary: string;
      headEntryUuid: string;
      lastActiveAt: string;
      messageCount: number;
    }> = {}
  ): void {
    const dir = join(hubDir, "projects", PROJECT_ID, "index");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${machineId}.json`),
      JSON.stringify(
        {
          schemaVersion: 1,
          agent: "claude-code",
          projectId: PROJECT_ID,
          machineId,
          updatedAt: "2026-07-21T00:00:00Z",
          projectPath: project,
          threads: {
            [threadId]: {
              localSessionId: "s-local",
              slug: "hub-slice-two",
              summary: "Hub slice two work",
              headEntryUuid: "h1",
              messageCount: 4,
              lastActiveAt: "2026-07-21T00:00:00Z",
              bundles: [],
              ...over,
            },
          },
        },
        null,
        2
      ) + "\n"
    );
  }

  function writeHubMachine(id: string, name: string): void {
    const dir = join(hubDir, "machines");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ id, name, platform: "linux", lastSeenAt: "2026-07-21T00:00:00Z" }, null, 2) +
        "\n"
    );
  }

  it("exits 0 and prints NOTHING when no hub is configured", () => {
    const r = runHook(JSON.stringify({ cwd: project, session_id: "s", source: "startup" }));
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("exits 0 and prints NOTHING when the payload is malformed or empty", () => {
    for (const input of ["not json at all {{{", "", "null"]) {
      const r = runHook(input);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    }
  });

  it("exits 0 and prints NOTHING when the project isn't linked", () => {
    writeSeshMoverConfig(home, { path: hubDir });
    const r = runHook(JSON.stringify({ cwd: project, source: "startup" }));
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("exits 0 and prints NOTHING when hub.startupNotice is turned off", () => {
    writeSeshMoverConfig(home, { path: hubDir });
    linkProject(project, PROJECT_ID);
    writeHubMachine(ME, "my-laptop");
    writeHubMachine(OTHER, "office-desktop");
    // Arrangement that WOULD produce a notice, so the only thing suppressing
    // it here is the opt-out itself.
    writeIndex(OTHER, "t-shared", { lastActiveAt: "2026-07-21T09:00:00Z" });

    writeSeshMoverConfig(project, { startupNotice: false });
    const projectScope = runHook(JSON.stringify({ cwd: project, source: "startup" }));
    expect(projectScope.stdout).toBe("");
    expect(projectScope.status).toBe(0);

    rmSync(join(project, ".claude-sesh-mover", "config.json"));
    writeSeshMoverConfig(home, { path: hubDir, startupNotice: false });
    const userScope = runHook(JSON.stringify({ cwd: project, source: "startup" }));
    expect(userScope.stdout).toBe("");
    expect(userScope.status).toBe(0);
  });

  it("exits 0 and prints NOTHING when nothing is newer elsewhere", () => {
    writeSeshMoverConfig(home, { path: hubDir });
    linkProject(project, PROJECT_ID);
    writeHubMachine(ME, "my-laptop");
    // Only this machine has pushed: the latest copy of the only thread is
    // already the local one, so there is nothing to announce.
    writeIndex(ME, "t-mine");

    const r = runHook(JSON.stringify({ cwd: project, source: "startup" }));
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("exits 0 and prints NOTHING when the other machine's copy is the one we already have", () => {
    writeSeshMoverConfig(home, { path: hubDir });
    linkProject(project, PROJECT_ID);
    writeHubMachine(ME, "my-laptop");
    writeHubMachine(OTHER, "office-desktop");
    // Same headEntryUuid on both copies: the remote is nominally "latest" by
    // timestamp, but we are not behind it, so a notice would be a lie.
    writeIndex(ME, "t-shared", { headEntryUuid: "same", lastActiveAt: "2026-07-20T00:00:00Z" });
    writeIndex(OTHER, "t-shared", {
      headEntryUuid: "same",
      lastActiveAt: "2026-07-21T00:00:00Z",
      localSessionId: "s-remote",
    });

    const r = runHook(JSON.stringify({ cwd: project, source: "startup" }));
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  it("emits hook JSON naming the thread and machine when a newer copy exists elsewhere", () => {
    writeSeshMoverConfig(home, { path: hubDir });
    linkProject(project, PROJECT_ID);
    writeHubMachine(ME, "my-laptop");
    writeHubMachine(OTHER, "office-desktop");
    writeIndex(ME, "t-mine", { slug: "local-only", lastActiveAt: "2026-07-01T00:00:00Z" });
    writeIndex(OTHER, "t-shared", {
      slug: "hub-slice-two",
      localSessionId: "s-remote",
      headEntryUuid: "h-remote",
      lastActiveAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    });

    const r = runHook(JSON.stringify({ cwd: project, source: "startup" }));
    expect(r.status).toBe(0);

    // Exactly ONE hook-JSON object, in the shape Claude Code's SessionStart
    // hook output schema accepts (verified against the installed build's own
    // zod schema, not from memory):
    //   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const context: string = parsed.hookSpecificOutput.additionalContext;
    expect(typeof context).toBe("string");
    // Names the thread and the machine that holds the newer copy — a notice
    // that says only "something is newer" is not actionable.
    expect(context).toContain("hub-slice-two");
    expect(context).toContain("office-desktop");
    // Points at the command that resolves it.
    expect(context).toMatch(/pull/i);
    // The thread this machine already owns is not stale, so it is not named.
    expect(context).not.toContain("local-only");
  });

  it("names the most recent stale thread and counts the rest", () => {
    writeSeshMoverConfig(home, { path: hubDir });
    linkProject(project, PROJECT_ID);
    writeHubMachine(ME, "my-laptop");
    writeHubMachine(OTHER, "office-desktop");
    const dir = join(hubDir, "projects", PROJECT_ID, "index");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${OTHER}.json`),
      JSON.stringify({
        schemaVersion: 1,
        agent: "claude-code",
        projectId: PROJECT_ID,
        machineId: OTHER,
        updatedAt: "2026-07-21T00:00:00Z",
        projectPath: project,
        threads: {
          // Insertion order deliberately puts the OLDER thread first, so a
          // naive stale[0] would name the wrong one.
          "t-old": {
            localSessionId: "s1", slug: "older-thread", summary: "old",
            headEntryUuid: "h1", messageCount: 2,
            lastActiveAt: "2026-01-01T00:00:00Z", bundles: [],
          },
          "t-new": {
            localSessionId: "s2", slug: "newest-thread", summary: "new",
            headEntryUuid: "h2", messageCount: 9,
            lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString(), bundles: [],
          },
        },
      }, null, 2) + "\n"
    );

    const r = runHook(JSON.stringify({ cwd: project, source: "resume" }));
    expect(r.status).toBe(0);
    const context: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain("newest-thread");
    expect(context).not.toContain("older-thread");
    expect(context).toContain("1 more");
  });

  it("prints NOTHING and exits 0 when the hub directory is unreadable", () => {
    const notADir = join(tempDir, "hub-is-a-file");
    writeFileSync(notADir, "this is a file, not a hub directory\n");
    writeSeshMoverConfig(home, { path: notADir });
    linkProject(project, PROJECT_ID);

    const r = runHook(JSON.stringify({ cwd: project, source: "startup" }));
    // A hub problem must degrade to silence at session start, never to a
    // half-written object on stdout that Claude Code would fail to parse.
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  it("prints NOTHING and exits 0 when an index file on the hub is corrupt", () => {
    writeSeshMoverConfig(home, { path: hubDir });
    linkProject(project, PROJECT_ID);
    writeHubMachine(ME, "my-laptop");
    const dir = join(hubDir, "projects", PROJECT_ID, "index");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${OTHER}.json`), "{ torn");

    const r = runHook(JSON.stringify({ cwd: project, source: "startup" }));
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  it("exits 0 without waiting forever when stdin is never closed", async () => {
    const started = Date.now();
    const child = spawn("node", [cliPath(), "hub", "hook-session-start"], {
      env: { ...process.env, ...homeEnv(home), CLAUDE_CONFIG_DIR: configDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.resume();
    // Deliberately never write to and never end child.stdin.
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(stdout).toBe("");
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(15000);
  }, 25000);
});
