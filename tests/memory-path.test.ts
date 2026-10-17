import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { git } from "./helpers/project-tree.js";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";
import {
  canonicalGitRoot,
  projectFolderNameOverride,
  resolveMemoryDir,
} from "../src/memory-path.js";

/**
 * #150 — Claude Code keys a project's MEMORY on the canonical git root of the
 * directory a session was started in, and its TRANSCRIPTS on that directory
 * itself. sesh-mover read and wrote memory out of the transcript folder, so a
 * session started in a subdirectory or a linked worktree shipped no memory and
 * an import into one landed memory where Claude Code never reads it.
 *
 * Real temp trees and real `git`, per the repo's testing conventions — the
 * worktree half in particular cannot be faked: what is under test is the shape
 * of the `.git` FILE a linked worktree gets, which only git writes.
 */
describe("memory path (#150)", () => {
  const ENV_KEYS = [
    "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
    "CLAUDE_CODE_REMOTE_MEMORY_DIR",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_PROJECT_DIR_NAME",
  ] as const;

  let tempDir: string;
  let home: HomeOverrideHandle;
  let savedEnv: Array<[string, string | undefined]>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-memory-path-"));
    home = overrideHome(tempDir);
    // Hermetic: these four steer the resolver, and a runner that happens to
    // have one set would otherwise change which folder the assertions see.
    savedEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    home.restore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A repository with a committed (empty) HEAD, a subdirectory, and a linked worktree. */
  function makeRepo(name: string): {
    repo: string;
    subdir: string;
    worktree: string;
  } {
    const repo = join(tempDir, name);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
    const subdir = join(repo, "sub", "dir");
    mkdirSync(subdir, { recursive: true });
    const worktree = join(tempDir, `${name}-wt1`);
    git(repo, ["worktree", "add", "-q", worktree]);
    return { repo, subdir, worktree };
  }

  const configDir = (): string => join(tempDir, "claude");

  describe("canonicalGitRoot", () => {
    it("answers null for a directory that is not in a repository", () => {
      const plain = join(tempDir, "plain");
      mkdirSync(plain, { recursive: true });
      expect(canonicalGitRoot(plain)).toBeNull();
    });

    it("walks a subdirectory up to the repository root", () => {
      const { repo, subdir } = makeRepo("walk-repo");
      expect(canonicalGitRoot(subdir)).toBe(repo);
      expect(canonicalGitRoot(repo)).toBe(repo);
    });

    it("follows a linked worktree's gitdir: pointer to the MAIN working tree", () => {
      const { repo, worktree } = makeRepo("wt-repo");
      // The pointer's spelling comes out of git's own file, so compare the
      // resolved paths rather than the byte strings git happened to write.
      const root = canonicalGitRoot(worktree);
      expect(root).not.toBeNull();
      expect(resolve(root!)).toBe(resolve(repo));
    });
  });

  describe("resolveMemoryDir", () => {
    it("keeps the plain-directory answer: the path itself, under the config dir", () => {
      const plain = join(tempDir, "plain");
      mkdirSync(plain, { recursive: true });
      expect(resolveMemoryDir(configDir(), plain)).toBe(
        join(configDir(), "projects", encodeProjectPath(plain), "memory")
      );
    });

    it("keys a subdirectory's memory on the repository root, NOT on the transcript folder", () => {
      const { repo, subdir } = makeRepo("sub-repo");
      const expected = join(
        configDir(),
        "projects",
        encodeProjectPath(repo),
        "memory"
      );
      expect(resolveMemoryDir(configDir(), subdir)).toBe(expected);
      // The defect, stated as the two folders Claude Code keeps apart: the
      // transcript folder is the subdir's encoding, and it is NOT the memory
      // folder — reading memory out of it (the pre-#150 rule) finds nothing.
      expect(join(configDir(), "projects", encodeProjectPath(subdir), "memory")).not.toBe(
        expected
      );
    });

    it("keys a linked worktree's memory on the main working tree's folder", () => {
      const { repo, worktree } = makeRepo("wtmem-repo");
      expect(resolveMemoryDir(configDir(), worktree)).toBe(
        join(configDir(), "projects", encodeProjectPath(repo), "memory")
      );
    });

    it("honors CLAUDE_COWORK_MEMORY_PATH_OVERRIDE only for the config dir the environment names", () => {
      const { repo, subdir } = makeRepo("cowork-repo");
      const override = join(tempDir, "cowork-memory");
      process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = override;

      // The environment names no config dir at all: the default (~/.claude
      // under the overridden HOME) is what a Claude Code process here would
      // use, so the default config dir is the one that gets the override.
      process.env.CLAUDE_CONFIG_DIR = configDir();
      expect(resolveMemoryDir(configDir(), subdir)).toBe(override);

      // A run that names ANOTHER config dir must not be steered by an
      // environment describing this one (#152's rule).
      const other = join(tempDir, "other-claude");
      mkdirSync(other, { recursive: true });
      expect(resolveMemoryDir(other, subdir)).toBe(
        join(other, "projects", encodeProjectPath(repo), "memory")
      );
    });

    it("uses CLAUDE_CODE_REMOTE_MEMORY_DIR as the base when the environment names this config dir", () => {
      const { repo, subdir } = makeRepo("remote-repo");
      process.env.CLAUDE_CONFIG_DIR = configDir();
      const remote = join(tempDir, "remote-memory");
      process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = remote;

      expect(resolveMemoryDir(configDir(), subdir)).toBe(
        join(remote, "projects", encodeProjectPath(repo), "memory")
      );

      // ...and not for a config dir the environment does not name.
      const other = join(tempDir, "other-claude");
      mkdirSync(other, { recursive: true });
      expect(resolveMemoryDir(other, subdir)).toBe(
        join(other, "projects", encodeProjectPath(repo), "memory")
      );
    });

    it("reads autoMemoryDirectory from user settings, above the git-root answer", () => {
      const { repo, subdir } = makeRepo("setting-repo");
      mkdirSync(configDir(), { recursive: true });
      const configured = join(tempDir, "configured-memory");
      writeFileSync(
        join(configDir(), "settings.json"),
        JSON.stringify({ autoMemoryDirectory: configured })
      );

      expect(resolveMemoryDir(configDir(), subdir)).toBe(configured);
      // The setting does not move the root: the project settings file is still
      // looked for at the repository root, which is where this put them.
      expect(canonicalGitRoot(subdir)).toBe(repo);
    });

    it("lets project settings win over user settings, in Claude Code's precedence", () => {
      const { repo } = makeRepo("projsetting-repo");
      mkdirSync(configDir(), { recursive: true });
      const userLevel = join(tempDir, "user-memory");
      const projectLevel = join(tempDir, "project-memory");
      writeFileSync(
        join(configDir(), "settings.json"),
        JSON.stringify({ autoMemoryDirectory: userLevel })
      );
      mkdirSync(join(repo, ".claude"), { recursive: true });
      writeFileSync(
        join(repo, ".claude", "settings.json"),
        JSON.stringify({ autoMemoryDirectory: projectLevel })
      );

      expect(resolveMemoryDir(configDir(), repo)).toBe(projectLevel);
    });

    it("applies CLAUDE_CODE_PROJECT_DIR_NAME to the folder when the base is the config dir", () => {
      const { subdir } = makeRepo("override-repo");
      process.env.CLAUDE_CONFIG_DIR = configDir();
      process.env.CLAUDE_CODE_PROJECT_DIR_NAME = "my-project";
      expect(projectFolderNameOverride(configDir())).toBe("my-project");
      expect(resolveMemoryDir(configDir(), subdir)).toBe(
        join(configDir(), "projects", "my-project", "memory")
      );

      // Claude Code's own checks: a value its regex rejects is not an override.
      process.env.CLAUDE_CODE_PROJECT_DIR_NAME = "my.project";
      expect(projectFolderNameOverride(configDir())).toBeNull();
      expect(resolveMemoryDir(configDir(), subdir)).not.toBe(
        join(configDir(), "projects", "my.project", "memory")
      );
    });

    it("does not apply the folder-name override to a config dir the environment does not name", () => {
      const { repo } = makeRepo("naming-repo");
      process.env.CLAUDE_CONFIG_DIR = configDir();
      process.env.CLAUDE_CODE_PROJECT_DIR_NAME = "my-project";
      const other = join(tempDir, "other-claude");
      mkdirSync(other, { recursive: true });

      expect(projectFolderNameOverride(other)).toBeNull();
      expect(resolveMemoryDir(other, repo)).toBe(
        join(other, "projects", encodeProjectPath(repo), "memory")
      );
    });
  });

  /**
   * The end-to-end halves of #150, each written so it FAILS against the old
   * rule ("memory lives in the transcript folder") and passes with the
   * resolver wired in.
   */
  describe("export and import through the real code paths", () => {
    /** A minimal conversation transcript, keyed on the directory Claude Code filed it under. */
    function writeSession(
      configDirPath: string,
      encodedDir: string,
      sessionId: string,
      cwd: string
    ): void {
      // Claude Code's layout: the transcript is `<encoded>/<sessionId>.jsonl`,
      // a FILE BESIDE the session's own directory (which holds
      // `subagents/` and `tool-results/`), never inside it.
      const dir = join(configDirPath, "projects", encodedDir);
      mkdirSync(join(dir, sessionId), { recursive: true });
      const entries = [
        {
          uuid: "entry-1",
          timestamp: "2026-04-10T12:00:00Z",
          sessionId,
          cwd,
          version: "2.1.81",
          gitBranch: "main",
          slug: "test-session",
          type: "user",
          message: { role: "user", content: "Hello" },
        },
        {
          uuid: "entry-2",
          timestamp: "2026-04-10T12:00:05Z",
          sessionId,
          cwd,
          version: "2.1.81",
          gitBranch: "main",
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            id: "msg_test",
            content: [{ type: "text", text: "Hi." }],
          },
          parentUuid: "entry-1",
        },
      ];
      writeFileSync(
        join(dir, `${sessionId}.jsonl`),
        entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
      );
    }

    /** Claude Code's memory for `projectRoot`: the one folder that holds it. */
    function writeMemory(configDirPath: string, projectRoot: string): string {
      const memoryDir = join(
        configDirPath,
        "projects",
        encodeProjectPath(projectRoot),
        "memory"
      );
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(
        join(memoryDir, "MEMORY.md"),
        "- [Test memory](test_memory.md) — remembering test patterns\n"
      );
      writeFileSync(
        join(memoryDir, "test_memory.md"),
        "---\nname: Test memory\n---\n\nUse vitest for testing.\n"
      );
      return memoryDir;
    }

    async function exportFrom(
      configDirPath: string,
      projectPath: string,
      sessionId: string,
      name: string
    ) {
      const { exportSession } = await import("../src/exporter.js");
      return exportSession({
        configDir: configDirPath,
        projectPath,
        sessionId,
        outputDir: join(tempDir, "exports"),
        name,
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });
    }

    it("an export from a repository SUBDIRECTORY carries the memory kept at the root", async () => {
      const { repo, subdir } = makeRepo("export-sub-repo");
      const cfg = configDir();
      const sessionId = "550e8400-e29b-41d4-a716-446655440000";
      writeSession(cfg, encodeProjectPath(subdir), sessionId, subdir);
      writeMemory(cfg, repo);
      // The repro, stated: there is no memory in the transcript folder, which
      // is exactly what the exporter used to read and why it shipped none
      // while reporting success and no warnings.
      expect(
        existsSync(join(cfg, "projects", encodeProjectPath(subdir), "memory"))
      ).toBe(false);

      const result = await exportFrom(cfg, subdir, sessionId, "subdir-export");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(existsSync(join(result.exportPath, "memory", "MEMORY.md"))).toBe(
        true
      );
      expect(existsSync(join(result.exportPath, "memory", "test_memory.md"))).toBe(
        true
      );
      const manifest = JSON.parse(
        readFileSync(join(result.exportPath, "manifest.json"), "utf-8")
      );
      expect(manifest.includedLayers).toContain("memory");
      expect(manifest.memoryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("an export from a LINKED WORKTREE carries the main working tree's memory", async () => {
      const { repo, worktree } = makeRepo("export-wt-repo");
      const cfg = configDir();
      const sessionId = "550e8400-e29b-41d4-a716-446655440001";
      writeSession(cfg, encodeProjectPath(worktree), sessionId, worktree);
      writeMemory(cfg, repo);

      const result = await exportFrom(cfg, worktree, sessionId, "worktree-export");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(existsSync(join(result.exportPath, "memory", "MEMORY.md"))).toBe(
        true
      );
      const manifest = JSON.parse(
        readFileSync(join(result.exportPath, "manifest.json"), "utf-8")
      );
      expect(manifest.includedLayers).toContain("memory");
    });

    it("an import into a repository SUBDIRECTORY lands memory at the repository root", async () => {
      // Source: the ordinary fixture export (its memory lives under its own
      // config dir's encoded project folder).
      const fixture = createFixtureTree(tempDir);
      const exported = await exportFrom(
        fixture.configDir,
        "/Users/testuser/Projects/testproject",
        fixture.sessionId,
        "fixture-export"
      );
      expect(exported.success).toBe(true);
      if (!exported.success) return;

      // Target: a real repository, imported into one of its subdirectories.
      const { repo, subdir } = makeRepo("import-target-repo");
      const targetConfigDir = join(tempDir, "target-claude");
      mkdirSync(join(targetConfigDir, "projects"), { recursive: true });

      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath: exported.exportPath,
        targetConfigDir,
        targetProjectPath: subdir,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const rootMemory = join(
        targetConfigDir,
        "projects",
        encodeProjectPath(repo),
        "memory"
      );
      expect(existsSync(join(rootMemory, "MEMORY.md"))).toBe(true);
      expect(existsSync(join(rootMemory, "test_memory.md"))).toBe(true);
      // The folder Claude Code does NOT read memory from must stay empty of it
      // — this is where the pre-#150 importer wrote it.
      expect(
        existsSync(join(targetConfigDir, "projects", encodeProjectPath(subdir), "memory"))
      ).toBe(false);
      // The reported `memoryDir` has to name where the files went.
      expect(result.memoryDir).toBe(rootMemory);
      // A fresh destination takes route 1 — the bundle's MEMORY.md lands whole
      // — so `added` (the union route's count) is rightly empty. What must hold
      // is #49's property, at the destination Claude Code reads: every file
      // that landed is referenced by the index that landed beside it.
      expect(result.memoryIndex?.added).toEqual([]);
      expect(result.memoryIndex?.unindexed ?? []).toEqual([]);
      expect(readFileSync(join(rootMemory, "MEMORY.md"), "utf-8")).toContain(
        "test_memory.md"
      );
    });
  });
});
