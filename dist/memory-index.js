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
export const MEMORY_INDEX_NAME = "MEMORY.md";
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
export function normalizeMemoryTarget(dest) {
    let t = dest.trim();
    if (t === "")
        return null;
    // A markdown destination ends at the first whitespace; anything after it is
    // a link title, not part of the target.
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (c === " " || c === "\t") {
            t = t.slice(0, i);
            break;
        }
    }
    while (t.startsWith("./"))
        t = t.slice(2);
    if (t === "")
        return null;
    if (t.includes("://"))
        return null; // external link
    if (t.startsWith("#"))
        return null; // in-document anchor
    if (t.startsWith("/") || t.startsWith("\\"))
        return null; // absolute
    for (const seg of t.split(/[\\/]/)) {
        if (seg === "..")
            return null;
    }
    return t;
}
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
export function pointerTarget(line) {
    if (line.length < 2)
        return null;
    const marker = line[0];
    if (marker !== "-" && marker !== "*" && marker !== "+")
        return null;
    const second = line[1];
    if (second !== " " && second !== "\t")
        return null;
    const open = line.indexOf("[", 2);
    if (open === -1)
        return null;
    const bridge = line.indexOf("](", open);
    if (bridge === -1)
        return null;
    let depth = 1;
    let i = bridge + 2;
    for (; i < line.length; i++) {
        const c = line[i];
        if (c === "(")
            depth++;
        else if (c === ")") {
            depth--;
            if (depth === 0)
                break;
        }
    }
    if (depth !== 0)
        return null; // unterminated — not a link
    return normalizeMemoryTarget(line.slice(bridge + 2, i));
}
/**
 * Split an index into lines, keeping each line's offsets and terminator length
 * so the union can splice into the original bytes rather than re-join them.
 * A text ending in a terminator does NOT yield a final empty line.
 */
export function splitIndexLines(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
        const nl = text.indexOf("\n", i);
        if (nl === -1) {
            const raw = text.slice(i);
            out.push({ raw, start: i, end: text.length, eolLen: 0, key: pointerTarget(raw) });
            break;
        }
        const crlf = nl > i && text[nl - 1] === "\r";
        const end = crlf ? nl - 1 : nl;
        const raw = text.slice(i, end);
        out.push({ raw, start: i, end, eolLen: crlf ? 2 : 1, key: pointerTarget(raw) });
        i = nl + 1;
    }
    return out;
}
/** The local file's line ending convention — CRLF only if its first one is. */
function detectEol(text) {
    const nl = text.indexOf("\n");
    if (nl === -1)
        return "\n";
    return nl > 0 && text[nl - 1] === "\r" ? "\r\n" : "\n";
}
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
export function appendIndexLines(text, newLines) {
    if (newLines.length === 0)
        return text;
    const eol = detectEol(text);
    const lines = splitIndexLines(text);
    if (lines.length === 0)
        return newLines.join(eol) + eol;
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].key !== null) {
            at = i;
            break;
        }
    }
    if (at === -1) {
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].raw.trim() !== "") {
                at = i;
                break;
            }
        }
    }
    if (at === -1) {
        // Nothing but blank lines.
        return text.endsWith("\n")
            ? text + newLines.join(eol) + eol
            : text + eol + newLines.join(eol) + eol;
    }
    const line = lines[at];
    if (line.eolLen > 0) {
        const cut = line.end + line.eolLen;
        return text.slice(0, cut) + newLines.map((l) => l + eol).join("") + text.slice(cut);
    }
    // The insertion point is the final line and it has no terminator: keep the
    // file's "no trailing newline" state rather than quietly adding one.
    return text + eol + newLines.join(eol);
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
export function unionMemoryIndex(local, incoming) {
    const localLines = splitIndexLines(local);
    const incomingLines = splitIndexLines(incoming);
    const localKeys = new Set();
    const localProse = new Set();
    for (const l of localLines) {
        if (l.key !== null)
            localKeys.add(l.key);
        else if (l.raw.trim() !== "")
            localProse.add(l.raw.trim());
    }
    const added = [];
    const newLines = [];
    const seen = new Set();
    let alreadyPresent = 0;
    let droppedProse = false;
    for (const l of incomingLines) {
        if (l.key === null) {
            // Only count prose the local file does not already carry, so a shared
            // `# Memory Index` header is not reported as a loss on every import.
            if (l.raw.trim() !== "" && !localProse.has(l.raw.trim()))
                droppedProse = true;
            continue;
        }
        if (seen.has(l.key))
            continue; // two incoming lines for one key contribute one
        seen.add(l.key);
        if (localKeys.has(l.key)) {
            alreadyPresent++;
            continue;
        }
        added.push(l.key);
        newLines.push(l.raw);
    }
    return {
        text: appendIndexLines(local, newLines),
        added,
        alreadyPresent,
        droppedProse,
    };
}
/** Build one pointer line in the shape every index already uses. */
export function formatMemoryPointer(title, target, description) {
    return `- [${title}](${target}) — ${description}`;
}
/** Every memory file an index points at, deduped, in first-seen order. */
export function memoryIndexTargets(text) {
    const out = [];
    const seen = new Set();
    for (const l of splitIndexLines(text)) {
        if (l.key === null || seen.has(l.key))
            continue;
        seen.add(l.key);
        out.push(l.key);
    }
    return out;
}
//# sourceMappingURL=memory-index.js.map