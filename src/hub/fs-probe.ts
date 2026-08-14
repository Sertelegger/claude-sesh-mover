import { statSync } from "node:fs";

/**
 * Is this path a directory we can list?
 *
 * Both "the bundle declares a payload it does not contain" guards use this
 * rather than `existsSync`, because the failure they exist to close is a
 * `readdirSync` throwing out of `hubPull` BEFORE the session import — which a
 * plain file at that path does just as well (ENOTDIR) as a missing one
 * (ENOENT). Any error reads as "not usable": the caller's next move is to warn
 * and skip, which is the right answer for a permission failure too.
 *
 * It lives in a module of its own because its callers are pull STAGES —
 * `pull-apply-carry.ts` and (once extracted) `pull-apply-workspace.ts` — and
 * neither may depend on the other, nor on `pull.ts`. Keeping it in `pull.ts`
 * and exporting it made `pull.ts` import a stage that imported `pull.ts` back:
 * benign today only because a hoisted function declaration is initialised
 * before either module body runs, which is not a property to build on. One home
 * also means the two guards cannot drift apart on what counts as usable.
 */
export function isReadableDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
