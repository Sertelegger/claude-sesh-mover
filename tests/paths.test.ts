import { describe, it, expect, afterEach } from "vitest";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import {
  isPluginStateName, resolveUserSeshMoverDir, userDirWarnings, userSeshMoverDir,
  includeFilePath, ignoreFilePath, projectJsonFilePath, projectSeshMoverDir,
  PLUGIN_STATE_NAMES, INCLUDE_FILE_NAME, IGNORE_FILE_NAME, LEGACY_DIR_NAME,
  LEGACY_INCLUDE_FILE_NAME, LEGACY_IGNORE_FILE_NAME,
} from "../src/paths.js";
import { readIncludePatterns, readIgnorePatterns } from "../src/hub/workspace.js";

/**
 * The user-scope directory migration, case by case.
 *
 * This is the one part of the 0.7.0 rename that is not a find-and-replace:
 * `~/.claude-sesh-mover` holds `machine-id.json` and `sync-state/`, so a
 * version that merely READS a new path mints a new machine identity — the hub
 * then sees a machine that has never pushed, every peer ledger resets, the next
 * push re-uploads every session as a full bundle, and the old machine's index
 * and machine record stay on the hub forever (nothing calls `backend.delete`).
 * Each test below fails without the migration, and the ones that assert the
 * degrade paths fail if the migration ever becomes unconditional.
 *
 * EVERY test points HOME at a fresh `mkdtemp` directory before touching
 * anything. `resolveUserSeshMoverDir` memoizes per home, which is also what
 * keeps these tests independent: a new temp home is a new resolution.
 */

const isWindows = platform() === "win32";
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
  for (const h of homes.splice(0)) {
    try {
      chmodSync(h, 0o700);
    } catch { /* best effort; only the EACCES test lowers it */ }
    rmSync(h, { recursive: true, force: true });
  }
});

/** A legacy user directory with a pinned machine id and one sync-state file. */
function seedLegacy(home: string, machineId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"): string {
  const legacy = join(home, ".claude-sesh-mover");
  mkdirSync(join(legacy, "sync-state"), { recursive: true });
  writeFileSync(
    join(legacy, "machine-id.json"),
    JSON.stringify({ id: machineId, name: "old-box", createdAt: "2026-01-01T00:00:00Z" }) + "\n"
  );
  writeFileSync(
    join(legacy, "sync-state", "-tmp-proj.json"),
    JSON.stringify({
      projectPath: "/tmp/proj",
      schemaVersion: 1,
      // A real peer ledger: the thing that is lost, silently, if the directory
      // is left behind (the next push then re-uploads every session in full).
      peers: { hub: { name: "hub", received: {}, sent: { "sess-1": { entryCount: 7 } } } },
      lineage: {},
      imported: {},
    }) + "\n"
  );
  return legacy;
}

