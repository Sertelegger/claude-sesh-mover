---
name: hub-delete
description: Permanently delete a retired project's files from the cross-machine hub (owner machine, after the grace window)
---

You are running the sesh-mover hub delete command. **This is the one irreversible command in this plugin.** It removes every file of a hub project — its record, its bundles, and every machine's index for it — and nothing puts them back. It is phase 2 of retirement: it only runs on the machine that created the project, and only once that machine's own tombstone (written by `/sesh-mover:hub-retire`) is more than the grace window old.

Follow these steps:

1. **Confirm with the user before running it, every time, in words that name what is lost.** Not "delete this project?" but "delete the hub's copy of *<name>*: N bundles from M machines, gone for good?". Local sessions are untouched — say that too, because it is the reassuring half and it is true. If any machine still has work on the hub it has not pulled, this is its last moment.

2. Establish which project: default to the current working directory, or `--project-path "<dir>"`, or `--project-id "<id>"` for a project no directory here links to.

3. Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub delete [--project-path "<dir>"] [--project-id "<id>"]
   ```

4. Branch on the result:
   - `success: true` — report `deletedFiles`, and that this directory's hub link was removed too (`localLinkRemoved`), which is what stops the session-end auto-push from recreating the project on the next session end. If `failed` is non-empty, list those paths: nothing will ever mention them again.
   - `reason: "grace-period"` — **the expected answer if the user retired the project recently.** Report `deleteEligibleAt` and `remainingSeconds` as a wait, not as an error, and do not offer to work around it: the wait is sized against how long a synced hub takes to reach a machine that is switched off, and it is the only thing protecting a machine that has not seen the retirement yet. If `remainingSeconds` is `null` the tombstone's own timestamp is unreadable — the suggestion says how to write a fresh one.
   - `reason: "not-retired"` — phase 1 has not happened. Run `/sesh-mover:hub-retire` first, then come back after the window. Never present this as "delete needs a flag".
   - `reason: "not-owner"` — this machine did not create the project; report `ownerMachineName`/`ownerMachineId` and stop. There is no override, deliberately: a machine that cannot see the whole hub must not be able to destroy another machine's work.
   - `reason: "unlinked"` / `"project-gone"` / `"lock-busy"` / `"hub-unreachable"` — as documented in `/sesh-mover:hub-retire`; nothing was deleted in any of them.

5. Relay **every** entry in `warnings` verbatim, and do not soften these two:
   - **Other machines still hold their own link to the deleted project.** A push from one of them recreates the project directory on the hub with no project record — bytes nothing can discover. Each of those machines needs `/sesh-mover:hub-unlink`.
   - **This machine's local sync bookkeeping is kept**, so it still records what it once sent to this hub. Linking this directory to a *new* hub project later can therefore ship only a delta.

## What it deletes, and in what order

- Everything under `projects/<id>/`: the project record, every machine's index, every bundle. Empty directories may remain — the hub backend removes files, never directories.
- `project.json` goes **first**, so a run interrupted half way leaves a project that can no longer be linked to; the tombstone goes **last**, so such a run leaves the pull gate up and the command still authorized to finish the job on a re-run. If a delete is interrupted, simply run it again.
- Local sessions, exports and workspaces are not touched. Deleting a hub project removes the shared copies only.

**Exit codes:** branch on the parsed JSON, not on `$?`. `0` success, `2` for `grace-period` / `not-retired` / `not-owner` / `unlinked` / `project-gone` — the grace refusal is a refusal, not an environment problem, and a caller must not loop on it — `3` for `lock-busy` and `hub-unreachable`, `1` for a bad invocation or an unexpected failure.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is; do not search the plugin cache. The flag set documented here (`--project-path`, `--project-id`) is authoritative — do not run the CLI with `--help` to discover its surface.
