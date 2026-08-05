# Changelog

Notable changes per release. Direction and upcoming work live in [ROADMAP.md](./ROADMAP.md).

## [0.6.0] — 2026-08-04

The Hub, Slice 2: the hub keeps itself current, and a pulled continuation lands *in* the
session it continues instead of beside it.

### Read this before upgrading

Two items change behavior for existing hub users with no action on their part.

- **A linked project starts pushing by itself.** This release registers a `SessionEnd`
  hook, and **linking a project to a hub project is the consent gate** — so a project you
  linked under 0.5.x is auto-pushed at the end of your next Claude Code session, with
  nothing further to enable. For a project **with a git remote** that push also carries
  your *uncommitted* work (a `git diff HEAD` patch plus untracked, non-gitignored files),
  because `hub.carryDiff` defaults to on: the payload is your working tree, not just
  transcripts. The hook takes no flags, so config is the only opt-out —
  `sesh-mover configure --set hub.autoPush=false` (no automatic push at all),
  `… hub.carryDiff=false` (no uncommitted work from git projects),
  `… hub.noWorkspace=true` (no workspace snapshot from projects *without* a git remote —
  it does not affect the carry), `… hub.startupNotice=false` (add `--scope project` to
  limit any of them to one project). Nothing happens at all for a project that was never
  linked, or on a machine with no hub configured. The automatic push is also **silent by
  construction** — its output goes to a stderr a clean session exit never shows — so the
  warnings a manual push prints, the `carry.trackedIgnored` disclosure included, are
  recorded in sync-state and reported by `hub status` (`lastAutoPush`) instead.
- **Workspace bundles already on your hub can be unpullable, and this release fixes
  them** — every sesh-mover that has ever written one (0.5.0, 0.5.1) could produce this.
  When a workspace snapshot happened to contain no files (an empty
  project directory, a `hubignore` broad enough to drop the whole tree, or a project whose
  only content was the `project.json` that linking had just planted), `push` still wrote a
  manifest declaring a workspace payload the bundle did not contain. Pulling such a bundle
  **crashed, terminally**: the crash happened inside the bundle loop *before* the session
  import, so no session arrived, nothing was recorded as received, every retry failed
  identically, and no flag skipped the workspace step — the thread was permanently
  unpullable. 0.6.0 fixes both ends: a snapshot that carries no files now creates the
  (empty) `workspace/` directory it declares, so the payload matches the manifest — the
  manifest still declares `fileCount: 0`, which is a legitimate snapshot — **and** a pull
  that meets a bundle declaring a payload it does not contain degrades to a warning instead
  of crashing, so a thread stranded by an older version becomes pullable again by upgrading
  the machine that pulls.

### Added
- **Hub automation** (`hooks/hooks.json`, two internal CLI endpoints). `SessionEnd` →
  auto-push, run detached so it never delays session exit; `SessionStart` (on `startup`
  and `resume`) → a one-line notice when another machine holds newer work for this project,
  bounded at 10s so an unreachable hub can't stall a session opening. Both default on, both
  inert until a hub is configured *and* the project is linked. Opt out with
  `hub.autoPush` / `hub.startupNotice`.
- **Append-to-base on pull.** A continuation for a session this machine already has is
  spliced onto the end of that transcript (`appended`), so a two-machine round trip leaves
  one resumable session instead of a chain of fragments. Guards: the entry chain must line
  up, the local file must not have been written in the last 5 minutes, and the bundle must
  pass its integrity hash. `--force-append` overrides the liveness guard only;
  `--no-append` / `hub.pullAppend=false` disables the path.
- **Divergence resolution** (`--on-divergence fragment|adopt-hub|skip`, `hub.onDivergence`)
  for the case where both machines continued a thread from the same point: keep both,
  adopt the hub's branch while preserving your own **in full** as a new registered session,
  or apply and record nothing so the choice can be made later. `/sesh-mover:pull` always
  asks before applying anything.
