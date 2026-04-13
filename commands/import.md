---
name: import
description: Import a previously exported Claude Code session
---

You are running the sesh-mover import command. Follow these steps:

1. List available exports:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" browse --storage all --json
   ```

2. If no exports found, respond with just: "No exported sessions found." Do NOT elaborate unless asked.

3. Present the list to the user with: date, name, summary, source platform, source project path, session count. Format as a numbered table.

4. Use AskUserQuestion to let the user pick which export to import (present each as a selectable option with the name and summary).

5. If the chosen export contains multiple sessions, use AskUserQuestion to ask:
   - "Import all sessions" (recommended)
   - "Pick specific sessions" — then present individual sessions as selectable options

6. Run a dry-run first:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" import --from "<path>" [--session-id <ids>] --target-project-path "<cwd>" --target-config-dir "<config-dir>" --dry-run
   ```

7. Present the dry-run results: path rewrites that will be applied, version adaptations, integrity status, any warnings.

8. Use AskUserQuestion to confirm: "Proceed with import" (recommended) / "Cancel".

9. Execute the import:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" import --from "<path>" [--session-id <ids>] --target-project-path "<cwd>" --target-config-dir "<config-dir>"
   ```

10. Report the result. If `resumable` is true, tell the user they can continue the session with `claude --resume <newSessionId>`. If not resumable, offer to read the imported JSONL and inject it as context into the current conversation.

To find the plugin root, search for the sesh-mover plugin directory by running:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Or check common locations: `~/.claude-tzun/plugins/cache/*/sesh-mover/*/` or `~/.claude/plugins/cache/*/sesh-mover/*/`. Cache the path for the duration of the conversation.
