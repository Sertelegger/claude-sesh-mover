import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, } from "node:fs";
import { join } from "node:path";
export const DEFAULT_WORKSPACE_EXCLUDES = [
    ".git", "node_modules", ".claude-sesh-mover", ".venv", "__pycache__", ".DS_Store",
];
/**
 * Names that can never be carried, re-included, or applied — at ANY depth, on
 * any path, by any pattern (design §6.0).
 *
 * `hubinclude` exists to make the exclusion logic say "yes" where it used to
 * say "no", so this list is the floor it can never dig under:
 *
 * - `.git` is a VCS store, not project content: it holds credentials in some
 *   configurations, it is enormous, and a peer's copy landing on top of a local
 *   one corrupts the repository rather than merging it. A *nested* `.git` (a
 *   vendored submodule, a worktree) is the same store one level down, which is
 *   why the check is per segment and not just on the first one.
 * - `.claude-sesh-mover` holds this plugin's own project state — `project.json`
 *   (planted by pull independently), the project-scope `config.json` (which can
 *   redirect `hub.path`), and `hubinclude` ITSELF. A payload able to write that
 *   directory could rewrite the list deciding what the next push ships, turning
 *   a workspace payload into an exfiltration primitive. So it is refused on the
 *   apply side too, not only on the carry side.
 *
 * Everything else in `DEFAULT_WORKSPACE_EXCLUDES` (`node_modules`, `.venv`,
 * `__pycache__`, `.DS_Store`) is a convenience default and stays re-includable
 * on purpose — a user who names it has said what they mean.
 */
export const NEVER_INCLUDABLE = [".git", ".claude-sesh-mover"];
/** Byte cap on `hubinclude`; a bigger file is ignored outright (fail closed). */
const MAX_HUBINCLUDE_BYTES = 64 * 1024;
/** Pattern cap: every pattern is tested against every candidate path. */
const MAX_HUBINCLUDE_PATTERNS = 500;
/**
 * Wildcard cap per pattern segment. `isExcluded` compiles a glob to
 * `^…​.*…​.*…$`, and a segment like `*a*a*a*a*a*a*a*a*a*a*a*b` tested against a
 * long run of `a`s backtracks combinatorially — measured to hang the walk. A
 * pattern over the cap is dropped, which is the fail-closed direction (fewer
 * re-includes), and no honest pattern comes close.
 */
const MAX_PATTERN_WILDCARDS = 8;
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
//
// A trailing slash is stripped so `build/` and `build` mean the same thing.
// Without that, `build/` was a SILENT NO-OP: isExcluded compares a pattern to a
// bare directory entry name, which never carries a slash, so the directory was
// carried anyway. hubinclude documents `dir/` as meaningful (§6.0) and calls
// itself a sibling of this file, so the two have to agree.
export function readHubignore(projectPath) {
    const p = join(projectPath, ".claude-sesh-mover", "hubignore");
    if (!existsSync(p))
        return [];
    return readFileSync(p, "utf-8")
        .split("\n")
        .map((l) => l.trim().replace(/\/+$/, ""))
        .filter((l) => l.length > 0 && !l.startsWith("#"));
}
/** Where a project's `hubinclude` lives. */
export function hubincludePath(projectPath) {
    return join(projectPath, ".claude-sesh-mover", "hubinclude");
}
/**
 * hubinclude: the opt-in re-include list (design §6.0). Sibling to `hubignore`,
 * same syntax, and meant to be COMMITTED so it travels with the repo and means
 * the same thing on every clone.
 *
 * It exists because `.gitignore` is also where `.env` and credential files
 * live: ignored files are never carried by default, and this is the explicit,
 * reviewable exception list. Returned lines are raw (trimmed only) — every
 * normalization happens in `isReIncluded`, so what a user wrote is what a
 * caller can echo back to them.
 *
 * Bounds are asymmetric with `readHubignore` on purpose: an ignore pattern
 * fails safe (it only ever removes files), an include pattern fails OPEN and
 * costs a glob test per candidate path. Over `MAX_HUBINCLUDE_BYTES` the file is
 * ignored entirely; past `MAX_HUBINCLUDE_PATTERNS` the tail is dropped.
 */
