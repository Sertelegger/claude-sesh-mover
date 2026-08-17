import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
  cpSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir, platform } from "node:os";
import * as tar from "tar";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";
import { exitCodeForResult, type CliResult } from "../src/types.js";
import { overrideHome, homeEnv, prependPath, tmpEnv } from "./helpers/env.js";
import { readTextLf } from "./helpers/eol.js";
import { runCli as sharedRunCli, type RunCliResult } from "./helpers/run-cli.js";

const isWindows = platform() === "win32";

describe("cli", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-cli-test-"));
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Thin wrapper over the shared helper that pins this suite's fixture config
  // dir (still overridable per call). String form returns stdout and throws on
  // a non-zero exit; array form returns { stdout, stderr, status }.
  function runCli(args: string, envOverrides?: Record<string, string>): string;
  function runCli(
    args: string[],
    envOverrides?: Record<string, string>
  ): RunCliResult;
  function runCli(
    args: string | string[],
    envOverrides?: Record<string, string>
  ): string | RunCliResult {
    // This wrapper's second parameter is a flat ENV RECORD, not the shared
    // helper's options object. Handing it `{ env: …, cwd: … }` silently sets
    // two environment variables named "env" and "cwd" instead — the child then
    // runs against the DEVELOPER'S REAL HOME, and a `hub init --scope user` in
    // a test rewrites their actual config. That happened; this is the guard.
    for (const [k, v] of Object.entries(envOverrides ?? {})) {
      if (typeof v !== "string") {
        throw new TypeError(
          `runCli env override "${k}" must be a string — this wrapper takes a flat env record, not RunCliOptions. Use the imported sharedRunCli for cwd/input.`
        );
      }
    }
    const env = { CLAUDE_CONFIG_DIR: configDir, ...envOverrides };
    return Array.isArray(args)
      ? sharedRunCli(args, { env })
      : sharedRunCli(args, { env });
  }

  describe("export command", () => {
    it("exports current session as JSON output", () => {
      const outputDir = join(tempDir, "cli-export");
      mkdirSync(outputDir, { recursive: true });
      const output = runCli(
        `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format dir --name cli-test --output "${outputDir}"`
      );
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.command).toBe("export");
    });

    it("removes staging directory when format is archive", () => {
      const outputDir = join(tempDir, "cli-archive");
      mkdirSync(outputDir, { recursive: true });
      const output = runCli(
        `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format archive --name archive-test --output "${outputDir}"`
      );
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.archivePath).toMatch(/\.tar\.gz$/);
      expect(existsSync(result.archivePath)).toBe(true);
      const stagingDir = join(outputDir, "archive-test");
      expect(existsSync(stagingDir)).toBe(false);
      expect(result.exportPath).toBe(result.archivePath);
    });

    it("accepts --format tar.gz as alias for archive", () => {
      const outputDir = join(tempDir, "cli-targz");
      mkdirSync(outputDir, { recursive: true });
      const output = runCli(
        `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format tar.gz --name targz-test --output "${outputDir}"`
      );
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.archivePath).toMatch(/\.tar\.gz$/);
      expect(existsSync(result.archivePath)).toBe(true);
      expect(existsSync(join(outputDir, "targz-test"))).toBe(false);
    });

    it("accepts --format tar.zst as alias for zstd", () => {
      const outputDir = join(tempDir, "cli-tarzst");
      mkdirSync(outputDir, { recursive: true });
      const output = runCli(
        `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format tar.zst --name tarzst-test --output "${outputDir}"`
      );
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      // If zstd is not available it falls back to gzip and warns; either way archivePath must exist.
      expect(result.archivePath).toMatch(/\.tar\.(zst|gz)$/);
      expect(existsSync(result.archivePath)).toBe(true);
      expect(existsSync(join(outputDir, "tarzst-test"))).toBe(false);
    });

    it("rejects invalid --format values with an error", () => {
      const outputDir = join(tempDir, "cli-badfmt");
      mkdirSync(outputDir, { recursive: true });
      let caught: { stdout: string; status: number } | null = null;
      try {
        runCli(
          `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format bogus --name bad-test --output "${outputDir}"`
        );
      } catch (e) {
        const err = e as { stdout?: Buffer; status?: number };
        caught = {
          stdout: err.stdout ? err.stdout.toString() : "",
          status: err.status ?? 0,
        };
      }
      expect(caught).not.toBeNull();
      // Class 1, bad invocation (#76). Was `not.toBe(0)`; tightened because the
      // exit code is now a stated contract rather than a side effect.
      expect(caught!.status).toBe(1);
      const result = JSON.parse(caught!.stdout);
      expect(result.success).toBe(false);
      expect(result.command).toBe("export");
      expect(result.error).toMatch(/format/i);
    });

    it("rejects invalid --scope values with an error", () => {
      const outputDir = join(tempDir, "cli-badscope");
      mkdirSync(outputDir, { recursive: true });
      let caught: { stdout: string; status: number } | null = null;
      try {
        runCli(
          `export --scope project --session-id ${sessionId} --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format dir --name bad-scope --output "${outputDir}"`
        );
      } catch (e) {
        const err = e as { stdout?: Buffer; status?: number };
        caught = {
          stdout: err.stdout ? err.stdout.toString() : "",
          status: err.status ?? 0,
        };
      }
      expect(caught).not.toBeNull();
      expect(caught!.status).toBe(1); // bad invocation (#76)
      const result = JSON.parse(caught!.stdout);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/scope/i);
    });

    it("records sessionScope=all in manifest when --scope all", () => {
      const outputDir = join(tempDir, "cli-scope-all");
      mkdirSync(outputDir, { recursive: true });
      const output = runCli(
        `export --scope all --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format dir --name scope-all-test --output "${outputDir}"`
      );
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      const manifestPath = join(outputDir, "scope-all-test", "manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf-8")
      );
      expect(manifest.sessionScope).toBe("all");
    });

    it("suffix collision path still produces an archive", () => {
      const outputDir = join(tempDir, "cli-suffix-archive");
      mkdirSync(outputDir, { recursive: true });
      const base = `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format archive --name suffixed --output "${outputDir}"`;
      // First export creates suffixed.tar.gz; staging dir "suffixed" is removed,
      // so create a directory with that name to force the collision branch.
      runCli(base);
      mkdirSync(join(outputDir, "suffixed"), { recursive: true });
      const output = runCli(`${base} --suffix`);
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      // Old code returned early from the suffix branch and never archived.
      expect(result.archivePath).toMatch(/suffixed-2\.tar\.gz$/);
      expect(existsSync(result.archivePath)).toBe(true);
      expect(existsSync(join(outputDir, "suffixed-2"))).toBe(false);
    });

    it("--no-summary keeps conversation text out of the manifest", () => {
      const outputDir = join(tempDir, "cli-nosummary");
      mkdirSync(outputDir, { recursive: true });
      const output = runCli(
        `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format dir --name nosum --output "${outputDir}" --no-summary`
      );
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(outputDir, "nosum", "manifest.json"), "utf-8")
      );
      expect(manifest.sessions[0].summary).toBe("test-session");
    });

    it("detects a name collision with an existing archive artifact", () => {
      const outputDir = join(tempDir, "cli-archive-collision");
      mkdirSync(outputDir, { recursive: true });
      const base = `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format archive --name arch-col --output "${outputDir}"`;
      runCli(base); // creates arch-col.tar.gz; staging dir removed
      const second = JSON.parse(runCli(base)); // old code silently overwrote
      expect(second.success).toBe(true);
      expect(second.collision).toBe(true);
      // --suffix resolves it
      const third = JSON.parse(runCli(`${base} --suffix`));
      expect(third.success).toBe(true);
      expect(third.archivePath).toMatch(/arch-col-2\.tar\.gz$/);
    });

    /**
     * The command-level half of the config-merge fix (57cd7b7, #29).
     *
     * `readConfig` backfills defaults even for a file that does not exist, so
     * merging two independently backfilled layers reset every user-scope-only
     * setting to its default whenever the project scope simply had no config
     * file — the ordinary case. `computeEffectiveConfig` layers raw file
     * contents instead, and `tests/config.test.ts` pins that at unit level.
     *
     * What nothing pinned is the WIRING: `cli.ts`'s `loadEffectiveConfig` is
     * what `export` and `migrate` call, and no export test could catch a
     * regression there because every one of them passes `--format`/`--storage`
     * explicitly, so config is bypassed. This one deliberately passes neither.
     *
     * Through `sharedRunCli` with an explicit `cwd`, because the project layer
     * is read from `process.cwd()` — the local wrapper cannot express that, and
     * an unset cwd would read the developer's own repo as the project scope.
     */
    it("honours a user-scope-only export setting when the project has no config file", () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cfg-export-home-"));
      const project = mkdtempSync(join(tmpdir(), "sesh-cfg-export-proj-"));
      const outputDir = mkdtempSync(join(tmpdir(), "sesh-cfg-export-out-"));
      try {
        const env = { env: { CLAUDE_CONFIG_DIR: configDir, ...homeEnv(home) }, cwd: project };
        const set = JSON.parse(
          sharedRunCli(["configure", "--scope", "user", "--set", "export.format=archive"], env).stdout
        );
        expect(set.success).toBe(true);
        expect(set.config.export.format).toBe("archive");
        // The condition the defect needed, asserted rather than assumed: the
        // project scope has no file at all. A `.sesh-mover/` here would make
        // this test pass for the wrong reason.
        expect(existsSync(join(project, ".sesh-mover"))).toBe(false);

        const result = JSON.parse(
          sharedRunCli(
            [
              "export", "--scope", "current", "--session-id", sessionId,
              "--source-config-dir", configDir,
              "--project-path", "/Users/testuser/Projects/testproject",
              "--name", "cfgmerge", "--output", outputDir,
              // No --format and no --storage: the whole point is that the
              // effective config decides, which is the code path a regression
              // in loadEffectiveConfig would break.
            ],
            env
          ).stdout
        );
        expect(result.success).toBe(true);
        // "archive" survived the absent project layer. Under the old merge this
        // read back as the default "dir" and produced a plain directory.
        expect(result.archivePath).toMatch(/cfgmerge\.tar\.gz$/);
        expect(result.exportPath).toBe(result.archivePath);
        expect(existsSync(result.archivePath)).toBe(true);
      } finally {
        for (const d of [home, project, outputDir]) rmSync(d, { recursive: true, force: true });
      }
    });
  });

  describe("pull command", () => {
    it("rejects invalid --on-divergence values before any hub lookup", () => {
      let caught: { stdout: string; status: number } | null = null;
      try {
        runCli(`pull --latest --on-divergence bogus --source-config-dir "${configDir}"`);
      } catch (e) {
        const err = e as { stdout?: Buffer; status?: number };
        caught = { stdout: err.stdout ? err.stdout.toString() : "", status: err.status ?? 0 };
      }
      expect(caught).not.toBeNull();
      // The reference case for class 1 in #76's decision: argument validation.
      expect(caught!.status).toBe(1);
      const result = JSON.parse(caught!.stdout);
      expect(result.success).toBe(false);
      expect(result.command).toBe("pull");
      // Not the "no hub configured" error: the bad mode is reported on its own
      // terms, whether or not a hub happens to be set up.
      expect(result.error).toMatch(/on-divergence/i);
      expect(result.error).toMatch(/adopt-hub/);
    });

    it("--apply-carry reaches the working tree, and its absence parks the payload", async () => {
      // Exercised through the built CLI on purpose: `--apply-carry` is a
      // src/cli.ts wiring, and a mutation there is invisible to every test that
      // calls hubPull directly.
      const homeA = mkdtempSync(join(tmpdir(), "sesh-cli-ac-homeA-"));
      const homeB = mkdtempSync(join(tmpdir(), "sesh-cli-ac-homeB-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-cli-ac-hub-"));
      const cloneRoot = mkdtempSync(join(tmpdir(), "sesh-cli-ac-clone-"));
      const configDirB = join(homeB, ".claude");
      const projectPath = join(tempDir, "acproj");
      mkdirSync(projectPath, { recursive: true });
      const { writeLocalProjectId } = await import("../src/hub/identity.js");
      try {
        cpSync(
          join(configDir, "projects", "-Users-testuser-Projects-testproject"),
          join(configDir, "projects", encodeProjectPath(projectPath)),
          { recursive: true }
        );
        const g = (args: string[], cwd = projectPath): void => {
          execFileSync("git", args, { cwd, stdio: "ignore" });
        };
        g(["init", "-q"]);
        g(["config", "user.email", "t@example.com"]);
        g(["config", "user.name", "Test"]);
        g(["remote", "add", "origin", "https://github.com/User/Repo.git"]);
        writeFileSync(join(projectPath, "tracked.txt"), "v1\n");
        g(["add", "-A"]);
        g(["commit", "-q", "-m", "init"]);
        const clone = join(cloneRoot, "acclone");
        execFileSync("git", ["clone", "-q", projectPath, clone], { stdio: "ignore" });
        writeFileSync(join(projectPath, "tracked.txt"), "v2 uncommitted\n");

        runCli(["hub", "init", "--path", hubDir], homeEnv(homeA));
        const push = JSON.parse(
          runCli(
            ["push", "--project-path", projectPath, "--create-project", "--source-config-dir", configDir],
            homeEnv(homeA)
          ).stdout
        );
        expect(push.success).toBe(true);

        runCli(["hub", "init", "--path", hubDir], homeEnv(homeB));
        writeLocalProjectId(clone, {
          projectId: push.projectId, name: "acproj",
          createdAt: new Date().toISOString(), createdByMachine: "machine-a",
        });

        const pulled = JSON.parse(
          runCli(
            [
              "pull", "--latest", "--apply-carry",
              "--project-path", clone, "--source-config-dir", configDirB,
            ],
            { ...homeEnv(homeB), CLAUDE_CONFIG_DIR: configDirB }
          ).stdout
        );
        expect(pulled.success).toBe(true);
        expect(pulled.carryApplied.applied).toBe(true);
        // Tracked, and `git apply` wrote it — so the clone's own EOL convention
        // decides its line endings on Windows. See helpers/eol.ts.
        expect(readTextLf(join(clone, "tracked.txt"))).toBe("v2 uncommitted\n");
      } finally {
        for (const d of [homeA, homeB, hubDir, cloneRoot]) {
          rmSync(d, { recursive: true, force: true });
        }
      }
    });

    /**
     * "Already up to date" AT CLI LEVEL (#29, exit code revised by #76).
     *
     * Module-level coverage of this refusal is good, but no in-process
     * `hubPull` test can observe what `commands/pull.md` actually tells the
     * skill layer to read: exactly one JSON object on stdout, and an exit code.
     * Both are `src/cli.ts` wiring.
     *
     * Two things worth knowing before changing this test. First, the refusal is
     * `success: false`, NOT a `success: true` no-op — so a caller that branches
     * on `success` alone reports a routine second pull as a failure unless it
     * reads `error`. Second, it exits **2**, the refusal class.
     *
     * THAT SECOND ASSERTION WAS `0` UNTIL #76, and the change is deliberate
     * rather than a test bent to fit new behavior. It pinned the old accident:
     * `output()` wrote the body and returned, `outputError()` exited 1, so which
     * exit a result took was decided by which helper its call site happened to
     * reach — and `success: false` therefore did not imply a non-zero exit. The
     * comment here used to spell that out and end "an exit code cannot be used
     * to detect a failed pull", which is exactly the property #76 removes.
     * Everything else this test proved is unchanged and still asserted below.
     */
    it("a second identical pull is a success:false 'already up to date' refusal that exits 2", async () => {
      const homeA = mkdtempSync(join(tmpdir(), "sesh-cli-up-homeA-"));
      const homeB = mkdtempSync(join(tmpdir(), "sesh-cli-up-homeB-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-cli-up-hub-"));
      const targetRoot = mkdtempSync(join(tmpdir(), "sesh-cli-up-target-"));
      const configDirB = join(homeB, ".claude");
      // Its own directory, not tempDir: the fixture config dir lives under
      // tempDir and a push of tempDir would snapshot it.
      const projectPath = join(tempDir, "upproj");
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(join(projectPath, "README.md"), "hello\n");
      const { writeLocalProjectId } = await import("../src/hub/identity.js");
      try {
        cpSync(
          join(configDir, "projects", "-Users-testuser-Projects-testproject"),
          join(configDir, "projects", encodeProjectPath(projectPath)),
          { recursive: true }
        );

        runCli(["hub", "init", "--path", hubDir], homeEnv(homeA));
        const push = JSON.parse(
          runCli(
            ["push", "--project-path", projectPath, "--create-project", "--source-config-dir", configDir],
            homeEnv(homeA)
          ).stdout
        );
        expect(push.success).toBe(true);

        runCli(["hub", "init", "--path", hubDir], homeEnv(homeB));
        const target = join(targetRoot, "uptarget");
        mkdirSync(target, { recursive: true });
        writeLocalProjectId(target, {
          projectId: push.projectId, name: "upproj",
          createdAt: new Date().toISOString(), createdByMachine: "machine-a",
        });

        const envB = { ...homeEnv(homeB), CLAUDE_CONFIG_DIR: configDirB };
        const args = ["pull", "--latest", "--project-path", target, "--source-config-dir", configDirB];
        const first = runCli(args, envB);
        expect(first.status).toBe(0);
        const firstResult = JSON.parse(first.stdout);
        expect(firstResult.success).toBe(true);
        expect(firstResult.importedSessions).toHaveLength(1);

        // The identical invocation again — the ordinary "did anything change?"
        // re-run, not an error case.
        const second = runCli(args, envB);
        const secondResult = JSON.parse(second.stdout); // throws unless stdout is exactly one JSON doc
        expect(secondResult.success).toBe(false);
        expect(secondResult.command).toBe("pull");
        expect(secondResult.suggestion).toBeTruthy();
        // The refusal class (#76). `|| handle_failure` in a shell now sees it.
        expect(second.status).toBe(2);
        // `--latest` selects across threads, so it stops at the PLURAL exit —
        // receipt-shaped, deliberately not a claim about heads.
        //
        // Deliberately NOT also asserting the singular exit's wording ("Already
        // up to date with the source machine.") by re-running with `--thread
        // <id>`: after this pull both machines hold the same head with the same
        // lastActiveAt, so which one `resolveThreads` calls `latest` comes down
        // to a tiebreak over two randomly generated machine ids, and the
        // singular refusal is worded from that choice — "Already up to date
        // with the source machine." when A wins, "The latest copy of this
        // thread is already local." when B does. Measured: it alternates
        // between runs. Both are correct; neither is pinnable here.
        expect(secondResult.error).toBe(
          "Nothing to pull: every bundle the machine each thread resolves to lists has already been received here."
        );
        // A refusal applies nothing: no second copy of the session landed.
        const sessions = readdirSync(
          join(configDirB, "projects", encodeProjectPath(target))
        ).filter((f) => f.endsWith(".jsonl"));
        expect(sessions).toHaveLength(1);
      } finally {
        for (const d of [homeA, homeB, hubDir, targetRoot]) {
          rmSync(d, { recursive: true, force: true });
        }
      }
    });

    /**
     * A `--project-id` naming no hub project: a typed refusal, before anything
     * happens (#29).
     *
     * It used to escape as whatever `readHubProjectAsLocal` threw — an
     * `assertSafeHubId` message for a path-unsafe id, a raw `ENOENT` carrying
     * the hub's absolute path for a well-formed one — through the generic outer
     * catch, with no `reason` and no candidates. The irony was exact: the typed
     * `unlinked` refusal's own suggestion is "Pass --project-id <id>", and
     * following it with a wrong id dropped the caller off the typed path.
     */
    it("refuses an unknown --project-id with a typed result and a pick list, leaking no hub path", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-badid-home-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-cli-badid-hub-"));
      const project = mkdtempSync(join(tmpdir(), "sesh-cli-badid-proj-"));
      const { createFsBackend } = await import("../src/hub/backend.js");
      const { projectJsonPath } = await import("../src/hub/layout.js");
      try {
        runCli(["hub", "init", "--path", hubDir], homeEnv(home));
        const realId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        await createFsBackend(hubDir).writeAtomic(
          projectJsonPath(realId),
          JSON.stringify({
            schemaVersion: 1, projectId: realId, name: "a-real-project",
            matchers: { gitRemotes: ["github.com/user/repo"] },
            createdAt: "2026-08-01T00:00:00Z", createdByMachine: "m1",
          }) + "\n"
        );

        const missingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const missing = runCli(
          ["pull", "--latest", "--project-path", project, "--project-id", missingId,
            "--source-config-dir", configDir],
          homeEnv(home)
        );
        const result = JSON.parse(missing.stdout);
        expect(result.success).toBe(false);
        expect(result.command).toBe("pull");
        expect(result.reason).toBe("no-such-project");
        expect(result.requestedProjectId).toBe(missingId);
        // The pick list the raw throw could never carry.
        expect(result.linkCandidates).toHaveLength(1);
        expect(result.linkCandidates[0].projectId).toBe(realId);
        expect(result.linkCandidates[0].name).toBe("a-real-project");
        // Non-zero, and the BODY is a shape rather than an error string, with
        // nothing echoing the hub's absolute path back out (the old ENOENT
        // message did).
        //
        // The CODE changed from 1 to 2 in #76 and the argument moved with it.
        // This comment said "a bad invocation, so it still exits non-zero",
        // which is one defensible reading of `--project-id <nonexistent>` — but
        // the owner's mapping puts `no-such-project` in the refusal class, and
        // that is the more useful line for a shell caller: nothing happened, the
        // hub was reachable, and the body carries a pick list to choose from.
        // Class 1 is reserved for what did not get that far.
        expect(missing.status).toBe(2);
        expect(missing.stdout).not.toContain(hubDir);
        expect(result.error).toBeUndefined();

        // Second flavour, same answer: an id that is not path-safe at all. This
        // one threw out of assertSafeHubId rather than out of the read.
        const unsafe = runCli(
          ["pull", "--latest", "--project-path", project, "--project-id", "../../etc",
            "--source-config-dir", configDir],
          homeEnv(home)
        );
        const unsafeResult = JSON.parse(unsafe.stdout);
        expect(unsafeResult.reason).toBe("no-such-project");
        expect(unsafeResult.requestedProjectId).toBe("../../etc");
        expect(unsafe.status).toBe(2);

        // ...and nothing was linked by either attempt.
        expect(existsSync(join(project, ".sesh-mover-project.json"))).toBe(false);
      } finally {
        for (const d of [home, hubDir, project]) rmSync(d, { recursive: true, force: true });
      }
    });

    /**
     * The other half of that gate: an id is only "unknown" if the HUB could be
     * asked. On an unmounted share or a sync client mid-copy every read fails,
     * including the validating one — answering `no-such-project` there would be
     * a confident wrong diagnosis with a wrong remedy (fix an id that is fine).
     * The pre-flight stands down and the verb reports the hub problem instead.
     */
    it("does not blame the --project-id when the hub itself is unreachable", () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-nohub-id-home-"));
      const project = mkdtempSync(join(tmpdir(), "sesh-cli-nohub-id-proj-"));
      try {
        const gone = join(home, "not-mounted");
        runCli(["configure", "--scope", "user", "--set", `hub.path=${gone}`], homeEnv(home));
        const { stdout } = runCli(
          ["pull", "--latest", "--project-path", project, "--project-id",
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "--source-config-dir", configDir],
          homeEnv(home)
        );
        const result = JSON.parse(stdout);
        expect(result.success).toBe(false);
        expect(result.reason).not.toBe("no-such-project");
      } finally {
        for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
      }
    });

    /**
     * #75 — what that hub problem now reads as, through the real CLI.
     *
     * Until this, an unreachable `hub.path` threw a raw `ENOENT` out of push and
     * pull alike, which the generic outer catch turned into an untyped
     * `{error: "ENOENT: no such file or directory, open '<hub>/hub.json'"}`. Two
     * things were wrong with that and both are asserted here: the skill layer
     * had no `reason` to branch on while every other hub failure has one, and
     * the message volunteered the hub's absolute path.
     *
     * Through the BUILT CLI rather than by calling `hubPull`, because half the
     * claim is about the process boundary: exactly one JSON object on stdout and
     * no exception text anywhere in it.
     */
    it("reports an unreachable hub as one typed JSON object naming no path", () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-gonehub-home-"));
      const project = mkdtempSync(join(tmpdir(), "sesh-cli-gonehub-proj-"));
      try {
        const gone = join(home, "not-mounted");
        runCli(["configure", "--scope", "user", "--set", `hub.path=${gone}`], homeEnv(home));

        for (const argv of [
          ["pull", "--latest", "--project-path", project, "--source-config-dir", configDir],
          ["push", "--project-path", project, "--source-config-dir", configDir],
        ]) {
          const { stdout, status } = runCli(argv, homeEnv(home));
          // Throws if stdout is not exactly one JSON document.
          const result = JSON.parse(stdout);
          expect(result.success).toBe(false);
          // Exit 3 — environment-not-ready. WAS `0` UNTIL #76, and the earlier
          // comment here argued the right thing from the wrong premise: it
          // reasoned that the invocation was fine and the machine simply is not
          // ready ("the `unlinked` / `lock-busy` / `not-yet-synced` class"),
          // then concluded that class exits 0, which is what made the whole
          // refusal set invisible to `$?`. #76 keeps the reasoning and gives
          // that class its own code. `hub-unreachable` / `lock-busy` /
          // `not-yet-synced` are the retryable set, and 3 is what says so.
          expect(status).toBe(3);
          expect(result.command).toBe(argv[0]);
          expect(result.reason).toBe("hub-unreachable");
          expect(result.hubState).toBe("no-directory");
          expect(result.suggestion).toBeTruthy();
          // No raw exception text, and no path.
          expect(result.error).toBeUndefined();
          expect(stdout).not.toContain("ENOENT");
          expect(stdout).not.toContain(gone);
        }
        // ...and neither verb built a hub at the mistyped path on its way to
        // failing: `registerMachine` writes through `writeAtomic`, which
        // mkdir -p's, so this used to leave a `machines/` directory behind.
        expect(existsSync(gone)).toBe(false);
      } finally {
        for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
      }
    });
  });

  describe("hub unlink command", () => {
    it("unlinks the cwd and reports the removed link as one JSON object", () => {
      // Through the built CLI on purpose: `hub unlink` deliberately resolves no
      // hub and no config dir, so the only thing standing between the user and
      // the disarm path is this src/cli.ts wiring — and a mutation there is
      // invisible to every test that calls hubUnlink directly. HOME is pointed
      // at a temp dir because the project lock lives under it; see the guard
      // rail on this suite's runCli wrapper for what a missed override costs.
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-unlink-home-"));
      const projectPath = join(tempDir, "unlinkproj");
      mkdirSync(projectPath, { recursive: true });
      const linkPath = join(projectPath, ".sesh-mover-project.json");
      const projectId = "11111111-1111-4111-8111-111111111111";
      writeFileSync(
        linkPath,
        JSON.stringify(
          { projectId, name: "unlinkproj", createdAt: "2026-07-21T00:00:00Z", createdByMachine: "m1" },
          null,
          2
        ) + "\n"
      );
      try {
        // The shared helper, not this suite's wrapper: `cwd` is an option there
        // and would become an environment variable named "cwd" here.
        const { stdout, status } = sharedRunCli(["hub", "unlink"], {
          env: homeEnv(home),
          cwd: projectPath,
        });
        expect(status).toBe(0);
        const result = JSON.parse(stdout); // throws if stdout isn't exactly one JSON doc
        expect(result.success).toBe(true);
        expect(result.command).toBe("hub-unlink");
        expect(result.wasLinked).toBe(true);
        expect(result.projectId).toBe(projectId);
        // Compared by suffix, not equality: the child reports its own cwd, and
        // a temp dir is reached through a symlink on some platforms.
        expect(result.removedPath.endsWith(join("unlinkproj", ".sesh-mover-project.json"))).toBe(
          true
        );
        expect(existsSync(linkPath)).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    /**
     * THE DISARM-PATH GUARANTEE, and the reason this change stopped short of
     * `hub unlink`.
     *
     * `skills/session-porter/SKILL.md` states it outright: unlink "is the one
     * hub verb that works with no hub configured or reachable (it is the disarm
     * path for the default-on hooks, so it must not depend on the thing it is
     * disarming from)". Extending the `hub-unreachable` gate to every hub verb
     * uniformly would have broken exactly that — and broken it in the situation
     * a user reaches for the command in, since a push wedged on an unreachable
     * share is the motivating case for `--force` in the same file.
     *
     * Asserted through the BUILT CLI with `hub.path` really configured and
     * really absent, because the guarantee is about the wiring: `src/hub/unlink.ts`
     * constructs no backend, and `src/cli.ts`'s action resolves no hub path, so
     * either one growing a gate is what this catches. Nothing about the module's
     * internals is inspected.
     */
    it("still unlinks when hub.path is configured and unreachable", () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-unlink-gone-home-"));
      const projectPath = join(tempDir, "unlinkgoneproj");
      mkdirSync(projectPath, { recursive: true });
      const linkPath = join(projectPath, ".sesh-mover-project.json");
      writeFileSync(
        linkPath,
        JSON.stringify(
          {
            projectId: "22222222-2222-4222-8222-222222222222",
            name: "unlinkgoneproj",
            createdAt: "2026-07-21T00:00:00Z",
            createdByMachine: "m1",
          },
          null,
          2
        ) + "\n"
      );
      try {
        const gone = join(home, "not-mounted");
        runCli(["configure", "--scope", "user", "--set", `hub.path=${gone}`], homeEnv(home));

        // The three verbs that DO consult the hub say so first, so this test
        // shows the unlink succeeding in a state the others decline in rather
        // than in a vacuum.
        const status = JSON.parse(sharedRunCli(["hub", "status"], {
          env: homeEnv(home), cwd: projectPath,
        }).stdout);
        expect(status.success).toBe(true); // diagnostic: reports, never refuses
        expect(status.reachable).toBe(false);
        expect(status.hubState).toBe("no-directory");

        const whereis = JSON.parse(sharedRunCli(
          ["whereis", "--project-path", projectPath, "--source-config-dir", configDir],
          { env: homeEnv(home), cwd: projectPath }
        ).stdout);
        expect(whereis.success).toBe(true); // read: reports, never refuses
        expect(whereis.reachable).toBe(false);
        expect(whereis.linkCandidates).toBeUndefined();

        const reindex = JSON.parse(sharedRunCli(
          ["hub", "reindex", "--project-path", projectPath, "--source-config-dir", configDir],
          { env: homeEnv(home), cwd: projectPath }
        ).stdout);
        expect(reindex.success).toBe(false); // writes: refuses
        expect(reindex.reason).toBe("hub-unreachable");

        // ...and the disarm path is unaffected by every one of them.
        const { stdout, status: exit } = sharedRunCli(["hub", "unlink"], {
          env: homeEnv(home),
          cwd: projectPath,
        });
        expect(exit).toBe(0);
        const result = JSON.parse(stdout);
        expect(result.success).toBe(true);
        expect(result.wasLinked).toBe(true);
        expect(result.automationDisarmed).toBe(true);
        expect(existsSync(linkPath)).toBe(false);
        // No verb in that sequence built a hub at the mistyped path — including
        // the unlink, which constructs no backend at all.
        expect(existsSync(gone)).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("--progress", () => {
    it("emits NDJSON progress on stderr while stdout stays one JSON object", () => {
      const outputDir = join(tempDir, "cli-progress");
      mkdirSync(outputDir, { recursive: true });
      const { stdout, stderr } = runCli([
        "export",
        "--scope",
        "all",
        "--format",
        "dir",
        "--name",
        "progress-test",
        "--source-config-dir",
        configDir,
        "--project-path",
        "/Users/testuser/Projects/testproject",
        "--output",
        outputDir,
        "--no-summary",
        "--progress",
      ]);
      const result = JSON.parse(stdout); // throws if stdout isn't exactly one JSON doc
      expect(result.success).toBe(true);
      const events = stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(events.length).toBeGreaterThan(0);
      for (const ev of events) {
        expect(["export-copy", "archive", "extract", "import-rewrite", "import-verify"]).toContain(
          ev.phase
        );
      }
      expect(events.some((e) => e.phase === "export-copy" && e.percent === 100)).toBe(true);
    });

    it("stderr is empty without the flag", () => {
      const outputDir = join(tempDir, "cli-no-progress");
      mkdirSync(outputDir, { recursive: true });
      const { stderr } = runCli([
        "export",
        "--scope",
        "all",
        "--format",
        "dir",
        "--name",
        "no-progress-test",
        "--source-config-dir",
        configDir,
        "--project-path",
        "/Users/testuser/Projects/testproject",
        "--output",
        outputDir,
        "--no-summary",
      ]);
      expect(stderr.trim()).toBe("");
    });
  });

  describe("browse command", () => {
    it("lists exports as JSON", () => {
      // First create an export
      const outputDir = join(tempDir, "cli-browse");
      mkdirSync(outputDir, { recursive: true });
      runCli(
        `export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format dir --name browse-test --output "${outputDir}"`
      );

      const output = runCli(`browse --storage all --json`);
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.command).toBe("browse");
    });
  });

  describe("browse archive metadata", () => {
    const FOREIGN_MANIFEST = {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: "2026-07-25T18:30:48.718Z",
      // "wsl2" is deliberate and load-bearing: it is a valid Platform (see
      // src/types.ts) that os.platform() can NEVER return — on WSL, node
      // reports "linux" — so `not.toBe(platform())` below stays meaningful on
      // every CI OS. An earlier "win32" was only foreign-looking from a Mac:
      // on the windows-latest runner the fixture value equalled the local
      // platform, so the assertion that browse doesn't fabricate the local
      // platform became untestable exactly where it mattered, and failed.
      // Pick a value no host can produce, not merely one this host isn't.
      // It also mirrors the originating bug: a WSL2 bundle browsed elsewhere.
      sourcePlatform: "wsl2",
      sourceProjectPath: "/mnt/e/GitHub/someone/faraway",
      sourceConfigDir: "/home/someone/.claude",
      sourceClaudeVersion: "2.1.81",
      sessionScope: "current",
      includedLayers: ["jsonl"],
      sessions: [
        {
          sessionId: "550e8400-e29b-41d4-a716-446655440000",
          slug: "faraway",
          summary: "work done elsewhere",
          lastActiveAt: "2026-07-25T18:00:00Z",
          messageCount: 2731,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash: "sha256:abc",
        },
      ],
    };

    /** Build a real bundle .tar.gz at `archivePath` carrying FOREIGN_MANIFEST. */
    async function writeForeignArchive(archivePath: string): Promise<void> {
      const staging = join(tempDir, "stage", basename(archivePath).replace(/\.tar\.gz$/, ""));
      mkdirSync(join(staging, "sessions"), { recursive: true });
      writeFileSync(join(staging, "manifest.json"), JSON.stringify(FOREIGN_MANIFEST, null, 2));
      writeFileSync(
        join(staging, "sessions", "550e8400-e29b-41d4-a716-446655440000.jsonl"),
        '{"uuid":"a","type":"user"}\n'
      );
      await tar.create(
        { gzip: true, file: archivePath, cwd: dirname(staging) },
        [basename(staging)]
      );
    }

    it("reports an archive's REAL origin platform, not the local one", async () => {
      const homeDir = join(tempDir, "browse-home");
      const store = join(homeDir, ".sesh-mover");
      mkdirSync(store, { recursive: true });
      await writeForeignArchive(join(store, "2026-07-25-faraway.tar.gz"));

      const result = JSON.parse(runCli(`browse --storage user --json`, homeEnv(homeDir)));
      expect(result.success).toBe(true);
      const entry = result.exports.find(
        (e: { name: string }) => e.name === "2026-07-25-faraway.tar.gz"
      );
      expect(entry).toBeDefined();
      expect(entry.metadataAvailable).toBe(true);
      expect(entry.metadataError).toBeUndefined();
      expect(entry.sourcePlatform).toBe("wsl2");
      // Holds on darwin/linux/win32 alike: os.platform() has no "wsl2".
      expect(entry.sourcePlatform).not.toBe(platform());
      expect(entry.sourceProjectPath).toBe("/mnt/e/GitHub/someone/faraway");
      expect(entry.exportedAt).toBe("2026-07-25T18:30:48.718Z");
      expect(entry.sessionCount).toBe(1);
      expect(entry.sessions).toHaveLength(1);
      expect(entry.sessions[0].messageCount).toBe(2731);
      expect(entry.storage).toBe("user");
    });

    it("marks an unreadable archive honestly instead of inventing values", () => {
      const homeDir = join(tempDir, "browse-home-broken");
      const store = join(homeDir, ".sesh-mover");
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, "2026-01-01-broken.tar.gz"), "definitely not a tar archive");

      const result = JSON.parse(runCli(`browse --storage user --json`, homeEnv(homeDir)));
      expect(result.success).toBe(true);
      const entry = result.exports.find(
        (e: { name: string }) => e.name === "2026-01-01-broken.tar.gz"
      );
      expect(entry).toBeDefined();
      expect(entry.metadataAvailable).toBe(false);
      expect(typeof entry.metadataError).toBe("string");
      expect(entry.metadataError.length).toBeGreaterThan(0);
      expect(entry.sourcePlatform).toBeNull();
      expect(entry.sourceProjectPath).toBeNull();
      expect(entry.exportedAt).toBeNull();
      expect(entry.sessionCount).toBeNull();
      expect(entry.sessions).toEqual([]);
    });

    it("reads real metadata for a date-prefixed archive dropped in the project root", async () => {
      // Covers the second fabrication site: the cwd scan below the
      // .sesh-mover scan, which keeps its date-prefix filename filter.
      const projectDir = join(tempDir, "dropped-in-root");
      mkdirSync(projectDir, { recursive: true });
      const homeDir = join(tempDir, "empty-home");
      mkdirSync(homeDir, { recursive: true });
      await writeForeignArchive(join(projectDir, "2026-07-25-dropped.tar.gz"));
      // Same content, no date prefix: must stay filtered out.
      await writeForeignArchive(join(projectDir, "no-date-prefix.tar.gz"));

      const cliPath = join(import.meta.dirname, "..", "dist", "cli.js");
      const run = spawnSync("node", [cliPath, "browse", "--storage", "project", "--json"], {
        encoding: "utf-8",
        cwd: projectDir,
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...homeEnv(homeDir) },
      });
      const result = JSON.parse(run.stdout);
      expect(result.success).toBe(true);
      const entry = result.exports.find(
        (e: { name: string }) => e.name === "2026-07-25-dropped.tar.gz"
      );
      expect(entry).toBeDefined();
      expect(entry.metadataAvailable).toBe(true);
      expect(entry.sourcePlatform).toBe("wsl2");
      expect(entry.sourceProjectPath).toBe("/mnt/e/GitHub/someone/faraway");
      expect(entry.sessionCount).toBe(1);
      expect(entry.storage).toBe("project");
      expect(
        result.exports.some((e: { name: string }) => e.name === "no-date-prefix.tar.gz")
      ).toBe(false);
    });

    it("returns an entry for every archive when there are more than the concurrency bound", async () => {
      // ARCHIVE_READ_CONCURRENCY is 8, so 24 archives means three batches:
      // batching must not drop, duplicate, or reorder-away any entry.
      const total = 24;
      const homeDir = join(tempDir, "many-home");
      const store = join(homeDir, ".sesh-mover");
      mkdirSync(store, { recursive: true });
      const seed = join(tempDir, "seed.tar.gz");
      await writeForeignArchive(seed);
      const expected: string[] = [];
      for (let i = 0; i < total; i++) {
        const name = `2026-07-25-many-${String(i).padStart(2, "0")}.tar.gz`;
        cpSync(seed, join(store, name));
        expected.push(name);
      }

      // Point the child's temp root at a dir we own, so we can prove the
      // reads clean up after themselves instead of leaking a scratch dir
      // per archive. tmpEnv (all of TMPDIR/TMP/TEMP), not a bare TMPDIR:
      // Windows ignores TMPDIR, which would send the child to the system
      // temp dir and make the leak assertion below pass vacuously. The
      // sibling "temp root itself is unusable" test is the positive control
      // that this steering reaches the child at all.
      const tmpRoot = join(tempDir, "many-tmproot");
      mkdirSync(tmpRoot, { recursive: true });
      const result = JSON.parse(
        runCli(`browse --storage user --json`, { ...homeEnv(homeDir), ...tmpEnv(tmpRoot) })
      );

      expect(result.success).toBe(true);
      const names = result.exports.map((e: { name: string }) => e.name).sort();
      expect(names).toEqual(expected);
      expect(
        result.exports.every(
          (e: { metadataAvailable: boolean; sourcePlatform: string }) =>
            e.metadataAvailable === true && e.sourcePlatform === "wsl2"
        )
      ).toBe(true);
      expect(readdirSync(tmpRoot).filter((n) => n.startsWith("sesh-manifest-"))).toEqual([]);
    });

    it.skipIf(isWindows)(
      "degrades only the archive that hits a resource failure and still lists the rest",
      async () => {
        const homeDir = join(tempDir, "mixed-home");
        const store = join(homeDir, ".sesh-mover");
        mkdirSync(store, { recursive: true });

        // A directory export (read without touching an archive at all)...
        const dirExport = join(store, "2026-07-25-dir-export");
        mkdirSync(join(dirExport, "sessions"), { recursive: true });
        writeFileSync(join(dirExport, "manifest.json"), JSON.stringify(FOREIGN_MANIFEST));

        // ...two healthy archives...
        await writeForeignArchive(join(store, "2026-07-25-healthy-a.tar.gz"));
        await writeForeignArchive(join(store, "2026-07-25-healthy-b.tar.gz"));

        // ...and one the process cannot open: a real per-archive resource
        // failure (EACCES), not a corrupt or hostile bundle.
        const unreadable = join(store, "2026-07-25-locked.tar.gz");
        await writeForeignArchive(unreadable);
        chmodSync(unreadable, 0o000);

        try {
          const result = JSON.parse(runCli(`browse --storage user --json`, homeEnv(homeDir)));

          // The command survives: success, and an entry for all four.
          expect(result.success).toBe(true);
          expect(result.exports).toHaveLength(4);

          const byName = Object.fromEntries(
            result.exports.map((e: { name: string }) => [e.name, e])
          );
          for (const ok of [
            "2026-07-25-dir-export",
            "2026-07-25-healthy-a.tar.gz",
            "2026-07-25-healthy-b.tar.gz",
          ]) {
            expect(byName[ok].metadataAvailable).toBe(true);
            expect(byName[ok].sourcePlatform).toBe("wsl2");
            expect(byName[ok].sessionCount).toBe(1);
          }

          const bad = byName["2026-07-25-locked.tar.gz"];
          expect(bad.metadataAvailable).toBe(false);
          expect(bad.metadataError.length).toBeGreaterThan(0);
          expect(bad.sourcePlatform).toBeNull();
          expect(bad.sessionCount).toBeNull();
          expect(bad.sessions).toEqual([]);
        } finally {
          chmodSync(unreadable, 0o644); // so afterEach can clean up
        }
      }
    );

    it("keeps the listing alive when the temp root itself is unusable", async () => {
      // The regression this guards: the scratch-dir allocation used to sit
      // outside readManifestFromArchive's try, so an allocation failure
      // escaped as a rejection and Promise.all failed the WHOLE command —
      // success:false with zero entries, worse than the bug being fixed.
      const homeDir = join(tempDir, "notmp-home");
      const store = join(homeDir, ".sesh-mover");
      mkdirSync(store, { recursive: true });
      const dirExport = join(store, "2026-07-25-dir-export");
      mkdirSync(dirExport, { recursive: true });
      writeFileSync(join(dirExport, "manifest.json"), JSON.stringify(FOREIGN_MANIFEST));
      await writeForeignArchive(join(store, "2026-07-25-a.tar.gz"));
      await writeForeignArchive(join(store, "2026-07-25-b.tar.gz"));

      // All three temp names, or this steers nothing on Windows (os.tmpdir()
      // there reads TEMP/TMP and never TMPDIR): the child would find a
      // perfectly usable temp root and report metadataAvailable: true.
      const result = JSON.parse(
        runCli(`browse --storage user --json`, {
          ...homeEnv(homeDir),
          ...tmpEnv(join(tempDir, "no-such-temp-root")),
        })
      );

      expect(result.success).toBe(true);
      expect(result.exports).toHaveLength(3);
      const archives = result.exports.filter((e: { name: string }) =>
        e.name.endsWith(".tar.gz")
      );
      expect(archives).toHaveLength(2);
      for (const a of archives) {
        expect(a.metadataAvailable).toBe(false);
        expect(a.metadataError).toMatch(/ENOENT|no such file/i);
        expect(a.sourcePlatform).toBeNull();
      }
      // The directory export, which needs no scratch dir, is unaffected.
      const dirEntry = result.exports.find(
        (e: { name: string }) => e.name === "2026-07-25-dir-export"
      );
      expect(dirEntry.metadataAvailable).toBe(true);
      expect(dirEntry.sourcePlatform).toBe("wsl2");
    });
  });

  // #33. v0.5.1 made ARCHIVE entries honest; directory exports kept swallowing
  // the readManifest throw, so a store bundle with a broken manifest.json
  // vanished from the listing entirely — the user saw nothing rather than a
  // broken row. The fix is deliberately asymmetric, and both halves are pinned
  // here: degrade in the store dirs (a manifest.json there is ours by
  // construction), keep silently skipping in the cwd scan (where reading that
  // file IS the "is this even one of ours?" test).
  describe("browse directory metadata (#33)", () => {
    const HEALTHY_MANIFEST = {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: "2026-07-25T18:30:48.718Z",
      sourcePlatform: "wsl2",
      sourceProjectPath: "/mnt/e/GitHub/someone/faraway",
      sourceConfigDir: "/home/someone/.claude",
      sourceClaudeVersion: "2.1.81",
      sessionScope: "current",
      includedLayers: ["jsonl"],
      sessions: [
        {
          sessionId: "550e8400-e29b-41d4-a716-446655440000",
          slug: "faraway",
          summary: "work done elsewhere",
          lastActiveAt: "2026-07-25T18:00:00Z",
          messageCount: 7,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash: "sha256:abc",
        },
      ],
    };

    /** Write `<parent>/<name>/manifest.json` with `body` verbatim. */
    function writeBundleDir(parent: string, name: string, body: string): string {
      const dir = join(parent, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), body);
      return dir;
    }

    it("degrades a store directory with a malformed manifest instead of dropping it", () => {
      const homeDir = mkdtempSync(join(tmpdir(), "sesh-browse-dir-broken-"));
      try {
        const store = join(homeDir, ".sesh-mover");
        mkdirSync(store, { recursive: true });
        writeBundleDir(store, "2026-07-25-healthy", JSON.stringify(HEALTHY_MANIFEST));
        writeBundleDir(store, "2026-07-26-truncated", '{"version":1,"plugin":"sesh-mo');
        // No manifest.json at all: not an export CLAIM, so not an entry —
        // not even a degraded one. That is the line between the two cases.
        mkdirSync(join(store, "not-an-export"), { recursive: true });

        const result = JSON.parse(runCli(`browse --storage user --json`, homeEnv(homeDir)));
        expect(result.success).toBe(true);

        const broken = result.exports.find(
          (e: { name: string }) => e.name === "2026-07-26-truncated"
        );
        expect(broken).toBeDefined();
        expect(broken.metadataAvailable).toBe(false);
        expect(typeof broken.metadataError).toBe("string");
        expect(broken.metadataError.length).toBeGreaterThan(0);
        // Exactly the archive row shape, so the skill layer's existing
        // `metadataAvailable: false` branch handles a directory unchanged.
        expect(broken.exportedAt).toBeNull();
        expect(broken.sourcePlatform).toBeNull();
        expect(broken.sourceProjectPath).toBeNull();
        expect(broken.sessionCount).toBeNull();
        expect(broken.sessions).toEqual([]);
        expect(broken.storage).toBe("user");
        // Still selectable: commands/browse.md's import and delete steps act on
        // `path`, and refuse a `path` that doesn't end in the entry's own name.
        expect(broken.path).toBe(join(store, "2026-07-26-truncated"));

        // One broken row degrades only itself.
        const healthy = result.exports.find(
          (e: { name: string }) => e.name === "2026-07-25-healthy"
        );
        expect(healthy.metadataAvailable).toBe(true);
        expect(healthy.sessionCount).toBe(1);

        expect(
          result.exports.some((e: { name: string }) => e.name === "not-an-export")
        ).toBe(false);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it("degrades a structurally wrong store manifest rather than fabricating from it", () => {
      const homeDir = mkdtempSync(join(tmpdir(), "sesh-browse-dir-shape-"));
      try {
        const store = join(homeDir, ".sesh-mover");
        mkdirSync(store, { recursive: true });
        // Parses fine, and every field a listing reports is present and
        // plausible — but `sessions` is a string. `sessions.length` is 3.
        writeBundleDir(
          store,
          "2026-07-27-sessions-string",
          JSON.stringify({ ...HEALTHY_MANIFEST, sessions: "abc" })
        );
        // `sessions` a number: readManifest itself throws (not iterable), so
        // this exercises the throwing branch on a *parseable* manifest.
        writeBundleDir(
          store,
          "2026-07-28-sessions-number",
          JSON.stringify({ ...HEALTHY_MANIFEST, sessions: 5 })
        );
        // No plugin marker: the store scan never checked for one before, so
        // this row used to list as healthy. It is not a bundle manifest.
        writeBundleDir(
          store,
          "2026-07-29-no-marker",
          JSON.stringify({ ...HEALTHY_MANIFEST, plugin: undefined })
        );

        const result = JSON.parse(runCli(`browse --storage user --json`, homeEnv(homeDir)));
        expect(result.success).toBe(true);
        expect(result.exports).toHaveLength(3);

        const byName = Object.fromEntries(
          result.exports.map((e: { name: string }) => [e.name, e])
        );

        const stringSessions = byName["2026-07-27-sessions-string"];
        expect(stringSessions.metadataAvailable).toBe(false);
        // The whole point: 3 is the string's length, not a session count.
        expect(stringSessions.sessionCount).not.toBe(3);
        expect(stringSessions.sessionCount).toBeNull();
        expect(stringSessions.sessions).toEqual([]);
        expect(stringSessions.metadataError).toMatch(/bundle manifest/i);
        // Degradation is all-or-nothing: the readable fields go too, rather
        // than half a row sourced from a manifest we just declared untrusted.
        expect(stringSessions.exportedAt).toBeNull();
        expect(stringSessions.sourcePlatform).toBeNull();

        for (const name of ["2026-07-28-sessions-number", "2026-07-29-no-marker"]) {
          expect(byName[name].metadataAvailable).toBe(false);
          expect(byName[name].metadataError.length).toBeGreaterThan(0);
          expect(byName[name].sessionCount).toBeNull();
          expect(byName[name].sessions).toEqual([]);
        }
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });

    // THE REGRESSION GUARD for the trap in #33: this must fail if someone
    // later "symmetrizes" the two directory paths. In the cwd scan the
    // readManifest failure is not a broken export — it is the answer "no, this
    // directory is not a sesh-mover export", and degrading there would list
    // every unrelated manifest.json-bearing directory in a user's project root
    // as broken. Both policies run in ONE browse below, so the asymmetry is
    // asserted as a contrast rather than as two independent facts.
    it("skips a stranger's manifest.json in the cwd scan while degrading a store one", () => {
      const homeDir = mkdtempSync(join(tmpdir(), "sesh-browse-cwd-home-"));
      const projectDir = mkdtempSync(join(tmpdir(), "sesh-browse-cwd-proj-"));
      try {
        const store = join(homeDir, ".sesh-mover");
        mkdirSync(store, { recursive: true });
        writeBundleDir(store, "2026-07-26-truncated", "{ not json");

        // Strangers in the project root, all with a manifest.json:
        writeBundleDir(
          projectDir,
          "some-package",
          JSON.stringify({ name: "some-package", version: "1.0.0" })
        );
        writeBundleDir(projectDir, "dist", "<html>definitely not json</html>");
        // Carries our marker but a wrong-shaped session list. Skipped here —
        // and above all never listed with a session count of 3.
        writeBundleDir(
          projectDir,
          "half-ours",
          JSON.stringify({ ...HEALTHY_MANIFEST, sessions: "abc" })
        );
        // Positive control: a real export dropped in the project root. Without
        // it, "nothing was listed" could mean the cwd scan never ran.
        writeBundleDir(projectDir, "2026-07-25-dropped", JSON.stringify(HEALTHY_MANIFEST));

        const result = JSON.parse(
          sharedRunCli(["browse", "--storage", "all", "--json"], {
            env: { CLAUDE_CONFIG_DIR: configDir, ...homeEnv(homeDir) },
            cwd: projectDir,
          }).stdout
        );
        expect(result.success).toBe(true);

        const names = result.exports.map((e: { name: string }) => e.name);
        expect(names).toContain("2026-07-25-dropped");
        expect(names).not.toContain("some-package");
        expect(names).not.toContain("dist");
        expect(names).not.toContain("half-ours");

        const dropped = result.exports.find(
          (e: { name: string }) => e.name === "2026-07-25-dropped"
        );
        expect(dropped.metadataAvailable).toBe(true);
        expect(dropped.sessionCount).toBe(1);
        expect(dropped.storage).toBe("project");

        // Same run, same failure mode, opposite policy — this is the contrast.
        const broken = result.exports.find(
          (e: { name: string }) => e.name === "2026-07-26-truncated"
        );
        expect(broken).toBeDefined();
        expect(broken.metadataAvailable).toBe(false);
        expect(broken.sessionCount).toBeNull();
        expect(broken.storage).toBe("user");
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe("configure command", () => {
    it("shows current config", () => {
      // Isolated HOME on purpose: `--show` reports the EFFECTIVE config, so
      // without one this asserts on whatever the developer running the suite
      // happens to have configured (it read the real ~/.sesh-mover).
      const home = mkdtempSync(join(tmpdir(), "sesh-cfg-show-home-"));
      try {
        const output = sharedRunCli(["configure", "--show", "--json"], {
          env: { CLAUDE_CONFIG_DIR: configDir, ...homeEnv(home) },
          cwd: home,
        }).stdout;
        const result = JSON.parse(output);
        expect(result.success).toBe(true);
        expect(result.config.export.storage).toBe("user");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("sets machine.name via --set", () => {
      const homeOverride = overrideHome(tempDir);
      try {
        const output = runCli(`configure --scope user --set machine.name=my-laptop --json`);
        const result = JSON.parse(output);
        expect(result.success).toBe(true);
        expect(result.message).toMatch(/machine\.name\s*=\s*my-laptop/);
      } finally {
        homeOverride.restore();
      }
    });

    it("sets hub.startupNotice via --set and persists it", () => {
      // End-to-end guard for the SessionStart notice opt-out. setConfigValue
      // only accepts dot-paths that already exist in getDefaultConfig(), so
      // before hub.startupNotice was added to the defaults this exact command
      // failed with "Invalid config path" — the flag the hook gates on was
      // documented but unsettable through the supported interface.
      const homeOverride = overrideHome(tempDir);
      try {
        const output = runCli(`configure --scope user --set hub.startupNotice=false --json`);
        const result = JSON.parse(output);
        expect(result.success).toBe(true);
        const shown = JSON.parse(runCli("configure --show --json"));
        expect(shown.config.hub.startupNotice).toBe(false);
      } finally {
        homeOverride.restore();
      }
    });

    // The whole-branch review's Critical 1, end to end through the real CLI:
    // 0.6.0's release notes tell users to add `--scope project` to any of the
    // hub opt-outs, and doing so used to write a defaults snapshot — `hub.path:
    // ""` included — into the project file, which then beat the user-scope hub
    // path. `hub status` answered `hubPath: null` and `push` answered "No hub
    // configured" for that project, forever.
    it("a project-scope --set does not unconfigure the user-scope hub", () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cfg-scope-home-"));
      const project = mkdtempSync(join(tmpdir(), "sesh-cfg-scope-proj-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-cfg-scope-hub-"));
      try {
        // sharedRunCli, not the local wrapper: this needs a cwd (that IS the
        // project scope) as well as an isolated HOME.
        const env = { env: { CLAUDE_CONFIG_DIR: configDir, ...homeEnv(home) }, cwd: project };
        const init = JSON.parse(
          sharedRunCli(["hub", "init", "--scope", "user", "--path", hubDir], env).stdout
        );
        expect(init.success).toBe(true);

        const set = JSON.parse(
          sharedRunCli(
            ["configure", "--set", "hub.autoPush=false", "--scope", "project", "--json"],
            env
          ).stdout
        );
        expect(set.success).toBe(true);
        // The result reports what APPLIES now, so the regression is visible in
        // the very output of the command that caused it.
        expect(set.config.hub.autoPush).toBe(false);
        expect(set.config.hub.path).toBe(hubDir);

        // The file itself holds only what this scope sets.
        const written = JSON.parse(
          readFileSync(join(project, ".sesh-mover", "config.json"), "utf-8")
        );
        expect(written).toEqual({ hub: { autoPush: false } });

        // And the hub is still configured for this project.
        const status = JSON.parse(sharedRunCli(["hub", "status"], env).stdout);
        expect(status.hubPath).toBe(hubDir);
        expect(status.reachable).toBe(true);
      } finally {
        for (const d of [home, project, hubDir]) rmSync(d, { recursive: true, force: true });
      }
    });

    it("--reset clears one scope's settings instead of pinning defaults over the other", () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cfg-reset-home-"));
      const project = mkdtempSync(join(tmpdir(), "sesh-cfg-reset-proj-"));
      try {
        const env = { env: { CLAUDE_CONFIG_DIR: configDir, ...homeEnv(home) }, cwd: project };
        sharedRunCli(["configure", "--set", "export.storage=project", "--scope", "user"], env);
        sharedRunCli(["configure", "--set", "hub.autoPush=false", "--scope", "project"], env);
        const reset = JSON.parse(
          sharedRunCli(["configure", "--reset", "--scope", "project", "--json"], env).stdout
        );
        expect(reset.success).toBe(true);
        expect(reset.config.hub.autoPush).toBe(true); // the project override is gone
        expect(reset.config.export.storage).toBe("project"); // the user's setting survives
        expect(
          JSON.parse(readFileSync(join(project, ".sesh-mover", "config.json"), "utf-8"))
        ).toEqual({});
      } finally {
        for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
      }
    });

    it("--set stores a NUMERIC config key as a number, not as a string", () => {
      // `--set` used to parse only `true`/`false` and a leading `[`, leaving
      // everything else a string. `hub.carryMaxMb=100` would then persist
      // `"100"`, which `resolveBudgetMb` reads as "not a size" — so every push
      // afterwards silently fell back to the default while warning about a
      // value the user typed correctly.
      const homeOverride = overrideHome(tempDir);
      try {
        expect(JSON.parse(runCli(`configure --scope user --set hub.carryMaxMb=100 --json`)).success)
          .toBe(true);
        const shown = JSON.parse(runCli("configure --show --json"));
        expect(shown.config.hub.carryMaxMb).toBe(100);
        // …and it is on disk as a number, not as a quoted string.
        const raw = JSON.parse(
          readFileSync(join(tempDir, ".sesh-mover", "config.json"), "utf-8")
        );
        expect(raw.hub.carryMaxMb).toBe(100);
        // 0 is a legitimate setting (carry nothing), so it must not be
        // mistaken for "unset" anywhere on the way in.
        expect(JSON.parse(runCli(`configure --scope user --set hub.workspaceMaxMb=0 --json`)).success)
          .toBe(true);
        expect(JSON.parse(runCli("configure --show --json")).config.hub.workspaceMaxMb).toBe(0);
      } finally {
        homeOverride.restore();
      }
    });

    it("--set refuses a non-numeric value for a numeric key instead of storing it", () => {
      const homeOverride = overrideHome(tempDir);
      let caught: { stdout: string; status: number } | null = null;
      try {
        runCli(`configure --scope user --set hub.carryMaxMb=lots --json`);
      } catch (e) {
        const err = e as { stdout?: Buffer; status?: number };
        caught = { stdout: err.stdout ? err.stdout.toString() : "", status: err.status ?? 0 };
      } finally {
        homeOverride.restore();
      }
      expect(caught).not.toBeNull();
      expect(caught!.status).toBe(1); // bad invocation (#76)
      const result = JSON.parse(caught!.stdout);
      expect(result.success).toBe(false);
      expect(result.error).toContain("hub.carryMaxMb");
    });

    it("returns clean ErrorResult JSON for malformed --set JSON values", () => {
      let caught: { stdout: string; status: number } | null = null;
      try {
        runCli(`configure --scope user --set 'export.exclude=[unclosed'`);
      } catch (e) {
        const err = e as { stdout?: Buffer; status?: number };
        caught = { stdout: err.stdout ? err.stdout.toString() : "", status: err.status ?? 0 };
      }
      expect(caught).not.toBeNull();
      expect(caught!.status).toBe(1); // bad invocation (#76)
      const result = JSON.parse(caught!.stdout);
      expect(result.success).toBe(false);
      expect(result.command).toBe("configure");
      expect(result.error).toMatch(/json/i);
    });
  });

  describe("export incremental archive-first sent-state", () => {
    function installFailingZstdShim(binDir: string): void {
      // Same technique as tests/archiver.test.ts's installZstdShim (which
      // already passes on Windows CI): a bare-name POSIX shebang script.
      // execFileSync("zstd", …) resolves it via PATH the same way on all
      // three OSes; chmod is a no-op on Windows but harmless.
      mkdirSync(binDir, { recursive: true });
      const script = [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "zstd 1.5.5-fake"; exit 0; fi',
        'if [ "$1" = "-f" ]; then exit 1; fi',
        "exit 64",
        "",
      ].join("\n");
      const shimPath = join(binDir, "zstd");
      writeFileSync(shimPath, script);
      chmodSync(shimPath, 0o755);
    }

    // Windows: this test forces a synthetic zstd-compression failure by
    // putting a fake `zstd` shim first on PATH. execFileSync (no shell) only
    // resolves extensionless PATH entries via a match against PATHEXT
    // (.EXE/.BAT/.CMD/…), so a bare-name POSIX shebang script is invisible
    // to it there — and windows-latest runners ship a real `zstd.exe` at
    // C:\tools\zstd, so the lookup silently falls through to that instead of
    // our shim and the archive is created for real (confirmed by capturing
    // the CLI's stdout in CI: `success: true` with a genuine .tar.zst). A
    // `.cmd`/`.bat` shim doesn't help either — Node's execFileSync refuses
    // to launch those without `shell: true`, which archiver.ts doesn't pass.
    // The behavior under test (createArchive rejecting must block
    // recordSentFromBundle) is plain, platform-independent control flow in
    // src/cli.ts/exporter.ts; only this fault-injection technique is
    // unix-only, so skip rather than weaken the assertion.
    it.skipIf(isWindows)("does not record sent-state when archive creation fails after recordSentFromBundle would have run", () => {
      const tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-cli-inc-fail-home-"));
      const outputDir = join(tempDir, "cli-inc-fail");
      mkdirSync(outputDir, { recursive: true });
      const projectPath = "/Users/testuser/Projects/testproject";

      try {
        // Seed machine identity so loadOrCreateMachineId() picks it up deterministically.
        const seshDir = join(tempHome, ".sesh-mover");
        mkdirSync(seshDir, { recursive: true });
        writeFileSync(
          join(seshDir, "machine-id.json"),
          JSON.stringify(
            { id: "machine-local", name: "local-machine", createdAt: new Date().toISOString() },
            null,
            2
          ) + "\n"
        );

        // Seed sync-state with a known peer so `--to peer-1` resolves.
        const syncStateDir = join(seshDir, "sync-state");
        mkdirSync(syncStateDir, { recursive: true });
        const syncStatePath = join(syncStateDir, `${encodeProjectPath(projectPath)}.json`);
        const seededState = {
          projectPath,
          schemaVersion: 1,
          peers: {
            "peer-1": {
              name: "peer-machine",
              lastSentAt: null,
              lastReceivedAt: null,
              sent: {},
              received: {},
            },
          },
          lineage: {},
          imported: {},
        };
        writeFileSync(syncStatePath, JSON.stringify(seededState, null, 2) + "\n");

        // zstd --version succeeds (so isZstdAvailable() is true, no fallback to
        // gzip) but `-f` (compression) fails, forcing createArchive to throw.
        const shimDir = join(tempDir, "shim-bin-fail");
        installFailingZstdShim(shimDir);

        let caught: { stdout: string; status: number } | null = null;
        try {
          const cliPath = join(import.meta.dirname, "..", "dist", "cli.js");
          execSync(
            `node "${cliPath}" export --scope current --session-id ${sessionId} --source-config-dir "${configDir}" --project-path ${projectPath} --storage user --format zstd --name inc-zstd-fail --output "${outputDir}" --incremental --to peer-1`,
            {
              encoding: "utf-8",
              env: prependPath({ ...process.env, ...homeEnv(tempHome) }, shimDir),
            }
          );
        } catch (e) {
          const err = e as { stdout?: Buffer; status?: number };
          caught = {
            stdout: err.stdout ? err.stdout.toString() : "",
            status: err.status ?? 0,
          };
        }

        expect(caught).not.toBeNull();
        // Class 1: `createArchive` THREW and the command's catch reported it.
        expect(caught!.status).toBe(1);
        const result = JSON.parse(caught!.stdout);
        expect(result.success).toBe(false);

        // The sync-state peer's sent map must still be empty: recording
        // must happen AFTER the archive is successfully created, not before.
        const afterState = JSON.parse(readFileSync(syncStatePath, "utf-8"));
        expect(afterState.peers["peer-1"].sent).toEqual({});
      } finally {
        rmSync(tempHome, { recursive: true, force: true });
      }
    });
  });

  describe("export incremental", () => {
    it("errors when --incremental is used without --to or --since", () => {
      const outputDir = join(tempDir, "cli-inc-missing");
      mkdirSync(outputDir, { recursive: true });
      let caught: { stdout: string; status: number } | null = null;
      try {
        runCli(
          `export --scope all --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format dir --name inc-missing --output "${outputDir}" --incremental`
        );
      } catch (e) {
        const err = e as { stdout?: Buffer; status?: number };
        caught = {
          stdout: err.stdout ? err.stdout.toString() : "",
          status: err.status ?? 0,
        };
      }
      expect(caught).not.toBeNull();
      expect(caught!.status).toBe(1); // bad invocation (#76)
      const result = JSON.parse(caught!.stdout);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/--to|--since/);
    });

    it("errors when --to names an unknown peer", () => {
      const outputDir = join(tempDir, "cli-inc-unknown");
      mkdirSync(outputDir, { recursive: true });
      let caught: { stdout: string; status: number } | null = null;
      try {
        runCli(
          `export --scope all --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format dir --name inc-unknown --output "${outputDir}" --incremental --to nonexistent-peer`
        );
      } catch (e) {
        const err = e as { stdout?: Buffer; status?: number };
        caught = {
          stdout: err.stdout ? err.stdout.toString() : "",
          status: err.status ?? 0,
        };
      }
      expect(caught).not.toBeNull();
      const result = JSON.parse(caught!.stdout);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no sync history|unknown peer/i);
    });

    it("--since keys continuation entries by their local session id", () => {
      // Build a reference bundle whose manifest carries a continuation entry.
      const refDir = join(tempDir, "since-ref");
      mkdirSync(join(refDir, "sessions"), { recursive: true });
      const contId = "cccccccc-1111-2222-3333-444444444444";
      writeFileSync(
        join(refDir, "sessions", `${contId}.jsonl`),
        '{"uuid":"header"}\n{"uuid":"entry-3"}\n'
      );
      writeFileSync(
        join(refDir, "manifest.json"),
        JSON.stringify({
          version: 1,
          plugin: "sesh-mover",
          exportedAt: "2026-07-13T00:00:00Z",
          sourcePlatform: "darwin",
          sourceProjectPath: "/Users/testuser/Projects/testproject",
          sourceConfigDir: "/c",
          sourceClaudeVersion: "2.1.114",
          sessionScope: "all",
          includedLayers: ["jsonl"],
          sessions: [
            {
              sessionId: contId,
              slug: "test-session",
              summary: "continuation of test-session",
              createdAt: "",
              lastActiveAt: "",
              messageCount: 2,
              gitBranch: "main",
              entrypoint: "cli",
              integrityHash: "sha256:x",
              type: "continuation",
              continuation: {
                continuesLocalSessionId: sessionId,
                fromEntryIndex: 2,
                fromEntryUuid: "entry-3",
              },
            },
          ],
          sourceMachineId: "peer-1",
          incremental: true,
          baseline: { targetMachineId: "machine-me" },
        })
      );

      const outputDir = join(tempDir, "cli-since-cont");
      mkdirSync(outputDir, { recursive: true });
      const output = runCli(
        `export --scope all --source-config-dir "${configDir}" --project-path /Users/testuser/Projects/testproject --storage user --format dir --name since-cont --output "${outputDir}" --incremental --since "${refDir}"`,
        homeEnv(tempDir)
      );
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      // The fixture session's last entry IS entry-3 (the ref bundle's head),
      // so keyed-by-LOCAL-id the diff sees it as unchanged → zero sessions.
      // The old bundle-id keying found no record and re-exported it whole.
      const manifest = JSON.parse(
        readFileSync(
          join(outputDir, "since-cont", "manifest.json"),
          "utf-8"
        )
      );
      expect(manifest.sessions.length).toBe(0);
    });

    /**
     * #59 item 1 — `export --incremental --to <peer>` reads the peer's memory
     * ledger. Only `hub push` passed `peerMemoryDigest` before, so a plain
     * incremental export re-shipped the whole `memory/` directory on every run:
     * safe (absent means ship), just never minimal.
     *
     * It has to go through the CLI: `resolveIncrementalOptions` is
     * module-private to src/cli.ts and the ledger read is the thing under test,
     * so calling the exporter directly would test the exporter's half again.
     */
    describe("--to reads the peer's memory ledger", () => {
      const projectPath = "/Users/testuser/Projects/testproject";

      /** A HOME with a fixed machine id and one peer that is caught up on sessions. */
      function seedPeerHome(tempHome: string, memoryDigest?: string): string {
        const seshDir = join(tempHome, ".sesh-mover");
        mkdirSync(join(seshDir, "sync-state"), { recursive: true });
        writeFileSync(
          join(seshDir, "machine-id.json"),
          JSON.stringify({
            id: "machine-local",
            name: "local-machine",
            createdAt: new Date().toISOString(),
          }) + "\n"
        );
        const statePath = join(
          seshDir,
          "sync-state",
          `${encodeProjectPath(projectPath)}.json`
        );
        writeFileSync(
          statePath,
          JSON.stringify({
            projectPath,
            schemaVersion: 1,
            peers: {
              "peer-1": {
                name: "peer-machine",
                lastSentAt: null,
                lastReceivedAt: null,
                // Caught up on session content, so `memory/` is the only
                // variable the bundle's contents can turn on.
                sent: {
                  [sessionId]: {
                    headEntryUuid: "entry-3",
                    messageCount: 3,
                    sentAsType: "full",
                    sentAsSessionId: sessionId,
                  },
                },
                received: {},
                ...(memoryDigest ? { memoryDigest } : {}),
              },
            },
            lineage: {},
            imported: {},
          }) + "\n"
        );
        return statePath;
      }

      function runIncrementalTo(tempHome: string, name: string): Record<string, unknown> {
        const outputDir = join(tempDir, name);
        mkdirSync(outputDir, { recursive: true });
        runCli(
          `export --scope all --source-config-dir "${configDir}" --project-path ${projectPath} --storage user --format dir --name ${name} --output "${outputDir}" --incremental --to peer-1`,
          homeEnv(tempHome)
        );
        return JSON.parse(
          readFileSync(join(outputDir, name, "manifest.json"), "utf-8")
        ) as Record<string, unknown>;
      }

      it("nothing known about the peer: memory ships (the safe default is unchanged)", () => {
        const tempHome = mkdtempSync(join(tmpdir(), "sesh-cli-mem-ship-"));
        try {
          seedPeerHome(tempHome);
          const manifest = runIncrementalTo(tempHome, "inc-to-mem-first");
          expect(existsSync(join(tempDir, "inc-to-mem-first", "inc-to-mem-first", "memory"))).toBe(
            true
          );
          expect(manifest.includedLayers as string[]).toContain("memory");
          expect(manifest.memoryDigest as string).toMatch(/^sha256:[0-9a-f]{64}$/);
        } finally {
          rmSync(tempHome, { recursive: true, force: true });
        }
      });

      it("peer already holds this exact memory: it is not re-shipped", () => {
        const tempHome = mkdtempSync(join(tmpdir(), "sesh-cli-mem-skip-"));
        try {
          seedPeerHome(tempHome);
          const first = runIncrementalTo(tempHome, "inc-to-mem-a");
          const digest = first.memoryDigest as string;
          expect(digest).toMatch(/^sha256:/);

          // Credit the peer exactly as a delivery would (`setPeerMemoryDigest`
          // takes the BUNDLE's digest), then export again. The export above
          // rewrote this file via recordSentFromBundle, so re-seed rather than
          // patching a copy read before it.
          seedPeerHome(tempHome, digest);
          const second = runIncrementalTo(tempHome, "inc-to-mem-b");
          expect(existsSync(join(tempDir, "inc-to-mem-b", "inc-to-mem-b", "memory"))).toBe(false);
          expect(second.includedLayers as string[]).not.toContain("memory");
          // Nothing shipped, so nothing may be credited on the receiving end.
          expect(second.memoryDigest).toBeUndefined();
        } finally {
          rmSync(tempHome, { recursive: true, force: true });
        }
      });

      it("a stale digest is not a skip: changed memory ships again", () => {
        const tempHome = mkdtempSync(join(tmpdir(), "sesh-cli-mem-changed-"));
        try {
          seedPeerHome(tempHome);
          const first = runIncrementalTo(tempHome, "inc-to-mem-c");
          const digest = first.memoryDigest as string;

          writeFileSync(
            join(configDir, "projects", encodeProjectPath(projectPath), "memory", "test_memory.md"),
            "---\nname: Test memory\n---\n\nSomething new was learned.\n"
          );
          seedPeerHome(tempHome, digest);
          const second = runIncrementalTo(tempHome, "inc-to-mem-d");
          expect(second.includedLayers as string[]).toContain("memory");
          expect(second.memoryDigest).not.toBe(digest);
          expect(
            readFileSync(
              join(tempDir, "inc-to-mem-d", "inc-to-mem-d", "memory", "test_memory.md"),
              "utf-8"
            )
          ).toContain("Something new was learned.");
        } finally {
          rmSync(tempHome, { recursive: true, force: true });
        }
      });
    });

  });

  describe("hub init/status CLI", () => {
    it("hub init then hub status round-trips through the CLI", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-hub-home-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-cli-hub-dir-"));
      try {
        const init = JSON.parse(
          (await runCli(["hub", "init", "--path", hubDir], homeEnv(home))).stdout
        );
        expect(init.success).toBe(true);
        expect(init.command).toBe("hub-init");
        const status = JSON.parse(
          (await runCli(["hub", "status"], homeEnv(home))).stdout
        );
        expect(status.reachable).toBe(true);
        expect(status.hubId).toBe(init.hubId);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(hubDir, { recursive: true, force: true });
      }
    });
  });

  describe("push CLI", () => {
    it("push creates a hub project and bundle for the current project's sessions", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-push-home-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-cli-push-hub-"));
      try {
        await runCli(["hub", "init", "--path", hubDir], homeEnv(home));

        // Hub identity writes .sesh-mover-project.json under the real
        // project directory, so (unlike plain export/import/migrate) push
        // needs a real, writable projectPath. The project is its OWN directory
        // here, not tempDir — the same reason the carry test below gives: the
        // fixture config dir lives under tempDir, so pushing tempDir itself
        // snapshotted `<tempDir>/.claude`, i.e. this test's own bundle carried
        // the fixture's transcripts inside the WORKSPACE payload. Relocate the
        // fixture's session data to that directory's encoded name so discovery
        // finds it there.
        const projectPath = join(tempDir, "pushproj");
        mkdirSync(projectPath, { recursive: true });
        writeFileSync(join(projectPath, "README.md"), "hello\n");
        const fixtureEncoded = "-Users-testuser-Projects-testproject";
        const realEncoded = encodeProjectPath(projectPath);
        cpSync(join(configDir, "projects", fixtureEncoded), join(configDir, "projects", realEncoded), {
          recursive: true,
        });

        const { stdout, stderr } = await runCli(
          ["push", "--project-path", projectPath, "--create-project", "--source-config-dir", configDir],
          homeEnv(home)
        );
        expect(stderr.trim()).toBe(""); // no --progress: stderr stays pristine
        const result = JSON.parse(stdout);
        expect(result.success).toBe(true);
        expect(result.command).toBe("push");
        expect(result.pushedSessions).toHaveLength(1);
        expect(result.upToDate).toBe(false);

        // Repeat push with no changes: up to date, no new bundle.
        const again = JSON.parse(
          (
            await runCli(["push", "--project-path", projectPath, "--source-config-dir", configDir], homeEnv(home))
          ).stdout
        );
        expect(again.success).toBe(true);
        expect(again.upToDate).toBe(true);
        expect(again.bundleId).toBeNull();
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(hubDir, { recursive: true, force: true });
      }
    });

    it("carry travels by default, and hub.carryDiff=false turns it off without a flag", () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-carry-home-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-cli-carry-hub-"));
      // The project is its OWN directory here, not tempDir: the fixture config
      // dir lives under tempDir, and a repo rooted there would carry the whole
      // fixture as untracked files.
      const projectPath = join(tempDir, "carryproj");
      mkdirSync(projectPath, { recursive: true });
      const realEncoded = encodeProjectPath(projectPath);
      const sessionPath = join(configDir, "projects", realEncoded, `${sessionId}.jsonl`);
      try {
        runCli(["hub", "init", "--path", hubDir], homeEnv(home));
        cpSync(
          join(configDir, "projects", "-Users-testuser-Projects-testproject"),
          join(configDir, "projects", realEncoded),
          { recursive: true }
        );
        const g = (args: string[]): void => {
          execFileSync("git", args, { cwd: projectPath, stdio: "ignore" });
        };
        g(["init", "-q"]);
        g(["config", "user.email", "t@example.com"]);
        g(["config", "user.name", "Test"]);
        g(["remote", "add", "origin", "https://github.com/User/Repo.git"]);
        writeFileSync(join(projectPath, "tracked.txt"), "v1\n");
        g(["add", "-A"]);
        g(["commit", "-q", "-m", "init"]);
        writeFileSync(join(projectPath, "tracked.txt"), "v2 uncommitted\n");

        const first = JSON.parse(
          runCli(
            ["push", "--project-path", projectPath, "--create-project", "--source-config-dir", configDir],
            homeEnv(home)
          ).stdout
        );
        expect(first.success).toBe(true);
        expect(first.carry.baseCommit).toMatch(/^[0-9a-f]{40}$/);

        // Second push, carry disabled in config only — the SessionEnd hook takes
        // no flags, so config is the ONLY way to opt out of uploading
        // uncommitted work and it has to be honored at the CLI boundary.
        const homeOverride = overrideHome(home);
        try {
          runCli(`configure --scope user --set hub.carryDiff=false --json`, homeEnv(home));
        } finally {
          homeOverride.restore();
        }
        writeFileSync(join(projectPath, "tracked.txt"), "v3 uncommitted\n");
        appendFileSync(
          sessionPath,
          JSON.stringify({
            type: "user", uuid: "carry-cfg-1", parentUuid: null, timestamp: new Date().toISOString(),
            cwd: projectPath, sessionId, version: "2.1.81",
            message: { role: "user", content: "more" },
          }) + "\n"
        );
        const second = JSON.parse(
          runCli(
            ["push", "--project-path", projectPath, "--source-config-dir", configDir],
            homeEnv(home)
          ).stdout
        );
        expect(second.success).toBe(true);
        expect(second.upToDate).toBe(false); // a real bundle, just no carry in it
        expect(second.carry).toBeUndefined();
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(hubDir, { recursive: true, force: true });
      }
    });

    it("hub.carryMaxMb reaches the payload builder — 0 declines, a bad value warns", () => {
      // The wiring test for the budgets, not the arithmetic (config.test.ts has
      // that): a budget nothing threads through the CLI is a setting that does
      // not exist, and the push that matters most is the unattended SessionEnd
      // one, which takes no flags at all.
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-budget-home-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-cli-budget-hub-"));
      const projectPath = join(tempDir, "budgetproj");
      mkdirSync(projectPath, { recursive: true });
      const realEncoded = encodeProjectPath(projectPath);
      const sessionPath = join(configDir, "projects", realEncoded, `${sessionId}.jsonl`);
      try {
        runCli(["hub", "init", "--path", hubDir], homeEnv(home));
        cpSync(
          join(configDir, "projects", "-Users-testuser-Projects-testproject"),
          join(configDir, "projects", realEncoded),
          { recursive: true }
        );
        const g = (args: string[]): void => {
          execFileSync("git", args, { cwd: projectPath, stdio: "ignore" });
        };
        g(["init", "-q"]);
        g(["config", "user.email", "t@example.com"]);
        g(["config", "user.name", "Test"]);
        g(["remote", "add", "origin", "https://github.com/User/Repo.git"]);
        writeFileSync(join(projectPath, "tracked.txt"), "v1\n");
        g(["add", "-A"]);
        g(["commit", "-q", "-m", "init"]);
        writeFileSync(join(projectPath, "tracked.txt"), "v2 uncommitted\n");

        const homeOverride = overrideHome(home);
        try {
          runCli(`configure --scope user --set hub.carryMaxMb=0 --json`, homeEnv(home));
        } finally {
          homeOverride.restore();
        }
        const zero = JSON.parse(
          runCli(
            ["push", "--project-path", projectPath, "--create-project", "--source-config-dir", configDir],
            homeEnv(home)
          ).stdout
        );
        expect(zero.success).toBe(true);
        // Fails CLOSED and says so: no carry in the bundle, and a warning that
        // names the setting rather than a size.
        expect(zero.carry).toBeUndefined();
        expect(zero.warnings.join(" ")).toContain("hub.carryMaxMb");

        // A value that is not a size: the default applies and the push says so
        // — silence here is indistinguishable from the setting working.
        writeFileSync(
          join(home, ".sesh-mover", "config.json"),
          JSON.stringify({ hub: { path: hubDir, carryMaxMb: "lots" } }, null, 2) + "\n"
        );
        writeFileSync(join(projectPath, "tracked.txt"), "v3 uncommitted\n");
        appendFileSync(
          sessionPath,
          JSON.stringify({
            type: "user", uuid: "budget-cfg-1", parentUuid: null, timestamp: new Date().toISOString(),
            cwd: projectPath, sessionId, version: "2.1.81",
            message: { role: "user", content: "more" },
          }) + "\n"
        );
        const bad = JSON.parse(
          runCli(
            ["push", "--project-path", projectPath, "--source-config-dir", configDir],
            homeEnv(home)
          ).stdout
        );
        expect(bad.success).toBe(true);
        expect(bad.warnings.join(" ")).toContain("hub.carryMaxMb");
        expect(bad.carry.baseCommit).toMatch(/^[0-9a-f]{40}$/); // the default applied
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(hubDir, { recursive: true, force: true });
      }
    });

    /**
     * The ordering half of the `--project-id` fix (#29), and the reason it is
     * worth more than the error shape.
     *
     * `hub push` decides identity early but only RESOLVES it after
     * `registerMachine` (a hub write), after minting a thread into local
     * sync-state, and after a full incremental export — so a typo'd
     * `--project-id` failed with residue already written, and the outer catch
     * rethrew rather than producing the typed `failed-after-link` shape,
     * because `commits` was still null. A validation failure must not happen
     * after side effects.
     *
     * The project needs real sessions or the export short-circuits on "No
     * sessions found" and the bad id is never reached at all.
     */
    it("refuses an unknown --project-id before the export and leaves no local or hub state", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-pushbadid-home-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-cli-pushbadid-hub-"));
      try {
        await runCli(["hub", "init", "--path", hubDir], homeEnv(home));

        const projectPath = join(tempDir, "badidpushproj");
        mkdirSync(projectPath, { recursive: true });
        writeFileSync(join(projectPath, "README.md"), "hello\n");
        cpSync(
          join(configDir, "projects", "-Users-testuser-Projects-testproject"),
          join(configDir, "projects", encodeProjectPath(projectPath)),
          { recursive: true }
        );

        const missingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const { stdout, status } = await runCli(
          ["push", "--project-path", projectPath, "--project-id", missingId,
            "--source-config-dir", configDir],
          homeEnv(home)
        );
        const result = JSON.parse(stdout);
        expect(result.success).toBe(false);
        expect(result.command).toBe("push");
        expect(result.reason).toBe("no-such-project");
        expect(result.requestedProjectId).toBe(missingId);
        expect(result.suggestion).toContain("--create-project");
        expect(status).not.toBe(0);

        // NOTHING happened. The sync-state file is the sharpest of these: push
        // mints a thread id into it before it resolves the identity, so its
        // absence is what says the refusal really did land ahead of the work.
        expect(
          existsSync(join(home, ".sesh-mover", "sync-state", `${encodeProjectPath(projectPath)}.json`))
        ).toBe(false);
        expect(existsSync(join(projectPath, ".sesh-mover-project.json"))).toBe(false);
        expect(existsSync(join(hubDir, "projects"))).toBe(false);
        expect(existsSync(join(hubDir, "bundles"))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(hubDir, { recursive: true, force: true });
      }
    });

    it("push without a configured hub returns an error", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-push-nohub-home-"));
      try {
        const result = JSON.parse(
          (
            await runCli(
              ["push", "--project-path", tempDir, "--source-config-dir", configDir],
              homeEnv(home)
            )
          ).stdout
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("No hub configured");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("push --progress emits NDJSON hub-push events on stderr while stdout stays one JSON object", async () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-cli-push-progress-home-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-cli-push-progress-hub-"));
      try {
        await runCli(["hub", "init", "--path", hubDir], homeEnv(home));

        // Same real-directory arrangement as the plain push CLI test above,
        // INCLUDING its isolation: hub identity writes
        // .sesh-mover-project.json under the real project directory, and the
        // fixture config dir lives under tempDir — so pushing tempDir itself
        // snapshotted `<tempDir>/.claude`, i.e. this test's own bundle carried
        // the fixture's transcripts inside the WORKSPACE payload. That is
        // currently harmless only because `.claude` sits on
        // DEFAULT_WORKSPACE_EXCLUDES, which `src/hub/workspace.ts` documents as
        // a re-includable convenience default rather than the NEVER_INCLUDABLE
        // floor — so a user-overridable policy, not directory isolation, was
        // holding this test's hygiene up. Own directory instead.
        const projectPath = join(tempDir, "progressproj");
        mkdirSync(projectPath, { recursive: true });
        writeFileSync(join(projectPath, "README.md"), "hello\n");
        const fixtureEncoded = "-Users-testuser-Projects-testproject";
        const realEncoded = encodeProjectPath(projectPath);
        cpSync(join(configDir, "projects", fixtureEncoded), join(configDir, "projects", realEncoded), {
          recursive: true,
        });

        const { stdout, stderr } = await runCli(
          ["push", "--project-path", projectPath, "--create-project", "--source-config-dir", configDir, "--progress"],
          homeEnv(home)
        );
        const result = JSON.parse(stdout); // throws if stdout isn't exactly one JSON doc
        expect(result.success).toBe(true);
        expect(result.command).toBe("push");

        const events = stderr
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        expect(events.length).toBeGreaterThan(0);
        // push's export step forwards onProgress too (export-copy events),
        // so only assert on the hub-push phase specifically.
        const hubPushEvents = events.filter((e) => e.phase === "hub-push");
        expect(hubPushEvents.some((e) => e.percent === 0)).toBe(true);
        expect(hubPushEvents.some((e) => e.percent === 100)).toBe(true);
        // The isolation above, made checkable: the push linked its own
        // directory and nothing else, so tempDir (which holds the fixture
        // config dir) was never the project being pushed.
        expect(existsSync(join(projectPath, ".sesh-mover-project.json"))).toBe(true);
        expect(existsSync(join(tempDir, ".sesh-mover-project.json"))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(hubDir, { recursive: true, force: true });
      }
    });
  });

  /**
   * THE EXIT-CODE CONTRACT (#76).
   *
   * `0` success · `1` the command did not run (bad invocation, or a throw) ·
   * `2` refusal · `3` environment-not-ready. Stated in CLAUDE.md, in every
   * command doc that can produce a non-zero code, and in SKILL.md.
   *
   * What this replaced was not a different rule but the ABSENCE of one: the
   * code a result took was decided by which output helper its call site
   * happened to reach, so every typed refusal exited 0 alongside every success
   * and `sesh-mover hub pull || handle_failure` was silently a no-op for the
   * whole refusal class. The class assignments below are the contract; several
   * assertions elsewhere in this file changed from `0`/`not.toBe(0)` to a
   * specific code as part of the same decision, each annotated at its site.
   */
  describe("exit codes", () => {
    /**
     * The classifier itself, exhaustively — one case per class, including the
     * two that no CLI-level test in this file reaches (`lock-busy` needs a
     * concurrent holder, `failed-after-link` needs a push to break mid-flight).
     *
     * `exitCodeForResult` reads exactly `success`, `pickRequired` and `reason`,
     * so the partial objects below are the whole input it sees; the cast is to
     * avoid restating fifteen irrelevant fields per case.
     */
    it("classifies each result shape into its documented class", () => {
      const cases: Array<[string, Record<string, unknown>, number]> = [
        ["a plain success", { success: true, command: "push" }, 0],
        // The one `success: true` shape that exits non-zero. `sesh-mover pull`
        // with neither --thread nor --latest pulls nothing — it answers with
        // the thread list and waits to be told which.
        [
          "the pick-required listing",
          { success: true, command: "pull", pickRequired: true, threads: [] },
          2,
        ],
        ["unlinked", { success: false, command: "push", reason: "unlinked" }, 2],
        ["no-such-project", { success: false, command: "pull", reason: "no-such-project" }, 2],
        ["project-retired", { success: false, command: "pull", reason: "project-retired" }, 2],
        ["not-owner", { success: false, command: "hub-retire", reason: "not-owner" }, 2],
        ["not-retired", { success: false, command: "hub-delete", reason: "not-retired" }, 2],
        ["project-gone", { success: false, command: "hub-delete", reason: "project-gone" }, 2],
        // NOT class 3, and the one worth stating: "wait and try again" sounds
        // retryable, but class 3 means retryable UNCHANGED IN A MOMENT and this
        // is a deliberate multi-day hold. Class 3 would invite a caller to loop.
        ["grace-period", { success: false, command: "hub-delete", reason: "grace-period" }, 2],
        ["hub-unreachable", { success: false, command: "pull", reason: "hub-unreachable" }, 3],
        ["lock-busy", { success: false, command: "push", reason: "lock-busy" }, 3],
        ["not-yet-synced", { success: false, command: "pull", reason: "not-yet-synced" }, 3],
        // A push that THREW past the identity decision: it may have left a
        // link, an orphan hub project or an unreferenced bundle behind. Not a
        // refusal ("nothing happened") and not retryable the way class 3 is.
        [
          "a push that failed after linking",
          { success: false, command: "push", reason: "failed-after-link" },
          1,
        ],
        // The untyped bucket: an ErrorResult a command RETURNED as a value,
        // having got far enough to describe the outcome. Class 2 by default —
        // an exception never reaches this function, `outputError` handles those.
        [
          "an untyped refusal returned as a value",
          {
            success: false,
            command: "pull",
            error: "Already up to date with the source machine.",
          },
          2,
        ],
      ];
      for (const [label, result, code] of cases) {
        expect(exitCodeForResult(result as unknown as CliResult), label).toBe(code);
      }
    });

    it("exits 1 for Commander's own argument validation, with nothing on stdout", () => {
      // `--from` is a requiredOption, so Commander refuses before any action
      // runs. The owner's mapping keeps this at 1 (it already was), and this
      // pins that the new scheme did not disturb it — nor teach Commander to
      // print a JSON body it has never printed.
      const r = runCli(["import"]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/--from/);
    });

    it("exits 0 for an ordinary success", () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-exit-ok-home-"));
      try {
        const r = runCli(["browse", "--storage", "user", "--json"], homeEnv(home));
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout).success).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("exits 2 for an unlinked project's push, alongside the pick list", () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-exit-unlinked-home-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-exit-unlinked-hub-"));
      const project = mkdtempSync(join(tmpdir(), "sesh-exit-unlinked-proj-"));
      try {
        expect(runCli(["hub", "init", "--path", hubDir], homeEnv(home)).status).toBe(0);
        const r = runCli(
          ["push", "--project-path", project, "--source-config-dir", configDir],
          homeEnv(home)
        );
        const result = JSON.parse(r.stdout);
        expect(result.success).toBe(false);
        expect(result.reason).toBe("unlinked");
        expect(result.suggestion).toBeTruthy();
        // The refusal class. Nothing was pushed and nothing was linked, which
        // is the state a shell caller's `|| handle` now actually observes.
        expect(r.status).toBe(2);
        expect(existsSync(join(project, ".sesh-mover-project.json"))).toBe(false);
      } finally {
        for (const d of [home, hubDir, project]) rmSync(d, { recursive: true, force: true });
      }
    });

    /**
     * `pick-required` is the one place a `success: true` body carries a
     * non-zero exit, and it is the assignment most worth pinning: it is
     * deliberate (the owner's mapping puts it in the refusal class) and it is
     * exactly the shape a future "success means 0" simplification would undo.
     *
     * The pull really did nothing — that is what makes 2 right — so this
     * asserts the no-op as well as the code.
     */
    it("exits 2 for a pull that requires a thread to be picked", () => {
      const home = mkdtempSync(join(tmpdir(), "sesh-exit-pick-home-"));
      const hubDir = mkdtempSync(join(tmpdir(), "sesh-exit-pick-hub-"));
      const projectPath = join(tempDir, "pickproj");
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(join(projectPath, "README.md"), "hello\n");
      try {
        cpSync(
          join(configDir, "projects", "-Users-testuser-Projects-testproject"),
          join(configDir, "projects", encodeProjectPath(projectPath)),
          { recursive: true }
        );
        expect(runCli(["hub", "init", "--path", hubDir], homeEnv(home)).status).toBe(0);
        const push = JSON.parse(
          runCli(
            ["push", "--project-path", projectPath, "--create-project",
              "--source-config-dir", configDir],
            homeEnv(home)
          ).stdout
        );
        expect(push.success).toBe(true);

        // Neither --thread nor --latest: the pick list.
        const r = runCli(
          ["pull", "--project-path", projectPath, "--source-config-dir", configDir],
          homeEnv(home)
        );
        const result = JSON.parse(r.stdout);
        expect(result.success).toBe(true);
        expect(result.pickRequired).toBe(true);
        expect(result.threads.length).toBeGreaterThan(0);
        expect(r.status).toBe(2);
        // Nothing was applied: no session was imported into this machine's
        // config dir beyond the one the push read.
        expect(result.importedSessions).toBeUndefined();
      } finally {
        for (const d of [home, hubDir]) rmSync(d, { recursive: true, force: true });
      }
    });
  });
});
