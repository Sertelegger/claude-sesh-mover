---
name: session-porter
description: Full context for Claude Code session export/import/migration operations via sesh-mover CLI
---

# sesh-mover Session Porter Skill

This skill provides background knowledge for all sesh-mover slash commands. It is not invoked directly by users — the individual commands (export, import, migrate, browse, configure, hub-init, push, pull, whereis) reference this knowledge.

## CLI Location

The sesh-mover CLI is at `${CLAUDE_PLUGIN_ROOT}/dist/cli.js`. Claude Code sets `CLAUDE_PLUGIN_ROOT` automatically inside plugin command execution, so **no plugin-cache discovery is needed** — invoke directly:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <command> [options]
```
Do not run `find` over `~/.claude*/plugins/cache` to locate the plugin; the env var is authoritative.

All commands output structured JSON to stdout. Parse it with JSON.parse().

## Do Not Probe the CLI

Each command file (`commands/*.md`) lists the exact CLI invocation it should produce, with every flag spelled out. **Do not run the CLI with `--help`, with no arguments, or with `-h` to discover its surface** — the command file is the authoritative reference. If a flag you need isn't listed there, the command file is wrong; fix it rather than working around it at runtime.

## Sensitive Data Warning

Exported sessions may contain API keys, tokens, passwords, or other sensitive data from the conversation or tool results. Always warn the user:
- When exporting to a project-level directory (it might get committed to git)
- When creating archives for transfer (the archive contains raw conversation data)
- Recommend adding `.claude-sesh-mover/` to `.gitignore` for project-level exports

## Detecting the Current Session

The current session ID can be found by:
1. Looking at the `sessionId` field in any recent tool result in the current conversation (fastest; always available mid-session)
2. Listing `<configDir>/projects/<encoded-project-path>/*.jsonl` — each filename (minus `.jsonl`) is a session ID for that project

Do **not** use `sesh-mover browse` to find live session IDs — `browse` only lists previously-exported bundles, not live sessions. There is no `--project` flag on `browse`.

## Config Directory Detection

The Claude config directory is resolved in order:
1. `--source-config-dir` / `--target-config-dir` flags
2. `CLAUDE_CONFIG_DIR` environment variable
3. `~/.claude/` default

The user may have multiple config dirs (e.g., `~/.claude` and `~/.claude-tzun`). Always detect or ask rather than assuming.

## Error Handling

When a CLI command returns `{"success": false, ...}`:
- Read the `error` and `details` fields
- If `suggestion` is present, offer it to the user
- Common errors:
  - "No sessions found" — wrong project path or config dir
  - "Session validation failed" — version mismatch, suggest `--no-register`
  - "Integrity check failed" — data corruption during transfer

Common warnings (result is still `success: true`):
- Sessions already imported — reported in `skippedSessions` with reason `duplicate` (identical content already in this project) or `already-received` (already synced from this peer), not as an error. `importedSessions` will be empty if every requested session was skipped this way. If the user actually intended a fresh re-import, offer to retry with `--allow-duplicates`.

When import registration fails (session not resumable):
- Offer to read the imported JSONL and inject the conversation as context into a new session
- This is the fallback for when Claude Code's internal validation rejects the imported session

## Platform Notes

- WSL paths: `/home/user/...` and `/mnt/c/...`
- Windows paths: `C:\Users\user\...`
- macOS paths: `/Users/user/...`
- Linux paths: `/home/user/...`

The CLI auto-detects the current platform and translates paths during import. For WSL <-> Windows, it shows the mapping and asks for confirmation.

Rewriting is two-stage: stage 1 always replaces the exact project-path/config-dir/home-dir prefixes it's given (longest-first); stage 2 runs only cross-family (e.g. WSL ↔ Windows) and additionally scans tool-result content, `toolUseResult` stdout/stderr, and file-history snapshot keys for other path-shaped tokens (`/mnt/<drive>/...`, `/tmp`, `/home/<user>/...`, `/Users/<user>/...`). `gitBranch` is never rewritten (it's a branch name, not a path), and user text / assistant text and thinking blocks are never rewritten. Stage 2's token scan stops at the first whitespace, so a path containing a space only translates reliably when it falls under one of stage 1's exact mappings.

## Incremental Sync

sesh-mover supports incremental export/import between machines. Key concepts:

- **Machine identity:** each machine has a persistent ID in `~/.claude-sesh-mover/machine-id.json`, auto-created on first incremental op. The human-readable name defaults to the hostname and can be overridden with `sesh-mover configure --set machine.name=<label>`.
- **Per-project sync state:** `~/.claude-sesh-mover/sync-state/<encoded-project-path>.json` tracks, per peer machine, what's been sent and received.
- **Incremental export:** `export --incremental --to <peer>` emits only new sessions + continuation sessions for sessions with new messages since the last sync. `--since <path>` is a stateless fallback when no peer state exists (e.g. the user received an export bundle from a new machine).
- **Continuation session:** a new session whose first entry is a synthetic user message explaining the lineage. The body is the sliced remainder of the source session. This avoids merge conflicts entirely and lets Claude see the lineage directly in the transcript.
- **Idempotent import:** import is idempotent by default for every export, not just incremental ones — a per-project content-hash registry recognizes sessions whose exact content was already imported into this project and skips them (`skippedSessions` reason `duplicate`). Peer-tracked incremental syncs additionally skip sessions already recorded as received from that specific peer (reason `already-received`). Pass `--allow-duplicates` to force a re-import.

When users ask "why are there two sessions that look like the same conversation?" — check `~/.claude-sesh-mover/sync-state/<encoded>.json`'s `lineage` map. The continuation header in the JSONL also spells out the origin session.

## Hub

The hub is a shared directory (synced folder or network share) that lets sessions move between machines without a manual export/import round-trip: `/sesh-mover:hub-init` sets it up once, `/sesh-mover:push` publishes this project's sessions to it, `/sesh-mover:pull` brings a thread from another machine down onto this one, and `/sesh-mover:whereis` is a read-only view of which machines have which threads. There's also a CLI-only repair verb, `hub reindex` — it rebuilds this machine's own hub index for the current project from its own pushed bundles (no dedicated command doc; run it directly if a machine's index looks stale or corrupted, e.g. `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub reindex --project-path "<path>"`).

A **thread** is the hub's cross-machine identity for a logical conversation — one thread can have a different local session id (and even different JSONL content, if machines are out of sync) on each machine. `push`/`pull`/`whereis` all resolve threads before doing anything else.

**JSON result classes the skill must branch on:**
- `reason: "unlinked"` (push, pull — a `success: false` result instead of their normal shape) — this project directory isn't linked to a hub project yet. Comes with `linkCandidates` (matched by git remote) to present as a pick-list, plus a "create new" option for push (`--create-project`) or pick-and-relink for either (`--project-id <id>`). `whereis` reports the equivalent state differently: it always returns `success: true`, with `linked: false` and the same `linkCandidates` shape embedded in its normal result — there's no separate error case to catch there.
- `reason: "lock-busy"` (push, pull) — another sesh-mover hub operation is already running for this project **on this machine** (see the lock caveat below). Wait briefly and retry once; don't loop.
- `reason: "not-yet-synced"` (pull) — the hub folder's own sync client (OneDrive/Dropbox/Syncthing/etc.) hasn't finished copying the needed bundle files to this machine yet. Lists `missing` files; offer a retry.
- `pickRequired: true` (pull, when run without `--thread`/`--latest`) — presents the same thread list shape as `whereis` (`threads: WhereisThread[]`); ask the user to pick one, or offer `--latest`.

**Same-machine lock caveat:** the push/pull lock (`~/.claude-sesh-mover/locks/<encoded-project-path>.lock`) only guards against two hub operations racing on the **same machine** for the same project. It is not a distributed lock — two different machines can still push or pull concurrently, and the hub's append-only bundle/index design is what keeps that safe, not the lock.

**Trust model:** the hub directory is a trust boundary — sessions are stored there in plaintext at rest until a future encryption slice ships. Anyone with read access to the hub folder can read every pushed session.
