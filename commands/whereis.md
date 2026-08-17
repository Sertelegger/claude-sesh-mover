---
name: whereis
description: Show this project's sessions across all machines registered on the hub
---

You are running the sesh-mover whereis command. This is a read-only view — it never links or creates a hub project, and it never pulls anything. Follow these steps:

1. Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" whereis --project-path "<cwd>" --source-config-dir "<config-dir>"
   ```

2. If the result is `success: false`, report the `error` — most commonly "no hub configured", in which case point the user at `/sesh-mover:hub-init` — and stop.

2b. If `reachable: false` (a `success: true` result — `whereis` reports an unreachable hub, it does not refuse on one): **stop here and report that, before reading any other field.** `hubState` says which case it is — `"no-directory"` (an unmounted share, a synced folder that hasn't appeared on this machine yet, or a typo in `hub.path`) or `"not-a-hub"` (a directory is there but carries no `hub.json`, so it was never `hub init`-ed or points at the wrong folder). Three things not to do with the rest of the result, because none of them were read from the hub:

   - **`threads: []` means UNKNOWN, never "this project has no sessions elsewhere."** Do not render an empty table, and do not say the project is only on this machine.
   - **`linked` is a purely local fact** (the presence of `<project>/.sesh-mover-project.json`). `linked: true` here says nothing about whether the hub still has that project, and `linked: false` is not evidence that it doesn't.
   - **`linkCandidates` is absent, not empty** — don't offer a pick list, and don't fall through to step 3's "never been pushed from any machine" wording, which is what an empty list means when the hub *was* readable.

   Ask the user to mount/connect the share or check `hub.path` (`configure --show`), then offer to re-run — nothing was written, so a re-run is always safe. The result deliberately does not echo the path back; `hub status` is where the configured path is reported.

3. If `linked: false` (and `reachable: true`): tell the user this project isn't linked to a hub project yet.
   - If `linkCandidates` is non-empty, list the candidate(s) (name + gitRemotes) that this project's git remote matches, and point the user at `/sesh-mover:push` to link to one of them (or create a new hub project) — `whereis` itself cannot link.
   - If `linkCandidates` is empty, just say this project has never been pushed from any machine, and point at `/sesh-mover:push`.

4. If `linked: true` (and `reachable: true`): render `threads` as a table. Columns:
   - **Thread** — `slug`
   - **Machines** — the distinct machine names across `copies` (fall back to machine id if `machineName` is null)
   - **Latest** — `latest.machineName` (or id) and `latest.lastActiveAt`
   - **Current here?** — "yes" if `localCopy` is non-null and `localCopy.current` is true; "stale" if `localCopy` is non-null but `current` is false; "no local copy" if `localCopy` is null — **unless `unfetchableBundles` is present on that thread** (see step 5b), in which case render it as "partial" instead: `current` there means "level with the copy a pull would resolve to", not "holds the whole conversation"

   Example:
   ```
   Thread              Machines           Latest (machine @ when)         Current here?
   fix-auth-flow        laptop, desktop    desktop @ 2026-07-20T14:02:00Z  stale
   design-review        laptop             laptop @ 2026-07-19T09:11:00Z  yes
   ```

5. For any thread with `pullNeeded: true`, mention that `/sesh-mover:pull` (with that thread's slug/id) would bring it up to date on this machine — except where step 5b applies, which limits what "up to date" can mean. `pullNeeded` answers exactly one question, the same one `pull` asks: **would a pull of this thread fetch a bundle that has never arrived here?** It is not a statement about heads, so it can be true on a row whose "Current here?" reads "yes" (the newest head is here, and a bundle for the thread still is not) and false on a thread whose `latest` is another machine. It asks that of the thread's whole assembled chain, across every machine's bundle list — so it is also true for a thread whose remaining bundles sit on a machine this pull does not resolve to. Trust the field over the column.

5b. For any thread with a non-empty `unfetchableBundles` (a result field — branch on it, not on wording): a pull **assembles** a thread across every machine's bundle list, following the entry each bundle records itself as continuing from, so a history split across machines is delivered whole and this field is silent for it. When the field is non-empty, something about the chain itself defeated that: a **gap** (a bundle's link names an entry no bundle on the hub carries), a **parked branch** (the thread forks and a pull follows one side), or a **pre-assembly bundle** (pushed before this release recorded links at all — unlinkable by construction, *not* missing, and it re-links when the machine holding that session next pushes). Name the machines in the field (`machineName`, falling back to `machineId`) and say which condition applies — `pull`'s warning text says so, and the three have different answers. **What you may additionally offer depends on which machine holds the latest copy**, so work that out too: this machine's own entry in `copies` is the one whose `localSessionId` equals `localCopy.localSessionId`; compare its `machineId` with `latest.machineId`.

   - **`latest` is this machine's own copy** (`localCopy` non-null and its machine *is* `latest.machineId`): a remedy exists and it takes no flag. `pull` no longer stops at "the latest copy of this thread is already local" — it falls back to the copy that still lists bundles this machine has never received, fetches those, and warns that it did. Offer a plain `/sesh-mover:pull` for that thread. It reaches **one** of the named machines (the most recently active); if the field names more than one, the rest stay unreachable and the next bullet applies to them. If everything that machine lists turns out to be accounted for here already, the pull still answers "the latest copy of this thread is already local" — that is the pull reporting the truth, not a failure to follow through.
   - **`latest` is another machine**: a pull of this thread already reads every machine's list, so what the field names is not a machine that was skipped — it is a bundle no link can place. Say which of the three conditions applies, that nothing is lost because every bundle is still on the hub, and what (if anything) resolves it: a pre-assembly bundle re-links when the machine holding that session next pushes it; a gap and a parked branch are facts about the hub that no flag on this machine changes. **Offer no `--from-machine` and no `hub reindex` for those bundles: neither exists for this, and `hub reindex` only rebuilds *this* machine's index from *its own* bundles.**

   Never skip 5b for a thread that reads as "current" or `pullNeeded: false` — `pullNeeded: false` means "a pull would fetch nothing", never "this machine holds the whole conversation", and 5b is the only field that answers the second question.

6. Report any `warnings` from the result (e.g. a machine whose index file couldn't be read).

**Exit codes:** keep branching on the parsed JSON, not on `$?`. `whereis` is a diagnostic, so it exits `0` even when it reports `linked: false` or a hub whose index files it could only partly read — `$?` is not a link check and not a hub-health check; `linked`, `warnings` and `unfetchableBundles` are. `1` means the command itself failed and stdout carries an `ErrorResult`. See "Exit Codes" in the skill doc for the full four-class table.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocation above; do not search the plugin cache. The flag set documented in this file (`--project-path`, `--source-config-dir`) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
