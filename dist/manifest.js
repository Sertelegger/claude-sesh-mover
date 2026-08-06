import { readFileSync, writeFileSync, existsSync, createReadStream, readdirSync, statSync, } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
/**
 * The single place a bundle manifest is written, and therefore the single place
 * `sessionsDigest` is stamped. Recomputed here rather than by the caller so a
 * manifest can never be written whose digest disagrees with the session list
 * sitting right beside it — including by a caller that legitimately edits the
 * list (the incremental/continuation paths) and would otherwise have to
 * remember. The input object is not mutated.
 *
 * `hub/push.ts` patches `projectId`/`workspace`/`carry` into a staged
 * manifest.json with a plain `writeFileSync` instead. That is correct and must
 * stay correct: none of those three fields is inside the digest (see
 * `computeSessionsDigest`), so those patches leave it valid.
 */
export function writeManifest(exportDir, manifest) {
    const manifestPath = join(exportDir, "manifest.json");
    const stamped = {
        ...manifest,
        sessionsDigest: computeSessionsDigest(manifest.sessions),
    };
    writeFileSync(manifestPath, JSON.stringify(stamped, null, 2) + "\n", "utf-8");
}
export function readManifest(exportDir) {
    const manifestPath = join(exportDir, "manifest.json");
    if (!existsSync(manifestPath)) {
        throw new Error(`No manifest.json found in ${exportDir}`);
    }
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);
    assertSafeManifestIds(manifest);
    return manifest;
}
// A session id is safe iff it is a non-empty string with no path separators,
// no NUL byte, and isn't "." or "..". Real Claude session ids are UUIDs, so
// this accepts them while rejecting anything path-traversal-shaped. Any value
// containing "/" or "\" already covers "../" and "..\" segments — the bare
// "."/".." checks cover the separator-less forms.
export function isSafeSessionId(id) {
    if (typeof id !== "string" || id.length === 0)
        return false;
    if (id.includes("/") || id.includes("\\") || id.includes("\0"))
        return false;
    if (id === "." || id === "..")
        return false;
    return true;
}
// Single chokepoint: every manifest read that will later be used to build a
// filesystem path (session JSONL, subagents dir, tool-results dir, etc.)
// must run through this before the manifest is trusted. Guards
// session.sessionId and both continuation-linkage ids, since all three get
// interpolated into join() calls downstream (importer.ts, sync-state.ts).
export function assertSafeManifestIds(manifest) {
    for (const s of manifest.sessions) {
        const ids = [
            s.sessionId,
            s.continuation?.continuesLocalSessionId,
            s.continuation?.continuesPeerSessionId,
        ];
        for (const id of ids) {
            if (id !== undefined && !isSafeSessionId(id)) {
                throw new Error(`Unsafe session id in manifest: ${JSON.stringify(id)} (path separators and ".." are not allowed)`);
            }
        }
    }
}
export function computeIntegrityHash(contents) {
    const hash = createHash("sha256");
    for (const content of contents) {
        hash.update(content);
    }
    return `sha256:${hash.digest("hex")}`;
}
// Streaming twin of computeIntegrityHash: sha256 over raw file bytes.
// For valid UTF-8 files (all session JSONL) this yields the same digest as
// computeIntegrityHash([readFileSync(path, "utf-8")]) — hash.update(string)
// encodes utf-8 — so manifests from pre-streaming exports keep verifying.
export async function computeIntegrityHashFromFile(path) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return `sha256:${hash.digest("hex")}`;
}
export function verifyIntegrity(contents, expectedHash) {
    const actual = computeIntegrityHash(contents);
    return actual === expectedHash;
}
/** The auxiliary layers a bundle can carry per session, each as its own directory. */
export const HASHED_LAYERS = ["subagents", "tool-results", "file-history"];
/** `HASHED_LAYERS` is a subset of `ExportLayer` — this line fails to compile if that stops holding. */
const _hashedLayersAreExportLayers = HASHED_LAYERS;
void _hashedLayersAreExportLayers;
/**
 * Aggregate digest over ONE auxiliary layer directory of a bundle
 * (`sessions/<id>/subagents`, `sessions/<id>/tool-results`,
 * `file-history/<id>`). `null` when the directory is absent — a bundle that
 * never carried that layer declares no digest for it.
 *
 * ## Why one digest per layer and not one per file
 *
 * Detection power is identical: the digest is taken over the sorted
 * `(name, sha256-of-content)` pairs plus the file count, so ANY bit flip,
 * truncation, rename, addition or removal inside the directory changes it. Only
 * *localisation* differs — an aggregate says "this session's file-history is not
 * what the exporter hashed", a per-file map says which file. Localisation buys
 * nothing here because the response is the same either way (the layer is not
 * copied; see importer.ts), and the manifest cost is not hypothetical: measured
 * on a real `~/.claude`, one session's `file-history` held 106 files, so a
 * per-file map is ~10 KB of manifest for ONE session and hundreds of KB for a
 * `--scope all` export of a busy project. Three keys per session is O(1).
 *
 * The directory listing is deliberately flat (`readdirSync`, files only): that
 * is exactly the set `copyDirIfExists` in exporter.ts copies and
 * `copyLayerDirs` in hub/pull.ts copies, so the digest can never cover a file
 * the bundle does not actually carry, or miss one it does.
 *
 * Names are hashed alongside contents. In principle a filesystem that
 * re-normalises Unicode filenames on extraction could turn that into a false
 * mismatch; in practice every name Claude Code writes here is ASCII (subagent
 * and tool-result files are uuid-named, file-history entries are
 * `<hex>@v<n>`), and the failure direction is a warning plus a skipped
 * auxiliary layer, never lost transcript data.
 */
