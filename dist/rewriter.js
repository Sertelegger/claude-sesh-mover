import { createReadStream, createWriteStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { applyAdapters } from "./version-adapters.js";
import { detectPlatform, encodeProjectPath, extractUserFromPath, getCurrentUser, samePlatformFamily, translatePath, } from "./platform.js";
import { errorMessage } from "./errors.js";
import { latchedWriteStream } from "./latched-write.js";
/**
 * The characters that may appear INSIDE a path token, and — with one stated
 * exception — the characters that block a token from starting.
 *
 * **One constant, because two lists drifted.** The guard used to be
 * `[A-Za-z0-9.-]` while the token class was `[A-Za-z0-9._@+~-]`, so `_ @ ~ +`
 * were legal inside a token and invisible in front of one. Measured against
 * the shipped build, that mangled ordinary shell output:
 *
 *     "cd ~/tmp/build"   ->  "cd ~C:\Users\…\Temp\build"
 *     "~/mnt/e/x"        ->  "~E:\x"
 *
 * A tilde is not a domain character, so no URL rule was protecting it; the
 * asymmetry alone was the bug. Deriving both from one constant is what stops
 * the two lists disagreeing again — the class is the thing, not the two
 * spellings of it.
 */
const TOKEN_CHARS = "A-Za-z0-9._@+~-";
/**
 * The guard class, which is `TOKEN_CHARS` MINUS `+`.
 *
 * **`+` is carved out deliberately, by owner ruling, and the reason is this
 * repo's own subject matter.** A line beginning `+/home/user/src/app.ts` is a
 * unified-diff added line, and `rewriteString` runs on captured shell output —
 * where `git diff` output is ordinary and where a project whose whole domain is
 * carry patches will meet it. Under full symmetry those paths would stop being
 * translated and a transcript would show the SOURCE machine's path, which is
 * wrong in a way a reader cannot see is wrong.
 *
 * The carve-out is the kind of exception that invites someone to "finish" the
 * symmetry later, so it is spelled here with the reason attached rather than
 * left as a difference between two character classes. `tests/rewriter.test.ts`
 * pins both halves: `+`-prefixed paths still translate, and `~`/`_`/`@` no
 * longer do.
 */
const GUARD_CHARS = TOKEN_CHARS.replace("+", "");
// Characters that terminate a path token embedded in free text.
// (?<!\/) — a token immediately preceded by "/" is URL-context
// (http://mnt/..., protocol-relative //tmp/..., file:///mnt/...) and is
// never translated. The `GUARD_CHARS` lookbehind protects paths following
// domain names (https://example.com/mnt/...) and, since the two classes were
// unified, anything else a token may contain. Together these prevent URL
// corruption while still translating bare filesystem paths. Leaving text
// unchanged is the preferred failure mode.
const UNIX_TOKEN = new RegExp(`(?<![${GUARD_CHARS}])(?<!\\/)(?:\\/[${TOKEN_CHARS}]+)+\\/?`, "g");
const WIN_TOKEN = new RegExp(`(?<![${GUARD_CHARS}])(?<!\\/)[A-Za-z]:\\\\[^\\s"'\`)\\]}>,;]*`, "g");
const TAIL = /[^\s"'`)\]}>,;:]*/;
/**
 * A scheme prefix immediately before the position a stage-1 match starts at
 * (#108).
 *
 * **Stage 1 had no leading guard at all**, and that is a different bug from the
 * one above rather than a variant of it. Stage 2 matches a SHAPE (`/seg/seg`)
 * and can be guarded by a character class; stage 1 substitutes a known LITERAL
 * wherever it appears, including inside a URL — so a character class cannot
 * express the rule. Measured, and NOT gated on a cross-platform move:
 *
 *     "https://example.com/home/me/proj/x"          ->  ".../home/dev/app/x"
 *     "http://localhost:5173/home/me/proj/index.html"
 *                                    (cross-family) ->  "http://localhost:5173E:\proj/index.html"
 *
 * The first is the dangerous one: still a well-formed URL, now pointing
 * somewhere else. Every export/import/push/pull runs stage 1, so this fired on
 * same-machine moves too.
 *
 * Matched against the text BEFORE the candidate rather than as a lookbehind,
 * because the mapping is interpolated into the pattern and a variable-length
 * lookbehind in front of it would be both unreadable and easy to get wrong. It
 * is deliberately narrow — a scheme and authority, not "any URL-ish thing" —
 * so a path that merely follows a colon still translates.
 */
const URL_PREFIX = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`)\]}>,;]*$/;
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalizeSeparators(tail, targetPlatform) {
    return targetPlatform === "win32"
        ? tail.replace(/\//g, "\\")
        : tail.replace(/\\/g, "/");
}
/**
 * The primitive for a field that is a path IN ITS ENTIRETY but whose interior
 * may carry ids this import is renaming (#127).
 *
 * `rewriteWholePath` alone is not enough for the largest such family.
 * `realParentDir` (6,358 occurrences measured) looks like
 * `/tmp/claude-1000/-home-dev-repos-x/<sourceSessionId>/scratchpad`: the
 * leading `/tmp/claude-1000` matches no mapping, so the prefix pass hands it
 * back untouched — and the two things that ARE stale sit mid-path.
 *
 * The interior pass matches whole `/`- or `\`-delimited SEGMENTS and nothing
 * else. An encoded project name and a session id are each exactly one segment,
 * and segment matching is what makes a prefix collision between two encoded
 * names structurally impossible here — unlike `rewriteString`, which needs a
 * lookahead guard for the same job.
 */
export function rewritePathValue(input, ctx) {
    const mapped = rewriteWholePath(input, ctx);
    if (!ctx.encodedProject && !ctx.sessionIdMap)
        return mapped;
    const isSep = /^[/\\]$/;
    return mapped
        .split(/([/\\])/)
        .map((seg) => {
        if (isSep.test(seg))
            return seg;
        if (ctx.encodedProject && seg === ctx.encodedProject[0])
            return ctx.encodedProject[1];
        return ctx.sessionIdMap?.get(seg) ?? seg;
    })
        .join("");
}
export function rewriteString(input, ctx) {
    const crossFamily = !samePlatformFamily(ctx.sourcePlatform, ctx.targetPlatform);
    let result = input;
    // Stage 1: exact mappings (project path, config dir, home), longest first.
    // Cross-family, the tail after the replacement gets its separators
    // normalized up to a token boundary; same-family tails are left alone.
    for (const mapping of ctx.mappings) {
        // Only replace when mapping.from ends at a path-component boundary: the
        // next char is a separator, or the match ends at a token terminator / EOS.
        // Prevents `/home/me/app` from rewriting inside `/home/me/app-backup`.
        const re = new RegExp(escapeRegex(mapping.from) + "(?![^\\s\"'`)\\]}>,;:/\\\\])" + "(" + TAIL.source + ")", "g");
        result = result.replace(re, (m, tail, offset, whole) => {
            // #108: leave a mapped path alone when it sits inside a URL. Checked on
            // the text BEFORE this match rather than in the pattern — see
            // `URL_PREFIX`. Returning the match verbatim is the no-op, and "leave
            // text unchanged" is this function's stated preferred failure mode.
            if (URL_PREFIX.test(whole.slice(0, offset)))
                return m;
            return mapping.to + (crossFamily ? normalizeSeparators(tail, ctx.targetPlatform) : tail);
        });
    }
    // Stage 2 (cross-family only): translate remaining path-like tokens through
    // the platform engine (/mnt/<drive>, /tmp, /home, /Users, drive letters).
    if (crossFamily) {
        const tokenRe = ctx.sourcePlatform === "win32" ? WIN_TOKEN : UNIX_TOKEN;
        result = result.replace(tokenRe, (token) => translatePath(token, ctx.sourcePlatform, ctx.targetPlatform, {
            sourceUser: ctx.sourceUser,
            targetUser: ctx.targetUser,
        }));
    }
    return mapSessionDirSegments(result, ctx);
}
/**
 * Stage 3 of `rewriteString`: the session-id segment of a path into this
 * import's own session directories (#136).
 *
 * #127 taught stage 1 the encoded project name, so a free-text
 * `<configDir>/projects/<encoded>/<sessionId>/tool-results/x.txt` came out
 * with the target config dir, the target encoded name and the SOURCE session
 * id — a directory that exists on neither machine, in the `<persisted-output>`
 * text the model reads, beside a `persistedOutputPath` that `rewritePathValue`
 * had mapped correctly.
 *
 * It runs on the FINISHED text, after both earlier stages, and matches the
 * TARGET directory — so it recognizes the path the same way whether a mapping
 * moved it there, the token engine did, or it never needed to move. Three
 * things keep it from reading prose as a path:
 *
 * - only the ONE segment directly under `targetProjectDir` is a candidate, and
 *   only an exact key of the map is replaced. A bare uuid in a sentence is
 *   CONTENT; `/tmp/claude-<uid>/<encoded>/<sessionId>/…` names a scratchpad no
 *   bundle carries and keeps its id here (a whole-path field still maps it);
 *   `<sessionId>.jsonl` is a file name, not the id, exactly as in
 *   `rewritePathValue`.
 * - the directory must not continue a longer token (`GUARD_CHARS`, stage 2's
 *   rule), so `/x/tgt/cfg/projects/…` is some other directory.
 * - a match inside a URL is left alone (`URL_PREFIX`, stage 1's rule).
 *
 * Separators are matched as `[/\\]` because the target may be Windows while
 * the text arrived with either.
 */
