import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, } from "node:fs";
import { dirname, join } from "node:path";
import { HUBIGNORE_FILE_NAME, HUBINCLUDE_FILE_NAME, PLUGIN_STATE_NAMES, PROJECT_DIR_NAME, hubignoreFilePath, hubincludeFilePath, isPluginStateName, } from "../paths.js";
import { DEFAULT_WORKSPACE_MAX_MB } from "../config.js";
/**
 * The convenience excludes every carry path starts from. Each of these is a
 * DEFAULT, not a floor: `.sesh-mover-hubinclude` names any of them back
 * (the floor that nothing names back is `NEVER_INCLUDABLE`, below).
 *
 * `.claude` is the one entry here that is not about size or noise. It is the
 * project-local Claude Code directory, and a workspace snapshot is a plain file
 * copy of the project, so without this line every git-less project's push
 * uploaded `settings.local.json` (permission allowlists, which routinely name
 * paths and hostnames) and any project-local hooks — and, whenever
 * `CLAUDE_CONFIG_DIR` points inside the project, every transcript a SECOND
 * time, inside the workspace payload rather than the `sessions/` payload the
 * "sessions are secrets" handling applies to. Measured in a real bundle:
 * `bundle/workspace/.claude/settings.json` and
 * `bundle/workspace/.claude/projects/<encoded>/<session>.jsonl`. The
 * default-on SessionEnd auto-push is what made that the ordinary case rather
 * than something a user chose per push.
 */
