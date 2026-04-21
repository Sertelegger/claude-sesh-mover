---
name: session-porter
description: Full context for Claude Code session export/import/migration operations via sesh-mover CLI
---

# sesh-mover Session Porter Skill

This skill provides background knowledge for all sesh-mover slash commands. It is not invoked directly by users — the individual commands (export, import, migrate, browse, configure) reference this knowledge.

## CLI Location

The sesh-mover CLI is at `${CLAUDE_PLUGIN_ROOT}/dist/cli.js`. Claude Code sets `CLAUDE_PLUGIN_ROOT` automatically inside plugin command execution, so **no plugin-cache discovery is needed** — invoke directly:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <command> [options]
```
Do not run `find` over `~/.claude*/plugins/cache` to locate the plugin; the env var is authoritative.

All commands output structured JSON to stdout. Parse it with JSON.parse().

## Do Not Probe the CLI

Each command file (`commands/*.md`) lists the exact CLI invocation it should produce, with every flag spelled out. **Do not run the CLI with `--help`, with no arguments, or with `-h` to discover its surface** — the command file is the authoritative reference. If a flag you need isn't listed there, the command file is wrong; fix it rather than working around it at runtime.

## Sensitive Data Warning

Exported sessions may contain API keys, tokens, passwords, or other sensitive data from the conversation or tool results. Always warn the user:
- When exporting to a project-level directory (it might get committed to git)
- When creating archives for transfer (the archive contains raw conversation data)
- Recommend adding `.claude-sesh-mover/` to `.gitignore` for project-level exports

## Detecting the Current Session

The current session ID can be found by:
1. Looking at the `sessionId` field in any recent tool result in the current conversation (fastest; always available mid-session)
2. Listing `<configDir>/projects/<encoded-project-path>/*.jsonl` — each filename (minus `.jsonl`) is a session ID for that project

Do **not** use `sesh-mover browse` to find live session IDs — `browse` only lists previously-exported bundles, not live sessions. There is no `--project` flag on `browse`.

## Config Directory Detection

The Claude config directory is resolved in order:
1. `--source-config-dir` / `--target-config-dir` flags
2. `CLAUDE_CONFIG_DIR` environment variable
3. `~/.claude/` default

The user may have multiple config dirs (e.g., `~/.claude` and `~/.claude-tzun`). Always detect or ask rather than assuming.

## Error Handling

When a CLI command returns `{"success": false, ...}`:
- Read the `error` and `details` fields
- If `suggestion` is present, offer it to the user
- Common errors:
  - "No sessions found" — wrong project path or config dir
  - "Session validation failed" — version mismatch, suggest `--no-register`
  - "Integrity check failed" — data corruption during transfer

When import registration fails (session not resumable):
- Offer to read the imported JSONL and inject the conversation as context into a new session
- This is the fallback for when Claude Code's internal validation rejects the imported session

## Platform Notes

- WSL paths: `/home/user/...` and `/mnt/c/...`
- Windows paths: `C:\Users\user\...`
- macOS paths: `/Users/user/...`
- Linux paths: `/home/user/...`

The CLI auto-detects the current platform and translates paths during import. For WSL <-> Windows, it shows the mapping and asks for confirmation.

## Incremental Sync

sesh-mover supports incremental export/import between machines. Key concepts:

- **Machine identity:** each machine has a persistent ID in `~/.claude-sesh-mover/machine-id.json`, auto-created on first incremental op. The human-readable name defaults to the hostname and can be overridden with `sesh-mover configure --set machine.name=<label>`.
- **Per-project sync state:** `~/.claude-sesh-mover/sync-state/<encoded-project-path>.json` tracks, per peer machine, what's been sent and received.
- **Incremental export:** `export --incremental --to <peer>` emits only new sessions + continuation sessions for sessions with new messages since the last sync. `--since <path>` is a stateless fallback when no peer state exists (e.g. the user received an export bundle from a new machine).
- **Continuation session:** a new session whose first entry is a synthetic user message explaining the lineage. The body is the sliced remainder of the source session. This avoids merge conflicts entirely and lets Claude see the lineage directly in the transcript.
- **Idempotent import:** re-importing the same bundle is safe — already-received sessions are skipped with a warning.

When users ask "why are there two sessions that look like the same conversation?" — check `~/.claude-sesh-mover/sync-state/<encoded>.json`'s `lineage` map. The continuation header in the JSONL also spells out the origin session.