function mapSessionDirSegments(text, ctx) {
    const ids = ctx.sessionIdMap;
    const root = ctx.targetProjectDir?.replace(/[/\\]+$/, "");
    if (!ids || ids.size === 0 || !root)
        return text;
    const matcher = sessionDirMatcher(ctx, root);
    // Cheap reject: every match contains the directory's last segment, and most
    // free text does not.
    if (!text.includes(matcher.lastSegment))
        return text;
    return text.replace(matcher.re, (m, seg, offset, whole) => {
        const to = ids.get(seg);
        if (to === undefined)
            return m;
        if (URL_PREFIX.test(whole.slice(0, offset)))
            return m;
        return m.slice(0, m.length - seg.length) + to;
    });
}
/**
 * Stage 3's pattern depends only on the context's `targetProjectDir`, while
 * `rewriteString` runs on every free-text field of every entry — and every
 * Bash command naming a scratchpad under the target's encoded project passes
 * the cheap reject — so it is compiled once per context rather than per call.
 * Keyed weakly on the context object, and re-checked against `root`, so a
 * caller that builds a new context, or edits one, never matches a stale
 * directory. Reusing a `g` regex is safe here: `String.prototype.replace`
 * resets `lastIndex` before it starts.
 */
const sessionDirMatchers = new WeakMap();
function sessionDirMatcher(ctx, root) {
    const cached = sessionDirMatchers.get(ctx);
    if (cached && cached.root === root)
        return cached;
    const segments = root.split(/[/\\]/);
    const matcher = {
        root,
        lastSegment: segments[segments.length - 1],
        re: new RegExp(`(?<![${GUARD_CHARS}])` +
            segments.map(escapeRegex).join("[/\\\\]") +
            "[/\\\\]" +
            "([^/\\\\\\s\"'`)\\]}>,;:]+)", "g"),
    };
    sessionDirMatchers.set(ctx, matcher);
    return matcher;
}
// Like rewriteString, but for fields that are a path in their entirety (cwd,
// trackedFileBackups keys) rather than free text that may merely *contain*
// paths. Stage-1 exact mappings normalize their WHOLE tail (not just up to
// the first token boundary), so spaces and other non-token characters in the
// tail still get separator-normalized cross-family. Falls through to the
// same token-translation engine as rewriteString when no mapping matches.
export function rewriteWholePath(input, ctx) {
    const crossFamily = !samePlatformFamily(ctx.sourcePlatform, ctx.targetPlatform);
    for (const mapping of ctx.mappings) {
        if (input === mapping.from ||
            input.startsWith(mapping.from + "/") ||
            input.startsWith(mapping.from + "\\")) {
            const tail = input.slice(mapping.from.length);
            return mapping.to + (crossFamily ? normalizeSeparators(tail, ctx.targetPlatform) : tail);
        }
    }
    if (crossFamily) {
        return translatePath(input, ctx.sourcePlatform, ctx.targetPlatform, {
            sourceUser: ctx.sourceUser,
            targetUser: ctx.targetUser,
        });
    }
    return input;
}
export function buildPathMappings(sourcePlatform, targetPlatform, sourceProjectPath, targetProjectPath, sourceConfigDir, targetConfigDir, sourceUser, targetUser) {
    const mappings = [];
    // Project path mapping (most specific first)
    if (sourceProjectPath !== targetProjectPath) {
        mappings.push({
            from: sourceProjectPath,
            to: targetProjectPath,
            description: `Project path: ${sourceProjectPath} -> ${targetProjectPath}`,
        });
    }
    // Config dir mapping
    if (sourceConfigDir !== targetConfigDir) {
        mappings.push({
            from: sourceConfigDir,
            to: targetConfigDir,
            description: `Config dir: ${sourceConfigDir} -> ${targetConfigDir}`,
        });
    }
    // Home dir mapping — cross-platform or same-platform different user
    if (!samePlatformFamily(sourcePlatform, targetPlatform)) {
        const sourceHome = getHomePath(sourcePlatform, sourceUser);
        const targetHome = getHomePath(targetPlatform, targetUser);
        if (sourceHome !== targetHome) {
            mappings.push({
                from: sourceHome,
                to: targetHome,
                description: `Home dir: ${sourceHome} -> ${targetHome}`,
            });
        }
    }
    else if (sourceUser !== targetUser) {
        // Same platform family, different user
        const sourceHome = getHomePath(sourcePlatform, sourceUser);
        const targetHome = getHomePath(targetPlatform, targetUser);
        if (sourceHome !== targetHome) {
            mappings.push({
                from: sourceHome,
                to: targetHome,
                description: `User home: ${sourceHome} -> ${targetHome}`,
            });
        }
    }
    // The ENCODED project-folder name appears INSIDE paths that are otherwise
    // correctly mapped — `<configDir>/projects/<encoded>/…` and
    // `/tmp/claude-*/<encoded>/…` — so without this a rewritten stdout line comes
    // out half target and half source, naming nothing on either machine (#127).
    // Encoding forward is well defined; this module only refuses to DECODE.
    //
    // A prefix collision between two encoded names (`-home-dev-repos-tzun` inside
    // `-home-dev-repos-tzun-sdk`) is already handled by `rewriteString`'s
    // boundary lookahead, which requires the next character to be a separator or
    // a token terminator — and `-` is neither. Do not add a second guard here.
    if (sourceProjectPath !== targetProjectPath) {
        const encodedFrom = encodeProjectPath(sourceProjectPath);
        const encodedTo = encodeProjectPath(targetProjectPath);
        if (encodedFrom !== encodedTo) {
            mappings.push({
                from: encodedFrom,
                to: encodedTo,
                description: `Encoded project dir: ${encodedFrom} -> ${encodedTo}`,
            });
        }
    }
    // Sort longest-from first to prevent prefix collisions
    mappings.sort((a, b) => b.from.length - a.from.length);
    return mappings;
}
/**
 * THE construction site for "rewrite this bundle's content for this machine".
 *
 * Every consumer of a bundle — importer.ts's session/subagent rewrite and
 * hub/pull.ts's continuation splice — must derive its context here rather
 * than re-deriving the mapping list locally. Two copies of this would drift,
 * and the ordering constraint they'd drift on is silent: buildPathMappings
 * sorts longest-`from`-first so a project path nested under the config dir
 * (or under the home dir) wins over its own prefix. A second construction
 * site that merely *looked* equivalent would rewrite the same entry
 * differently, and the difference only shows up on someone's real paths.
 *
 * `sourceUser` is recovered from the source PROJECT path (not the config
 * dir): a project under `/home/<user>/...` or `C:\Users\<user>\...` names the
 * user directly, and "unknown" is the honest fallback for a project that
 * lives outside any home directory — it only feeds the home-dir mapping,
 * which is skipped when source and target homes come out equal anyway.
 */
