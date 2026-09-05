---
name: hub-compact
description: Consolidate a thread into one full bundle and retire this machine's chain behind it
---

You are running the sesh-mover hub compact command. It replaces a thread's long chain of continuation bundles with a single full one, and then **deletes** the chain behind it. Deletion is the point of the verb, so treat it the way you treat `/sesh-mover:hub-delete` rather than the way you treat a push.

Two things to hold on to before you start:

- **It runs in two phases, on two separate invocations, usually days apart.** The first uploads a consolidated bundle and deletes nothing at all. The second deletes, and only once every machine has demonstrably received the content. A user who runs it once and sees "consolidated" has not had anything removed and is not half way through a dangerous operation.
- **It only ever retires *this* machine's bundles.** If a thread's history was pushed from two machines, running it here reclaims this machine's share and no more. That is deliberate — one machine deleting another's files is what per-machine ownership forbids, and that rule is what makes concurrent push and pull safe with no distributed lock.

Follow these steps:

1. **Establish which thread.** There is no default and there is deliberately no "compact everything": the command deletes, so it never guesses. Run `/sesh-mover:whereis` (or `hub status`) to list this project's threads, and show the user the list with the thread ids. If they have already named a thread, use it.

2. **Ask before running it**, unless the user has plainly asked for this thread to be compacted. Say what the first phase does — re-uploads the whole transcript, deletes nothing — and what the second will eventually do. The re-upload is the cost worth naming: a long thread means the entire conversation goes over the wire again, which is exactly what continuation bundles exist to avoid, and on a slow or metered connection that matters.

3. Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub compact --thread "<threadId>" [--project-path "<dir>"]
   ```

4. Branch on the result:
   - `success: true` with `phase: "consolidated"` — a full bundle is on the hub and **nothing was deleted**. Report `consolidatedBundleId`. Tell the user the thread is already being served from the consolidated bundle, and that re-running later is what finishes the job. Do not imply anything is pending or broken.
   - `success: true` with `phase: "retired"` — the chain is gone. Report `retiredBundleIds.length` and, **always**, `retained`. A retained entry with `why: "not-covered"` is the one to read out in full: that bundle was kept because the consolidated transcript does not contain its head, which is what a parked fork or an adopted branch looks like — the hub may hold the only copy of that work. If `failed` is present, say which files could not be removed and that re-running finishes it; nothing is broken, they are simply still on disk and referenced by nothing.
   - `reason: "compaction-pending"` — **this is the normal answer, not an error.** Relay `outstanding` machine by machine, using `machineName` where it is there, and say what each one means: `behind` clears itself when that machine pulls; `unknown-head` needs one more push or pull from it; `no-anchor` means it is on a plugin version that predates chain assembly and needs upgrading, not catching up. If `eligibleAt` is present the grace window is also still open — give the time and say what the window is for: it is the only defence against a pull that is in flight right now, and against a machine whose interrupted pull left it holding content it never published. Nothing is broken meanwhile; the consolidated bundle is already what a reader fetches.
   - `reason: "unlinked"` — this directory is linked to no hub project. Follow the suggestion (`push --create-project`, or `--project-id` for one that already exists).
   - `reason: "lock-busy"` — another sesh-mover hub operation holds this project's lock. Wait and re-run the same invocation. There is deliberately no override: what it would be racing is a push writing new bundles into the very thread being compacted.
   - `reason: "hub-unreachable"` — nothing was written; report `hubState` and the suggestion.
   - An `error` with no `reason` — the usual cause is that this machine's index lists no such thread, or that no local session here is mapped to it. Compaction can only be run from a machine that holds the transcript, because a consolidated bundle is a fresh full export of it. Say which machine to run it on rather than suggesting a flag.

5. **Relay every entry in `warnings` verbatim.** Two of them carry the shape of the whole feature: that only this machine's bundles were retired, and — on the consolidate phase — that nothing has been deleted yet.

**Never run this on a schedule, in a loop, or as a follow-up to something else.** It is the only verb in this plugin that destroys data the user did not name a file for, it is unreachable from the session-end auto-push by design, and it has no config key for the same reason `push --full` has none: an unattended caller must not be able to make an irreversible choice.
