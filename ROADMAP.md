# Roadmap

Where claude-sesh-mover is heading beyond one-shot session export/import. Items are ordered,
not scheduled — each stage gets its own design pass before implementation. Shipped releases
are documented in [CHANGELOG.md](./CHANGELOG.md).

## Hardening follow-ups (queued)

Smaller items surfaced by the 0.3.0 final review, deferred to keep that milestone shippable.
Version numbers are chosen at implementation time; stages here are ordered, not numbered.

- Registered-state tracking in the import dedup registry (the `--no-register` escape leaves
  no record that a copy exists unregistered, so a later normal import can't tell it should
  register-in-place instead of creating a second copy).
- Empty-`headEntryUuid` guard in the incremental diff.
- `skippedSessions` on `MigrateResult`.
- `--since` continuation keying by local session id.
- Archive-name collision detection in export.
- Removal of import's no-op `--force` flag.

## Stream-transform rewriting (candidate)

O(1)-per-session memory for the rewrite/import pipeline. Only matters for very large single
sessions (hundreds of MB); version number depends on API impact (patch if internal, minor if
the library API goes async). May instead be absorbed into the hub milestone below, where
streaming matters most at the transfer boundary.

## The Hub: cross-machine session index + remote pull

The core problem: working across multiple machines (Windows 11/WSL2, native Linux, macOS),
you lose track of **which machine has which sessions and where the latest one lives** —
finding it means SSH-ing around. The hub answers "where did I work last?" and moves the
session to wherever you are now.

**Architecture direction: dumb storage + smart client.** No hosted service. A designated
storage backend — a private git repo first (auth via existing SSH keys, history for free),
abstracted so S3/WebDAV/synced folders can slot in later — holds incremental bundles plus a
small JSON index (machines, sessions, lineage, last-active). Planned surface:

- `/sesh-mover:whereis` — all sessions for the current project across all machines, sorted
  by last activity.
- `/sesh-mover:push` / `/sesh-mover:pull` — send/fetch bundles through the hub, reusing the
  existing incremental-sync machinery (machine identity, peer state, continuations).
- Optional `SessionEnd` hook that auto-pushes index updates, so the index is always current.
- Optional age/gpg encryption of bundles at rest (sessions contain secrets).

**Why build it (landscape as of 2026-07):** Claude Code local CLI sessions are machine-local
with no native sync; Remote Control steers live sessions but transfers nothing and requires
the origin machine online; teleport is cloud→CLI only; `claude session export/import` is a
repeatedly-requested, unshipped feature. Among community tools: claude-sync does encrypted
whole-directory sync but has **no machine-aware index and no Windows/WSL support**;
Happy/Omnara show cross-machine session *lists* but are remote-control-only; nothing found
handles WSL↔Windows path discrimination. The two halves of this milestone exist only as
fragments across four tools — no product does both.

**Inspiration backlog** (from the survey): client-side age encryption (claude-sync),
SessionStart/SessionEnd auto-sync hooks (claude-context-sync), repo-scoped in-project
bundles for handoff (cctrace), self-hosted E2E-encrypted relay (Happy — later, if ever).

## Beyond Claude: multi-agent-CLI support

Partial support for other agentic CLIs (Codex, Gemini CLI, opencode, …) — the same
"which machine has my latest session?" problem exists for all of them, and cross-vendor
support is something Anthropic will never ship. Per-CLI adapters cover three seams that
already exist as module boundaries: session discovery (where transcripts live, how they're
project-keyed), path-field rewriting (which fields carry paths), and resume registration.

- The hub's index schema and bundle manifest are **agent-agnostic from day one** (an `agent`
  discriminator, `"claude-code"` initially) so this stage needs no schema migration.
- Explicitly out of scope: cross-CLI transcript *translation* (a Codex session stays a Codex
  session — indexed and transferable, not converted).

## Exploratory — multi-user shared sessions

Sequential handoff between people using the same continuation mechanics (a "peer" is already
abstract — a colleague's machine is just another peer), plus shared knowledgebase via the
memory layer. Concurrent transcript merging is explicitly out of scope: Claude Code has no
merge semantics, and the push/pull discipline the README documents is the right constraint.

## Principles

- **Keep shipping even if Anthropic fills the basic gap.** Native export/import would cover
  the simplest case; the index, WSL↔Windows translation, incremental continuations, and
  multi-CLI support remain differentiated.
- **Sessions are secrets.** User-owned storage only, optional encryption at rest, no
  false redaction promises.
- **Design before build.** Each stage gets its own brainstorm/spec/plan cycle; this file
  tracks direction, not commitments.
