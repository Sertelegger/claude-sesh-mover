---
name: migrate
description: Move session(s) to a new project path or config directory (same machine only)
---

You are running the sesh-mover migrate command. This is a same-machine operation that moves sessions (export + import + cleanup of the source). Follow these steps:

1. Determine the source project path. Use AskUserQuestion with options:
   - "Current directory (<cwd>)" (default, only if cwd has sessions in the config dir)
   - "A different path" (free-text follow-up for the absolute source path)

   **Self-migration note:** The CLI refuses to run an actual migration when the current working directory is inside the source project path (the active session's JSONL is held open and would be recreated at the old path after cleanup, leaving an orphan). A `--dry-run` is still allowed through, and carries a `Self-migration detected: …` warning. If the user picks the current directory as source, tell them the real run will be blocked and recommend exiting this session, `cd`-ing to an outer dir (`~/` or the parent of the project), and starting a fresh Claude Code session there before re-running `/sesh-mover:migrate`. Merging into a target dir that already has sessions is fully supported, so the recovery flow is safe.

2. Ask the user for the target project path (use AskUserQuestion if there are obvious candidates, otherwise ask as a free-text question).

3. If applicable, ask for the source and/or target config directory (each defaults to the resolved config dir — `CLAUDE_CONFIG_DIR` or `~/.claude/`). Only prompt when the user is migrating across config dirs.

4. Use AskUserQuestion to ask scope:
   - "This session only" (recommended when source = cwd)
   - "All sessions for this project"

   **Note:** "This session only" requires a session ID — the CLI refuses `--scope current` without `--session-id` (it returns an error rather than silently migrating and deleting every session for the project). If the user picks "This session only", make sure you have a session ID (see "Detecting the Current Session" in the skill doc) before running steps 7 and 10, and always pass `--session-id` alongside `--scope current`.

5. If the source and target project paths differ and the source directory exists on disk, use AskUserQuestion to ask:
   - "Yes, also rename the project directory" (recommended) — the CLI will `mv` the source directory to the target path
   - "No, only migrate session data" — the user will rename the directory themselves

   The `mv` is **conditional**, not guaranteed. The CLI skips it — with a warning, and `directoryRenamed: false` — when the target directory already exists (it will not overwrite), when the source directory does not exist, or when the two project paths are identical. Session data still migrates in all of those cases; only the directory move is skipped. Step 7's dry-run tells you which of these applies before anything is deleted, so don't promise the user a rename the preview didn't predict.

6. Detect the current platform. If WSL is involved (source or target paths suggest it), auto-detect the path translation and present the mapping for the user to confirm before proceeding.

7. Run a dry-run (always pass `--source-project-path` explicitly, even when it equals cwd — this makes the command self-documenting and future-proofs it against cwd changes mid-run):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" migrate --source-project-path "<source>" --target-project-path "<target>" [--source-config-dir "<path>"] [--target-config-dir "<path>"] --scope <scope> [--session-id <id>] [--rename-dir] --dry-run
   ```
   Pass `--rename-dir` in the dry-run whenever you intend to pass it in step 10 — the preview evaluates the real `mv` preconditions and reports the answer in `directoryRenamed`, so the flag changes the preview. A dry-run without it can say nothing about a rename you are about to perform.

8. Present what will happen, using only what the result actually carries:
   - **Sessions that will be moved** — one line per entry in `importedSessions` (`originalId`, `slug`, `messageCount`). `newId` is the id the session gets at the target; on a dry-run it is a preview id, not the id the real run will assign.
   - **Sessions that will be skipped** — `skippedSessions[]`, each with a `reason` of `"duplicate"` or `"already-received"`. These are *not* failures: identical content already exists at the target, and the source copy is deleted anyway (migrate semantics: the source ends up gone).
   - **Source files that will be deleted** — the result carries no file list. Cleanup deletes, for every id in `importedSessions[].originalId` **and** `skippedSessions[].originalId`: `<sourceConfigDir>/projects/<encoded-source-path>/<id>.jsonl`, that session's subdirectory beside it (subagents, tool-results), and `<sourceConfigDir>/file-history/<id>/`. Name the session ids; don't invent paths beyond that. `cleanedUp` is the boolean summary (on a dry-run, "cleanup would run").
   - **Whether the project directory will be renamed** — `directoryRenamed`, plus the explaining warning when it is `false` (see step 5).
   - **`sourcePath` → `targetPath`** — the one path rewrite migrate reports. There is no per-path translation report in a migrate result; do not claim to list individual rewritten paths.
   - **Any `warnings`.**

   On a dry-run the result carries `dryRun: true`, and *every* field above is a prediction — `cleanedUp` and `directoryRenamed` mean "would happen", not "happened". A real run has no `dryRun` field and those same booleans are facts. Say which one you are reporting.

9. Use AskUserQuestion to confirm: "Proceed with migration" / "Cancel". Emphasize that this will delete the source session files after import, and — only if the dry-run predicted `directoryRenamed: true` — that it will move the project directory.

10. Execute:
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" migrate --source-project-path "<source>" --target-project-path "<target>" [--source-config-dir "<path>"] [--target-config-dir "<path>"] --scope <scope> [--session-id <id>] [--rename-dir]
    ```
    Include `--rename-dir` only if the user chose to rename the directory in step 5.

    If the CLI returns `success: false` with an error mentioning "self-migration", do NOT retry with `--force` automatically. Present the `suggestion` field to the user and stop. Only pass `--force` if the user explicitly confirms they understand the risk AND asserts that the active Claude Code session is not in the source path.

11. Report: sessions moved (`importedSessions`, with `newId` — this is the id to resume by), sessions skipped as duplicates, whether cleanup ran (`cleanedUp`), whether the directory was renamed (`directoryRenamed`, with the reason from `warnings` when it was not), and any remaining warnings.

## Other flags

- `--exclude <layers...>` — omit layers from the move: `subagents`, `tool-results`, `file-history`, `memory`, `plans`. (`jsonl` is accepted but has no effect — the transcript is always carried.) **On a migrate this is destructive, not selective:** cleanup deletes each moved session's subdirectory and file-history directory wholesale, so an excluded layer is neither copied to the target nor left at the source — it is gone. The result does not warn about this. Only pass `--exclude` when the user has asked for it and has been told the layer will be lost; if they just want a lighter copy, `/sesh-mover:export` is the non-destructive command.
- `--force` — overrides the self-migration block only. See step 10; never pass it on your own initiative.
- `--progress` — emits NDJSON progress events on stderr. It is oriented at humans running the CLI directly; don't pass it from this command flow.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocations, the "Other flags" section, and any conditional/retry branches, e.g. `--force` for the self-migration override path described in step 10) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