export function readHubinclude(projectPath) {
    const p = hubincludePath(projectPath);
    let st;
    try {
        st = statSync(p);
    }
    catch {
        return [];
    }
    // isFile() also refuses a directory and a device node (a `hubinclude ->
    // /dev/zero` symlink would otherwise be read forever).
    if (!st.isFile() || st.size > MAX_HUBINCLUDE_BYTES)
        return [];
    return readFileSync(p, "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"))
        .slice(0, MAX_HUBINCLUDE_PATTERNS);
}
/**
 * Is this ONE path segment a name that can never be carried?
 *
 * Comparison is case-insensitive and ignores trailing dots and whitespace
 * because a directory that IS the git store can present under any of those
 * spellings: macOS and Windows filesystems fold case (a store renamed `.GIT`
 * still works), and Win32 strips trailing dots/spaces from path components, so
 * `.git.` and `.git ` resolve to `.git` there. Refusing a POSIX file genuinely
 * named `.git.` is the harmless direction of that trade.
 */
function isNeverSegment(segment) {
    return NEVER_INCLUDABLE.includes(segment.replace(/[.\s]+$/u, "").toLowerCase());
}
/**
 * Split a workspace-relative path into segments, or `null` if it is not a
 * project-relative path at all (absolute, UNC, drive-rooted, or escaping via
 * `..`). `null` always means "no" at every call site — never "match anything".
 *
 * Backslashes are treated as separators on EVERY platform. `hubinclude` is
 * committed and shared, so a pattern written on Windows has to work on macOS
 * and vice versa; and on the path side it is load-bearing for safety, since a
 * `\`-spelled `.git\config` would otherwise read as one exotic filename and
 * sail past the segment guard. The cost — a POSIX file whose name genuinely
 * contains a backslash reads as two segments — only ever makes the guard
 * stricter.
 */
function toSegments(input, kind) {
    // NFC on both sides: macOS hands back decomposed names from readdir while a
    // pattern committed from Linux is usually composed, and the same file must
    // not stop matching because of which machine typed the accent. It cannot
    // weaken the NEVER_INCLUDABLE check — those names are ASCII, and no sequence
    // NFC-composes INTO ASCII (that is NFK*, which this deliberately is not).
    const s = input.normalize("NFC").replace(/\\/g, "/");
    if (/^[a-zA-Z]:/.test(s))
        return null; // drive-relative or drive-absolute
    // A leading "/" on a PATTERN is the familiar "rooted at the project" spelling
    // and is simply stripped (our patterns are rooted already). On a PATH it means
    // absolute, and an absolute path is nobody's workspace-relative path.
    if (s.startsWith("/") && kind === "path")
        return null;
    const segments = [];
    for (const raw of s.split("/")) {
        if (raw === "" || raw === ".")
            continue;
        if (raw === "..")
            return null;
        segments.push(raw);
    }
    return segments.length > 0 ? segments : null;
}
/** Does any segment of this path name something that can never be carried? */
export function isNeverIncludable(relPath) {
    const segments = toSegments(relPath, "path");
    return segments === null ? true : segments.some(isNeverSegment);
}
/**
 * Patterns are normalized once per array identity: `isReIncluded` runs per
 * directory entry during a walk, and re-splitting the same strings for every
 * candidate path is pure waste. Callers must treat a patterns array they have
 * handed in as immutable (they all read it straight from `readHubinclude`).
 */