export function buildImportRewriteContext(source, targetProjectPath, targetConfigDir, 
/**
 * source session id -> the session its content lands in, when the caller
 * can name the whole set (#127) — from `buildSessionIdMap`. Omit it and
 * every session reference is left byte-identical, which is the correct
 * answer for a caller that cannot.
 */
sessionIdMap) {
    const targetPlatform = detectPlatform();
    const sourceUser = extractUserFromPath(source.sourceProjectPath, source.sourcePlatform) ?? "unknown";
    const targetUser = getCurrentUser();
    return {
        mappings: buildPathMappings(source.sourcePlatform, targetPlatform, source.sourceProjectPath, targetProjectPath, source.sourceConfigDir, targetConfigDir, sourceUser, targetUser),
        sourcePlatform: source.sourcePlatform,
        targetPlatform,
        sourceUser,
        targetUser,
        ...(sessionIdMap !== undefined ? { sessionIdMap } : {}),
        // The encoded pair is derived from the SAME two project paths the mappings
        // are, so it can never disagree with them (#127).
        ...(source.sourceProjectPath !== targetProjectPath
            ? { encodedProject: [
                    encodeProjectPath(source.sourceProjectPath),
                    encodeProjectPath(targetProjectPath),
                ] }
            : {}),
        // The directory every session this import writes lands in — the importer's
        // and the pull's `targetProjectDir`, spelled the same way (#136).
        targetProjectDir: join(targetConfigDir, "projects", encodeProjectPath(targetProjectPath)),
    };
}
/**
 * THE construction of a `RewriteContext.sessionIdMap`: which source ids a
 * bundle's sessions answer to, and the session each one's content lands in.
 *
 * A session answers to its own bundle id — and, for a CONTINUATION, also to
 * `continuation.continuesLocalSessionId` (#137). A continuation's lines are the
 * sender's lines verbatim: its bundle id is minted at export and stamped only on
 * the synthetic header, while every `session_id` the sender's run wrote and
 * every `<configDir>/projects/<encoded>/<id>/tool-results/…` pointer carries the
 * sender's LOCAL id. Keying only the bundle id — what the importer did until
 * #137, while the splice passed no map at all — maps nothing a continuation
 * actually contains.
 *
 * `landingId` is the importer's minted id, or the base session a splice or an
 * adoption writes into; the layer files land under that same id on every path,
 * which is what makes the mapped pointer resolve.
 *
 * A session's own bundle id always wins over a continuation alias for the same
 * string, in either order: the bundle's own session is a stronger fact than a
 * self-report naming a session that is not here. Among aliases, the first wins.
 * Both are only reachable with a hand-built manifest.
 */
