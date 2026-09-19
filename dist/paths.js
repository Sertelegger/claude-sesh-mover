import { homedir } from "node:os";
import { join } from "node:path";
/**
 * Every on-disk name sesh-mover owns, in one place.
 *
 * ## Why these names
 *
 * `claude-sesh-mover` is the npm package and GitHub repo — the `claude-` prefix
 * makes the scope obvious to someone browsing that ecosystem. `sesh-mover` is
 * the plugin name and the CLI bin, kept short because it is what a user types.
 * A dotfile is the latter. An earlier `.claude-sesh-mover/` also asserted
 * "Claude" about projects that may have no Claude in them at all: the hub index
 * schema carries an `agent` discriminator from day one and Codex/Gemini support
 * is tracked, so the directory name had to stop claiming otherwise.
 *
 * ## Why the split by lifecycle
 *
 * One directory used to hold two things with opposite lifecycles: generated
 * exports (must never be committed) and user config plus identity (the include
 * list, the ignore list, `project.json` — must be committed, or they do not
 * work). One directory cannot be both, which is why `.gitignore` needed a
 * negation to make this repo able to follow its own README. That was a symptom.
 * Splitting by lifecycle is the fix:
 *
 * - `<project>/.sesh-mover/` — generated exports only. Plainly gitignored.
 * - `<project>/.sesh-mover-include`, `-ignore`, `-project.json` — the
 *   committed files, as ordinary root dotfiles, the way every comparable tool
 *   spells a per-project config.
 * - `~/.sesh-mover/` — machine identity, sync state, locks, user-scope exports
 *   and config.
 *
 * ## 0.8.0 is a clean break
 *
 * These are the only names this plugin reads or writes. Nothing here falls back
 * to a spelling an earlier release used, nothing migrates one, and nothing
 * warns about one: a pre-0.8.0 directory or list file is inert, not a redirect,
 * because no reader looks at it. That is a deliberate end to two consecutive
 * renames' worth of compatibility machinery — see the CHANGELOG's 0.8.0 entry
 * for what a user coming from an older version does instead.
 */
/** Per-project directory: generated exports only, and gitignored. */
export const PROJECT_DIR_NAME = ".sesh-mover";
/** User-scope directory: machine identity, sync state, locks, exports, config. */
export const USER_DIR_NAME = ".sesh-mover";
/** Committed: the opt-in re-include list, at the project root. */
export const INCLUDE_FILE_NAME = ".sesh-mover-include";
/** Committed: the per-segment exclusion list, at the project root. */
export const IGNORE_FILE_NAME = ".sesh-mover-ignore";
/** Committed: this project's hub identity (`projectId`), at the project root. */
export const PROJECT_JSON_FILE_NAME = ".sesh-mover-project.json";
/**
 * Every name this plugin owns inside a user's project, in one place.
 *
 * Order matters only for readability. The floor (`NEVER_INCLUDABLE` in
 * `hub/workspace.ts`) is built from this list plus `.git`, so adding a name here
 * protects it on the carry side and the apply side at once.
 *
 * **THERE IS EXACTLY ONE COPY OF THIS LIST, and that is the invariant to keep.**
 * Every predicate, pathspec and byte scan that has to agree about "what belongs
 * to sesh-mover" derives from here rather than restating a literal, so a name
 * cannot be protected on one side and not the other. A name added here is
 * protected everywhere; a name removed is un-protected everywhere, which is why
 * a change to this list is a security change and is pinned by exact-contents
 * assertions in `tests/paths.test.ts` and `tests/hub-workspace.test.ts` (two
 * sites there — they move together).
 */
export const PLUGIN_STATE_NAMES = Object.freeze([
    PROJECT_DIR_NAME,
    INCLUDE_FILE_NAME,
    IGNORE_FILE_NAME,
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
/**
 * The children of `<configDir>/projects/<encoded>/<sessionId>/` that an export
 * CARRIES — and therefore the only ones `migrate` may delete (#124).
 *
 * **These are Claude Code's names, not this plugin's**, which is why they are
 * not on `PLUGIN_STATE_NAMES`. They live here anyway because the property that
 * matters is the same one that list exists for: exactly one copy, so the
 * exporter and the migrator's cleanup cannot disagree about what travelled.
 *
 * The list is deliberately a CLOSED set that the code treats as incomplete.
 * Claude Code adds directories to a session on its own schedule and has done so
 * twice already — `workflows/` (run records and scripts) and
 * `auto-mode-classifier-error.txt` — neither of which any version of this
 * plugin carries. Both were found by accident, after a real migration, by
 * diffing 6,382 files. So the rule is not "delete everything except these", it
 * is "delete ONLY these, keep anything unrecognised, and say so" — which is
 * safe against the next name without anyone having to learn it first.
 */
export const EXPORTED_SESSION_DIR_NAMES = ["subagents", "tool-results"];
/** `<projectPath>/.sesh-mover-project.json`. */
export function projectJsonFilePath(projectPath) {
    return join(projectPath, PROJECT_JSON_FILE_NAME);
}
/**
 * `~/.sesh-mover` — machine identity, sync state, locks, exports and config.
 *
 * Resolved from `homedir()` on every call rather than memoized: it is a string
 * join with no filesystem probe behind it, and reading the home directory each
 * time is what lets a test repoint HOME without a reset hook on the public API.
 *
 * Creating it is the job of whoever writes into it. A call that only reads must
 * leave a home directory untouched.
 */
export function userSeshMoverDir() {
    return join(homedir(), USER_DIR_NAME);
}
//# sourceMappingURL=paths.js.map