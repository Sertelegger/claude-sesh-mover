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

   These values come from each bundle's own `manifest.json` — for `.tar.gz`/`.tar.zst` archives just as for directory exports — so they describe the machine the bundle was *exported from*, not this one. That's what lets the user tell two archives apart without unpacking them, so always show source platform and source project path in the picker, not just the file name.

   **Degraded entries.** An entry with `metadataAvailable: false` has `null` for `exportedAt` / `sourcePlatform` / `sourceProjectPath` / `sessionCount` — its metadata could not be read, which is not the same as "the bundle has none". List it with its name and the `metadataError` in place of those columns rather than blank or zero values, and still offer it as a selectable option (import itself unpacks the real bundle and will work if the archive is intact).

   If `metadataError` mentions **zstd** (`.tar.zst` metadata can only be read where the `zstd` binary is installed), offer to install it rather than leaving the row unexplained:
   - macOS: `brew install zstd`
   - Debian/Ubuntu/WSL: `sudo apt-get install -y zstd`

   After a successful install, re-run step 1 so the picker shows the archive's real platform, path, date, and session count. zstd is also required to *import* a `.tar.zst` bundle, so this install is worth offering before the user picks one.

4. Use AskUserQuestion to let the user pick which export to import. Always include an extra option:
   - Each found export as a selectable option (name + summary)
   - "Specify a different file path" — for exports not in the standard locations

5. If the chosen export contains multiple sessions, use AskUserQuestion to ask:
   - "Import all sessions" (recommended)
   - "Pick specific sessions" — then present individual sessions as selectable options

   For an entry with `metadataAvailable: false`, `sessions` is `[]` — that means "unknown", not "empty". Skip this question and let the step 6 dry-run report what the bundle actually contains.

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
    - If not resumable because of a version-mismatch or "session validation failed" error: offer to retry the step 9 invocation with `--no-register` appended. That imports the session content but skips the registry entry — the user won't get a `claude --resume` slot, but the JSONL is on disk. Note: after a `--no-register` import, a later normal import of the same bundle automatically imports a registered copy — the older unregistered copy remains on disk and can be deleted manually. `--allow-duplicates` is no longer needed for this case.
    - If the `--no-register` retry also fails, or if the user prefers: offer to read the imported JSONL and inject it as context into the current conversation.
    - Import is idempotent by default: check `skippedSessions` in the result. If it shows all requested sessions skipped (reason `duplicate` = identical content already imported into this project; reason `already-received` = already synced from this peer) and `importedSessions` is empty, tell the user nothing new was imported and why. If the user actually intended a re-import, re-run the step 9 invocation with `--allow-duplicates` appended.
    - If `manifest.incremental === true`, also include in the report:
      - Source machine: `<manifest.sourceMachineName>` (`<manifest.sourceMachineId>`)
      - Imported: N full sessions, M continuation sessions (for each continuation session, note "continues `<slug>`")
      - Duplicates skipped: K (count `result.warnings` entries containing "already received")

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocations and any conditional/retry branches, e.g. `--no-register` for the version-mismatch fallback, `--allow-duplicates` for the duplicate-skip retry) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
