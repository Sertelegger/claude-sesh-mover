/**
 * The project memory index (`memory/MEMORY.md`) and the union that reconciles
 * two copies of it.
 *
 * `MEMORY.md` is not prose: it is a list of pointer lines, and it is the ONLY
 * enumeration of the memory directory a future session reads. That is what
 * makes it the one auxiliary file with a mechanical, safe reconciliation — and
 * what made the naive "keep local on any difference" rule so damaging (#49): a
 * bundle's memory files land on disk correct and complete, and the one edit
 * that makes them reachable is withheld.
 *
 * Everything here is pure: strings in, strings out, no filesystem. The importer
 * owns every write; this module owns the rule.
 */
/** The index file inside a project's `memory/` directory. */
export declare const MEMORY_INDEX_NAME = "MEMORY.md";
/** One line of an index file, with the offsets needed to splice around it. */
export interface MemoryIndexLine {
    /** The line's own text, without its terminator. */
    raw: string;
    /** Offset of the line's first character in the source text. */
    start: number;
    /** Offset one past the line's last character (before its terminator). */
    end: number;
    /** Length of the terminator that follows: 0 (EOF), 1 (`\n`) or 2 (`\r\n`). */
    eolLen: number;
    /**
     * The normalised link target when this is a pointer line, else `null`.
     * `null` means "non-pointer content" — a heading, a blank line, prose, an
     * indented/nested line, a bullet with no link, or a bullet whose link is not
     * a memory (an external URL, an absolute path, anything with a `..`).
     */
    key: string | null;
}
/**
 * Normalise a markdown link destination to the key the union dedups on, or
 * `null` when the destination is not a memory file reference.
 *
 * The key is the **link target**, never the title and never the whole line:
 * the same memory is routinely retitled on two machines, and its one-line
 * description drifts every time either machine updates it, so keying on either
 * degenerates to "append everything". The target names a file on disk, which
 * is the only part of a pointer line that is the memory's identity.
 *
 * The rejections are a correctness rule, not a path-traversal guard — nothing
 * here dereferences the target. An external link is not a memory and must not
 * dedup against a file that happens to share its tail.
 */
export declare function normalizeMemoryTarget(dest: string): string | null;
/**
 * The pointer-line matcher. Returns the normalised target, or `null` when the
 * line is non-pointer content.
 *
 * A pointer line is, in this order: an unordered-list marker (`-`, `*`, `+`)
 * at column 0 followed by at least one space or tab; then a markdown inline
 * link `[text](target)`, the target being the first `](…)` group on the line;
 * then anything or nothing.
 *
 * Deliberately a marker check plus `indexOf` plus a paren-depth scan rather
 * than a regex with alternation — `src/hub/workspace.ts` replaced a glob regex
 * with a two-pointer matcher after a measured ReDoS, and this matcher runs over
 * a file that arrived from another machine.
 */
export declare function pointerTarget(line: string): string | null;
/**
 * Split an index into lines, keeping each line's offsets and terminator length
 * so the union can splice into the original bytes rather than re-join them.
 * A text ending in a terminator does NOT yield a final empty line.
 */
export declare function splitIndexLines(text: string): MemoryIndexLine[];
/**
 * Append lines to an index **after its last pointer line** — not at end of
 * file. That placement is the rule an implementer gets wrong: a real index that
 * ends in explanatory prose after its list would otherwise get its new entries
 * stranded below that prose, where a reader reads them as commentary rather
 * than as index entries.
 *
 * With no pointer line at all, they go after the last non-blank line. The
 * local file's own line endings and trailing-newline state are preserved.
 */