const patternCache = new WeakMap();
function parsePatterns(patterns) {
    const cached = patternCache.get(patterns);
    if (cached)
        return cached;
    const parsed = [];
    for (const raw of patterns) {
        const segments = toSegments(raw, "pattern");
        if (segments === null)
            continue;
        // A pattern naming a hard-excluded directory is dropped whole. This is
        // belt-and-braces and INCOMPLETE by construction (`.g*` names the same
        // directory and is not caught here) — the per-segment check on the PATH
        // side is the load-bearing guard. It earns its place by making the file's
        // contract legible: writing `.git` in hubinclude does nothing, ever.
        // (Removing this line survives the whole suite — it is unobservable BY
        // CONSTRUCTION, since the path-side check answers first for every path such
        // a pattern could match. Kept as documentation, not as a guard.)
        if (segments.some(isNeverSegment))
            continue;
        const normalized = [];
        let tooWild = false;
        for (const segment of segments) {
            const collapsed = segment.replace(/\*+/g, "*");
            if ((collapsed.match(/\*/g)?.length ?? 0) > MAX_PATTERN_WILDCARDS) {
                tooWild = true;
                break;
            }
            normalized.push(collapsed);
        }
        if (!tooWild)
            parsed.push(normalized);
    }
    patternCache.set(patterns, parsed);
    return parsed;
}
/**
 * Does `hubinclude` name this workspace-relative path?
 *
 * Matching is on the RELATIVE PATH, not a bare segment, so a pattern carries a
 * subtree. Two shapes, both segment-wise with `*` globs:
 *
 * - **rooted** (`docs/superpowers/`, `build/keep.txt`, `docs/*.md`) — the
 *   pattern's segments must match the path's LEADING segments, so the pattern
 *   matches that path and everything under it, and nothing outside it.
 * - **bare** (`*.keepme`, `secrets`) — matches that name at any depth, the same
 *   way a `hubignore` line does. `snapshotWorkspace` walks excluded directories
 *   when a bare pattern exists precisely so this predicate and the payload it
 *   builds can never disagree (§6.0: one meaning in the product).
 *
 * `NEVER_INCLUDABLE` wins over every pattern, on every segment — see that
 * constant. A path that is absolute or escapes the project is never a match.
 */
export function isReIncluded(relPath, patterns) {
    const segments = toSegments(relPath, "path");
    if (segments === null || segments.some(isNeverSegment))
        return false;
    for (const pattern of parsePatterns(patterns)) {
        if (pattern.length === 1) {
            if (segments.some((s) => matchesSegment(pattern[0], s)))
                return true;
        }
        else if (pattern.length <= segments.length &&
            pattern.every((p, i) => matchesSegment(p, segments[i]))) {
            return true;
        }
    }
    return false;
}
/**
 * Could anything BELOW this directory be re-included? The walker's companion to
 * `isReIncluded`: it decides whether to descend into a directory that the
 * exclude patterns dropped, so that the two never disagree about a path.
 *
 * A bare pattern matches at any depth, so it forces descent into every excluded
 * directory — the price of that convenience is a read-only walk of, say, an
 * excluded `node_modules` on each push. A rooted pattern only opens the
 * directories on its own prefix, so `docs/*.keepme` keeps the walk pruned.
 * Nothing ever descends into a `NEVER_INCLUDABLE` directory: not one path
 * inside it can be carried, so reading it would be pure cost.
 */
