import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isNeverIncludable, snapshotWorkspace, } from "./workspace.js";
import { captureCarry, gitChildEnv } from "./carry.js";
import { includeFilePath } from "../paths.js";
/**
 * THE FILE PAYLOAD — one decision, one disclosure, two transports.
 *
 * `hub push` and `sesh-mover export` are the same operation with different
 * transports (#47), and the part they must not duplicate is not the two leaf
 * calls — `snapshotWorkspace` and `captureCarry` are one line each. It is the
 * DECISION between them and the disclosure that goes with it:
 *
 *  1. one git-remote scan per operation;
 *  2. the `unknown` arm building **neither** payload and saying why;
 *  3. the snapshot only on `kind: "none"`;
 *  4. the carry only on `kind: "remotes"`, contained so no git failure can cost
 *     the sessions that are the point of the operation;
 *  5. `reIncluded` / `trackedIgnored` / `inProgress` / a non-capture turned into
 *     prose a user can act on.
 *
 * Item 2 is a SECURITY behaviour and is the reason this module exists rather
 * than a second copy of the block living in `exporter.ts`: reading "I could not
 * ask git" as "there is no remote" takes the whole-tree snapshot — which does
 * not read `.gitignore` — on a git project, and ships its `.env`. Only
 * `kind: "none"` may take that path. See `GitRemoteScan`.
 *
 * What it deliberately does NOT own:
 *
 * - `workspace.basedOn`. A workspace generation is a hub concept identified by
 *   a hub bundle id (see `ExportManifest.workspace.basedOn`), so `hub/push.ts`
 *   stamps it and an export must not mint one.
 * - Where the fields land. `push` patches its staged manifest in place because
 *   that manifest was written before the hub link existed; `exporter.ts` sets
 *   the same two fields in its manifest literal before the single
 *   `writeManifest` call, so it needs no patch and no restamp. Doing what push
 *   does there would import a workaround for a constraint export does not have.
 * - The git scan itself. It arrives as a value so this module has no opinion
 *   about caching it, and so `src/payload/` keeps one direction of dependency.
 */
/** Cap on `ignoredNotCarried`: a sample the user can recognize, not an inventory. */
const MAX_IGNORED_REPORTED = 10;
/**
 * Top-level gitignored paths, as `git` spells them — `docs/` for a wholly
 * ignored directory, `src/generated.ts` for a single ignored file inside a
 * carried one. Each is a valid `.sesh-mover-include` pattern for exactly that thing.
 *
 * `-z` is not a nicety: without it git applies `core.quotePath`, so a name with
 * a space, a quote, a newline or any non-ASCII character comes back C-quoted
 * and octal-escaped, and a newline in a filename would split one entry into
 * two. This list is shown to a user and offered as a pattern to paste, so it
 * has to be the real bytes.
 *
 * Every failure — no git, not a repo, timeout, output past `maxBuffer` — is the
 * same answer: no discovery aid this time. It is a hint, never a gate.
 */
export function listTopLevelIgnored(projectPath) {
    try {
        const out = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
            cwd: projectPath, encoding: "utf-8", timeout: 5000,
            // Not the inherited environment (see `gitChildEnv`): these paths are
            // offered to the user as `.sesh-mover-include` lines to paste, so they have to
            // come from the project's own repository and its own ignore rules.
            env: gitChildEnv(),
            stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024,
        });
        const paths = new Set();
        for (const entry of out.split("\0")) {
            // No trimming: with -z the bytes between separators ARE the path, and a
            // name may legitimately begin or end with a space.
            if (!entry)
                continue;
            if (isNeverIncludable(entry))
                continue; // can never be carried, so never suggest it
            paths.add(entry);
            if (paths.size >= MAX_IGNORED_REPORTED)
                break;
        }
        return [...paths];
    }
    catch {
        return [];
    }
}
/**
 * Build the file payload for one bundle, or explain why there is none.
 *
 * Never throws for a reason that belongs to the payload: a git repository in an
 * arbitrary state is unbounded (mid-rebase, submodules, 200k untracked files, a
 * filesystem that refuses a read), and the sessions are the primary artifact on
 * both transports. Every such failure comes back as a warning and an absent
 * payload.
 */
