---
name: browse
description: List all exported sessions with identifying information
---

You are running the sesh-mover browse command. Follow these steps:

1. List all exports:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" browse --storage all --json
   ```

2. If the result has zero exports, respond with just: "No exported sessions found." Do NOT explain where you checked unless the user specifically asks. The CLI already scans ~/.claude-sesh-mover/, <cwd>/.claude-sesh-mover/, and the current directory for export bundles and archives.

3. If exports exist, present the results as a formatted table:
   ```
   #  Date        Name                   Summary                                          Platform  Sessions  Storage
   1  2026-04-11  sesh-mover-design      Designing a session migration plugin             darwin    1         user
   2  2026-04-09  fix-auth-middleware     Debugging JWT token expiry in auth middleware    wsl2      3         project
   ```

4. If the user asks about a specific export, read its manifest for more details (individual sessions, layers, source info).

5. If the user wants to import one, invoke the import command flow.

6. If the user wants to delete old exports, confirm which one, then delete the directory directly.

To find the plugin root, search for the sesh-mover plugin directory by running:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Or check common locations: `~/.claude-tzun/plugins/cache/*/sesh-mover/*/` or `~/.claude/plugins/cache/*/sesh-mover/*/`. Cache the path for the duration of the conversation.
