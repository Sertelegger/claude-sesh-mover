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

3. If `linked: false`: tell the user this project isn't linked to a hub project yet.
   - If `linkCandidates` is non-empty, list the candidate(s) (name + gitRemotes) that this project's git remote matches, and point the user at `/sesh-mover:push` to link to one of them (or create a new hub project) — `whereis` itself cannot link.
   - If `linkCandidates` is empty, just say this project has never been pushed from any machine, and point at `/sesh-mover:push`.

4. If `linked: true`: render `threads` as a table. Columns:
   - **Thread** — `slug`
   - **Machines** — the distinct machine names across `copies` (fall back to machine id if `machineName` is null)
   - **Latest** — `latest.machineName` (or id) and `latest.lastActiveAt`
   - **Current here?** — "yes" if `localCopy` is non-null and `localCopy.current` is true; "stale" if `localCopy` is non-null but `current` is false; "no local copy" if `localCopy` is null

   Example:
   ```
   Thread              Machines           Latest (machine @ when)         Current here?
   fix-auth-flow        laptop, desktop    desktop @ 2026-07-20T14:02:00Z  stale
   design-review        laptop             laptop @ 2026-07-19T09:11:00Z  yes
   ```

5. For any thread with `pullNeeded: true`, mention that `/sesh-mover:pull` (with that thread's slug/id) would bring it up to date on this machine.

6. Report any `warnings` from the result (e.g. a machine whose index file couldn't be read).

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocation above; do not search the plugin cache. The flag set documented in this file (`--project-path`, `--source-config-dir`) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
