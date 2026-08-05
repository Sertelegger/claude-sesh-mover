/**
 * Reading back a file that **git itself wrote**, on a checkout whose end-of-line
 * convention is not LF.
 *
 * Git for Windows ships `core.autocrlf=true` in its system config, so on that
 * platform — and only there — a blob stored as LF is written to the working tree
 * as CRLF by every command that materialises a file: `git checkout`, `git reset
 * --hard`, and `git apply` alike. A test that writes `"v1\n"`, commits it, and
 * then reads the file back after any of those commands legitimately sees
 * `"v1\r\n"`.
 *
 * Measured, on macOS with `GIT_CONFIG_GLOBAL` set to `core.autocrlf=true` (which
 * reproduces the Git-for-Windows default exactly), for the carry pipeline:
 *
 * - **Capture is unaffected.** `git diff HEAD --binary` renders the patch in
 *   INDEX form, so the patch bytes a CRLF worktree produces are byte-identical
 *   to the ones an LF worktree produces. Nothing platform-specific reaches the
 *   hub.
 * - **Apply round-trips.** An LF patch applied into a CRLF worktree produces
 *   CRLF, and the receiver's own `git diff HEAD` of the result is byte-identical
 *   to the sender's patch — no EOL churn propagates back, and `git status` shows
 *   only the real change.
 * - **Content is intact.** Trailing whitespace survives (`v1\r\ntrailing   \r\n`,
 *   so `--whitespace=nowarn` still does its job) and non-UTF-8 bytes survive
 *   (`caf\xe9\xe9\r\n`).
 *
 * So the difference is the RECEIVING checkout's own convention, exactly as
 * `carry.ts` documents ("Not pinned, and why"), not a fidelity loss — and what
 * these tests assert is that the other machine's work arrived, not what line
 * ending the receiving repo is configured to use. Normalising the comparison is
 * therefore right, and pinning `core.autocrlf=false` in the fixtures would be
 * wrong: it would test a git configuration no Windows user has, and the matrix
 * would stop covering the one platform these helpers exist for.
 *
 * **Use these ONLY for a file git materialised.** Untracked files travel through
 * the carry code's own byte copy, never through git's filters, so their
 * assertions stay byte-exact — that is the half of the suite that would catch a
 * text-mode transform sneaking into the copy path, and normalising it would
 * silence exactly the defect this project's Windows matrix exists to find.
 * (Verified: under the `autocrlf=true` proxy every failing assertion was on a
 * tracked file, and every untracked-file assertion passed unchanged.)
 */

import { readFileSync } from "node:fs";

/** Text content of a git-written file, CRLF folded to LF. */
export function readTextLf(path: string): string {
  return readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
}

/**
 * Raw bytes of a git-written file, CRLF folded to LF.
 *
 * The Buffer form exists for content that is NOT valid UTF-8 — a `utf-8` decode
 * would replace those bytes with U+FFFD and the comparison would pass on
 * mangled input.
 */
export function readBytesLf(path: string): Buffer {
  const raw = readFileSync(path);
  const out = Buffer.alloc(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x0d && raw[i + 1] === 0x0a) continue;
    out[n++] = raw[i]!;
  }
  return out.subarray(0, n);
}
