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

   **Degraded entries.** An entry with `metadataAvailable: false` has `null` for `exportedAt` / `sourcePlatform` / `sourceProjectPath` / `sessionCount` — its metadata could not be read, which is not the same as "the bundle has none". List it with its name and the `metadataError` in place of those columns rather than blank or zero values, and still offer it as a selectable option — but say it will likely fail until the cause is fixed. Import unpacks the real bundle and will work if the archive is intact *and readable on this machine*: a `.tar.zst` whose metadata could not be read for lack of `zstd` will fail to import for exactly the same reason, so offer the install below before the user selects it.

   **The zstd case.** A degraded entry whose **name ends in `.tar.zst`** is this case: `.tar.zst` bundles can only be read where the `zstd` binary is installed. Key off the name, not off the wording of `metadataError` — that field carries a free-text detail string that is not guaranteed to contain the word "zstd" (it usually will, and when it does it corroborates the name). Offer to install it rather than leaving the row unexplained:
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

7. Present the dry-run results: version adaptations, any warnings, the path rewrites in `rewriteReport` (it is computed over the **first** session only — say "sample" rather than implying every session was previewed), and the memory plan.

   **`memoryPlan`** is one entry per file in the bundle's `memory/`, produced by the same function the real run executes. Read the verdicts and give the user one sentence *before* the import rather than a warning after it — that sentence is the whole defect this preview exists to prevent:
   - `copy` — absent here, will be written · `identical` — same bytes, no write
   - `index-union` — this is `MEMORY.md` and it differs; `added` lists the entries that will be appended to your index and `alreadyPresent` those already in it
   - `park` — a memory that differs on both sides; yours is kept and theirs is saved as `parkedAs` beside it
   - `keep-local` / `skip` — nothing will be written; `note` says why

   Aggregate it, e.g. *"11 memory files: 10 new, 1 index — 10 entries would be added to MEMORY.md; `notes.md` differs and would be parked as `notes.incoming.md` (you can merge it afterwards)."* Do **not** describe a `park` verdict as "would be merged": the merge is step 11, it costs tokens, and it has not been offered yet.

   `planConflicts` on the dry run lists plans that already exist here with different content. Those are reported and never written — say so, because the incoming plan stays in the bundle and nowhere else.

8. Use AskUserQuestion to confirm: "Proceed with import" (recommended) / "Cancel".