export async function capturePayload(opts) {
    const warnings = [];
    const { projectPath, destDir, scan, scope } = opts;
    const projectExists = existsSync(projectPath);
    const noun = scope === "export" ? "export" : "push";
    // Neither payload is built when git could not be asked about this project's
    // remotes (see `GitRemoteScan`). The workspace snapshot copies the whole
    // project directory WITHOUT reading .gitignore, so taking that path on a
    // repository whose remotes are merely unknown discloses secrets a git project
    // never intended to publish — and on the hub this may be the unattended
    // SessionEnd push. The carry needs a working `git` by definition. Say so
    // instead, in the shape the declined-carry warning already uses: no remedy is
    // named that this invocation has already foreclosed.
    if (scan.kind === "unknown" && (opts.wantWorkspace || opts.wantCarry) && projectExists) {
        warnings.push(`No project files or uncommitted work were included in this ${noun}: ${scan.detail}, so whether this project has a git remote could not be established. A full copy of the working tree is only safe for a project that genuinely has none — it does not read .gitignore — and the git-diff carry needs a working \`git\` of its own. The sessions travelled normally; once git can answer here, the files travel with the next ${noun}.`);
        return { decision: "unknown", warnings };
    }
    // Workspace payload — projects with no git remotes (including remote-less git
    // repositories), since there's no remote to reconstruct the working tree from
    // otherwise.
    if (opts.wantWorkspace && scan.kind === "none" && projectExists) {
        const ws = await snapshotWorkspace(projectPath, join(destDir, "workspace"), {
            maxBytes: opts.workspaceMaxBytes,
            measureOnly: opts.measureOnly,
            scope,
        });
        if (ws.symlinksSkipped > 0) {
            warnings.push(`${ws.symlinksSkipped} symlink(s) skipped in workspace snapshot.`);
        }
        // Rule-level diagnostics (an include list past a cap, an exclude set that
        // swallowed the whole tree, a payload over the snapshot budget). Every one
        // of them fails CLOSED — fewer files — which is invisible from the outside
        // without this.
        warnings.push(...ws.warnings);
        // `skipped` = over the snapshot budget, nothing copied. The sessions still
        // travel; there is simply no payload to declare and — critically, on the hub
        // — no generation to record. Recording an un-applied generation is the one
        // way this feature loses data quietly: the next merge would read the whole
        // un-sent tree as "deleted here".
        if (ws.skipped)
            return { decision: "none", warnings };
        return {
            decision: "workspace",
            workspace: {
                fileCount: ws.fileCount,
                byteSize: ws.byteSize,
                snapshotAt: new Date().toISOString(),
            },
            warnings,
        };
    }
    // Git-diff carry — the complement of the workspace snapshot: a project WITH a
    // remote reconstructs its committed state from git, so only the uncommitted
    // part has to travel. This is also the only thing that gives
    // `.sesh-mover-include` an effect on a git project.
    //
    // Gated on `kind === "remotes"`, which is `rawCount > 0` and not the
    // normalized list: a self-hosted `git@gitserver:team/repo.git` is a perfectly
    // real remote that `normalizeGitRemote` declines to canonicalize (no dot in
    // the host), and such a project must get the carry — the payload the
    // .gitignore rules apply to — rather than a whole-tree snapshot.
    if (opts.wantCarry && scan.kind === "remotes" && projectExists) {
        const diagnostics = [];
        // Contained deliberately, unlike the workspace snapshot above: this branch
        // runs `git` against a real user repository whose state is unbounded, and no
        // failure of the OPTIONAL half may cost the user the session bundle.
        const cap = await captureCarry(projectPath, join(destDir, "carry"), {
            diagnostics,
            maxBytes: opts.carryMaxBytes,
            measureOnly: opts.measureOnly,
            scope,
        }).catch((e) => ({ captured: false, reason: "git-failed", detail: e.message }));
        warnings.push(...diagnostics);
        if (cap.captured) {
            warnings.push(...describeCarryCapture(cap.meta, scope, opts.measureOnly === true));
            const ignoredNotCarried = opts.discoverIgnored
                ? discoverIgnored(projectPath)
                : undefined;
            return {
                decision: "carry",
                carry: cap.meta,
                warnings,
                ...(ignoredNotCarried ? { ignoredNotCarried } : {}),
            };
        }
        if (cap.reason !== "clean" && cap.reason !== "not-git") {
            // "clean" is the ordinary case and "not-git" cannot happen here (this
            // branch already established a git remote), so everything else is a
            // capture the user expected and did not get.
            warnings.push(`Uncommitted changes were not carried: ${cap.detail ?? cap.reason}. They will be picked up by the next ${noun} that has new session content.`);
        }
        const ignoredNotCarried = opts.discoverIgnored ? discoverIgnored(projectPath) : undefined;
        return { decision: "none", warnings, ...(ignoredNotCarried ? { ignoredNotCarried } : {}) };
    }
    return { decision: "none", warnings };
}
/**
 * Discovery aid: name what `.gitignore` kept out, so the user can opt paths
 * back in without having to know the include list exists.
 *
 * Only until an include list exists, at which point the user has met the
 * mechanism and further nagging is noise. Existence, not pattern count, is the
 * test: a file holding only comments still means "I know about this".
 */
