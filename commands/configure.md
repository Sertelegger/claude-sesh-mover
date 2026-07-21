---
name: configure
description: Set user or project level defaults for sesh-mover commands
---

You are running the sesh-mover configure command. Follow these steps:

1. Show current effective config:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" configure --show --json
   ```

2. Present the current settings grouped by command:
   - **Export defaults:** storage (user/project), format (dir/archive/zstd), excluded layers, scope (current/all), summary generation
   - **Import defaults:** dry-run first (true/false)
   - **Migrate defaults:** scope (current/all)
   - **Hub defaults:** hub path (set via `/sesh-mover:hub-init`), workspace snapshot on push (on/off)

3. Ask the user which settings they want to change.

4. For each change, apply it:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" configure --scope <user|project> --set "<key>=<value>"
   ```

5. Confirm what was saved and at which scope level.

Configurable keys:
- `export.storage` — "user" or "project"
- `export.format` — "dir", "archive", or "zstd"
- `export.exclude` — JSON array like `["file-history","plans"]`
- `export.scope` — "current" or "all"
- `export.noSummary` — true or false (functional: when true, exports use a slug-only manifest summary and skip parsing conversation text for it; the exported session JSONL itself is unaffected)
- `import.dryRunFirst` — true or false
- `migrate.scope` — "current" or "all"
- `hub.path` — absolute path to the hub directory ("" = not configured; normally set via `/sesh-mover:hub-init` rather than by hand)
- `hub.noWorkspace` — true or false (when true, `push` skips the workspace snapshot for non-git projects by default)

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocations and any conditional branches) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
