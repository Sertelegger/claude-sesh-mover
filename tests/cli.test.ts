import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

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

  function runCli(args: string): string {
    const cliPath = join(__dirname, "..", "dist", "cli.js");
    return execSync(`node "${cliPath}" ${args}`, {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
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
        require("node:fs").readFileSync(manifestPath, "utf-8")
      );
      expect(manifest.sessionScope).toBe("all");
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

  describe("configure command", () => {
    it("shows current config", () => {
      const output = runCli("configure --show --json");
      const result = JSON.parse(output);
      expect(result.success).toBe(true);
      expect(result.config.export.storage).toBe("user");
    });

    it("sets machine.name via --set", () => {
      const prevHome = process.env.HOME;
      process.env.HOME = tempDir;
      try {
        const output = runCli(`configure --scope user --set machine.name=my-laptop --json`);
        const result = JSON.parse(output);
        expect(result.success).toBe(true);
        expect(result.message).toMatch(/machine\.name\s*=\s*my-laptop/);
      } finally {
        if (prevHome !== undefined) process.env.HOME = prevHome;
        else delete process.env.HOME;
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
  });
});
