# Changelog

Notable changes per release. Direction and upcoming work live in [ROADMAP.md](./ROADMAP.md).

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
