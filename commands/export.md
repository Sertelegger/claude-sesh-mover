---
name: export
description: Export the current Claude Code session or all sessions for this project
---

You are running the sesh-mover export command. Follow these steps:

1. Detect the current session ID from the conversation context: look at the `sessionId` field in any recent tool result in this conversation. Do not use `sesh-mover browse` — it lists previously-exported bundles, not live sessions. If the session ID isn't obvious, list `<configDir>/projects/<encoded-path>/*.jsonl` and ask the user to pick.

2. Ask the user configuration questions using the AskUserQuestion tool to present selectable options. Ask one question at a time (unless the user has config defaults set, in which case skip those questions). The labels below are what the user sees; the `→` arrow shows which CLI flag value to pass in step 5.

   **Question 1 — Scope:**
   Use AskUserQuestion with options:
   - "This session only" (default/recommended) → `--scope current`
   - "All sessions in this project" → `--scope all`

   **Question 2 — Storage:**
   Use AskUserQuestion with options:
   - "User level (~/.sesh-mover/)" (recommended) → `--storage user`
   - "Project level (.sesh-mover/)" → `--storage project`

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

   **Question 5 — Mode (only if prior peers exist for this project):**
   Read `~/.sesh-mover/sync-state/<encoded-project-path>.json` if present. If the file is missing or `peers` is empty, skip this question entirely.

   If peers exist, ask with AskUserQuestion (≤4 options):
   - Slot 1: "Full export (every session)" → omit `--incremental`
   - Slots 2–3: one slot per known peer, up to two peers — "Incremental for peer `<name>`" → `--incremental --to <peer-id>`
   - Slot 4 (when peers.length ≤ 2): "Incremental since another export…" → prompt for path, add `--incremental --since <path>`
   - Slot 4 (when peers.length > 2): "Other…" → follow-up question listing the remaining peers and the `--since` option.

   `--since` takes a **directory** export — the path must contain a `manifest.json`. A `.tar.gz`/`.tar.zst` archive is rejected outright ("does not contain a manifest.json"), so if the user names an archive, ask for a directory export instead rather than re-running.

   Incremental composes with --scope. Default --scope to `all` when --incremental is selected unless the user picks "This session only".

   Only ask for individual exclusion of memory, plans, or subagents if the user explicitly requests that granularity after seeing the grouped option.

   **Privacy option:** If the user mentions privacy, sharing the export with someone else, posting it publicly, or otherwise not wanting conversation text visible in manifests/listings, offer `--no-summary` — this is a functional flag: it makes the manifest's summary fall back to the session slug and skips parsing the JSONL for an excerpt entirely. It does not redact the exported JSONL itself (the full conversation is still copied); mention that distinction if the user's concern is broader than listing text. If selected, add `--no-summary` to the step 5 invocation.

   **Project files are a separate question** and it is asked in step 4, not here — `--include-workspace` / `--include-carry` are the only flags on this command that put something other than session data in the bundle, and they get their own gate for that reason. Offer them here only if the user asks to move the project's *files* (a working copy, work in progress, gitignored directories a clone won't have); otherwise leave them off and let step 4 stay silent.

3. Generate a one-line summary of the session by reading the first few exchanges, then describe it in ~100 characters.

