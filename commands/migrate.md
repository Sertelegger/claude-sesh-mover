---
name: migrate
description: Move session(s) to a new project path or config directory (same machine only)
---

You are running the sesh-mover migrate command. This is a same-machine operation that moves sessions (export + import + cleanup). Follow these steps:

1. Determine the source project path. Use AskUserQuestion with options:
   - "Current directory (<cwd>)" (default, only if cwd has sessions in the config dir)
   - "A different path" (free-text follow-up for the absolute source path)

   **Self-migration note:** The CLI refuses to run an actual migration when the current working directory is inside the source project path (the active session's JSONL is held open and would be recreated at the old path after cleanup, leaving an orphan). If the user picks the current directory as source, tell them the migration will be blocked and recommend exiting this session, `cd`-ing to an outer dir (`~/` or the parent of the project), and starting a fresh Claude Code session there before re-running `/sesh-mover:migrate`. Merging into a target dir that already has sessions is fully supported, so the recovery flow is safe.

2. Ask the user for the target project path (use AskUserQuestion if there are obvious candidates, otherwise ask as a free-text question).

3. If applicable, ask for the source and/or target config directory (each defaults to the resolved config dir — `CLAUDE_CONFIG_DIR` or `~/.claude/`). Only prompt when the user is migrating across config dirs.

4. Use AskUserQuestion to ask scope:
   - "This session only" (recommended when source = cwd)
   - "All sessions for this project"

5. If the source and target project paths differ and the source directory exists on disk, use AskUserQuestion to ask:
   - "Yes, also rename the project directory" (recommended) — the CLI will `mv` the source directory to the target path
   - "No, only migrate session data" — the user will rename the directory themselves

6. Detect the current platform. If WSL is involved (source or target paths suggest it), auto-detect the path translation and present the mapping for the user to confirm before proceeding.

7. Run a dry-run (always pass `--source-project-path` explicitly, even when it equals cwd — this makes the command self-documenting and future-proofs it against cwd changes mid-run):
   ```bash
   node "PLUGIN_ROOT/dist/cli.js" migrate --source-project-path "<source>" --target-project-path "<target>" [--source-config-dir "<path>"] [--target-config-dir "<path>"] --scope <scope> [--session-id <id>] [--rename-dir] --dry-run
   ```
   Include `--rename-dir` in the dry-run too so the preview reflects the real plan.

8. Present what will happen:
   - Sessions that will be moved
   - Path translations that will be applied
   - Source files that will be cleaned up after successful import
   - Whether the project directory will be renamed (if user chose that option)
   - Any warnings

9. Use AskUserQuestion to confirm: "Proceed with migration" / "Cancel". Emphasize that this will delete the source session files after import, and rename the directory if that option was selected.

10. Execute:
    ```bash
    node "PLUGIN_ROOT/dist/cli.js" migrate --source-project-path "<source>" --target-project-path "<target>" [--source-config-dir "<path>"] [--target-config-dir "<path>"] --scope <scope> [--session-id <id>] [--rename-dir]
    ```
    Include `--rename-dir` only if the user chose to rename the directory in step 5.

    If the CLI returns `success: false` with an error mentioning "self-migration", do NOT retry with `--force` automatically. Present the `suggestion` field to the user and stop. Only pass `--force` if the user explicitly confirms they understand the risk AND asserts that the active Claude Code session is not in the source path.

11. Report: sessions moved, new session IDs, whether cleanup succeeded, whether directory was renamed.

To find the plugin root, search for the sesh-mover plugin directory by running:
```bash
find ~/.claude-tzun/plugins/cache ~/.claude/plugins/cache -name "plugin.json" -path "*/sesh-mover/*" 2>/dev/null | head -1 | xargs dirname | xargs dirname
```
Or check common locations: `~/.claude-tzun/plugins/cache/*/sesh-mover/*/` or `~/.claude/plugins/cache/*/sesh-mover/*/`. Cache the path for the duration of the conversation.