- **3-way workspace merge** for projects with no git remote. An incoming snapshot is merged
  against a generation both trees are known to have held (matched by bundle id, never by a
  timestamp) rather than skipped or overwritten: unmergeable files keep the local copy with
  the incoming one parked as `<name>.theirs-<ts>`, conflicts get real conflict markers, and
  the merge never deletes. Reported as `workspaceMerge`.
- **Carried uncommitted work for git projects.** `push` bundles a `git diff HEAD` patch
  (binary-safe) plus untracked, non-gitignored files; `pull` never applies it on its own —
  `--apply-carry` plus a clean tree at the exact base commit, no merge/rebase in progress,
  and `git apply --check` clean. Any decline parks the whole payload in
  `.claude-sesh-mover/carry-<ts>/` with a README of the manual steps. `--no-carry` /
  `hub.carryDiff=false` turns it off.
- **`.claude-sesh-mover/hubinclude`** — the opposite of `hubignore`. Paths listed there are
  carried even when `hubignore`, the built-in excludes, or `.gitignore` would drop them,
  for **both** payload builders (workspace snapshot and git carry). Meant to be committed,
  so one line fixes every clone. `.git` and `.claude-sesh-mover` can never be re-included.
  Until the file exists, `push` reports a capped sample of the gitignored paths it left
  behind (`ignoredNotCarried`) and `/sesh-mover:push` offers to create it from them.
- New flags: `--force-append`, `--no-append`, `--on-divergence <mode>`, `--apply-carry`
  (pull); `--no-carry` (push).
- New config keys: `hub.autoPush`, `hub.startupNotice`, `hub.pullAppend`,
  `hub.onDivergence`, `hub.carryDiff`.
- New result fields — `pull`: `appended`, `divergence`, `workspaceMerge`,
  `workspaceRefused`, `workspaceDeclaredMissing`, `carryAvailable`, `carryApplied`,
  `unfetchableBundles`; `push`: `carry`, `ignoredNotCarried`; `whereis`:
  `unfetchableBundles` per thread. Every one of them is a typed field precisely so the
  slash commands branch on results rather than on warning wording.
- Library: `hub/append`, `hub/merge`, `hub/carry` and `hub/hooks` are re-exported from the
  package barrel (`src/index.ts`).

### Changed
- A pulled continuation now **appends** to the local session it continues when the chain
  matches; the separate "continuation session" fragment is the documented fallback, not the
  norm. Sessions that were appended are reported in `appended` and are **not** in
  `importedSessions`.
- A workspace payload applied to a non-empty directory now **merges** when a shared
  generation is known, instead of being skipped. `--force-workspace` keeps exactly one
  meaning — "overwrite, don't combine" — and now overrides the merge too.
- Session head/metadata derivation no longer reads the literal first or last line of a
  transcript. Claude Code brackets a transcript with uuid-less bookkeeping entries; on real
  transcripts ~31% of line boundaries have one. In 0.5.x that made `whereis`'s
  "which machine has the latest copy" tiebreak compare missing values, and project-path
  recovery fall back to the lossy encoded directory name. Left unfixed it would also have
  defeated this release's headline feature — a wrong head reads as a chain mismatch, which
  0.6.0 classifies as divergence, so `pull` would have reported forks that had not happened
  and offered `--on-divergence adopt-hub`, the one destructive answer, as the remedy.
- Sync-state's `hub` block gains `workspaceGenerations` (bounded history of the snapshot
  generations this tree passed through) alongside `lastWorkspace`. Additive; still
  `schemaVersion: 2`.

### Fixed
- `whereis`/`pull` picked the "latest copy" of a thread by index-file iteration order when
  `lastActiveAt`, `messageCount` and head uuid all tied — which is exactly what a
  successful append produces. The tiebreak is now total and deterministic (final key:
  machine id).
