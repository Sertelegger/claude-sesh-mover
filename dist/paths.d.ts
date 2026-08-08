/**
 * The on-disk names sesh-mover owns, and the one-time migration of the
 * user-scope directory off its old name.
 *
 * ## Why these names
 *
 * `claude-sesh-mover` is the npm package and GitHub repo — the `claude-` prefix
 * makes the scope obvious to someone browsing that ecosystem. `sesh-mover` is
 * the plugin name and the CLI bin, kept short because it is what a user types.
 * A dotfile is the latter. The old `.claude-sesh-mover/` also asserted "Claude"
 * about projects that may have no Claude in them at all: the hub index schema
 * carries an `agent` discriminator from day one and Codex/Gemini support is
 * tracked, so the directory name had to stop claiming otherwise.
 *
 * ## Why the split by lifecycle
 *
 * `.claude-sesh-mover/` held two things with opposite lifecycles: generated
 * exports (must never be committed) and user config plus identity (`hubinclude`,
 * `hubignore`, `project.json` — must be committed, or they do not work). One
 * directory cannot be both, which is why `.gitignore` needed a negation
 * (`.claude-sesh-mover/*` plus three `!` lines) to make this repo able to follow
 * its own README. That was a symptom. Splitting by lifecycle is the fix:
 *
 * - `<project>/.sesh-mover/` — generated exports only. Plainly gitignored.
 * - `<project>/.sesh-mover-hubinclude`, `-hubignore`, `-project.json` — the
 *   committed files, as ordinary root dotfiles, the way every comparable tool
 *   spells a per-project config.
 * - `~/.sesh-mover/` — machine identity, sync state, locks, user-scope exports
 *   and config.
 */
/** Per-project directory: generated exports only, and gitignored. */
export declare const PROJECT_DIR_NAME = ".sesh-mover";
/** User-scope directory: machine identity, sync state, locks, exports, config. */
export declare const USER_DIR_NAME = ".sesh-mover";
/**
 * The pre-0.7 spelling of both directories.
 *
 * It is still on the `NEVER_INCLUDABLE` floor and always will be — see the note
 * there. Nothing else reads it except `resolveUserSeshMoverDir` below.
 */
export declare const LEGACY_DIR_NAME = ".claude-sesh-mover";
/** Committed: the opt-in re-include list (`hubinclude`), at the project root. */
export declare const HUBINCLUDE_FILE_NAME = ".sesh-mover-hubinclude";
/** Committed: the per-segment exclusion list (`hubignore`), at the project root. */
export declare const HUBIGNORE_FILE_NAME = ".sesh-mover-hubignore";
/** Committed: this project's hub identity (`projectId`), at the project root. */
export declare const PROJECT_JSON_FILE_NAME = ".sesh-mover-project.json";
/**
 * Every name this plugin owns inside a user's project, in one place.
 *
 * Order matters only for readability. The floor (`NEVER_INCLUDABLE` in
 * `hub/workspace.ts`) is built from this list plus `.git`, so adding a name here
 * protects it on the carry side and the apply side at once.
 */
export declare const PLUGIN_STATE_NAMES: readonly string[];
/**
 * Is this a top-level entry name that belongs to sesh-mover rather than to the
 * user's project?
 *
 * Used by the two "does this directory hold real content" checks (the empty
 * snapshot warning, and the merge-vs-skip decision on pull): a pull plants
 * `.sesh-mover-project.json` before either of them runs, so a directory holding
 * nothing but plugin state must still read as empty. Exact match on purpose —
 * this is a `readdir` entry name, never a pattern, and the fold-tolerant
 * spelling check that a payload has to pass is `isNeverIncludable`.
 */
export declare function isPluginStateName(name: string): boolean;
/** `<projectPath>/.sesh-mover` — project-scope exports and config. */
export declare function projectSeshMoverDir(projectPath: string): string;
/** `<projectPath>/.sesh-mover-hubinclude`. */
export declare function hubincludeFilePath(projectPath: string): string;
/** `<projectPath>/.sesh-mover-hubignore`. */
export declare function hubignoreFilePath(projectPath: string): string;
/** `<projectPath>/.sesh-mover-project.json`. */
export declare function projectJsonFilePath(projectPath: string): string;
/** How `resolveUserSeshMoverDir` arrived at the directory it returned. */
export type UserDirState = 
/** Neither name exists. Normal first run — nothing was created, nothing to say. */
"fresh"
/** `~/.sesh-mover` already existed; no legacy directory to move. */
 | "current"
/** `~/.claude-sesh-mover` was renamed to `~/.sesh-mover` by this call. */
 | "migrated"
/** Both exist. Neither is touched; the current name is used. */
 | "both"
/** The rename failed. The legacy directory is used as-is. */
 | "migration-failed";
export interface UserDirResolution {
    /** The directory to read and write. May be the LEGACY one — see `state`. */
    dir: string;
    state: UserDirState;
    /**
     * A sentence for the user, or `null`. Present for every state except `fresh`
     * and `current`, i.e. exactly when something happened they did not ask for.
     */
    warning: string | null;
}
/**
 * Resolve the user-scope directory, migrating `~/.claude-sesh-mover` to
 * `~/.sesh-mover` on first use.
 *
 * **This has to be a MOVE, not a rename in the code.** That directory holds
 * `machine-id.json` and `sync-state/`. Reading a new path without moving the old
 * one mints a NEW machine identity: the hub sees a machine that has never
 * pushed, every peer ledger resets, and the next push re-uploads every session
 * as a full bundle instead of a continuation. Worse, the old machine's
 * `index/<id>.json` and `machines/<id>.json` stay on the hub forever — nothing
 * in this codebase ever calls `backend.delete` (#43) — so `whereis` lists a
 * ghost and every pull resolves across it.
 *
 * Four cases, all of which fire on a machine the owner updates later than the
 * others, so each has to be right on its own:
 *
 * 1. **Neither exists** — first run. Return the new path, create nothing, say
 *    nothing. (The directory is created by whoever writes into it, as before.)
 * 2. **Only the legacy one exists** — one `renameSync`, which preserves the
 *    machine id, the sync state, the locks and the exports exactly. State
 *    `migrated`, with a sentence saying where things went.
 * 3. **Both exist** — do NOT clobber: a `renameSync` onto a non-empty directory
 *    fails on POSIX and silently replaces on some filesystems, and either way one
 *    of the two identities would be lost. Leave both, use the current name (it is
 *    the one this version writes), and warn naming the situation and the
 *    remedy — the user is the only one who can tell which sync state is live.
 * 4. **The rename fails** (EACCES, EXDEV across a mount, a lock held by another
 *    process) — degrade to the LEGACY path rather than start fresh. A slightly
 *    wrong directory name costs nothing; a new machine identity costs the hub
 *    bookkeeping described above.
 */
export declare function resolveUserSeshMoverDir(): UserDirResolution;
/** The user-scope directory, after the one-time migration above. */
export declare function userSeshMoverDir(): string;
/**
 * The migration's warning as a `warnings` array, for the commands that have one.
 *
 * Deliberately not one-shot: a `both` or `migration-failed` state persists, and
 * a user who only ever runs `hub push` should keep being told. `migrated` fires
 * at most once per machine by construction — the legacy directory is gone
 * afterwards.
 */
export declare function userDirWarnings(): string[];
//# sourceMappingURL=paths.d.ts.map