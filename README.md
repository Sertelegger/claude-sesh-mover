# claude-sesh-mover

> Export, import, and migrate Claude Code sessions across machines, operating systems, config directories, and project paths — including **incremental round-trips** between two machines.

Claude Code sessions are JSONL files keyed to an absolute path on the machine that created them, so they can't follow you to another laptop, directory, or across the Windows ↔ WSL boundary. `claude-sesh-mover` rewrites the path-dependent bits so a session can be resumed anywhere.

| Command | What it does |
|---|---|
| `/sesh-mover:export` | Bundle one or all sessions into a portable directory or `.tar.gz`/`.tar.zst`. Incremental mode sends only what's new since the last sync to a peer. |
| `/sesh-mover:import` | Unpack on the target machine, rewrite paths, register for `claude --resume`. Idempotent — re-imports are skipped (`--allow-duplicates` overrides). |
| `/sesh-mover:migrate` | Same-machine move: export + import + delete source. Optionally renames the project directory (`--rename-dir`). |
| `/sesh-mover:browse` | List exports, view manifests, import, or delete. |
| `/sesh-mover:configure` | Set defaults (scope, storage, format, layers) and the machine's name (`--set machine.name=<label>`). |

Where this is heading — a cross-machine session index with remote pull ("the hub"), and later other agentic CLIs — is tracked in [ROADMAP.md](./ROADMAP.md). Release history: [CHANGELOG.md](./CHANGELOG.md).

## Install

```text
/plugin marketplace add sertelegger/claude-sesh-mover
/plugin install sesh-mover@claude-sesh-mover
```

If the slash commands don't appear, run `/reload-plugins`. No build step — the plugin only needs Node.js ≥ 18.17, which Claude Code already requires. Optional: a `zstd` binary for `.tar.zst` archives (falls back to `.tar.gz` automatically).

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

### Incremental sync between two machines

After one full export → import round-trip, exports to that peer can be incremental: new sessions ship whole, sessions with new messages ship as **continuation sessions** (a new session that starts with a lineage note, followed by only the messages added since the last sync), unchanged sessions are skipped. The export flow offers this automatically once a peer is known.

- Machine identity: `~/.claude-sesh-mover/machine-id.json` (name defaults to hostname). Per-project sync state: `~/.claude-sesh-mover/sync-state/`.
- No sync state for a peer? `/sesh-mover:export --incremental --since <path-to-previous-export>` diffs against that bundle directly.
- Work on one machine at a time: parallel edits to the same session produce two independent continuations, not a merge.

## Security notes

Exports are faithful copies of your conversation — they can contain API keys, pasted secrets, and environment dumps. Treat them like `~/.claude/projects/` itself. As of 0.3.2, imported bundles are validated to reject session ids that would enable path traversal outside the bundle.

- Prefer user-level storage, or add `.claude-sesh-mover/` to the project's `.gitignore`.
- An archive on a cloud drive or in Slack is a copy of your conversation history. Move it like a secret.
- Nothing is redacted automatically. Inspect before sharing; `--no-summary` hides excerpts from listings but does not redact the JSONL.

## Platform support

- **macOS, Linux, WSL1/WSL2** — full support; WSL is auto-detected and paths translate to/from Windows peers (`/home/u/...` ↔ `C:\Users\u\...`, `/mnt/c/...` ↔ `C:\...`), including inside tool output.
- **Windows (native)** — import works; export isn't battle-tested (PowerShell quoting). PRs welcome.
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
