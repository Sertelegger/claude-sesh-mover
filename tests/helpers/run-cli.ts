/**
 * Shared runner for the built CLI (`dist/cli.js`).
 *
 * Two forms, both preserved from the original local helper in cli.test.ts:
 *
 * - **String form** — shells out via `execSync` and returns stdout only. It
 *   throws on a non-zero exit, which most command tests rely on as an implicit
 *   "the CLI didn't blow up" assertion.
 * - **Array form** — `spawnSync` without a shell, so stdout and stderr are
 *   captured separately (needed for tests that assert on stderr, e.g.
 *   `--progress` NDJSON) without polluting the test runner's own stderr, and
 *   so a non-zero exit is reported rather than thrown.
 *
 * The array form also accepts `input`, piped to the child's stdin. The hook
 * endpoints (`hub hook-session-end`, and later hook-session-start) read their
 * payload from stdin, so testing them at all requires it.
 */

import { execSync, spawnSync } from "node:child_process";
import { join } from "node:path";

export interface RunCliOptions {
  /** Env vars layered over the parent process env for the child. */
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin (array form only). */
  input?: string;
  /**
   * Working directory for the child. Needed for anything project-scoped:
   * `--scope project` resolves to `<cwd>/.sesh-mover`, and the effective
   * config is always read from the cwd's project layer.
   */
  cwd?: string;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null if the child was killed by a signal. */
  status: number | null;
}

export function cliPath(): string {
  return join(import.meta.dirname, "..", "..", "dist", "cli.js");
}

export function runCli(args: string, opts?: RunCliOptions): string;
export function runCli(args: string[], opts?: RunCliOptions): RunCliResult;
export function runCli(
  args: string | string[],
  opts: RunCliOptions = {}
): string | RunCliResult {
  const env = { ...process.env, ...opts.env };
  const cwd = opts.cwd === undefined ? {} : { cwd: opts.cwd };
  if (Array.isArray(args)) {
    const result = spawnSync("node", [cliPath(), ...args], {
      encoding: "utf-8",
      env,
      ...cwd,
      // Only pass `input` when the caller supplied one: spawnSync treats an
      // explicit `undefined` the same as omitted, but being explicit here
      // keeps the no-stdin case identical to every pre-existing call site.
      ...(opts.input === undefined ? {} : { input: opts.input }),
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
  }
  return execSync(`node "${cliPath()}" ${args}`, { encoding: "utf-8", env, ...cwd });
}
