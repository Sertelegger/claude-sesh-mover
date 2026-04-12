# sesh-mover Design Spec

> A Claude Code plugin for migrating sessions between machines, platforms, config directories, and project paths.

## Overview

sesh-mover is a marketplace-publishable Claude Code plugin that provides slash commands for exporting, importing, and migrating Claude Code sessions. It solves the problem that Claude Code sessions are machine-local and tied to absolute filesystem paths, making it impossible to continue work when switching between machines (especially Windows <-> WSL), moving projects to new directories, or switching between Claude config directories.

## Architecture: Hybrid (Node.js Core + Rich Skills)

A Node.js core library handles deterministic, I/O-heavy work: session discovery, JSONL parsing/rewriting, path translation, archive creation, file copying, and index registration. Slash commands provide the conversational UX: browsing sessions, confirming options, explaining what will happen, and handling edge cases.

**Rationale:** Node.js is a zero-cost dependency — Claude Code itself requires it on every platform. The core operations (rewriting megabytes of JSONL, translating Windows paths, creating tar archives) must be deterministic code, not prompt-driven. Claude handles what it's good at: presenting choices, explaining trade-offs, troubleshooting failures.

## Operations

Two distinct operations:

| Operation | Scope | Cleanup | Use Case |
|-----------|-------|---------|----------|
| **Export** | Cross-machine safe | Never (copy only) | Transfer sessions to another machine |
| **Migrate** | Same-machine only (incl. Win<->WSL) | Deletes source after success | Move to different path or config dir |

## Plugin Structure

```
sesh-mover/
├── .claude-plugin/
│   └── plugin.json              # Manifest: name, version, commands list
├── package.json                 # Node.js package, TypeScript deps
├── tsconfig.json
├── src/
│   ├── cli.ts                   # CLI entry point
│   ├── discovery.ts             # Find sessions in Claude config dir
│   ├── exporter.ts              # Read session data, build export bundle
│   ├── importer.ts              # Write session data to target, register in index
│   ├── migrator.ts              # Orchestrate export + import + cleanup
│   ├── rewriter.ts              # Rewrite paths, UUIDs, timestamps in JSONL
│   ├── archiver.ts              # tar.gz creation/extraction
│   ├── platform.ts              # OS detection, WSL path translation
│   ├── manifest.ts              # Export manifest read/write
│   └── version-adapters.ts     # Schema migration between Claude Code versions
├── dist/                        # Compiled JS (shipped with plugin)
├── commands/
│   ├── export.md                # /sesh-mover:export
│   ├── import.md                # /sesh-mover:import
│   ├── migrate.md               # /sesh-mover:migrate
│   ├── browse.md                # /sesh-mover:browse
│   └── configure.md             # /sesh-mover:configure
├── skills/
│   └── session-porter/
│       └── SKILL.md             # Full context for Claude (CLI reference, error handling)
├── tests/
│   ├── rewriter.test.ts
│   ├── platform.test.ts
│   └── fixtures/                # Sample JSONL, manifests for testing
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-04-11-sesh-mover-design.md  # This file
```

## Export Bundle Format

### Directory Structure

```
<export-name>/
├── manifest.json
├── sessions/
│   ├── <sessionId>.jsonl
│   └── <sessionId>/
│       ├── subagents/
│       │   ├── agent-<id>.jsonl
│       │   └── agent-<id>.meta.json
│       └── tool-results/
│           └── toolu_<id>.txt
├── file-history/
│   └── <sessionId>/
│       └── <hash>@v<N>
├── memory/
│   ├── MEMORY.md
│   └── *.md
└── plans/
    └── *.md
```

### Manifest (manifest.json)

```json
{
  "version": 1,
  "plugin": "sesh-mover",
  "exportedAt": "2026-04-11T14:32:00Z",
  "sourcePlatform": "darwin|linux|wsl1|wsl2|win32",
  "sourceProjectPath": "/Users/sascha/Projects/foo",
  "sourceConfigDir": "/Users/sascha/.claude",
  "sourceClaudeVersion": "2.1.81",
  "sessionScope": "current|all",
  "includedLayers": ["jsonl", "subagents", "file-history", "tool-results", "memory", "plans"],
  "sessions": [
    {
      "sessionId": "original-uuid",
      "slug": "session-human-readable-name",
      "summary": "One-line description of what this session was about",
      "createdAt": "2026-04-09T12:00:00Z",
      "lastActiveAt": "2026-04-11T14:30:00Z",
      "messageCount": 47,
      "gitBranch": "main",
      "entrypoint": "cli",
      "integrityHash": "sha256:<per-session-hash-of-jsonl-content>"
    }
  ]
}
```

### Design Decisions

