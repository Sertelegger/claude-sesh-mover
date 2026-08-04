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
// prints exactly one JSON result" contract: `hub hook-session-end` prints
// nothing to stdout on every path and always exits 0, because a broken hub
// must never surface as a hook error when a user's session ends. Every CLI
// test below asserts that pair (stdout === "", status === 0) explicitly.

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
});
