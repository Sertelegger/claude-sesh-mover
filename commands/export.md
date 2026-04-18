---
name: export
description: Export the current Claude Code session or all sessions for this project
---

You are running the sesh-mover export command. Follow these steps:

1. Detect the current session ID from the conversation context (look at the sessionId in any recent tool result, or use `sesh-mover browse` to find sessions for the current project path).

2. Ask the user configuration questions using the AskUserQuestion tool to present selectable options. Ask one question at a time (unless the user has config defaults set, in which case skip those questions):

   **Question 1 — Scope:**
   Use AskUserQuestion with options:
   - "This session only" (default/recommended)
   - "All sessions for this project"

   **Question 2 — Storage:**
   Use AskUserQuestion with options:
   - "User level (~/.claude-sesh-mover/)" (recommended)
   - "Project level (.claude-sesh-mover/)"

   **Question 3 — Format:**
   Use AskUserQuestion with options:
   - "Directory (recommended)" — inspectable, git-friendly
   - "Archive (tar.gz)" — single portable file
   - "Archive (tar.zst)" — faster compression, requires zstd

   **Question 4 — Layers:**
   Use AskUserQuestion with multiSelect: true and options:
   - "Include everything (recommended)" 
   - "Exclude file-history"
   - "Exclude tool-results"
   - "Exclude memory"
   - "Exclude plans"
   - "Exclude subagents"

3. Generate a one-line summary of the session by reading the first few exchanges, then describe it in ~100 characters.

4. Run the CLI command:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" export --scope <scope> --session-id <id> --storage <storage> --format <format> [--exclude <layers>] --name "<name>" --source-config-dir "<config-dir>"
   ```

5. Parse the JSON output. If `collision` is true, use AskUserQuestion with options, then re-run the step 4 invocation with the corresponding flag appended:
   - "Keep both (append suffix)" — append `--suffix` and re-run
   - "Overwrite existing export" — append `--overwrite` and re-run
   - "Cancel" — stop, do not re-run

6. If archive was requested, the result's `archivePath` is the single artifact — the staging directory is removed automatically. Report `archivePath` as the destination; do not mention a separate directory.

7. Report what was exported: session name, summary, layers included, destination path.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocation and any conditional/retry branches, e.g. `--suffix`/`--overwrite` for collision handling) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
