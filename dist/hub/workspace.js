import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, } from "node:fs";
import { join } from "node:path";
export const DEFAULT_WORKSPACE_EXCLUDES = [
    ".git", "node_modules", ".claude-sesh-mover", ".venv", "__pycache__", ".DS_Store",
];
export class WorkspaceTargetNotEmptyError extends Error {
    targetPath;
    constructor(targetPath) {
        super(`workspace target ${targetPath} exists and is not empty — pass force to merge into it`);
        this.targetPath = targetPath;
    }
}
// hubignore: one pattern per line, '#' comments and blank lines skipped.
// Patterns are matched against individual path segments at any depth,
// literal or with '*' wildcards — deliberately NOT full gitignore semantics.
export function readHubignore(projectPath) {
    const p = join(projectPath, ".claude-sesh-mover", "hubignore");
    if (!existsSync(p))
        return [];
    return readFileSync(p, "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
}
export function isExcluded(name, patterns) {
    for (const pattern of patterns) {
        if (!pattern.includes("*")) {
            if (name === pattern)
                return true;
            continue;
        }
        const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
        if (re.test(name))
            return true;
    }
    return false;
}
/**
 * Decide whether `rel` is safe to write inside `targetDir`.
 *
 * `rel` is always built from real directory entries in a bundle's tree, so it
 * can never contain a separator, `..`, or a NUL — but what already sits at that
 * path LOCALLY is another matter, and both hazards below write outside the
 * project or destroy unrelated data if ignored:
 *
 * - A symlink at the path (or at any parent) — `copyFileSync` follows symlinks
 *   on the destination, so writing "docs/note.md" through a `docs -> ~/notes`
 *   link silently overwrites a file nobody asked to touch. `mkdirSync(...,
 *   { recursive: true })` likewise succeeds against an existing symlink-to-dir,
 *   which is how an entire subtree escapes.
 * - A directory where a file belongs (or a file where a directory belongs) —
 *   `copyFileSync` raises EISDIR and `mkdirSync` raises ENOTDIR/EEXIST, which
 *   without this check aborts a half-applied tree.
 *
 * `expect` says what the caller is about to create there: a workspace unpack
 * walks directories too, and a directory already sitting at a directory's path
 * is the normal case, not a collision.
 *
 * Lives here rather than in merge.ts so BOTH ways of applying a payload —
 * 3-way merge and Slice-1 unpack — go through one guard. They did not, and the
 * unpack path wrote through symlinks (verified) until this was shared.
 */
export function classifyDestination(targetDir, rel, expect = "file") {
    const segments = rel.split("/");
    let current = targetDir;
    for (let i = 0; i < segments.length; i++) {
        current = join(current, segments[i]);
        let st;
        try {
            st = lstatSync(current);
        }
        catch {
            return { ok: true }; // nothing there yet: we create it (and everything under it)
        }
        if (st.isSymbolicLink())
            return { ok: false, reason: "local-symlink" };
        const isLast = i === segments.length - 1;
        const wantDirectory = !isLast || expect === "dir";
        if (wantDirectory ? !st.isDirectory() : !st.isFile()) {
            return { ok: false, reason: "local-not-a-file" };
        }
    }
    return { ok: true };
}
export async function snapshotWorkspace(projectPath, destDir) {
    const patterns = [...DEFAULT_WORKSPACE_EXCLUDES, ...readHubignore(projectPath)];
    let fileCount = 0;
    let byteSize = 0;
    let symlinksSkipped = 0;
    const walk = (srcDir, outDir) => {
        for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
            if (isExcluded(entry.name, patterns))
                continue;
            const srcPath = join(srcDir, entry.name);
            if (entry.isSymbolicLink()) {
                symlinksSkipped++; // never follow: loop/escape safety (archiver posture)
                continue;
            }
            if (entry.isDirectory()) {
                walk(srcPath, join(outDir, entry.name));
            }
            else if (entry.isFile()) {
                mkdirSync(outDir, { recursive: true });
                copyFileSync(srcPath, join(outDir, entry.name));
                fileCount++;
                byteSize += statSync(srcPath).size;
            }
        }
    };
    walk(projectPath, destDir);
    return { fileCount, byteSize, symlinksSkipped };
}
/**
 * Apply a workspace payload by copying it over `targetPath`, overwriting on
 * collision. Slice-1 behavior, and still the right one when there is no
 * ancestor generation to merge against (design §5.4).
 *
 * `blocked` reports paths that were NOT written because of what already sits at
 * the destination locally — see `classifyDestination`. Nothing is written near
 * a blocked path, so the caller must surface it: an unreported skip and a
 * successful copy look identical from the outside.
 */
export async function unpackWorkspace(srcDir, targetPath, opts) {
    if (existsSync(targetPath) && readdirSync(targetPath).length > 0 && !opts.force) {
        throw new WorkspaceTargetNotEmptyError(targetPath);
    }
    let fileCount = 0;
    let symlinksSkipped = 0;
    const blocked = [];
    const walk = (from, to, rel) => {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from, { withFileTypes: true })) {
            const src = join(from, entry.name);
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) {
                // Never follow (loop/escape safety). Bundles reaching unpack already
                // passed the archiver's tar validation, which rejects symlink entries —
                // this skip+count is defense-in-depth for direct callers of this module.
                symlinksSkipped++;
                continue;
            }
            if (!entry.isDirectory() && !entry.isFile())
                continue;
            // The destination is the user's own tree, which the source's cleanliness
            // says nothing about: a `docs -> ~/notes` symlink here used to send the
            // whole subtree outside the project (measured), because copyFileSync
            // follows destination symlinks and mkdirSync -p accepts one.
            const dest = classifyDestination(targetPath, childRel, entry.isDirectory() ? "dir" : "file");
            if (!dest.ok) {
                blocked.push({ path: childRel, reason: dest.reason });
                continue;
            }
            if (entry.isDirectory())
                walk(src, join(to, entry.name), childRel);
            else {
                copyFileSync(src, join(to, entry.name));
                fileCount++;
            }
        }
    };
    walk(srcDir, targetPath, "");
    return { fileCount, symlinksSkipped, blocked };
}
//# sourceMappingURL=workspace.js.map