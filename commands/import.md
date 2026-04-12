---
name: import
description: Import a previously exported Claude Code session
---

You are running the sesh-mover import command. Follow these steps:

1. List available exports:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" browse --storage all --json
   ```

2. Present the list to the user with: date, name, summary, source platform, source project path, session count. Format as a numbered table.

3. Ask which export to import.

4. If the chosen export contains multiple sessions, present the individual sessions (ID, summary, date, message count) and ask:
   - Import all sessions?
   - Import specific ones? (let user pick by number)

5. Run a dry-run first:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" import --from "<path>" [--session-id <ids>] --target-project-path "<cwd>" --target-config-dir "<config-dir>" --dry-run
   ```

6. Present the dry-run results: path rewrites that will be applied, version adaptations, integrity status, any warnings.

7. Ask the user to confirm.

8. Execute the import:
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" import --from "<path>" [--session-id <ids>] --target-project-path "<cwd>" --target-config-dir "<config-dir>"
   ```

9. Report the result. If `resumable` is true, tell the user they can continue the session with `claude --resume <newSessionId>`. If not resumable, offer to read the imported JSONL and inject it as context into the current conversation.

To find the plugin root, search for the sesh-mover plugin directory by running:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Or check common locations: `~/.claude-tzun/plugins/cache/*/sesh-mover/*/` or `~/.claude/plugins/cache/*/sesh-mover/*/`. Cache the path for the duration of the conversation.
