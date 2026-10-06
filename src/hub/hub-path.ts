import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * How a hub path the user TYPED becomes the path every verb uses (#162).
 *
 * **Why this exists.** `commands/hub-init.md` offers hub candidates spelled
 * `~/Dropbox`, `~/OneDrive`, and bash expands `~` neither inside double quotes,
 * nor in Commander's `--path=~/…` form, nor in `hub.path=~/…` (that word is not
 * shaped like a variable assignment, so bash leaves the tilde alone). The CLI
 * therefore received a literal `~`, and `resolve()` turned it into
 * `<cwd>/~/Dropbox/…` — a hub that lived INSIDE the current project, synced
 * with nothing, reported `created: true`, and was then carried off the machine
 * inside that project's own workspace snapshot or carry. Measured, repeatedly,
 * before this module.
 *
 * Two rules, applied at both WRITE sites (`hub init --path`, `configure --set
 * hub.path`) and — the tilde half only — at the one READ site
 * (`resolveHubPath`), so a value stored before the fix means what its author
 * meant:
 *
 * - a leading `~` that is the whole value, or is followed by `/` or `\`, is the
 *   home directory (`os.homedir()`, which is what `HOME`/`USERPROFILE` steer).
 *   `~user` is NOT expanded: resolving another account's home is a lookup this
 *   plugin has no business making, so it stays literal and fails the absolute
 *   check below like any other relative spelling;
 * - after expansion, a value that is not absolute is REFUSED at write time.
 *   Relative resolution against the working directory is exactly how the
 *   defect happened, and a hub path that names a different directory in every
 *   project is never what anyone meant.
 *
 * A relative value that is ALREADY stored (hand-edited, or written before this
 * fix) is left to resolve as it always has: settling what a stored relative
 * value should mean belongs to the single hub-address resolution point #112
 * introduces, and changing it here would move every such user's hub without
 * telling them.
 */
export function expandLeadingTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

export type HubPathInput =
  | { ok: true; path: string }
  /** `given` is echoed back verbatim — it is what the user typed, not a hub value. */
  | { ok: false; given: string };

/**
 * A typed hub path, as it should be stored: tilde-expanded, absolute, and
 * normalized (`resolve` folds `..` and a trailing separator, which is also what
 * makes it usable as a hub ADDRESS — see `hubAddress`).
 */
export function normalizeHubPathInput(value: string): HubPathInput {
  const expanded = expandLeadingTilde(value);
  if (!isAbsolute(expanded)) return { ok: false, given: value };
  return { ok: true, path: resolve(expanded) };
}

/**
 * The key `joined-hubs.json` is recorded under: the normalized absolute path
 * the probe is about to read.
 *
 * `resolve`, deliberately not `realpath`: the address is what the user
 * configured, and a symlinked hub reached through two spellings is two
 * addresses, each of which seeds or records on its own — the cheap direction,
 * since a second address is only ever a first sighting, never a mismatch.
 */
export function hubAddress(hubPath: string): string {
  return resolve(hubPath);
}

/**
 * Do two recorded addresses name the same hub? Case-insensitive on Windows,
 * where `C:\Hub` and `c:\hub` are one directory and a case-sensitive compare
 * would read a re-typed path as a hub this machine never joined.
 *
 * `platform` is a parameter only so both behaviours can be tested on one OS.
 */
export function sameHubAddress(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
