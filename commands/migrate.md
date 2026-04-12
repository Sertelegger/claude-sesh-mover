---
name: migrate
description: Move session(s) to a new project path or config directory (same machine only)
---

You are running the sesh-mover migrate command. This is a same-machine operation that moves sessions (export + import + cleanup). Follow these steps:

1. Ask the user:
   - What is the target project path?
   - (If applicable) What is the target config directory?
   - Migrate this session only, or all sessions for the current project?

2. Detect the current platform. If WSL is involved (source or target paths suggest it), auto-detect the path translation and present the mapping for the user to confirm before proceeding.

3. Run a dry-run:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" migrate --target-project-path "<path>" [--target-config-dir "<path>"] --scope <scope> [--session-id <id>] --dry-run
   ```

4. Present what will happen:
   - Sessions that will be moved
   - Path translations that will be applied
   - Source files that will be cleaned up after successful import
   - Any warnings

5. Ask the user to confirm. Emphasize that this will delete the source session files after import.

6. Execute:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" migrate --target-project-path "<path>" [--target-config-dir "<path>"] --scope <scope> [--session-id <id>]
   ```

7. Report: sessions moved, new session IDs, whether cleanup succeeded.

To find the plugin root, search for the sesh-mover plugin directory by running:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Or check common locations: `~/.claude-tzun/plugins/cache/*/sesh-mover/*/` or `~/.claude/plugins/cache/*/sesh-mover/*/`. Cache the path for the duration of the conversation.