4. **The file payload: measure, disclose, confirm — then write.** This is the only gate on this page, and it has to run *before* the export because the artifact is what leaves.

   **Skip this step entirely, and say nothing, when no payload was asked for**: neither `--include-workspace` nor `--include-carry` from step 2, and neither `export.includeWorkspace` nor `export.includeCarry` `true` in the effective config (`configure --show --json`, the same read step 2's defaults come from). Sessions-only is the default; silence about a payload nobody is capturing is correct.

   Otherwise, measure before anything is written:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" export --payload-plan [--include-workspace] [--include-carry] --project-path "<cwd>"
   ```
   `--payload-plan` creates no bundle, writes no file and exports no session — the result is marked `payloadPlan: true`, and there is nothing to clean up if the user declines. Present all of the following, **unconditionally**. Do not gate it on the user raising privacy the way the `--no-summary` note above is gated: the user who most needs this is the one who has not thought to ask for it.

   - **Which payload applies, and why.** `decision` is settled by asking `git` about this project's remotes and by nothing else — the user does not pick it, and the flag they passed may turn out to be a no-op:
     - `"carry"` — this project has a git remote, so only the *uncommitted* work travels: a `git diff HEAD` patch plus untracked files.
     - `"workspace"` — no git remote (which includes a git repository that simply has none configured, not just a non-git directory), so a copy of the **whole working tree** travels. **It does not read `.gitignore` at all** — say that in those words. It is the reason this arm is limited to a project git says has no remote.
     - `"unknown"` — a `.git` puts this path inside a repository and `git` could not be asked about its remotes (not on `PATH`, timed out, or a repository it refuses to read), so **neither** payload is captured. That is deliberate rather than a gap: an unfiltered whole-tree copy is only safe for a project that genuinely has no remote, and "I could not ask" is not that answer. The warning names the `.git` that made this path count as a repository, which is routinely an ancestor directory outside the project — relay it as a local setup problem to fix (the sessions export normally), never as "this project has nothing to carry".
     - `"none"` — nothing to capture, or the flag names a payload this project cannot take (`--include-carry` on a remote-less project, `--include-workspace` on one with a remote). Say which, so a user who asked for files and is getting none knows why.
   - **The size.** For a snapshot, `workspace.fileCount` files and `workspace.byteSize` bytes. For a carry, `carry.untrackedCount` untracked files plus a `carry.patchBytes`-byte patch against `carry.baseCommit` on `carry.branch`.
   - **`carry.reIncludedCount` — the count, stated separately from the sample.** These are gitignored files that would travel *because* `.sesh-mover-include` names them. `carry.reIncluded` is capped at 10, so when the count is higher say so rather than reading the list out as though it were complete. The remedy is to remove the line.
   - **`carry.trackedIgnoredCount` — kept apart from the above, and the loudest thing on this page.** Give the reason and not just the number: **the `git diff` patch is not filtered by `.gitignore`. Only the untracked enumeration is.** So a gitignored file that git *tracks* has its contents in the patch. A `.env` committed once and gitignored later without `git rm --cached` carries its current value, in plaintext, into the bundle. The remedy is `git rm --cached <path>`, or exporting without `--include-carry`. Never offer `.sesh-mover-include` as the remedy here: no line put these files in the payload and no line can take them out, which is exactly why the CLI reports them in their own field.
   - **Why this is not the question `push` asks.** Say it plainly, once: a hub bundle lands in a directory you control; an export bundle gets `scp`'d, emailed, dropped in a shared folder, or handed to someone. That is why the payload is on by default on `push` and off by default here — the polarity *is* the security decision — and why this confirmation is unconditional and precedes the write instead of following it.
   - `ignoredNotCarried`, if present: gitignored paths this project has that the payload leaves behind (a sample, capped at 10, spelled the way git spells them; a trailing `/` means that directory at the project root and everything under it). It appears only on a git project with no `.sesh-mover-include` yet. If the user wants any of them in the bundle, offer via AskUserQuestion to create `.sesh-mover-include` at the project root (it is a root dotfile, not a file inside `.sesh-mover/`) listing exactly the ones they pick, one per line, exactly as reported. Before they choose, say: `.gitignore` is also where `.env` and credential files live, so this is a security-relevant list; the file is meant to be committed, so it applies on every clone and every machine; listing a path means it is **in this bundle**, and in every later push and export of this project; and creating the file also *stops this suggestion appearing*, since its existence is what suppresses `ignoredNotCarried`. Never pre-select entries, never widen one (`docs/specs/notes.md` stays that path — don't turn it into `docs/`), and never offer `.git` or any path sesh-mover owns (`.sesh-mover/`, the `.sesh-mover-*` root dotfiles). If they accept, **re-run the plan above and present it again** before confirming: an include list changes what the payload contains, so the numbers they were about to agree to no longer describe it. If they decline, don't ask again this session.
   - Relay the plan's `warnings` verbatim — the budget notes and the `unknown`-arm explanation are only there.

   Then use AskUserQuestion to confirm, wording it as the thing it is — *"This export will also carry `<the project's working tree | the uncommitted work>`: `<N>` files, `<size>`. The bundle travels wherever you send it. Proceed?"* Options: "Include the project files" / "Export sessions only" / "Cancel".

   **"Export sessions only" is not always a flag you can drop.** If a config key rather than a step-2 flag turned the payload on, there is nothing to remove: the CLI reads `--include-workspace` *or* `export.includeWorkspace`, and neither flag has a `--no-` form. Turn the key off with `configure` first (or export from a directory whose project-scope config does not set it) and say that is what you are doing — never run the export with the payload anyway.

5. Run the CLI command, substituting the values mapped in the questions above:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" export --scope <current|all> --session-id <id> --storage <user|project> --format <dir|archive|zstd> [--exclude <layer1> <layer2> ...] --name "<name>" --source-config-dir "<config-dir>" [--no-summary] [--include-workspace] [--include-carry]
   ```
   Never pass user-facing labels (e.g. `tar.zst`, `project`) as flag values — always pass the mapped CLI value (`zstd`, `all`, etc.). The CLI also accepts `tar.gz`/`tar.zst` as aliases for `archive`/`zstd`, but prefer the canonical values. Pass `--include-workspace` / `--include-carry` only when step 4 confirmed them; a payload flag that reached this line without that gate is the defect the gate exists to prevent.

6. Parse the JSON output. If `collision` is true, use AskUserQuestion with options, then re-run the step 5 invocation with the corresponding flag appended:
   - "Keep both (append suffix)" — append `--suffix` and re-run
   - "Overwrite existing export" — append `--overwrite` and re-run
   - "Cancel" — stop, do not re-run

7. If archive was requested, the result's `archivePath` is the single artifact — the staging directory is removed automatically. Report `archivePath` as the destination; do not mention a separate directory.

   **Report the format that was actually produced, not the one requested.** `actualFormat` is present only when the CLI could not honour the request: `--format zstd` on a machine without the `zstd` binary falls back to gzip, writes a `.tar.gz`, and sets `actualFormat` to `"archive"`. Its values are the same three `--format` takes — `dir`, `archive` (tar.gz), `zstd` (tar.zst). When it is present, say plainly that zstd was unavailable and a gzip archive was written instead, and offer the install if the user wants zstd next time:
   - macOS: `brew install zstd`
   - Debian/Ubuntu/WSL: `sudo apt-get install -y zstd`

8. Relay the result's `warnings` — do not drop them. This is the only channel for the zstd fallback ("zstd not found on system, falling back to gzip"), for anything the incremental planner reports, and for the payload's own disclosures when a payload was captured; an export whose warnings are dropped looks like it did exactly what was asked. The routine `"<layer> excluded by user request"` entries are the exception worth folding into the layers line of step 9 rather than listing one by one — they just echo the `--exclude` the user already chose.

9. Report what was exported: session name, summary, layers included, destination path, and the format actually produced (step 7).

   **Report the file payload from the typed fields, not from the warnings**, and report it even though step 4 already previewed it — the plan said what *would* be captured, and these say what is in the bundle:
   - `hasWorkspace` — always present. `true` means the bundle contains a copy of the project's working tree; name the destination path in the same breath, because that file is now what travels.
   - `carry` — present only when uncommitted work was captured. Report `carry.untrackedCount` untracked files plus a `carry.patchBytes`-byte patch against `carry.baseCommit` on `carry.branch`, and repeat `carry.reIncludedCount` and `carry.trackedIgnoredCount` **kept apart**, with the same two remedies as step 4 (remove the `.sesh-mover-include` line; `git rm --cached`). A count that moved between the plan and the result means the tree changed in between — say so rather than reporting only the newer number.
   - `ignoredNotCarried` — the gitignored paths this bundle does *not* contain. Mention it once if step 4 did not already act on it.
   - A payload the user asked for and did not get shows up as a `warnings` entry with no `hasWorkspace`/`carry` to match it (the `unknown` git arm, a budget refusal, a `git` failure). Report it as such: the export succeeded and the files did not travel.

**See also:** for ongoing cross-machine sync through a shared hub folder instead of a one-off export/import round-trip, use `/sesh-mover:push` (requires `/sesh-mover:hub-init` once).

**Exit codes:** keep branching on the parsed JSON, not on `$?`. `export` exits `0` when it produced a bundle — **and also for the `collision: true` case and for every `--payload-plan` run**, both of which produced nothing and are recognizable only from the body (`collision: true`, `payloadPlan: true`), so never read a zero exit as "the export was written". `1` is a bad invocation (an unknown `--format` or `--scope`, `--incremental` without `--to`/`--since`) or a failure partway through, and `2` is a refusal reported as a result, of which `No sessions found for this project` is the common one. See "Exit Codes" in the skill doc for the full four-class table.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in the main invocation, the step 4 measuring run — `--payload-plan`, `--include-workspace`, `--include-carry`, `--project-path` — and any conditional/retry branches, e.g. `--suffix`/`--overwrite` for collision handling) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface. In particular there is no `--no-include-workspace` and no `--no-include-carry`: both payloads are opt-in and the only way to *not* carry one is to not turn it on.
