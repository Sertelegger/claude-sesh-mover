# Roadmap

Where claude-sesh-mover is heading beyond one-shot session export/import. Items are ordered,
not scheduled — each stage gets its own design pass before implementation; version numbers
are chosen at implementation time. Shipped releases are documented in
[CHANGELOG.md](./CHANGELOG.md).

## The Hub: cross-machine session index + remote pull

The core problem: working across multiple machines (Windows 11/WSL2, native Linux, macOS),
you lose track of **which machine has which sessions and where the latest one lives** —
finding it means SSH-ing around. The hub answers "where did I work last?" and moves the
session to wherever you are now.

**Architecture direction: dumb storage + smart client.** No hosted service (yet — see Slice
4 below). A designated storage backend holds bundles plus a small JSON index (machines,
sessions, lineage, last-active) per machine.

**Slice 1 — filesystem-directory backend: shipped in v0.5.0.** `hub init`/`hub status`/
`hub reindex`, `push`/`pull`, and `whereis` all work today against any directory that
behaves like a shared filesystem path — a network share or a synced folder (OneDrive/
Dropbox/Syncthing/iCloud Drive). Project identity, git-remote matching, cross-machine
thread lineage, and git-less workspace snapshots are all in place; see the README's
"The Hub" section and [CHANGELOG.md](./CHANGELOG.md#050--2026-07-21) for the full surface.
Sessions are plaintext at rest in the hub directory until Slice 3 ships.

**Git backend: not planned.** The original direction here was "a private git repo first,
auth via existing SSH keys, history for free" — dropped after Slice 1's design pass:
bundle blobs (JSONL + optional workspace snapshots, potentially large and always
binary-ish after compression) don't fit git's history model or LFS economics well enough
to justify the added complexity over a plain shared directory, which needs no git
tooling on either machine and already satisfies the sync/network-share requirement.

**Slice 2 — automation + full round-trips: shipped in v0.6.0.** A `SessionEnd` hook
auto-pushes and a `SessionStart` hook announces newer work elsewhere, both gated on the
project being linked; a pulled continuation is appended to the local session it continues
instead of landing as a truncated fragment (with an explicit resolution when both machines
diverged from the same point); a workspace payload is merged 3-way against a generation
both trees held rather than overwriting; and a git project carries its uncommitted work
(`git diff HEAD` + untracked files), applied only behind `--apply-carry` and a clean tree.
See the README's "The Hub" and [CHANGELOG.md](./CHANGELOG.md#060--2026-08-06).

**Remaining slices** (each gets its own design pass before implementation; not scheduled):

- **Slice 3 — cross-machine chain assembly + encryption at rest + compaction.** Assembling
  a thread whose bundles are split across several machines' indexes by walking the
  `fromEntryUuid`/`headEntryUuid` links, so a third machine can pull it whole
  ([#35](https://github.com/Sertelegger/claude-sesh-mover/issues/35) — v0.6.0 discloses
  what it could not fetch, it does not assemble it); age/gpg encryption of bundles in the
  hub (closing the plaintext-at-rest gap called out in Slice 1's security notes);
  compaction of superseded bundles so a long-lived hub directory doesn't grow unbounded.
  Two hardening items belong to the same pass because Slice 2 made them reachable:
  [#38](https://github.com/Sertelegger/claude-sesh-mover/issues/38) (stop re-implementing
  git's patch-header parser in the carry apply path and ask git instead) and the
  disclosure-side half of #35.
- **Slice 4 — web service + UI.** A hosted alternative to the filesystem backend (own
  design pass — auth, multi-user access control, and a browsable UI are all out of scope
  for the dumb-storage model above and need dedicated design work). **Two threat-model
  items are hard gates on it,** both fine under Slice 1's "a folder shared between machines
  you own" model and neither acceptable for a shared or hostile hub:
  [#36](https://github.com/Sertelegger/claude-sesh-mover/issues/36) — the built-in
  workspace excludes are a convenience default, not a security boundary, so an applied
  payload can write ordinary project files — and
  [#37](https://github.com/Sertelegger/claude-sesh-mover/issues/37) — the merge-ancestor
  "common to both trees" guarantee is verified on our side and self-reported by the peer,
  which no filesystem backend can attest.

**Why build it (landscape as of 2026-07):** Claude Code local CLI sessions are machine-local
with no native sync; Remote Control steers live sessions but transfers nothing and requires
the origin machine online; teleport is cloud→CLI only; `claude session export/import` is a
repeatedly-requested, unshipped feature. Among community tools: claude-sync does encrypted
whole-directory sync but has **no machine-aware index and no Windows/WSL support**;
Happy/Omnara show cross-machine session *lists* but are remote-control-only; nothing found
handles WSL↔Windows path discrimination. The two halves of this milestone exist only as
fragments across four tools — no product does both.

**Inspiration backlog** (from the survey): client-side age encryption (claude-sync),
repo-scoped in-project bundles for handoff (cctrace), self-hosted E2E-encrypted relay
(Happy — later, if ever). SessionStart/SessionEnd auto-sync hooks (claude-context-sync)
shipped in Slice 2.

## Beyond Claude: multi-agent-CLI support

Partial support for other agentic CLIs (Codex, Gemini CLI, opencode, …) — the same
"which machine has my latest session?" problem exists for all of them, and cross-vendor
support is something Anthropic will never ship. Per-CLI adapters cover three seams that
already exist as module boundaries: session discovery (where transcripts live, how they're
project-keyed), path-field rewriting (which fields carry paths), and resume registration.

- The hub's **index schema** is agent-agnostic from day one (`HubIndexJson.agent`, `"claude-code"`
  initially), so that half needs no schema migration. The **bundle manifest** is not: `ExportManifest`
  carries `plugin: "sesh-mover"` and no agent discriminator, so adding one there is part of this stage.
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
