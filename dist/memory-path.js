import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { encodeProjectPath, resolveConfigDir } from "./platform.js";
/**
 * Where Claude Code keeps a project's auto-memory. ONE resolver, shared by the
 * exporter's READ, the importer's WRITE and hub pull's WRITE (#150).
 *
 * ## The defect
 *
 * Claude Code keys a project's TRANSCRIPTS on the working directory a session
 * was started in — `<configDir>/projects/<encoded cwd>/…` — and its
 * auto-memory on the CANONICAL GIT ROOT of that working directory:
 * `<base>/projects/<encoded root>/memory/`, with `<base>` the config dir
 * unless `CLAUDE_CODE_REMOTE_MEMORY_DIR` names another. The two folders are
 * the same only outside a git repository and at the root of a repository's
 * main working tree; they differ for a session started in a SUBDIRECTORY of a
 * repository or in a LINKED WORKTREE.
 *
 * sesh-mover assumed the two were one folder: the exporter read memory out of
 * the transcript folder it had just discovered (`exporter.ts`), and the
 * importer and hub pull wrote it into the target's transcript folder
 * (`importer.ts`, reached from `hub/pull-apply-sessions.ts`). So an export or
 * auto-push from a subdirectory or a worktree shipped no memory and said
 * nothing (`success: true`, `includedLayers: ["jsonl"]`, `warnings: []`), and
 * an import into one landed memory in a folder Claude Code never reads — where
 * the index union and the conflict parking of #49 then ran against an empty
 * directory. Nothing is lost at the source; the layer just never travels.
 *
 * This module is the root cause of that, and it is deliberately a function of
 * the PROJECT PATH rather than of a folder name: the transcript folder is the
 * thing that is keyed on the working directory, and it stays that way.
 *
 * ## The resolver, in Claude Code's own order — first match wins
 *
 * 1. the `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` environment variable, which names
 *    the memory directory itself;
 * 2. the `autoMemoryDirectory` setting;
 * 3. the canonical git root (below), under `CLAUDE_CODE_REMOTE_MEMORY_DIR ??
 *    configDir`, with `CLAUDE_CODE_PROJECT_DIR_NAME` naming the folder when the
 *    base is the config dir (#152) and the plain encoding of the root
 *    otherwise;
 * 4. otherwise the path itself, which is the pre-#150 behaviour and still the
 *    right answer for a plain directory.
 *
 * The order and the resolver chain are the ones reported from the Claude Code
 * 2.1.283–2.1.285 bundles in #150 (verified there, not re-verified here); the
 * canonical-root walk below is a port of the behaviour described there.
 *
 * ## The canonical root is found by WALKING, never by running git
 *
 * The walk mirrors Claude Code's: upward from the project path until `.git` is
 * found, and when `.git` is a `gitdir:` FILE, follow it to the common dir —
 * but only through the `worktrees/` layout, and only when the worktree's
 * back-pointer is there too.
 *
 * `git rev-parse --git-common-dir` is the tempting shortcut and is WRONG for a
 * submodule: its common dir is `<super>/.git/modules/<name>`, so the common
 * dir's parent is the SUPERPROJECT — a different project, with its own
 * sessions and its own memory. The `worktrees/`-layout check is what keeps a
 * submodule's memory in the submodule (#150's fix sketch).
 *
 * ## Why the environment inputs are gated on the config dir in use
 *
 * `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, `CLAUDE_CODE_REMOTE_MEMORY_DIR` and
 * `CLAUDE_CODE_PROJECT_DIR_NAME` describe THE CLAUDE CODE PROCESS. A
 * `sesh-mover export --source-config-dir <other>` or `import --target-config-dir
 * <other>` run names a different config dir than the one this environment's
 * Claude Code uses, and routing ITS memory by this process's environment is
 * how a bundle silently ships the wrong project's memory. So they are honored
 * only for the config dir the environment itself names — the same rule #152
 * applies to the folder-name override, generalized: the config dir is the one
 * `CLAUDE_CONFIG_DIR` names, or `~/.claude` when it names none. A test that
 * passes a temp config dir is therefore isolated from whatever these vars hold
 * on the machine running it.
 *
 * The `autoMemoryDirectory` SETTING is not env, so it is not gated: it is read
 * from the config dir and project in use, which is what identifies it.
 */
/** Claude Code's per-project memory folder name, under `<base>/projects/<encoded>/`. */
const MEMORY_DIR_NAME = "memory";
/** A non-empty environment variable, or `undefined`. */
function envValue(name) {
    const value = process.env[name];
    return value !== undefined && value.length > 0 ? value : undefined;
}
/**
 * Do the environment's Claude Code inputs describe THIS config dir?
 *
 * `resolveConfigDir()` with no arguments is exactly what a Claude Code process
 * in this environment would use — `CLAUDE_CONFIG_DIR`, else `~/.claude`.
 */
function envNamesThisConfigDir(configDir) {
    try {
        return resolve(resolveConfigDir()) === resolve(configDir);
    }
    catch {
        return false;
    }
}
/**
 * The repository root whose memory Claude Code keys, or `null` when the path
 * is not inside a git working tree at all (which is the plain-directory case,
 * and the common one).
 *
 * The path is walked AS GIVEN — not `resolve`d, not `realpath`ed. Callers on
 * the write side are handed paths `cli.ts` has already turned physical
 * (#149), and a caller-typed path is also what the rest of the pipeline keys
 * folders on; resolving here would silently re-encode a path whose spelling
 * the transcript folder was filed under.
 */
