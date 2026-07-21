# Changelog

Notable changes per release. Direction and upcoming work live in [ROADMAP.md](./ROADMAP.md).

## [0.4.1] — 2026-07-20

Toolchain and repo-hygiene release: the package is now ESM on current dependency
majors, and the repo gained CI-enforced community and security scaffolding.

### Changed
- Package is now ESM (`"type": "module"`); `dist/` is emitted as ES modules (#26).
- Node floor raised 18.17 → 22.12 — current Claude Code releases already require
  Node ≥ 22, and commander 15 needs ≥ 22.12 (#26).
- commander 13 → 15 (ESM-only major) (#26).
- Dev toolchain: TypeScript 7 (native compiler — emitted `dist/` byte-identical
  to 5.9), vitest 4, @types/node 26 (#22, #25, #26).

### Added
- Community health files: contributing guide, security policy, code of conduct,
  issue forms, PR template (#17).
- Dependabot (grouped minor/patch updates), CodeQL scanning, and automatic
  GitHub Releases on `v*` tag push (#17).
- npm publish metadata: `repository`/`homepage`/`bugs` fields, `files` allowlist,
  `prepublishOnly` guard (#17).
- Social preview banner assets under `.github/`.

## [0.4.0] — 2026-07-14

First CI-tested release: a 3-OS test matrix, a streaming rewrite/import/export pipeline for
large sessions, and a URL-safety fix for cross-family path rewriting.

### Added
- First CI: 3-OS matrix (Linux/macOS/Windows), dist-freshness gate, and a Windows
  PowerShell/Git-Bash smoke round-trip (#7).
- `--progress` flag on `export`/`import`/`migrate` — emits NDJSON progress events on
  stderr; the stdout JSON result contract is unchanged.
- Library: `transformLine`, `rewriteJsonlStream`, `computeIntegrityHashFromFile`,
  `buildContinuationStream`, `extractSummaryFromFile`, `readEntryUuids`, `percentThrottle`,
  `ProgressEvent`.

### Fixed
- Free-text tokens preceded by `/` are no longer translated — URLs with unix-root hosts
  (`http://mnt/e/...`, `//tmp/...`, `file:///...`) now survive cross-family import intact,
  instead of being mangled by token translation (#8). The fix guards on both the preceding
  `/` and a domain-character class (`[A-Za-z0-9.-]`) immediately before the match — the
  domain guard is load-bearing, protecting hosts like `https://example.com/mnt/e/data` from
  being treated as a bare path. Accepted trade-off: POSIX `//net/share` and `file://` URLs
  no longer translate in free text.

### Changed
- **Streaming pipeline** — rewrite/import/export is now O(longest-line) memory per session
  instead of loading whole sessions into memory; hash format and bundle compatibility are
  unchanged (#11).
- Import validation failures now abort before the memory/plans merge step (previously the
  merge ran first).
- Dry-run `rewriteReport` JSON gains two additive keys: `adaptationsApplied` and
  `parseFailures`.

## [0.3.2] — 2026-07-14

### Security
- Import now rejects manifests whose session ids contain path separators or `..`
  — a crafted bundle could previously make the importer read files outside the
  bundle and copy them into the session store (path traversal → exfiltration).
  Affects 0.1.0–0.3.1 (#13).

### Fixed
- Path rewriting no longer rewrites sibling paths that merely share a mapped
  prefix (e.g. `app` vs `app-backup`) (#14).

## [0.3.1] — 2026-07-14

Hardening follow-ups surfaced by the 0.3.0 final review.

### Added
- Import dedup registry now tracks registered state — a `--no-register` import is no longer
  a dead end: a later normal import of the same bundle automatically imports a registered
  copy, leaving the earlier unregistered copy on disk (#1).
- `MigrateResult.skippedSessions` — migrate now surfaces the same duplicate/already-received
  skip reporting import already had (#3).

### Fixed
- Incremental diff: a session with an empty recorded head UUID is now sent whole instead of
  risking a bad diff against it (#2).
- `--since <path>` fallback keys continuation sessions by their local session id (matching
  how sync-state records them) instead of the source session id, so re-diffing against a
  reference bundle correctly recognizes continuations of the same session (#4).
- Export: archive-name collision detection now also checks for existing `.tar.gz`/`.tar.zst`
  artifacts, not just a same-named directory — previously a second archive export with the
  same name could silently overwrite the earlier archive (#5).

### Removed
- Import's no-op `--force` flag (confirmation was never gated on it) (#6).

## [0.3.0] — 2026-07-13

Hardening pass: fixes from a full adversarial review of 0.2.0.

### Security
- Archiver: zstd intermediate files now live in private temp dirs (never next to — or
  clobbering — user files); tar entries are validated *before* extraction (absolute paths,
  `..` traversal, symlink/hardlink entries rejected).
- Config: prototype-polluting `--set` paths rejected; malformed JSON values return a clean
  error. `npm audit` down from 5 advisories to 0.

### Added
- **Idempotent imports** — a per-project content-hash registry skips already-imported
  sessions (with an existence check so a deleted copy can be re-imported); structured
  `skippedSessions` reporting; `--allow-duplicates` to override.
- `--no-summary` / `export.noSummary` now functional: slug-only manifests, no conversation
  text in export metadata or resume listings.

### Changed
- **Path rewriting rebuilt as a two-stage pipeline** — exact project/config/home mappings
  with separator normalization, then cross-family token translation (`/mnt/<drive>`, `/tmp`,
  home dirs) — fixing mixed-separator output and untranslated paths in tool output for
  WSL ↔ Windows ↔ macOS ↔ Linux imports; structured fields (`cwd`, file-history keys)
  translate fully, including spaced Windows paths; array-form tool results now covered.
- Migrate: `--scope current` requires `--session-id` (previously it silently migrated and
  deleted **all** sessions); source cleanup deletes only confirmed-moved sessions.
- Memory footprint: discovery and export process sessions one at a time with bounded reads —
  peak usage is O(largest session), not O(all sessions).

### Fixed
- Incremental sync: sent-state head UUIDs are recorded from the export snapshot (not the
  live, still-growing session) and only after the archive is successfully written; the
  `--suffix` collision path now archives and records state like every other path;
  continuation bundles carry subagents/tool-results/file-history layers; the slice point is
  verified by UUID before cutting a continuation.
- Discovery no longer fails on sessions whose first JSONL line exceeds 4KB.
- `configure --set machine.name=<label>` now actually persists the name (documented in
  0.2.0 but unwired).

## [0.2.0] — 2026-04-21

Incremental sync between machines.

### Added
- Persistent machine identity (`~/.claude-sesh-mover/machine-id.json`) and per-project,
  per-peer sync state with atomic writes and corrupt-file recovery.
- `export --incremental --to <peer>`: new sessions ship whole; sessions with new messages
  ship as **continuation sessions** (lineage header + only the new messages); unchanged
  sessions are skipped. `--since <path>` as a stateless fallback.
- Import records lineage and peer state; re-importing an incremental bundle skips
  already-received sessions.
- CLI flag validation and `tar.gz`/`tar.zst` format aliases.

## [0.1.3] — 2026-04-18
- Slash commands invoke the CLI via `${CLAUDE_PLUGIN_ROOT}` instead of searching the plugin
  cache.

## [0.1.2] — 2026-04-16
- Archive exports remove their staging directory; the archive is the sole artifact.

## [0.1.1] — 2026-04-15

Public-release prep.

- Self-migration safety: migrate refuses to run from inside the session being migrated
  (`--force` overrides).
- Interactive browse (view details, import, delete); `--rename-dir` on migrate; import
  discovers bundles dropped in the project root.
- Committed `dist/` so the plugin works without a build step; marketplace manifest for
  `/plugin marketplace add`; docs and MIT license.
- Review-pass fixes: import rollback scoped to files it wrote; path mappings sorted
  longest-first to prevent prefix collisions.

## [0.1.0] — 2026-04-11

Initial release: export / import / migrate / browse / configure slash commands and CLI;
platform detection with WSL1/WSL2 discrimination and WSL ↔ Windows path translation;
session discovery; JSONL path rewriting; manifest with sha256 integrity hashes; `tar.gz` /
`tar.zst` archives; version-adapter framework; two-tier config; full-fixture integration
tests.