9. Execute the import:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" import --from "<path>" [--session-id <ids>] --target-project-path "<cwd>" --target-config-dir "<config-dir>"
   ```

10. Report the result. Read what actually landed **before** offering anything to resume — `resumable` says the importer was allowed to register sessions, not that this run created any.
    - Import is idempotent by default, so check `skippedSessions` first. If it shows all requested sessions skipped (reason `duplicate` = identical content already imported into this project; reason `already-received` = already synced from this peer) and `importedSessions` is `[]`, tell the user **no new sessions** were imported and why, and offer **no** resume command — but do not call the run a no-op: the memory and plan layers are not session-scoped and are reconciled on a fully-duplicate import too, so read `memoryIndex` / `memoryConflicts` below before summarising — a fully-skipped import still reports `resumable: true`, and there is no new session id to resume. If the user actually intended a re-import, re-run the step 9 invocation with `--allow-duplicates` appended.
    - Otherwise, if `importedSessions` is non-empty and `resumable` is true: tell the user they can continue with `claude --resume <newId>`, using the `newId` of an entry in `importedSessions` — the importer assigns a fresh id, so never quote `originalId` or an id from the bundle.
    - If not resumable because of a version-mismatch or "session validation failed" error: offer to retry the step 9 invocation with `--no-register` appended. That imports the session content but skips the registry entry — the user won't get a `claude --resume` slot, but the JSONL is on disk. Note: after a `--no-register` import, a later normal import of the same bundle automatically imports a registered copy — the older unregistered copy remains on disk and can be deleted manually. `--allow-duplicates` is no longer needed for this case.
    - If the `--no-register` retry also fails, or if the user prefers: offer to read the imported JSONL and inject it as context into the current conversation.
    - Always relay `warnings` verbatim — that is where version adaptations, integrity problems, the idempotent-skip notice and the memory reconciliation surface.
    - **Report the memory layer from the typed fields, not from the warnings.** A session's memories are only reachable through `memory/MEMORY.md`, so a transfer that lands them and leaves the index alone lands nothing usable (that is #49, measured: ten memory files on disk, referenced by nothing, reported as `success: true`).
      - `memoryIndex.added` — link targets appended to your `MEMORY.md`. Name the count. `alreadyPresent` is how many the index already had.
      - `memoryIndex.droppedProse: true` — the sender's index carried headings or prose; only its entries were merged. One line, not a footnote.
      - `memoryIndex.unindexed` — memory files that arrived and that **no index lists**, so nothing will ever read them. They were usually already orphaned on the source machine; the union cannot fix that, because a file no line points at contributes no line. Name them and offer to add index entries if the user wants them (that is an ordinary edit to `MEMORY.md`, and it is the user's call, not the importer's).
      - `memoryConflicts` — memories that differ on both sides. **Yours was kept and nothing was overwritten**; `parkedAs` is the file the incoming copy was saved as, inside `memoryDir`. Both texts are on disk. Then go to step 11.
      - `planConflicts` — plans that already exist here with different content. Yours was kept; the incoming plan was **not** written and is only in the bundle. If the user wants it, they must re-extract the bundle — say that, because unlike a memory nothing was parked for them. (Plans live in a directory every project on this machine shares, which is why nothing is written beside them.)

    **Incremental bundles.** The import result carries no manifest, so incremental detail has to come from the bundle itself — and only when the user picked an export **directory**: for a `.tar.gz`/`.tar.zst` the CLI extracts to a private temp dir and deletes it before returning, so nothing is left to read. When `--from` was a directory and `<path>/manifest.json` has `incremental: true`, read it and add to the report:
    - Source machine: `<sourceMachineName>` (`<sourceMachineId>`)
    - What arrived, split by kind: for each entry in `importedSessions`, find the manifest session whose `sessionId` equals that entry's `originalId` and read its `type` (`"full"` or `"continuation"`). For a continuation, its manifest `slug` is the slug of the session it continues on the source machine — report it as "continues `<slug>`".
    - Duplicates skipped: `skippedSessions.filter(s => s.reason === "already-received").length`. Count the typed field, never warning text: the CLI pushes ONE aggregated warning no matter how many sessions were skipped, so matching on its wording reports at most 1.

11. **Offer to merge the conflicting memories** — only if `memoryConflicts` is non-empty and every entry you act on has a `parkedAs`. This step is yours, not the CLI's: `dist/cli.js` does pure filesystem work and never calls a model, so the semantic merge happens here, in the session the user is already paying for, where its cost is visible and it can be confirmed before it happens.

    **When there is nobody to confirm — do nothing.** A `hub pull` driven by a SessionEnd/SessionStart hook, a piped or scripted CLI run, and a `--no-register` recovery run all reach this state with no user attached. What the CLI already did (yours kept, theirs parked, both indexed) is a **complete and correct outcome**, not a fallback that failed. Never merge without asking.

    1. **Size it before offering.** For each conflict, `memoryDir` + `filename` and `memoryDir` + `parkedAs` are the two texts. Get their byte sizes and say so: *"3 memories differ (~9 KB). Merge them into one file each?"* — not *"merge memories"*. At the scale this occurs it is small (the import that produced #49 carried 11 memory files, 578–4,648 bytes each, ~16 KB in total, so merging every one is ~32 KB of reading). At 100 conflicts it is not, and the user needs the number to decline or to pick.
    2. **Offer per file, not all-or-nothing.** Conflicts are independent — merging one memory tells you nothing about another — so use AskUserQuestion with the files as options plus "All of them" and "None, leave them parked".
    3. **Read both texts, then classify every contradiction** before proposing anything. A memory is a set of claims, not a version of a string, so:
       - `superseded` — the same claim, later and more accurate. Carry the newer, drop the older.
       - `both-true-scoped` — both true, of different machines, config dirs, branches or phases. This is the *normal* case for a cross-machine tool: "the config dir is `~/.claude-nv`" and "the config dir is `~/.claude`" are both true, of two machines. Keep **both claims, each explicitly scoped**. Never pick one.
       - `unresolved` — the claims conflict and nothing in either text says which is newer or which context each belongs to.
    4. **Any `unresolved` blocks the write.** Show both claims verbatim, say which file each came from, and ask. **Presenting the contradiction instead of resolving it is a correct answer, not a degraded one.** Never merge "everything except the hard part": a merged memory that silently omits a disputed claim is the same silent partial-state loss as the defect this whole flow exists to fix.
    5. **Show the full proposed text before writing anything**, and get an explicit yes.
    6. **On acceptance, in this order:**
       1. Write the merged text to `<memoryDir>/<filename>`.
       2. Write the **pre-merge local text** to `<memoryDir>/<stem>.pre-merge.md` and delete `<memoryDir>/<parkedAs>`. Keep the *local* half, not the incoming one: the incoming text is still in the bundle (and on the hub, which deletes nothing), while the local pre-merge text existed in exactly one place — the file you just overwrote.
       3. Remove the `MEMORY.md` pointer line whose target is `<parkedAs>` — the merged memory is reachable under its own name, and a `.pre-merge.md` backup is a backup, **not a memory**: never index it. Touch no other line of `MEMORY.md`.
    7. **On decline, change nothing.** Two files, two index entries, nothing lost.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocations and any conditional/retry branches, e.g. `--no-register` for the version-mismatch fallback, `--allow-duplicates` for the duplicate-skip retry) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
