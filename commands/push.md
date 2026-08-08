---
name: push
description: Push this project's sessions to the cross-machine hub
---

You are running the sesh-mover push command. Follow these steps:

1. Check hub configuration and current link state first:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub status
   ```
   - If `hubPath` is `null`, tell the user no hub is configured yet and point them at `/sesh-mover:hub-init`. Stop.
   - If `reachable` is false, surface the `warnings` (e.g. the synced folder isn't mounted) and stop.
   - Note `project.linked` / `project.projectId` — informational only; the actual link/create decision happens in step 3 if push reports it's unlinked.
   - If `lastAutoPush` is present, that is the record of the last **automatic** (session-end) push for this project, which has no other output at all. Mention it when `ok` is `false` (the automatic pushes have been failing and nothing would have said so) or when `notes` is non-empty (those are warnings the user was never shown — the gitignored-but-tracked disclosure is one of them). Don't repeat it once the manual push below reports the same thing.

2. Ask the user which sessions to push. Default to "All sessions in this project" (omit `--session-id`). Only ask for specific sessions if the user requests narrower scope — if so, detect session IDs the same way `export` does (see "Detecting the Current Session" in the skill doc) and let them multi-select via AskUserQuestion, passing each as `--session-id <id>`.

3. Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" push --project-path "<cwd>" --source-config-dir "<config-dir>" [--session-id <id> ...] [--no-workspace] [--no-carry]
   ```
   For non-git projects, push bundles a workspace snapshot (the project's files) alongside the sessions by default — offer `--no-workspace` when the user doesn't want project files uploaded to the hub (large or sensitive working directory), and carry it into any re-run in step 4.

   For git projects (a remote is configured) push instead carries the **uncommitted** work: a `git diff HEAD` patch plus untracked, non-gitignored files. Offer `--no-carry` when the user doesn't want work-in-progress on the hub, and carry it into any re-run. Among *untracked* files, a gitignored one is never carried unless `.sesh-mover-include` names it (see step 4). That rule does **not** extend to tracked files: the patch describes every tracked file that changed, so a gitignored-but-tracked file's changes do travel — never tell the user `.gitignore` protects them from the carry without that qualification.

   Which of the two a project gets is decided by asking `git` for its remotes, and there is a third answer: if `git` can't be asked (not on `PATH`, or a repository it refuses to read), push includes **neither** payload and says so in a warning. That is deliberate — a workspace snapshot copies the whole directory without reading `.gitignore`, which is only safe for a project that genuinely has no remote — so relay it as a local setup problem to fix (the sessions still pushed), never as the project having no uncommitted work.

4. Parse the result and branch on its shape:
   - `reason: "unlinked"` (this project isn't linked to any hub project yet): present `linkCandidates` (name + gitRemotes) as a pick-list via AskUserQuestion, with an extra "Create a new hub project for this directory" option. Then re-run the step 3 invocation with `--project-id <picked-id>` appended (if the user picked a candidate) or `--create-project` appended (if they chose to create new). Do this once automatically as part of the flow — don't ask the user to re-invoke the command themselves.
   - `reason: "lock-busy"`: tell the user another sesh-mover hub operation is already running for this project (mention `holderPid`/`ageSeconds` if present), wait a few seconds, and retry the exact same invocation once. If it's still lock-busy after that retry, stop and report it to the user rather than looping.
   - `success: true` and `upToDate: true`: this is a successful push, not a no-op error — tell the user there was nothing new to push (`bundleId` is `null`, `pushedSessions` is empty because every session's head already matches what the hub has recorded).
   - `success: true` and `upToDate: false`: report `pushedSessions` (thread id, session id, `full` or `continuation`), whether `hasWorkspace` was included, and any `warnings`.
   - Any other `success: false`: report `error`/`suggestion` and stop. Nothing was linked: `push` defers the identity write (the local `.sesh-mover-project.json` and the hub project) until the export has produced a bundle, precisely so a failed push cannot leave the project linked — and linking is what arms the default-on session-end auto-push. The commonest shape here is `No sessions found for this project`, which just means this directory has no Claude Code sessions yet.

   If the result carries a `carry` object, say what uncommitted work went with it: `carry.untrackedCount` untracked files plus a `carry.patchBytes`-byte patch against `carry.baseCommit` on `carry.branch`. If `carry.reIncludedCount` is above zero, name the `carry.reIncluded` paths explicitly — those are gitignored files that travelled *because* `.sesh-mover-include` lists them, and the user should be told which ones are now on the hub (`reIncluded` is capped at 10; if the count is higher, say so rather than implying the list is complete). If `carry.trackedIgnoredCount` is above zero, name `carry.trackedIgnored` too, and keep the two apart: those are gitignored files that git **tracks**, so the patch carried their changes and no `.sesh-mover-include`/`.sesh-mover-ignore` line put them there or can take them away — the remedy is `git rm --cached <path>` or `--no-carry`. A carry that was declined shows up as a `warnings` entry, not as a failure; report it verbatim rather than treating the push as broken.

   If (and only if) the result carries a non-empty `ignoredNotCarried`, mention it once after the summary — it's present only on a git project that has no `.sesh-mover-include` yet, and it lists gitignored paths this push left behind (a sample, capped at 10, spelled the way git spells them; a trailing `/` means that directory at the project root and everything under it). Tell the user these are *not* carried, and offer via AskUserQuestion to create `.sesh-mover-include` (at the project root — it is a root dotfile, not a file inside `.sesh-mover/`) listing the ones they want synced across machines. If they accept, write only the paths they picked, one per line, exactly as reported. Say plainly, before they choose:
   - `.gitignore` is also where `.env` and credential files live, so this is a security-relevant list;
   - the file is meant to be committed, so it applies on every clone and every machine;
   - listing a path means it is **uploaded on the next push** of this project (it rides the git carry described above), and a later push reports it back in `carry.reIncluded`;
   - creating the file also *stops this suggestion appearing*, since its existence is what suppresses `ignoredNotCarried`.

   Never pre-select entries, never widen one (`docs/specs/notes.md` stays that path — don't turn it into `docs/`), and never offer `.git` or any path sesh-mover owns (`.sesh-mover/`, the `.sesh-mover-*` root dotfiles): those can never be carried and a pattern naming one does nothing. If the user declines, don't ask again in this session.

5. Report a final summary: hub project id, sessions pushed (count, and full-vs-continuation breakdown), whether a workspace snapshot was included, and whether the project was newly linked or created during this run.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocation and the unlinked-retry branches, `--project-id`/`--create-project`, plus `--no-workspace` and `--no-carry`) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface. `push` also accepts `--progress` (NDJSON progress events on stderr) — it's oriented at humans running the CLI directly; don't pass it from this command flow.
