---
name: browse
description: Browse exported sessions — view, import, or delete
---

You are running the sesh-mover browse command. Follow these steps:

1. List all exports:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" browse --storage all --json
   ```

2. If the result has zero exports, respond with just: "No exported sessions found." Do NOT explain where you checked unless the user specifically asks.

3. If exports exist, present the results as a formatted table:
   ```
   #  Date        Name                 Summary                                        Platform  Source path                Sessions  Storage
   1  2026-04-11  sesh-mover-design    Designing a session migration plugin           darwin    /Users/sam/dev/sesh-mover  1         user
   2  2026-04-09  fix-auth-middleware  Debugging JWT token expiry in auth middleware  wsl2      /mnt/e/GitHub/api-gateway  3         project
   3  —           broken-bundle.tar.gz  (metadata unreadable: TAR_BAD_ARCHIVE: Unrecognized archive format)
   ```

   `exportedAt`, `sourcePlatform`, `sourceProjectPath`, and `sessionCount` are the **exporting** machine's values, read from each bundle's own `manifest.json` — for `.tar.gz`/`.tar.zst` archives as well as for directory exports. A bundle exported on WSL and browsed on a Mac lists as `wsl2` with its WSL path; never relabel it with the local platform.

   **Degraded entries.** An entry with `metadataAvailable: false` had unreadable metadata: every manifest-derived field is `null` (never a stand-in value), `sessions` is `[]`, and `metadataError` says why. Show the name and that error in place of the metadata columns, as in row 3 above — never blanks or zeros — and keep listing every other export normally. These entries sort last.

   If `metadataError` mentions **zstd** (`.tar.zst` archives can only be read where the `zstd` binary is installed), don't leave the user with an unexplained row — offer to install it:
   - macOS: `brew install zstd`
   - Debian/Ubuntu/WSL: `sudo apt-get install -y zstd`

   After the user accepts and the install succeeds, re-run step 1 so the affected archives show their real metadata.

   Reading `.tar.zst` metadata decompresses the whole bundle to a temp file first, so `browse` over many large zstd archives is IO-bound in total archive size — it can take a few seconds. That is expected, not a hang.

4. Use AskUserQuestion to let the user pick an export (each as a selectable option with name + summary), plus a "Cancel" option.

5. Once an export is selected, use AskUserQuestion to ask what to do:
   - "Import to current project" — proceed with the import flow (dry-run, confirm, execute, report)
   - "View details" — show the full manifest: individual sessions (ID, summary, date, message count), included layers, source platform, source path, Claude version, integrity hashes. For an entry with `metadataAvailable: false` there is no manifest to show (`sessions` is `[]`): report the `metadataError` instead, plus the zstd install offer above when it applies, and offer "Delete" as the other option.
   - "Delete" — confirm with AskUserQuestion ("Yes, delete" / "Cancel"), then delete the export directory or archive

6. After completing an action, if the user chose "View details", offer the import/delete options again for the same export.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocation above; do not search the plugin cache. The flag set documented in this file (in both the main invocation and any conditional branches) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
