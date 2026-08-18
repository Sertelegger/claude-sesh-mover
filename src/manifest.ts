import {
  readFileSync,
  writeFileSync,
  existsSync,
  createReadStream,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExportManifest, SessionManifest, ExportLayer } from "./types.js";

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
export function writeManifest(
  exportDir: string,
  manifest: ExportManifest
): void {
  const manifestPath = join(exportDir, "manifest.json");
  const stamped: ExportManifest = {
    ...manifest,
    sessionsDigest: computeSessionsDigest(manifest.sessions),
  };
  writeFileSync(manifestPath, JSON.stringify(stamped, null, 2) + "\n", "utf-8");
}

/**
 * Parse `<exportDir>/manifest.json` and run the trust boundary's first two
 * steps in order: *is this a manifest at all* (`isBundleManifestShape`), then
 * *are its ids path-safe* (`assertSafeManifestIds`). Throws on either. Step
 * three (`verifySessionsDigest`) is the caller's, because only the caller knows
 * whether a digest mismatch is a refusal or a warning.
 *
 * ## Why the shape check is here and not at each of the five call sites (#72)
 *
 * It is not a new fourth step — it is step one, applied where the parse
 * happens. `assertSafeManifestIds` ALREADY throws for almost every wrong
 * `sessions` value, because `for...of` over a non-iterable throws: measured
 * against a `JSON.parse` result, `null`, a number, a boolean, a plain object
 * and a missing key all raise `manifest.sessions is not iterable` inside it,
 * and `[null]` raises on `.sessionId`. So every caller here already has to
 * survive a `readManifest` throw for a wrong-shaped list; this only widens
 * WHICH wrong shapes reach that throw instead of passing silently.
 *
 * Exactly one silent survivor motivated the change, and it is the one #72
 * names: a **string**. Strings are the only iterable JSON can produce that is
 * not an array, so `sessions: "abc"` iterates three characters whose
 * `.sessionId` is `undefined`, every id check is skipped, and
 * `manifest.sessions.length` then reports a session count of 3 that no session
 * list ever supplied.
 *
 * ## The honest limit — do not read this as "the list is now validated"
 *
 * `Array.isArray` is true for `[1,2,3]` and `["a"]`, so an array of
 * NON-OBJECTS still passes both steps here. That is deliberate rather than
 * overlooked: at every call site those degrade into an existing typed refusal
 * (the importer's step-1b "declared session has no file in the bundle", the
 * reindex per-session "no local thread mapping" drop) because each element's
 * `.sessionId` is `undefined`, whereas a string additionally fabricates a
 * *count* out of a value that is not a list at all. A per-element schema check
 * is a different, larger decision — it would belong beside `assertSafeManifestIds`,
 * not inside this predicate, whose whole contract is "is this one of ours".
 */
