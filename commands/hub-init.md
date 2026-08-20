---
name: hub-init
description: Initialize or join a cross-machine session hub
---

You are running the sesh-mover hub init command. Follow these steps:

1. Explain briefly what the hub is: a shared directory that lets you push sessions from one machine and pull them on another (a synced folder like OneDrive/Dropbox/iCloud Drive/Syncthing, or a network share). State the trust model in one sentence: **the hub directory is a trust boundary** — by default sessions are stored there in plaintext at rest, so anyone with read access to the folder can read every pushed session. Encryption at rest exists as of 0.10.0 and is **off by default**; `/sesh-mover:hub-encrypt --enable` turns it on for the hub, and it seals what is pushed *afterwards* — it never rewrites what is already there. If the user is initializing a hub on a share other people can read, that ordering is worth one extra sentence now rather than a migration later: sealing an empty hub costs nothing, and sealing a full one leaves everything in it readable forever.

2. Ask the user for the hub directory. If you can suggest a likely candidate (an existing synced folder you can detect, e.g. `~/OneDrive`, `~/Dropbox`, `~/Library/Mobile Documents` for iCloud Drive), offer it with AskUserQuestion alongside a free-text option; otherwise just ask for the absolute path as free text. Prefer a folder that's actually synced across the user's machines — a plain local-only path only "shares" with itself.

3. Ask for the config scope, only if it isn't obvious (e.g. skip this question if the user has never used project-level config before). Use AskUserQuestion:
   - "This machine, all projects" (recommended/default) → `--scope user`
   - "This project only" → `--scope project`

4. Run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub init --path "<hub-dir>" --scope <user|project>
   ```

5. Parse the result:
   - If `success: false`, report the `error` and `suggestion` (e.g. the directory isn't writable, or an existing `hub.json` at that path couldn't be read) and stop.
   - If `success: true`: `created: true` means this machine just minted a brand-new hub at that path (it's empty and ready for other machines to join by pointing `hub init` at the same folder); `created: false` means it joined a hub another machine already initialized there. Mention which case happened — it matters for whether the user should expect existing projects/threads to show up.

6. Confirm registration by running:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub status
   ```
   Report `hubPath`, `reachable`, `machineRegistered`, and `project.linked` from the result. If `reachable` is false or there are `warnings`, surface them — a hub that was just created should normally come back reachable and registered.

   `hub status` is a **diagnostic** and always returns `success: true`: unlike `push`, `pull` and `hub reindex`, it reports an unreachable hub instead of refusing, because reporting it is the question it was asked. `hubState` says which state, and the remedies differ:

   - `"ok"` — `reachable: true`. The normal case.
   - `"no-directory"` — nothing is at `hub.path`: an unmounted share, a synced folder that hasn't reached this machine, or a typo. **Do not offer `hub init` here** — running it at an unmounted mount point mints a *different* hub in a directory that will be shadowed the moment the real one mounts. Offer to check the path (`configure --show`) or to mount the share.
   - `"not-a-hub"` — a directory is there but carries no usable `hub.json`. If it's a synced folder the first sync may still be in flight, so offer to wait and re-check; otherwise the path names some other directory and `hub init` (at the right path) or `configure --set hub.path=<dir>` is the fix.
   - `"unresponsive"` — the path is mounted and a filesystem call against it did not come back within the hub I/O timeout: a hard-mounted network share whose server has gone away, or a sync/FUSE daemon that has died. **Do not offer `hub init`, and do not offer to check `hub.path`** — the path is almost certainly right, and both of the remedies above are wrong for it. The fix is outside sesh-mover: reconnect or force-unmount the filesystem, then re-run. This is also the one state that takes real wall-clock time to report, because it is defined by a call that never returned.
   - `null` — no hub is configured at all (`hubPath` is also `null`). This is not a failure: point at `/sesh-mover:hub-init` and say nothing about mounts.

   `hub status` is also the one hub result that reports the configured path; the `hub-unreachable` refusals from `push`/`pull`/`hub reindex` withhold it on purpose and point here instead.

7. Report to the user: hub path, created-vs-joined, machine registration confirmed, and point them at `/sesh-mover:push` to start sharing this project's sessions through the hub (linking happens automatically on the first push/pull, not during init). On `created: true` — a brand-new, still-empty hub — also point at `/sesh-mover:hub-encrypt`, and say why the moment matters: enabling encryption seals only what is pushed after it, so an empty hub is the one time it costs nothing to leave behind. Do not run it for them, and do not raise it on a `created: false` join, where the decision belongs to whoever owns the existing hub.

8. State the automation consent, once, in the same breath — **linking a project is what turns it on**, so say it before the user runs their first push rather than after: linking a project enables automatic push when a session ends and a startup notice when another machine has newer work; disable with `configure --set hub.autoPush=false` / `hub.startupNotice=false` (add `--scope project` to limit either to this project). Both are inert until a project is actually linked, so `hub init` on its own changes nothing about how sessions end or start. Mention what the automatic push carries, because it is the same payload as a manual one: this project's sessions, plus — depending on the project — a workspace snapshot (no git remote) or a `git diff HEAD` patch and untracked files (git remote); `hub.noWorkspace` / `hub.carryDiff` are the opt-outs for those two, and the hook takes no flags, so config is the only place to express them.

**Exit codes:** keep branching on the parsed JSON, not on `$?`. `hub init` exits `0` once the hub is created or joined, `1` for a bad invocation (a missing `--path`, an unknown `--scope`) or an unexpected failure, and `2` for a refusal it reported as a result — a path it could not create, or a directory it could not make a hub of. `hub status` is a diagnostic and exits `0` **even when it reports `reachable: false`**: the whole point of that verb is to describe the state, so read `hubState`, never `$?`. See "Exit Codes" in the skill doc for the full four-class table.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (`--path`, `--scope` for `hub init`; `hub status` takes no flags) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
