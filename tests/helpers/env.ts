/**
 * Shared home-directory override helpers for test isolation.
 *
 * node:os's homedir() reads $HOME on POSIX but $USERPROFILE on Windows
 * (falling back to a native lookup only when neither is set). Any test
 * that redirects the home directory to an isolated temp dir must set
 * BOTH env vars — overriding HOME alone silently no-ops on Windows:
 * assertions fail AND the code under test writes into the real runner's
 * user profile instead of the temp dir.
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
