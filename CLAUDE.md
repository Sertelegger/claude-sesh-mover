# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Names

- **npm package / GitHub repo:** `claude-sesh-mover` — the `claude-` prefix makes the scope obvious to a browser of the npm/GitHub ecosystem.
- **Plugin name (in `.claude-plugin/plugin.json`):** `sesh-mover` — this is what drives slash command prefixes (`/sesh-mover:export`, etc.), so it stays short.
- **CLI bin:** `sesh-mover` — matches the plugin name for in-session discoverability.

Don't change any of these without updating the others *and* every slash command reference in `commands/*.md`, the skill doc, and this file.

## Commands

- `npm run build` — compile TypeScript to `dist/`. **`dist/` is committed to the repo** (not gitignored) so that users installing via `/plugin install` get a working plugin without a build step. Rebuild and stage `dist/` alongside any `src/` change.
- `npm run lint` — type-check only (`tsc --noEmit`).
- `npm test` — run full vitest suite once.
- `npm run test:watch` — vitest in watch mode.
- Run a single test file: `npx vitest run tests/rewriter.test.ts`
- Filter by test name: `npx vitest run -t "translates WSL paths"`
- Invoke the built CLI directly: `node dist/cli.js <command> [options]` (all commands emit a single JSON object to stdout; parse it).

## Architecture

claude-sesh-mover is a Claude Code **plugin** (not a standalone app) that exports, imports, and migrates Claude Code sessions across machines, OS/path conventions (macOS/Linux/Windows/WSL), config directories (e.g. `~/.claude` vs `~/.claude-tzun`), and project paths.

The design is **hybrid: deterministic Node.js core + conversational skill layer.**

- `src/` compiles to `dist/cli.js`, a Commander-based CLI with subcommands: `export`, `import`, `migrate`, `browse`, `configure`, `push`, `pull`, `whereis`, and the nested `hub init` / `hub status` / `hub reindex`. Every command returns structured JSON keyed by `success` and `command` (see `src/types.ts` for result shapes — `ExportResult`, `ImportResult`, `MigrateResult`, `BrowseResult`, `ConfigureResult`, `ErrorResult`, and the hub shapes `HubInitResult`, `HubStatusResult`, `HubPushResult`, `HubPullResult`/`HubPullListResult`, `WhereisResult`, `HubReindexResult`, plus the shared `HubUnlinkedResult`/`HubLockBusyResult`/`NotYetSyncedResult` error shapes).
- `commands/*.md` + `skills/session-porter/SKILL.md` are markdown-based slash commands loaded by Claude Code when the plugin is installed. They shell out to the CLI, parse the JSON, and drive UX (confirmations, path-collision handling, prune prompts, registration fallback when Claude Code rejects an imported session).
- `.claude-plugin/plugin.json` is the plugin manifest consumed by Claude Code's plugin cache — its `commands` array must list every `commands/*.md` doc (a doc not listed there never loads as a slash command, even if the file exists); `.claude-plugin/marketplace.json` sits alongside it for marketplace listing.
- `src/index.ts` is the library entrypoint — it re-exports every core module so the package can also be consumed programmatically. It deliberately does **not** export a `decodeProjectPath`: project-folder encoding (`-` for path separators) is lossy for hyphenated paths and cannot be reliably reversed. Read `cwd` from JSONL entries, or use `readProjectPathFromJsonl` in `discovery.ts`, instead of trying to decode the folder name.

### Core module responsibilities