- Workspace snapshots skipped `.git` case-sensitively, so on a case-insensitive filesystem
  (macOS, Windows) a directory named `.GIT` was copied into the bundle and uploaded to the
  hub — a git store, in plaintext, in every push of that project.
- Unpacking a workspace payload (`--force-workspace`) refused nothing: a bundle carrying
  `workspace/.claude-sesh-mover/…` could plant the project-scope `config.json` that decides
  where this machine's hub is, or the `hubinclude` that decides what its next push uploads.
  Both names are now refused on every apply path (`workspaceRefused`).
- Unpacking a workspace payload wrote **through** a symlink in the target tree, landing a
  file outside the project entirely. Both apply paths now share one destination classifier.
- `push` no longer records a workspace generation for a snapshot it did not send
  (over-budget or skipped) — a recorded-but-unapplied generation makes the next merge read
  the whole tree as deleted.

### Known limitation
- **A thread whose history spans two machines cannot be pulled whole by a third**
  ([#35](https://github.com/Sertelegger/claude-sesh-mover/issues/35)). A pull fetches the
  bundle list of exactly one machine, and each machine's index lists only the bundles it
  pushed. **v0.6.0 ships a disclosure, not a fix:** `pull` and `whereis` now report the
  machines holding the part that could not be fetched (`unfetchableBundles`, plus a warning
  on `pull`), and there is **no flag that fetches them** — `--from-machine` does not exist,
  `--thread`/`--target-path` resolve to the same source, and `hub reindex` only rebuilds
  this machine's index from its own bundles. Nothing is lost (every bundle stays on the
  hub) and two machines are unaffected; on a third, the conversation arrives in halves and
  the session-start notice will keep flagging that thread as behind. Chain assembly is the
  next slice.

### Security / consent
- **Linking a project is the consent gate for the automation.** Both hooks default on and
  both are inert until a hub is configured *and* the project is linked. See "Read this
  before upgrading" for the opt-out keys.
- **The carry's safety rules cover the untracked half only — say it that way.** Among
  *untracked* files, a gitignored one is never carried unless `hubinclude` names it, and
  symlinks, `.git`, `.claude-sesh-mover`, `hubignore` matches and the built-in excludes are
  all dropped. **None of that filters the patch:** `git diff HEAD` describes every *tracked*
  file that changed, so a file that is gitignored *and* tracked (committed once, gitignored
  later, never `git rm --cached`; or `git add -f`) travels in full. `push` names that set
  back in `carry.trackedIgnored` and in a warning — the remedy there is `git rm --cached`
  or `--no-carry`, never a `hubinclude`/`hubignore` line.
- `.git` and `.claude-sesh-mover` are refused on every apply path — workspace unpack,
  workspace merge, and the carry patch (a bundle must never be able to plant the
  `config.json` that says where your hub is, or the `hubinclude` that decides what your
  next push uploads). A carry payload naming either, or creating a symlink, is refused
  whole rather than partly applied.
- The hub directory's threat model is unchanged and still **"a folder only machines you own
  can write"**: sessions remain plaintext at rest, applying a payload writes ordinary
  project files ([#36](https://github.com/Sertelegger/claude-sesh-mover/issues/36)), and
  the merge ancestor is verified on our side but self-reported by the peer
  ([#37](https://github.com/Sertelegger/claude-sesh-mover/issues/37)). Both are gates on
  any future hosted backend.

## [0.5.1] — 2026-07-28

### Fixed
- `browse` (and the `/sesh-mover:import` picker) reported archives with the *browsing*
  machine's platform and blank/zero metadata; it now reads each archive's real
  `manifest.json` and reports the true origin platform, project path, export date, and
  session count. Archives whose metadata genuinely can't be read (e.g. `.tar.zst` on a
  machine without `zstd`) are now marked `metadataAvailable: false` with a reason instead
  of showing fabricated values.

### Changed
- `BrowseResult` archive entries: `exportedAt` / `sourcePlatform` / `sourceProjectPath` /
  `sessionCount` are nullable and accompanied by `metadataAvailable` (+ `metadataError`
  when false).

## [0.5.0] — 2026-07-21

The Hub, Slice 1: a cross-machine session index with a filesystem backend — push, pull,
and see where a project's sessions live across every machine you use.

### Added
- **The Hub** — `hub init`, `hub status`, `hub reindex`, `push`, `pull`, `whereis`.
  - Filesystem hub backend: any directory works as the hub — network share, or a
    synced folder (OneDrive/Dropbox/Syncthing/iCloud Drive).
  - Project identity (`.claude-sesh-mover/project.json`, meant to be committed) with
    git-remote matching, so a project links to the same hub project from any clone.
  - Logical-session **threads** with cross-machine lineage — `whereis` shows every
    machine's copy of a thread, which one is latest, and whether the local copy is
    current or stale.
  - Workspace snapshots for git-less projects (project files bundled alongside
    sessions on push/pull), with `.claude-sesh-mover/hubignore` support to exclude
    paths from the snapshot.
  - `--progress` NDJSON phases on `push`/`pull` (extends the existing
    export/import/migrate progress contract).
  - Same-machine advisory locking so two hub operations for the same project on one
    machine don't race each other.
  - Plugin slash commands: `/sesh-mover:push`, `/sesh-mover:pull`,
    `/sesh-mover:whereis`, `/sesh-mover:hub-init` (`plugin.json`'s `commands` array
    updated to match).
  - Library: the `src/hub/*` module surface (backend, layout, identity, threads,
    index-file, workspace, lock, init, status, push, pull, whereis, reindex) is
    re-exported from the package barrel (`src/index.ts`).
  - `--session-id` filtering on `push` is an **exact subset** of the project's
    sessions — reuses `exporter.ts`'s existing sessionIds filter (unknown ids are
    rejected, not silently skipped).

### Changed
- Sync-state schema **v2** (additive): a `hub` block (`hubId` + thread-by-local-session
  mapping) is added only once a project first pushes/pulls through a hub; files
  otherwise stay v1. Older plugin versions that see a v2 file don't understand
  `schemaVersion: 2` and treat it as corrupt — the file is renamed aside and a fresh
  state is started, which loses only peer/thread bookkeeping, never session data.
- Export manifest gains two optional, backward-compatible fields: `projectId` (hub
  project this bundle belongs to) and `workspace` (`fileCount`/`byteSize`/`snapshotAt`
  when a workspace snapshot was included).
- `HubPullResult.localSessionId` is `string | null` — `null` specifically means the
  pulled content was already present locally, but sesh-mover couldn't identify which
  existing local session it corresponds to (a bookkeeping edge case), not that the
  pull failed.

### Fixed
- Config-merge bug (pre-existing, since the two-tier config was introduced): merging
  user-scope and project-scope config silently reset any user-scope-only setting to
  its default whenever the project-scope `config.json` didn't exist, because
  `readConfig` always backfills defaults even for a missing file — the merge couldn't
  distinguish "no project override" from "project explicitly set back to default".
  Fixed via `computeEffectiveConfig`, which layers raw (non-backfilled) file overrides
  onto defaults instead of merging two independently-defaulted config objects; `cli.ts`'s
  `loadEffectiveConfig` now routes through it. Affects `export`, `migrate`,
  `configure --show`, and the new `hub status`/`push`/`pull` — everywhere effective
  config is read (57cd7b7).

### Security
- **Hub trust model documented:** the hub directory is the trust boundary — every
  pulled bundle still passes the existing tar-entry validation and manifest-id safety
  checks before anything touches disk, but **sessions are stored in the hub in
  plaintext at rest** until a future encryption slice ships. Anyone with read access
  to the hub folder can read every pushed session; treat the hub directory like you'd
  treat `~/.claude/projects/` itself.

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
