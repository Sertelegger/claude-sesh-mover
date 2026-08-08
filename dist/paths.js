import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 * exports (must never be committed) and user config plus identity (the include
 * list, the ignore list, `project.json` — must be committed, or they do not
 * work). One
 * directory cannot be both, which is why `.gitignore` needed a negation
 * (`.claude-sesh-mover/*` plus three `!` lines) to make this repo able to follow
 * its own README. That was a symptom. Splitting by lifecycle is the fix:
 *
 * - `<project>/.sesh-mover/` — generated exports only. Plainly gitignored.
 * - `<project>/.sesh-mover-include`, `-ignore`, `-project.json` — the
 *   committed files, as ordinary root dotfiles, the way every comparable tool
 *   spells a per-project config.
 * - `~/.sesh-mover/` — machine identity, sync state, locks, user-scope exports
 *   and config.
 *
 * ## Why the include/ignore files dropped "hub" in 0.8.0
 *
 * They were `.sesh-mover-hubinclude` / `.sesh-mover-hubignore` for exactly one
 * release, because the hub was the only thing that read them. It is not any
 * more: `export` and `import` carry the same workspace and git-diff payloads
 * (#47), so a hub-less user configuring what travels was reading a file whose
 * name asserted a feature they never touch. The rename went in AHEAD of that
 * feature so the names were already right when it landed, and so anyone still
 * on 0.6.x has ONE migration rather than two.
 */
/** Per-project directory: generated exports only, and gitignored. */
export const PROJECT_DIR_NAME = ".sesh-mover";
/** User-scope directory: machine identity, sync state, locks, exports, config. */
export const USER_DIR_NAME = ".sesh-mover";
/**
 * The pre-0.7 spelling of both directories.
 *
 * It is still on the `NEVER_INCLUDABLE` floor and always will be — see the note
 * there. Nothing else reads it except `resolveUserSeshMoverDir` below.
 */
export const LEGACY_DIR_NAME = ".claude-sesh-mover";
/** Committed: the opt-in re-include list, at the project root. */
export const INCLUDE_FILE_NAME = ".sesh-mover-include";
/** Committed: the per-segment exclusion list, at the project root. */
export const IGNORE_FILE_NAME = ".sesh-mover-ignore";
/**
 * The 0.7.0-only spellings of the two lists above.
 *
 * Read by nothing — a project holding one of these is simply not configured, the
 * same call 0.7.0 made about the pre-0.7.0 `.claude-sesh-mover/hubinclude`. They
 * exist for ONE reason: the `NEVER_INCLUDABLE` floor, which never drops a name.
 * See `PLUGIN_STATE_NAMES` below.
 */
export const LEGACY_INCLUDE_FILE_NAME = ".sesh-mover-hubinclude";
/** The 0.7.0-only spelling of the ignore list. Floor-only — see above. */
export const LEGACY_IGNORE_FILE_NAME = ".sesh-mover-hubignore";
/** Committed: this project's hub identity (`projectId`), at the project root. */
export const PROJECT_JSON_FILE_NAME = ".sesh-mover-project.json";
/**
 * Every name this plugin owns inside a user's project, in one place.
 *
 * Order matters only for readability. The floor (`NEVER_INCLUDABLE` in
 * `hub/workspace.ts`) is built from this list plus `.git`, so adding a name here
 * protects it on the carry side and the apply side at once.
 *
 * **THIS LIST ONLY EVER GROWS.** Three of its seven entries are names no current
 * version of this plugin writes or reads: `.claude-sesh-mover` (pre-0.7.0) and
 * the two 0.7.0 `hub*` spellings. Bundles carrying every one of them are already
 * sitting on hubs and inside export archives, and removing a name un-protects
 * exactly those — a payload could then plant a legacy include list that an older
 * peer still reads, which is the Slice-2 exfiltration primitive in a new shape.
 * A retired name costs two array entries and two `git` pathspecs; dropping one
 * costs a security property. Add, never replace.
 */
export const PLUGIN_STATE_NAMES = Object.freeze([
    PROJECT_DIR_NAME,
    LEGACY_DIR_NAME,
    INCLUDE_FILE_NAME,
    IGNORE_FILE_NAME,
    LEGACY_INCLUDE_FILE_NAME,
    LEGACY_IGNORE_FILE_NAME,
    PROJECT_JSON_FILE_NAME,
]);
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
export function isPluginStateName(name) {
    return PLUGIN_STATE_NAMES.includes(name);
}
/** `<projectPath>/.sesh-mover` — project-scope exports and config. */
export function projectSeshMoverDir(projectPath) {
    return join(projectPath, PROJECT_DIR_NAME);
}
/** `<projectPath>/.sesh-mover-include`. */
export function includeFilePath(projectPath) {
    return join(projectPath, INCLUDE_FILE_NAME);
}
/** `<projectPath>/.sesh-mover-ignore`. */
export function ignoreFilePath(projectPath) {
    return join(projectPath, IGNORE_FILE_NAME);
}
/** `<projectPath>/.sesh-mover-project.json`. */
export function projectJsonFilePath(projectPath) {
    return join(projectPath, PROJECT_JSON_FILE_NAME);
}
/**
 * Resolved once per home directory, because this is on the path of every
 * command and most of them touch it several times: `machine.ts`, `sync-state.ts`
 * and `lock.ts` each build a path from it, and a `renameSync` probe per call
 * would be both wasteful and racy with itself.
 *
 * Keyed by `homedir()` rather than a bare boolean so a test that repoints HOME
 * gets a fresh resolution without needing a reset hook on the public API.
 */
let resolution = null;
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
export function resolveUserSeshMoverDir() {
    const home = homedir();
    if (resolution && resolution.home === home)
        return resolution;
    const current = join(home, USER_DIR_NAME);
    const legacy = join(home, LEGACY_DIR_NAME);
    const currentExists = existsSync(current);
    const legacyExists = existsSync(legacy);
    let result;
    if (!legacyExists) {
        result = { dir: current, state: currentExists ? "current" : "fresh", warning: null };
    }
    else if (currentExists) {
        result = {
            dir: current,
            state: "both",
            warning: `Both ${legacy} and ${current} exist. sesh-mover is using ${current} and has left the other one alone — merging them automatically could destroy a machine identity or a sync-state file, and only you can tell which is the live one. If ${current} is the empty leftover, remove it and restart so the older directory is moved into place; otherwise ${legacy} is dead weight you can delete once you are sure.`,
        };
    }
    else {
        try {
            renameSync(legacy, current);
            result = {
                dir: current,
                state: "migrated",
                warning: `sesh-mover moved ${legacy} to ${current} (the directory dropped its \`claude-\` prefix in 0.7.0). Nothing was copied or recreated, so this machine keeps its identity, its hub sync state and its exports. Project-level files did NOT move: if a project has a \`.claude-sesh-mover/\` directory, recreate \`hubinclude\`/\`hubignore\`/\`project.json\` as \`${INCLUDE_FILE_NAME}\`/\`${IGNORE_FILE_NAME}\`/\`${PROJECT_JSON_FILE_NAME}\` at the project root. If you are coming from 0.7.0 instead, the two list files dropped their \`hub\` in 0.8.0 — rename \`${LEGACY_INCLUDE_FILE_NAME}\` to \`${INCLUDE_FILE_NAME}\` and \`${LEGACY_IGNORE_FILE_NAME}\` to \`${IGNORE_FILE_NAME}\`; \`${PROJECT_JSON_FILE_NAME}\` is unchanged.`,
            };
        }
        catch (e) {
            result = {
                dir: legacy,
                state: "migration-failed",
                warning: `sesh-mover could not move ${legacy} to ${current} (${e.message}). It is still using ${legacy}, so nothing is lost and this machine keeps its hub identity — but the move will be retried on every command until it succeeds. Move the directory by hand if the cause is permanent (a cross-device mount, for instance).`,
            };
        }
    }
    resolution = { ...result, home };
    return result;
}
/** The user-scope directory, after the one-time migration above. */
export function userSeshMoverDir() {
    return resolveUserSeshMoverDir().dir;
}
/**
 * The migration's warning as a `warnings` array, for the commands that have one.
 *
 * Deliberately not one-shot: a `both` or `migration-failed` state persists, and
 * a user who only ever runs `hub push` should keep being told. `migrated` fires
 * at most once per machine by construction — the legacy directory is gone
 * afterwards.
 */
export function userDirWarnings() {
    const w = resolveUserSeshMoverDir().warning;
    return w ? [w] : [];
}
//# sourceMappingURL=paths.js.map