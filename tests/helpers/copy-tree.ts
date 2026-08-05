import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Recursive directory copy for fixtures — a deterministic stand-in for
 * `cpSync(src, dest, { recursive: true })`.
 *
 * It exists because of a flake, not a preference. On macOS CI, `cpSync` of a
 * real git repository intermittently threw
 * `ENOENT ... '<dest>/.git/objects'` with `syscall: 'cp'` — naming the
 * DESTINATION, inside a `mkdtempSync` directory that demonstrably existed, in
 * tests whose source tree nothing was touching. It was seen once during the
 * Windows-CI task and twice in a single run afterwards, always on the same
 * helper, and never reproduced locally (300 consecutive copies, clean).
 *
 * Without a `filter`, Node's `cpSync` delegates the whole recursive walk to
 * C++ (`fsBinding.cpSyncCopyDir`, i.e. `std::filesystem` under libc++), which
 * is where that error shape comes from — there is no JS frame to blame and
 * nothing here can influence it. This walk is a handful of ordinary syscalls
 * per entry instead: parent directories are created before their children by
 * construction, and any error names the path that actually failed, so a future
 * failure is diagnostic rather than mysterious.
 *
 * Deliberately NOT silent about anything: no skipping of vanished entries. If
 * a source tree ever really is mutating under a fixture, that should surface as
 * a loud ENOENT on the SOURCE path, not as a corrupt copy.
 *
 * Modes ride along (`copyFileSync` propagates the source's), which the git
 * object store depends on, and symlinks are recreated rather than followed.
 */
export function copyTreeSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (entry.isDirectory()) copyTreeSync(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    // Anything else (socket, fifo, device) has no place in a fixture tree and
    // is skipped rather than blocking a test on an open().
  }
}
