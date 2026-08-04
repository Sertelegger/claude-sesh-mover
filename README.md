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

Where this is heading beyond Slice 1 — hub automation, encryption at rest, a web service — and later other agentic CLIs, is tracked in [ROADMAP.md](./ROADMAP.md). Release history: [CHANGELOG.md](./CHANGELOG.md).

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

## Quick start

Move a session from machine A to machine B:

1. On A: `/sesh-mover:export` → pick "this session", archive format. Note the `.tar.gz` path it reports.
2. Copy the archive to B (scp, cloud drive, whatever you trust — it contains your conversation).
3. On B, in the project directory: `/sesh-mover:import` → point it at the archive, confirm the dry-run.
4. `claude --resume` — the imported session is in the list.

## Usage notes

**Export** prompts for scope (one session / all for the project), storage (`~/.claude-sesh-mover/` or `./.claude-sesh-mover/`), format, and layers (JSONL, file-history, tool-results, memory, plans, subagents). `--no-summary` keeps conversation excerpts out of the manifest and resume listings (the JSONL itself is still exported in full).

**Import** shows a dry-run of the path rewrites before touching anything. If Claude Code rejects the session over a version mismatch, `--no-register` imports the content without the resume entry. Already-imported sessions are skipped and reported in `skippedSessions`; `--allow-duplicates` forces a re-import.

**Browse** lists every export it finds in `~/.claude-sesh-mover/`, `./.claude-sesh-mover/`, and the project root (archives sitting loose in the project root are only picked up if their filename carries the standard `YYYY-MM-DD-` export prefix), with each bundle's *origin* platform, project path, export date, and session count — read from the bundle's own manifest, archives included, so a `.tar.gz` carried over from WSL still says `wsl2`. If a bundle's metadata can't be read (a `.tar.zst` on a machine without `zstd`, a corrupt archive), that entry is marked `metadataAvailable: false` with the reason instead of showing invented values, and the rest of the listing is unaffected. Reading `.tar.zst` metadata decompresses the whole bundle first, so browsing a directory of large zstd archives takes a moment.

**Migrate** is for same-machine moves (repo relocated, home dir renamed, config dir switched). Don't run it from inside the session being migrated — the CLI blocks this; exit, start a fresh session from an outer directory (e.g. `~/`), and run it there. `--scope current` requires `--session-id`.

`export`, `import`, and `migrate` all accept `--progress`, which emits NDJSON progress events on stderr (one JSON object per line) while leaving stdout's JSON result contract unchanged — useful when driving the CLI directly rather than through the slash commands.

### Incremental sync between two machines

After one full export → import round-trip, exports to that peer can be incremental: new sessions ship whole, sessions with new messages ship as **continuation sessions** (a new session that starts with a lineage note, followed by only the messages added since the last sync), unchanged sessions are skipped. The export flow offers this automatically once a peer is known.

- Machine identity: `~/.claude-sesh-mover/machine-id.json` (name defaults to hostname). Per-project sync state: `~/.claude-sesh-mover/sync-state/`.
- No sync state for a peer? `/sesh-mover:export --incremental --since <path-to-previous-export>` diffs against that bundle directly.
- Work on one machine at a time: parallel edits to the same session produce two independent continuations, not a merge.

## The Hub

Incremental sync (above) moves sessions one peer-to-peer round-trip at a time — you still have to know which machine to pull from. The hub is a shared directory that removes that bookkeeping: push sessions to it from any machine, and any other machine that points at the same directory can see what's there and pull it down.

### Quick start

1. On machine A: `/sesh-mover:hub-init` → point it at a directory both machines can reach (see storage guidance below). This mints a hub (or joins one that already exists there).
2. Still on A, in a project directory: `/sesh-mover:push` — publishes this project's sessions to the hub. First push in a project links it to a hub project (matched by git remote, or minted fresh).
3. On machine B: `/sesh-mover:hub-init` pointed at the *same* directory, then in the same project (cloned there, or pulled fresh — see the bootstrap case in `/sesh-mover:pull`), run `/sesh-mover:whereis` to see every machine's copy of this project's sessions and which is latest, then `/sesh-mover:pull` to bring the one you want down onto B.

`whereis` is read-only — it never links a project or pulls anything, so it's safe to run just to look.

### Storage

The hub backend is filesystem-only in this slice: point `hub init --path` at anything that behaves like a directory both machines can read and write —

- a network share (SMB/NFS mount), or
- a synced folder (OneDrive, Dropbox, Syncthing, iCloud Drive, …).

Synced folders have two gotchas the hub can't paper over:

- **On-demand hydration** (OneDrive Files On-Demand, Dropbox Smart Sync, and similar): a file can exist in the folder's listing before its content is actually downloaded to this machine. If `pull` needs a bundle that hasn't hydrated yet, it returns `reason: "not-yet-synced"` with the specific files it's waiting on, instead of silently reading a truncated file.
- **Sync lag**: a push from another machine may not be visible here until the sync client catches up. The fix in both cases is the same — wait a moment for the client to sync/hydrate, then retry the same command. On `not-yet-synced`, the slash command will offer to retry for you rather than retrying automatically.

### Trust model

