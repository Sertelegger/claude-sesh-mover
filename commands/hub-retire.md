---
name: hub-retire
description: Retire a project from the cross-machine hub — refuses new pulls of it, deletes nothing
---

You are running the sesh-mover hub retire command. It writes one small file to the hub — a **tombstone**, this machine's assertion that a project is retired — and removes nothing at all. Retiring is phase 1 of a two-phase story; `/sesh-mover:hub-delete` is phase 2 and it destroys data. Keep them apart in your head and in what you tell the user.

Follow these steps:

1. Establish which project. Default to the current working directory and pass no flag. Two exceptions:
   - the user names a different directory → `--project-path "<dir>"`;
   - the project has **no local link here** — the classic case is a hub project left behind by a push that failed half way, which no directory points at — → `--project-id "<id>"`. `/sesh-mover:whereis` and `hub status` report ids.

2. **Ask before running it**, unless the user has already said plainly that they want the project retired. Retiring makes every other machine refuse to pull the project, and only *this* machine can take that back. Offer `--reason "<text>"` in the same breath: the text is shown verbatim to whoever hits the refusal on another machine, and "why did this stop working" is exactly what they will be asking.

3. Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub retire [--project-path "<dir>"] [--project-id "<id>"] [--reason "<text>"]
   ```

4. Branch on the result:
   - `success: true` with `retired: true` — report `retiredAt` and, prominently, **`deleteEligibleAt`**: that is the moment `hub delete` stops refusing, and it is the deadline for anyone who still needs work off the hub. If `wasRetired` is also `true`, this run re-asserted an existing tombstone and deliberately **kept the original timestamp** — say so, because it means the wait was not restarted.
   - `success: true` with `retired: false` — this was `--undo`; the assertion is withdrawn and pulls work again. If `wasRetired` is `false` there was nothing to withdraw: a successful no-op, not an error.
   - `reason: "unlinked"` — the directory is linked to no hub project. Re-run with `--project-id <id>`; do not guess an id.
   - `reason: "not-owner"` — **this machine did not create the project**, and both phases are the creating machine's to run. Report `ownerMachineName`/`ownerMachineId` and say the command has to be run there. Do not look for a flag to override it; there isn't one, on purpose.
   - `reason: "project-gone"` — the hub has no record of the project. On a synced hub it may simply not have landed here; otherwise it is already deleted, and `/sesh-mover:hub-unlink` is what clears the stale link in this directory.
   - `reason: "lock-busy"` — another sesh-mover hub operation holds this project's lock. Wait and re-run the same invocation. There is deliberately no `--force` here: what it could be racing is a push writing new bundles into the project being retired.
   - `reason: "hub-unreachable"` — nothing was written; report `hubState` and the suggestion.

5. Relay **every** entry in `warnings` verbatim. Three of them carry the shape of the whole feature: nothing was deleted, other machines only stop pulling once the tombstone reaches them, and **pushes are not blocked** — a machine still linked to this project keeps uploading to it, including through the unattended session-end auto-push, so `/sesh-mover:hub-unlink` on each machine is what actually stops that.

## Undoing it

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub retire --undo [--project-path "<dir>"]
```

Retraction is **asymmetric**: a tombstone belongs to the machine that wrote it, and only that machine can remove it. If machine A retired a project, B cannot un-retire it — B can only pull past it with `/sesh-mover:pull --ignore-retirement`. Never tell a user on the wrong machine to run `--undo`.

## What retiring is, and is not

- **It is an assertion, not a deletion.** Every bundle, index, workspace copy and carry payload stays exactly where it is. That is what makes a mistaken retire cheap.
- **It is per machine, and it is this machine's file.** `projects/<id>/tombstones/<machineId>.json` — a machine never writes another machine's files, which is the invariant the whole hub design rests on.
- **It gates *new pulls*, and nothing else.** A pull already running is not interrupted, and a machine the tombstone has not reached yet will start one perfectly happily. That is precisely why deleting is a separate command with a multi-day wait in front of it, and it is the sentence to repeat if a user asks why they cannot delete immediately.
- **Only the creating machine may retire a project.** Not "by default" — there is no override.

**Exit codes:** branch on the parsed JSON, not on `$?`. `0` success (including `--undo` on a project that was not retired), `2` for every refusal in step 4 except the last two, `3` for `lock-busy` and `hub-unreachable` (the retryable class), `1` for a bad invocation or an unexpected failure. See "Exit Codes" in the skill doc.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is; do not search the plugin cache. The flag set documented here (`--project-path`, `--project-id`, `--reason`, `--undo`) is authoritative — do not run the CLI with `--help` to discover its surface.