describe("user directory migration", () => {
  it("case 1 — neither directory exists: uses the new name, creates nothing, says nothing", () => {
    const home = freshHome();
    const r = resolveUserSeshMoverDir();
    expect(r).toEqual({ dir: join(home, ".sesh-mover"), state: "fresh", warning: null });
    expect(userDirWarnings()).toEqual([]);
    // A resolution is not a write: a first run that only READS config must not
    // leave a directory behind in the user's home.
    expect(readdirSync(home)).toEqual([]);
  });

  it("case 2 — only the legacy directory exists: it is MOVED, identity and sync state intact", async () => {
    const home = freshHome();
    const legacy = seedLegacy(home);
    const current = join(home, ".sesh-mover");

    const r = resolveUserSeshMoverDir();
    expect(r.state).toBe("migrated");
    expect(r.dir).toBe(current);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(current)).toBe(true);

    // The whole point: the machine keeps its identity, so the hub keeps seeing
    // the same machine. Read through the real reader, not through the file.
    const { loadOrCreateMachineId } = await import("../src/machine.js");
    expect(loadOrCreateMachineId().id).toBe("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    expect(loadOrCreateMachineId().name).toBe("old-box");
    // And its per-project sync bookkeeping came along byte for byte.
    const { readSyncState } = await import("../src/sync-state.js");
    expect(readSyncState("/tmp/proj").peers.hub?.sent["sess-1"]?.entryCount).toBe(7);

    const warning = r.warning ?? "";
    expect(warning).toContain(legacy);
    expect(warning).toContain(current);
    expect(userDirWarnings()).toEqual([warning]);
  });

  it("case 3 — both exist: neither is clobbered, the current name wins, and it warns", () => {
    const home = freshHome();
    const legacy = seedLegacy(home, "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb");
    const current = join(home, ".sesh-mover");
    mkdirSync(current, { recursive: true });
    writeFileSync(
      join(current, "machine-id.json"),
      JSON.stringify({ id: "cccccccc-3333-4333-8333-cccccccccccc", name: "new-box", createdAt: "2026-06-01T00:00:00Z" }) + "\n"
    );

    const r = resolveUserSeshMoverDir();
    expect(r.state).toBe("both");
    expect(r.dir).toBe(current);
    // Neither identity is destroyed — that is the entire reason this branch
    // refuses to merge them.
    expect(JSON.parse(readFileSync(join(legacy, "machine-id.json"), "utf-8")).id)
      .toBe("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb");
    expect(JSON.parse(readFileSync(join(current, "machine-id.json"), "utf-8")).id)
      .toBe("cccccccc-3333-4333-8333-cccccccccccc");
    expect(existsSync(join(legacy, "sync-state", "-tmp-proj.json"))).toBe(true);
    expect(r.warning).toContain(legacy);
    expect(r.warning).toContain(current);
  });

  it.skipIf(isWindows)("case 4 — the rename fails: degrades to the LEGACY path rather than starting fresh", async () => {
    const home = freshHome();
    const legacy = seedLegacy(home, "dddddddd-4444-4444-8444-dddddddddddd");
    // A read+execute-only home makes `renameSync` fail with EACCES — the same
    // shape as a locked-down home directory or a cross-device mount, which is
    // what this branch exists for.
    chmodSync(home, 0o500);

    const r = resolveUserSeshMoverDir();
    expect(r.state).toBe("migration-failed");
    expect(r.dir).toBe(legacy);
    expect(existsSync(join(home, ".sesh-mover"))).toBe(false);
    expect(r.warning).toContain(legacy);

    // The degrade is only worth anything if the identity survives it: reading
    // the NEW path here would mint a fresh machine id and orphan this machine's
    // records on the hub.
    const { loadOrCreateMachineId } = await import("../src/machine.js");
    expect(loadOrCreateMachineId().id).toBe("dddddddd-4444-4444-8444-dddddddddddd");
    chmodSync(home, 0o700);
  });

  it("every consumer of the user directory follows the migration, not just the resolver", async () => {
    const home = freshHome();
    seedLegacy(home);
    const current = join(home, ".sesh-mover");

    const { syncStatePath, readSyncState } = await import("../src/sync-state.js");
    expect(syncStatePath("/tmp/proj").startsWith(join(current, "sync-state"))).toBe(true);
    expect(userSeshMoverDir()).toBe(current);
    // Reading the path is not the claim; reading the CONTENT is. Without the
    // move this file is not at the new path at all, and `readSyncState` hands
    // back a default state — which on the hub means the peer ledger is gone.
    expect(readSyncState("/tmp/proj").peers.hub?.sent["sess-1"]?.entryCount).toBe(7);
    expect(existsSync(join(current, "sync-state", "-tmp-proj.json"))).toBe(true);
  });

  it("the resolution is memoized per home, so a second home is resolved afresh", () => {
    const first = freshHome();
    seedLegacy(first);
    expect(resolveUserSeshMoverDir().state).toBe("migrated");
    // Same process, different home: a memo keyed on anything but the home
    // directory would answer "migrated" here and hand back the first home's path.
    const second = freshHome();
    expect(resolveUserSeshMoverDir()).toEqual({
      dir: join(second, ".sesh-mover"), state: "fresh", warning: null,
    });
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

  it("isPluginStateName knows every name this plugin owns, retired ones included", () => {
    for (const n of [
      ".sesh-mover", ".claude-sesh-mover",
      ".sesh-mover-include", ".sesh-mover-ignore", ".sesh-mover-project.json",
      ".sesh-mover-hubinclude", ".sesh-mover-hubignore",
    ]) {
      expect([n, isPluginStateName(n)]).toEqual([n, true]);
    }
    for (const n of ["src", "README.md", ".git", ".claude", ".sesh-mover-notes"]) {
      expect([n, isPluginStateName(n)]).toEqual([n, false]);
    }
  });

  it("PLUGIN_STATE_NAMES only ever GROWS — every retired spelling is still on it", () => {
    // This is the single list `NEVER_INCLUDABLE` is built from, so it is the
    // one place where deleting a line silently un-protects bundles that already
    // exist. Two renames have happened (0.7.0 dropped the `claude-` prefix and
    // moved the committed files to root dotfiles; 0.8.0 dropped `hub` from the
    // two list files), and NOTHING reads the three retired names any more —
    // which is exactly what makes them easy to remove by accident. A payload
    // able to plant `.sesh-mover-hubinclude` rewrites the list an 0.7.0 peer
    // still consults to decide what its next push uploads.
    //
    // Exact contents, in order. A failure because a name was ADDED is a
    // one-line update; a failure because one was REMOVED is the finding.
    expect(PLUGIN_STATE_NAMES).toEqual([
      ".sesh-mover",
      ".claude-sesh-mover",
      ".sesh-mover-include",
      ".sesh-mover-ignore",
      ".sesh-mover-hubinclude",
      ".sesh-mover-hubignore",
      ".sesh-mover-project.json",
    ]);
    for (const retired of [
      LEGACY_DIR_NAME, LEGACY_INCLUDE_FILE_NAME, LEGACY_IGNORE_FILE_NAME,
    ]) {
      expect([retired, PLUGIN_STATE_NAMES.includes(retired)]).toEqual([retired, true]);
    }
    // And the current pair is genuinely a rename, not an alias: the readers
    // point at the new names only.
    expect(INCLUDE_FILE_NAME).toBe(".sesh-mover-include");
    expect(IGNORE_FILE_NAME).toBe(".sesh-mover-ignore");
    expect(INCLUDE_FILE_NAME).not.toBe(LEGACY_INCLUDE_FILE_NAME);
    expect(IGNORE_FILE_NAME).not.toBe(LEGACY_IGNORE_FILE_NAME);
  });

  it("a project holding only the 0.7.0 names is read as having NO lists at all", () => {
    // The deliberate call, same as 0.7.0's: no migration and no fallback read.
    // A silently HALF-read list would be worse than none — an include list is
    // security-relevant (it decides what leaves the machine), so "not
    // configured" is the recoverable failure and "partly configured from a file
    // you thought you had renamed" is not.
    const dir = mkdtempSync(join(tmpdir(), "sesh-legacy-lists-"));
    try {
      writeFileSync(join(dir, ".sesh-mover-hubinclude"), "docs/\n");
      writeFileSync(join(dir, ".sesh-mover-hubignore"), "build\n");
      expect(readIncludePatterns(dir)).toEqual([]);
      expect(readIgnorePatterns(dir)).toEqual([]);
      // ...and the new names are what a reader picks up.
      writeFileSync(join(dir, ".sesh-mover-include"), "docs/\n");
      writeFileSync(join(dir, ".sesh-mover-ignore"), "build\n");
      expect(readIncludePatterns(dir)).toEqual(["docs/"]);
      expect(readIgnorePatterns(dir)).toEqual(["build"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
