import type { ExportManifest, SessionManifest } from "./types.js";
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
export declare function writeManifest(exportDir: string, manifest: ExportManifest): void;
export declare function readManifest(exportDir: string): ExportManifest;
/**
 * Minimal structural check that a parsed `manifest.json` is a sesh-mover bundle
 * manifest at all: the plugin marker, and a `sessions` value that really is an
 * array. Deliberately NOT a schema validator — no field types, no required
 * keys beyond those two.
 *
 * ## Why those two clauses and not more
 *
 * They are the two facts a caller states about a bundle it never opened
 * further: that it is one of ours, and a `sessionCount` derived from a value
 * that really is a session list. Without the second, `sessions: "abc"` parses
 * fine, survives `assertSafeManifestIds` (iterating a string yields
 * characters, whose `.sessionId` is `undefined`, so every check passes) and
 * `browse` then reports `sessionCount: 3` — the string's length, presented as
 * a session count, in the code path whose whole point is never inventing
 * metadata. That is the case worth remembering: this predicate and
 * `assertSafeManifestIds` catch disjoint things, so neither substitutes for
 * the other.
 *
 * ## Why it lives in manifest.ts
 *
 * This module is not only the hashing module. It already owns the trust
 * boundary a parsed manifest crosses, in three steps that run in this order:
 * *is this a manifest at all* (here), *are its ids path-safe*
 * (`assertSafeManifestIds`), *is its session list the one the exporter wrote*
 * (`verifySessionsDigest`). Splitting step one into a module of its own would
 * put a five-line predicate behind its own file, its own export line and its
 * own test file, and would hide the ordering relationship between the three.
 *
 * ## One copy, on purpose
 *
 * This used to exist twice — privately in `archiver.ts` (archive path, v0.5.1)
 * and privately in `cli.ts` (directory path, #33) — and the two paths had
 * already drifted once: the store directory scan checked no plugin marker at
 * all until #33, while the archive path had checked it since v0.5.1. Both call
 * sites import this now. `tests/manifest.test.ts` fails if a second copy of
 * the comparison reappears under `src/` (see the guard's own doc comment for
 * what that check can and cannot see).
 *
 * `readManifest` deliberately does not call this: its contract is to throw,
 * and the two readers that must DEGRADE rather than throw — `browse`'s
 * directory scan and `readManifestFromArchive` — call it themselves against
 * their own parse. Folding it into `readManifest` would change what the import
 * and hub-pull paths throw, which is a larger decision than this predicate.
 *
 * Returns `boolean`, not a type predicate: narrowing to `ExportManifest` would
 * claim a validation of the other fields that this does not perform.
 */
export declare function isBundleManifestShape(value: unknown): boolean;
export declare function isSafeSessionId(id: unknown): boolean;
export declare function assertSafeManifestIds(manifest: ExportManifest): void;
export declare function computeIntegrityHash(contents: string[]): string;
export declare function computeIntegrityHashFromFile(path: string): Promise<string>;
export declare function verifyIntegrity(contents: string[], expectedHash: string): boolean;
/** The auxiliary layers a bundle can carry per session, each as its own directory. */
export declare const HASHED_LAYERS: readonly ["subagents", "tool-results", "file-history"];
export type HashedLayer = (typeof HASHED_LAYERS)[number];
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
export declare function computeLayerDigest(dir: string): Promise<string | null>;
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
 * - **It does not enumerate `memory/` or `plans/`.** Those are the two
 *   shared-namespace layers: they land in a directory the TARGET owns rather
 *   than under a session id the import just minted. Since #49 the importer
 *   RECONCILES them rather than restoring them: `MEMORY.md` is a line union
 *   (local entries kept verbatim, incoming pointers appended, nothing
 *   reordered or deleted), and a conflicting prose file is parked beside the
 *   local one as `<stem>.incoming.md` and indexed — the local file is never
 *   overwritten on any path. So a damaged payload still cannot overwrite
 *   anything the user has, which is why these stay outside this digest.
 *
 *   Two earlier versions of this bullet were wrong in opposite directions: it
 *   first claimed the layers were "merged" (they were not, on either path),
 *   then that the importer "keeps the existing file on any difference" (true
 *   only until #49). If you are about to describe this behaviour again, read
 *   `reconcileSharedLayers` rather than this comment.
 */
export declare function computeSessionsDigest(sessions: SessionManifest[]): string;
/**
 * `null` when the manifest declares no digest (pre-0.6.0 bundle) or the digest
 * matches; otherwise a caller-facing description of the mismatch.
 */
export declare function verifySessionsDigest(manifest: ExportManifest): string | null;
//# sourceMappingURL=manifest.d.ts.map