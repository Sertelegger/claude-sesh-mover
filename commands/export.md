---
name: export
description: Export the current Claude Code session or all sessions for this project
---

You are running the sesh-mover export command. Follow these steps:

1. Detect the current session ID from the conversation context: look at the `sessionId` field in any recent tool result in this conversation. Do not use `sesh-mover browse` — it lists previously-exported bundles, not live sessions. If the session ID isn't obvious, list `<configDir>/projects/<encoded-path>/*.jsonl` and ask the user to pick.

2. Ask the user configuration questions using the AskUserQuestion tool to present selectable options. Ask one question at a time (unless the user has config defaults set, in which case skip those questions). The labels below are what the user sees; the `→` arrow shows which CLI flag value to pass in step 4.

   **Question 1 — Scope:**
   Use AskUserQuestion with options:
   - "This session only" (default/recommended) → `--scope current`
   - "All sessions in this project" → `--scope all`

   **Question 2 — Storage:**
   Use AskUserQuestion with options:
   - "User level (~/.claude-sesh-mover/)" (recommended) → `--storage user`
   - "Project level (.claude-sesh-mover/)" → `--storage project`

   **Question 3 — Format:**
   Use AskUserQuestion with options:
   - "Directory (recommended)" — inspectable, git-friendly → `--format dir`
   - "Archive (tar.gz)" — single portable file → `--format archive`
   - "Archive (tar.zst)" — faster compression, requires zstd → `--format zstd`

   **Question 4 — Layers:** (AskUserQuestion enforces `maxItems: 4`, so the three low-traffic auxiliary layers are grouped.)
   Use AskUserQuestion with multiSelect: true and options:
   - "Include everything (recommended)" → omit `--exclude`
   - "Exclude file-history" → add `file-history` to `--exclude`
   - "Exclude tool-results" → add `tool-results` to `--exclude`
   - "Exclude memory/plans/subagents" → add `memory plans subagents` to `--exclude`

   Only ask for individual exclusion of memory, plans, or subagents if the user explicitly requests that granularity after seeing the grouped option.

3. Generate a one-line summary of the session by reading the first few exchanges, then describe it in ~100 characters.

4. Run the CLI command, substituting the values mapped in the questions above:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" export --scope <current|all> --session-id <id> --storage <user|project> --format <dir|archive|zstd> [--exclude <layer1> <layer2> ...] --name "<name>" --source-config-dir "<config-dir>"
   ```
   Never pass user-facing labels (e.g. `tar.zst`, `project`) as flag values — always pass the mapped CLI value (`zstd`, `all`, etc.). The CLI also accepts `tar.gz`/`tar.zst` as aliases for `archive`/`zstd`, but prefer the canonical values.

5. Parse the JSON output. If `collision` is true, use AskUserQuestion with options, then re-run the step 4 invocation with the corresponding flag appended:
   - "Keep both (append suffix)" — append `--suffix` and re-run
   - "Overwrite existing export" — append `--overwrite` and re-run
   - "Cancel" — stop, do not re-run

6. If archive was requested, the result's `archivePath` is the single artifact — the staging directory is removed automatically. Report `archivePath` as the destination; do not mention a separate directory.

7. Report what was exported: session name, summary, layers included, destination path.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocation and any conditional/retry branches, e.g. `--suffix`/`--overwrite` for collision handling) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