export declare function appendIndexLines(text: string, newLines: string[]): string;
export interface MemoryIndexUnionResult {
    /** The new local index text. Byte-identical to `local` when nothing is added. */
    text: string;
    /** Link targets appended, in incoming order. */
    added: string[];
    /** Incoming pointers deduped away because the local index already had them. */
    alreadyPresent: number;
    /** Incoming non-pointer content (headings, prose) that was discarded. */
    droppedProse: boolean;
}
/**
 * Union two index files: **your file, plus the entries it was missing.**
 *
 * The local file is emitted verbatim — every line, in its original order, with
 * its original bytes — and incoming pointer lines whose target the local index
 * does not already name are appended after its last pointer line.
 *
 * What it must never do, each because it would break the property that makes
 * this safe enough to run without asking:
 * - never reorder existing entries (a diff that reorders twelve lines to add
 *   two is unreviewable);
 * - never rewrite a local line — if the key matches, the local line wins whole,
 *   drifted description and all;
 * - never delete a line, including one whose target no longer exists. The worst
 *   case is a dead link in a markdown file, which is strictly better than the
 *   current worst case: a live file no line points at.
 *
 * Incoming non-pointer content is discarded: interleaving two documents' prose
 * is a document merge, which is the skill layer's job, not this function's. The
 * drop is reported (`droppedProse`), never silent.
 *
 * Idempotent by construction — a second run finds every incoming key already
 * present — which is what makes re-running an import safe.
 */
export declare function unionMemoryIndex(local: string, incoming: string): MemoryIndexUnionResult;
/**
 * Make an arbitrary string safe to interpolate into a pointer line's **display**
 * fields (its title and its description).
 *
 * Display text is SANITISED rather than rejected, because refusing a pointer
 * over an odd machine name would cost the user the index entry that makes a
 * memory reachable — which is #49's defect, arriving by a new route. Every
 * unsafe code point becomes a single space (not nothing: `a\nb` must not silently
 * read as `ab`), and `]` is dropped from a title by `formatMemoryPointer`
 * because a title carrying `](` steals the link's destination from this module's
 * own matcher.
 *
 * Note what this is NOT: a markdown escaper. `\]` would satisfy a renderer and
 * NOT `pointerTarget`, which is escape-blind by construction — it looks for the
 * first literal `](`. A guard the parser cannot see is not a guard.
 */
export declare function sanitizePointerText(text: string): string;
/**
 * Build one pointer line in the shape every index already uses, or `null` when
 * the target cannot be expressed as one.
 *
 * ## Why the three fields are treated differently
 *
 * A pointer line is built here from strings this module did not author: a title
 * and a target derived from a **bundle filename**, and a description carrying a
 * bundle's self-declared machine name, which nothing validates. Raw
 * interpolation let any of them carry a newline and append arbitrary entries to
 * the user's `MEMORY.md` — the same shape as the measured `git apply --summary`
 * defect in `hub/carry.ts`, where an attacker-controlled destination split a
 * line and a floor-protected file was deleted as a result. `unionMemoryIndex`
 * does not cover this: its incoming lines are newline-free *because they came
 * out of `splitIndexLines`*, and a line constructed here never did.
 *
 * - **Title and description are SANITISED** (see `sanitizePointerText`). They are
 *   prose with no identity role, so degrading a character is cheaper than
 *   withholding the line.
 * - **The target is REJECTED, never rewritten.** It is the key the union dedups
 *   on and the name of a real file on disk; escaping or stripping a character
 *   would produce a line that points at nothing *and* whose key no longer equals
 *   the caller's `parkedAs`, so the caller's "one pointer per parked file, ever"
 *   check would miss it and append a fresh duplicate on every single import. A
 *   target this module cannot express is a `null`, and the caller says so.
 *
 * ## The check is a round-trip, not a denylist
 *
 * The final guard is the module's OWN parser: the assembled line must split into
 * exactly one line and must read back through `pointerTarget` as the target that
 * was asked for. That cannot drift from `pointerTarget`/`normalizeMemoryTarget`
 * the way a hand-maintained character list would, and it covers, without naming
 * them, every way a target breaks the link: an unescaped `)` (closes the
 * destination early), a `(`, whitespace (a markdown destination ends at the
 * first space), a `./` prefix, a `..` segment, an absolute path, a `://` scheme.
 */
export declare function formatMemoryPointer(title: string, target: string, description: string): string | null;
/** Every memory file an index points at, deduped, in first-seen order. */
export declare function memoryIndexTargets(text: string): string[];
//# sourceMappingURL=memory-index.d.ts.map