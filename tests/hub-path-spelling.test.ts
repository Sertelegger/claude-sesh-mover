/**
 * #162 — a hub path spelled with `~`, or relative, used to be resolved against
 * the process's working directory.
 *
 * `commands/hub-init.md` offers `~/Dropbox`-style candidates, and bash expands
 * `~` neither inside double quotes, nor in `--path=~/…`, nor in
 * `hub.path=~/…` (not a variable-assignment word). So the plugin's own flow
 * could hand the CLI a literal `~`, which became `<cwd>/~/Dropbox/…`: a hub
 * that lived INSIDE the project, synced with nothing, and was then shipped
 * inside that project's own payloads.
 *
 * CLI level, shipped `dist/`, a scratch home each — the tilde is expanded
 * against `os.homedir()`, which is exactly what `HOME`/`USERPROFILE` steer.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./helpers/run-cli.js";
import { homeEnv } from "./helpers/env.js";

const TIMEOUT = 120_000;

function run(home: string, args: string[], cwd: string): { status: number | null; json: any; stdout: string } {
  const r = runCli(args, { env: homeEnv(home), cwd });
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { status: r.status, json, stdout: r.stdout + r.stderr };
}

function userConfig(home: string): { hub?: { path?: string } } | null {
  const p = join(home, ".sesh-mover", "config.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
}

describe("hub init --path spelling (#162)", () => {
  it("expands a leading ~ against the home directory, never the cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "sm-162-tilde-"));
    try {
      const home = join(root, "home");
      const cwd = join(root, "project");
      mkdirSync(home, { recursive: true });
      mkdirSync(cwd, { recursive: true });

      for (const spelling of ["~/hub", "~\\hub2", "~"]) {
        const r = run(home, ["hub", "init", "--path", spelling], cwd);
        expect(r.status, r.stdout).toBe(0);
        const expected = spelling === "~" ? home : join(home, spelling.slice(2));
        expect(r.json.hubPath).toBe(expected);
        expect(existsSync(join(expected, "hub.json"))).toBe(true);
        expect(userConfig(home)?.hub?.path).toBe(expected);
        if (spelling === "~") break; // the home itself is now a hub; nothing below would add anything
      }
      // The defect's signature: a directory literally named "~" under the cwd.
      expect(existsSync(join(cwd, "~"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("refuses a relative --path before creating anything, and an absolute --path then succeeds", () => {
    const root = mkdtempSync(join(tmpdir(), "sm-162-rel-"));
    try {
      const home = join(root, "home");
      const cwd = join(root, "project");
      mkdirSync(home, { recursive: true });
      mkdirSync(cwd, { recursive: true });

      for (const spelling of ["hub", "./hub", "~someone/hub"]) {
        const r = run(home, ["hub", "init", "--path", spelling], cwd);
        expect(r.status, r.stdout).toBe(1);
        expect(r.json.success).toBe(false);
        expect(r.json.reason).toBe("hub-path-not-absolute");
        expect(r.json.suggestion).toMatch(/--path/);
      }
      expect(existsSync(join(cwd, "hub"))).toBe(false);
      expect(existsSync(join(cwd, "~someone"))).toBe(false);
      expect(userConfig(home)).toBeNull();

      const good = run(home, ["hub", "init", "--path", join(root, "hub")], cwd);
      expect(good.status, good.stdout).toBe(0);
      expect(good.json.hubPath).toBe(join(root, "hub"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe("configure --set hub.path spelling (#162)", () => {
  it("stores ~/… expanded, and refuses a relative value without writing", () => {
    const root = mkdtempSync(join(tmpdir(), "sm-162-cfg-"));
    try {
      const home = join(root, "home");
      const cwd = join(root, "project");
      mkdirSync(home, { recursive: true });
      mkdirSync(cwd, { recursive: true });

      const set = run(home, ["configure", "--scope", "user", "--set", "hub.path=~/hub"], cwd);
      expect(set.status, set.stdout).toBe(0);
      expect(userConfig(home)?.hub?.path).toBe(join(home, "hub"));

      const before = readFileSync(join(home, ".sesh-mover", "config.json"), "utf-8");
      const rel = run(home, ["configure", "--scope", "user", "--set", "hub.path=relative/hub"], cwd);
      expect(rel.status, rel.stdout).toBe(1);
      expect(rel.json.success).toBe(false);
      expect(readFileSync(join(home, ".sesh-mover", "config.json"), "utf-8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("reads an already-stored ~/… value against the home directory", () => {
    const root = mkdtempSync(join(tmpdir(), "sm-162-read-"));
    try {
      const home = join(root, "home");
      const cwd = join(root, "project");
      mkdirSync(join(home, ".sesh-mover"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      // What `configure --set hub.path=~/hub` stored before this fix.
      writeFileSync(join(home, ".sesh-mover", "config.json"), JSON.stringify({ hub: { path: "~/hub" } }) + "\n");

      const s = run(home, ["hub", "status"], cwd);
      expect(s.status, s.stdout).toBe(0);
      expect(s.json.hubPath).toBe(join(home, "hub"));
      expect(s.json.hubState).toBe("no-directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