export function mayContainReIncluded(dirRelPath, patterns) {
    const segments = toSegments(dirRelPath, "path");
    if (segments === null || segments.some(isNeverSegment))
        return false;
    for (const pattern of parsePatterns(patterns)) {
        if (pattern.length === 1)
            return true; // bare: can match at any depth below
        if (pattern.length > segments.length &&
            segments.every((s, i) => matchesSegment(pattern[i], s))) {
            return true;
        }
    }
    return false;
}
/** One pattern segment against one path segment, with `isExcluded`'s glob rules. */
function matchesSegment(pattern, segment) {
    return isExcluded(segment, [pattern]);
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
/**
 * Copy a project's working tree into `destDir`, minus the excluded paths and
 * plus whatever `hubinclude` names back in (design §5, §6.0).
 *
 * The invariant the walk maintains, and the reason it tracks a relative path
 * and an "inside an excluded subtree" flag rather than deciding entry by entry:
 *
 *   **every file copied out of an excluded subtree is individually matched by
 *   `isReIncluded`, and therefore individually passed the `NEVER_INCLUDABLE`
 *   segment check.**
 *
 * Exclusion is sticky downward — once a directory is dropped, its descendants
 * are re-admitted one at a time, never wholesale — so re-including
 * `build/keep.txt` cannot drag `build/other.txt` along, and re-including a
 * subtree (`docs/`) still cannot drag a nested `.git` along.
 */
export async function snapshotWorkspace(projectPath, destDir) {
    const patterns = [...DEFAULT_WORKSPACE_EXCLUDES, ...readHubignore(projectPath)];
    const includePatterns = readHubinclude(projectPath);
    let fileCount = 0;
    let byteSize = 0;
    let symlinksSkipped = 0;
    const walk = (srcDir, outDir, rel, insideExcluded) => {
        for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
            // Hard exclusions first, and independently of `patterns`: isExcluded
            // compares case-SENSITIVELY, but macOS and Windows filesystems do not, so
            // a git store renamed `.GIT` still works there and still readdirs as
            // ".GIT" — and it used to land in the payload, hubinclude or not, because
            // an entry the excludes never matched never reached a re-include check.
            if (isNeverSegment(entry.name))
                continue;
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            const excluded = insideExcluded || isExcluded(entry.name, patterns);
            const carried = !excluded || isReIncluded(childRel, includePatterns);
            if (!carried) {
                // Not carried, but a pattern may still name something below it. Only
                // a real directory is worth opening; a symlink never is.
                if (!entry.isDirectory() || !mayContainReIncluded(childRel, includePatterns))
                    continue;
            }
            const srcPath = join(srcDir, entry.name);
            if (entry.isSymbolicLink()) {
                symlinksSkipped++; // never follow: loop/escape safety (archiver posture)
                continue;
            }
            if (entry.isDirectory()) {
                walk(srcPath, join(outDir, entry.name), childRel, excluded);
            }
            else if (entry.isFile()) {
                mkdirSync(outDir, { recursive: true });
                copyFileSync(srcPath, join(outDir, entry.name));
                fileCount++;
                byteSize += statSync(srcPath).size;
            }
        }
    };
    walk(projectPath, destDir, "", false);
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
 *
 * `refused` reports paths dropped because the PAYLOAD named plugin or VCS
 * internals (`NEVER_INCLUDABLE`). A bundle this codebase produced never
 * contains them — `snapshotWorkspace` hard-excludes both and `mergeWorkspaceTrees`
 * lists neither — so a payload that does is malformed or hostile, and the one
 * it would most want is `.claude-sesh-mover/hubinclude`: the file deciding what
 * the NEXT push ships. Refusing here is what keeps the two apply paths (merge
 * and unpack) saying the same thing, the same argument that moved
 * `classifyDestination` into this module.
 */
export async function unpackWorkspace(srcDir, targetPath, opts) {
    if (existsSync(targetPath) && readdirSync(targetPath).length > 0 && !opts.force) {
        throw new WorkspaceTargetNotEmptyError(targetPath);
    }
    let fileCount = 0;
    let symlinksSkipped = 0;
    const blocked = [];
    const refused = [];
    const walk = (from, to, rel) => {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from, { withFileTypes: true })) {
            const src = join(from, entry.name);
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (isNeverSegment(entry.name)) {
                refused.push(childRel); // never applied, never opened — see `refused`
                continue;
            }
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
    return { fileCount, symlinksSkipped, blocked, refused };
}
//# sourceMappingURL=workspace.js.map