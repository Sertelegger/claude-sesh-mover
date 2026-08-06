# Changelog

Notable changes per release. Direction and upcoming work live in [ROADMAP.md](./ROADMAP.md).

## [0.6.0] — 2026-08-06

The Hub, Slice 2: the hub keeps itself current, and a pulled continuation lands *in* the
session it continues instead of beside it.

### Read this before upgrading

Two items change behavior for existing hub users with no action on their part.

- **A linked project starts pushing by itself.** This release registers a `SessionEnd`
  hook, and **linking a project to a hub project is the consent gate** — so a project you
  linked under 0.5.x is auto-pushed at the end of your next Claude Code session, with
  nothing further to enable. For a project **with a git remote** that push also carries
  your *uncommitted* work (a `git diff HEAD` patch plus untracked, non-gitignored files),
  because `hub.carryDiff` defaults to on: the payload is your working tree, not just
  transcripts. The hook takes no flags, so config is the only opt-out —
  `sesh-mover configure --set hub.autoPush=false` (no automatic push at all),
  `… hub.carryDiff=false` (no uncommitted work from git projects),
  `… hub.noWorkspace=true` (no workspace snapshot from projects *without* a git remote —
  it does not affect the carry), `… hub.startupNotice=false` (add `--scope project` to
  limit any of them to one project). Nothing happens at all for a project that was never
  linked, or on a machine with no hub configured. The automatic push is also **silent by
  construction** — its output goes to a stderr a clean session exit never shows — so the
  warnings a manual push prints, the `carry.trackedIgnored` disclosure included, are
  recorded in sync-state and reported by `hub status` (`lastAutoPush`) instead.
- **Workspace bundles already on your hub can be unpullable, and this release fixes
  them** — every sesh-mover that has ever written one (0.5.0, 0.5.1) could produce this.
  When a workspace snapshot happened to contain no files (an empty
  project directory, a `hubignore` broad enough to drop the whole tree, or a project whose
  only content was the `project.json` that linking had just planted), `push` still wrote a
  manifest declaring a workspace payload the bundle did not contain. Pulling such a bundle
  **crashed, terminally**: the crash happened inside the bundle loop *before* the session
  import, so no session arrived, nothing was recorded as received, every retry failed
  identically, and no flag skipped the workspace step — the thread was permanently
  unpullable. 0.6.0 fixes both ends: a snapshot that carries no files now creates the
  (empty) `workspace/` directory it declares, so the payload matches the manifest — the
  manifest still declares `fileCount: 0`, which is a legitimate snapshot — **and** a pull
  that meets a bundle declaring a payload it does not contain degrades to a warning instead
  of crashing, so a thread stranded by an older version becomes pullable again by upgrading
  the machine that pulls.

