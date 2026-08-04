---
name: pull
description: Pull a project's thread from the cross-machine hub into this machine
---

You are running the sesh-mover pull command. Follow these steps:

1. Check hub configuration first:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub status
   ```
   - If `hubPath` is `null`, tell the user no hub is configured yet and point them at `/sesh-mover:hub-init`. Stop.
   - If `reachable` is false, surface the `warnings` and stop.

2. Determine the project path:
   - Normal case (this project already exists locally — you're pulling an update or a thread from another machine into it): use cwd as `--project-path`, no `--target-path` needed.
   - Bootstrap case (this project doesn't exist on this machine at all yet — first time pulling it here): ask the user for the destination directory (AskUserQuestion or free text) and pass it as `--target-path <dir>` **in addition to** `--project-path` (still cwd, or wherever the user is running the command from — it drives hub project identity/linking, while `--target-path` is where the session files and workspace snapshot actually land). Don't conflate the two flags; they can point at different places.

3. Run without a thread selector first, to discover what's available:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" pull --project-path "<cwd>" --source-config-dir "<config-dir>" [--project-id <id>]
   ```
   (only include `--project-id` if the user is deliberately linking to a specific hub project that isn't linked locally yet)

4. Parse the result and branch:
   - `reason: "unlinked"`: same shape as push — present `linkCandidates` as a pick-list, but point the user at `/sesh-mover:push` to link or create the hub project first (pull can also link directly via `--project-id`; offer to re-run step 3 with `--project-id <picked>` if the user prefers not to switch commands).
   - `reason: "lock-busy"`: wait a few seconds and retry the same invocation once; if still busy, stop and report it.
   - `pickRequired: true`: present `threads` as a numbered list — slug, latest machine name, `lastActiveAt`, `messageCount`, and whether `pullNeeded` is true. Ask the user which thread to pull (AskUserQuestion), or offer "pull whichever most needs updating" which maps to `--latest` instead of `--thread <id>`.
   - Any other `success: false` (no `reason` field): report `error`/`suggestion` and stop.

5. Run the real pull with the chosen thread:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" pull --project-path "<cwd>" --source-config-dir "<config-dir>" --thread "<id>" [--target-path "<dir>"] [--project-id <id>]
   ```
   (substitute `--latest` for `--thread "<id>"` if that's what the user picked)

6. Parse the result and branch:
   - `reason: "not-yet-synced"`: tell the user the hub folder's sync client (OneDrive/Dropbox/Syncthing/etc.) hasn't finished copying these files to this machine yet. List the `missing` files, wait a moment, and offer to retry the same invocation.
   - `success: false` with an error mentioning the workspace target already has content: this happens specifically when you passed an explicit `--target-path` that isn't empty. Use AskUserQuestion to confirm with the user ("merge into the existing directory" / "cancel") **before** re-running with `--force-workspace` appended — never add it automatically.
   - `success: true` with a warning naming `--force-workspace`: this is the routine (no `--target-path`) case — the project directory already has content, so the workspace payload was skipped (sessions still imported normally). Tell the user they can re-run with `--force-workspace` to merge the workspace files in here, or re-pull with `--target-path <fresh-dir>` to unpack them elsewhere instead.
   - `success: true` with a non-empty `appended` array: the continuation was **spliced onto the end of a session this machine already had** (`appended[i].baseSessionId`), adding `entriesAppended` entries. Report it as "your existing session now continues" and point at `claude --resume <baseSessionId>` — that session really does hold the whole conversation, so the separate-session caveat below does **not** apply to it. Note that appended sessions are not listed in `importedSessions` (nothing new was created); a single pull can both append one thread's continuation and import other bundles, so check both fields.
   - `success: true` with a warning about a continuation that "could not be appended": the splice was refused and the content arrived as a separate session instead (handled by the next bullet). Two causes worth relaying differently: a chain mismatch (the local session isn't the entry the continuation follows — nothing to do, this is the honest outcome) versus a base modified in the last 5 minutes, i.e. it looks like a live Claude Code session (the warning names `--force-append`). Only suggest re-running with `--force-append` after confirming with the user that no Claude Code session is currently open on that transcript — and note the already-imported separate session would then be a duplicate.
   - `success: true`, `localSessionId` is a string and `appended` is absent/empty: report `importedSessions`/`skippedSessions` and tell the user the session is registered and resumable with `claude --resume <localSessionId>`.
     **Honesty requirement (always include this when reporting a resumable pulled session that was NOT appended):** the pulled session is a **separate, new session** on this machine — never claim the full original conversation now lives inside it. If it continues earlier work, its first entry is a synthetic continuation header explaining where the prior messages live (on the originating machine, or in another local session id if this machine already had them). The result JSON does not tell you whether this pull was a full session or a continuation, so state it conditionally ("if this continues earlier work, you'll see a header at the top explaining where the earlier messages are"). Optionally, to tailor the message precisely: read the first line of the new session's JSONL (`<configDir>/projects/<encoded-project-path>/<localSessionId>.jsonl`) and check whether its message content starts with `[sesh-mover continuation]` — if yes, it's a continuation and you can describe the header definitively; if no, it's a full transcript.
   - `success: true`, `localSessionId` is `null`: the pulled content already existed locally, but sesh-mover couldn't identify which existing session it corresponds to (a bookkeeping edge case, explained further in the accompanying warning). There is nothing new to resume in this case — say so plainly, and mention that a future push from this machine will re-establish the thread mapping.
   - If `workspaceUnpacked` is non-null, report its `path` and `fileCount`.
   - Any other `success: false` you haven't handled above (e.g. "no thread found", "already local", "already up to date"): report `error`/`suggestion` and stop — these are plain mistakes (bad thread id, nothing new to pull), not conditions to retry automatically.

7. Report a final summary: thread pulled, sessions imported/skipped/appended, workspace outcome, and the resumable session id (or, if `null`, why there isn't one).

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocations and the conditional branches — `--project-id` for linking, `--target-path` for the bootstrap/relocate case, `--force-workspace` for the confirmed-merge retry, `--latest` as the `--thread` alternative, `--force-append` for the confirmed live-base retry, and `--no-append` to opt out of splicing entirely) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface. `pull` also accepts `--progress` (NDJSON progress events on stderr) — it's oriented at humans running the CLI directly; don't pass it from this command flow.