export async function computeLayerDigest(dir) {
    if (!existsSync(dir))
        return null;
    let names;
    try {
        names = readdirSync(dir).filter((n) => {
            try {
                return statSync(join(dir, n)).isFile();
            }
            catch {
                return false;
            }
        });
    }
    catch {
        return null;
    }
    // Explicit comparator: UTF-16 code-unit order, identical on every platform,
    // never the host locale's collation (which `sort()` does not use, but which
    // a future "readable" comparator would).
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const hash = createHash("sha256");
    hash.update(`${names.length}\n`);
    for (const name of names) {
        const fileHash = await computeIntegrityHashFromFile(join(dir, name));
        hash.update(`${name}\0${fileHash}\n`);
    }
    return `sha256:${hash.digest("hex")}`;
}
/**
 * Recursively key-sorted projection of a value, so two structurally equal
 * objects serialize identically regardless of key insertion order. `undefined`
 * properties are dropped, which is what `JSON.stringify` does when the manifest
 * is written — so the digest computed over the in-memory manifest at export
 * matches the one computed over the parsed manifest at import.
 */
function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
        const src = value;
        const out = {};
        for (const key of Object.keys(src).sort()) {
            if (src[key] === undefined)
                continue;
            out[key] = canonicalize(src[key]);
        }
        return out;
    }
    return value;
}
/**
 * Bundle-level digest over the manifest's own session inventory: the count,
 * then every declared session record verbatim (session id, per-session
 * `integrityHash`, `layerDigests`, message count, continuation linkage, …).
 * Cheap by construction — it hashes hashes, never content.
 *
 * ## What it catches that the per-session hashes cannot
 *
 * A per-session `integrityHash` answers "is this file the file the exporter
 * hashed?" and is only ever consulted for a session the manifest still lists.
 * It therefore says nothing about the *inventory*: a manifest damaged so that a
 * session record is lost, or a hash edited, stays internally self-consistent and
 * every surviving check passes. This digest is the statement that the session
 * list itself is the one the exporter wrote.
 *
 * ## Its honest limits — read before relying on it
 *
 * - **It is damage detection, not attestation.** Anyone who can rewrite the
 *   session list can recompute this digest; nothing here is signed and nothing
 *   binds the bundle to a sender. A hostile hub writer is issue #37's territory
 *   and this field does not touch it.
 * - **It covers the session inventory only.** `sourceProjectPath`,
 *   `sourceConfigDir`, `workspace`, `carry` and `projectId` are outside it —
 *   deliberately, because `hub/push.ts` patches three of those into the staged
 *   `manifest.json` in place, after the exporter wrote it. Widening the digest
 *   to the whole manifest would make every hub bundle fail its own check.
 * - **It does not enumerate `memory/` or `plans/`.** Those are merged rather
 *   than restored (the importer keeps the existing file on any difference and
 *   reports a `memoryConflicts` entry), so a damaged one cannot overwrite
 *   anything the user has.
 *
 * Optional on `ExportManifest`: bundles written before this field existed carry
 * no digest, and are verified exactly as they were before rather than refused.
 */
export function computeSessionsDigest(sessions) {
    const hash = createHash("sha256");
    hash.update(`sesh-mover/sessions-digest/1\n${sessions.length}\n`);
    hash.update(JSON.stringify(canonicalize(sessions)));
    return `sha256:${hash.digest("hex")}`;
}
/**
 * `null` when the manifest declares no digest (pre-0.6.0 bundle) or the digest
 * matches; otherwise a caller-facing description of the mismatch.
 */
export function verifySessionsDigest(manifest) {
    if (!manifest.sessionsDigest)
        return null;
    const actual = computeSessionsDigest(manifest.sessions);
    if (actual === manifest.sessionsDigest)
        return null;
    return `manifest.json declares ${manifest.sessions.length} session(s) with digest ${manifest.sessionsDigest}, but its own session list hashes to ${actual}`;
}
//# sourceMappingURL=manifest.js.map