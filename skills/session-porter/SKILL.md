---
name: session-porter
description: Full context for Claude Code session export/import/migration operations via sesh-mover CLI
---

# sesh-mover Session Porter Skill

This skill provides background knowledge for all sesh-mover slash commands. It is not invoked directly by users — the individual commands (export, import, migrate, browse, configure) reference this knowledge.

## CLI Location

The sesh-mover CLI is at `PLUGIN_ROOT/dist/cli.js`. To find PLUGIN_ROOT, run:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Cache this path for the duration of the conversation. Then invoke:
```bash
node "<PLUGIN_ROOT>/dist/cli.js" <command> [options]
```

All commands output structured JSON to stdout. Parse it with JSON.parse().

## Sensitive Data Warning

Exported sessions may contain API keys, tokens, passwords, or other sensitive data from the conversation or tool results. Always warn the user:
- When exporting to a project-level directory (it might get committed to git)
- When creating archives for transfer (the archive contains raw conversation data)
- Recommend adding `.claude-sesh-mover/` to `.gitignore` for project-level exports

## Detecting the Current Session

The current session ID can be found by:
1. Looking at the `sessionId` field in any JSONL entry visible in the conversation
2. Checking `~/.claude/history.jsonl` for the most recent entry matching the current project path
3. Running: `node "PLUGIN_ROOT/dist/cli.js" browse --json` and finding the session for the current path

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