export function buildSessionIdMap(landings) {
    const map = new Map();
    for (const [session, landingId] of landings)
        map.set(session.sessionId, landingId);
    for (const [session, landingId] of landings) {
        const alias = session.continuation?.continuesLocalSessionId;
        if (alias !== undefined && !map.has(alias))
            map.set(alias, landingId);
    }
    return map;
}
function getHomePath(platform, user) {
    if (platform === "win32")
        return `C:\\Users\\${user}`;
    if (platform === "darwin")
        return `/Users/${user}`;
    return `/home/${user}`;
}
/**
 * # Which fields get translated, and the rule that decides the NEXT one
 *
 * **A field is rewritten if its value is a LOCATION; it is left verbatim if its
 * value is CONTENT. Decide by what the value IS, never by what the key is
 * called.**
 *
 * - **LOCATION** — the value says *where* on a filesystem something is: a path
 *   in its entirety, or an invocation that names paths. Locations are
 *   translated wherever they occur, in a tool INPUT exactly as in a tool
 *   RESULT, because a bundle's whole contract is that every filesystem fact in
 *   it describes the machine you are reading it on.
 * - **CONTENT** — bytes that were, or would be, the contents of a file, or
 *   prose addressed to a person or a model. Never translated, for the reason
 *   user and assistant text is not, plus a stronger one: **a second copy of
 *   those bytes usually travels in the same bundle and is not translated** —
 *   the file in the workspace payload, and the subagent transcript whose first
 *   user message this module refuses to touch. One stale copy beats two copies
 *   that disagree.
 * - **The tie-breaker for the next field, in one question:** *does a second
 *   copy of these bytes travel in this bundle?* Yes, leave it. No, and the
 *   value is a path, translate it. Neither is clear — leave it, which is this
 *   module's stated preferred failure mode.
 *
 * The tables are an ALLOWLIST, and the default for anything unclassified is
 * LEAVE — including every field of every `mcp__*` tool, whose schemas we do not
 * own. The corpus is why a denylist would not do: `Workflow.script` is named
 * like a location and held JavaScript in 67 of 67 measured values.
 */
const TOOL_RESULT_PATH_FIELDS = [
    "persistedOutputPath",
    "transcriptDir",
    "scriptPath",
    "filePath",
    "outputFile",
    "originalFilePath",
];
/**
 * Free text that may CONTAIN a path. Note what is absent and why:
 * `originalFile` is NOT here despite the name — 78 of 637 measured values start
 * with a shebang, so it is file bytes, and file bytes are CONTENT.
 *
 * `command` is an invocation that names paths — a location, given the same
 * treatment as Bash's `input.command` (#135). TaskStop is the only tool that
 * wrote one in the measured window (159 of 159), and it echoes the background
 * task's Bash command, whose other copy is that tool INPUT, already translated:
 * leaving this one would make the two disagree.
 */
const TOOL_RESULT_TEXT_FIELDS = [
    "stdout",
    "stderr",
    "message",
    "backgroundCwdHint",
    "command",
];
/**
 * Tool INPUT fields that are locations, keyed by tool name.
 *
 * An input is a machine-readable argument object, not prose — `Read.file_path`
 * is a location in exactly the sense `toolUseResult.filePath` is, and the
 * bundle's contract says locations describe the machine you are reading them
 * on. Until #127 there was no `assistant` branch at all, so every one of these
 * survived a move and a resumed session re-read its own history as a list of
 * operations on paths that do not exist here.
 *
 * ALLOWLIST, and deliberately short. What is NOT here, and why, so the next
 * reader does not re-litigate it:
 *
 * - `Write.content`, `Edit.old_string` / `new_string` — file bytes. CONTENT.
 * - `Workflow.script` — named like a location, held JavaScript in 67 of 67
 *   measured values. The reason the table is an allowlist rather than a
 *   denylist on key names.
 * - `Agent.prompt` — 387 of 439 measured prompts are byte-identical to the
 *   first user message of a subagent transcript that travels in the SAME
 *   bundle and is left verbatim by rule. Rewriting it would manufacture two
 *   copies of one text, inside one bundle, that disagree — and the cause would
 *   be us, not drift.
 * - `Grep.pattern`, every `description` — prose or a regex.
 * - Every field of every `mcp__*` tool — schemas we do not own.
 */
const TOOL_INPUT_PATH_FIELDS = {
    Read: ["file_path"],
    Write: ["file_path"],
    Edit: ["file_path"],
    NotebookEdit: ["notebook_path"],
    Glob: ["path"],
    Grep: ["path"],
    Workflow: ["scriptPath"],
    // #135. Both name files under the session's scratchpad, which no bundle
    // carries — so this buys agreement with the already-translated
    // `scratchpadDirectory`, not a working pointer. `SendUserFile.files` is an
    // array of paths, the one listed field that is not a string.
    Artifact: ["file_path", "root"],
    SendUserFile: ["files"],
};
/** Whole-path fields on an `attachment`'s environment snapshot. */
const ATTACHMENT_PATH_FIELDS = [
    "workingDirectory",
    "scratchpadDirectory",
];
/**
 * A file-history backup record's own paths.
 *
 * **The KEY and its VALUE are the same fact.** Before #127 only the key was
 * rewritten, so one object named the target machine in its key and the source
 * machine in `realParentDir` — and `realParentDir` is the field a `/rewind`
 * restore consults to re-create the parent directory. That makes this the
 * highest WRITE-side risk in the set. Do not re-split them.
 */
