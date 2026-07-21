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

If the slash commands don't appear, run `/reload-plugins`. No build step — the plugin only needs Node.js ≥ 22.12 (current Claude Code releases already require Node ≥ 22). Optional: a `zstd` binary for `.tar.zst` archives (falls back to `.tar.gz` automatically).

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
- **Sync lag**: a push from another machine may not be visible here until the sync client catches up. The fix in both cases is the same — wait a moment for the client to sync/hydrate, then retry the same command. The slash commands do this retry for you (once) on `not-yet-synced`.

### Trust model

**The hub directory is a trust boundary, not a vault.** Sessions are stored there in plaintext at rest — anyone with read access to the hub folder can read every session ever pushed to it, until a future encryption-at-rest slice ships (tracked in [ROADMAP.md](./ROADMAP.md)). Every pulled bundle still goes through the same tar-entry and manifest-id validation as a manual import — see [Security notes](#security-notes) below; the hub doesn't relax any of that, it just adds a shared drop point on top.

### Workspace snapshots

For git-less projects, `push`/`pull` also carry a **workspace snapshot** — a copy of the project's files, not just its Claude Code sessions — because there's no git remote to reconstruct the project from otherwise. Skip it with `--no-workspace` on push. To exclude specific paths from the snapshot (large build artifacts, secrets, anything you don't want copied into the hub), add a `.claude-sesh-mover/hubignore` file (one pattern per line, `#` comments allowed; matched against path segments, with `*` wildcards — not full `.gitignore` semantics). `pull` refuses to overwrite a non-empty target directory with a workspace snapshot unless you pass `--force-workspace`.

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
