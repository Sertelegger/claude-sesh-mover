---
name: import
description: Import a previously exported Claude Code session
---

You are running the sesh-mover import command. Follow these steps:

1. List available exports:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" browse --storage all --json
   ```

2. If no exports found, use AskUserQuestion to offer:
   - "Specify a file path" — ask the user for the path to an export directory or archive
   - "Cancel"
   Do NOT give a verbose explanation of where you searched unless the user asks.

3. If exports exist, present the list with: date, name, summary, source platform, source project path, session count. Format as a numbered table.

4. Use AskUserQuestion to let the user pick which export to import. Always include an extra option:
   - Each found export as a selectable option (name + summary)
   - "Specify a different file path" — for exports not in the standard locations

5. If the chosen export contains multiple sessions, use AskUserQuestion to ask:
   - "Import all sessions" (recommended)
   - "Pick specific sessions" — then present individual sessions as selectable options

6. Run a dry-run first:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" import --from "<path>" [--session-id <ids>] --target-project-path "<cwd>" --target-config-dir "<config-dir>" --dry-run
   ```

7. Present the dry-run results: path rewrites that will be applied, version adaptations, integrity status, any warnings.

8. Use AskUserQuestion to confirm: "Proceed with import" (recommended) / "Cancel".

9. Execute the import:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" import --from "<path>" [--session-id <ids>] --target-project-path "<cwd>" --target-config-dir "<config-dir>"
   ```

10. Report the result.
    - If `resumable` is true: tell the user they can continue the session with `claude --resume <newSessionId>`.
    - If not resumable because of a version-mismatch or "session validation failed" error: offer to retry the step 9 invocation with `--no-register` appended. That imports the session content but skips the registry entry — the user won't get a `claude --resume` slot, but the JSONL is on disk.
    - If the `--no-register` retry also fails, or if the user prefers: offer to read the imported JSONL and inject it as context into the current conversation.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocations and any conditional/retry branches, e.g. `--no-register` for the version-mismatch fallback) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