- `platform.ts` — OS detection (including WSL1/WSL2 discrimination) and path translation between conventions. Also resolves the Claude config dir: `--*-config-dir` flag → `CLAUDE_CONFIG_DIR` env → `~/.claude`.
- `discovery.ts` — walks a config dir's project folders (`<configDir>/projects/<encoded-path>/<sessionId>.jsonl`) to find sessions matching a project path / session ID.
- `rewriter.ts` — rewrites `cwd`, tool-result content (string and text-block forms), `toolUseResult` stdout/stderr, and file-history snapshot keys via a two-stage pipeline: exact mappings (project/config/home, longest-first) with cross-family tail-separator normalization, then cross-family token translation through `translatePath`. `gitBranch` is NOT rewritten (branch names are not paths). User text and assistant text/thinking are never rewritten. Path mappings must be sorted longest-first to avoid prefix collisions (see commit 948c763).
- `manifest.ts` — reads/writes the `manifest.json` inside an export bundle (records source platform, project path, session list, Claude version, export timestamp).
- `archiver.ts` — `tar.gz` (always available) and `tar.zst` (falls back to gzip if `zstd` binary missing; sets `actualFormat` to signal the fallback to the skill layer). zstd intermediates are written to a private temp dir (never next to the destination file), and tar entries are validated before extraction — absolute paths, `..` segments, and symlink/hardlink entries are rejected outright.
- `jsonl.ts` — bounded JSONL IO (first/last line, line count) — use these instead of whole-file reads for metadata.
- `exporter.ts` / `importer.ts` / `migrator.ts` — orchestrators. Export copies only; migrate is export+import+delete-source and only runs same-machine. Migrate accepts an optional `currentCwd` (wired from `process.cwd()` in `cli.ts`) and emits a "self-migration" warning when the caller is running inside the directory being moved — this is the common foot-gun when a user invokes `/sesh-mover:migrate` from the session they're trying to migrate. `--scope current` requires `--session-id`; cleanup deletes only confirmed-moved sessions (imported + skipped-as-duplicate). Import registers sessions in Claude's session index; `--no-register` skips registration (fallback for version-mismatch rejections). Imports are idempotent by default — a per-project content-hash registry in sync-state skips already-imported sessions; `--allow-duplicates` overrides.
- `version-adapters.ts` — schema migrations between Claude Code JSONL versions; called during import when source/target Claude versions differ.
- `config.ts` — two-tier config: user (`~/.claude-sesh-mover/config.json`) merged with project (`<cwd>/.claude-sesh-mover/config.json`); project overrides user. `computeEffectiveConfig` is the merge site (used by `cli.ts`'s `loadEffectiveConfig` and by `hub/status.ts`) — it layers each layer's *raw, non-backfilled* file contents onto the defaults, rather than merging two independently defaults-backfilled config objects. The latter (what an earlier `mergeConfigs(readConfig(user), readConfig(project))` call did) silently reset any user-scope-only setting back to its default whenever the project-scope file was simply absent, because `readConfig` always backfills defaults even for a missing file — fixed in 57cd7b7; affects `export`, `migrate`, and `configure --show` too.
- `summary.ts` — extracts a short session summary for export names/browse listings. `--no-summary` (or `export.noSummary` in config) is functional: it skips JSONL parsing for the summary entirely and sets the manifest `summary` to the session slug, so no conversation text is copied into the manifest.
- `sync-state.ts` — per-project peer sync bookkeeping (peers, lineage, imported registry), one file per project keyed by encoded project path. Schema `v2` (additive): a `hub` block (`hubId` + `threadByLocalSession`, written by `hub/push.ts`/`hub/pull.ts` via `setThreadId`) is added lazily, only once a project first pushes/pulls through a hub — plain incremental-sync users never see `schemaVersion` leave `1`. A plugin version that predates the hub and encounters a `v2` file doesn't recognize it, treats it as corrupt, and renames it aside (fresh state) — that costs only peer/thread bookkeeping, never session data.

### Hub module responsibilities (`src/hub/`)

The hub is a shared directory (filesystem backend only, in Slice 1 — any path that behaves like a shared filesystem: network share or synced folder) that every participating machine points at via `hub.path` in config, holding per-project bundles plus **one index file per machine**. Two invariants hold the whole design together:

- **Per-machine ownership** — a machine only ever writes its own index file (`indexes/<machineId>.json`, see `layout.ts`'s `indexPath`) and its own bundles; it never touches another machine's files. This is what makes concurrent push/pull from *different* machines safe without a distributed lock — the same-machine advisory lock (`lock.ts`) only ever has to guard one machine's own writes against itself, not against other machines.
- **Derivable indexes** — everything an index file records (thread → bundle history) is reconstructible from the bundles on the hub plus this machine's local sync-state (which thread each local session belongs to). `hub reindex` (`reindex.ts`) is this invariant made executable: a repair tool for a lost/corrupt index, not a sync primitive.

Module map: `backend.ts` (the `HubBackend` interface — `read`/`writeAtomic`/`list`/`exists`/`delete` — and `createFsBackend`, the only implementation in Slice 1; throws `HubNotSyncedError` when index-referenced files haven't synced to this machine's copy of the hub directory yet) · `layout.ts` (hub-relative path builders and the on-disk schema types — `HubJson`, `HubProjectJson`, `HubBundleRecord`, `HubThreadEntry`, `HubIndexJson` — plus `assertSafeHubId`, the path-safety chokepoint every id passes through before it's used in a hub path) · `identity.ts` (project identity — `.claude-sesh-mover/project.json`, meant to be committed, holds the project's `projectId`; `normalizeGitRemote` + matching lets a project link to the same hub project from any clone via its git remote) · `lock.ts` (the same-machine advisory lock, with stale-lock stealing after `LOCK_STALE_MS`) · `index-file.ts` (`buildIndexFile` — a pure projection of local sessions + prior index + new bundle records — plus read/write for a machine's own index and `readAllIndexes` across every machine) · `threads.ts` (`resolveThreads` — a deterministic latest-copy tiebreak across every machine's index; load-bearing for "which machine has my latest work", so it must never depend on iteration/insertion order) · `workspace.ts` (git-less project snapshot/unpack, `.claude-sesh-mover/hubignore` exclusion patterns) · `init.ts` / `status.ts` / `push.ts` / `pull.ts` / `whereis.ts` / `reindex.ts` (one orchestrator per CLI verb; each of push/pull/reindex acquires the project lock before writing hub state).

### Export storage layout

Exports land in `<homedir>/.claude-sesh-mover/<name>/` (user scope) or `<cwd>/.claude-sesh-mover/<name>/` (project scope). A directory export is `<name>/` with `manifest.json` + session JSONL + referenced layer files. For `--format archive`/`zstd`, the exporter writes that directory as a staging area, tars it to `<name>.tar.gz` or `<name>.tar.zst` in the parent, then removes the staging directory; the archive is the sole artifact, and `ExportResult.exportPath` is set to the archive path (equal to `archivePath`). `browse` scans both user and project directories.

### Migrate flow (self-migration hazard)

`migrate` = export + import + cleanup + optional `--rename-dir`. Because it deletes source session files and may `mv` the source project directory, running it from inside the session being migrated is unsafe:

- The running Claude Code session holds the source JSONL open and keeps appending to it; anything said after the migrate snapshot goes to the now-deleted source path and Claude Code recreates the file, orphaning the session with a stale `cwd`.
- If `--rename-dir` is passed, the shell's cwd disappears under subsequent tool calls.

`migrator.ts` **blocks actual self-migration runs by default** (returns `ErrorResult` with a recovery-step `suggestion`) whenever `currentCwd` is inside `sourceProjectPath`. Dry-run still previews (with a warning), and `--force` overrides the block for advanced use. The recommended flow for moving the active session is: exit Claude Code, `cd` to a stable outer path (`~` or similar), start a new Claude Code session there, then run `/sesh-mover:migrate`. Merging into a target project dir that already has sessions is supported, so the recovery flow is safe even when target sessions are already in place.

### Testing conventions

Vitest with fixtures under `tests/fixtures/`. Integration tests (`tests/integration.test.ts`) build full export/import round-trips against fixture config dirs — do **not** mock filesystem or archive operations; use real temp dirs (`mkdtempSync`). When adding a new JSONL entry variant, update both `src/types.ts` and the fixture JSONL; rewriter/version-adapter tests rely on realistic shapes.

### When adding a command or CLI option

1. Extend `src/cli.ts` with the Commander subcommand/option.
2. Add the matching result shape to `src/types.ts` (every CLI result is typed).
3. Update `commands/<name>.md` and (if the behavior needs explanation for the skill layer) `skills/session-porter/SKILL.md`. If the command is new (not just a new option on an existing one), add its `./commands/<name>.md` path to `.claude-plugin/plugin.json`'s `commands` array too — Claude Code only loads slash commands listed there, so a new doc file with no matching entry silently never appears as a slash command.
4. Rebuild with `npm run build` **and stage the updated `dist/`** — it's committed so installed plugins pick up the change. A commit that touches `src/` without a corresponding `dist/` update will ship a stale binary.
