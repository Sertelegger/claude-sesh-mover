---
name: push
description: Push this project's sessions to the cross-machine hub
---

You are running the sesh-mover push command. Follow these steps:

1. Check hub configuration and current link state first:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub status --source-config-dir "<config-dir>"
   ```
   - If `hubPath` is `null`, tell the user no hub is configured yet and point them at `/sesh-mover:hub-init`. Stop.
   - If `reachable` is false, surface the `warnings` (e.g. the synced folder isn't mounted) and stop.
   - Note `project.linked` / `project.projectId` — informational only; the actual link/create decision happens in step 3 if push reports it's unlinked.

2. Ask the user which sessions to push. Default to "All sessions in this project" (omit `--session-id`). Only ask for specific sessions if the user requests narrower scope — if so, detect session IDs the same way `export` does (see "Detecting the Current Session" in the skill doc) and let them multi-select via AskUserQuestion, passing each as `--session-id <id>`.

3. Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" push --project-path "<cwd>" --source-config-dir "<config-dir>" [--session-id <id> ...] [--no-workspace]
   ```
   For non-git projects, push bundles a workspace snapshot (the project's files) alongside the sessions by default — offer `--no-workspace` when the user doesn't want project files uploaded to the hub (large or sensitive working directory), and carry it into any re-run in step 4.

4. Parse the result and branch on its shape:
   - `reason: "unlinked"` (this project isn't linked to any hub project yet): present `linkCandidates` (name + gitRemotes) as a pick-list via AskUserQuestion, with an extra "Create a new hub project for this directory" option. Then re-run the step 3 invocation with `--project-id <picked-id>` appended (if the user picked a candidate) or `--create-project` appended (if they chose to create new). Do this once automatically as part of the flow — don't ask the user to re-invoke the command themselves.
   - `reason: "lock-busy"`: tell the user another sesh-mover hub operation is already running for this project (mention `holderPid`/`ageSeconds` if present), wait a few seconds, and retry the exact same invocation once. If it's still lock-busy after that retry, stop and report it to the user rather than looping.
   - `success: true` and `upToDate: true`: this is a successful push, not a no-op error — tell the user there was nothing new to push (`bundleId` is `null`, `pushedSessions` is empty because every session's head already matches what the hub has recorded).
   - `success: true` and `upToDate: false`: report `pushedSessions` (thread id, session id, `full` or `continuation`), whether `hasWorkspace` was included, and any `warnings`.
   - Any other `success: false`: report `error`/`suggestion` and stop.

5. Report a final summary: hub project id, sessions pushed (count, and full-vs-continuation breakdown), whether a workspace snapshot was included, and whether the project was newly linked or created during this run.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocation and the unlinked-retry branches, `--project-id`/`--create-project`, plus `--no-workspace`) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface. `push` also accepts `--progress` (NDJSON progress events on stderr) — it's oriented at humans running the CLI directly; don't pass it from this command flow.
