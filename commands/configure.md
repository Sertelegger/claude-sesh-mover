---
name: configure
description: Set user or project level defaults for sesh-mover commands
---

You are running the sesh-mover configure command. Follow these steps:

1. Show current effective config:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" configure --show --json
   ```

2. Present the current settings grouped by command:
   - **Export defaults:** storage (user/project), format (dir/archive/zstd), excluded layers, scope (current/all), summary generation
   - **Import defaults:** dry-run first (true/false)
   - **Migrate defaults:** scope (current/all)
   - **Hub defaults:** hub path (set via `/sesh-mover:hub-init`), workspace snapshot on push (on/off), git-carry on push (on/off), and the two automation switches — auto-push at session end, freshness notice at session start. Call the last two out by name when showing hub settings: they are on by default and take effect as soon as a project is linked to a hub project, so a user who has linked one is already being auto-pushed.

   `--show` reports the effective config only, which is the contents of `config.json` merged across scopes. `machine.name` is not in it (see the key list below); read it from `~/.sesh-mover/machine-id.json` if the user asks what this machine is called.

3. Ask the user which settings they want to change.

4. For each change, apply it:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" configure --scope <user|project> --set "<key>=<value>"
   ```
   A `--set` writes **only that key** into the targeted scope's `config.json`; the file holds what that scope actually sets and nothing else, so a `--set hub.autoPush=false --scope project` leaves a file of exactly `{"hub":{"autoPush":false}}`. A key absent from a scope's file means that scope has no opinion on it — not that it wants the default. Don't hand-write a scope's config file with a full settings snapshot: at the project scope that pins every default over the user's settings.

   To clear a scope rather than change a key:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" configure --scope <user|project> --reset
   ```
   `--reset` empties the targeted scope's file. It does **not** write defaults, and it does not touch the other scope — so clearing the project scope hands this project back to the user-scope settings, which are then what applies. Offer it when a user wants a project to stop overriding their global setup.

5. Confirm what was saved, and be precise about what you are reading. In the result, `message` names the one key that was written (e.g. `Set hub.autoPush = false`) and `scope` merely echoes the `--scope` you passed. `config` is the **effective** config after the write — user scope merged with project scope — not the contents of the scope you targeted. So a project-scope `--set` will show values the project never set (they came from the user scope, or from the defaults). Report the key and scope from `message`, and describe `config` as "what applies in this project now", never as "your project settings".

Configurable keys:
- `export.storage` — "user" or "project"
- `export.format` — "dir", "archive", or "zstd"
- `export.exclude` — JSON array like `["file-history","plans"]`
- `export.scope` — "current" or "all"
- `export.noSummary` — true or false (functional: when true, exports use a slug-only manifest summary and skip parsing conversation text for it; the exported session JSONL itself is unaffected). It governs `push` too — including the session-end auto-push, which takes no flags — so it is the switch for a user who does not want a line of their conversation sitting in a bundle manifest on the hub. Worth naming when a user asks what leaves their machine: it is the *manifest* summary only, never the transcript, which travels in full either way.
- `import.dryRunFirst` — true or false
- `migrate.scope` — "current" or "all"
- `hub.path` — absolute path to the hub directory ("" = not configured; normally set via `/sesh-mover:hub-init` rather than by hand)
- `hub.noWorkspace` — true or false (when true, `push` skips the workspace snapshot by default). The snapshot is taken for a project with **no git remote** — which is not the same as "not a git project": a git repository with no remote configured takes this path too, since there is no remote to reconstruct its working tree from. It copies the project tree without reading `.gitignore` (only `.git`, the paths sesh-mover owns — `.sesh-mover/` and the `.sesh-mover-*` root dotfiles — the project-local `.claude` directory, which holds `settings.local.json`'s permission allowlists, and a few convenience excludes like `node_modules` are skipped), so this is the switch for a user who does not want project files leaving the machine at all. A project *with* a remote never takes this path — its uncommitted work travels via `hub.carryDiff` instead, and `hub.noWorkspace` does nothing for it.
- `hub.autoPush` — true or false (default true: push this project to the hub automatically when a Claude Code session ends. Inert until a hub is configured **and** this project is linked to a hub project, so it does nothing for a user who never touches the hub. The automatic push carries the same payload a manual one does, so `hub.noWorkspace` and `hub.carryDiff` govern it too — the hook takes no flags, which makes config the only way to express either opt-out for it.)
- `hub.startupNotice` — true or false (default true: at session start, announce that a newer copy of one of this project's threads exists on another machine. Same "hub + linked" precondition as `hub.autoPush`; the notice never appears when this machine already has the latest copy of everything.)
- `hub.carryDiff` — true or false (default true: for a project **with** a git remote, `push` carries the uncommitted work — a `git diff HEAD` patch plus untracked, non-gitignored files — alongside the sessions. `false` is the same as always passing `--no-carry`, and it is the only way to opt out of the **carry** for the session-end auto-push, which takes no flags. It is not the only opt-out that reaches that push at all: `hub.noWorkspace` governs its workspace half the same way, and `hub.autoPush=false` stops the push entirely. Worth naming explicitly when a user asks what leaves their machine: the patch describes every *tracked* file they changed, `.gitignore` notwithstanding.)
- `hub.pullAppend` — true or false (default true: `pull` splices a continuation onto the local session it continues instead of importing it as a separate session; false is the same as always passing `--no-append`)
- `hub.onDivergence` — "fragment", "adopt-hub", or "skip" (default "fragment": what `pull` does when a thread was extended on both machines from the same point — keep both as separate sessions, make the hub's branch canonical and preserve the local branch as a new session, or apply nothing and decide later. Same as always passing `--on-divergence <mode>`. Note `/sesh-mover:pull` passes `skip` explicitly so it can ask, so this setting is about direct CLI use.)
- `hub.carryMaxMb` — size budget in **megabytes** for the git-diff carry (default `50`). Over it the **whole** carry is declined with a warning naming the largest contributors; nothing partial is ever sent, because half a generated directory reads on the other machine as a corrupt install rather than as a truncated upload. Two things to say when a user asks about this one. First, **the decline is not retryable on demand**: the carry rides a bundle, so an immediate re-push answers `upToDate: true` and the raised budget only takes effect on the next push that has new session content — which is why there is no CLI flag for it, only this setting. Second, **the carry rides a bundle pushed on every session end, unattended, and the hub keeps every bundle** — so a 50 MB carry on a synced folder is 50 MB of sync traffic per session end. Each file also costs 512 bytes against the budget on top of its own size (so a tree of hundreds of thousands of empty files cannot slip a byte-only limit); that charge is fixed, so raising the budget raises the implied file ceiling in proportion.
- `hub.workspaceMaxMb` — the same, in megabytes, for the whole-project workspace snapshot a project with **no** git remote pushes instead of a carry (default `50`). Over budget the snapshot is skipped entirely and the sessions still push.

  Both budgets take the same values. `0` means **carry nothing** — an explicit off switch, never "unlimited" — so a user who wants that should be told it is equivalent to `hub.carryDiff=false` / `hub.noWorkspace=true` but expressed as a size. A negative, non-numeric or non-finite value is **not** silently accepted: the default applies and the push warns naming the key. Anything over `1024` is clamped to 1024 MB, with a warning; that ceiling is a memory limit, not a policy one — both payloads are held in memory whole, to capture and again to check on the receiving machine. A budget above what the *receiving* machine will inspect (128 MB) produces payloads a peer saves but does not apply, which is the fail-closed direction and leaves the saved copy as the remedy.

- `hub.encrypt` — true or false (default false). **Inert as of 0.9.0 — nothing encrypts a bundle yet**, so setting it records an intention and changes no byte that leaves this machine; say that plainly rather than letting a user believe they have just turned encryption on. It is also, deliberately, **not the switch even once encryption ships**: the authoritative one is an `encrypt` field in the hub's own `hub.json`, because a local-only flag has a silent failure — one machine that never set it keeps pushing plaintext into a hub the user believes is sealed, and nothing anywhere says so. This key is the local *preference*, i.e. what a future enable verb writes through to the hub.

- `machine.name` — this machine's display name (any string; defaults to the OS hostname). It is what other machines see for this one in `/sesh-mover:whereis`, in pull reporting and in the session-start notice, and it names this machine as a peer in incremental export/import. Settable through the same `--set` as the keys above, but it is **not a config.json setting**: it is written to `~/.sesh-mover/machine-id.json`, so `--scope` has no effect on it (it is always this machine's, whichever scope you pass) and it never appears in the `config` the result reports.

**Exit codes:** keep branching on the parsed JSON, not on `$?`. `configure` exits `0` on every successful read or write, and `1` for a `--set` it rejected — a non-numeric value for a numeric key, malformed JSON for a list key, a missing `key=value` — with the `ErrorResult` on stdout saying which. Commander's own argument rejection is also `1` but prints on stderr and leaves stdout empty. See "Exit Codes" in the skill doc for the full four-class table.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (in both the main invocations and any conditional branches) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface.
