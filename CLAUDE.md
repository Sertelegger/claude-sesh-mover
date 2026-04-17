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

- `src/` compiles to `dist/cli.js`, a Commander-based CLI with five subcommands: `export`, `import`, `migrate`, `browse`, `configure`. Every command returns structured JSON keyed by `success` and `command` (see `src/types.ts` for result shapes — `ExportResult`, `ImportResult`, `MigrateResult`, `BrowseResult`, `ConfigureResult`, `ErrorResult`).
- `commands/*.md` + `skills/session-porter/SKILL.md` are markdown-based slash commands loaded by Claude Code when the plugin is installed. They shell out to the CLI, parse the JSON, and drive UX (confirmations, path-collision handling, prune prompts, registration fallback when Claude Code rejects an imported session).
- `.claude-plugin/plugin.json` is the plugin manifest consumed by Claude Code's plugin cache.

### Core module responsibilities

- `platform.ts` — OS detection (including WSL1/WSL2 discrimination) and path translation between conventions. Also resolves the Claude config dir: `--*-config-dir` flag → `CLAUDE_CONFIG_DIR` env → `~/.claude`.
- `discovery.ts` — walks a config dir's project folders (`<configDir>/projects/<encoded-path>/<sessionId>.jsonl`) to find sessions matching a project path / session ID.
- `rewriter.ts` — rewrites `cwd`, `gitBranch`, and embedded paths inside JSONL entries when source and target paths differ. Path mappings must be sorted longest-first to avoid prefix collisions (see commit 948c763).
- `manifest.ts` — reads/writes the `manifest.json` inside an export bundle (records source platform, project path, session list, Claude version, export timestamp).
- `archiver.ts` — `tar.gz` (always available) and `tar.zst` (falls back to gzip if `zstd` binary missing; sets `actualFormat` to signal the fallback to the skill layer).
- `exporter.ts` / `importer.ts` / `migrator.ts` — orchestrators. Export copies only; migrate is export+import+delete-source and only runs same-machine. Migrate accepts an optional `currentCwd` (wired from `process.cwd()` in `cli.ts`) and emits a "self-migration" warning when the caller is running inside the directory being moved — this is the common foot-gun when a user invokes `/sesh-mover:migrate` from the session they're trying to migrate. Import registers sessions in Claude's session index; `--no-register` skips registration (fallback for version-mismatch rejections).
- `version-adapters.ts` — schema migrations between Claude Code JSONL versions; called during import when source/target Claude versions differ.
- `config.ts` — two-tier config: user (`~/.claude-sesh-mover/config.json`) merged with project (`<cwd>/.claude-sesh-mover/config.json`); project overrides user. `loadEffectiveConfig` in `cli.ts` is the merge site.
- `summary.ts` — extracts a short session summary for export names/browse listings. The `--no-summary` flag is currently documentation-only; summaries always use fallback extraction (see commit 431c1d5).

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
3. Update `commands/<name>.md` and (if the behavior needs explanation for the skill layer) `skills/session-porter/SKILL.md`.
4. Rebuild with `npm run build` **and stage the updated `dist/`** — it's committed so installed plugins pick up the change. A commit that touches `src/` without a corresponding `dist/` update will ship a stale binary.