- Original session IDs preserved in bundle for traceability; importer assigns new IDs on target.
- Paths inside JSONL are NOT rewritten at export time. Bundle preserves original data verbatim. Path rewriting happens at import time based on target environment.
- Layers are directories — if a layer was excluded, its directory doesn't exist. Importer checks what's present.
- Per-session integrity hash (sha256) of JSONL content stored in manifest, verified on import to detect corruption. Per-session hashes allow selective import without false corruption warnings.

### Export Storage

Dual-scope (user chooses per-export):
- **User-level**: `~/.claude-sesh-mover/` (always in home dir, independent of config dir, namespaced to this plugin)
- **Project-level**: `.claude-sesh-mover/` inside the project directory

Format options:
- **Directory** (default): inspectable, diffable, git-friendly
- **Archive** (`.tar.gz`): single portable file for cross-machine transfer
- **Archive** (`.tar.zst`): zstd compression — faster than gzip with better ratios, ideal for large exports. Requires zstd available on the system (falls back to tar.gz with a warning if not found).

### Export Naming Convention

Auto-generated: `<YYYY-MM-DD>-<slug-or-first-prompt-words>`

Examples:
- `2026-04-11-sesh-mover-design`
- `2026-04-09-fix-auth-middleware`
- `2026-04-08-all-sessions-home` (for `--scope all`)

### Name Collision Handling

When an export with the same name already exists:

1. The CLI detects the collision and returns it in the JSON output (`"collision": true, "existingPath": "..."`)
2. The skill presents three options to the user:
   - **Keep both** — append incrementing suffix (`-2`, `-3`, etc.)
   - **Overwrite** — replace the existing export
   - **Cancel** — abort the export
3. For non-interactive use, `--overwrite` forces replacement and `--suffix` forces an incrementing suffix

### Session Summary Generation

Per-session one-line summary for browsability, generated at export time by Claude (via the skill invoking the CLI with `--generate-summary`):

1. The CLI extracts the first few user/assistant exchanges from the JSONL
2. Claude reads them and produces a one-line summary (~100 chars)
3. The summary is stored in the manifest

Fallback (if running non-interactively or `--no-summary`):
1. Use the session's `slug` if descriptive (not "new-session" or a UUID)
2. Fallback: first user message truncated to ~100 chars
3. Fallback: first assistant response describing what it's doing

## Import & Session Registration

### Import Flow

**Step 1 — Read manifest, detect environment:**
- Parse manifest.json for source platform and paths
- Detect current platform
- Determine target project path (cwd or user-specified)
- Determine target config dir (auto-detect or user-specified)

**Step 1.5 — Version reconciliation:**
- Read `sourceClaudeVersion` from manifest
- Detect target Claude Code version
- Compare and classify:
  - Same version: proceed normally
  - Source newer than target: warn, may contain unknown entry types
  - Source older than target: run version adapters to upgrade schema
- Report what was adapted in dry-run output

**Step 2 — Verify integrity (before any mutation):**
- Verify per-session sha256 hashes from manifest against the exported JSONL content in the bundle
- This must happen BEFORE rewriting, since rewriting changes the content
- Warn if mismatch (potential corruption during transfer)

**Step 3 — Path rewriting:**
- Rewrite path-bearing fields in JSONL entries (see Path Rewriting section)
- Confirmed dry-run first: show user what transformations will be applied

**Step 4 — Write session files:**
- Generate new session UUID(s)
- Write rewritten JSONL to `<target-config-dir>/projects/<encoded-target-path>/<newSessionId>.jsonl`
- Copy subagent files with updated session references
- Copy tool-results
- Copy file-history to `<target-config-dir>/file-history/<newSessionId>/`
- Merge memory files into target project's memory/ (skip duplicates by filename, warn on conflicts)
- Copy plans to `<target-config-dir>/plans/`

**Step 5 — Validate before registering:**
- Verify the written JSONL is parseable and well-formed
- Verify all referenced files (subagents, tool-results, file-history) exist
- If validation fails: clean up all written files from Step 4, return error, do NOT register in indexes

**Step 6 — Register in indexes (only after successful validation):**
- Append entry to `<target-config-dir>/history.jsonl` with new session ID and target project path
- Report session is fully resumable with `--continue`/`--resume`
- If resumability still fails at runtime: fall back to context injection (read imported JSONL, present full conversation to Claude in a new session with continuation instructions)

### Memory Merge Behavior

When target project already has memory files:
- Skip files with identical filenames (assumes same content)
- Copy files with unique filenames
- Warn if filename matches but content differs; ask user which to keep

## Platform Detection & WSL Path Translation

### Platform Detection Chain

