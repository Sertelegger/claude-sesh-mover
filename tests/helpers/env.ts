/**
 * Shared environment-override helpers for test isolation.
 *
 * Every helper here exists because the env var that steers a node:os lookup
 * is NOT the same variable on every platform, so the obvious single-variable
 * override silently no-ops on Windows:
 *
 * - homedir() reads $HOME on POSIX but $USERPROFILE on Windows (falling back
 *   to a native lookup only when neither is set).
 * - tmpdir() reads $TMPDIR on POSIX but $TEMP/$TMP on Windows — it never
 *   consults TMPDIR there.
 * - PATH is spelled "Path" on Windows, where env var names are
 *   case-insensitive at the OS level but not in a plain JS object. Note the
 *   asymmetry: `process.env` ITSELF is a case-insensitive proxy on Windows, so
 *   an in-process assignment is safe; a `{ ...process.env }` SPREAD is an
 *   ordinary object and loses that, which is where the hazard actually bites
 *   (see prependPath).
 *
 * A no-op override is worse than a missing one: assertions fail, the code
 * under test touches the real runner's home/temp dir instead of the isolated
 * one, and "nothing leaked" style assertions pass *vacuously* against a
 * directory the code never used.
 */

import { delimiter } from "node:path";

/** Point HOME and USERPROFILE at `dir` in the current process's env. */
export function setHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

/** Env var overrides for spawning a child process with `dir` as its home. */
export function homeEnv(dir: string): { HOME: string; USERPROFILE: string } {
  return { HOME: dir, USERPROFILE: dir };
}

export interface HomeOverrideHandle {
  /** Restore the previous HOME/USERPROFILE values (deleting either that was unset). */
  restore(): void;
}

/**
 * Snapshot the current HOME/USERPROFILE, point both at `dir`, and return a
 * handle that restores the originals. Typical usage: call in beforeEach,
 * call `.restore()` in afterEach.
 */
export function overrideHome(dir: string): HomeOverrideHandle {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  setHome(dir);
  return {
    restore(): void {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
    },
  };
}

/**
 * Env var overrides for spawning a child process whose temp root is `dir`.
 *
 * node:os's tmpdir() reads $TMPDIR on POSIX but `$TEMP || $TMP ||
 * <SystemRoot>\temp` on Windows — TMPDIR is never consulted there. So a test
 * that steers mkdtempSync (into a dir it owns, or into a deliberately
 * unusable one) must set all three names, or on Windows the child happily
 * uses the real system temp dir: "unusable temp root" assertions fail, and
 * scratch-dir leak assertions pass against a directory nothing ever wrote to.
 *
 * Unlike PATH (see prependPath) these keys need no casing dance when spread
 * over `process.env`: node's child_process sorts env keys and drops
 * case-insensitive duplicates keeping the lexicographically first, and ASCII
 * uppercase sorts before lowercase — so a literal "TEMP" key always wins over
 * an inherited "Temp". These overrides also *replace* rather than extend the
 * inherited value, so there is nothing to read out of the original casing.
 */
export function tmpEnv(dir: string): { TMPDIR: string; TMP: string; TEMP: string } {
  return { TMPDIR: dir, TMP: dir, TEMP: dir };
}

export interface TmpOverrideHandle {
  /** Restore the previous TMPDIR/TMP/TEMP values (deleting any that were unset). */
  restore(): void;
}

/**
 * In-process twin of `tmpEnv`: point this process's temp root at `dir` and
 * return a handle that restores the originals. Safe on Windows, where
 * `process.env` is a case-insensitive proxy — assigning "TEMP" overwrites an
 * existing "Temp" rather than adding a second key.
 */
export function overrideTmp(dir: string): TmpOverrideHandle {
  const names = ["TMPDIR", "TMP", "TEMP"] as const;
  const saved = names.map((n) => [n, process.env[n]] as const);
  for (const n of names) process.env[n] = dir;
  return {
    restore(): void {
      for (const [n, value] of saved) {
        if (value !== undefined) process.env[n] = value;
        else delete process.env[n];
      }
    },
  };
}

export interface PathOverrideHandle {
  /** Restore the previous PATH value under its original casing. */
  restore(): void;
}

/**
 * In-process twin of `prependPath`, but *replacing* PATH rather than extending
 * it: point this process's executable search path at `dir` alone and return a
 * handle that restores the original.
 *
 * Used to prove that code shelling out to an external binary (git) degrades
 * honestly when that binary cannot be found, and to put a stub binary in front
 * of the real one.
 *
 * The variable may be spelled "Path" on Windows, but — unlike `prependPath`,
 * which spreads into a plain object — a bare `process.env.PATH = dir` would
 * already be correct here: `process.env` is a case-insensitive proxy on
 * Windows, so assigning "PATH" overwrites an existing "Path" rather than adding
 * a second key (same reason `overrideTmp` can assign "TEMP" directly). The
 * find-and-overwrite loop below is belt-and-braces, and it is what lets
 * `restore()` put the value back under its ORIGINAL casing rather than leaving
 * the process with a renamed variable.
 *
 * Like `overrideTmp`, this mutates process-wide state for the duration of one
 * test; always `.restore()` in a `finally`.
 */
export function overridePath(dir: string): PathOverrideHandle {
  const keys = Object.keys(process.env).filter((k) => k.toUpperCase() === "PATH");
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  process.env[keys[0] ?? "PATH"] = dir;
  return {
    restore(): void {
      for (const k of Object.keys(process.env).filter((n) => n.toUpperCase() === "PATH")) {
        delete process.env[k];
      }
      for (const [k, value] of saved) if (value !== undefined) process.env[k] = value;
    },
  };
}

/**
 * Build an env object with `dir` prepended to PATH, safe to pass as a child
 * process's `env` option.
 *
 * Windows env var names are case-insensitive at the OS level but a plain JS
 * object spread (`{ ...process.env, PATH: … }`) is case-*sensitive*: if the
 * real variable is spelled "Path" (as it typically is on Windows), spreading
 * `process.env` and then setting a literal "PATH" key produces an object
 * with BOTH keys, and which one the child process's own PATH search actually
 * honors is undefined/implementation-specific. Find and overwrite whatever
 * casing already exists instead of blindly adding a new "PATH" key.
 */
export function prependPath(
  baseEnv: NodeJS.ProcessEnv,
  dir: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const existingKeys = Object.keys(env).filter((k) => k.toUpperCase() === "PATH");
  const pathKey = existingKeys[0] ?? "PATH";
  const current = pathKey in env ? env[pathKey] : undefined;
  for (const k of existingKeys) delete env[k];
  env[pathKey] = `${dir}${delimiter}${current ?? ""}`;
  return env;
}
