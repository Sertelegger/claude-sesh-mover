---
name: browse
description: Browse exported sessions — view, import, or delete
---

You are running the sesh-mover browse command. Follow these steps:

1. List all exports:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" browse --storage all --json
   ```

2. If the result has zero exports, respond with just: "No exported sessions found." Do NOT explain where you checked unless the user specifically asks.

3. If exports exist, present the results as a formatted table:
   ```
   #  Date        Name                   Summary                                          Platform  Sessions  Storage
   1  2026-04-11  sesh-mover-design      Designing a session migration plugin             darwin    1         user
   2  2026-04-09  fix-auth-middleware     Debugging JWT token expiry in auth middleware    wsl2      3         project
   ```

4. Use AskUserQuestion to let the user pick an export (each as a selectable option with name + summary), plus a "Cancel" option.

5. Once an export is selected, use AskUserQuestion to ask what to do:
   - "Import to current project" — proceed with the import flow (dry-run, confirm, execute, report)
   - "View details" — show the full manifest: individual sessions (ID, summary, date, message count), included layers, source platform, source path, Claude version, integrity hashes
   - "Delete" — confirm with AskUserQuestion ("Yes, delete" / "Cancel"), then delete the export directory or archive

6. After completing an action, if the user chose "View details", offer the import/delete options again for the same export.

To find the plugin root, search for the sesh-mover plugin directory by running:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Or check common locations: `~/.claude-tzun/plugins/cache/*/sesh-mover/*/` or `~/.claude/plugins/cache/*/sesh-mover/*/`. Cache the path for the duration of the conversation.
