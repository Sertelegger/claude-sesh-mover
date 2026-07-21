import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, } from "node:fs";
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
export async function unpackWorkspace(srcDir, targetPath, opts) {
    if (existsSync(targetPath) && readdirSync(targetPath).length > 0 && !opts.force) {
        throw new WorkspaceTargetNotEmptyError(targetPath);
    }
    let fileCount = 0;
    const walk = (from, to) => {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from, { withFileTypes: true })) {
            const src = join(from, entry.name);
            if (entry.isDirectory())
                walk(src, join(to, entry.name));
            else if (entry.isFile()) {
                copyFileSync(src, join(to, entry.name));
                fileCount++;
            }
        }
    };
    walk(srcDir, targetPath);
    return { fileCount };
}
//# sourceMappingURL=workspace.js.map