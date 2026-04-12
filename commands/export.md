---
name: export
description: Export the current Claude Code session or all sessions for this project
---

You are running the sesh-mover export command. Follow these steps:

1. Detect the current session ID from the conversation context (look at the sessionId in any recent tool result, or use `sesh-mover browse` to find sessions for the current project path).

2. Ask the user (unless they specified in their command):
   - Export this session only, or all sessions for this project?
   - Store at user level (~/.claude-sesh-mover/) or project level (.claude-sesh-mover/)?
   - Exclude any layers? (file-history, tool-results, memory, plans, subagents) — default is include all
   - Directory or archive format? (dir, archive/tar.gz, zstd/tar.zst)

3. Generate a one-line summary of the session by reading the first few exchanges, then describe it in ~100 characters.

4. Run the CLI command:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" export --scope <scope> --session-id <id> --storage <storage> --format <format> [--exclude <layers>] --name "<name>" --source-config-dir "<config-dir>"
   ```

5. Parse the JSON output. If `collision` is true, ask the user:
   - Keep both (append suffix)
   - Overwrite
   - Cancel

6. If archive was requested and the result has `archivePath`, report both the directory and archive locations.

7. Report what was exported: session name, summary, layers included, destination path.

To find the plugin root, search for the sesh-mover plugin directory by running:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Or check common locations: `~/.claude-tzun/plugins/cache/*/sesh-mover/*/` or `~/.claude/plugins/cache/*/sesh-mover/*/`. Cache the path for the duration of the conversation.
