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
 * Deliberately NOT silent by default: a vanished entry is a loud ENOENT on the
 * SOURCE path, not a corrupt copy. A static fixture that mutates under a walk
 * is a bug worth failing on.
 *
 * `live: true` opts out of that, and exists for exactly one shape: copying a
 * real git repository. Git writes transient state into `.git` on its own
 * schedule — lock files, temp objects, a gc's scratch — so an entry really can
 * disappear between the `readdirSync` that listed it and the `copyFileSync`
 * that reads it, with nothing in the test at fault. That is what failed the
 * macOS CI leg here, and it is not the same event as a fixture mutating: the
 * files that vanish are ones git itself was about to remove. Swallowing ENOENT
 * for a STATIC tree would hide a real defect, which is why this is a parameter
 * and not a softened default.
 *
 * Modes ride along (`copyFileSync` propagates the source's), which the git
 * object store depends on, and symlinks are recreated rather than followed.
 */
export function copyTreeSync(src: string, dest: string, opts: { live?: boolean } = {}): void {
  mkdirSync(dest, { recursive: true });
  let entries;
  try {
    entries = readdirSync(src, { withFileTypes: true });
  } catch (e) {
    if (opts.live && (e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    try {
      if (entry.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else if (entry.isDirectory()) copyTreeSync(from, to, opts);
      else if (entry.isFile()) copyFileSync(from, to);
      // Anything else (socket, fifo, device) has no place in a fixture tree and
      // is skipped rather than blocking a test on an open().
    } catch (e) {
      if (opts.live && (e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
  }
}
