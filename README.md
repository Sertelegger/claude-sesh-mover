# claude-sesh-mover

[![CI](https://github.com/Sertelegger/claude-sesh-mover/actions/workflows/ci.yml/badge.svg)](https://github.com/Sertelegger/claude-sesh-mover/actions/workflows/ci.yml)

> Export, import, and migrate Claude Code sessions across machines, operating systems, config directories, and project paths — including **incremental round-trips** between two machines.

Claude Code sessions are JSONL files keyed to an absolute path on the machine that created them, so they can't follow you to another laptop, directory, or across the Windows ↔ WSL boundary. `claude-sesh-mover` rewrites the path-dependent bits so a session can be resumed anywhere.

| Command | What it does |
|---|---|
| `/sesh-mover:export` | Bundle one or all sessions into a portable directory or `.tar.gz`/`.tar.zst`. Incremental mode sends only what's new since the last sync to a peer. |
| `/sesh-mover:import` | Unpack on the target machine, rewrite paths, register for `claude --resume`. Idempotent — re-imports are skipped (`--allow-duplicates` overrides). |
| `/sesh-mover:migrate` | Same-machine move: export + import + delete source. Optionally renames the project directory (`--rename-dir`). |
| `/sesh-mover:browse` | List exports, view manifests, import, or delete. |
| `/sesh-mover:configure` | Set defaults (scope, storage, format, layers) and the machine's name (`--set machine.name=<label>`). |
| `/sesh-mover:hub-init` | Set up (or join) a shared directory as the cross-machine session hub. |
| `/sesh-mover:push` | Publish this project's sessions to the hub. |
| `/sesh-mover:pull` | Bring a project's thread down from the hub onto this machine. |
| `/sesh-mover:whereis` | Read-only: which machines have which sessions for this project, and which is latest. |
| `/sesh-mover:hub-unlink` | Unlink this directory from the hub: removes its `.sesh-mover-project.json` and nothing else, which disarms the automation here. Writes nothing to the hub. |

The hub also runs itself once a project is linked: a session-end auto-push and a session-start "newer work elsewhere" notice — see [Automation](#automation) for what they do, how to turn them off, and how to unlink a directory entirely. Where this is heading beyond that — assembling a thread whose history is split across three machines, encryption at rest, a web service — and later other agentic CLIs, is tracked in [ROADMAP.md](./ROADMAP.md). Release history: [CHANGELOG.md](./CHANGELOG.md).

## Install

```text
/plugin marketplace add sertelegger/claude-sesh-mover
/plugin install sesh-mover@claude-sesh-mover
```

If the slash commands don't appear, run `/reload-plugins`. No build step — the plugin only needs Node.js ≥ 22.12 (current Claude Code releases already require Node ≥ 22). Optional: a `zstd` binary for `.tar.zst` archives — exporting falls back to `.tar.gz` automatically without it, but *reading* a `.tar.zst` someone else sent you (browsing its metadata or importing it) does require zstd on this machine (`brew install zstd`, or `sudo apt-get install -y zstd` on Debian/Ubuntu/WSL).

For local development, clone and load directly (a pre-built `dist/` ships in the repo):

```bash
git clone https://github.com/sertelegger/claude-sesh-mover.git
claude --plugin-dir ./claude-sesh-mover
```

### Upgrading to 0.8.0 — a clean break

**0.8.0 does not read, migrate, or warn about anything a previous version wrote.** Two consecutive releases renamed on-disk paths, and 0.8.0 ends the compatibility machinery rather than carrying it: there is no fallback read of an old name, no rename-on-first-run, and no stale-name notice. These are the only paths it knows:

| What | Where it lives |
| --- | --- |
| Machine identity, sync state, locks, user-scope exports and config | `~/.sesh-mover/` |
| Project-scope exports and parked carry payloads | `<project>/.sesh-mover/` |
| The opt-in re-include list (committed) | `<project>/.sesh-mover-include` |
| The exclusion list (committed) | `<project>/.sesh-mover-ignore` |
| This project's hub identity (committed) | `<project>/.sesh-mover-project.json` |

The per-project state is split by **lifecycle**: generated exports (which must never be committed) live in `.sesh-mover/`, while config and identity (which must be committed, or they do nothing) are root dotfiles outside it. That is why a plain `.sesh-mover/` line in `.gitignore` is all a project needs, with no negation.

**Coming from an older version, here is the whole of it:**

- **Recreate `.sesh-mover-include` and `.sesh-mover-ignore`** at the project root, with the same contents as whatever you had before (`.sesh-mover-hubinclude` / `.sesh-mover-hubignore` in 0.7.0, `hubinclude` / `hubignore` inside `.claude-sesh-mover/` before that). A file left under an old name is simply not read, so the project behaves as if it had no list at all — recoverable, and deliberately preferred to a list that is silently read in part.
- **For each project's hub link, either copy `.sesh-mover-project.json` across verbatim** — from `.claude-sesh-mover/project.json` if that is where yours is — **or do nothing**, and let the next `/sesh-mover:push` re-link the project by its git remote (or offer to mint a fresh hub project). Copying it across also re-arms the automation for that directory ([Automation](#automation) below), since the file's existence is the consent gate: `sesh-mover hub unlink` removes it again if that isn't what you wanted, and — unlike every other hub verb — it needs no configured or reachable hub to do it.
- **`~/.claude-sesh-mover/` and `<project>/.claude-sesh-mover/` can simply be deleted.** Nothing reads them. A machine that had not already taken the 0.7.0 upgrade gets a new machine identity and starts its hub bookkeeping fresh; its sessions are still on the hub and still pullable.

A file left under a retired name is inert clutter, not a redirect — and that is also why the retired names are **no longer on the never-syncable floor** (below). A floor entry stops a payload planting a file some reader consults; with no reader left, it guarded nothing.

## Quick start

Move a session from machine A to machine B:

1. On A: `/sesh-mover:export` → pick "this session", archive format. Note the `.tar.gz` path it reports.
2. Copy the archive to B (scp, cloud drive, whatever you trust — it contains your conversation).
3. On B, in the project directory: `/sesh-mover:import` → point it at the archive, confirm the dry-run.
4. `claude --resume` — the imported session is in the list.

## Usage notes

**Export** prompts for scope (one session / all for the project), storage (`~/.sesh-mover/` or `./.sesh-mover/`), format, and layers (JSONL, file-history, tool-results, memory, plans, subagents). `--no-summary` keeps conversation excerpts out of the manifest and resume listings (the JSONL itself is still exported in full).

**Import** shows a dry-run of the path rewrites before touching anything. If Claude Code rejects the session over a version mismatch, `--no-register` imports the content without the resume entry. Already-imported sessions are skipped and reported in `skippedSessions`; `--allow-duplicates` forces a re-import.

**Browse** lists every export it finds in `~/.sesh-mover/`, `./.sesh-mover/`, and the project root (archives sitting loose in the project root are only picked up if their filename carries the standard `YYYY-MM-DD-` export prefix), with each bundle's *origin* platform, project path, export date, and session count — read from the bundle's own manifest, archives included, so a `.tar.gz` carried over from WSL still says `wsl2`. If a bundle's metadata can't be read (a `.tar.zst` on a machine without `zstd`, a corrupt archive), that entry is marked `metadataAvailable: false` with the reason instead of showing invented values, and the rest of the listing is unaffected. Reading `.tar.zst` metadata decompresses the whole bundle first, so browsing a directory of large zstd archives takes a moment.

**Migrate** is for same-machine moves (repo relocated, home dir renamed, config dir switched). Don't run it from inside the session being migrated — the CLI blocks this; exit, start a fresh session from an outer directory (e.g. `~/`), and run it there. `--scope current` requires `--session-id`.

`export`, `import`, `migrate`, `push`, and `pull` all accept `--progress`, which emits NDJSON progress events on stderr (one JSON object per line) while leaving stdout's JSON result contract unchanged — useful when driving the CLI directly rather than through the slash commands. On `push` and `pull` the `hub-push`/`hub-pull` events carry a coarse `percent` and the per-session detail comes from the export/import phases underneath them. A `pull` emits either no events at all (it was refused before it took the project lock) or an opening `percent: 0` and a closing `percent: 100` — the closing one always arrives, including when the pull is refused or fails, so `100` means "finished", not "succeeded".

### Incremental sync between two machines

After one full export → import round-trip, exports to that peer can be incremental: new sessions ship whole, sessions with new messages ship as **continuation sessions** (a new session that starts with a lineage note, followed by only the messages added since the last sync), unchanged sessions are skipped. The export flow offers this automatically once a peer is known.

- Machine identity: `~/.sesh-mover/machine-id.json` (name defaults to hostname). Per-project sync state: `~/.sesh-mover/sync-state/`.
- No sync state for a peer? `/sesh-mover:export --incremental --since <path-to-previous-export>` diffs against that bundle directly.
- Work on one machine at a time: parallel edits to the same session produce two independent continuations, not a merge.

## The Hub

Incremental sync (above) moves sessions one peer-to-peer round-trip at a time — you still have to know which machine to pull from. The hub is a shared directory that removes that bookkeeping: push sessions to it from any machine, and any other machine that points at the same directory can see what's there and pull it down.

### Quick start

1. On machine A: `/sesh-mover:hub-init` → point it at a directory both machines can reach (see storage guidance below). This mints a hub (or joins one that already exists there).
2. Still on A, in a project directory: `/sesh-mover:push` — publishes this project's sessions to the hub. First push in a project links it to a hub project (matched by git remote, or minted fresh).
3. On machine B: `/sesh-mover:hub-init` pointed at the *same* directory, then in the same project (cloned there, or pulled fresh — see the bootstrap case in `/sesh-mover:pull`), run `/sesh-mover:whereis` to see every machine's copy of this project's sessions and which is latest, then `/sesh-mover:pull` to bring the one you want down onto B.

`whereis` is read-only — it never links a project or pulls anything, so it's safe to run just to look.

### Automation

Once a project is linked to a hub project, sesh-mover keeps it current without being asked. Two Claude Code lifecycle hooks do it:

- **Session end → push.** When a Claude Code session ends in a linked project, the same payload a manual push would send goes by itself: this project's sessions, plus a workspace snapshot (no git remote) or a `git diff HEAD` patch and untracked files (git remote). What it does *not* do is talk to you. It runs detached, so it never delays session exit, and its output goes nowhere a clean exit shows — so the warnings a manual push prints (including the disclosure naming gitignored-but-tracked files whose contents the patch carried off this machine) are not printed here, and a chronically failing auto-push (an unmounted share, say) doesn't announce itself either. Both are recorded instead: `sesh-mover hub status` reports the last automatic push for the project you're in, with its warnings or its error (`lastAutoPush`). Detached also means nothing bounds it: a push wedged on an unreachable network path leaves a `node` process running until the path answers.
- **Session start → notice.** When a session starts or resumes in a linked project, sesh-mover checks the hub and, if another machine holds newer work for this project, injects one line naming the thread, the machine, and how long ago — then gets out of the way. It's bounded at 10 seconds so an unreachable hub can't stall session start, and it says nothing at all when this machine already has the latest of everything.

**Linking a project is the consent gate.** Both are on by default and both are inert until a hub is configured *and* the project is linked — so nothing happens for anyone who never uses the hub. The flip side: if you linked a project under an earlier version, the automatic push starts at your next session end, with no further action. Turn either off per machine (or add `--scope project` for one project):

```bash
sesh-mover configure --set hub.autoPush=false
sesh-mover configure --set hub.startupNotice=false
```

The automatic push takes no flags, so `--no-workspace` / `--no-carry` can't be given to it — `hub.noWorkspace=true` and `hub.carryDiff=false` are how you opt out of those payloads everywhere, manual pushes included.

**Unlinking is the other lever, and it works on one directory at a time:**

```bash
sesh-mover hub unlink [--project-path <dir>]      # or /sesh-mover:hub-unlink
```

Because the link *is* the consent gate, removing `<project>/.sesh-mover-project.json` makes both hooks inert for that directory — and that file is all `hub unlink` removes. It writes nothing to the hub (it doesn't even open it), so sessions already pushed stay there and no other machine is affected, and it deliberately does **not** require a configured or reachable hub: this is the disarm path for automation that is on by default, so an unmounted share or a `hub.path` you have since removed must not be able to block it. It is idempotent (an unlinked directory reports `wasLinked: false` and succeeds), it takes the same per-project lock push and pull take (`--force` skips that, at the price of a still-running push re-creating the link when it finishes), and it keeps this machine's sync bookkeeping on purpose — the result hands you back the `projectId`, so `sesh-mover push --project-id <id>` re-links to the same hub project and carries on rather than re-uploading everything. Deleting that one root dotfile by hand does the same thing; the command adds the lock, the disclosure and the id.

### Storage

The hub backend is filesystem-only in this slice: point `hub init --path` at anything that behaves like a directory both machines can read and write —

- a network share (SMB/NFS mount), or
- a synced folder (OneDrive, Dropbox, Syncthing, iCloud Drive, …).

Synced folders have two gotchas the hub can't paper over:

- **On-demand hydration** (OneDrive Files On-Demand, Dropbox Smart Sync, and similar): a file can exist in the folder's listing before its content is actually downloaded to this machine. If `pull` needs a bundle that hasn't hydrated yet, it returns `reason: "not-yet-synced"` with the specific files it's waiting on, instead of silently reading a truncated file.
- **Sync lag**: a push from another machine may not be visible here until the sync client catches up. The fix in both cases is the same — wait a moment for the client to sync/hydrate, then retry the same command. On `not-yet-synced`, the slash command will offer to retry for you rather than retrying automatically.

### Trust model

**The hub directory is a trust boundary, not a vault.** Sessions are stored there in plaintext at rest — anyone with read access to the hub folder can read every session ever pushed to it, until a future encryption-at-rest slice ships (tracked in [ROADMAP.md](./ROADMAP.md)). Every pulled bundle still goes through the same tar-entry and manifest-id validation as a manual import — see [Security notes](#security-notes) below; the hub doesn't relax any of that, it just adds a shared drop point on top.

**Point it at a directory only your own machines can write.** Pulling is not a read-only operation: a bundle can carry project files (a workspace snapshot, or another machine's uncommitted work), and applying them writes into your working tree. A short list of names is refused unconditionally, on every path — `.git`, and everything sesh-mover owns (`.sesh-mover/`, `.sesh-mover-include`, `.sesh-mover-ignore`, `.sesh-mover-project.json`), at any depth and in any casing or dot spelling, so a bundle can never plant the files that decide where your hub is or what your next push uploads — and a carry needs `--apply-carry` plus a clean tree at the exact base commit before it touches anything. Beyond those, an applied payload can write ordinary project files, which on a *shared or hostile* hub would be enough to reach code execution the next time you build or run something ([#36](https://github.com/Sertelegger/claude-sesh-mover/issues/36)). Relatedly, the merge's "only merge against a generation both trees held" rule is verified on your side and taken on trust from the sender's ([#37](https://github.com/Sertelegger/claude-sesh-mover/issues/37)). Both are fine for a folder shared between machines you own, which is what this slice is for; both are gates on any future multi-user backend.

### Workspace snapshots

For projects with no git remotes (including remote-less git repositories), `push`/`pull` also carry a **workspace snapshot** — a copy of the project's files, not just its Claude Code sessions — because there's no git remote to reconstruct the project from otherwise. Skip it with `--no-workspace` on push. To exclude specific paths from the snapshot (large build artifacts, secrets, anything you don't want copied into the hub), add a `.sesh-mover-ignore` file at the project root (one pattern per line, `#` comments allowed; matched against path segments, with `*` wildcards — not full `.gitignore` semantics; `dir/` and `dir` mean the same thing). `.sesh-mover-ignore` also works in the other direction: when a pull merges an incoming payload, a path it names is not applied and your local file there is left alone (reported in the merge's `skipped` list). `--force-workspace` does not honor that — it takes the hub's copy wholesale.

A snapshot (and the git carry below) rides a bundle, and a bundle is only written when a **session** has something new in it: with no new messages, `push` reports `upToDate` before writing anything at all. So editing project files without talking to Claude Code publishes nothing — the files travel with the next push that has conversation in it.

A snapshot is a plain file copy: it does **not** read `.gitignore`. Four things keep a file out of it: `.sesh-mover-ignore`, the built-in excludes (`.git`, `.claude`, `.sesh-mover`, `node_modules`, `.venv`, `__pycache__`, `.DS_Store`), symlinks (never followed, never copied — reported as `symlinksSkipped`), and a size budget — 50 MB by default, `hub.workspaceMaxMb` to change it — over which the whole snapshot is declined with a warning rather than partially copied. A remote-less git repository takes this path, so a gitignored `.env` sitting in one **is** copied into the bundle unless `.sesh-mover-ignore` names it — that is the opposite of the git-carry rule below, and the difference is which payload builder ran, not which files you have.

**`.claude` is on that list for a privacy reason, not a size one.** The project-local Claude Code directory holds `settings.local.json` — permission allowlists, which routinely name paths and hostnames — plus any project hooks and agents, and if your `CLAUDE_CONFIG_DIR` points somewhere inside the project it holds the transcripts themselves, which would then travel a second time inside the *project* payload rather than the session payload. Since 0.6.0 none of it is snapshotted. It is a default rather than a hard rule, so `.sesh-mover-include` names it back if a shared `.claude/settings.json` or a set of committed agents is content you *do* want on your other machines — unlike `.git` and the paths sesh-mover owns, which no pattern can re-include. In a project **with** a git remote the split below applies to it like any other path: a committed `.claude/settings.json` you have edited still travels in the patch (it is tracked project content you chose to commit), while an untracked `.claude/settings.local.json` no longer does.

The opposite lever is `.sesh-mover-include`, a root dotfile beside `.sesh-mover-ignore` and with the same wildcards — but note one deliberate difference, spelled out below: a trailing slash is decoration in `.sesh-mover-ignore` and meaningful in `.sesh-mover-include`. Paths listed there are carried **even if** `.sesh-mover-ignore`, the built-in excludes or `.gitignore` would drop them (`.gitignore` only ever applies to the git carry below, where it decides which *untracked* files travel). It is meant to be **committed**, so one line fixes a project on every clone and every machine — this repo's own gitignored `docs/superpowers/` specs are the motivating case. Committing it takes nothing special: the three files a project is meant to keep — `.sesh-mover-include`, `.sesh-mover-ignore` and the hub identity `.sesh-mover-project.json` — are ordinary root dotfiles no ignore rule touches, and the one path to ignore is `.sesh-mover/`, where generated exports and parked carry payloads land. A plain `.sesh-mover/` line does it, with no negation — which is the point of splitting the two lifecycles: a single directory holding both meant that ignoring your exports also silently stopped the include list and the identity file being committed, the one thing that makes them work.

A pattern with a `/` **anywhere in it** — trailing one included — is rooted at the project: `docs/` is `docs` at the top level and everything under it, never a `docs` nested somewhere else; `docs/superpowers/` carries that subtree, `docs/*.md` those files. Only a pattern with no separator at all matches that name at any depth (`*.keepme`). This is the difference from `.sesh-mover-ignore`, where patterns are matched per path segment and a trailing slash is stripped: `docs/` there excludes a `docs` at **any** depth, while `docs/` here names back only the top-level one. Some paths can never be re-included, by any pattern or spelling: `.git`, and everything sesh-mover owns — `.sesh-mover/`, `.sesh-mover-include`, `.sesh-mover-ignore` and `.sesh-mover-project.json`. The dotfiles need the floor *more* than the directory does: they are files at the project root, so a payload can name one directly with no directory in the way. Treat the file as security-relevant — `.gitignore` is also where `.env` lives, so list only what you mean to upload. It applies to **both** payload builders: the workspace snapshot for a project with no remotes, and the git carry below for a project with one. A push that re-includes gitignored files names them back to you in `carry.reIncluded` and in its warnings.

### Applying a workspace snapshot: 3-way merge, never a silent overwrite

A pull applies an incoming snapshot one of three ways, and the result says which:

- **Merge** — when this machine and the payload share a *generation* (a snapshot both trees are known to have passed through, matched by bundle id). Every file is decided against that common ancestor: unchanged here → take theirs, unchanged there → keep yours, changed on both → a real 3-way merge via `git merge-file`. Reported as `workspaceMerge`.
- **Unpack** — into an empty project directory, or when you pass `--force-workspace`, which means "give me the hub's copy wholesale" and overwrites files of the same name. Reported as `workspaceUnpacked` alone.
- **Skip** — a directory that already has content with no shared generation to merge from. Nothing is written, and the sessions still import normally. The warning names `--target-path <fresh-dir>` (unpacks elsewhere, destroys nothing) and `--force-workspace` (overwrites) — but treat those as applying to the *next* payload rather than as a retry of this one: the pull has already recorded its bundles, so an immediate re-run can answer "already up to date" before it reaches the files. Nothing is lost either way; the payload stays in the bundle on the hub. **This state does not clear itself.** A skip applies nothing, so it records no generation, so the next payload from that machine has nothing to merge against either and skips for the same reason — and every workspace bundle written before 0.6.0 declares no ancestor at all, which is exactly how the first 0.6.0 pull of an existing hub project lands here. Getting to the merge takes one deliberate application **into this directory**, and only `--force-workspace` on a later pull is that: it takes the hub's copy over the current files, after which both trees share a generation and later payloads merge. `--target-path <fresh-dir>` on a later pull is the non-destructive way to *see* a payload — it unpacks elsewhere and touches nothing here — but sesh-mover keys its bookkeeping off the effective project path, so the generation it records belongs to that fresh directory and pulls into the original go on skipping identically. **It does leave one thing behind in that directory.** A pull that delivers a payload there also plants `.sesh-mover-project.json` in it, which *links* that directory to the hub project — and linking is the consent gate for the session-end auto-push ([Automation](#automation) above). Looking at the files is still inert; what is not is starting a Claude Code session **in** that scratch directory, because its session end would then push that directory's contents to the hub. `sesh-mover hub unlink --project-path <that-dir>` (or `/sesh-mover:hub-unlink`) is the supported way to undo that, and deleting `.sesh-mover-project.json` there by hand does the same thing — the gate is that one file's existence, nothing else. Either way it is a root dotfile rather than something the `.sesh-mover/` directory beside it contains; that directory holds any carry payload parked there and can be deleted separately.

What the merge will and won't do:

- **Conflict markers are normal.** A file both sides changed in the same place comes back with markers in it — `<<<<<<< local`, `||||||| ancestor`, `>>>>>>> incoming` — and is listed in `conflicted`. Resolve them the way you would a git conflict.
- **Nothing is merged blindly.** A file both sides changed that can't be merged — a binary, one `git merge-file` fails on, or any of them if there's no usable `git merge-file` on this machine — keeps your copy, with the incoming one parked beside it as `<name>.theirs-<timestamp>` (`sidecars`). Delete those once you've reconciled — otherwise the next push carries them back to the hub.
- **Some paths get nothing written near them at all.** If a symlink or a directory occupies the destination (or one of its parent segments), the file is reported in `skipped` and no sidecar is left either — parking one beside a `docs -> ~/notes` symlink would escape the project exactly as the original write would. The incoming copy is still in the bundle on the hub. Files your own `.sesh-mover-ignore` excludes land here too (`locally-excluded`), which is a rule on this machine rather than a fault.
- **The merge never deletes.** A file the other machine deleted is kept here and reported (`upstreamDeleted`) — delete it yourself if you agree. Symmetrically, a file *you* deleted that nobody changed upstream stays deleted (`localDeleted`), while one you deleted that *was* changed upstream comes back (`restored`), because that edit exists nowhere else. `localDeleted` is a report, not a verdict: a path an earlier merge couldn't write to lands in the same list, so it doesn't prove you deleted anything.
- **Falling back is safe by construction.** Without a common ancestor, sesh-mover refuses to guess one — no timestamp is consulted anywhere in that decision, because the hub stamps nothing and every clock in it belongs to the machine that pushed. An older-than-necessary base fails toward "keep local, show a conflict"; a wrong newer one would fail toward silently overwriting your work, so it is never chosen.
- The floor can never be applied, whatever a bundle says: `.git`, and every path sesh-mover owns (`.sesh-mover/`, `.sesh-mover-include`, `.sesh-mover-ignore`, `.sesh-mover-project.json`) — at any depth, in any casing (`workspaceRefused`).

### Uncommitted work (git projects)

For a project **with** a git remote there is no workspace snapshot — git already has the committed state — so `push` carries the part git does not publish: a `git diff HEAD` patch (staged and unstaged, binary-safe) plus untracked, non-gitignored files, under `carry/` in the bundle. Skip it with `--no-carry`, or turn it off everywhere (including for the SessionEnd auto-push, which takes no flags) with `sesh-mover configure --set hub.carryDiff=false`.

The carry has two halves and they obey **different** rules, so it is worth being precise about which is which.

*Untracked* files — the copied half. What never travels: gitignored files unless `.sesh-mover-include` names them, symlinks, `.git`, the paths sesh-mover owns, `.claude`, and anything else `.sesh-mover-ignore` or the built-in excludes drop. The whole payload is declined if it exceeds the carry budget — **50 MB** by default since 0.7.0, `hub.carryMaxMb` to change it (reported as a warning naming the largest contributors). It was 5 MB, on the reasoning that a carry is a *diff* and therefore small; measured, that is simply not true of uncommitted work — this repository's own untracked `.superpowers/` notes are ~12.6 MB, so the carry declined on the very repo that produced the tool. Each file also costs 512 bytes against the budget on top of its own size, so a tree of hundreds of thousands of empty files cannot slip a byte-only limit.

Two things about that number are worth knowing before you raise it. **The decline is not retryable on demand:** the carry rides a bundle, so an immediate re-push answers `upToDate` and the new budget takes effect on the next push that has new session content — which is why it is a config key and not a flag (the push that matters most is the unattended session-end one, which takes no flags at all). And **the carry rides a bundle pushed on every session end, and the hub keeps every bundle**, so a 50 MB carry on a synced folder is 50 MB of sync traffic per session end. `0` means carry nothing; a value that is not a size falls back to the default with a warning rather than silently; anything over 1024 MB is clamped, because both payloads are held in memory whole to build and to check.

*Tracked* files — the patch half. **None of those rules filter the patch.** `git diff HEAD` describes every tracked file you changed, so a change to a file that is gitignored *and* tracked travels in full: the common shape is a `.env` that was committed once and gitignored later without `git rm --cached`, and `git add -f` produces the same thing. `.sesh-mover-ignore` does not stop it either. Push names that set back to you in `carry.trackedIgnored` and in a warning; the remedies are `git rm --cached <path>` or `--no-carry`. On the **automatic** session-end push that warning has no one to print to — it is recorded in sync-state instead and reported by `sesh-mover hub status` as `lastAutoPush`, which is worth checking once after linking a project you have gitignored-but-tracked files in. One rule *does* cover the patch — the floor: `.git` and every path sesh-mover owns are excluded from it as well, so a tracked `.sesh-mover/config.json` (which can redirect `hub.path`) or `.sesh-mover-include` never rides along. `.claude` is deliberately **not** in that floor, only in the built-in excludes, which filter the untracked half alone — so a committed `.claude/settings.json` you have edited travels in the patch like any other tracked file you chose to commit, while its untracked `settings.local.json` sibling does not.

The patch records the working tree as it stands, so capturing during a conflicted merge or rebase captures the conflict markers too; the push says so, and the operation itself does not travel. The carry is for the work you have not committed, not a replacement for git — push your branch as usual.

On the other machine a carry is **never** applied on its own. `pull` reports it (`carryAvailable`) and only `pull --apply-carry` writes it into the working tree, and only when every guard passes: this machine is inside a git repository, its `HEAD` is the exact commit the patch was taken against, no merge/rebase/cherry-pick is in progress, there are no uncommitted changes to tracked files in the project, and `git apply --check` agrees. Those guards are what make it reversible — with a clean tree at the same commit, `git checkout -- .` undoes the patch half and the copied untracked files are listed in the result. Untracked files are never overwritten: an identical file is a no-op, a differing one is kept and the incoming copy lands beside it as `<name>.incoming-<timestamp>`. A patch that names anything on the floor — `.git`, or a path sesh-mover owns, in any casing or dot spelling — or that would create a symbolic link is refused whole, not partly applied.

Anything that stops the automatic path — a different commit, your own uncommitted work, no `--apply-carry` at all — parks the entire payload in `.sesh-mover/carry-<timestamp>/` with a `README.md` explaining what happened, and the exact commands to finish by hand. Two cases withhold those commands on purpose and say so instead: a payload the floor refused, and a patch this machine's `git` could not parse. That is deliberate: a pull records its bundles as received, so re-running it never offers the same carry again, and the saved copy is the only remedy that actually works. Those directories are self-ignoring (they carry a `.gitignore` of `*`, so a peer's uncommitted work can never be committed here by accident) and only the most recent few are kept.

### Three machines: a thread whose history is split across machines

Each machine's hub index lists only the bundles *it* pushed, so a conversation started on A, continued on B and pulled back to A leaves half its bundles listed by A and half by B. A pull used to read exactly one of those lists — the one belonging to the machine holding the thread's latest copy — so on a third machine C the conversation arrived in halves, with no error, no fork and no failure.

**A pull now assembles the thread across every machine's list** ([#35](https://github.com/Sertelegger/claude-sesh-mover/issues/35)). Each bundle records the entry it continues from, so a pull follows those links and fetches the whole chain in order, whichever machine listed which part — C gets the conversation entire. The order comes from the links alone and never from a timestamp: the hub stamps nothing, so `pushedAt` is the *pushing* machine's clock and ordering by it would silently revert work under clock skew.

What a pull still cannot deliver, it names rather than swallowing — and each condition is a separate result field, so a caller never has to read the wording to know which one it hit: `chainGaps` (a bundle's recorded link points at an entry no bundle on the hub carries), `parkedBranches` (a branch it did not follow when a thread forks), `unplaceableBundles` (a bundle pushed **before** this release recorded links at all — unlinkable by construction, not missing, and it re-links the next time that machine pushes), `unwalkedRoots` (the thread has more than one independent starting point, which a compaction routinely produces, and a pull walks one of them), and `advertisedUnshipped` (a machine advertising newer work it has never uploaded). `unfetchableBundles` says which machines hold what was left behind, and each field arrives with the warning that explains it. A pull that finds one of these and correctly applies nothing is a **success** that says why, not an error you can retry.

The shape that **does** have a remedy — and it needs no flag — is the one where the newest copy of the thread is *this* machine's own while another machine still lists bundles that never arrived here. `pull` used to refuse that outright ("the latest copy of this thread is already local"), which is a statement about heads answering a question about bundles. It now falls back to the machine that still has something for you, fetches it, and says so in a warning; a plain `sesh-mover pull --thread <id>` is the whole remedy. The session-end auto-push makes that shape routine: you pull, leave a divergence undecided, your own session ends and is pushed, and now your machine holds the newest head while the other machine's bundle is still sitting on the hub unreceived.

`pull --latest`, `pull --thread <id>` and `whereis` all decide that the same way, by asking whether any bundle in the thread's assembled chain has yet to arrive here. They used to disagree: `--latest` compared *heads* and `--thread` compared *receipts*, so a thread whose newest head was already here while a bundle for it was not got "nothing to pull" from one and a fetch from the other, and `whereis` reported `pullNeeded: false` about it either way ([#44](https://github.com/Sertelegger/claude-sesh-mover/issues/44)). That question is now asked of the whole chain rather than of one machine's list, so `whereis`'s `pullNeeded` and the session-start notice are right about a split thread too — the indefinite "you are behind" nag on a thread no pull could complete is gone with the defect that caused it.

**One case is worth knowing about after upgrading:** bundles already sitting on a hub were pushed before links were recorded, so nothing can chain onto them. A pull still fetches them exactly as it did before — assembly widens what a pull reaches, it never narrows it — but a thread made only of such bundles is not *assembled*, it is merely fetched, and a new bundle pushed on top of an old one is reported as unlinkable rather than as missing. Each machine repairs its own share the next time it pushes that session. Nothing is lost either way: every bundle stays on the hub.

### Same-machine lock

Push and pull take an advisory lock per project while they run, so two hub operations for the *same project on the same machine* can't race each other and corrupt the hub's index. This is **not** a distributed lock — two different machines can (and normally do) push or pull concurrently; the hub's append-only bundle/index design is what keeps that safe, not the lock. If a command reports `reason: "lock-busy"`, wait a few seconds and retry once.

### What a pulled continuation lands as

When a pulled bundle continues a session **this machine already has**, `pull` appends the new entries to the end of that local transcript, so the thread stays one resumable session (`appended`, naming the `baseSessionId` to resume). That is the ordinary case for a two-machine round trip: work on A, continue on B, pull back to A, and A's original session simply has B's messages at the end of it.

Three things make it fall back to importing a **separate** session instead, and the pull says which:

- the local session was written in the last five minutes. That looks like a live Claude Code session, and sesh-mover cannot tell one from its **own** earlier pull, whose import stamps the same transcript — so a pull a few minutes after another one lands here with nothing running anywhere, and the warning names both possibilities rather than accusing a session that may not exist. *That bundle* is foreclosed: it has already arrived as a separate session and is recorded, so no re-run reaches it. The thread is not — `--force-append` on the **next** pull of it does splice that pull's continuation. The fix that needs no flag is preventive: close the Claude Code session writing to that transcript *before* pulling, and later continuations splice in normally.
- no local session's entry chain lines up with the continuation — nothing to append to, and `--force-append` will not help, because the chain guard is never skipped;
- the bundle's content doesn't match its manifest hash, so it is never welded into a transcript you own.

`--no-append` (or `hub.pullAppend=false`) turns the whole path off. Either way the content arrives — the difference is one session or two. A separate session is registered fresh for `claude --resume`, and its first entry is a synthetic continuation header pointing at where the earlier messages actually live: the full original conversation is never silently merged into it.

**Divergence — both machines continued from the same point.** Then neither branch continues the other and there is no safe automatic answer, so `pull` reports a `divergence` object with both sides' entry counts and last-active times, and you choose:

- **keep both** (`--on-divergence fragment`, the CLI default) — your session is untouched and the hub's branch is imported alongside it. Nothing is lost; the conversation stays in two transcripts.
- **adopt the hub's branch** (`--on-divergence adopt-hub`) — your session becomes the shared history plus the hub's branch, and your own branch is preserved **in full** as a new registered session. Three things worth knowing before you pick: the preserved session has no thread mapping, so your next push publishes it as its own thread; adoption truncates the session it rewrites, so it is refused outright while that transcript looks live; and the preserved copy is the transcript only — side files (subagent transcripts, tool-result blobs, file-history backups) stay attached to the session that was adopted.
- **decide later** (`--on-divergence skip`) — nothing is applied and nothing is recorded, so the same pull can be re-run with either answer. That holds for the whole thread, not just the bundle that diverged: a skip (and the liveness refusal of an `adopt-hub`) stops the rest of the chain too and says how many bundles it left, because the next bundle is anchored on the head the skipped one would have installed and would otherwise arrive as a third transcript with the answer silently dropped. `/sesh-mover:pull` always passes this first, then asks.

## Is this bundle what it says it is?

Everything below is **damage detection** — an incomplete transfer, a half-finished unpack, a bit that flipped on a network share. It is deliberately not attestation: nothing is signed, and anyone who can rewrite a bundle can recompute every hash in it. Trusting the *sender* is a separate question, covered by the hub's [trust model](#trust-model) above.

A bundle's `manifest.json` carries three layers of hash, checked in this order before anything is written:

- **`sessionsDigest`** — one digest over the whole declared session inventory (each session's id, its `integrityHash`, its layer digests, its continuation linkage). It is what catches a manifest that is internally *self-consistent but wrong*: a session record dropped from the list, or a hash edited to match content that was altered. Every per-session check would still pass in both cases, because a per-session hash is only ever consulted for a session the manifest still lists.
- **`integrityHash`, per session** — sha256 over the session JSONL as the exporter wrote it.
- **`layerDigests`, per session per layer** — one digest each for that session's `subagents`, `tool-results` and `file-history` directories, over the sorted (name, content-hash) pairs.

What each failure does:

- **A session the manifest declares but the bundle does not contain** fails the import outright, before anything is written. Until 0.6.0 that case was never *checked* — the session was counted as imported and no file was written for it, so a bundle holding no session data at all reported `success: true, imported: 1, warnings: []`. On a `migrate` that was destructive, because the source is deleted on the strength of that list. `--session-id` still imports the sessions that *are* present.
- **A damaged session inventory** fails the import, and on the hub side fails that `pull` — before the workspace merge, before the carry, and before a continuation can be spliced into a transcript you already own.
- **A session whose bytes don't match its own hash** is imported with a warning (the content is the only copy you have), but is never *spliced* into an existing transcript — see [What a pulled continuation lands as](#what-a-pulled-continuation-lands-as).
- **A layer whose digest doesn't match is not copied**, and the import says which session and which layer. A `file-history` entry is a backup Claude Code may later restore over your own file, so a backup that cannot be shown to be the backup that was taken has no business landing where something may restore it. The transcript itself imports normally.

Layer digests are one per layer rather than one per file. Detection is identical either way — any change to any file in the directory changes the digest — and per-file localisation buys nothing, since the response is the same for one corrupt file as for ten. The cost is not hypothetical: a single real session was measured holding 106 `file-history` entries, which is ~10 KB of manifest for that one session.

**Archive framing.** A `.tar.gz` carries a CRC32, so both a truncated and a bit-flipped one fail loudly on extraction. A `.tar.zst` is only as loud because the zstd CLI writes an XXH64 frame checksum by default — with `--no-check`, a flipped byte decompresses silently to different content. Since 0.6.0 that default is verified rather than assumed: an archive whose frame carries no content checksum is never handed back as a bundle (the export falls back to gzip and says so), and one arriving from elsewhere without a checksum extracts with a warning, since the manifest hashes above cover its contents anyway.

## Security notes

Exports are faithful copies of your conversation — they can contain API keys, pasted secrets, and environment dumps. Treat them like `~/.claude/projects/` itself. As of 0.3.2, imported bundles are validated to reject session ids that would enable path traversal outside the bundle.

- **Sessions are secrets.** Prefer user-level storage, or add `.sesh-mover/` to the project's `.gitignore` — a plain line, since the files a project is meant to commit are root dotfiles outside that directory.
- An archive on a cloud drive or in Slack is a copy of your conversation history. Move it like a secret. The same is true of anything pushed to a hub directory — see [The Hub](#the-hub)'s trust model above.
- Nothing is redacted automatically. Inspect before sharing; `--no-summary` hides excerpts from listings but does not redact the JSONL.

## Platform support

- **macOS, Linux, WSL1/WSL2, Windows (native)** — full support; CI runs the test suite on all three OSes plus a PowerShell and Git-Bash export/import smoke round-trip on Windows. WSL is auto-detected and paths translate to/from Windows peers (`/home/u/...` ↔ `C:\Users\u\...`, `/mnt/c/...` ↔ `C:\...`), including inside tool output.
- Known limitation: in free text, a path containing spaces only translates fully when it's under the project/config/home mappings; structured fields (`cwd`, file-history keys) always translate fully. Details in [`CLAUDE.md`](./CLAUDE.md).

## Development

```bash
npm install
npm run build       # src/ → dist/ (dist/ is committed — rebuild after src/ changes)
npm test            # vitest run
npm run lint        # tsc --noEmit
```

Single file: `npx vitest run tests/rewriter.test.ts` · by name: `npx vitest run -t "translates WSL paths"`. Architecture and conventions: [`CLAUDE.md`](./CLAUDE.md).

## License

[MIT](./LICENSE). If this saves you a headache, a ⭐ is appreciated.