export function readManifest(exportDir: string): ExportManifest {
  const manifestPath = join(exportDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json found in ${exportDir}`);
  }
  const raw = readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as ExportManifest;
  if (!isBundleManifestShape(manifest)) {
    throw new Error(
      `manifest.json in ${exportDir} is not a sesh-mover bundle manifest (needs plugin "sesh-mover" and a sessions array)`
    );
  }
  assertSafeManifestIds(manifest);
  return manifest;
}

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
 * `readManifest` DOES call this, since #72 — see the reasoning on
 * `readManifest` itself. The two readers that must DEGRADE rather than throw —
 * `browse`'s directory scan and `readManifestFromArchive` — still call it
 * themselves, because neither goes through `readManifest`: the archive path
 * parses the manifest out of a tar stream, and `browse`'s store scan needs the
 * refusal as a value rather than an exception. `cli.ts`'s call is now reached
 * only when `readManifest` did not throw first; it stays because the
 * consolidation guard below reads the call as the evidence that the directory
 * path has not quietly re-derived its own copy.
 *
 * Returns `boolean`, not a type predicate: narrowing to `ExportManifest` would
 * claim a validation of the other fields that this does not perform.
 */
export function isBundleManifestShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { plugin?: unknown; sessions?: unknown };
  return m.plugin === "sesh-mover" && Array.isArray(m.sessions);
}

// A session id is safe iff it is a non-empty string with no path separators,
// no NUL byte, and isn't "." or "..". Real Claude session ids are UUIDs, so
// this accepts them while rejecting anything path-traversal-shaped. Any value
// containing "/" or "\" already covers "../" and "..\" segments — the bare
// "."/".." checks cover the separator-less forms.
export function isSafeSessionId(id: unknown): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  if (id === "." || id === "..") return false;
  return true;
}

// Single chokepoint: every manifest read that will later be used to build a
// filesystem path (session JSONL, subagents dir, tool-results dir, etc.)
// must run through this before the manifest is trusted. Guards
// session.sessionId and both continuation-linkage ids, since all three get
// interpolated into join() calls downstream (importer.ts, sync-state.ts).
export function assertSafeManifestIds(manifest: ExportManifest): void {
  for (const s of manifest.sessions) {
    const ids = [
      s.sessionId,
      s.continuation?.continuesLocalSessionId,
      s.continuation?.continuesPeerSessionId,
    ];
    for (const id of ids) {
      if (id !== undefined && !isSafeSessionId(id)) {
        throw new Error(
          `Unsafe session id in manifest: ${JSON.stringify(id)} (path separators and ".." are not allowed)`
        );
      }
    }
  }
}

export function computeIntegrityHash(contents: string[]): string {
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
export async function computeIntegrityHashFromFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function verifyIntegrity(
  contents: string[],
  expectedHash: string
): boolean {
  const actual = computeIntegrityHash(contents);
  return actual === expectedHash;
}

/**
 * The carry payload's `changes.patch`, hashed as BYTES — the fourth hash a
 * bundle carries, and the same kind of thing as the three above it: damage
 * detection, never attestation (#37). Anyone who can rewrite the patch can
 * rewrite the digest sitting beside it in the same manifest; what this catches
 * is a patch that arrived different from the one that left.
 *
 * ## Bytes, and a bare sha256
 *
 * No domain-separation prefix, unlike `computeSessionsDigest`, and that is
 * deliberate twice over. It has to agree with `computeIntegrityHashFromFile`,
 * which is what the apply side re-hashes the extracted file with — the two are
 * the same function over the same bytes, one from a buffer and one from a
 * stream. And it makes the field independently checkable: `sha256sum
 * changes.patch` prints exactly what the manifest declares, minus the `sha256:`
 * label, so a user debugging a refused carry can settle "is my copy the
 * damaged one" without this plugin.
 *
 * A `Buffer` rather than a string because the patch is bytes end to end: a
 * `git diff` of a text file that is not valid UTF-8 does not survive a string
 * round trip (see `payload/carry.ts`), and a digest taken over the lossy
 * spelling would fail on exactly the payloads that need it most.
 *
 * ## Why the CAPTURE side hashes the buffer and not the file it just wrote
 *
 * The opposite of `memoryDigest`, on purpose. That one is taken over the
 * bundle's own copy because it decides a re-send skip: a copy truncated in
 * flight must fail toward re-sending, so it has to describe what travelled.
 * This one decides an APPLY, so it has to describe what was *captured* — hash
 * the file back and a truncated write yields a self-consistent pair that
 * verifies happily and is then applied as if intact. Hashing the buffer puts
 * the write itself inside the covered range.
 */
export function computePatchDigest(patch: Buffer): string {
  return `sha256:${createHash("sha256").update(patch).digest("hex")}`;
}

/**
 * `null` when the bundle declares no patch digest (any bundle written before
 * the field existed) or the patch on disk is the one it declares; otherwise a
 * caller-facing description of the mismatch. Same contract as
 * `verifySessionsDigest`, including the "absent means unverifiable, not
 * broken" arm — a pre-digest bundle is applied exactly as it always was.
 *
 * An unreadable or absent `changes.patch` is a MISMATCH rather than a skip
 * once a digest is declared: a bundle that declares one comes from a version
 * that always writes the file, so its absence is damage. Callers that legally
 * have no patch at all pass `undefined` for `declared` and never reach this.
 */
export async function verifyPatchDigest(
  patchPath: string,
  declared: string | undefined
): Promise<string | null> {
  if (declared === undefined) return null;
  let actual: string;
  try {
    actual = await computeIntegrityHashFromFile(patchPath);
  } catch (e) {
    return `the bundle declares a patch digest of ${declared || "(unreadable)"}, but changes.patch could not be read (${(e as Error).message})`;
  }
  if (actual === declared) return null;
  return `the bundle declares a patch digest of ${declared || "(unreadable)"}, but its changes.patch hashes to ${actual}`;
}

/** The auxiliary layers a bundle can carry per session, each as its own directory. */
export const HASHED_LAYERS = ["subagents", "tool-results", "file-history"] as const;
export type HashedLayer = (typeof HASHED_LAYERS)[number];

/** `HASHED_LAYERS` is a subset of `ExportLayer` — this line fails to compile if that stops holding. */
const _hashedLayersAreExportLayers: readonly ExportLayer[] = HASHED_LAYERS;
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
export async function computeLayerDigest(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
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
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] === undefined) continue;
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
export function computeSessionsDigest(sessions: SessionManifest[]): string {
  const hash = createHash("sha256");
  hash.update(`sesh-mover/sessions-digest/1\n${sessions.length}\n`);
  hash.update(JSON.stringify(canonicalize(sessions)));
  return `sha256:${hash.digest("hex")}`;
}

/**
 * `null` when the manifest declares no digest (pre-0.6.0 bundle) or the digest
 * matches; otherwise a caller-facing description of the mismatch.
 */
export function verifySessionsDigest(manifest: ExportManifest): string | null {
  if (!manifest.sessionsDigest) return null;
  const actual = computeSessionsDigest(manifest.sessions);
  if (actual === manifest.sessionsDigest) return null;
  return `manifest.json declares ${manifest.sessions.length} session(s) with digest ${manifest.sessionsDigest}, but its own session list hashes to ${actual}`;
}
