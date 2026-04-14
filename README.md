# claude-sesh-mover

> Export, import, and migrate Claude Code sessions across machines, operating systems, config directories, and project paths.

Claude Code stores each conversation as a JSONL file keyed to an absolute filesystem path on the machine that created it. That makes sessions **machine-local**: you can't easily continue a session after switching laptops, moving the project to a new directory, renaming your home folder, switching between `~/.claude` and an alternate config dir, or crossing the Windows ↔ WSL boundary. `claude-sesh-mover` rewrites the path-dependent bits of a session so it can be resumed anywhere.

It adds five slash commands to Claude Code:

| Command | What it does |
|---|---|
| `/sesh-mover:export` | Bundle one or all sessions for the current project into a portable directory or `.tar.gz` / `.tar.zst` archive. |
| `/sesh-mover:import` | Unpack an export on the target machine, rewrite paths for the new location, and register the session so it shows up in `claude --resume`. |
| `/sesh-mover:migrate` | Same-machine move: export + import + delete source. Can also rename the project directory with `--rename-dir`. |
| `/sesh-mover:browse` | List exports (user-level and project-level), view manifests, import, or delete. |
| `/sesh-mover:configure` | Set user- or project-level defaults for scope, storage, format, and excluded layers. |

## Install

### Recommended: via the Claude Code plugin marketplace

Add the marketplace:

```text
/plugin marketplace add sertelegger/claude-sesh-mover
```

Install the plugin:

```text
/plugin install sesh-mover@claude-sesh-mover
```

If the slash commands (`/sesh-mover:export` etc.) don't show up right away, reload:

```text
/reload-plugins
```

Or run `/plugin`, go to the **Discover** tab, and install interactively.

The plugin is self-contained: it depends only on Node.js (≥18.17), which Claude Code already requires. No separate install or build step.

### Alternative: clone and load directly

For local development or if you'd rather not add a marketplace:

```bash
git clone https://github.com/sertelegger/claude-sesh-mover.git
cd claude-sesh-mover
claude --plugin-dir .
```

The repo ships a pre-built `dist/` so the plugin works immediately after clone. If you change anything under `src/`, run `npm install && npm run build` before testing.

## Usage

### Export a session

```text
/sesh-mover:export
```

Prompts for scope (this session / all for this project), storage location (user-level `~/.claude-sesh-mover/` or project-level `./.claude-sesh-mover/`), format (directory / `tar.gz` / `tar.zst`), and which layers to include (session JSONL, file-history snapshots, tool-results, memory, plans, subagents). Produces a timestamped bundle you can copy to another machine.

### Import on the target machine

```text
/sesh-mover:import --from /path/to/export.tar.gz
```

Walks you through path translation (including WSL ↔ Windows if relevant), shows a dry-run diff, asks for confirmation, then unpacks and registers the session. If Claude Code rejects the imported session due to a version mismatch, the command offers `--no-register` as a fallback (you get the conversation content without the resume entry).

### Migrate a session to a new directory on the same machine

```text
/sesh-mover:migrate
```

Prompts for source and target project paths, scope, and whether to also rename the project directory (`--rename-dir`). Useful when you move a repo to a new location, rename your home directory, or switch between config dirs (e.g., `~/.claude` ↔ `~/.claude-tzun`).

**Important:** Don't run `/sesh-mover:migrate` from *inside* the session you're migrating. The CLI emits a warning, and the recommended flow is to exit, start a new Claude Code session from a stable outer directory (e.g., `~/`), and run the migrate from there.

### Browse and manage exports

```text
/sesh-mover:browse
```

Lists all exports (user and project scope), lets you view full manifests, trigger import, or delete old bundles.

## Security notes

Exported sessions are faithful copies of the original JSONL — they may contain API keys, tokens, pasted secrets, environment variables dumped by tool calls, or any other sensitive data the conversation encountered. Treat an export like you'd treat your `~/.claude/projects/` directory:

- Prefer **user-level** storage (`~/.claude-sesh-mover/`) over project-level unless you've added `.claude-sesh-mover/` to the project's `.gitignore`.
- Archives on cloud drives, Slack, or email are copies of your conversation history. Move them like you'd move secrets.
- The plugin does **not** redact secrets automatically. This is a conscious choice — redaction creates burden for the common single-user case without much payoff. If you're sharing an export with someone else, inspect it first.

## Platform support

- **macOS** (native).
- **Linux** (native).
- **WSL1 / WSL2** — auto-detected; paths translate to/from Windows peers (`/home/user/...` ↔ `C:\Users\user\...`, `/mnt/c/...` ↔ `C:\`).
- **Windows** — import works; export hasn't been battle-tested on native Windows (PowerShell shell quoting differences). PRs welcome.

Requires **Node.js ≥ 18.17** (already a Claude Code requirement).

## Requirements

- Claude Code 2.x or later.
- `zstd` binary on the system if you want `.tar.zst` archives. Otherwise the CLI transparently falls back to `.tar.gz` and reports the fallback in `warnings[]`.

## Development

```bash
npm install
npm run build       # compile src/ → dist/ (dist/ is committed, rebuild after src/ changes)
npm test            # vitest run
npm run test:watch  # vitest watch mode
npm run lint        # type-check only (tsc --noEmit)
```

Single-file test: `npx vitest run tests/rewriter.test.ts`.
Filter by test name: `npx vitest run -t "translates WSL paths"`.

See [`CLAUDE.md`](./CLAUDE.md) for the architecture overview, module responsibilities, and conventions for adding new commands or schema-migrating across Claude Code versions.

## License

[MIT](./LICENSE). Commercial use is allowed — if this saves you a headache, a ⭐ is appreciated.