export const DEFAULT_WORKSPACE_EXCLUDES = [
    ".git", "node_modules", ".claude", PROJECT_DIR_NAME, ".venv", "__pycache__", ".DS_Store",
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
 * - Everything in `PLUGIN_STATE_NAMES` holds this plugin's own project state —
 *   `.sesh-mover-project.json` (planted by pull independently), the
 *   project-scope `config.json` under `.sesh-mover/` (which can redirect
 *   `hub.path`), and `.sesh-mover-hubinclude` ITSELF. A payload able to write
 *   any of those could rewrite the list deciding what the next push ships,
 *   turning a workspace payload into an exfiltration primitive. So they are
 *   refused on the apply side too, not only on the carry side.
 *
 * TWO THINGS ABOUT THIS LIST ARE PERMANENT, not incidental to the 0.7.0 rename:
 *
 * 1. **`.claude-sesh-mover` stays here forever.** Bundles carrying that path are
 *    already sitting on hubs, written by every version before 0.7.0. Dropping
 *    the old name would un-protect every one of them and reopen the exact
 *    exfiltration primitive above in a new shape — a payload writing a legacy
 *    `hubinclude` that an older peer still reads.
 * 2. **The three root dotfiles need the floor MORE than the directory did.**
 *    They are ordinary files at the project root, so there is no directory name
 *    between a payload and them: `.sesh-mover-hubinclude` can be named directly.
 *    The check is per SEGMENT and fold-tolerant (`isNeverSegment`), so it holds
 *    at any depth and in every spelling the directory names already survive.
 *
 * Everything else in `DEFAULT_WORKSPACE_EXCLUDES` (`.claude`, `node_modules`,
 * `.venv`, `__pycache__`, `.DS_Store`) is a convenience default and stays
 * re-includable on purpose — a user who names it has said what they mean.
 *
 * `.claude` is the entry in that list that has to argue for itself, because it
 * is excluded for a disclosure reason rather than a size one (see
 * `DEFAULT_WORKSPACE_EXCLUDES`) and the two lists are one line apart. It is
 * deliberately NOT here, and the dividing line is what a name can do rather
 * than what it contains: this floor holds the names that decide where the hub
 * is, what the next push ships, and whether a VCS store survives being written
 * over — a payload that reaches any of those subverts sesh-mover itself.
 * `.claude` does none of that. Its risk is that its contents leave the
 * machine, which is the user's own call to make: a project-level
 * `.claude/settings.json` or a set of shared agents is ordinary project content
 * someone may well want carried between their own machines, and writing
 * `.claude` in `hubinclude` is exactly how they say so.
 */
export const NEVER_INCLUDABLE = Object.freeze([
    ".git",
    ...PLUGIN_STATE_NAMES,
]);
/** Byte cap on `hubinclude`; a bigger file is ignored outright (fail closed). */
const MAX_HUBINCLUDE_BYTES = 64 * 1024;
/** Pattern cap: every pattern is tested against every candidate path. */
const MAX_HUBINCLUDE_PATTERNS = 500;
export class WorkspaceTargetNotEmptyError extends Error {
    targetPath;
    constructor(targetPath) {
        // "overwrite", never "merge": `force` here means unpack the payload over
        // whatever is there, replacing files of the same name. The 3-way merge is a
        // different code path entirely (`mergeWorkspaceTrees`), reached only when a
        // generation common to both trees is known, and `--force-workspace`
        // deliberately SKIPS it. Calling this a merge is how a user ends up
        // consenting to an overwrite.
        super(`workspace target ${targetPath} exists and is not empty — pass force to unpack over it, overwriting files of the same name`);
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
// carried anyway.
//
// This is where hubignore and hubinclude DELIBERATELY DIVERGE, and the asymmetry
// is intentional rather than an oversight to be tidied away. Every hubignore
// pattern is matched per SEGMENT, so it has no way to express rooting and a
// trailing slash can only be decoration. hubinclude matches whole relative paths,
// so there a trailing slash is the difference between `docs` at the top level and
// every `docs` at any depth — and it must stay significant, because it is the
// exact shape `ignoredNotCarried` hands the user to paste. Net: `docs/` in this
// file excludes a `docs` anywhere; `docs/` in hubinclude names back only the top
// -level one. Do not "harmonize" them by making one follow the other.
export function readHubignore(projectPath) {
    const p = hubignoreFilePath(projectPath);
    if (!existsSync(p))
        return [];
    return readFileSync(p, "utf-8")
        .split("\n")
        .map((l) => l.trim().replace(/\/+$/, ""))
        .filter((l) => l.length > 0 && !l.startsWith("#"));
}
/** Where a project's `hubinclude` lives. */
export function hubincludePath(projectPath) {
    return hubincludeFilePath(projectPath);
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
 * fails safe (it only ever removes files), an include pattern fails OPEN. Over
 * `MAX_HUBINCLUDE_BYTES` the file is ignored entirely; past
 * `MAX_HUBINCLUDE_PATTERNS` the tail is dropped.
 *
 * Both bounds fail CLOSED — fewer re-includes — which from the outside is
 * indistinguishable from "my files silently stopped syncing". So a caller that
 * has somewhere to put it may pass `diagnostics`, and every bound that bit
 * appends a sentence naming the file, the limit and the consequence.
 * `snapshotWorkspace` threads them into the push's `warnings`.
 */
export function readHubinclude(projectPath, diagnostics) {
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
    if (!st.isFile()) {
        if (st.isDirectory()) {
            diagnostics?.push(`${HUBINCLUDE_FILE_NAME} is a directory, not a file — it was ignored entirely, so no re-includes are in effect.`);
        }
        return [];
    }
    if (st.size > MAX_HUBINCLUDE_BYTES) {
        diagnostics?.push(`${HUBINCLUDE_FILE_NAME} is ${st.size} bytes, over the ${MAX_HUBINCLUDE_BYTES}-byte cap — it was ignored ENTIRELY, so none of its re-includes are in effect and every path it names was left out of this snapshot.`);
        return [];
    }
    const all = readFileSync(p, "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
    if (all.length > MAX_HUBINCLUDE_PATTERNS) {
        diagnostics?.push(`${HUBINCLUDE_FILE_NAME} has ${all.length} patterns, over the ${MAX_HUBINCLUDE_PATTERNS}-pattern cap — only the first ${MAX_HUBINCLUDE_PATTERNS} are in effect and the rest were dropped.`);
    }
    return all.slice(0, MAX_HUBINCLUDE_PATTERNS);
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
    // Measured on the RAW text, before empty segments are dropped: a trailing,
    // leading or interior separator all mean the same thing — the author spelled
    // out a location, not a name.
    const rooted = s.includes("/");
    const segments = [];
    for (const raw of s.split("/")) {
        if (raw === "" || raw === ".")
            continue;
        if (raw === "..")
            return null;
        segments.push(raw);
    }
    return segments.length > 0 ? { segments, rooted } : null;
}
/** Does any segment of this path name something that can never be carried? */
export function isNeverIncludable(relPath) {
    const parsed = toSegments(relPath, "path");
    return parsed === null ? true : parsed.segments.some(isNeverSegment);
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
        const p = toSegments(raw, "pattern");
        if (p === null)
            continue;
        // A pattern naming a hard-excluded directory is dropped whole. This is
        // belt-and-braces and INCOMPLETE by construction (`.g*` names the same
        // directory and is not caught here) — the per-segment check on the PATH
        // side is the load-bearing guard. It earns its place by making the file's
        // contract legible: writing `.git` in hubinclude does nothing, ever.
        // (Removing this line survives the whole suite — it is unobservable BY
        // CONSTRUCTION, since the path-side check answers first for every path such
        // a pattern could match. Kept as documentation, not as a guard.)
        if (p.segments.some(isNeverSegment))
            continue;
        // `**` and `*` mean the same thing to a per-segment matcher; collapsing
        // runs keeps the matcher's work proportional to something a human wrote.
        parsed.push({ segments: p.segments.map((s) => s.replace(/\*+/g, "*")), rooted: p.rooted });
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
 * - **rooted** (`docs/superpowers/`, `build/keep.txt`, `docs/*.md`, and — the
 *   commonest line of all — `docs/`) — the pattern's segments must match the
 *   path's LEADING segments, so the pattern matches that path and everything
 *   under it, and nothing outside it. Anything with a separator ANYWHERE in it
 *   is rooted, trailing one included: `docs/` is `docs` at the project root,
 *   never `vendor/x/docs`.
 * - **bare** (`*.keepme`, `secrets`) — no separator at all, so it matches that
 *   name at any depth, the same way a `hubignore` line does. `snapshotWorkspace`
 *   walks excluded directories when a bare pattern exists precisely so this
 *   predicate and the payload it builds can never disagree (§6.0: one meaning
 *   in the product).
 *
 * That split matters more than it looks: `push.md` offers `ignoredNotCarried`
 * entries to be pasted verbatim and forbids widening one, and git spells a
 * wholly-ignored top-level directory as exactly `dist/`. Reading that as bare
 * would silently hand the user every nested `dist` directory as well.
 *
 * `NEVER_INCLUDABLE` wins over every pattern, on every segment — see that
 * constant. A path that is absolute or escapes the project is never a match.
 */
export function isReIncluded(relPath, patterns) {
    const path = toSegments(relPath, "path");
    if (path === null || path.segments.some(isNeverSegment))
        return false;
    const segments = path.segments;
    for (const { segments: pattern, rooted } of parsePatterns(patterns)) {
        if (!rooted && pattern.length === 1) {
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
    const dir = toSegments(dirRelPath, "path");
    if (dir === null || dir.segments.some(isNeverSegment))
        return false;
    const segments = dir.segments;
    for (const { segments: pattern, rooted } of parsePatterns(patterns)) {
        if (!rooted && pattern.length === 1)
            return true; // bare: any depth below
        if (pattern.length > segments.length &&
            segments.every((s, i) => matchesSegment(pattern[i], s))) {
            return true;
        }
    }
    return false;
}
/** One pattern segment against one path segment, with `isExcluded`'s glob rules. */
function matchesSegment(pattern, segment) {
    return globMatch(pattern, segment);
}
/**
 * `*`-glob match of ONE pattern against ONE name, in linear-ish time.
 *
 * This used to compile the pattern to `^…\.\*…$` and hand it to `RegExp`, which
 * is where the cost lived: a segment like `*a*a*a*a*a*a*a*b` against a run of
 * `a`s makes the backtracking engine explore ~n^7 paths. Measured through the
 * shipped `isReIncluded`, at eight wildcards — inside the wildcard cap that was
 * supposed to prevent exactly this — a 56-character name took 4.7 s and a
 * 64-character one 13.7 s; filenames go to 255 bytes, and `hubignore` had no
 * cap at all (a ten-star line against a 44-character name measured 9.6 s).
 *
 * The two-pointer form below is the standard one: walk both strings, remember
 * the last `*` and how far the name had been consumed, and on a mismatch resume
 * from there having let the `*` swallow one more character. Each `*` can only
 * advance the name pointer forward, so the work is bounded by
 * `len(pattern) * len(name)` — 255x255 in the worst case a filesystem can
 * produce — with no configuration-dependent cliff. That is why there is no
 * wildcard cap any more: the cap was the mitigation for the regex, and a cap of
 * 8 did not even hold the line it documented.
 *
 * The `*` branch is tested BEFORE the literal comparison so that a name
 * containing a literal `*` cannot consume the pattern's wildcard (`*` vs `*b`
 * must match). One deliberate behaviour change: `*` now crosses a newline,
 * where `RegExp`'s `.` did not. A filename may legitimately contain one, and an
 * ignore pattern that silently stopped matching such a name was the unsafe
 * direction; for `hubinclude` it changes nothing about the hard exclusions,
 * which are decided per segment by `isNeverSegment`, not by the glob.
 */
function globMatch(pattern, name) {
    let p = 0;
    let n = 0;
    let starP = -1;
    let starN = 0;
    while (n < name.length) {
        if (p < pattern.length && pattern[p] === "*") {
            starP = p++;
            starN = n;
        }
        else if (p < pattern.length && pattern.charCodeAt(p) === name.charCodeAt(n)) {
            p++;
            n++;
        }
        else if (starP !== -1) {
            // Backtrack: the last `*` swallows one more character of the name.
            p = starP + 1;
            n = ++starN;
        }
        else {
            return false;
        }
    }
    while (p < pattern.length && pattern[p] === "*")
        p++;
    return p === pattern.length;
}
export function isExcluded(name, patterns) {
    for (const pattern of patterns) {
        if (pattern.includes("*") ? globMatch(pattern, name) : name === pattern)
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
 * Walk a tree and visit every file the hub's carry rules admit — ONE definition
 * of "carried", used by the snapshot that builds a payload and by the merge that
 * applies one.
 *
 * It is shared rather than duplicated because the two disagreed in production:
 * `mergeWorkspaceTrees` filtered its three trees through the excludes while
 * knowing nothing about `hubinclude`, so a file the user had explicitly listed
 * was snapshotted, archived, uploaded, downloaded — and then dropped on the
 * ordinary pull path with no report row, while a `--force-workspace` unpack of
 * the same bundle applied it. Given the same rule files on both machines (they
 * live in the project and are meant to be committed), this function is what
 * makes "the payload" and "what an apply path considers" the same set.
 *
 * The invariant the walk maintains, and the reason it tracks a relative path
 * and an "inside an excluded subtree" flag rather than deciding entry by entry:
 *
 *   **every file admitted out of an excluded subtree is individually matched by
 *   `isReIncluded`, and therefore individually passed the `NEVER_INCLUDABLE`
 *   segment check.**
 *
 * Exclusion is sticky downward — once a directory is dropped, its descendants
 * are re-admitted one at a time, never wholesale — so re-including
 * `build/keep.txt` cannot drag `build/other.txt` along, and re-including a
 * subtree (`docs/`) still cannot drag a nested `.git` along.
 *
 * `onDropped` fires at the point the walk gives up on something, so a pruned
 * DIRECTORY is reported once instead of enumerating a subtree that was never
 * opened. Symlinks are never followed and never visited.
 *
 * `admitPaths` admits a known set of relative paths (and opens the directories
 * on the way to them) whatever the exclude rules say — everything except the
 * `NEVER_INCLUDABLE` floor, which nothing overrides. `mergeWorkspaceTrees` uses
 * it to scan the LOCAL tree for exactly the paths an incoming payload names,
 * so a local file under an excluded directory is never invisible to the merge
 * while its incoming counterpart is being applied.
 */
export function forEachCarriedFile(root, rules, visit, hooks) {
    const { excludePatterns, includePatterns } = rules;
    const admit = hooks?.admitPaths;
    // Directories on the way to an admitted path, so the walk opens them even
    // when the exclude rules prune them.
    const admitPrefixes = new Set();
    if (admit) {
        for (const p of admit) {
            let cut = p.indexOf("/");
            while (cut !== -1) {
                admitPrefixes.add(p.slice(0, cut));
                cut = p.indexOf("/", cut + 1);
            }
        }
    }
    const walk = (dir, rel, insideExcluded) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            // Hard exclusions first, and independently of `excludePatterns`:
            // isExcluded compares case-SENSITIVELY, but macOS and Windows filesystems
            // do not, so a git store renamed `.GIT` still works there and still
            // readdirs as ".GIT" — and it used to land in the payload, hubinclude or
            // not, because an entry the excludes never matched never reached a
            // re-include check.
            if (isNeverSegment(entry.name)) {
                // Counted as a skipped symlink too: a symlink NAMED `.git` is still a
                // symlink we declined to follow, and leaving it out of that count made
                // the snapshot's own report quietly incomplete.
                if (entry.isSymbolicLink())
                    hooks?.onSymlinkSkipped?.(childRel);
                hooks?.onDropped?.(childRel, "never-includable", entry.isDirectory());
                continue;
            }
            const excluded = insideExcluded || isExcluded(entry.name, excludePatterns);
            const carried = !excluded || isReIncluded(childRel, includePatterns) || admit?.has(childRel) === true;
            if (!carried) {
                // Not carried, but a pattern (or an admitted path) may still name
                // something below it. Only a real directory is worth opening; a
                // symlink never is.
                if (!entry.isDirectory() ||
                    (!mayContainReIncluded(childRel, includePatterns) && !admitPrefixes.has(childRel))) {
                    hooks?.onDropped?.(childRel, "excluded", entry.isDirectory());
                    continue;
                }
            }
            const srcPath = join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                hooks?.onSymlinkSkipped?.(childRel); // never follow: loop/escape safety
                continue;
            }
            if (entry.isDirectory())
                walk(srcPath, childRel, excluded);
            else if (entry.isFile() && carried)
                visit(childRel, srcPath);
        }
    };
    if (existsSync(root))
        walk(root, "", false);
}
/**
 * Do the carry rules admit this ONE relative path? The list-side counterpart of
 * the decision `forEachCarriedFile` makes per directory entry, for enumerations
 * that arrive as paths rather than as a walk — `git ls-files` output in
 * `carry.ts` is the only such producer today.
 *
 * It deliberately re-uses the same three primitives in the same order rather
 * than restating the rule, because a second, subtly different rule is exactly
 * how the payload and the apply side drifted apart before `forEachCarriedFile`
 * existed:
 *
 * 1. `NEVER_INCLUDABLE` on every segment — which also answers "no" for a path
 *    that is absolute, drive-rooted, or escapes via `..`, so this doubles as
 *    the traversal guard for paths that came from a subprocess.
 * 2. `excludePatterns` on every segment: exclusion is sticky downward, so a
 *    path under an excluded directory is excluded (`forEachCarriedFile` carries
 *    the same fact in its `insideExcluded` flag).
 * 3. `includePatterns` on the WHOLE relative path, which re-admits it.
 *
 * The two forms therefore agree by construction on any file both can see, which
 * `hub-carry.test.ts` pins against a real tree.
 */
export function isCarriedPath(relPath, rules) {
    const parsed = toSegments(relPath, "path");
    if (parsed === null || parsed.segments.some(isNeverSegment))
        return false;
    const excluded = parsed.segments.some((s) => isExcluded(s, rules.excludePatterns));
    return !excluded || isReIncluded(relPath, rules.includePatterns);
}
/** The exclude/include rule pair a project's own files are carried under. */
export function readCarryRules(projectPath, diagnostics) {
    return {
        excludePatterns: [...DEFAULT_WORKSPACE_EXCLUDES, ...readHubignore(projectPath)],
        includePatterns: readHubinclude(projectPath, diagnostics),
    };
}
/** Entry names in a directory, or `[]` if it cannot be read (missing, EACCES). */
function listDirSafely(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        return [];
    }
}
/**
 * Byte budget for one workspace snapshot — the whole payload, measured before
 * anything is copied. The FALLBACK, like `CARRY_MAX_BYTES`: the real one comes
 * from `hub.workspaceMaxMb` via `snapshotWorkspace`'s `maxBytes`.
 *
 * The guard exists because `hubinclude` made an unbounded payload reachable: a
 * single `*` line re-admits every built-in exclude, and a measured
 * `node_modules` alone is 6,021 files. Before that the built-in excludes made
 * an over-budget payload nearly impossible, so there was nothing to bound.
 *
 * **WHY THIS AND `CARRY_MAX_BYTES` NOW SHARE A DEFAULT, having deliberately
 * disagreed.** The original split was 50 MB here and 5 MB there, reasoning that
 * a snapshot is a whole project while a carry is a diff, so 5 MB in a diff
 * already means generated artifacts. The second half of that did not survive
 * contact: measured on this repository, its own untracked `.superpowers/`
 * working notes are ~12.6 MB of content the owner deliberately wants carried.
 * A diff of uncommitted work is not inherently small — it is exactly as large
 * as the work you have not committed yet. So the numbers agree now because the
 * distinction they encoded turned out not to exist, NOT because the two
 * payloads became the same thing. They still differ in every other way, and
 * they are separately configurable precisely so a user who does find the split
 * real can restore it.
 */
export const WORKSPACE_MAX_BYTES = DEFAULT_WORKSPACE_MAX_MB * 1024 * 1024;
/**
 * What one carried FILE costs against a budget on top of its bytes (one tar
 * header). Fixed, not a fraction of the budget — see `CARRY_PER_FILE_BYTES` in
 * carry.ts, which is the same charge for the same reason.
 */
const PER_FILE_BYTES = 512;
/**
 * Copy a project's working tree into `destDir`, minus the excluded paths and
 * plus whatever `hubinclude` names back in (design §5, §6.0). The rules
 * themselves live in `forEachCarriedFile`, which the apply side shares.
 *
 * `warnings` carries anything the user would otherwise have to infer from an
 * empty or surprising payload: a `hubinclude` big enough to be ignored, a
 * truncated pattern list, or an exclude set that swallowed the whole tree.
 *
 * `skipped` means the payload was over `maxBytes` and NOTHING was copied — see
 * `WORKSPACE_MAX_BYTES`. The size is measured in a first, copy-free pass
 * precisely so the over-budget case costs a stat walk rather than gigabytes of
 * I/O that is then thrown away. All-or-nothing is the deliberate shape: a
 * truncated snapshot is worse than none, because the apply side reads a missing
 * file as an upstream state rather than as a payload that was cut short.
 * Callers must not record a generation or set `hasWorkspace` for a skipped
 * snapshot.
 */
export async function snapshotWorkspace(projectPath, destDir, opts) {
    const warnings = [];
    const maxBytes = Math.max(0, opts?.maxBytes ?? WORKSPACE_MAX_BYTES);
    if (maxBytes === 0) {
        // A budget of 0 is an explicit "snapshot nothing" (see `resolveBudgetMb`),
        // answered before the measuring walk so that it costs nothing. Handled
        // separately from the over-budget branch below rather than falling into it:
        // on an EMPTY project the measured cost is also 0, and `0 > 0` is false, so
        // that branch would quietly build an empty payload for a setting that said
        // not to.
        return {
            fileCount: 0,
            byteSize: 0,
            symlinksSkipped: 0,
            skipped: true,
            warnings: [
                "The workspace snapshot budget is set to 0, so this push carries no project files (hub.workspaceMaxMb). Raise that setting, or pass --no-workspace on later pushes, if that is not what you meant.",
            ],
        };
    }
    const rules = readCarryRules(projectPath, warnings);
    let fileCount = 0;
    let byteSize = 0;
    let symlinksSkipped = 0;
    // Pass 1: measure only. `statSync` is safe here for the same reason it is in
    // the copy below — `forEachCarriedFile` never visits a symlink.
    //
    // Each file also costs `PER_FILE_BYTES` against the budget: a pure byte
    // budget bounds the wrong thing, since a tree of hundreds of thousands of
    // tiny generated files measures near zero and still costs a copy, a tar
    // entry, and a file the peer writes on every pull.
    let measured = 0;
    let cost = 0;
    let counted = 0;
    const largest = [];
    forEachCarriedFile(projectPath, rules, (relPath, srcPath) => {
        let size = 0;
        try {
            size = statSync(srcPath).size;
        }
        catch {
            return; // unreadable now; the copy pass reports it if it is still there
        }
        measured += size;
        cost += size + PER_FILE_BYTES;
        counted++;
        largest.push({ path: relPath, size });
        largest.sort((a, b) => b.size - a.size);
        if (largest.length > 3)
            largest.pop();
    });
    if (cost > maxBytes) {
        warnings.push(`The workspace snapshot was skipped: ${formatBytes(cost)} of project files across ${counted} file(s) exceeds the ${formatBytes(maxBytes)} snapshot budget, so this push carries no project files (largest: ${largest.map((f) => `${f.path} ${formatBytes(f.size)}`).join(", ")}). Exclude what you don't need with ${HUBIGNORE_FILE_NAME} — and check ${HUBINCLUDE_FILE_NAME} for a pattern like \`*\` that re-admits node_modules and the other built-in excludes.`);
        return { fileCount: 0, byteSize: measured, symlinksSkipped: 0, skipped: true, warnings };
    }
    // Created up front, not lazily per file: a payload this function returns
    // WITHOUT `skipped` is one the caller declares in the manifest, and a
    // declared payload that isn't in the bundle is a crash on every machine that
    // pulls it (`unpackWorkspace`/`mergeWorkspaceTrees` both start by reading
    // this directory). An empty tree is a legitimate outcome — an empty project,
    // or a hubignore broad enough to drop everything — so the empty DIRECTORY is
    // what has to travel. It survives the tar round trip (verified).
    mkdirSync(destDir, { recursive: true });
    forEachCarriedFile(projectPath, rules, (relPath, srcPath) => {
        const outPath = join(destDir, ...relPath.split("/"));
        mkdirSync(dirname(outPath), { recursive: true });
        copyFileSync(srcPath, outPath);
        fileCount++;
        byteSize += statSync(srcPath).size;
    }, { onSymlinkSkipped: () => { symlinksSkipped++; } });
    // An empty payload is a legitimate outcome (an empty project), but it is also
    // what one over-broad line produces: `*/` in hubignore excludes every
    // top-level directory, so the snapshot silently carried nothing. Say so
    // whenever there WAS something to carry.
    if (fileCount === 0 && listDirSafely(projectPath).some((n) => !isPluginStateName(n))) {
        warnings.push(`The workspace snapshot is empty: every file in this project was dropped by the built-in workspace excludes or by ${HUBIGNORE_FILE_NAME}, so this push carries no project files. Check it for an over-broad pattern (\`*\` and \`*/\` match everything at a level), or pass --no-workspace on future pushes if that is what you meant.`);
    }
    return { fileCount, byteSize, symlinksSkipped, skipped: false, warnings };
}
/** Human-readable size for a warning a user has to act on. */
export function formatBytes(bytes) {
    if (bytes >= 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} bytes`;
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
 * internals (`NEVER_INCLUDABLE`). A CURRENT sesh-mover never produces such a
 * bundle — `snapshotWorkspace` hard-excludes both and `mergeWorkspaceTrees`
 * lists neither — but three things reach this branch, and only one is an
 * attack: a hand-made or damaged bundle; a bundle written by a version older
 * than this guard, on a case-insensitive filesystem where a store spelled
 * `.GIT` slipped past the case-sensitive exclude list; and a deliberately
 * planted payload, whose prize is `.sesh-mover-hubinclude` — the file
 * deciding what the NEXT push ships. Callers must not name a culprit. Refusing
 * here is what keeps the two apply paths (merge and unpack) saying the same
 * thing, the same argument that moved `classifyDestination` into this module.
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