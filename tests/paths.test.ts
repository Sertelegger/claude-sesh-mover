import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import {
  isPluginStateName, userSeshMoverDir,
  includeFilePath, ignoreFilePath, projectJsonFilePath, projectSeshMoverDir,
  PLUGIN_STATE_NAMES, INCLUDE_FILE_NAME, IGNORE_FILE_NAME,
} from "../src/paths.js";
import { readIncludePatterns, readIgnorePatterns } from "../src/payload/workspace.js";

/**
 * The on-disk names, and 0.8.0's clean break.
 *
 * 0.8.0 stopped carrying the two preceding releases' renames: no old spelling is
 * read, none is migrated, and none is warned about. So the tests here are the
 * executable form of two claims — the user directory is simply `~/.sesh-mover`,
 * and a project holding a pre-0.8.0 file is read as not configured rather than
 * partly configured.
 *
 * EVERY test that touches a home directory points HOME at a fresh `mkdtemp`
 * first. Never the real one.
 */

const homes: string[] = [];
let handle: HomeOverrideHandle | null = null;

/** A fresh, isolated HOME. Never the real one — this suite is ABOUT that dir. */
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sesh-paths-home-"));
  homes.push(home);
  handle?.restore();
  handle = overrideHome(home);
  return home;
}

afterEach(() => {
  handle?.restore();
  handle = null;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("user-scope directory", () => {
  it("is simply ~/.sesh-mover, and resolving it creates nothing", () => {
    const home = freshHome();
    expect(userSeshMoverDir()).toBe(join(home, ".sesh-mover"));
    // A resolution is not a write: a first run that only READS config must not
    // leave a directory behind in the user's home.
    expect(readdirSync(home)).toEqual([]);
  });

  it("re-reads HOME on every call, so a repointed home resolves afresh", () => {
    const first = freshHome();
    expect(userSeshMoverDir()).toBe(join(first, ".sesh-mover"));
    const second = freshHome();
    expect(userSeshMoverDir()).toBe(join(second, ".sesh-mover"));
  });

  it("leaves a pre-0.8.0 user directory strictly alone — no move, no read", async () => {
    // The clean break, at the one place a previous release did migrate. 0.7.0
    // renamed `~/.claude-sesh-mover` to `~/.sesh-mover` so a machine kept its
    // hub identity across that release; 0.8.0 does not, and a machine that
    // never took the 0.7.0 upgrade starts fresh — which is the whole point.
    // What must NOT happen is a half-state: reading the old directory, or
    // touching it at all.
    const home = freshHome();
    const legacy = join(home, ".claude-sesh-mover");
    mkdirSync(join(legacy, "sync-state"), { recursive: true });
    writeFileSync(
      join(legacy, "machine-id.json"),
      JSON.stringify({ id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", name: "old-box" }) + "\n"
    );

    expect(userSeshMoverDir()).toBe(join(home, ".sesh-mover"));
    // Untouched: still there, still holding what it held.
    expect(readdirSync(home)).toEqual([".claude-sesh-mover"]);
    expect(readdirSync(legacy).sort()).toEqual(["machine-id.json", "sync-state"]);
    // And not read: a fresh identity is minted at the new path, not adopted
    // from the old one.
    const { loadOrCreateMachineId } = await import("../src/machine.js");
    expect(loadOrCreateMachineId().id).not.toBe("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
  });
});

describe("project-scope names", () => {
  it("the three committed files are ROOT dotfiles, and exports keep their own directory", () => {
    const project = "/tmp/example-project";
    expect(includeFilePath(project)).toBe(join(project, ".sesh-mover-include"));
    expect(ignoreFilePath(project)).toBe(join(project, ".sesh-mover-ignore"));
    expect(projectJsonFilePath(project)).toBe(join(project, ".sesh-mover-project.json"));
    expect(projectSeshMoverDir(project)).toBe(join(project, ".sesh-mover"));
  });

  it("isPluginStateName knows every name this plugin owns", () => {
    for (const n of [
      ".sesh-mover", ".sesh-mover-include", ".sesh-mover-ignore",
      ".sesh-mover-project.json",
    ]) {
      expect([n, isPluginStateName(n)]).toEqual([n, true]);
    }
    for (const n of [
      "src", "README.md", ".git", ".claude", ".sesh-mover-notes",
      // Retired spellings. 0.8.0 reads none of them, so none is plugin state
      // this version has any opinion about — a project holding one holds an
      // ordinary file.
      ".claude-sesh-mover", ".sesh-mover-hubinclude", ".sesh-mover-hubignore",
    ]) {
      expect([n, isPluginStateName(n)]).toEqual([n, false]);
    }
  });

  it("PLUGIN_STATE_NAMES is the ONE list every side derives from — exact contents", () => {
    // This is the single list `NEVER_INCLUDABLE` is built from, so it is the one
    // place where editing a line changes what the workspace walk, the merge, the
    // unpack, the `git` pathspecs and the patch byte scan all refuse at once.
    // Adding a name protects it everywhere; removing one un-protects it
    // everywhere. Either direction is a deliberate change, and a failure here is
    // the prompt to make sure it was.
    //
    // 0.8.0 SHRANK this list on purpose: `.claude-sesh-mover` (pre-0.7.0) and
    // the 0.7.0-only `.sesh-mover-hubinclude` / `.sesh-mover-hubignore` came off
    // it, because that release stopped reading anything an earlier one wrote. A
    // name on the floor guards against a payload planting a file some reader
    // consults; with no reader left, those three guarded nothing.
    expect(PLUGIN_STATE_NAMES).toEqual([
      ".sesh-mover",
      ".sesh-mover-include",
      ".sesh-mover-ignore",
      ".sesh-mover-project.json",
    ]);
    expect(INCLUDE_FILE_NAME).toBe(".sesh-mover-include");
    expect(IGNORE_FILE_NAME).toBe(".sesh-mover-ignore");
  });

  it("a project holding only pre-0.8.0 names is read as having NO lists at all", () => {
    // The clean break, project side: no migration, no fallback read, and no
    // stale-name warning either. A silently HALF-read list would be worse than
    // none — an include list is security-relevant (it decides what leaves the
    // machine), so "not configured" is the recoverable failure and "partly
    // configured from a file you thought you had renamed" is not.
    const dir = mkdtempSync(join(tmpdir(), "sesh-legacy-lists-"));
    try {
      writeFileSync(join(dir, ".sesh-mover-hubinclude"), "docs/\n"); // 0.7.0
      writeFileSync(join(dir, ".sesh-mover-hubignore"), "build\n");
      mkdirSync(join(dir, ".claude-sesh-mover"), { recursive: true }); // pre-0.7.0
      writeFileSync(join(dir, ".claude-sesh-mover", "hubinclude"), "docs/\n");
      writeFileSync(join(dir, ".claude-sesh-mover", "hubignore"), "build\n");
      expect(readIncludePatterns(dir)).toEqual([]);
      expect(readIgnorePatterns(dir)).toEqual([]);
      // ...and the current names are what a reader picks up.
      writeFileSync(join(dir, ".sesh-mover-include"), "docs/\n");
      writeFileSync(join(dir, ".sesh-mover-ignore"), "build\n");
      expect(readIncludePatterns(dir)).toEqual(["docs/"]);
      expect(readIgnorePatterns(dir)).toEqual(["build"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
