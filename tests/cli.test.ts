import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  writeFileSync,
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
import { overrideHome, homeEnv, prependPath } from "./helpers/env.js";

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

  // String form (existing call sites): shells out via execSync, returns stdout
  // only — unchanged behavior. Array form (new): uses spawnSync without a
  // shell so stdout/stderr are captured separately, for tests that need to
  // assert on stderr (e.g. --progress NDJSON) without polluting the test
  // runner's own stderr.
  function runCli(args: string, envOverrides?: Record<string, string>): string;
  function runCli(
    args: string[],
    envOverrides?: Record<string, string>
  ): { stdout: string; stderr: string };
  function runCli(
    args: string | string[],
    envOverrides?: Record<string, string>
  ): string | { stdout: string; stderr: string } {
    const cliPath = join(import.meta.dirname, "..", "dist", "cli.js");
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...envOverrides };
    if (Array.isArray(args)) {
      const result = spawnSync("node", [cliPath, ...args], {
        encoding: "utf-8",
        env,
      });
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }
    return execSync(`node "${cliPath}" ${args}`, {
      encoding: "utf-8",
      env,
    });
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
      expect(caught!.status).not.toBe(0);
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
      expect(caught!.status).not.toBe(0);
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
      // A platform no test runner is: proves browse reads the archive rather
      // than reporting its own detectPlatform().
      sourcePlatform: "win32",
      sourceProjectPath: "C:\\Users\\someone\\Projects\\faraway",
      sourceConfigDir: "C:\\Users\\someone\\.claude",
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
      const store = join(homeDir, ".claude-sesh-mover");
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
      expect(entry.sourcePlatform).toBe("win32");
      expect(entry.sourcePlatform).not.toBe(platform());
      expect(entry.sourceProjectPath).toBe("C:\\Users\\someone\\Projects\\faraway");
      expect(entry.exportedAt).toBe("2026-07-25T18:30:48.718Z");
      expect(entry.sessionCount).toBe(1);
      expect(entry.sessions).toHaveLength(1);
      expect(entry.sessions[0].messageCount).toBe(2731);
      expect(entry.storage).toBe("user");
    });

    it("marks an unreadable archive honestly instead of inventing values", () => {
      const homeDir = join(tempDir, "browse-home-broken");
      const store = join(homeDir, ".claude-sesh-mover");
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
      // .claude-sesh-mover scan, which keeps its date-prefix filename filter.
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
      expect(entry.sourcePlatform).toBe("win32");
      expect(entry.sourceProjectPath).toBe("C:\\Users\\someone\\Projects\\faraway");
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
      const store = join(homeDir, ".claude-sesh-mover");
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
      // per archive.
      const tmpRoot = join(tempDir, "many-tmproot");
      mkdirSync(tmpRoot, { recursive: true });
      const result = JSON.parse(
        runCli(`browse --storage user --json`, { ...homeEnv(homeDir), TMPDIR: tmpRoot })
      );

      expect(result.success).toBe(true);
      const names = result.exports.map((e: { name: string }) => e.name).sort();
      expect(names).toEqual(expected);
      expect(
        result.exports.every(
          (e: { metadataAvailable: boolean; sourcePlatform: string }) =>
            e.metadataAvailable === true && e.sourcePlatform === "win32"
        )
      ).toBe(true);
      expect(readdirSync(tmpRoot).filter((n) => n.startsWith("sesh-manifest-"))).toEqual([]);
    });

    it.skipIf(isWindows)(
      "degrades only the archive that hits a resource failure and still lists the rest",
      async () => {
        const homeDir = join(tempDir, "mixed-home");
        const store = join(homeDir, ".claude-sesh-mover");
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
            expect(byName[ok].sourcePlatform).toBe("win32");
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
      const store = join(homeDir, ".claude-sesh-mover");
      mkdirSync(store, { recursive: true });
      const dirExport = join(store, "2026-07-25-dir-export");
      mkdirSync(dirExport, { recursive: true });
      writeFileSync(join(dirExport, "manifest.json"), JSON.stringify(FOREIGN_MANIFEST));
      await writeForeignArchive(join(store, "2026-07-25-a.tar.gz"));
      await writeForeignArchive(join(store, "2026-07-25-b.tar.gz"));

      const result = JSON.parse(
        runCli(`browse --storage user --json`, {
          ...homeEnv(homeDir),
          TMPDIR: join(tempDir, "no-such-temp-root"),
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
      expect(dirEntry.sourcePlatform).toBe("win32");
    });
  });

  describe("configure command", () => {
    it("shows current config", () => {
      const output = runCli("configure --show --json");
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.config.export.storage).toBe("user");
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

    it("returns clean ErrorResult JSON for malformed --set JSON values", () => {
      let caught: { stdout: string; status: number } | null = null;
      try {
        runCli(`configure --scope user --set 'export.exclude=[unclosed'`);
      } catch (e) {
        const err = e as { stdout?: Buffer; status?: number };
        caught = { stdout: err.stdout ? err.stdout.toString() : "", status: err.status ?? 0 };
      }
      expect(caught).not.toBeNull();
      expect(caught!.status).not.toBe(0);
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
        const seshDir = join(tempHome, ".claude-sesh-mover");
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
        expect(caught!.status).not.toBe(0);
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
      expect(caught!.status).not.toBe(0);
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

        // Hub identity writes .claude-sesh-mover/project.json under the real
        // project directory, so (unlike plain export/import/migrate) push
        // needs a real, writable projectPath. Reuse tempDir (already real,
        // from beforeEach) and relocate the fixture's session data to
        // tempDir's own encoded name so discovery finds it there.
        const fixtureEncoded = "-Users-testuser-Projects-testproject";
        const realEncoded = encodeProjectPath(tempDir);
        cpSync(join(configDir, "projects", fixtureEncoded), join(configDir, "projects", realEncoded), {
          recursive: true,
        });

        const { stdout, stderr } = await runCli(
          ["push", "--project-path", tempDir, "--create-project", "--source-config-dir", configDir],
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
            await runCli(["push", "--project-path", tempDir, "--source-config-dir", configDir], homeEnv(home))
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

        // Same real-directory arrangement as the plain push CLI test above —
        // hub identity writes .claude-sesh-mover/project.json under the real
        // project directory.
        const fixtureEncoded = "-Users-testuser-Projects-testproject";
        const realEncoded = encodeProjectPath(tempDir);
        cpSync(join(configDir, "projects", fixtureEncoded), join(configDir, "projects", realEncoded), {
          recursive: true,
        });

        const { stdout, stderr } = await runCli(
          ["push", "--project-path", tempDir, "--create-project", "--source-config-dir", configDir, "--progress"],
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
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(hubDir, { recursive: true, force: true });
      }
    });
  });
});
