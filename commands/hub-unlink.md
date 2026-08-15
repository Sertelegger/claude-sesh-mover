---
name: hub-unlink
description: Unlink this project from the cross-machine hub (disarms the session-end auto-push here)
---

You are running the sesh-mover hub unlink command. It removes one file — this directory's hub link, `.sesh-mover-project.json` — and that file's existence **is** the consent gate for the two default-on lifecycle hooks, so removing it makes the session-end auto-push and the session-start freshness notice inert for this directory. Follow these steps:

1. Establish which directory to unlink. Default to the current working directory and pass no flag. When the user names a different one — commonly a throwaway directory that a `pull --target-path <dir>` planted a link into — pass it as `--project-path "<dir>"` rather than `cd`-ing there, so the answer is about the directory they meant.

2. Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub unlink [--project-path "<dir>"]
   ```
   Do **not** run `hub status` first to check whether the project is linked. The command answers that itself in `wasLinked`, and — unlike every other hub verb — it neither requires nor reads a configured hub, so a `hub status` precheck can fail (an unmounted share, a removed `hub.path`) on a directory this command would unlink perfectly well. That is deliberate: this is the *disarm* path for automation that is on by default, and it must not be gated on the hub being reachable.

3. Branch on the result:
   - `success: true` with `wasLinked: false` — **a successful no-op, not an error.** There was no `.sesh-mover-project.json` in that directory, so nothing was linked and nothing was removed. Say that plainly; don't report it as a failure, don't suggest a retry, and don't offer `--force`. `projectId` and `removedPath` are `null` here, and `automationDisarmed` describes the state the directory is now in (both hooks inert) rather than something this run changed.
   - `success: true` with `wasLinked: true` — report `removedPath` (the single file that was deleted) and `projectId`, and **keep that id in your final summary**: it is what a later `/sesh-mover:push --project-id <that id>` needs to re-link this directory to the *same* hub project. Say why it matters rather than just quoting it — the local sync bookkeeping is left in place on purpose, so re-linking to the same hub project resumes where this machine left off instead of re-uploading every session from scratch.
   - `reason: "lock-busy"` — another sesh-mover hub operation (a push, a pull, or `hub reindex`) holds this project's lock; mention `holderPid`/`ageSeconds` if present. Wait a few seconds and retry the exact same invocation once. If it is still busy, offer `--force` and say what it trades: it skips the lock, so an operation that genuinely is still running could write the link file again when it finishes — the result says so in a warning, and running `hub unlink` again afterwards clears it. Offer the flag rather than looping: a wedged push holds that lock for up to 10 minutes, and disarming must not be blocked by the thing you are disarming.
   - any other `success: false` (a filesystem error, say) — report `error`/`suggestion` and stop. Nothing on the hub is affected either way, because this command never writes there.

4. Relay **every** entry in `warnings` verbatim. The one worth understanding before you paraphrase it concerns re-linking to a *different* hub project: this machine's peer ledger for the hub is keyed by hub id, not by project id, so after an unlink it still credits that hub with the sessions it already holds. Re-link this directory to the same project and that is exactly right; re-link it to a **different** hub project on the **same** hub and the ledger claims the hub already has sessions that project does not, so the next push ships only a delta. `hub unlink` warns and resets nothing — clearing it is a deliberate act, not something it does behind the user's back.

5. Report a final summary: whether anything was unlinked, the file that was removed, the `projectId` to relink with, and — in one sentence — that the automatic session-end push and the session-start notice no longer fire for this directory.

## What this does and does not do

Say as much of this as the user's question calls for; all of it is load-bearing when they are asking whether unlinking loses anything.

- **Exactly one file.** `<project>/.sesh-mover-project.json`, and nothing else. The `.sesh-mover/` directory beside it (exports, parked carry payloads), `.sesh-mover-include`, `.sesh-mover-ignore` and the project directory itself are all left alone. A link file that is corrupt or unparseable is still removed — it is still on disk, it only looks inert.
- **Nothing is written to the hub, ever.** The command does not even open the hub directory. The hub project, its bundles and every machine's index are exactly as they were. Unlinking is a local, per-directory act: it does not remove this machine's sessions from the hub, and no other machine notices.
- **No hub required.** It does not read `hub.path` and it does not read the Claude config dir (so there is no `--source-config-dir` on it). Every other hub verb bails with "No hub configured"; this one deliberately does not.
- **Idempotent.** Running it on a directory that was never linked succeeds and changes nothing.
- **Per-directory, not per-project-name.** Unlinking project P does not disarm any other directory — notably a scratch directory a `pull --target-path <dir>` delivered a payload into, which gets its own link file. Each such directory has to be unlinked (or its dotfile deleted) on its own.
- **Local sync bookkeeping is kept on purpose.** `~/.sesh-mover/sync-state/…` survives, because clearing it would make a re-link to the same hub project re-upload every session of this project. See the warning in step 4 for the one case where keeping it is a hazard.
- **Doing it by hand works too, and is the same act.** Deleting `.sesh-mover-project.json` un-links a directory exactly as this command does — the gate is that one file's existence and nothing else. What the verb adds is the project lock (so it cannot race a running push), the disclosure above, the `projectId` you need to relink, and a defined answer when the file was not there.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocation above; do not search the plugin cache. The flag set documented in this file (`--project-path`, plus `--force` in the lock-busy branch) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