function rewriteBackupValue(value, ctx) {
    if (!value || typeof value !== "object")
        return value;
    const b = { ...value };
    if (typeof b.realParentDir === "string")
        b.realParentDir = rewritePathValue(b.realParentDir, ctx);
    return b;
}
/** Map every string element of an array of paths; leave anything else as it is. */
function rewritePathArray(value, ctx) {
    return Array.isArray(value)
        ? value.map((v) => (typeof v === "string" ? rewritePathValue(v, ctx) : v))
        : value;
}
/** Rewrite the LOCATION fields of one tool-use input, per `TOOL_INPUT_PATH_FIELDS`. */
function rewriteToolInput(toolName, input, ctx) {
    const out = { ...input };
    for (const field of TOOL_INPUT_PATH_FIELDS[toolName] ?? []) {
        if (typeof out[field] === "string")
            out[field] = rewritePathValue(out[field], ctx);
        else if (Array.isArray(out[field]))
            out[field] = rewritePathArray(out[field], ctx);
    }
    // `command` is free text that NAMES paths — a location by the rule above, not
    // prose. Bash and Monitor are the two tools that carry one.
    if ((toolName === "Bash" || toolName === "Monitor") && typeof out.command === "string") {
        out.command = rewriteString(out.command, ctx);
    }
    return out;
}
/**
 * Which shape of the wire equation a stored `wire.command` had BEFORE any
 * rewriting — the only thing the re-derivation needs from it.
 *
 * `plain` when the wire form equalled the input verbatim, `cd` when it was the
 * `cd <cwd> && <input>` form, `none` when neither held. `none` is not a
 * failure: Claude Code's own check already fails for those, so it is already
 * ignoring the wire form, and reproducing that is correct.
 */
