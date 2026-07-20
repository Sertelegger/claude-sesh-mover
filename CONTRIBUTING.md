# Contributing to claude-sesh-mover

Thanks for your interest in contributing! This document covers the local setup, the project's conventions, and the one rule that trips everyone up (`dist/` is committed — see below).

## Development setup

Requirements: Node.js ≥ 18.17 (CI runs Node 24) and npm.

```bash
git clone https://github.com/Sertelegger/claude-sesh-mover.git
cd claude-sesh-mover
npm ci
npm run build   # compile TypeScript to dist/
npm test        # full vitest suite
npm run lint    # type-check only (tsc --noEmit)
```

Useful during development:

```bash
npm run test:watch                          # vitest in watch mode
npx vitest run tests/rewriter.test.ts       # single test file
npx vitest run -t "translates WSL paths"    # filter by test name
node dist/cli.js export --help              # invoke the built CLI directly
```

Every CLI command emits a single JSON object to stdout — this is the contract the plugin's slash commands depend on. Don't add human-readable output to stdout; progress/diagnostics belong on stderr.

## The `dist/` rule

**`dist/` is committed to the repo** (not gitignored) so that users installing via `/plugin install` get a working plugin without a build step.

Any change to `src/` must be accompanied by a rebuild:

```bash
npm run build
git add dist/
```

CI enforces this: the `dist freshness` step fails if the committed `dist/` doesn't match what `src/` compiles to.

## Testing conventions

- Tests use [vitest](https://vitest.dev/) with fixtures under `tests/fixtures/`.
- Integration tests build full export/import round-trips against fixture config dirs. Do **not** mock filesystem or archive operations — use real temp dirs (`mkdtempSync`).
- When adding a new JSONL entry variant, update both `src/types.ts` and the fixture JSONL; rewriter and version-adapter tests rely on realistic shapes.

## Adding a command or CLI option

1. Extend `src/cli.ts` with the Commander subcommand/option.
2. Add the matching result shape to `src/types.ts` (every CLI result is typed).
3. Update `commands/<name>.md` and, if the behavior needs explanation for the skill layer, `skills/session-porter/SKILL.md`.
4. Rebuild and stage `dist/` (see above).

## Naming

The three names are intentionally different and must stay in sync:

- npm package / GitHub repo: `claude-sesh-mover`
- Plugin name (`.claude-plugin/plugin.json`): `sesh-mover` — drives slash command prefixes
- CLI bin: `sesh-mover`

Don't change any of these without updating the others plus every slash command reference in `commands/*.md` and the skill doc.

## Commits and pull requests

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(rewriter): …`, `fix(importer): …`, `chore: …`.
- Open PRs against `main`. CI must pass on all three OSes (Ubuntu, Windows, macOS) plus the Windows smoke test.
- Small, focused PRs are easier to review than large ones. If you're planning a bigger change, opening an issue first to discuss the approach is appreciated — [ROADMAP.md](./ROADMAP.md) shows where the project is heading.