```
1. process.platform → "win32" | "darwin" | "linux"
2. If linux: check for WSL markers
   - /proc/version contains "microsoft" or "Microsoft" → WSL
   - /proc/sys/fs/binfmt_misc/WSLInterop exists → WSL
3. If WSL: detect WSL version (1 vs 2) from /proc/version
4. Result: "darwin" | "linux" | "wsl1" | "wsl2" | "win32"
```

### Path Translation Rules

| Direction | Pattern | Transform |
|-----------|---------|-----------|
| WSL → Windows | `/home/<user>/...` | `C:\Users\<user>\...` |
| WSL → Windows | `/mnt/<drive>/...` | `<DRIVE>:\...` |
| WSL → Windows | `/tmp/...` | `C:\Users\<user>\AppData\Local\Temp\...` |
| Windows → WSL | `C:\Users\<user>\...` | `/home/<user>/...` |
| Windows → WSL | `<DRIVE>:\...` | `/mnt/<drive>/...` |
| Same platform | `<sourceProjectPath>/...` | `<targetProjectPath>/...` |

### Username Handling

Source and target usernames may differ. The rewriter:
1. Extracts username from source project path
2. Extracts username from target environment (`os.userInfo()` or `$USER`)
3. If they differ, includes username mapping in translation rules
4. Shows all mappings in dry-run confirmation

### Rewrite Targets

Fields that ARE rewritten:
- `cwd` — always
- `message.content` where `type === "tool_result"` — file paths in tool output
- `toolUseResult.stdout` / `toolUseResult.stderr` — command output containing paths
- `snapshot.trackedFileBackups` keys — filenames in file-history references

Fields that are NOT rewritten:
- Assistant thinking/reasoning text — conversational context, not functional references
- User message text — preserves what the user actually typed
- Tool use `input` fields — historical records of what happened

**Philosophy:** Rewrite paths that Claude Code's runtime uses to locate files. Leave everything else as historical record.

## Config Directory Handling

The CLI resolves the Claude config dir through a priority chain:

1. **Explicit flag** (`--source-config-dir`, `--target-config-dir`) — highest priority
2. **Environment variable** (`CLAUDE_CONFIG_DIR` or equivalent)
3. **Default** `~/.claude/`

The manifest records the source config dir. Cross-config-dir migration is fully supported:

```
sesh-mover migrate --source-config-dir ~/.claude-tzun --target-config-dir ~/.claude
```

## Version Compatibility

### Version Adapter Chain

A chain of small, targeted transformers that handle known schema changes between Claude Code versions:

```typescript
interface VersionAdapter {
  fromVersion: string;      // minimum version this applies to
  toVersion: string;        // version that introduced the change
  description: string;      // human-readable explanation
  applies(entry: JsonlEntry): boolean;
  transform(entry: JsonlEntry): JsonlEntry;
}
```

### Behavior

- Adapters run in sequence, oldest-first
- Best-effort: transform what they can, pass through what they don't recognize
- Unknown entry types preserved verbatim (forward-compatible)
- Dry-run output shows which adapters fired and how many entries they touched
- If an adapter can't safely transform something, it flags a warning rather than failing

### Coverage

- Old exports on new Claude Code → adapters upgrade the schema
- New exports on old Claude Code → unknown fields pass through, warnings emitted
- Same version → adapters are no-ops

Adapters ship with the plugin and grow over time as Claude Code evolves.

## CLI Interface

### Commands

```
sesh-mover export [options]
  --scope <current|all>           Which sessions to export (default: current)
  --storage <user|project>        Where to save the export (default: user)
  --format <dir|archive|zstd>    Directory, .tar.gz, or .tar.zst (default: dir)
  --exclude <layers...>           Opt out: file-history,tool-results,memory,plans,subagents
  --source-config-dir <path>      Override Claude config dir to read from
  --session-id <id>               Export a specific session by ID
  --name <string>                 Human-readable export name (default: auto-generated)
  --output <path>                 Override export destination path
  --no-summary                    Skip Claude-generated summary, use fallback extraction

sesh-mover import [options]
  --from <path>                   Path to export directory or archive
  --session-id <id...>            Import specific session(s) from a multi-session export (default: all)
  --target-project-path <path>    Override target project path (default: cwd)
  --target-config-dir <path>      Override Claude config dir to write into
  --dry-run                       Show what would be rewritten, don't write
  --no-register                   Import files but skip index/history registration
  --force                         Skip dry-run confirmation (for scripted use)

sesh-mover migrate [options]
  --target-project-path <path>    Destination project path (required)
  --scope <current|all>           Which sessions to migrate (default: current)
  --source-config-dir <path>      Source Claude config dir
  --target-config-dir <path>      Target Claude config dir
  --exclude <layers...>           Same as export

sesh-mover browse [options]
  --storage <user|project|all>    Which exports to list (default: all)
  --source-config-dir <path>      Override config dir for discovery
  --json                          Output raw JSON (default: formatted table)
  --prune                         Interactively delete old exports

sesh-mover configure [options]
  --scope <user|project>          Which config level to set (default: user)
  --set <key=value>               Set a config value (e.g., --set export.storage=project)
  --show                          Display current effective config (merged user + project)
  --reset                         Reset config to defaults
  --json                          Output raw JSON
```