export function canonicalGitRoot(projectPath) {
    let dir = projectPath;
    for (;;) {
        const dotGit = join(dir, ".git");
        let kind = null;
        try {
            const stat = statSync(dotGit);
            kind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
        }
        catch {
            kind = null;
        }
        // A directory `.git` is a MAIN working tree (or a plain repository, or a
        // submodule laid out the old way) — this level is the root.
        if (kind === "dir")
            return dir;
        // A file `.git` is a `gitdir:` pointer: a linked worktree, or a submodule.
        if (kind === "file")
            return mainWorkingTreeOf(dir) ?? dir;
        const up = dirname(dir);
        if (up === dir)
            return null;
        dir = up;
    }
}
/**
 * Follow a `gitdir:` pointer to the MAIN working tree it belongs to, and
 * return `null` when it does not describe a linked worktree — in which case
 * the pointer's own directory is the root (a submodule's memory belongs to the
 * submodule, not to the repository that contains it).
 */
function mainWorkingTreeOf(workTree) {
    let text;
    try {
        text = readFileSync(join(workTree, ".git"), "utf8");
    }
    catch {
        return null;
    }
    const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!match)
        return null;
    const gitDir = resolve(workTree, match[1]);
    // BOTH checks are load-bearing, and together they are the submodule guard:
    // a submodule's git dir is `<super>/.git/modules/<name>` — not under
    // `worktrees/`, and carrying no back-pointer — so "the common dir's parent"
    // would name the superproject, a different project with its own sessions and
    // its own memory.
    if (basename(dirname(gitDir)) !== "worktrees")
        return null;
    // The back-pointer: `<gitDir>/gitdir` names the working tree this worktree
    // was created from. A directory that merely spells itself `worktrees/`
    // without one is not a worktree git dir this code should follow.
    if (!existsSync(join(gitDir, "gitdir")))
        return null;
    let common;
    try {
        common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    }
    catch {
        return null;
    }
    const main = dirname(resolve(gitDir, common));
    return existsSync(main) ? main : null;
}
/**
 * `CLAUDE_CODE_PROJECT_DIR_NAME`, Claude Code's folder-name override (#152):
 * valid only when `CLAUDE_CONFIG_DIR` is set AND names the config dir in use,
 * and only when the value passes Claude Code's own two checks — its name regex
 * and the Windows reserved-device-name list. Mirrors the bundle exactly, so
 * that #150's memory folder and #152's session folder cannot come to disagree
 * about the name.
 */
export function projectFolderNameOverride(configDir) {
    const configEnv = process.env.CLAUDE_CONFIG_DIR;
    if (configEnv === undefined || configEnv.length === 0)
        return null;
    try {
        if (resolve(configEnv) !== resolve(configDir))
            return null;
    }
    catch {
        return null;
    }
    const name = envValue("CLAUDE_CODE_PROJECT_DIR_NAME");
    if (name === undefined)
        return null;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
        return null;
    if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name))
        return null;
    return name;
}
/**
 * `autoMemoryDirectory`, the setting half of the resolver (#150 step 2), read
 * in Claude Code's precedence: project-local, project, then user settings.
 *
 * Claude Code's own project-layer read is behind a gate the bundle analysis in
 * #150 could not trace (`qH()` in 2.1.285), so this mirrors the UNCONDITIONAL
 * read. That is the side to be wrong on for a destination: a project that sets
 * the key wants its memory there, and refusing to look is what shipped memory
 * nobody reads.
 *
 * A setting that is present but not a non-empty string is treated as absent,
 * and an unreadable or malformed file as no setting at all — the resolver must
 * not throw on a user's half-written settings file, because every export,
 * import and pull calls it.
 */
function configuredMemoryDir(configDir, projectRoot) {
    const files = [
        join(projectRoot, ".claude", "settings.local.json"),
        join(projectRoot, ".claude", "settings.json"),
        join(configDir, "settings.json"),
    ];
    for (const file of files) {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(file, "utf8"));
        }
        catch {
            continue;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            continue;
        const value = parsed.autoMemoryDirectory;
        if (typeof value === "string" && value.length > 0)
            return value;
    }
    return null;
}
/**
 * The directory Claude Code reads a project's memory from, and the directory a
 * bundle's `memory/` must therefore be read out of (export) or written into
 * (import, pull).
 *
 * `projectPath` is the PROJECT, not the transcript folder: a session started in
 * `repo/sub/dir` or in `repo/worktree` has its transcripts under the encoded
 * spelling of that path and its memory under the canonical root, which is what
 * this resolves. Nothing here consults a discovered session or an encoded
 * folder name, so the answer cannot drift from Claude Code's by construction.
 */
export function resolveMemoryDir(configDir, projectPath) {
    if (envNamesThisConfigDir(configDir)) {
        const override = envValue("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE");
        if (override !== undefined)
            return override;
    }
    const root = canonicalGitRoot(projectPath) ?? projectPath;
    const configured = configuredMemoryDir(configDir, root);
    if (configured !== null)
        return configured;
    const base = (envNamesThisConfigDir(configDir)
        ? envValue("CLAUDE_CODE_REMOTE_MEMORY_DIR")
        : undefined) ?? configDir;
    // The folder-name override applies to the CONFIG DIR base only: with a remote
    // memory dir Claude Code names the folder after the root plainly, which is
    // also why that base cannot collide with the override folder here.
    const folder = base === configDir
        ? projectFolderNameOverride(configDir) ?? encodeProjectPath(root)
        : encodeProjectPath(root);
    return join(base, "projects", folder, MEMORY_DIR_NAME);
}
//# sourceMappingURL=memory-path.js.map