### Added
- **Bundle-level integrity.** `manifest.json` now carries a `sessionsDigest` over its whole
  declared session inventory and a `layerDigests` entry per session per auxiliary layer
  (`subagents`, `tool-results`, `file-history`), on top of the per-session `integrityHash`
  that already existed. The digest catches a manifest that is internally self-consistent
  but *wrong* — a session record dropped from the list, or a hash edited to match content
  that was altered — which no per-session hash can see, since it is only ever consulted for
  a session the manifest still lists. A layer whose digest doesn't match is **not copied**
  (a `file-history` entry is a backup Claude Code may later restore over your own file), and
  the import says which session and which layer while the transcript itself imports
  normally. All of it is damage detection, not attestation: nothing is signed and anyone who
  can rewrite a bundle can recompute it — trusting the *sender* remains
  [#37](https://github.com/Sertelegger/claude-sesh-mover/issues/37). Bundles written by
  earlier versions declare no digests and are verified exactly as they were before.
- **Archive framing is verified rather than assumed.** A `.tar.zst` whose frame carries no
  content checksum can hide a flipped byte (measured: `zstd -d` exits 0 and writes different
  bytes), where the `.tar.gz` path's CRC32 catches the same damage loudly. `export` now
  checks the frame it produced and falls back to gzip if the checksum is absent — reusing
  the existing `actualFormat` signal — and an archive arriving from elsewhere without one
  extracts with a warning rather than a refusal, since the manifest hashes cover its
  contents anyway.
- **Hub automation** (`hooks/hooks.json`, two internal CLI endpoints). `SessionEnd` →
  auto-push, run detached so it never delays session exit; `SessionStart` (on `startup`
  and `resume`) → a one-line notice when another machine holds newer work for this project,
  bounded at 10s so an unreachable hub can't stall a session opening. Both default on, both
  inert until a hub is configured *and* the project is linked. Opt out with
  `hub.autoPush` / `hub.startupNotice`.
- **Append-to-base on pull.** A continuation for a session this machine already has is
  spliced onto the end of that transcript (`appended`), so a two-machine round trip leaves
  one resumable session instead of a chain of fragments. Guards: the entry chain must line
  up, the local file must not have been written in the last 5 minutes, and the bundle must
  pass its integrity hash. `--force-append` overrides the liveness guard only;
  `--no-append` / `hub.pullAppend=false` disables the path.
- **Divergence resolution** (`--on-divergence fragment|adopt-hub|skip`, `hub.onDivergence`)
  for the case where both machines continued a thread from the same point: keep both,
  adopt the hub's branch while preserving your own **in full** as a new registered session,
  or apply and record nothing so the choice can be made later. `/sesh-mover:pull` always
  asks before applying anything.
- **3-way workspace merge** for projects with no git remote. An incoming snapshot is merged
  against a generation both trees are known to have held (matched by bundle id, never by a
  timestamp) rather than skipped or overwritten: unmergeable files keep the local copy with
  the incoming one parked as `<name>.theirs-<ts>`, conflicts get real conflict markers, and
  the merge never deletes. Reported as `workspaceMerge`.
- **Carried uncommitted work for git projects.** `push` bundles a `git diff HEAD` patch
  (binary-safe) plus untracked, non-gitignored files; `pull` never applies it on its own —
  `--apply-carry` plus a clean tree at the exact base commit, no merge/rebase in progress,
  and `git apply --check` clean. Any decline parks the whole payload in
  `.claude-sesh-mover/carry-<ts>/` with a README of the manual steps. `--no-carry` /
  `hub.carryDiff=false` turns it off.
- **`.claude-sesh-mover/hubinclude`** — the opposite of `hubignore`. Paths listed there are
  carried even when `hubignore`, the built-in excludes, or `.gitignore` would drop them,
  for **both** payload builders (workspace snapshot and git carry). Meant to be committed,
  so one line fixes every clone. `.git` and `.claude-sesh-mover` can never be re-included.
  Until the file exists, `push` reports a capped sample of the gitignored paths it left
  behind (`ignoredNotCarried`) and `/sesh-mover:push` offers to create it from them.
- New flags: `--force-append`, `--no-append`, `--on-divergence <mode>`, `--apply-carry`
  (pull); `--no-carry` (push).
- New config keys: `hub.autoPush`, `hub.startupNotice`, `hub.pullAppend`,
  `hub.onDivergence`, `hub.carryDiff`.
- New result fields — `pull`: `appended`, `divergence`, `workspaceMerge`,
  `workspaceRefused`, `workspaceDeclaredMissing`, `carryAvailable`, `carryApplied`,
  `unfetchableBundles`; `push`: `carry`, `ignoredNotCarried`; `whereis`:
  `unfetchableBundles` per thread; `hub status`: `lastAutoPush`. Every one of them is a
  typed field precisely so the slash commands branch on results rather than on warning
  wording.
- **`hub status` now reports the last automatic push** for the project you are in
  (`lastAutoPush`: when, whether it succeeded, and its warnings). The session-end push runs
  detached with its stdout closed, and Claude Code does not show a clean-exit hook's
  stderr, so everything it computes for a human was thrown away — including the disclosure
  naming gitignored-but-*tracked* files whose contents its patch carried off the machine,
  and the error from a push that has been failing every session against an unmounted share.
- Library: `hub/append`, `hub/merge`, `hub/carry` and `hub/hooks` are re-exported from the
  package barrel (`src/index.ts`).

### Changed
- A pulled continuation now **appends** to the local session it continues when the chain
  matches; the separate "continuation session" fragment is the documented fallback, not the
  norm. Sessions that were appended are reported in `appended` and are **not** in
  `importedSessions`.
- A workspace payload applied to a non-empty directory now **merges** when a shared
  generation is known, instead of being skipped. `--force-workspace` keeps exactly one
  meaning — "overwrite, don't combine" — and now overrides the merge too.
- Session head/metadata derivation no longer reads the literal first or last line of a
  transcript. Claude Code brackets a transcript with uuid-less bookkeeping entries; on real
  transcripts ~31% of line boundaries have one. In 0.5.x that made `whereis`'s
  "which machine has the latest copy" tiebreak compare missing values, and project-path
  recovery fall back to the lossy encoded directory name. Left unfixed it would also have
  defeated this release's headline feature — a wrong head reads as a chain mismatch, which
  0.6.0 classifies as divergence, so `pull` would have reported forks that had not happened
  and offered `--on-divergence adopt-hub`, the one destructive answer, as the remedy.
- Sync-state's `hub` block gains `workspaceGenerations` (bounded history of the snapshot
  generations this tree passed through) alongside `lastWorkspace`. Additive; still
  `schemaVersion: 2`.