### Output Format

All commands write structured JSON to stdout:

```json
{
  "success": true,
  "command": "export",
  "exportPath": "/Users/sascha/.claude-sesh-mover/2026-04-11-sesh-mover-design",
  "sessions": [
    {
      "originalId": "abc-123",
      "slug": "sesh-mover-design",
      "summary": "Designing a session migration plugin",
      "messageCount": 47,
      "exportedLayers": ["jsonl", "subagents", "memory"]
    }
  ],
  "warnings": ["file-history excluded by user request"],
  "archivePath": null
}
```

Error output:

```json
{
  "success": false,
  "command": "import",
  "error": "Session validation failed: version mismatch",
  "details": "Export created with Claude Code 2.1.81, target is 2.0.50",
  "suggestion": "Try --no-register to import as read-only"
}
```

## Slash Commands

### /sesh-mover:export

1. Detect current session ID and project path
2. Ask: this session or all sessions for this project?
3. Ask: user-level or project-level storage?
4. Ask: exclude any layers?
5. Ask: directory or archive?
6. Invoke CLI, parse JSON result, report outcome

### /sesh-mover:import

1. Invoke `sesh-mover browse --json`
2. Present list with date, name, summary, source platform, session count
3. User picks an export
4. If the export contains multiple sessions, present the session list (ID, summary, date, message count) and ask which to import (all or specific ones)
5. Invoke `sesh-mover import --from <path> [--session-id <ids>] --dry-run`
6. Present dry-run: path rewrites, version adaptations, warnings
7. User confirms
8. Invoke `sesh-mover import --from <path> [--session-id <ids>]`
9. Report result; if registration failed, offer context-injection fallback

### /sesh-mover:migrate

1. Ask: target project path (or target config dir)
2. For WSL: auto-detect path translation, present mapping for confirmation
3. Ask: this session or all?
4. Invoke `sesh-mover migrate --dry-run`
5. Present dry-run including source cleanup plan
6. User confirms
7. Invoke `sesh-mover migrate`
8. Report result

### /sesh-mover:configure

1. Invoke `sesh-mover configure --show --json`
2. Present current effective config (merged user + project)
3. Ask which settings the user wants to change
4. Write updates via `sesh-mover configure --scope <user|project> --set key=value`
5. Confirm what was saved

### /sesh-mover:browse

1. Invoke `sesh-mover browse --json`
2. Present formatted table:
   ```
   #  Date        Name                   Summary                                          Platform  Sessions
   1  2026-04-11  sesh-mover-design      Designing a session migration plugin             darwin    1
   2  2026-04-09  fix-auth-middleware    Debugging JWT token expiry in auth middleware    wsl2      3
   3  2026-04-08  all-sessions-home      (12 sessions)                                   darwin    12
   ```
3. User can ask follow-up questions or proceed to import

## Testing Strategy

- **Unit tests**: rewriter (path translation correctness), platform detection (mock /proc/version), version adapters (fixture JSONL files), manifest parsing
- **Integration tests**: full export/import cycle with fixture sessions, verify resumability of imported sessions
- **Platform tests**: WSL path translation with various mount configurations
- **Fixtures**: sample JSONL from different Claude Code versions, sample manifests, sample file-history structures

## Configuration

### Config Files

Defaults are stored at two levels, with project overriding user:

- **User-level**: `~/.claude-sesh-mover/config.json`
- **Project-level**: `.claude-sesh-mover/config.json` in the project directory

### Configurable Defaults

```json
{
  "export": {
    "storage": "user",
    "format": "dir",
    "exclude": [],
    "scope": "current",
    "noSummary": false
  },
  "import": {
    "dryRunFirst": true
  },
  "migrate": {
    "scope": "current"
  }
}
```

### Resolution Order

For each setting: CLI flag > project config > user config > built-in default.

When any command runs, the CLI merges configs in this order and the skill respects the merged result. If a default is set, the skill skips the corresponding prompt (e.g., if `export.storage` is set to `"user"`, the skill won't ask "user-level or project-level?"). The user can always override via CLI flags.

## Future Considerations (Not in v1)

- Network transfer mode (direct machine-to-machine without intermediate file) — needs its own brainstorming session to cover scenarios like same-network, VPN, relay, port restrictions, etc.
