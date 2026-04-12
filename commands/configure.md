---
name: configure
description: Set user or project level defaults for sesh-mover commands
---

You are running the sesh-mover configure command. Follow these steps:

1. Show current effective config:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" configure --show --json
   ```

2. Present the current settings grouped by command:
   - **Export defaults:** storage (user/project), format (dir/archive/zstd), excluded layers, scope (current/all), summary generation
   - **Import defaults:** dry-run first (true/false)
   - **Migrate defaults:** scope (current/all)

3. Ask the user which settings they want to change.

4. For each change, apply it:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" configure --scope <user|project> --set "<key>=<value>"
   ```

5. Confirm what was saved and at which scope level.

Configurable keys:
- `export.storage` — "user" or "project"
- `export.format` — "dir", "archive", or "zstd"
- `export.exclude` — JSON array like `["file-history","plans"]`
- `export.scope` — "current" or "all"
- `export.noSummary` — true or false
- `import.dryRunFirst` — true or false
- `migrate.scope` — "current" or "all"

To find the plugin root, search for the sesh-mover plugin directory by running:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Or check common locations: `~/.claude-tzun/plugins/cache/*/sesh-mover/*/` or `~/.claude/plugins/cache/*/sesh-mover/*/`. Cache the path for the duration of the conversation.