function wireEquationShape(wireCommand, originalInputCommand, originalCwd) {
    if (wireCommand === originalInputCommand)
        return "plain";
    if (originalCwd !== undefined && wireCommand === `cd ${originalCwd} && ${originalInputCommand}`) {
        return "cd";
    }
    return "none";
}
export function rewriteEntry(entry, ctx, newSessionId) {
    const result = structuredClone(entry);
    // Rewrite sessionId
    if (newSessionId) {
        result.sessionId = newSessionId;
    }
    // `sessionId` (camel) is WHICH FILE this entry is in — 205,376 of 205,376
    // measured entries equal their transcript's filename stem, across every entry
    // type — so the unconditional restamp above is right for it.
    //
    // `session_id` (snake) is WHO WROTE IT: the id of the RUN that authored the
    // entry, preserved verbatim when the entry is carried into a different file
    // (compaction, a fork, a resume — and, on a machine that uses this plugin,
    // our own imports). So it is MAPPED when the referent travels in this bundle
    // and left BYTE-IDENTICAL when it does not. Never assigned: measured, ~24% of
    // `session_id` lines do not name their own transcript, so stamping the new id
    // over them fabricates authorship. Same rule as `manifest.ts`'s
    // `isAgentTranscript` — do not write a field into a schema we do not own.
    //
    // `sessionId` is the file; `session_id` is the process. Never harmonize them.
    // `bridgeSessionId` is a cloud namespace and `sessionKind` is a kind; neither
    // is ever mapped.
    if (typeof result.session_id === "string") {
        result.session_id = ctx.sessionIdMap?.get(result.session_id) ?? result.session_id;
    }
    // A real session->session edge, and Claude Code dereferences it: it hides the
    // PARENT from the resume list only when `<same dir>/<continuedInSessionId>.jsonl`
    // exists with real content. After an import the pointer names the source
    // machine's id, that file does not exist, and the imported parent is offered
    // for resume beside its own continuation. Fail-open — mapping closes it when
    // both ends travel together.
    if (typeof result.continuedInSessionId === "string") {
        result.continuedInSessionId =
            ctx.sessionIdMap?.get(result.continuedInSessionId) ?? result.continuedInSessionId;
    }
    // Rewrite cwd (always) — whole-path field, not free text.
    if (typeof result.cwd === "string") {
        result.cwd = rewriteWholePath(result.cwd, ctx);
    }
    // Rewrite tool_result content and toolUseResult for user entries
    if (result.type === "user" && result.message) {
        const msg = result.message;
        if (Array.isArray(msg.content)) {
            msg.content = msg.content.map((item) => {
                if (item.type === "tool_result" && typeof item.content === "string") {
                    return { ...item, content: rewriteString(item.content, ctx) };
                }
                if (item.type === "tool_result" && Array.isArray(item.content)) {
                    return {
                        ...item,
                        content: item.content.map((block) => block?.type === "text" && typeof block.text === "string"
                            ? { ...block, text: rewriteString(block.text, ctx) }
                            : block),
                    };
                }
                return item;
            });
        }
        // Do NOT rewrite plain string user message content
        /**
         * `serverClassifierContext` (#135) — on two-thirds of tool-result entries
         * written since 2.1.278, and read BACK by Claude Code: it becomes the
         * `priorTurnContext` of an auto-mode server-classifier request, telling the
         * classifier where earlier tool calls ran. Three whole paths; `git_state.root`
         * is `null` outside a repository and stays `null`.
         *
         * Translated, not deleted — deleting it is what Claude Code's own resume
         * sanitizer does on the subagent and teammate paths, and whether a moved
         * session should do the same is an owner decision #135 leaves open.
         * `context.platform` sits beside the paths and is not one, so a
         * cross-family move leaves this object naming the source platform.
         *
         * `rewritePathValue`, not the top-level `cwd`'s `rewriteWholePath`, and the
         * two differ only for a directory whose interior carries the encoded project
         * name or a renamed session id — a session sitting in its own scratchpad.
         * `live_cwd` records where a tool call ran — the same kind of fact as
         * `wireIngestContext[id].cwd` and an attachment's
         * `snapshot.workingDirectory`, which #127 maps with `rewritePathValue` — so
         * it agrees with those copies rather than with `cwd`. Nothing reads it
         * against the entry's `cwd`: Claude Code forwards it to the classifier as
         * data (2.1.285). `relocatedCwd` is the opposite case and takes `cwd`'s
         * function, because the loader substitutes it FOR `cwd`.
         */
        const scc = result.serverClassifierContext
            ?.context;
        if (scc && typeof scc === "object") {
            if (typeof scc.live_cwd === "string")
                scc.live_cwd = rewritePathValue(scc.live_cwd, ctx);
            const gs = scc.git_state;
            if (gs && typeof gs === "object") {
                for (const k of ["cwd", "root"]) {
                    if (typeof gs[k] === "string")
                        gs[k] = rewritePathValue(gs[k], ctx);
                }
            }
        }
        // `toolUseResult` is a RESULT — the machine telling us where things are —
        // so every location in it is translated. Until #127 only `stdout`/`stderr`
        // were, which left the pointers stale while the bytes they point at were
        // carried and renamed: `persistedOutputPath` names a file in the
        // `tool-results` layer that this very import renames to a new session id.
        if (typeof result.toolUseResult === "string") {
            // It is a plain string on a measured 557 lines. The old shape check read
            // `tr.stdout` off a string, got `undefined`, and skipped the whole value
            // in silence.
            result.toolUseResult = rewriteString(result.toolUseResult, ctx);
        }
        else if (result.toolUseResult) {
            const tr = result.toolUseResult;
            // Whole-path fields. `rewritePathValue`, not `rewriteWholePath`: several
            // of these embed the encoded project name and the session id mid-path.
            for (const k of TOOL_RESULT_PATH_FIELDS) {
                if (typeof tr[k] === "string")
                    tr[k] = rewritePathValue(tr[k], ctx);
            }
            // Free text that may CONTAIN paths.
            for (const k of TOOL_RESULT_TEXT_FIELDS) {
                if (typeof tr[k] === "string")
                    tr[k] = rewriteString(tr[k], ctx);
            }
            const file = tr.file;
            if (file && typeof file.filePath === "string") {
                file.filePath = rewritePathValue(file.filePath, ctx);
            }
            // A Read of a PDF: the directory its page images were extracted into,
            // which sits inside the `tool-results` layer this import renames (#135).
            if (file && typeof file.outputDir === "string") {
                file.outputDir = rewritePathValue(file.outputDir, ctx);
            }
            // SendUserFile's result: each file it sent (#135).
            if (Array.isArray(tr.attachments)) {
                tr.attachments = tr.attachments.map((a) => a && typeof a.path === "string" ? { ...a, path: rewritePathValue(a.path, ctx) } : a);
            }
            // Artifact's `path` (#135), keyed on the result's SHAPE and deliberately
            // NOT added to TOOL_RESULT_PATH_FIELDS. Claude Code's memory-store read
            // tool also returns a top-level `path`, and that one names a document
            // inside a store, not a place on any filesystem. Artifact has TWO result
            // shapes and both carry the tool's resolved `file_path` there: a publish
            // (`artifact_id`) and a create-from-type (`created_from_type: true`, no
            // `artifact_id`). The store's result carries neither marker (all three
            // read from the 2.1.283-2.1.285 bundles).
            if (typeof tr.path === "string" &&
                (typeof tr.artifact_id === "string" || tr.created_from_type === true)) {
                tr.path = rewritePathValue(tr.path, ctx);
            }
            for (const k of ["changedFiles", "filenames"]) {
                const arr = tr.bashEditDiff?.[k] ?? tr[k];
                if (Array.isArray(arr)) {
                    const out = arr.map((v) => (typeof v === "string" ? rewritePathValue(v, ctx) : v));
                    if (tr.bashEditDiff && tr.bashEditDiff[k]) {
                        tr.bashEditDiff[k] = out;
                    }
                    else if (tr[k]) {
                        tr[k] = out;
                    }
                }
            }
            const bed = tr.bashEditDiff;
            if (bed && Array.isArray(bed.files)) {
                bed.files = bed.files.map((f) => f && typeof f.filePath === "string" ? { ...f, filePath: rewritePathValue(f.filePath, ctx) } : f);
            }
            if (Array.isArray(tr.content)) {
                tr.content = tr.content.map((b) => b?.type === "text" && typeof b.text === "string"
                    ? { ...b, text: rewriteString(b.text, ctx) }
                    : b);
            }
            else if (typeof tr.content === "string") {
                tr.content = rewriteString(tr.content, ctx);
            }
        }
    }
    /**
     * The `assistant` branch. There was none until #127, which is the structural
     * reason every tool INPUT in every transcript survived a move untouched.
     */
    if (result.type === "assistant" && result.message) {
        const msg = result.message;
        // Snapshot what the equation's right-hand side looked like BEFORE anything
        // moved. The wire form can only be re-derived by knowing which of the two
        // shapes it originally had, and both comparands are about to change.
        const originalCommand = new Map();
        if (Array.isArray(msg.content)) {
            for (const b of msg.content) {
                if (b?.type === "tool_use" && typeof b.id === "string") {
                    const inp = b.input;
                    if (inp && typeof inp.command === "string")
                        originalCommand.set(b.id, inp.command);
                }
            }
            msg.content = msg.content.map((block) => {
                if (block?.type !== "tool_use" || !block.input || typeof block.name !== "string")
                    return block;
                return { ...block, input: rewriteToolInput(block.name, block.input, ctx) };
            });
        }
        /**
         * THE WIRE TRIPLE, and it moves as one.
         *
         * Claude Code re-checks `wire.command === "cd " + wic.cwd + " && " +
         * input.command` (or `=== input.command`) on resume and on every API
         * message build, and USES the wire form when it passes. Rewriting one leg
         * is the only outcome strictly worse than doing nothing: the check fails
         * silently, the wire form is discarded, and nothing on our side says so.
         *
         * So `command` is RE-DERIVED from the already-rewritten parts rather than
         * rewritten in place. `rewriteString` is not a homomorphism over
         * concatenation — its guard-character lookbehind and URL back-scan are
         * context-sensitive — so rewriting a prefix and a suffix independently is
         * not guaranteed to reproduce the rewrite of their concatenation, and a
         * one-character disagreement voids the wire form.
         *
         * When the relation did not hold BEFORE the rewrite, the wire value is left
         * alone. That is not a gap: Claude Code's own check already fails for those
         * (measured: 2 of 1,825, both unicode-escape normalizations), so it is
         * already falling back to the stored input and reproducing the failure
         * changes nothing.
         */
        const wic = result.wireIngestContext;
        const originalWic = {};
        if (wic && typeof wic === "object") {
            for (const [id, v] of Object.entries(wic)) {
                // Measured 631/631: the ONLY subkey is `cwd`, always a string — and 1
                // of them is a strict subdirectory of the entry's own cwd, which is why
                // it is mapped like a path rather than stamped with `result.cwd`.
                if (v && typeof v.cwd === "string") {
                    originalWic[id] = v.cwd;
                    v.cwd = rewritePathValue(v.cwd, ctx);
                }
            }
        }
        const wti = result.wireToolInputs;
        if (wti && typeof wti === "object" && Array.isArray(msg.content)) {
            const byId = new Map();
            for (const b of msg.content) {
                if (b?.type === "tool_use" && typeof b.id === "string")
                    byId.set(b.id, b);
            }
            for (const [id, wire] of Object.entries(wti)) {
                if (!wire || typeof wire !== "object")
                    continue;
                const block = byId.get(id);
                const name = typeof block?.name === "string" ? block.name : undefined;
                const input = block?.input;
                const beforeCmd = typeof wire.command === "string" ? wire.command : undefined;
                if (name) {
                    const rewritten = rewriteToolInput(name, wire, ctx);
                    for (const k of Object.keys(rewritten)) {
                        if (k !== "command")
                            wire[k] = rewritten[k];
                    }
                }
                const origCmd = originalCommand.get(id);
                if (beforeCmd !== undefined && origCmd !== undefined && input && typeof input.command === "string") {
                    const origCwd = originalWic[id];
                    const newCwd = wic?.[id]?.cwd ?? origCwd;
                    const shape = wireEquationShape(beforeCmd, origCmd, origCwd);
                    if (shape === "plain") {
                        wire.command = input.command;
                    }
                    else if (shape === "cd" && newCwd !== undefined) {
                        wire.command = `cd ${newCwd} && ${input.command}`;
                    }
                    // `none`: the relation did not hold before the rewrite either, so
                    // Claude Code is already ignoring this wire form. Leave it untouched
                    // rather than manufacture an agreement that was never there.
                }
            }
        }
    }
    /**
     * `attachment` — the most common entry type in a modern transcript (about a
     * third of all lines, and roughly half of all CONVERSATION entries), and
     * until #127 it had no branch at all.
     *
     * The one that matters most is a SECOND, PARALLEL cwd:
     * `attachment.snapshot.workingDirectory`, plus the pre-rendered
     * system-reminder text that quotes it. The top-level `cwd` above was being
     * rewritten correctly while these were not — so a resumed session was told,
     * in the context the model actually reads, that it sits in a directory that
     * does not exist on this machine.
     */
    if (result.type === "attachment" && result.attachment) {
        const att = result.attachment;
        const snap = att.snapshot;
        if (snap) {
            for (const k of ATTACHMENT_PATH_FIELDS) {
                if (typeof snap[k] === "string")
                    snap[k] = rewritePathValue(snap[k], ctx);
            }
            if (Array.isArray(snap.additionalWorkingDirectories)) {
                snap.additionalWorkingDirectories = snap.additionalWorkingDirectories.map((d) => (typeof d === "string" ? rewritePathValue(d, ctx) : d));
            }
        }
        // cwd-change deltas: `field` is "workingDirectory" on virtually every one.
        if (Array.isArray(att.changes)) {
            att.changes = att.changes.map((c) => {
                if (!c)
                    return c;
                const out = { ...c };
                for (const k of ["from", "to"]) {
                    if (typeof out[k] === "string")
                        out[k] = rewritePathValue(out[k], ctx);
                }
                return out;
            });
        }
        for (const k of ["filename", "path"]) {
            if (typeof att[k] === "string")
                att[k] = rewritePathValue(att[k], ctx);
        }
        if (Array.isArray(att.files)) {
            att.files = att.files.map((f) => f && typeof f.path === "string" ? { ...f, path: rewritePathValue(f.path, ctx) } : f);
        }
        const attFile = att.content?.file;
        if (attFile && typeof attFile.filePath === "string") {
            attFile.filePath = rewritePathValue(attFile.filePath, ctx);
        }
        // Free text that may contain paths. `systemPrompt` is deliberately absent:
        // it is prose addressed to a model, i.e. CONTENT.
        for (const k of ["stdout", "stderr", "command", "text", "banner"]) {
            if (typeof att[k] === "string")
                att[k] = rewriteString(att[k], ctx);
        }
        if (typeof att.content === "string")
            att.content = rewriteString(att.content, ctx);
        // #135. `nested_memory`'s `content` is an OBJECT, `{path, type, content}`:
        // its `path` is the same location as `att.path` above, which was rewritten
        // while this was not, and its own `content` is the memory file's bytes —
        // CONTENT, left verbatim.
        const attContent = att.content;
        if (attContent && typeof attContent === "object" && typeof attContent.path === "string") {
            attContent.path = rewritePathValue(attContent.path, ctx);
        }
        // `task_status`: where the background task writes its output, and the
        // invocation it is running — free text, as Bash's `input.command` is.
        if (typeof att.outputFilePath === "string") {
            att.outputFilePath = rewritePathValue(att.outputFilePath, ctx);
        }
        const shell = att.shell;
        if (shell && typeof shell === "object" && typeof shell.command === "string") {
            shell.command = rewriteString(shell.command, ctx);
        }
        // `instructions`: the instruction files no longer loaded, beside the
        // already-translated `files[].path` Claude Code diffs them against. Gated on
        // the type because `removed` is a generic name and other payloads use it
        // for lists that are not paths.
        if (att.type === "instructions" && Array.isArray(att.removed)) {
            att.removed = rewritePathArray(att.removed, ctx);
        }
        // The pre-rendered reminder the model actually sees on resume.
        for (const k of ["rendered", "renderedInHumanTurn"]) {
            if (Array.isArray(result[k])) {
                result[k] = result[k].map((b) => b && typeof b.content === "string"
                    ? { ...b, content: rewriteString(b.content, ctx) }
                    : b);
            }
        }
    }
    // Rewrite file-history-snapshot trackedFileBackups keys AND values
    if (result.type === "file-history-snapshot" && result.snapshot) {
        const snapshot = result.snapshot;
        if (snapshot.trackedFileBackups) {
            const backups = snapshot.trackedFileBackups;
            const newBackups = {};
            for (const [key, value] of Object.entries(backups)) {
                const newKey = rewritePathValue(key, ctx);
                newBackups[newKey] = rewriteBackupValue(value, ctx);
            }
            snapshot.trackedFileBackups = newBackups;
        }
    }
    /**
     * `file-history-delta` — a whole entry type with no branch until #127,
     * carrying two absolute paths of its own.
     */
    if (result.type === "file-history-delta") {
        if (typeof result.trackingPath === "string") {
            result.trackingPath = rewritePathValue(result.trackingPath, ctx);
        }
        result.backup = rewriteBackupValue(result.backup, ctx);
    }
    /**
     * `relocated` (#135) — appended when EnterWorktree, ExitWorktree or a
     * directory move changes the session's directory. Claude Code's loader takes
     * `relocatedCwd ?? <head cwd>` as the session's project path and matches it
     * against the directory a resume runs in, so it is translated by exactly the
     * function the top-level `cwd` is: two spellings of one directory would make
     * the loader disagree with itself.
     */
    if (result.type === "relocated" && typeof result.relocatedCwd === "string") {
        result.relocatedCwd = rewriteWholePath(result.relocatedCwd, ctx);
    }
    /**
     * `frame-link` (#135) — an entry with no uuid, pointing at an Artifact's file
     * under the session scratchpad; Claude Code reads its `path` for the label.
     *
     * `worktree-state` is deliberately still absent. Its `worktreeSession` holds
     * three paths, but also a `sessionId` whose meaning — the file, or the run —
     * is not established, and #135's corpus held no such entry to measure.
     * Unclear means leave.
     */
    if (result.type === "frame-link" && typeof result.path === "string") {
        result.path = rewritePathValue(result.path, ctx);
    }
    return result;
}
// The single per-line transform both the string API (rewriteJsonl) and the
// streaming API (rewriteJsonlStream) are built on: parse once, apply version
// adapters, rewrite, stringify. Replaces the importer's old double-parse
// (adapter pass + rewrite pass).
export function transformLine(line, ctx, opts = {}) {
    let entry;
    try {
        entry = JSON.parse(line);
    }
    catch (e) {
        return {
            line,
            changed: false,
            fieldsChanged: 0,
            adaptationsApplied: [],
            parseFailed: true,
            parseError: errorMessage(e),
        };
    }
    let adaptationsApplied = [];
    if (opts.adapters && opts.adapters.length > 0) {
        const { entry: adapted, applied } = applyAdapters(entry, opts.adapters);
        entry = adapted;
        adaptationsApplied = applied;
    }
    const original = JSON.stringify(entry);
    const rewritten = rewriteEntry(entry, ctx, opts.newSessionId);
    const rewrittenStr = JSON.stringify(rewritten);
    let fieldsChanged = 0;
    if (rewrittenStr !== original) {
        for (const key of Object.keys(entry)) {
            if (JSON.stringify(entry[key]) !==
                JSON.stringify(rewritten[key])) {
                fieldsChanged++;
            }
        }
    }
    return {
        line: rewrittenStr,
        changed: rewrittenStr !== original,
        fieldsChanged,
        adaptationsApplied,
        parseFailed: false,
    };
}
export function rewriteJsonl(jsonlContent, ctx, newSessionId) {
    const lines = jsonlContent.trim().split("\n").filter(Boolean);
    let entriesRewritten = 0;
    let fieldsRewritten = 0;
    const warnings = [];
    const rewrittenLines = lines.map((line) => {
        const r = transformLine(line, ctx, { newSessionId });
        if (r.parseFailed) {
            warnings.push(`Failed to parse JSONL line: ${r.parseError}`);
            return line; // preserve unparseable lines
        }
        if (r.changed) {
            entriesRewritten++;
            fieldsRewritten += r.fieldsChanged;
        }
        return r.line;
    });
    return {
        rewritten: rewrittenLines.join("\n") + "\n",
        report: { mappings: ctx.mappings, entriesRewritten, fieldsRewritten, warnings },
    };
}
// Streaming twin of rewriteJsonl: O(longest line) memory instead of O(file).
// outputPath null = report-only (dry-run preview): full transform + report,
// nothing written. Backpressure honored (awaits drain). Unparseable lines are
// passed through verbatim with a warning, mirroring rewriteJsonl; import-level
// strictness on parse failures is the CALLER's job (see importer.ts).
export async function rewriteJsonlStream(inputPath, outputPath, ctx, opts = {}) {
    const bytesTotal = statSync(inputPath).size;
    let bytesProcessed = 0;
    let entriesRewritten = 0;
    let fieldsRewritten = 0;
    let parseFailures = 0;
    const warnings = [];
    const adaptationsApplied = [];
    const hash = opts.computeHash && outputPath ? createHash("sha256") : null;
    const input = createReadStream(inputPath, { encoding: "utf-8" });
    const rl = createInterface({ input, crlfDelay: Infinity });
    // The output sits on the write-side error latch (latched-write.ts holds
    // the three guards it exists for, once). Its two await points below are
    // where a write failure surfaces; the destroy() in the catch is for OUR
    // failures — a read error, a thrown transform — which the stream would
    // otherwise never learn about.
    const out = outputPath
        ? latchedWriteStream(createWriteStream(outputPath, { encoding: "utf-8" }))
        : null;
    try {
        for await (const line of rl) {
            // readline strips the terminator; count it back for progress (LF assumed).
            bytesProcessed += Buffer.byteLength(line, "utf8") + 1;
            if (!line)
                continue; // mirror rewriteJsonl's filter(Boolean)
            const r = transformLine(line, ctx, {
                adapters: opts.adapters,
                newSessionId: opts.newSessionId,
            });
            let outLine;
            if (r.parseFailed) {
                parseFailures++;
                warnings.push(`Failed to parse JSONL line: ${r.parseError}`);
                outLine = line; // preserve unparseable lines
            }
            else {
                if (r.changed) {
                    entriesRewritten++;
                    fieldsRewritten += r.fieldsChanged;
                }
                adaptationsApplied.push(...r.adaptationsApplied);
                outLine = r.line;
            }
            const chunk = outLine + "\n";
            hash?.update(chunk);
            if (out && !out.write(chunk))
                await out.drain();
            opts.onProgress?.(Math.min(bytesProcessed, bytesTotal), bytesTotal);
        }
        if (out)
            await out.finish();
    }
    catch (e) {
        out?.destroy();
        throw e;
    }
    finally {
        rl.close();
        input.destroy();
    }
    return {
        mappings: ctx.mappings,
        entriesRewritten,
        fieldsRewritten,
        warnings,
        adaptationsApplied,
        parseFailures,
        outputHash: hash ? `sha256:${hash.digest("hex")}` : undefined,
    };
}
//# sourceMappingURL=rewriter.js.map