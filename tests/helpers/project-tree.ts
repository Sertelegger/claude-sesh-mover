import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * REAL PROJECT WORKING TREES, for the file payloads #47 gave export/import.
 *
 * The shared session fixture (`tests/fixtures/create-fixtures.ts`) deliberately
 * has no working tree at all — its "project path" is a string literal that does
 * not exist on disk, which is exactly right for testing transcripts and exactly
 * useless for testing a payload that copies a directory. `hub-fixtures.ts`'s
 * `createRealProject` covers the CONFIG-DIR half of that gap (it re-encodes the
 * fixture's project folder under a real path); this file covers the WORKING-TREE
 * half.
 *
 * Real `git`, real files, real temp dirs — no mocking, per the testing
 * conventions. `vitest.config.ts` already raises the timeouts for exactly this.
 */

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * A throwaway repository with a remote and one commit.
 *
 * The remote is what makes `scanGitRemotes` answer `remotes`, which is what
 * routes this project to the CARRY payload. A repo without one answers `none`
 * and takes the workspace snapshot instead — that difference is the whole
 * decision the capture makes, so a test that means to exercise one must build
 * the right shape rather than assume it.
 */
export function gitProject(name = "carry"): string {
  const dir = mkdtempSync(join(tmpdir(), `sesh-${name}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["remote", "add", "origin", "https://example.com/x/y.git"]);
  writeFileSync(join(dir, "tracked.txt"), "v1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** A clean copy of `repo` at the same HEAD — the apply-side target for a carry. */
export function cleanTwin(repo: string, name = "twin"): string {
  const twin = mkdtempSync(join(tmpdir(), `sesh-${name}-`));
  git(twin, ["init", "-q"]);
  git(twin, ["config", "user.email", "t@example.com"]);
  git(twin, ["config", "user.name", "Test"]);
  git(twin, ["remote", "add", "origin", "https://example.com/x/y.git"]);
  git(twin, ["fetch", "-q", repo, "HEAD"]);
  git(twin, ["checkout", "-q", "FETCH_HEAD"]);
  git(twin, ["checkout", "-q", "-B", "master"]);
  return twin;
}

/** Write `{ "a/b.txt": "…" }` into `root`, creating directories as needed. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** Every file under `root`, as "/"-joined relative paths, sorted. */
export function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, childRel));
    else out.push(childRel);
  }
  return out.sort();
}
