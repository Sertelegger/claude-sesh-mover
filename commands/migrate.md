---
name: migrate
description: Move session(s) to a new project path or config directory (same machine only)
---

You are running the sesh-mover migrate command. This is a same-machine operation that moves sessions (export + import + cleanup). Follow these steps:

1. Ask the user for the target project path (use AskUserQuestion if there are obvious candidates, otherwise ask as a free-text question).

2. If applicable, ask for the target config directory.

3. Use AskUserQuestion to ask scope:
   - "This session only" (recommended)
   - "All sessions for this project"

4. If the source and target project paths differ and the source directory exists, use AskUserQuestion to ask:
   - "Yes, also rename the project directory" (recommended) — the CLI will `mv` the source directory to the target path
   - "No, only migrate session data" — the user will rename the directory themselves

5. Detect the current platform. If WSL is involved (source or target paths suggest it), auto-detect the path translation and present the mapping for the user to confirm before proceeding.

6. Run a dry-run:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" migrate --target-project-path "<path>" [--target-config-dir "<path>"] --scope <scope> [--session-id <id>] --dry-run
   ```

7. Present what will happen:
   - Sessions that will be moved
   - Path translations that will be applied
   - Source files that will be cleaned up after successful import
   - Whether the project directory will be renamed (if user chose that option)
   - Any warnings

8. Use AskUserQuestion to confirm: "Proceed with migration" / "Cancel". Emphasize that this will delete the source session files after import, and rename the directory if that option was selected.

9. Execute:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" migrate --target-project-path "<path>" [--target-config-dir "<path>"] --scope <scope> [--session-id <id>] [--rename-dir]
   ```
   Include `--rename-dir` only if the user chose to rename the directory in step 4.

10. Report: sessions moved, new session IDs, whether cleanup succeeded, whether directory was renamed.

To find the plugin root, search for the sesh-mover plugin directory by running:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Or check common locations: `~/.claude-tzun/plugins/cache/*/sesh-mover/*/` or `~/.claude/plugins/cache/*/sesh-mover/*/`. Cache the path for the duration of the conversation.