### Fixed
- **A bundle missing its session data reported a successful import.** `import` gated its
  integrity check on the session file *existing*, so a session the manifest declared but
  the bundle did not contain was never checked at all: it was counted in
  `importedSessions`, no file was written for it, and the result was
  `success: true, imported: 1, warnings: []` — the exact signature of a truncated transfer
  or a half-finished unpack, reported as a completed import. On `migrate` it was
  destructive, because the source session is deleted on the strength of that list. It is
  now a hard failure before anything is written, on `import`, on `migrate` and on `pull`;
  `--session-id` still imports the sessions that *are* present. `pull` refuses such a
  bundle by name, before the workspace merge, the carry, or a splice into a transcript you
  already own.
- **An interrupted pull could fork a thread in two.** `peers[…].received` is written inside
  the bundle loop while the thread mapping is written after the whole chain, so a pull
  interrupted between the two left this machine holding the content with no record of which
  thread it belonged to. Every re-pull then answered "Already up to date" (or "Nothing to
  pull: all threads are current") and returned without repairing it — and the next push
  minted a **second thread** whose only bundle was a continuation with no base in its own
  chain, with `whereis` showing two threads for one conversation. All three of those early
  returns now restore the mapping from this machine's own receipt bookkeeping and say so.
  ([#28](https://github.com/Sertelegger/claude-sesh-mover/issues/28))
- **`whereis` could list the same machine twice.** `readAllIndexes` walked `index/`
  *recursively* and took the machine id from the filename, so a Syncthing `.stversions/`
  folder or a Dropbox "conflicted copy" directory — the expected environment for a hub on a
  synced folder — produced two copies of one machine, silently feeding the "which machine
  has my latest work" tiebreak. The scan is now confined to the immediate directory and
  deduped by machine id, and a non-`.json` file is ignored instead of being reported as
  "index file for machine README is unreadable". ([#28](https://github.com/Sertelegger/claude-sesh-mover/issues/28))
- **One poisoned index record could take out a whole pull.** `readMachineIndex` validated
  three ids but not a bundle's `file`, which becomes a hub path later — so a single bad
  record threw a raw internal string out of `pull` and lost every other bundle in that
  index. Bad records (unsafe `file`, `bundleId`, `sessionIdInBundle`, or thread key) are now
  dropped individually with a warning, keeping the rest of the index.
  ([#28](https://github.com/Sertelegger/claude-sesh-mover/issues/28))
- **A stolen lock could be released by the machine it was stolen from.** `release()` deleted
  the lock file unconditionally, so after another process stole a stale lock (>10 min), the
  original holder's `release()` deleted *the thief's* lock and a third process could acquire
  while it was mid-write — into your working tree, a real git repo, or a transcript splice,
  with the unattended `SessionEnd` auto-push among the callers. Each acquisition now carries
  an owner token and only deletes a lock still bearing it.
  ([#28](https://github.com/Sertelegger/claude-sesh-mover/issues/28))
- **An exact `lastActiveAt` tie in the index projection was broken by iteration order.**
  `buildIndexFile` now falls back to the session id, a stable key — deliberately not
  `newerThreadCopy`, whose `messageCount` tiebreak would prefer a stale base over a
  continuation. ([#28](https://github.com/Sertelegger/claude-sesh-mover/issues/28))
- **The project-local `.claude/` directory was uploaded by the default-on auto-push.** For a
  project with no git remote, the workspace snapshot copied it whole —
  `settings.local.json` (permission allowlists, which routinely name paths and hostnames),
  project hooks and agents, and, if `CLAUDE_CONFIG_DIR` pointed inside the project, every
  transcript a second time inside the *project* payload. `.claude` is now a built-in
  workspace exclude. It is a default rather than a floor, so `hubinclude` names it back; in
  a git project a committed `.claude/settings.json` still travels in the patch while an
  untracked `settings.local.json` does not.
- **A divergence you were asked about could be answered, and the answer silently
  dropped.** When a pull met a fork it could not resolve — `--on-divergence skip`, or an
  `adopt-hub` refused because the local transcript looked live — it left *that bundle*
  unapplied and carried on to the next one in the same chain. The next one is anchored on
  the head the skipped bundle would have installed, so it could never chain onto the local
  session either: it was imported as a *third* transcript, recorded, and its own outcome
  overwrote the `divergence.resolution` field, so a user who picked "adopt the hub's
  branch" got a fragment with nothing saying so — and every remedy the warning named then
  answered "Nothing to pull". A divergence now stops the **whole thread**: no later bundle
  of the chain is fetched, applied, saved or recorded (the warning says how many were left),
  so re-running with the answer applies it to the whole thread. Only reachable with two or
  more pending bundles, which is why the single-bundle round trip looked correct.
- **…and that stop is now honest about what it already did.** A chain is walked in order,
  so when the fork is not the *first* bundle, the ones before it have already been spliced
  into your transcript and recorded — while the warning still said "skipped, nothing
  changed" and `commands/pull.md` told the assistant that `resolution: "skip"` meant
  nothing had happened yet. Three consequences, all fixed: the carried uncommitted work of
  an **already-recorded** bundle was thrown away rather than deferred (the re-run never
  offers that bundle again, so the only surviving copy was the archive on the hub, and the
  warning claimed the opposite); both stop-warnings now name what the earlier bundles
  landed and say the re-run resumes at the diverged bundle; and the fork report no longer
  counts entries **this same pull** just delivered as your own local divergence
  (`divergence.localEntriesSinceAnchor` was reporting 4 where 2 of the 4 had arrived from
  the hub moments earlier).
- **"The latest copy of this thread is already local" refused work that was still on the
  hub.** That answer is about *heads*, and the question is about *bundles* — and the
  default-on auto-push routinely separates the two: `/sesh-mover:pull` probes with
  `--on-divergence skip` and re-runs with your answer, and one session end in between
  publishes this machine's own diverged branch. The answer was then refused outright. A
  pull whose newest copy is this machine now falls back to the copy that still lists
  bundles this machine has never received, and says that it did.
- **A failed `push` left the project linked — and linking is what arms the automation.**
  `push --create-project` in a directory with no Claude Code sessions returned the
  exporter's `success: false` while having already written `.claude-sesh-mover/project.json`
  and created the hub project; the next session end then auto-pushed that directory,
  `.env` included. The identity write is now deferred until the export has produced a
  bundle, so any failure up to that point leaves the project unlinked. A push that fails
  in the exporter also reports `"command": "push"` rather than `"command": "export"`.
  A failure *after* the link is committed — a bundle upload or an index write that throws
  — now rolls the local link back (only when this push is the one that wrote it, and only
  when the file still names the id it wrote) and returns a typed `success: false` instead
  of a bare throw, saying in as many words whether the project is linked, whether a bundle
  reached the hub with no index referencing it, and — because nothing can delete a hub
  project — the id of any hub project the failed `--create-project` left behind.
- **`migrate --dry-run` hid the most destructive part of its own plan.** The preview
  hardcoded `directoryRenamed: false` and emitted no rename warning, so a dry run with
  `--rename-dir` and one without were identical — and `commands/migrate.md` told the
  assistant to include the flag "so the preview reflects the real plan". The preview now
  answers the rename question through the same predicate the real run uses, in every case
  it has (would rename / target already exists / source missing / paths identical), so the
  two can no longer disagree. `MigrateResult` gains `dryRun: true` on previews, and
  `cleanedUp` is likewise predictive there rather than hardcoded false.
- **`migrate` swallowed the export's warnings**, which is where `--exclude` is disclosed —
  and on a migrate an excluded layer is *destroyed*, not left behind: cleanup deletes the
  whole source session directory and its file-history whatever the bundle carried. The
  `"<layer> excluded by user request"` warnings now reach the caller on both the real and
  the dry-run path.
- **The plain-append liveness decline named the wrong writer, and its remedy was
  overstated in both directions.** The self-write exemption covers only the pull doing the
  asking, so sesh-mover's *own* earlier pull — whose import stamps the transcript — was
  reported as "possible live session" with nothing running anywhere. The message now gives
  the age and both candidates. `--force-append` is foreclosed for the bundle that declined
  (it was imported and recorded) but not for the thread: on the *next* pull of that thread
  it does splice, and the docs now scope it that way instead of calling it useless.
- **The workspace no-ancestor skip promised that `--target-path` would end it.** It does
  not: all local bookkeeping is keyed off the effective project path, which *is*
  `--target-path` when one is given, so the generation an unpack there records belongs to
  the fresh directory and pulls into the original keep skipping identically. Only
  `--force-workspace` ends it for the project directory; `--target-path <fresh-dir>` is
  the non-destructive way to *see* a payload. Corrected in the warning, `README.md`,
  `commands/pull.md` and the skill doc.
- **A saved carry payload could hand you a command that plants plugin/VCS internals.** The
  saved copy's `README.md` tells you to run `cp -R '<saved>/untracked/.' .`, which copies
  dot-entries — so an `untracked/.git/hooks/pre-commit` or
  `untracked/.claude-sesh-mover/hubinclude` that `--apply-carry` refuses outright was saved
  verbatim on the routine path. The floor now runs on the save too; refusals are listed in
  `carryApplied.refused`, in the pull's warnings and in that README. Only a hand-made,
  damaged or pre-floor bundle can contain such a path.
- **`adoptHubBranch` restored a transcript it could not measure.** A failed `statSync`
  after the truncate left the whole-file restore to proceed blind, where the append path
  throws in the identical situation. It now refuses and throws, naming the pre-adoption
  snapshot it keeps.
- **The split-thread warning named a machine three times without distinguishing them.**
  Machine names come from the hostname, so two default installs or a VM clone share one;
  any name used by more than one machine in that sentence now carries its machine id.
- **`configure --set <key> --scope project` unconfigured the hub for that project**
  (pre-existing, and this is the release that tells you to run it). A scope-targeted write
  serialized the *whole* config — every default included — so the project file then beat
  the user file on keys only the user scope had ever set, `hub.path: ""` among them:
  `hub status` answered `hubPath: null` and `push` answered "No hub configured". A scope's
  file now holds only what that scope sets, and `--reset` clears one scope instead of
  pinning defaults over the other. `hub init --scope project` had the same defect.
- **A project *with* a git remote could have its whole working tree uploaded.** Which
  payload a push builds is decided by asking git for the project's remotes, and three
  different answers collapsed into "there are none" — the condition for the workspace
  snapshot, which deliberately does not read `.gitignore`. A remote sesh-mover could not
  canonicalize (`git@gitserver:team/repo.git` — an ordinary self-hosted server, whose host
  carries no dot) and *any* failure to run `git` at all (missing binary, timeout,
  unreadable repository) both landed there, with `warnings: []`. Since the session-end
  auto-push is on by default and unattended, that meant `.env`, `secrets/`, and everything
  else `.gitignore` covers could reach the hub with nothing said. A project with an
  unrecognized remote now takes the git-diff carry (the payload those rules *do* filter),
  and a project whose git cannot be asked gets **neither** payload plus a warning saying so.
- `pull --latest` (and "the latest copy of this thread is already local") returned before
  the split-history disclosure ran, so a machine holding half of a thread whose bundles
  span two others was told "all threads are current on this machine" — the most reassuring
  answer available, on the copy that was least complete. Both branches now report
  `unfetchableBundles`.
- The header at the top of a pulled continuation said the earlier messages lived in a named
  session "on this machine". That id is the *sending* machine's, and the importer mints a
  fresh one for everything it writes, so on the machine actually reading the header it named
  nothing. It now names the machine those messages are on.
- `--force-workspace` was described as merging into the target directory in four places,
  including one suggestion emitted only when no merge was possible. It overwrites files of
  the same name; the 3-way merge is a different path that the flag deliberately skips.
- `whereis`/`pull` picked the "latest copy" of a thread by index-file iteration order when
  `lastActiveAt`, `messageCount` and head uuid all tied — which is exactly what a
  successful append produces. The tiebreak is now total and deterministic (final key:
  machine id).
- Workspace snapshots skipped `.git` case-sensitively, so on a case-insensitive filesystem
  (macOS, Windows) a directory named `.GIT` was copied into the bundle and uploaded to the
  hub — a git store, in plaintext, in every push of that project.
- Unpacking a workspace payload (`--force-workspace`) refused nothing: a bundle carrying
  `workspace/.claude-sesh-mover/…` could plant the project-scope `config.json` that decides
  where this machine's hub is, or the `hubinclude` that decides what its next push uploads.
  Both names are now refused on every apply path (`workspaceRefused`).
- Unpacking a workspace payload wrote **through** a symlink in the target tree, landing a
  file outside the project entirely. Both apply paths now share one destination classifier.
- `push` no longer records a workspace generation for a snapshot it did not send
  (over-budget or skipped) — a recorded-but-unapplied generation makes the next merge read
  the whole tree as deleted.

### Known limitation
- **A thread whose history spans two machines cannot be pulled whole by a third**
  ([#35](https://github.com/Sertelegger/claude-sesh-mover/issues/35)). A pull fetches the
  bundle list of exactly one machine, and each machine's index lists only the bundles it
  pushed. **v0.6.0 ships a disclosure, not a fix:** `pull` and `whereis` now report the
  machines holding the part that could not be fetched (`unfetchableBundles`, plus a warning
  on `pull`), and there is **no flag that fetches them** — `--from-machine` does not exist,
  `--thread`/`--target-path` resolve to the same source, and `hub reindex` only rebuilds
  this machine's index from its own bundles. Nothing is lost (every bundle stays on the
  hub) and two machines are unaffected; on a third, the conversation arrives in halves and
  the session-start notice will keep flagging that thread as behind. Chain assembly is the
  next slice.

### Security / consent
- **Linking a project is the consent gate for the automation.** Both hooks default on and
  both are inert until a hub is configured *and* the project is linked. See "Read this
  before upgrading" for the opt-out keys.
- **The carry's safety rules cover the untracked half only — say it that way.** Among
  *untracked* files, a gitignored one is never carried unless `hubinclude` names it, and
  symlinks, `.git`, `.claude-sesh-mover`, `hubignore` matches and the built-in excludes are
  all dropped. **None of that filters the patch:** `git diff HEAD` describes every *tracked*
  file that changed, so a file that is gitignored *and* tracked (committed once, gitignored
  later, never `git rm --cached`; or `git add -f`) travels in full. `push` names that set
  back in `carry.trackedIgnored` and in a warning — the remedy there is `git rm --cached`
  or `--no-carry`, never a `hubinclude`/`hubignore` line.
- `.git` and `.claude-sesh-mover` are refused on every apply path — workspace unpack,
  workspace merge, and the carry patch (a bundle must never be able to plant the
  `config.json` that says where your hub is, or the `hubinclude` that decides what your
  next push uploads). A carry payload naming either, or creating a symlink, is refused
  whole rather than partly applied.
- The hub directory's threat model is unchanged and still **"a folder only machines you own
  can write"**: sessions remain plaintext at rest, applying a payload writes ordinary
  project files ([#36](https://github.com/Sertelegger/claude-sesh-mover/issues/36)), and
  the merge ancestor is verified on our side but self-reported by the peer
  ([#37](https://github.com/Sertelegger/claude-sesh-mover/issues/37)). Both are gates on
  any future hosted backend.

## [0.5.1] — 2026-07-28

### Fixed
- `browse` (and the `/sesh-mover:import` picker) reported archives with the *browsing*
  machine's platform and blank/zero metadata; it now reads each archive's real
  `manifest.json` and reports the true origin platform, project path, export date, and
  session count. Archives whose metadata genuinely can't be read (e.g. `.tar.zst` on a
  machine without `zstd`) are now marked `metadataAvailable: false` with a reason instead
  of showing fabricated values.

### Changed
- `BrowseResult` archive entries: `exportedAt` / `sourcePlatform` / `sourceProjectPath` /
  `sessionCount` are nullable and accompanied by `metadataAvailable` (+ `metadataError`
  when false).

## [0.5.0] — 2026-07-21

The Hub, Slice 1: a cross-machine session index with a filesystem backend — push, pull,
and see where a project's sessions live across every machine you use.

### Added
- **The Hub** — `hub init`, `hub status`, `hub reindex`, `push`, `pull`, `whereis`.
  - Filesystem hub backend: any directory works as the hub — network share, or a
    synced folder (OneDrive/Dropbox/Syncthing/iCloud Drive).
  - Project identity (`.claude-sesh-mover/project.json`, meant to be committed) with
    git-remote matching, so a project links to the same hub project from any clone.
  - Logical-session **threads** with cross-machine lineage — `whereis` shows every
    machine's copy of a thread, which one is latest, and whether the local copy is
    current or stale.
  - Workspace snapshots for git-less projects (project files bundled alongside
    sessions on push/pull), with `.claude-sesh-mover/hubignore` support to exclude
    paths from the snapshot.
  - `--progress` NDJSON phases on `push`/`pull` (extends the existing
    export/import/migrate progress contract).
  - Same-machine advisory locking so two hub operations for the same project on one
    machine don't race each other.
  - Plugin slash commands: `/sesh-mover:push`, `/sesh-mover:pull`,
    `/sesh-mover:whereis`, `/sesh-mover:hub-init` (`plugin.json`'s `commands` array
    updated to match).
  - Library: the `src/hub/*` module surface (backend, layout, identity, threads,
    index-file, workspace, lock, init, status, push, pull, whereis, reindex) is
    re-exported from the package barrel (`src/index.ts`).
  - `--session-id` filtering on `push` is an **exact subset** of the project's
    sessions — reuses `exporter.ts`'s existing sessionIds filter (unknown ids are
    rejected, not silently skipped).

### Changed
- Sync-state schema **v2** (additive): a `hub` block (`hubId` + thread-by-local-session
  mapping) is added only once a project first pushes/pulls through a hub; files
  otherwise stay v1. Older plugin versions that see a v2 file don't understand
  `schemaVersion: 2` and treat it as corrupt — the file is renamed aside and a fresh
  state is started, which loses only peer/thread bookkeeping, never session data.
- Export manifest gains two optional, backward-compatible fields: `projectId` (hub
  project this bundle belongs to) and `workspace` (`fileCount`/`byteSize`/`snapshotAt`
  when a workspace snapshot was included).
- `HubPullResult.localSessionId` is `string | null` — `null` specifically means the
  pulled content was already present locally, but sesh-mover couldn't identify which
  existing local session it corresponds to (a bookkeeping edge case), not that the
  pull failed.

### Fixed
- Config-merge bug (pre-existing, since the two-tier config was introduced): merging
  user-scope and project-scope config silently reset any user-scope-only setting to
  its default whenever the project-scope `config.json` didn't exist, because
  `readConfig` always backfills defaults even for a missing file — the merge couldn't
  distinguish "no project override" from "project explicitly set back to default".
  Fixed via `computeEffectiveConfig`, which layers raw (non-backfilled) file overrides
  onto defaults instead of merging two independently-defaulted config objects; `cli.ts`'s
  `loadEffectiveConfig` now routes through it. Affects `export`, `migrate`,
  `configure --show`, and the new `hub status`/`push`/`pull` — everywhere effective
  config is read (57cd7b7).

### Security
- **Hub trust model documented:** the hub directory is the trust boundary — every
  pulled bundle still passes the existing tar-entry validation and manifest-id safety
  checks before anything touches disk, but **sessions are stored in the hub in
  plaintext at rest** until a future encryption slice ships. Anyone with read access
  to the hub folder can read every pushed session; treat the hub directory like you'd
  treat `~/.claude/projects/` itself.

## [0.4.1] — 2026-07-20

Toolchain and repo-hygiene release: the package is now ESM on current dependency
majors, and the repo gained CI-enforced community and security scaffolding.

### Changed
- Package is now ESM (`"type": "module"`); `dist/` is emitted as ES modules (#26).
- Node floor raised 18.17 → 22.12 — current Claude Code releases already require
  Node ≥ 22, and commander 15 needs ≥ 22.12 (#26).
- commander 13 → 15 (ESM-only major) (#26).
- Dev toolchain: TypeScript 7 (native compiler — emitted `dist/` byte-identical
  to 5.9), vitest 4, @types/node 26 (#22, #25, #26).

### Added
- Community health files: contributing guide, security policy, code of conduct,
  issue forms, PR template (#17).
- Dependabot (grouped minor/patch updates), CodeQL scanning, and automatic
  GitHub Releases on `v*` tag push (#17).
- npm publish metadata: `repository`/`homepage`/`bugs` fields, `files` allowlist,
  `prepublishOnly` guard (#17).
- Social preview banner assets under `.github/`.

## [0.4.0] — 2026-07-14

First CI-tested release: a 3-OS test matrix, a streaming rewrite/import/export pipeline for
large sessions, and a URL-safety fix for cross-family path rewriting.

### Added
- First CI: 3-OS matrix (Linux/macOS/Windows), dist-freshness gate, and a Windows
  PowerShell/Git-Bash smoke round-trip (#7).
- `--progress` flag on `export`/`import`/`migrate` — emits NDJSON progress events on
  stderr; the stdout JSON result contract is unchanged.
- Library: `transformLine`, `rewriteJsonlStream`, `computeIntegrityHashFromFile`,
  `buildContinuationStream`, `extractSummaryFromFile`, `readEntryUuids`, `percentThrottle`,
  `ProgressEvent`.

### Fixed
- Free-text tokens preceded by `/` are no longer translated — URLs with unix-root hosts
  (`http://mnt/e/...`, `//tmp/...`, `file:///...`) now survive cross-family import intact,
  instead of being mangled by token translation (#8). The fix guards on both the preceding
  `/` and a domain-character class (`[A-Za-z0-9.-]`) immediately before the match — the
  domain guard is load-bearing, protecting hosts like `https://example.com/mnt/e/data` from
  being treated as a bare path. Accepted trade-off: POSIX `//net/share` and `file://` URLs
  no longer translate in free text.

### Changed
- **Streaming pipeline** — rewrite/import/export is now O(longest-line) memory per session
  instead of loading whole sessions into memory; hash format and bundle compatibility are
  unchanged (#11).
- Import validation failures now abort before the memory/plans merge step (previously the
  merge ran first).
- Dry-run `rewriteReport` JSON gains two additive keys: `adaptationsApplied` and
  `parseFailures`.

## [0.3.2] — 2026-07-14

### Security
- Import now rejects manifests whose session ids contain path separators or `..`
  — a crafted bundle could previously make the importer read files outside the
  bundle and copy them into the session store (path traversal → exfiltration).
  Affects 0.1.0–0.3.1 (#13).

### Fixed
- Path rewriting no longer rewrites sibling paths that merely share a mapped
  prefix (e.g. `app` vs `app-backup`) (#14).

## [0.3.1] — 2026-07-14

Hardening follow-ups surfaced by the 0.3.0 final review.

### Added
- Import dedup registry now tracks registered state — a `--no-register` import is no longer
  a dead end: a later normal import of the same bundle automatically imports a registered
  copy, leaving the earlier unregistered copy on disk (#1).
- `MigrateResult.skippedSessions` — migrate now surfaces the same duplicate/already-received
  skip reporting import already had (#3).

### Fixed
- Incremental diff: a session with an empty recorded head UUID is now sent whole instead of
  risking a bad diff against it (#2).
- `--since <path>` fallback keys continuation sessions by their local session id (matching
  how sync-state records them) instead of the source session id, so re-diffing against a
  reference bundle correctly recognizes continuations of the same session (#4).
- Export: archive-name collision detection now also checks for existing `.tar.gz`/`.tar.zst`
  artifacts, not just a same-named directory — previously a second archive export with the
  same name could silently overwrite the earlier archive (#5).

### Removed
- Import's no-op `--force` flag (confirmation was never gated on it) (#6).

## [0.3.0] — 2026-07-13

Hardening pass: fixes from a full adversarial review of 0.2.0.

### Security
- Archiver: zstd intermediate files now live in private temp dirs (never next to — or
  clobbering — user files); tar entries are validated *before* extraction (absolute paths,
  `..` traversal, symlink/hardlink entries rejected).
- Config: prototype-polluting `--set` paths rejected; malformed JSON values return a clean
  error. `npm audit` down from 5 advisories to 0.

### Added
- **Idempotent imports** — a per-project content-hash registry skips already-imported
  sessions (with an existence check so a deleted copy can be re-imported); structured
  `skippedSessions` reporting; `--allow-duplicates` to override.
- `--no-summary` / `export.noSummary` now functional: slug-only manifests, no conversation
  text in export metadata or resume listings.

### Changed
- **Path rewriting rebuilt as a two-stage pipeline** — exact project/config/home mappings
  with separator normalization, then cross-family token translation (`/mnt/<drive>`, `/tmp`,
  home dirs) — fixing mixed-separator output and untranslated paths in tool output for
  WSL ↔ Windows ↔ macOS ↔ Linux imports; structured fields (`cwd`, file-history keys)
  translate fully, including spaced Windows paths; array-form tool results now covered.
- Migrate: `--scope current` requires `--session-id` (previously it silently migrated and
  deleted **all** sessions); source cleanup deletes only confirmed-moved sessions.
- Memory footprint: discovery and export process sessions one at a time with bounded reads —
  peak usage is O(largest session), not O(all sessions).

### Fixed
- Incremental sync: sent-state head UUIDs are recorded from the export snapshot (not the
  live, still-growing session) and only after the archive is successfully written; the
  `--suffix` collision path now archives and records state like every other path;
  continuation bundles carry subagents/tool-results/file-history layers; the slice point is
  verified by UUID before cutting a continuation.
- Discovery no longer fails on sessions whose first JSONL line exceeds 4KB.
- `configure --set machine.name=<label>` now actually persists the name (documented in
  0.2.0 but unwired).

## [0.2.0] — 2026-04-21

Incremental sync between machines.

### Added
- Persistent machine identity (`~/.claude-sesh-mover/machine-id.json`) and per-project,
  per-peer sync state with atomic writes and corrupt-file recovery.
- `export --incremental --to <peer>`: new sessions ship whole; sessions with new messages
  ship as **continuation sessions** (lineage header + only the new messages); unchanged
  sessions are skipped. `--since <path>` as a stateless fallback.
- Import records lineage and peer state; re-importing an incremental bundle skips
  already-received sessions.
- CLI flag validation and `tar.gz`/`tar.zst` format aliases.

## [0.1.3] — 2026-04-18
- Slash commands invoke the CLI via `${CLAUDE_PLUGIN_ROOT}` instead of searching the plugin
  cache.

## [0.1.2] — 2026-04-16
- Archive exports remove their staging directory; the archive is the sole artifact.

## [0.1.1] — 2026-04-15

Public-release prep.

- Self-migration safety: migrate refuses to run from inside the session being migrated
  (`--force` overrides).
- Interactive browse (view details, import, delete); `--rename-dir` on migrate; import
  discovers bundles dropped in the project root.
- Committed `dist/` so the plugin works without a build step; marketplace manifest for
  `/plugin marketplace add`; docs and MIT license.
- Review-pass fixes: import rollback scoped to files it wrote; path mappings sorted
  longest-first to prevent prefix collisions.

## [0.1.0] — 2026-04-11

Initial release: export / import / migrate / browse / configure slash commands and CLI;
platform detection with WSL1/WSL2 discrimination and WSL ↔ Windows path translation;
session discovery; JSONL path rewriting; manifest with sha256 integrity hashes; `tar.gz` /
`tar.zst` archives; version-adapter framework; two-tier config; full-fixture integration
tests.