function discoverIgnored(projectPath) {
    if (existsSync(includeFilePath(projectPath)))
        return undefined;
    const ignored = listTopLevelIgnored(projectPath);
    return ignored.length > 0 ? ignored : undefined;
}
/**
 * The two disclosures a captured carry owes the user, plus the in-progress note.
 *
 * They are NOT merged, and the separation is the point: `reIncluded` means "you
 * opted in via the include list, remove the line to stop it"; `trackedIgnored`
 * means "git tracks these gitignored files, so the patch carries their
 * uncommitted contents and no carry rule filters the patch", whose remedy is
 * `git rm --cached`. Folding the second into the first gives it a remedy that
 * does nothing.
 *
 * On an EXPORT both are louder than on a push, and the wording says why: a hub
 * bundle lands in a directory the user configured, while an export bundle is an
 * artifact that gets handed on.
 */
function describeCarryCapture(meta, scope, 
/**
 * TENSE. A measure has written nothing, so "they are in the bundle now" is
 * false there — and this is the sentence the user reads at the CONFIRM gate,
 * where a false past tense reads as "too late anyway".
 */
measured) {
    const out = [];
    // "in this bundle" on an export, because the bundle is the thing that travels
    // and its destination is not known here. "on the hub" on a push, because it
    // already is.
    const landed = scope === "export"
        ? measured
            ? "They would be in the export bundle, and would travel wherever it does"
            : "They are in this export bundle now, and they travel wherever it does"
        : "They are on the hub now";
    const carried = measured ? "Would carry" : "Carried";
    const carries = measured ? "would carry" : "carries";
    if (meta.reIncludedCount > 0) {
        const shown = meta.reIncluded.join(", ");
        const more = meta.reIncludedCount - meta.reIncluded.length;
        out.push(`${carried} ${meta.reIncludedCount} gitignored file(s) because .sesh-mover-include names them: ${shown}${more > 0 ? `, and ${more} more` : ""}. ${landed}.`);
    }
    if (meta.trackedIgnoredCount > 0) {
        const shown = meta.trackedIgnored.join(", ");
        const more = meta.trackedIgnored.length < meta.trackedIgnoredCount
            ? meta.trackedIgnoredCount - meta.trackedIgnored.length
            : 0;
        out.push(scope === "export"
            ? `The patch ${carries} changes to ${meta.trackedIgnoredCount} gitignored file(s) that git TRACKS, so .gitignore does not keep them out of this bundle: ${shown}${more > 0 ? `, and ${more} more` : ""}. A .env committed once and gitignored later is the common shape, and its current value travels in the patch in plaintext. ${landed}, so treat the bundle as carrying those secrets; untrack them (git rm --cached), or export without --include-carry, to keep the next one from carrying them.`
            : `The patch ${carries} changes to ${meta.trackedIgnoredCount} gitignored file(s) that git TRACKS, so .gitignore did not keep them off the hub: ${shown}${more > 0 ? `, and ${more} more` : ""}. ${landed} and nothing takes them off it; untrack them (git rm --cached) or push with --no-carry to keep the next push from carrying them again.`);
    }
    if (meta.inProgress) {
        out.push(measured
            ? `The uncommitted changes would be captured during an in-progress ${meta.inProgress}: the patch would record the working tree as it stands, conflict markers included, and the ${meta.inProgress} itself does not travel.`
            : `Uncommitted changes were captured during an in-progress ${meta.inProgress}: the patch records the working tree as it stands, conflict markers included, and the ${meta.inProgress} itself does not travel.`);
    }
    return out;
}
//# sourceMappingURL=capture.js.map