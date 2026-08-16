/**
 * Bounded so a directory already full of parked copies cannot spin. Shared by
 * both callers, so a message quoting the number cannot drift from the loop.
 */
export declare const MAX_SIDECAR_ATTEMPTS = 100;
/**
 * Copy `srcPath` to the first name `nameFor` yields that does not already
 * exist, and return that name — or `null` when every attempt collided.
 *
 * **This is the one copy of the park-without-overwriting rule.** Two places
 * park an incoming file beside a local one they refuse to overwrite:
 * `writeSidecar` in `src/hub/merge.ts` (workspace merge, `<name>.theirs-<stamp>`)
 * and the memory step in `src/importer.ts` (`<stem>.incoming.md`). The two
 * *names* diverge deliberately — a parked memory must end in `.md` or it is not
 * read as a memory at all, and it is user-facing and transient rather than
 * archaeological; each site carries a comment pointing at the other. The
 * *technique* must not diverge: the existence check and the write have to be
 * one atomic step (`COPYFILE_EXCL`), or a second unresolved transfer, or a user
 * file that happens to match, is silently overwritten — the exact defect a
 * check-then-write would reintroduce on each new caller.
 *
 * `resolve` maps a candidate name to the path to write, so a caller can keep
 * returning the name it wants back (a bundle-relative path, a bare filename)
 * while the loop stays identical.
 */
export declare function copyToUniqueName(srcPath: string, nameFor: (attempt: number) => string, resolve: (name: string) => string, maxAttempts?: number): string | null;
//# sourceMappingURL=sidecar.d.ts.map