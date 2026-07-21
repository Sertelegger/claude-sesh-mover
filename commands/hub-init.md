---
name: hub-init
description: Initialize or join a cross-machine session hub
---

You are running the sesh-mover hub init command. Follow these steps:

1. Explain briefly what the hub is: a shared directory that lets you push sessions from one machine and pull them on another (a synced folder like OneDrive/Dropbox/iCloud Drive/Syncthing, or a network share). State the trust model in one sentence: **the hub directory is a trust boundary** — anyone with read access to it can read every pushed session, because sessions are stored there in plaintext at rest until a future encryption slice ships.

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

7. Report to the user: hub path, created-vs-joined, machine registration confirmed, and point them at `/sesh-mover:push` to start sharing this project's sessions through the hub (linking happens automatically on the first push/pull, not during init).

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (`--path`, `--scope` for `hub init`; `hub status` takes no flags) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
