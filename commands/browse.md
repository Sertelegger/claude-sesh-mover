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
   #  Date        Name                  Summary                                        Platform  Source path                Sessions  Storage
   1  2026-04-11  sesh-mover-design     Designing a session migration plugin           darwin    /Users/sam/dev/sesh-mover  1         user
   2  2026-04-09  fix-auth-middleware   Debugging JWT token expiry in auth middleware  wsl2      /mnt/e/GitHub/api-gateway  3         project
   3  —           broken-bundle.tar.gz  (metadata unreadable: TAR_BAD_ARCHIVE: Unrecognized archive format)
   ```

   `exportedAt`, `sourcePlatform`, `sourceProjectPath`, and `sessionCount` are the **exporting** machine's values, read from each bundle's own `manifest.json` — for `.tar.gz`/`.tar.zst` archives as well as for directory exports. A bundle exported on WSL and browsed on a Mac lists as `wsl2` with its WSL path; never relabel it with the local platform.

   **Degraded entries.** An entry with `metadataAvailable: false` had unreadable metadata: every manifest-derived field is `null` (never a stand-in value), `sessions` is `[]`, and `metadataError` says why. Show the name and that error in place of the metadata columns, as in row 3 above — never blanks or zeros — and keep listing every other export normally. These entries sort last.

   **The zstd case.** A degraded entry whose **name ends in `.tar.zst`** is this case: `.tar.zst` bundles can only be read where the `zstd` binary is installed. Key off the name, not off the wording of `metadataError` — that field carries a free-text detail string that is not guaranteed to contain the word "zstd" (it usually will, and when it does it corroborates the name). Don't leave the user with an unexplained row — offer to install it:
   - macOS: `brew install zstd`
   - Debian/Ubuntu/WSL: `sudo apt-get install -y zstd`

   After the user accepts and the install succeeds, re-run step 1 so the affected archives show their real metadata.

   Reading `.tar.zst` metadata decompresses the whole bundle to a temp file first, so `browse` over many large zstd archives is IO-bound in total archive size — it can take a few seconds. That is expected, not a hang.

4. Use AskUserQuestion to let the user pick an export (each as a selectable option with name + summary), plus a "Cancel" option. A degraded entry has no summary to show (`sessions` is `[]`), so label it with its name plus a short "metadata unreadable" note instead — and keep it selectable: the bundle may still import fine.

5. Once an export is selected, use AskUserQuestion to ask what to do:
   - "Import to current project" — proceed with the import flow (dry-run, confirm, execute, report). Still offered for a degraded entry, but say up front that it will likely fail until the cause is fixed (install `zstd`, replace a corrupt archive), since import has to read the same bundle `browse` just couldn't.
   - "View details" — show what the browse entry actually carries, and nothing beyond it: `name`, `path`, `exportedAt`, `sourcePlatform`, `sourceProjectPath`, `sessionCount`, `storage`, plus one row per entry in `sessions` (`sessionId`, `slug`, `summary`, `createdAt`, `lastActiveAt`, `messageCount`, `gitBranch`, `entrypoint`, `integrityHash`, and `type` when present — `"continuation"` marks an incremental bundle's delta session). The result is **not** the full manifest: it carries no included-layers list and no source Claude version, so do not promise either. For a **directory** export you may read `<path>/manifest.json` directly if the user asks for those — it holds `includedLayers` and `sourceClaudeVersion`; for a `.tar.gz`/`.tar.zst` there is no manifest on disk to read. For an entry with `metadataAvailable: false` there is nothing to show at all (`sessions` is `[]`): report the `metadataError` instead, plus the zstd install offer above when it applies.
   - "Delete" — there is **no** sesh-mover delete command; deleting is a plain filesystem removal you perform yourself, so be exact about it. Confirm with AskUserQuestion ("Yes, delete" / "Cancel"), showing the entry's `path` verbatim in the question so the user approves the literal path. Then remove that one artifact and nothing above it: `rm -rf "<path>"` for a directory export, `rm "<path>"` for a `.tar.gz`/`.tar.zst`. Never widen the target — not the containing `.claude-sesh-mover` directory, not a glob, not a parent — and if `path` is missing or does not end in the export's own `name`, stop and ask the user rather than guessing.

6. After completing an action, if the user chose "View details", offer the import/delete options again for the same export.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocation above; do not search the plugin cache. The flag set documented in this file (in both the main invocation and any conditional branches) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