**The hub directory is a trust boundary, not a vault.** Sessions are stored there in plaintext at rest — anyone with read access to the hub folder can read every session ever pushed to it, until a future encryption-at-rest slice ships (tracked in [ROADMAP.md](./ROADMAP.md)). Every pulled bundle still goes through the same tar-entry and manifest-id validation as a manual import — see [Security notes](#security-notes) below; the hub doesn't relax any of that, it just adds a shared drop point on top.

### Workspace snapshots

For projects with no git remotes (including remote-less git repositories), `push`/`pull` also carry a **workspace snapshot** — a copy of the project's files, not just its Claude Code sessions — because there's no git remote to reconstruct the project from otherwise. Skip it with `--no-workspace` on push. To exclude specific paths from the snapshot (large build artifacts, secrets, anything you don't want copied into the hub), add a `.claude-sesh-mover/hubignore` file (one pattern per line, `#` comments allowed; matched against path segments, with `*` wildcards — not full `.gitignore` semantics; `dir/` and `dir` mean the same thing). `hubignore` also works in the other direction: when a pull merges an incoming payload, a path it names is not applied and your local file there is left alone (reported in the merge's `skipped` list). `--force-workspace` does not honor that — it takes the hub's copy wholesale. `pull` refuses to overwrite a non-empty target directory with a workspace snapshot unless you pass `--force-workspace`.

A snapshot is a plain file copy: it does **not** read `.gitignore`. Only `hubignore` and the built-in excludes (`.git`, `.claude-sesh-mover`, `node_modules`, `.venv`, `__pycache__`, `.DS_Store`) keep a file out of it. A remote-less git repository takes this path, so a gitignored `.env` sitting in one **is** copied into the bundle unless `hubignore` names it — that is the opposite of the git-carry rule below, and the difference is which payload builder ran, not which files you have.

The opposite lever is `.claude-sesh-mover/hubinclude`, in the same directory and with the same wildcards — but note one deliberate difference, spelled out below: a trailing slash is decoration in `hubignore` and meaningful in `hubinclude`. Paths listed there are carried **even if** `hubignore`, the built-in excludes or `.gitignore` would drop them (`.gitignore` only ever applies to the git carry below, where it decides which *untracked* files travel). It is meant to be **committed**, so one line fixes a project on every clone and every machine — this repo's own gitignored `docs/superpowers/` specs are the motivating case. A pattern with a `/` **anywhere in it** — trailing one included — is rooted at the project: `docs/` is `docs` at the top level and everything under it, never a `docs` nested somewhere else; `docs/superpowers/` carries that subtree, `docs/*.md` those files. Only a pattern with no separator at all matches that name at any depth (`*.keepme`). This is the difference from `hubignore`, where patterns are matched per path segment and a trailing slash is stripped: `docs/` there excludes a `docs` at **any** depth, while `docs/` here names back only the top-level one. Two names can never be re-included, by any pattern or spelling: `.git` and `.claude-sesh-mover`. Treat the file as security-relevant — `.gitignore` is also where `.env` lives, so list only what you mean to upload. It applies to **both** payload builders: the workspace snapshot for a project with no remotes, and the git carry below for a project with one. A push that re-includes gitignored files names them back to you in `carry.reIncluded` and in its warnings.

### Uncommitted work (git projects)

For a project **with** a git remote there is no workspace snapshot — git already has the committed state — so `push` carries the part git does not publish: a `git diff HEAD` patch (staged and unstaged, binary-safe) plus untracked, non-gitignored files, under `carry/` in the bundle. Skip it with `--no-carry`, or turn it off everywhere (including for the SessionEnd auto-push, which takes no flags) with `sesh-mover configure --set hub.carryDiff=false`.

The carry has two halves and they obey **different** rules, so it is worth being precise about which is which.

*Untracked* files — the copied half. What never travels: gitignored files unless `.claude-sesh-mover/hubinclude` names them, symlinks, `.git`, `.claude-sesh-mover`, and anything `hubignore` or the built-in excludes drop. The whole payload is declined if it exceeds 5 MB (reported as a warning naming the largest contributors — commit or ignore the big files and the carry rides the next push).

*Tracked* files — the patch half. **None of those rules filter the patch.** `git diff HEAD` describes every tracked file you changed, so a change to a file that is gitignored *and* tracked travels in full: the common shape is a `.env` that was committed once and gitignored later without `git rm --cached`, and `git add -f` produces the same thing. `hubignore` does not stop it either. Push names that set back to you in `carry.trackedIgnored` and in a warning; the remedies are `git rm --cached <path>` or `--no-carry`. One rule *does* cover the patch — the floor: `.git` and `.claude-sesh-mover` are excluded from it as well, so a tracked `.claude-sesh-mover/config.json` (which can redirect `hub.path`) or `hubinclude` never rides along.

The patch records the working tree as it stands, so capturing during a conflicted merge or rebase captures the conflict markers too; the push says so, and the operation itself does not travel. A carry applies automatically on the other machine only when that machine's `HEAD` matches the commit it was taken against — push your branch as usual; the carry is for the work you have not committed, not a replacement for git.

### Same-machine lock

Push and pull take an advisory lock per project while they run, so two hub operations for the *same project on the same machine* can't race each other and corrupt the hub's index. This is **not** a distributed lock — two different machines can (and normally do) push or pull concurrently; the hub's append-only bundle/index design is what keeps that safe, not the lock. If a command reports `reason: "lock-busy"`, wait a few seconds and retry once.

### Pulled continuations are new sessions

Be clear-eyed about what `pull` actually gives you: a pulled session is always a **separate, new session** on this machine, registered fresh for `claude --resume`. If it continues work from elsewhere, its first entry is a synthetic continuation header pointing at where the earlier messages actually live — the full original conversation is never silently merged into it. This matches the honesty requirement the incremental-sync continuations above already follow; the hub doesn't change the underlying mechanic, it just adds a directory-based way to discover and fetch the bundles.

## Security notes

Exports are faithful copies of your conversation — they can contain API keys, pasted secrets, and environment dumps. Treat them like `~/.claude/projects/` itself. As of 0.3.2, imported bundles are validated to reject session ids that would enable path traversal outside the bundle.

- **Sessions are secrets.** Prefer user-level storage, or add `.claude-sesh-mover/` to the project's `.gitignore`.
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
