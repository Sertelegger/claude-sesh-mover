// The two imports in this module, and deliberately type-only: the merge report
// and the carry metadata are hub-module concepts with their own documentation,
// and duplicating their shapes here to keep this file import-free would
// guarantee the copies drift apart. Type-only means nothing is imported at
// runtime, so neither creates a module cycle.
import type { WorkspaceMergeReport } from "./hub/merge.js";
import type { ApplyResult, CarryMeta } from "./payload/carry.js";

// --- Platform ---

export type Platform = "darwin" | "linux" | "wsl1" | "wsl2" | "win32";

// --- JSONL Entry Types ---

export type JsonlEntryType =
  | "user"
  | "assistant"
  | "file-history-snapshot"
  | "system"
  | "progress";

export interface JsonlEntryBase {
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  version: string;
  gitBranch?: string;
  slug?: string;
  userType?: string;
  entrypoint?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  agentId?: string;
}

export interface UserMessageContent {
  role: "user";
  content: string | Array<Record<string, unknown>>;
}

export interface UserMessageEntry extends JsonlEntryBase {
  type: "user";
  message: UserMessageContent;
  promptId?: string;
  permissionMode?: string;
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
    isImage?: boolean;
  };
  sourceToolAssistantUUID?: string;
}

export interface AssistantMessageEntry extends JsonlEntryBase {
  type: "assistant";
  message: {
    model: string;
    id: string;
    content: Array<Record<string, unknown>>;
    usage?: Record<string, unknown>;
  };
  requestId?: string;
}

export interface FileHistorySnapshotEntry extends JsonlEntryBase {
  type: "file-history-snapshot";
  messageId: string;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<
      string,
      {
        backupFileName: string;
        version: number;
        backupTime: string;
      }
    >;
    timestamp: string;
  };
  isSnapshotUpdate?: boolean;
}

export interface SystemEntry extends JsonlEntryBase {
  type: "system";
  subtype?: string;
  durationMs?: number;
  messageCount?: number;
  isMeta?: boolean;
}

export interface ProgressEntry extends JsonlEntryBase {
  type: "progress";
  data: Record<string, unknown>;
  parentToolUseID?: string;
}

export type JsonlEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | FileHistorySnapshotEntry
  | SystemEntry
  | ProgressEntry;

// --- Manifest ---

export type ExportLayer =
  | "jsonl"
  | "subagents"
  | "file-history"
  | "tool-results"
  | "memory"
  | "plans";

export type SessionScope = "current" | "all";
export type StorageScope = "user" | "project";
export type ExportFormat = "dir" | "archive" | "zstd";

export interface SessionContinuation {
  continuesLocalSessionId: string;
  continuesPeerSessionId?: string;
  fromEntryIndex: number;
  /**
   * Uuid of the FIRST entry this delta ships — `entries[fromEntryIndex].uuid`,
   * i.e. one PAST the head it was diffed against (`src/diff.ts`). Its consumer
   * is the continuation header written by `continuation.ts`, which re-reads the
   * entry at `fromEntryIndex` and refuses the slice if the uuid moved.
   *
   * It is NOT a link to the previous bundle and never was — see
   * `anchorEntryUuid`. It is also routinely `""`: `readEntryUuids` maps every
   * uuid-less or unparseable line to `""`, and the first unsent line of a live
   * transcript is usually a uuid-less bookkeeping entry.
   */
  fromEntryUuid: string;
  /**
   * The head this delta was built AGAINST: the `headEntryUuid` of the last
   * bundle the peer is recorded as holding, i.e. the parent of the first entry
   * shipped here. This is the field a chain walk links on — a bundle whose
   * `headEntryUuid` equals it is this one's predecessor.
   *
   * Optional, and the absence is meaningful rather than a default: a manifest
   * written before chain assembly existed carries no anchor and its bundle is
   * therefore **unlinkable by construction**. Never substitute `fromEntryUuid`
   * for a missing value — the two have never been equal, and mixing them in one
   * map manufactures chains that look assembled and are not.
   *
   * When present it is a non-empty uuid: `computeIncrementalPlan` falls back to
   * a full push whenever the recorded head is `""` or is no longer in the
   * transcript, so no continuation is ever planned against an empty head.
   */
  anchorEntryUuid?: string;
}

export interface SessionLineage {
  sourceMachineId: string;
  sourceSessionId: string;
}

export interface SessionManifest {
  sessionId: string;
  slug: string;
  summary: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  gitBranch: string;
  entrypoint: string;
  integrityHash: string;
  type?: "full" | "continuation";
  lineage?: SessionLineage;
  continuation?: SessionContinuation;
  /**
   * One aggregate digest per auxiliary layer directory this session carries —
   * `subagents`, `tool-results`, `file-history`. Until 0.6.0 only the session
   * JSONL was hashed, so a corrupted `file-history` backup rode through
   * silently and was later restored over the user's own file.
   *
   * A key is present only when the bundle actually contains that directory, and
   * the whole field is absent on bundles written before it existed — see
   * `computeLayerDigest` for the format and for why this is one digest per
   * layer rather than one per file.
   */
  layerDigests?: Partial<Record<"subagents" | "tool-results" | "file-history", string>>;
}

export interface ExportBaseline {
  targetMachineId: string;
  targetMachineName?: string;
  lastSyncAt?: string;
  referenceExport?: string;
}

export interface ExportManifest {
  version: number;
  plugin: "sesh-mover";
  exportedAt: string;
  sourcePlatform: Platform;
  sourceProjectPath: string;
  sourceConfigDir: string;
  sourceClaudeVersion: string;
  sessionScope: SessionScope;
  /**
   * The layers this bundle ACTUALLY CARRIES — content, never policy.
   *
   * A layer is listed iff its payload is on disk in the bundle: `jsonl` iff at
   * least one session file was written, the three per-session layers iff at
   * least one session directory for them exists (which is exactly when that
   * session declares a `layerDigests` key for it), `memory`/`plans` iff their
   * bundle-root directory exists. Nothing is listed because it was merely
   * *requested*.
   *
   * It used to be `getAllLayers()` minus `--exclude`, computed once and stamped
   * regardless of what the export then did — so every hub bundle declared
   * `memory` and `plans` while carrying neither (#53), and any export from a
   * source with no subagents declared `subagents`. `commands/browse.md` offers
   * this field to a human as the answer to "what is in this export", so the
   * distance between the two readings was a lie with a reader.
   *
   * It is OUTSIDE `sessionsDigest` (that digest covers `sessions` only), so
   * changing what is declared here can never invalidate an existing bundle.
   */
  includedLayers: ExportLayer[];
  sessions: SessionManifest[];
  /**
   * Digest over the session inventory above — see `computeSessionsDigest` for
   * what it covers, what it deliberately does not, and why it is damage
   * detection rather than attestation. Optional: pre-0.6.0 bundles carry none
   * and are verified as they always were.
   */
  sessionsDigest?: string;
  /**
   * `computeLayerDigest` over the bundle's own `memory/` directory — present
   * iff the bundle carries one, so it is the machine-readable twin of
   * `includedLayers` containing `"memory"`.
   *
   * Its job is the incremental skip: a push records this value against the peer
   * it sent to (`SyncStatePeer.memoryDigest`), and the next export to that peer
   * ships `memory/` again only when the source directory no longer hashes to
   * it. Taken over the BUNDLE's copies rather than the source tree, for the same
   * reason `computeSessionLayerDigests` is — the recorded value has to describe
   * the bytes that actually travelled, or a truncated copy would suppress the
   * re-send that repairs it.
   *
   * Outside `sessionsDigest`, like `workspace`/`carry`/`projectId`.
   */
  memoryDigest?: string;
  sourceMachineId?: string;
  sourceMachineName?: string;
  incremental?: boolean;
  baseline?: ExportBaseline;
  projectId?: string;
  workspace?: {
    fileCount: number;
    byteSize: number;
    snapshotAt: string;
    /**
     * The workspace generation the pushing machine's tree descended from when
     * this snapshot was taken — i.e. its own `hub.lastWorkspace` at that
     * moment. `null` when it had none (this was its first workspace push).
     *
     * **Only `bundleId` is ever acted on.** A puller looks that id up in its own
     * `hub.workspaceGenerations`; a hit proves the generation is common to both
     * trees and makes it a legal merge base, and the puller then uses ITS OWN
     * record of that generation. `file` and `pushedAt` are diagnostics: the
     * first never becomes a path on the puller (a forged one therefore cannot
     * reach the filesystem at all), and the second is the pusher's wall clock,
     * so it is not comparable with anything of ours.
     *
     * Without this field a puller can only assume its own generation is common,
     * which silently reverts its newer work to the pusher's older copy whenever
     * the two machines pushed without pulling in between — something auto-push
     * makes routine. Optional because bundles written before this field existed
     * do not carry it; those declare no common generation, so the payload
     * degrades to no-ancestor mode (§5.4) rather than being merged against a
     * guess.
     */
    basedOn?: { bundleId: string; file: string; pushedAt?: string } | null;
  };
  /**
   * Uncommitted work captured beside the sessions (design §6.1), for a project
   * with a git remote. Absent when the tree was clean, when the payload was
   * over budget, or when carry was off — and absent on every bundle written
   * before this field existed, which is why the apply side must treat it as
   * optional rather than as a promise the `carry/` directory is well-formed.
   */
  carry?: CarryMeta;
}

// --- Config ---

export interface SeshMoverConfig {
  export: {
    storage: StorageScope;
    format: ExportFormat;
    exclude: ExportLayer[];
    scope: SessionScope;
    noSummary: boolean;
    /**
     * Capture the whole-project workspace snapshot beside the sessions
     * (`--include-workspace`), for a project with NO git remote.
     *
     * **DEFAULT FALSE, and the polarity is the security decision (#47), not a
     * style choice.** `hub.noWorkspace: false` is the mirror image — the hub's
     * payload is on by default because linking a project is the consent gate
     * and the bundle lands in a directory the user configured. An export has no
     * such gate: `--output` names any path, and the artifact gets scp'd,
     * emailed, dropped in a shared folder or handed to someone. The destination
     * is unknown at capture time, so the user chooses. Do NOT "harmonize" the
     * two polarities.
     *
     * The snapshot does not read `.gitignore` at all, which is why it is only
     * ever taken for a project git says has no remote.
     */
    includeWorkspace: boolean;
    /**
     * Capture the git-diff carry beside the sessions (`--include-carry`), for a
     * project WITH a git remote. Default false, for the reason above.
     *
     * The asymmetry with `includeWorkspace` is why these are two keys and not
     * one: the two payloads have different disclosure profiles (the snapshot
     * ignores `.gitignore` entirely; the carry filters the untracked half and
     * nothing in the patch), so consent to one is not consent to the other, and
     * a single key could not express "snapshot never, carry sometimes".
     */
    includeCarry: boolean;
    /**
     * Byte budget for `--include-workspace`, in MB. Separate from
     * `hub.workspaceMaxMb` rather than merely tidy: the hub's is conservative
     * BECAUSE its payload rides a bundle pushed on every session end, and an
     * export is a one-shot foreground act with no such multiplier.
     */
    workspaceMaxMb: number;
    /** The same, for `--include-carry`. See `hub.carryMaxMb` for the semantics. */
    carryMaxMb: number;
  };
  import: {
    dryRunFirst: boolean;
  };
  migrate: {
    scope: SessionScope;
  };
  hub: {
    path: string; // "" = not configured
    noWorkspace: boolean;
    // Push this project to the hub from the Claude Code SessionEnd hook.
    // Defaults true, but inert until a hub is configured AND the project is
    // linked — linking is the consent gate (see src/hub/hooks.ts).
    autoPush: boolean;
    // Announce, from the Claude Code SessionStart hook, that a newer copy of
    // one of this project's threads lives on another machine. Same consent
    // model as autoPush: default true, inert until hub + link.
    startupNotice: boolean;
    // Splice a pulled continuation onto the local session it continues,
    // instead of importing it as a standalone fragment. Set false (or pass
    // --no-append) to keep the Slice-1 fragment behavior.
    pullAppend: boolean;
    // What to do when a thread was extended on BOTH machines from the same
    // anchor, so neither branch continues the other. See OnDivergenceMode.
    onDivergence: OnDivergenceMode;
    // Carry uncommitted work (a `git diff HEAD` patch plus untracked files)
    // alongside the sessions, for a project with a git remote. Set false (or
    // pass --no-carry) to push sessions only. Never carries a gitignored
    // UNTRACKED file unless .sesh-mover-include names it — but a
    // gitignored file that git TRACKS has its changes carried in the patch
    // regardless, since no carry rule filters the patch (reported back as
    // `carry.trackedIgnored`).
    carryDiff: boolean;
    // Byte budget for the git-diff carry, in MB (default 50). Over it the WHOLE
    // payload is declined with a warning, never partially sent. `0` means carry
    // nothing; a negative, non-finite or non-numeric value falls back to the
    // default with a warning; anything over 1024 MB is clamped. See
    // `resolveBudgetMb` in config.ts for why each of those is what it is.
    //
    // Worth knowing before raising it: the carry rides a bundle pushed on EVERY
    // session end, unattended, and the hub keeps every bundle — so a 50 MB
    // carry on a synced folder is 50 MB of sync traffic per session end.
    carryMaxMb: number;
    // The same, for the whole-project workspace snapshot a project with no git
    // remotes pushes instead of a carry (default 50).
    workspaceMaxMb: number;
  };
}

/**
 * How `pull` resolves a thread that diverged (local and hub both extended the
 * same anchor, so the chain guard refuses to splice):
 * - `fragment` (default): keep both, import the hub's branch as its own
 *   session. Nothing local is touched — the Slice-1 behavior.
 * - `adopt-hub`: make the hub's branch canonical in the local session and
 *   preserve the local branch as a second, complete session.
 * - `skip`: change nothing at all and leave the bundle unrecorded, so the same
 *   pull can be re-run with a different decision.
 */
export type OnDivergenceMode = "fragment" | "adopt-hub" | "skip";

// --- CLI Results ---

export interface ExportResult {
  success: true;
  command: "export";
  exportPath: string;
  sessions: Array<{
    originalId: string;
    slug: string;
    summary: string;
    messageCount: number;
    /**
     * What the bundle carries FOR THIS SESSION, plus the bundle-level layers
     * (`memory`/`plans`) it carries at all. Content, never policy — same rule as
     * `ExportManifest.includedLayers`, of which this is the per-session slice,
     * so two sessions in one bundle can legitimately differ (one had subagents,
     * the other did not).
     */
    exportedLayers: ExportLayer[];
  }>;
  warnings: string[];
  archivePath: string | null;
  actualFormat?: ExportFormat;
  collision: boolean;
  existingPath?: string;
  /**
   * The bundle carries a whole-project workspace snapshot (`--include-workspace`
   * on a project with no git remote). Same field name and same meaning as
   * `HubPushResult.hasWorkspace`, because a bundle is a bundle regardless of how
   * it travelled (#47).
   *
   * `false` is the default and the common case: unlike push, this payload is
   * opt-in — see `SeshMoverConfig.export.includeWorkspace` for why the two
   * polarities differ on purpose.
   */
  hasWorkspace: boolean;
  /**
   * The uncommitted work this bundle carries (`--include-carry` on a project
   * with a git remote), or absent when it carries none.
   *
   * Its two disclosures are LOUDER here than on push and the reason is the
   * artifact, not the mechanism: a hub bundle lands in a directory the user
   * configured, while this one gets scp'd, emailed or handed on.
   * `trackedIgnored` is the one that matters — no rule filters the patch, so a
   * `.env` that was committed once and gitignored later travels with its
   * current value in plaintext.
   */
  carry?: CarryMeta;
  /**
   * Gitignored paths this export did NOT carry — the `.sesh-mover-include`
   * discovery aid, capped at ten and spelled the way git spells them.
   *
   * Emitted on every payload-carrying export of a git project with no include
   * list, where push emits it only on a MANUAL push: every export is manual by
   * construction, and the artifact leaves the machine.
   */
  ignoredNotCarried?: string[];
  /** Never set on a real export. See `ExportPayloadPlanResult`. */
  payloadPlan?: false;
}

/**
 * `sesh-mover export --payload-plan`: what the FILE payload would carry, with
 * nothing written (#47).
 *
 * **Why this exists at all.** The disclosure a user needs before consenting to
 * ship their project's files — which payload applies, how many files, how many
 * bytes, which gitignored files are in it and why — is only knowable after the
 * capture has measured the tree, and a capture that has measured it has also
 * written it. The two ways out were to capture into staging and offer to abort,
 * which writes the secrets to local disk before anyone consented and makes the
 * staging directory the artifact for `--format dir`; or to expose the measuring
 * pass, which both builders already run first. This is the second.
 *
 * It exports NO sessions and creates NO bundle. `commands/export.md` runs it,
 * presents it, confirms, and only then runs the real export — the same
 * preview → confirm → execute shape `commands/import.md` already has, which is
 * the asymmetry #47 names: import needed new content in an existing gate, and
 * export needed the gate itself.
 */
export interface ExportPayloadPlanResult {
  success: true;
  command: "export";
  /** The discriminator. Always `true` here, never present on a real export. */
  payloadPlan: true;
  projectPath: string;
  /**
   * Which payload this project takes, decided by `scanGitRemotes` and nothing
   * else:
   * - `workspace` — no git remote, so the whole tree travels. It does NOT read
   *   `.gitignore`; that is the whole reason this arm is limited to a project
   *   git says has no remote.
   * - `carry` — a git remote, so only `git diff HEAD` plus untracked files
   *   travel. `.gitignore` filters the untracked half and NOTHING filters the
   *   patch.
   * - `none` — nothing to capture, or neither payload was requested.
   * - `unknown` — git could not be asked, which takes NEITHER payload. See
   *   `GitRemoteScan`.
   */
  decision: "workspace" | "carry" | "none" | "unknown";
  /** Present iff `decision` is `workspace`. The measured pass's own numbers. */
  workspace?: { fileCount: number; byteSize: number };
  /** Present iff `decision` is `carry`. The same block the bundle would declare. */
  carry?: CarryMeta;
  ignoredNotCarried?: string[];
  warnings: string[];
}

/**
 * A shared-namespace auxiliary file that exists on both sides with different
 * content. This is tier 3's entry point as well as tier 2's report: it gives
 * the skill layer the FACT of the conflict and two hashes, never the contents —
 * the contents come from disk, which is what `parkedAs` is for. By the time a
 * caller reads this the bundle may be gone (`cli.ts` deletes an archive's
 * extract dir before returning), so a reader that goes back to the bundle for
 * the incoming text is reading a directory that no longer exists.
 */
export interface AuxiliaryConflict {
  filename: string;
  existingHash: string;
  incomingHash: string;
}

export interface MemoryConflict extends AuxiliaryConflict {
  /**
   * Tier 2: the file the incoming copy was parked as, relative to the memory
   * directory (`<stem>.incoming.md`, uniquified). Absent only when parking was
   * impossible, in which case the incoming text is NOT on this machine.
   */
  parkedAs?: string;
}

/** What the `MEMORY.md` union did. `MEMORY.md` is an outcome, not a conflict. */
export interface MemoryIndexReport {
  /** Link targets appended to the local index, in incoming order. */
  added: string[];
  /** Incoming pointers deduped away because the local index already had them. */
  alreadyPresent: number;
  /** Incoming headings/prose discarded — the union merges entries, not documents. */
  droppedProse: boolean;
  /**
   * Memory files the bundle carried that no index line points at after the
   * union. These landed on disk unreachable — usually because they were already
   * orphaned on the SOURCE machine, which the union cannot fix: it is a union
   * over index lines, and a file no line points at contributes no line.
   */
  unindexed: string[];
}

/** One line of the dry run's memory preview. Same function as the real run. */
export interface MemoryPlanEntry {
  filename: string;
  /**
   * - `copy` — absent locally, will be written verbatim
   * - `identical` — present, bytes equal, no write
   * - `index-union` — this is `MEMORY.md` and it differs; entries will be appended
   * - `park` — prose conflict; local kept, incoming parked as `parkedAs`
   * - `keep-local` — conflict that could not be parked or read; local kept
   * - `skip` — not a regular file, ignored
   */
  verdict: "copy" | "identical" | "index-union" | "park" | "keep-local" | "skip";
  /** `index-union`: the link targets that would be appended. */
  added?: string[];
  /** `index-union`: incoming pointers that would be deduped away. */
  alreadyPresent?: number;
  /** `park`: the name that would be used, absent an unresolved earlier copy. */
  parkedAs?: string;
  note?: string;
}

/**
 * A payload that lands outside the minted session id.
 *
 * The first two are the SHARED-NAMESPACE layers — bytes out of the bundle into a
 * directory the target already owns. The second two are the FILE payloads #47
 * added, which land in the target PROJECT directory: `workspace` is a copy of a
 * whole working tree, `carry` is a git patch plus untracked files. They are the
 * reason the gate had to grow: a workspace payload is routinely hundreds of
 * paths where a memory layer is a handful, and every one of them is
 * bundle-chosen.
 */
export type WriteSetLayer = "memory" | "plans" | "workspace" | "carry";

/**
 * ONE path an import will write — or wrote — **outside the session id it
 * mints**. The write set is the consent gate's input (#36): the ruling is one
 * explicit per-import decision gating every payload that lands outside a minted
 * session id, *with the full write set disclosed*, and this is that disclosure
 * in a shape the skill layer can branch on rather than parse.
 *
 * **`display`, not `path`, is what goes in front of a human.** The final
 * segment of `path` is BUNDLE-CONTROLLED — a `readdirSync` basename out of the
 * bundle's `memory/` or `plans/` — so it can carry a newline, an ANSI escape or
 * an RTL override. `display` is that string through `JSON.stringify`, which is
 * the quoting rule stated at the top of `src/importer.ts` and taken from
 * `hub/index-file.ts`; there is deliberately no second convention. The
 * transport is not the defence: this rides out as JSON, where a newline is
 * `\n` and corrupts nothing, and then `commands/import.md` relays it into a
 * markdown list for a human — the same sink #79 closed for `MEMORY.md` pointer
 * lines and #38 closed for `git apply --summary`. Carrying the escaped form as
 * DATA is what stops the relay from having to remember.
 */
export interface WriteSetEntry {
  layer: WriteSetLayer;
  /** Absolute destination. For a program; never render it. */
  path: string;
  /** `JSON.stringify(path)` — quoted and escaped. The only form to show. */
  display: string;
  /**
   * - `create` — nothing is at `path`; this import creates it.
   * - `park` — a file of the bundle's name is already here and differs, so the
   *   incoming copy is saved BESIDE it under this name. The local file is not
   *   touched, which is why a park is disclosed as a write of a *new* name.
   * - `index-append` — `MEMORY.md` is already here and lines are appended to
   *   it. The only shared-layer kind that modifies a file the user already had.
   * - `overwrite` — a file of this name is already here and the workspace
   *   payload REPLACES it. Only reachable with `--force-workspace`, and the one
   *   fact a gate must not blur into "a new file arrived": unlike `park`, the
   *   local copy does not survive anywhere.
   */
  kind: "create" | "park" | "index-append" | "overwrite";
}

/**
 * A directory a bundle's payload can reach on this import, and how far its
 * blast radius goes. Reported even when the layer is declined (`applied:
 * false`), because "this bundle also wanted `<machine-global dir>`" is the
 * disclosure that makes an opt-in readable rather than mysterious.
 *
 * `path` is NOT quoted, and that is deliberate rather than an oversight: it is
 * built from this machine's own config dir and target project path, so quoting
 * it would assert a distrust that is not there (same rule as the QUOTING note
 * in `src/importer.ts`). Only `WriteSetEntry` carries bundle-chosen segments.
 */
export interface WriteSetRoot {
  layer: WriteSetLayer;
  path: string;
  /**
   * Whether `WriteSet.entries` enumerates this root's paths.
   *
   * `true` for `memory`, `plans` and `workspace`. `false` for `carry` ALONE, and
   * that is an argued scope line rather than an omission: a carry's destinations
   * live inside a git patch, and since #38 the only thing permitted to say what
   * a patch writes is git's own parse of it, read ONCE (`git apply --numstat -z
   * --summary`) because two invocations differing only in mode cannot disagree.
   * Predicting them before the apply would need either a second patch parser —
   * this codebase had one, and removed it after it let a copy-out of a
   * floor-protected file through — or a second git run against a tree that can
   * change in between.
   *
   * What stands in for enumeration is the payload's own gates, which are
   * strictly tighter than the workspace's: `applyCarry` refuses anything but a
   * CLEAN tree at the EXACT commit the patch was captured against, so it cannot
   * overwrite uncommitted work, and `git checkout -- .` undoes the patch half
   * whole. A gate that shows a list must SAY that this root's paths are not in
   * it — see `commands/import.md`.
   */
  enumerated: boolean;
  /**
   * - `project` — the target project's own directory; nothing else reads it.
   * - `machine` — shared by every project in this config dir. `plans/` is the
   *   only one, and it is why that layer is opt-in.
   */
  scope: "project" | "machine";
  /** Whether this run writes the layer at all. `false` = declined by a flag. */
  applied: boolean;
}

/**
 * Everything an import will write outside the session ids it mints.
 *
 * **SCOPE, stated so the completeness claim is checkable.** It covers exactly
 * the shared-namespace payload — the bytes that come out of the bundle and land
 * in a directory the target already owns. Three things are deliberately outside
 * it, and each for a reason that is not "we forgot":
 *
 *  - Everything under a **minted session id** (`<newId>.jsonl`, `<newId>/`,
 *    `file-history/<newId>/`). The id is a fresh UUID this import generated
 *    seconds earlier, so those paths are collision-free by construction and
 *    reconcile with nothing. That is the dividing line the ruling draws.
 *  - This machine's own **bookkeeping** — `history.jsonl` and the sync-state
 *    file. Neither carries a bundle-chosen byte at a bundle-chosen name; they
 *    record what the import did.
 *  - `.sesh-mover-project.json` in the target project, planted once when the
 *    project has no identity of its own. Its name is fixed and on the
 *    `NEVER_INCLUDABLE` floor, and its only bundle-derived content is a
 *    `projectId` that `isSafeSessionId` has already cleared — so a bundle
 *    cannot choose a path through it. It is disclosed in `warnings` instead.
 *
 * Within that scope the set is COMPLETE, and completeness is enforced in two
 * places rather than asserted: every branch of `reconcileSharedLayers` that
 * writes records at the same site it decides (one function, shared by the
 * preview and the run, so they cannot drift), and
 * `tests/importer.test.ts`'s filesystem-diff test compares the set against the
 * files a real import actually created.
 */
export interface WriteSet {
  /**
   * The authoritative count of paths this run WILL WRITE — and since #47 it is
   * no longer `entries.length`.
   *
   * That was written as a forward contract ("if a future payload class — a
   * workspace tree, #47 — ever truncates the enumeration, `total` must remain
   * the count of paths that will be written or the bound stops being honest"),
   * and #47 is that class: a workspace payload is routinely thousands of files,
   * so its entries are capped while this count is not. `memory` and `plans`
   * entries are never capped. A presenter that shows the first N states
   * `total - N` withheld and takes the number from HERE, never from counting a
   * list it has already cut down.
   *
   * It counts only WRITES: a layer a flag declined contributes zero, and says so
   * through its root's `applied: false` plus its own skipped count. The one root
   * whose paths are not in `entries` at all is `carry` — see
   * `WriteSetRoot.enumerated`, and note that its paths are not in `total`
   * either, which is the fact a gate has to relay rather than round off.
   */
  total: number;
  entries: WriteSetEntry[];
  roots: WriteSetRoot[];
}

/**
 * What a run did to the two **shared-namespace** auxiliary layers — `memory/`
 * (into the target project dir) and `plans/` (into the target config dir).
 * Produced by `reconcileSharedLayers` in `src/importer.ts`, which is the single
 * implementation every path shares.
 *
 * ONE DECLARATION, mixed into `ImportResult`, `MigrateResult` and
 * `HubPullResult`, for the same reason `HubPullFindings` is one declaration: an
 * import is reachable through three commands, and a hand-written second copy of
 * these fields on one of them is exactly how a field ends up readable on `import`
 * and absent on `pull` — which is what it did (#59 item 3), and what #49 was
 * before it. A field added here reaches all three shapes with no edit.
 *
 * **Warnings are not a substitute for these fields.** `pull` and `migrate` both
 * folded the importer's `warnings` into their own and stopped there, so the
 * skill layer got the sentence "…saved theirs as notes.incoming.md…" and no
 * machine-readable path to act on. `commands/import.md` branches on the typed
 * fields and uses the warning only for wording; `commands/pull.md` and
 * `commands/migrate.md` now do the same.
 */
export interface SharedLayerFindings {
  /**
   * Prose memory files that differ on both sides. Never `MEMORY.md` — the index
   * is unioned, so it is reported in `memoryIndex` instead.
   */
  memoryConflicts?: MemoryConflict[];
  memoryIndex?: MemoryIndexReport;
  /**
   * Absolute path of the target project's memory directory, present whenever
   * the bundle carried a `memory/` layer **and the run applied it** — a
   * `--no-memory` run reports `memorySkipped` and no directory, because there
   * is no directory it wrote to. Every `filename`/`parkedAs` above is
   * relative to it. It is reported rather than left to be derived because
   * deriving it means re-implementing `encodeProjectPath` in markdown — a
   * second copy of an encoding whose own module refuses to invert it.
   */
  memoryDir?: string;
  /**
   * Plans that differ on both sides. Reported only: a plan is a document with
   * no index and no union, and `plans/` is config-dir-global, so nothing is
   * written beside it. The local plan is kept and the incoming one stays in the
   * bundle.
   *
   * Only ever populated when the plans layer was applied at all — see
   * `plansSkipped`.
   */
  planConflicts?: AuxiliaryConflict[];
  /**
   * How many plan files the bundle carried that were **not written**, because
   * `--include-plans` was not passed. Present only when the bundle had some.
   *
   * The plans layer is opt-in on the receive side for the reason CLAUDE.md
   * already gives for keeping it off the hub: `<configDir>/plans` is
   * config-dir-global with no project filter, so applying it writes files every
   * project on this machine shares, on the say-so of a bundle. `memory/` lands
   * in the target project's own directory and stays default-on.
   *
   * A count and not a boolean, because the number is the disclosure: "this
   * bundle wanted to write 14 files into a shared directory" is a different
   * sentence from "it wanted to write 1".
   *
   * REACH, and it is narrower than the "one declaration" note above promises:
   * declaring a field here gives all three shapes the TYPE, not the value. The
   * two projections that build a `MigrateResult` (`migrator.ts`) and a
   * `HubPullResult` (`hub/pull-apply-state.ts`'s `sharedLayerFindings`) are
   * hand-written field lists, so this one is populated on `import` only. That
   * is currently harmless — a pull never writes plans and `plans/` never
   * reaches the hub — and the accompanying warning does cross both, but the
   * field does not follow the type until those two lists name it.
   */
  plansSkipped?: number;
  /**
   * How many memory files the bundle carried that were **not written**, because
   * `--no-memory` was passed. Present only when the bundle had some.
   *
   * The polarity is the opposite of `plansSkipped`'s and the asymmetry is the
   * recorded decision (#36): `memory/` lands in the target PROJECT's own
   * directory, is add-only, and parks rather than overwrites — and it is the
   * layer a future session reads prose out of, so it keeps arriving by default.
   * What it gained is an off switch the CLI honors, not a gate. Same REACH
   * caveat as `plansSkipped`: populated on `import` only.
   */
  memorySkipped?: number;
  /**
   * Every path this run writes outside a minted session id (#36).
   *
   * **Always present on `import`, including when it is empty** — deliberately
   * NOT subject to `sharedFindings`'s empty-is-absent rule. This field is a
   * consent gate's input, and "nothing lands outside the session" has to be a
   * statement the caller can read rather than an absence it has to interpret;
   * an omitted write set and an empty one are the same JSON otherwise. Same
   * REACH caveat as `plansSkipped`: the two hand-written projections
   * (`migrator.ts`, `hub/pull-apply-state.ts`) do not forward it, so `migrate`
   * and `pull` get the type and not the value. Neither has a confirm gate to
   * feed — a pull runs unattended from a hook — so that is a scope line, not an
   * oversight; forwarding it means concatenating one set per bundle in the
   * chain.
   */
  writeSet?: WriteSet;
}

/**
 * What a run did to the two **file payloads** a bundle can carry — the
 * whole-project `workspace/` snapshot and the git-diff `carry/` (#47).
 *
 * Deliberately the SAME field names `HubPullResult` uses, because a bundle is a
 * bundle regardless of which transport delivered it: a caller that already knows
 * how to read a pulled payload reads an imported one with no new branch.
 *
 * One declaration, mixed into `ImportResult` and `DryRunResult`, for the reason
 * `SharedLayerFindings` states — a hand-written second copy on one of them is
 * how a field ends up readable on the real run and absent from the preview,
 * which for a consent gate is the half that matters.
 */
export interface PayloadFindings {
  /**
   * The workspace payload was unpacked, and where. Absent when the bundle
   * carried none, when `--apply-workspace` was not passed, or on a dry run —
   * a preview reports `writeSet`, not an outcome.
   */
  workspaceUnpacked?: { path: string; fileCount: number };
  /**
   * Paths in the workspace payload the `NEVER_INCLUDABLE` floor refused. Nothing
   * from them was written. Never an accusation: a bundle from an older
   * sesh-mover on a case-insensitive filesystem legitimately carried a `.GIT`.
   */
  workspaceRefused?: string[];
  /** The manifest declared a workspace payload the bundle does not contain. */
  workspaceDeclaredMissing?: boolean;
  /**
   * Project files the bundle carries that were **not written**, because
   * `--apply-workspace` was not passed. A count and not a boolean, for the
   * reason `plansSkipped` is: "this bundle wanted to write 1,412 files into your
   * project" is a different sentence from "it wanted to write 3".
   */
  workspaceSkipped?: number;
  /**
   * The uncommitted work the bundle DECLARES, whether or not it was applied.
   * Present on a decline too — it is the sender's claim, read from the manifest.
   */
  carryAvailable?: CarryMeta;
  /**
   * What became of it. Present only when `--apply-carry` was passed AND the
   * bundle contained the payload: absent the flag, an import writes nothing at
   * all — not even the saved copy a `hub pull` parks, because unlike a pull the
   * bundle is a file the user still has and can re-import.
   */
  carryApplied?: ApplyResult;
}

export interface ImportResult extends SharedLayerFindings, PayloadFindings {
  success: true;
  command: "import";
  dryRun?: false;
  importedSessions: Array<{
    originalId: string;
    newId: string;
    slug: string;
    messageCount: number;
  }>;
  skippedSessions: Array<{
    originalId: string;
    reason: "duplicate" | "already-received";
  }>;
  warnings: string[];
  resumable: boolean;
  versionAdaptations?: string[];
}

export interface DryRunResult extends PayloadFindings {
  success: true;
  command: "import";
  dryRun: true;
  importedSessions: ImportResult["importedSessions"];
  skippedSessions: ImportResult["skippedSessions"];
  warnings: string[];
  resumable: boolean;
  rewriteReport?: RewriteReport;
  versionAdaptations?: string[];
  /** What the memory step would do, computed by the function that does it. */
  memoryPlan?: MemoryPlanEntry[];
  memoryDir?: string;
  planConflicts?: AuxiliaryConflict[];
  /** Plans the bundle carries that the real run would not write. Same rule. */
  plansSkipped?: number;
  /** Memory files the bundle carries that `--no-memory` declined. Same rule. */
  memorySkipped?: number;
  /**
   * What the real run would write outside a minted session id — the answer to
   * the question `commands/import.md`'s confirm gate asks, computed BEFORE any
   * byte is written. Same function as the real run, in plan mode, so the two
   * cannot drift; `tests/importer.test.ts` pins that they are equal.
   */
  writeSet?: WriteSet;
}

export interface MigrateResult extends SharedLayerFindings {
  success: true;
  command: "migrate";
  /**
   * Present and `true` only for `--dry-run`. It is the tense marker for the
   * whole object: on a preview, `cleanedUp` and `directoryRenamed` describe
   * what the real run WOULD do, not what happened (nothing happened).
   *
   * Without it those two booleans are ambiguous between prediction and fact,
   * which is exactly how the preview came to under-report the `--rename-dir`
   * `mv` — it reported the plan's most destructive step as `false` because
   * `false` was true-as-a-fact. Absent on a real run.
   */
  dryRun?: true;
  importedSessions: ImportResult["importedSessions"];
  skippedSessions: Array<{
    originalId: string;
    reason: "duplicate" | "already-received";
  }>;
  /**
   * Real run: source session files were deleted. Dry run: they would be — for
   * every id in `importedSessions[].originalId` and `skippedSessions[]`.
   */
  cleanedUp: boolean;
  /**
   * Real run: the project directory was `mv`-ed from `sourcePath` to
   * `targetPath`. Dry run: it would be. False whenever `--rename-dir` was not
   * passed, the paths are identical, the source is missing, or the target
   * already exists — the last three each carry an explaining `warnings` entry.
   */
  directoryRenamed: boolean;
  sourcePath: string;
  targetPath: string;
  /**
   * Dry run only: what the memory step WOULD do, computed by the same function
   * that does it. The mixed-in `memoryConflicts`/`memoryIndex` describe writes
   * that happened, so they are absent on a preview and this is what stands in
   * for them — the same split `DryRunResult` makes for a plain import.
   */
  memoryPlan?: MemoryPlanEntry[];
  warnings: string[];
}

export interface BrowseResult {
  success: true;
  command: "browse";
  exports: Array<{
    name: string;
    path: string;
    // An entry whose manifest could not be read reports null for every
    // manifest-derived field rather than a fabricated value (the browsing
    // machine's platform, "", 0). `metadataAvailable` says which case it is.
    // True of ARCHIVES and of DIRECTORY exports found in a `.sesh-mover` store
    // dir alike (#33) — the row shape is identical, so no consumer has to know
    // which kind it got. The one asymmetry is upstream of this shape and stays
    // there: a directory in the project root whose manifest won't read is not
    // listed at all, because reading it is the only test of whether it was
    // ever an export. See `cwdDirectoryBrowseEntry` in cli.ts.
    exportedAt: string | null;
    sourcePlatform: Platform | null;
    sourceProjectPath: string | null;
    sessionCount: number | null;
    sessions: SessionManifest[]; // [] when unavailable
    storage: StorageScope;
    metadataAvailable: boolean;
    metadataError?: string; // set iff metadataAvailable is false
    /**
     * Whether the bundle carries a file payload an import could write into the
     * project — `workspace/` and `carry/` respectively (#47).
     *
     * **`null` follows the same rule as the four fields above: it means NOT
     * READ, never "no payload".** `false` on a bundle whose manifest could not
     * be parsed would be the dangerous direction of lie — it says "importing
     * this cannot write to your project" about a bundle nobody checked. A
     * caller deciding whether to warn must treat `null` as unknown.
     *
     * Both are read from the manifest `browse` already parsed for the fields
     * above; neither costs a second look inside the archive, which matters
     * because reading a `.tar.zst` manifest decompresses the whole bundle
     * (#32).
     */
    hasWorkspace: boolean | null;
    hasCarry: boolean | null;
  }>;
}

export interface ConfigureResult {
  success: true;
  command: "configure";
  config: SeshMoverConfig;
  scope: StorageScope;
  message: string;
}

export interface ErrorResult {
  success: false;
  command: string;
  error: string;
  details?: string;
  suggestion?: string;
  /**
   * Disclosures collected BEFORE the failure, present only when there are any.
   *
   * A failure is not a reason to withhold what already happened. `hub pull`
   * applies bundles one at a time and accumulates a disclosure per bundle; when
   * bundle 3 aborts, bundles 0-2 are on disk, recorded as received, and will
   * never be offered again — so a result that reports only the abort is not
   * merely terse, it is **untruthful about what this command did**. That is the
   * invariant the failure contract puts first: truthfulness, with completeness
   * best-effort.
   *
   * Absent, never `[]`, when nothing was collected — so a reader can tell "this
   * command disclosed nothing" from "this command had nothing to disclose"
   * without either being a lie.
   */
  warnings?: string[];
}

// --- Hub ---

export interface HubInitResult {
  success: true;
  command: "hub-init";
  hubPath: string;
  hubId: string;
  created: boolean; // false when joining an existing hub
  machineRegistered: true;
  configScope: StorageScope;
}

/**
 * What this machine can see at the configured `hub.path`, as one answer shared
 * by every verb that asks (`src/hub/preflight.ts`'s `probeHubReachable`).
 *
 * The failing members are the ones `HubUnreachableResult` is built from — they
 * are declared here rather than there so that the diagnostic verbs, which
 * report the state instead of refusing on it, cannot drift into a second,
 * differently-spelled opinion about what "reachable" means. `hub status` saying
 * `reachable: true` for a directory `push` refuses as `not-a-hub` is exactly the
 * disagreement this type exists to make impossible.
 *
 * **`unresponsive` is a third condition, not a shade of the other two (#71),**
 * and folding it into either would be a confident wrong diagnosis. The path IS
 * there and it may well be a perfectly good hub; the filesystem underneath it
 * has stopped answering — a hard-mounted NFS/CIFS share whose server is gone, a
 * FUSE mount whose daemon died. `no-directory` would send the user to check
 * that the share is mounted, which it is; `not-a-hub` would send them to check
 * `hub.path`, which is fine. Neither remedy applies: nothing the user can edit
 * fixes it, and the honest instruction is to unstick or unmount the filesystem.
 * It is also the only one of the three whose *detection* costs wall-clock time
 * (`HUB_IO_TIMEOUT_MS`), because it is defined by a syscall that never returned.
 */
export type HubReachabilityState = "ok" | "no-directory" | "not-a-hub" | "unresponsive";

export interface HubStatusResult {
  success: true;
  command: "hub-status";
  hubPath: string | null;
  /**
   * `hubState === "ok"`, restated as the boolean this result has always carried.
   *
   * It is derived rather than computed separately on purpose: it used to mean
   * "hub.json exists and parsed", which said `true` for a `hub.json` carrying no
   * `hubId` — a file push and pull refuse outright. The two now answer from one
   * probe.
   */
  reachable: boolean;
  /**
   * WHICH of the states above, so a caller can tell an unmounted share from a
   * directory that is not a hub without reading `warnings` — the same enum, and
   * the same distinction of remedy, that `HubUnreachableResult.hubState` carries
   * for the verbs that refuse.
   *
   * `null` — and ONLY then — when `hubPath` is null: no hub is configured, so
   * the question was never asked. That is a different fact from "asked and could
   * not see it", and collapsing it into `no-directory` would send a user who has
   * simply never run `hub init` to check whether a share is mounted.
   *
   * `hub status` is also the one place the configured path IS reported
   * (`hubPath`): the refusals withhold it deliberately, and this is the command
   * they point at instead.
   */
  hubState: HubReachabilityState | null;
  hubId: string | null;
  machineRegistered: boolean;
  machinesKnown: number;
  project: { linked: boolean; projectId: string | null };
  /**
   * What the last SessionEnd auto-push for THIS project reported — the only
   * place its output survives, since that hook's stdout is closed and its
   * stderr is invisible at a clean exit. Absent when no auto-push has run here
   * (or when this project's sync-state predates the field).
   *
   * `notes` are that push's own warnings verbatim (capped), which is where the
   * carry disclosures live: gitignored-but-TRACKED files whose contents rode
   * the patch off this machine, and `.sesh-mover-include` paths that were re-included.
   * On a failed push it is the error instead.
   */
  lastAutoPush?: { at: string; ok: boolean; notes: string[]; noteCount: number };
  /**
   * The last time another process took this project's lock away from a holder
   * (#84), or absent if that has never happened here.
   *
   * It is reported by `status` and nowhere else for a specific reason: the two
   * parties to a steal are both badly placed to tell anyone. The thief's own
   * warning rides on whatever verb it was running — a SessionEnd auto-push has
   * closed stdout and an invisible stderr — and the victim, by definition, no
   * longer holds the lock `recordAutoPushOutcome` re-takes to write its
   * breadcrumb, so its note is dropped in exactly the case worth recording.
   * `status` holds no lock and is the verb a user runs when something looks
   * wrong, which makes it the one place this can be read.
   *
   * `noticedByHolderAt` absent means the victim has not unwound yet — or never
   * will, which is itself the interesting answer.
   */
  lastLockSteal?: LockStealRecord;
  warnings: string[];
}

export interface HubPushResult {
  success: true;
  command: "push";
  projectId: string;
  bundleId: string | null; // null when nothing to push
  pushedSessions: Array<{ threadId: string; sessionId: string; type: "full" | "continuation" }>;
  upToDate: boolean;
  hasWorkspace: boolean;
  warnings: string[];
  /**
   * Discovery aid (design §6.0): gitignored paths that this push did NOT carry,
   * as `git` spelled them (a trailing "/" means the whole directory), capped at
   * 10 — a sample to recognize, not an inventory.
   *
   * Present only on a MANUAL push of a project with a git remote that has no
   * `.sesh-mover-include` yet. Absent otherwise, and never emitted by
   * the auto-push hook, whose contract is silence at session exit. Each entry
   * is a valid `.sesh-mover-include` pattern for exactly the thing it names, which is
   * why they are reported as git gives them rather than summarized up to their
   * top-level directory: re-include is the permissive direction, so a broader
   * spelling would carry more than the user pointed at.
   */
  ignoredNotCarried?: string[];
  /**
   * The uncommitted work this push carried (design §6.1), or absent when it
   * carried none.
   *
   * Two separate disclosures, both also surfaced as warnings, and deliberately
   * not merged — they have different causes and different remedies:
   * `reIncluded` names gitignored UNTRACKED paths that travelled only because
   * `.sesh-mover-include` lists them (remedy: edit `.sesh-mover-include`), while `trackedIgnored`
   * names gitignored paths that git TRACKS, whose changes the patch carries
   * because no carry rule filters the patch at all (remedy: `git rm --cached`,
   * or `--no-carry`).
   */
  carry?: CarryMeta;
  /**
   * Present **iff** this push ran with `--full` and got as far as the ledger —
   * the recovery escape hatch for a hub that can no longer serve what it is
   * recorded as holding (bundles deleted; later, bundles encrypted to a lost
   * key). Absent on every ordinary push, so its presence alone is the signal
   * that this run re-sent whole sessions rather than deltas.
   *
   * It reports what was FORGOTTEN, not what was sent: `pushedSessions` already
   * says what travelled, and the two differ in the case worth seeing — a
   * session the hub was never credited with is pushed whole either way and is
   * not counted here. So `forgottenSessions` is exactly the number of deltas
   * this run turned into full bundles.
   *
   * `forgottenMemoryDigest` is the same question for the `memory/` layer, which
   * has no delta form: its ledger is one digest per peer, so a `--full` push
   * scoped to specific `--session-id`s leaves it alone and reports `false`.
   */
  fullResend?: {
    forgottenSessions: number;
    forgottenMemoryDigest: boolean;
  };
}

/**
 * A push that threw AFTER the point where it could have linked this project.
 * Structurally an `ErrorResult` (`success: false`, `command: "push"`, `error`,
 * optional `details`/`suggestion`) with the link state added as FIELDS.
 *
 * The fields are the point. What the user has to be told is not in the
 * exception and never was — whether this directory is linked *right now*,
 * because a link is the consent gate for the default-on SessionEnd auto-push,
 * and for a git-less project that push uploads the whole working tree. Until
 * this shape existed that fact lived only as English prose inside `details`,
 * and `recordAutoPushOutcome` (cli.ts) — the ONLY reader an unattended
 * session-end push has — records `error` and `suggestion` and never looks at
 * `details`. So the one push nobody watches was also the one that lost the
 * disclosure entirely. Branch on the fields; treat `details` as prose.
 *
 * `reason` says "failed-after-link" for every failure past the identity
 * decision, including the ones where no link was written at all (`linked:
 * false`, `linkRolledBack: false`): the discriminator marks the phase, and
 * `linked` — not the reason string — answers the question about state.
 */
export interface HubPushFailedResult {
  success: false;
  command: "push";
  reason: "failed-after-link";
  error: string;
  details?: string;
  suggestion?: string;
  /** TRUE = this directory is linked RIGHT NOW, so SessionEnd auto-push is armed. */
  linked: boolean;
  /** The hub project the link names (or would have named). */
  projectId: string;
  /** This push made the link and removed it again. */
  linkRolledBack: boolean;
  /**
   * A hub project this push minted that nothing removes — retry with
   * `--project-id <it>` rather than minting a second. Null when this push
   * created none.
   */
  orphanHubProjectId: string | null;
  /** Bundle reached the hub but no index references it. */
  orphanBundle: boolean;
}

/**
 * One machine's bundles for a thread that a pull resolving to some OTHER
 * machine cannot fetch — the reported shape of `findUnfetchableBundles`
 * (hub/threads.ts), with the hub's display name for the machine attached.
 *
 * Its presence means part of a thread's history is on a machine this pull did
 * not read the bundle list of, and no flag reaches it: a pull fetches exactly
 * one machine's list, and each machine's index lists only its own pushes.
 * Callers must report that plainly and must NOT offer a flag or a re-run —
 * there is none, and a warning whose stated remedy silently does nothing is
 * this milestone's own defect class.
 */
export interface UnfetchableBundleGroup {
  machineId: string;
  /** null when the hub has no readable `machines/<id>.json` record. */
  machineName: string | null;
  bundleIds: string[];
}

export interface WhereisThread {
  threadId: string;
  slug: string;
  summary: string;
  latest: { machineId: string; machineName: string | null; lastActiveAt: string; messageCount: number };
  copies: Array<{
    machineId: string;
    machineName: string | null;
    localSessionId: string;
    lastActiveAt: string;
    messageCount: number;
    headEntryUuid: string;
  }>;
  localCopy: { localSessionId: string; headEntryUuid: string; current: boolean } | null;
  /**
   * Would a pull of this thread fetch a bundle that has never arrived here?
   *
   * The pull's OWN selector answers it (`pullSourceFor`), so `whereis`, `pull
   * --latest` and `pull --thread <id>` cannot disagree about it — they did
   * until #44, when this field was head equality (`latest is on another machine
   * AND (no local copy or local head != latest head)`) and the pull was
   * receipts. A head can arrive by a route that recorded no bundle, so the two
   * come apart in both directions: this is true on a thread whose
   * `localCopy.current` is also true, and false on a thread whose `latest` is
   * another machine.
   */
  pullNeeded: boolean;
  /**
   * Set when at least one machine other than this one and the latest copy's
   * lists bundles for this thread that a pull cannot fetch. Absent on every
   * ordinary thread.
   *
   * Read it BEFORE `localCopy.current` and `pullNeeded`: when it is present,
   * both of those describe only the half of the thread this machine can see.
   * `current: true` alongside it means "level with the copy a pull would
   * resolve to", NOT "holds the whole conversation".
   */
  unfetchableBundles?: UnfetchableBundleGroup[];
}

export interface WhereisResult {
  success: true;
  command: "whereis";
  linked: boolean;
  projectId: string | null;
  linkCandidates?: Array<{ projectId: string; name: string; gitRemotes: string[] }>;
  threads: WhereisThread[];
  /**
   * Could this machine read the hub at all?
   *
   * **A field on a `success: true` result rather than a refusal, deliberately**
   * — the precedent is this command's own `linked: false`, which reports an
   * unresolved identity in the normal shape because `whereis` is a read (see
   * `HubUnlinkedResult`). An unreachable hub is the same kind of fact and gets
   * the same treatment; `push` and `pull` refuse on it because they were about
   * to write.
   *
   * **Read it before anything else, because it re-reads two other fields.** When
   * it is false: `threads` is `[]` meaning UNKNOWN, never "this project has no
   * threads on the hub"; `linked` is a purely local fact (the presence of
   * `.sesh-mover-project.json`) that says nothing about whether the hub still
   * has that project; and `linkCandidates` is ABSENT rather than empty, because
   * an empty pick list is documented to mean "the hub lists no projects" and the
   * projects listing is exactly what could not be read.
   *
   * Until this field existed all three of those read as confident answers: an
   * unmounted share produced `linked: true, threads: []` — identical to a linked
   * project nobody has ever pushed — with nothing to tell the two apart.
   */
  reachable: boolean;
  /** Which state `reachable` is short for; `"ok"` exactly when it is true. */
  hubState: HubReachabilityState;
  warnings: string[];
}

/**
 * A command that needs a hub project and found this directory linked to none.
 *
 * **Not to be confused with `HubUnlinkResult`** (no "ed"), which is the SUCCESS
 * result of the `hub unlink` verb — the deliberate act of removing a link.
 * This one is a refusal: nothing happened, and `linkCandidates` is the pick
 * list for linking.
 *
 * **`whereis` is deliberately NOT a member** (#29). It is a read, so an
 * unresolved identity is not a refusal for it: it reports the same pick list
 * through `WhereisResult.linked: false` + `linkCandidates` on a `success: true`
 * result, and `hubWhereis` is declared to return `WhereisResult` alone — it
 * *cannot* produce this shape. The member sat here unconstructed from the day
 * it was written, which is worse than absent: `commands/whereis.md` and the
 * skill doc both tell the caller there is no error case to catch, so a third
 * member here invited someone to write a branch that can never run. If a
 * `whereis` refusal is ever wanted, changing `WhereisResult` is the change —
 * re-adding the member alone would not produce one.
 */
export interface HubUnlinkedResult {
  success: false;
  command: "push" | "pull";
  reason: "unlinked";
  linkCandidates: Array<{ projectId: string; name: string; gitRemotes: string[] }>;
  suggestion: string;
}

/**
 * `--project-id` named a hub project the hub does not have (or whose id is not
 * path-safe). A refusal, and deliberately NOT `HubUnlinkedResult`: this
 * directory may well be linked already — only the *flag* is wrong — so
 * "unlinked" would misdescribe it and its remedy ("pick a project to link to")
 * is only half of this one's.
 *
 * Produced BEFORE the verb does any work, by the shared gate in
 * `src/hub/preflight.ts`, which is the point of it: `hub push` used to discover
 * a bad `--project-id` deep in its own identity resolution — after it had
 * registered this machine on the hub, minted a thread into local sync-state and
 * run a full export — and then throw an `ENOENT` carrying the hub's absolute
 * path out through the generic catch. A validation failure must not happen
 * after side effects.
 *
 * `linkCandidates` is the same pick list `HubUnlinkedResult` carries, so a
 * caller can offer one branch for both; it is empty (never absent) when the hub
 * itself could not be listed.
 *
 * Scope: the guarantee is the LIBRARY's, not just the CLI's. The gate was
 * CLI-level when it was introduced (#29), which left a consumer calling
 * `hubPush`/`hubPull` through `src/index.ts` still getting the throw from
 * `readHubProjectAsLocal`; #75 moved it inward so the two agree.
 *
 * Its exit class is 2, the refusal class — see `exitCodeForResult` below. It
 * exited 1 until #76, argued there as "a bad invocation, the same class as
 * `--on-divergence bogus`"; the owner's mapping moved it, and the more useful
 * line for a shell caller is that the hub was reachable, nothing was written,
 * and the body carries a pick list to correct the flag from.
 */
export interface HubNoSuchProjectResult {
  success: false;
  command: "push" | "pull";
  reason: "no-such-project";
  /** Echoed back verbatim — this is the value the user typed, not a hub value. */
  requestedProjectId: string;
  linkCandidates: Array<{ projectId: string; name: string; gitRemotes: string[] }>;
  suggestion: string;
}

/**
 * The configured hub could not be used AT ALL: nothing about it was read, so
 * push and pull refuse before touching the project, the hub or their own
 * bookkeeping (#75).
 *
 * Replaces a raw `ENOENT` that escaped both verbs through the CLI's generic
 * catch — untyped, so the skill layer had nothing to branch on while every
 * other hub failure (`unlinked`, `lock-busy`, `not-yet-synced`,
 * `no-such-project`) carried a `reason`, and carrying the hub's absolute path
 * in its message for no benefit. **Nothing here names the path**, deliberately:
 * `hub status` is where a user asks which path is configured.
 *
 * **Not `NotYetSyncedResult`, and the difference is not a shade of meaning.**
 * That one presupposes a fully readable hub — its `hub.json`, its machine
 * indexes, the thread it resolved — and reports that specific *bundle files*
 * those indexes reference have not landed on this machine's copy of a synced
 * folder yet; it can therefore list them (`missing`), and the remedy is to wait
 * for the same sync client to finish. This one is emitted when the hub itself
 * could not be read, so nothing is known about it and there is no file list to
 * give. The two can never both be true: `not-yet-synced` is only reachable
 * after this gate has passed.
 *
 * **Which verbs return it is a judgement per verb, not a rollout.** The three
 * here WRITE (push, pull) or repair by writing (`hub reindex`), so refusing is
 * what keeps the write from happening. The two diagnostic verbs deliberately do
 * NOT: `hub status` exists to answer "what state is this in", so it reports the
 * same `hubState` inside its `success: true` result, and `whereis` follows its
 * own `linked: false` precedent and does the same. `hub unlink` never asks the
 * question at all — it is the disarm path and constructs no backend.
 */
export interface HubUnreachableResult {
  success: false;
  command: "push" | "pull" | "hub-reindex" | "hub-retire" | "hub-delete";
  reason: "hub-unreachable";
  /**
   * Which of the two shapes it is — an enum rather than prose, because the
   * remedies differ and `skills/session-porter/SKILL.md` forbids branching on
   * message text.
   *
   * - `no-directory` — the configured path is not a directory this machine can
   *   stat: an unmounted share, a synced folder that has not appeared here, a
   *   path that was never right, or one it may not read.
   * - `not-a-hub` — the directory is there but carries no usable `hub.json`. A
   *   synced folder whose first sync is still in flight looks exactly like a
   *   directory that is simply not a hub, so this arm covers both.
   * - `unresponsive` — a single filesystem call against the path did not return
   *   within `HUB_IO_TIMEOUT_MS`. The mount is hung, not absent and not
   *   mis-configured; see `HubReachabilityState` for why it is its own arm.
   *

   * Spelled as the non-`ok` half of `HubReachabilityState` rather than as its
   * own pair of literals: the diagnostic verbs report the SAME probe's answer,
   * and one declaration is what stops a renamed (or third) state reaching `hub
   * status` and never reaching here.
   */
  hubState: Exclude<HubReachabilityState, "ok">;
  suggestion: string;
}

// ---------------------------------------------------------------------------
// #84 — PROJECT-LOCK STEAL DISCLOSURE. One block, two declarations, both owned
// by `src/hub/lock.ts`; nothing else writes either shape.
// ---------------------------------------------------------------------------

/**
 * What a liveness probe learned about the process recorded in a lock file.
 *
 * Three states, not a boolean, and the third is the load-bearing one: a torn
 * lock (the "wx" create and the JSON write are two syscalls, so a reader can
 * catch a live holder at zero bytes), a lock written before this field
 * existed, and a lock whose recorded hostname is not this machine all answer
 * `unknown` — and `lock.ts` treats `unknown` exactly as it treats `alive`,
 * because an unidentified holder is not evidence of an absent one.
 */
export type LockHolderLiveness = "alive" | "dead" | "unknown";

/**
 * A project lock taken from a previous holder, written to
 * `~/.sesh-mover/locks/<encoded-project>.lock.steal.json`.
 *
 * **Why a file rather than a result field.** A steal has two sides and only
 * one of them can report through the normal channels. The thief surfaces it as
 * a warning (`LockHandle.stoleStale`), which for a session-end push reaches
 * `hub status` through `lastAutoPush`. The victim has nothing: it does not
 * learn it was robbed until its own `release()`, and `recordAutoPushOutcome`
 * (cli.ts) — the only reader an unattended push has — writes its breadcrumb by
 * re-taking the very lock the thief is holding and gives up silently when it
 * is busy. So the one durable trace of a steal must not require the lock, and
 * this is it: written by the thief at steal time, stamped by the victim when
 * it finds out, readable by anyone via `readLockStealRecord`.
 */
export interface LockStealRecord {
  /** When the steal happened, on the thief's clock. Local by construction — the lock file is per-machine, never on the hub. */
  at: string;
  /**
   * Which arm of the steal rule fired. `dead-holder` is the benign one (a
   * crashed or killed process never runs its release). The other two are the
   * hard ceiling firing: a holder that was still running, or one that could
   * not be identified at all, kept its lock as long as the rule allows and
   * then lost it anyway, because refusing forever would be a silent permanent
   * outage for the project.
   */
  kind: "dead-holder" | "live-holder-past-ceiling" | "unidentified-holder-past-ceiling";
  /** The pid recorded in the stolen lock, or null when it carried none (torn write, foreign file). */
  holderPid: number | null;
  /** The hostname recorded in the stolen lock, or null. A value that is not this machine's is why `holderLiveness` can be `unknown`. */
  holderHost: string | null;
  /** The stolen lock's per-acquisition token — how the victim recognizes ITS loss rather than an older one. */
  holderToken: string | null;
  holderLiveness: LockHolderLiveness;
  /** Age of the stolen lock at steal time. Seconds, because minutes-scale is all this is ever read at. */
  holderAgeSeconds: number;
  stolenByPid: number;
  /** Stamped by the victim when its `release()` discovers the loss. Absent means it has not unwound yet — or never will. */
  noticedByHolderAt?: string;
}

// ---------------------------------------------------------------------------
// end #84 block
// ---------------------------------------------------------------------------

export interface HubLockBusyResult {
  success: false;
  command: "push" | "pull" | "hub-unlink" | "hub-reindex" | "hub-retire" | "hub-delete";
  reason: "lock-busy";
  holderPid: number | null;
  ageSeconds: number | null;
  /**
   * The lock error's own message (which pid, how old). Set by `hub unlink`,
   * whose refusal a HUMAN reads while deciding whether to wait or to `--force`
   * past it, and by `hub reindex`, which is a manual repair verb read the same
   * way; push and pull leave it absent, because for them a busy lock means
   * another operation is already doing the work and the caller is told to
   * retry, not to adjudicate.
   */
  error?: string;
  suggestion: string;
}

/**
 * A link in a thread's assembled history naming an entry no bundle on the hub
 * carries — something between two bundles is genuinely missing.
 *
 * Deliberately NOT the same condition as `HubPullUnplaceableBundle`: a gap is a
 * bundle that says which entry it continues and names one nobody ships, while an
 * unplaceable bundle never said. Only the first can be repaired by finding
 * something (spec §0b).
 */
export interface HubPullChainGap {
  /**
   * The entry the stranded bundle declares itself a continuation of. `""` is
   * one of them — an empty uuid can never match a head, so a bundle carrying it
   * is stranded exactly as if its predecessor were missing.
   */
  anchorEntryUuid: string;
  machineId: string;
  /** null when the hub has no readable `machines/<id>.json` record. */
  machineName: string | null;
  /** The bundle at the boundary: the first one the walk could not place. */
  bundleId: string;
  /** That bundle and every bundle chaining onto it — what this gap strands. */
  strandedBundleIds: string[];
}

/**
 * A branch of a forked thread this pull did not follow. Nothing is lost: it is
 * still on the hub, and this pull applied the other side of the fork.
 */
export interface HubPullParkedBranch {
  /** The entry both branches continue. Never `""` — that is a gap, not a fork. */
  anchorEntryUuid: string;
  /** The branch this pull DID follow, by its first bundle id. */
  followedBundleId: string;
  machineId: string;
  machineName: string | null;
  /** This branch's first bundle. */
  bundleId: string;
  /** That bundle and everything reachable from it. */
  bundleIds: string[];
}

/** A bundle that cannot be placed in a thread's history at all. */
export interface HubPullUnplaceableBundle {
  machineId: string;
  machineName: string | null;
  bundleId: string;
  /**
   * `true` — pushed before sesh-mover recorded which entry a continuation
   * chains onto, so the link was never written. That bundle is **not missing**,
   * and the machine still holding that session re-links it the next time it
   * pushes. `false` — the index declares a continuation of nothing, which no
   * sesh-mover push can produce: a damaged or hand-edited index.
   */
  preAssembly: boolean;
}

/**
 * A starting point of this thread that the pull did not walk. More than one
 * starting point is ORDINARY rather than damage — a session that was compacted,
 * truncated or rolled back is re-pushed whole under the same thread id — and two
 * of them can never be joined, because a compaction rewrites the very entry
 * uuids a link would need.
 */
export interface HubPullUnwalkedRoot {
  machineId: string;
  machineName: string | null;
  /** The root bundle itself. */
  bundleId: string;
  /** That bundle and everything reachable from it. */
  bundleIds: string[];
}

/**
 * A machine whose index advertises a thread head no bundle record ships — it has
 * work it never pushed.
 *
 * Not a fetch failure: that work is not on the hub at all, so no pull of any
 * kind reaches it. It arrives once that machine pushes, which its SessionEnd
 * auto-push does by default. Present only on a pull that applied nothing, where
 * it is frequently the entire answer to "why"; on a pull that applied something
 * it would be noise about another machine's local state.
 */
export interface HubPullAdvertisedHead {
  machineId: string;
  machineName: string | null;
  headEntryUuid: string;
}

/**
 * The chain-assembly disclosures a pull may attach to its result: what it worked
 * out about a thread's history that it could not deliver. Every field is
 * optional and absent on an ordinary pull, so "nothing to disclose" is the empty
 * object rather than a flag.
 *
 * ONE DECLARATION, mixed into `HubPullResult` below and carried verbatim by the
 * select stage's two applying-something/applied-nothing outcomes
 * (`SelectStageResult.findings` and `SelectReport.findings`, hub/pull-select.ts),
 * which `hubPull` spreads into the result unchanged. A disclosure added here
 * therefore reaches the ordinary pull and the applied-nothing report at the same
 * moment; a second, hand-written copy on the stage side is exactly how a finding
 * ends up reportable on one path and silently dropped on the other.
 *
 * THE PRESENCE RULE, and it is what makes these fields a contract rather than a
 * dump: **a field is present exactly when the warning that describes it was
 * emitted.** The two are computed together in `describeAssembly` for that reason
 * — a field with no sentence leaves a caller guessing at what it means, and a
 * sentence with no field forces the skill layer to branch on wording, which this
 * file's other docs spend a lot of words forbidding.
 */
export interface HubPullFindings {
  /**
   * Bundles for this thread that this pull did not fetch because the assembled
   * chain does not reach them. Absent on every ordinary pull — see
   * `UnfetchableBundleGroup` and, for the reasoning, `findUnfetchableBundles` in
   * hub/threads.ts.
   *
   * It names the MACHINES; which condition put those bundles out of reach is
   * one of the four fields below, and both are always emitted together. A field
   * rather than warning prose because the skill layer has to branch on it:
   * everything else this result reports (`importedSessions`, `appended`, an
   * empty `warnings`) describes a pull that succeeded, and it did — it just did
   * not deliver the whole thread. Warning text is not an interface (see
   * `commands/pull.md`).
   */
  unfetchableBundles?: UnfetchableBundleGroup[];
  /** Links naming an entry no bundle on the hub carries. */
  chainGaps?: HubPullChainGap[];
  /** Branches of a forked thread this pull did not follow. */
  parkedBranches?: HubPullParkedBranch[];
  /** Bundles that can be placed in no chain at all. */
  unplaceableBundles?: HubPullUnplaceableBundle[];
  /** Starting points of this thread this pull did not walk. */
  unwalkedRoots?: HubPullUnwalkedRoot[];
  /** Machines advertising a thread head they never pushed. */
  advertisedUnshipped?: HubPullAdvertisedHead[];
}

/**
 * Why a pull applied nothing, on the one exit where applying nothing is the
 * whole and correct answer rather than a failure. See `HubPullResult`'s
 * `nothingToApply`.
 */
export interface HubPullNothingToApply {
  /**
   * One or more sentences: what was worked out about this thread, and why none
   * of it needed applying. Never empty — an exit with nothing to say is the
   * ordinary "nothing to pull" refusal, not this.
   *
   * Prose, so it is deliberately not an interface. Anything a caller must
   * branch on belongs in `HubPullFindings` instead (see `commands/pull.md` on
   * why warning text is not a contract).
   */
  reason: string;
}

/**
 * `HubPullResult` mixes in `SharedLayerFindings` as well as `HubPullFindings`.
 *
 * A pull applies a CHAIN of bundles, each through its own `importSession` call,
 * all of them into the SAME memory directory — so the shared-layer fields are
 * **aggregated across the chain, not reported per session**. That is not a
 * convenience: `memory/` and `plans/` are not session-scoped at all (they are
 * project- and config-dir-scoped), so "per session" is a category error, and a
 * pull of five bundles that each park a memory file must report five parked
 * paths rather than the last one. The aggregation and its dedup rules live in
 * `hub/pull-apply-state.ts` (`recordSharedLayers` / `sharedLayerFindings`).
 */
export interface HubPullResult extends HubPullFindings, SharedLayerFindings {
  success: true;
  command: "pull";
  threadId: string;
  sourceMachineId: string;
  importedSessions: ImportResult["importedSessions"];
  skippedSessions: ImportResult["skippedSessions"];
  // The thread's local session after pull. null when every bundle was
  // skipped as a duplicate AND the existing local copy could not be
  // identified through peer bookkeeping or the imported-hash registry —
  // in that case no thread mapping is written (a future push re-maps it).
  localSessionId: string | null;
  workspaceUnpacked: { path: string; fileCount: number } | null;
  /**
   * Per-file outcome when the workspace payload was applied as a 3-way merge
   * against this machine's last synced generation (design §5.2-5.5), rather
   * than unpacked. Absent whenever no merge ran — including the bootstrap
   * unpack into an empty tree and every no-ancestor fallback — so its presence
   * is precisely "a merge happened, here is what it decided".
   *
   * `workspaceUnpacked` is set alongside it (the payload WAS applied, at that
   * path); this field is the detail.
   */
  workspaceMerge?: WorkspaceMergeReport;
  /**
   * Paths the workspace payload carried that can NEVER be applied, whatever a
   * pattern says — `.git` and `.sesh-mover` at any depth and in any
   * casing (see `NEVER_INCLUDABLE`). Absent on every ordinary pull.
   *
   * It is a result FIELD rather than warning prose because a skill layer has to
   * be able to branch on it: a payload naming `.sesh-mover-include`
   * is trying to rewrite the list that decides what this machine's NEXT push
   * ships, which is the strongest signal this command produces, and warning
   * text is not an interface (see `commands/pull.md`). Nothing from these paths
   * was written; a directory entry stands for everything under it, which was
   * never opened.
   *
   * Its presence is not by itself proof of an attack — a sesh-mover older than
   * the guard, on a case-insensitive filesystem, legitimately shipped a `.GIT`
   * store — so callers must report it without naming a culprit.
   */
  workspaceRefused?: string[];
  /**
   * `true` when a bundle's manifest declared a workspace payload the bundle
   * does not actually contain, so there was nothing to apply and the project
   * directory was left untouched. Absent otherwise.
   *
   * A field rather than warning prose for the usual reason (warning text is not
   * an interface — see `commands/pull.md`), and here it is the ONLY signal:
   * `workspaceUnpacked` is `null` and `workspaceMerge` is absent in this case
   * exactly as they are for the routine "no shared generation, so the payload
   * was skipped" branch, whose remedies (`--force-workspace`,
   * `--target-path <fresh-dir>`) can do nothing for a payload that is not in
   * the bundle. It is the workspace counterpart of `carryAvailable` present
   * with `carryApplied` absent.
   */
  workspaceDeclaredMissing?: boolean;
  /**
   * The uncommitted work this pull's bundle chain carried (design §6.2), as the
   * SENDING machine described it. Present whenever a bundle declared a carry,
   * whether or not it was applied — `carryApplied` says what happened to it.
   */
  carryAvailable?: CarryMeta;
  /**
   * What became of that payload. Always present alongside `carryAvailable`
   * (except when the bundle declared a carry it did not actually contain):
   * `applied: true` means the working tree was changed, and every other shape
   * carries a `reason` plus the `savedTo` directory holding the payload and its
   * manual steps.
   *
   * A field rather than warning prose because there is a real decision behind
   * it — `reason: "not-requested"` is the routine "you did not pass
   * --apply-carry", while `"unsafe-payload"` means a bundle tried to write
   * `.sesh-mover` or a symbolic link — and warning text is not an
   * interface (see `commands/pull.md`).
   */
  carryApplied?: ApplyResult;
  // Continuations spliced onto an existing local session rather than landing
  // as a new fragment. Absent when nothing was appended. These sessions are
  // NOT in importedSessions — no new session was created.
  appended?: Array<{ threadId: string; baseSessionId: string; entriesAppended: number }>;
  // Present when a thread was extended on BOTH sides of the same anchor.
  // Absent on an ordinary pull — its presence is the signal that the user was
  // asked (or defaulted) into a choice.
  divergence?: HubPullDivergence;
  /**
   * Present exactly when this pull resolved a thread, worked out that there was
   * nothing left to fetch for it, and therefore applied nothing — and that is
   * the complete, correct answer rather than a failure. Alongside it,
   * `importedSessions`/`skippedSessions`/`appended` are empty and
   * `localSessionId` is null, because this run landed nothing and so wrote no
   * thread mapping.
   *
   * WHY IT IS A SUCCESS FIELD AND NOT AN ERROR. The pull's failure contract is
   * apply-safe-and-name-the-gap: truthfulness is the invariant, completeness is
   * best-effort. "Here is this thread's history, here is the part of it I cannot
   * reach, and I correctly changed nothing" satisfies both. Returning it as
   * `success: false` is the nag loop the disclosure fields exist to break, one
   * branch later — an error tells the caller to try again, and every try says
   * the same thing forever.
   *
   * NOT TO BE CONFUSED with `pull-record.ts`'s local `appliedNothing`, which
   * asks a different question of a pull that DID fetch a chain (did any of its
   * bundles land?) and is true on the divergence-skip path, where this field is
   * absent.
   */
  nothingToApply?: HubPullNothingToApply;
  warnings: string[];
}

export interface HubPullDivergence {
  threadId: string;
  /** The last entry both branches share; "" when the bundle carries none. */
  anchorUuid: string;
  /** The local session that diverged — the one the numbers below describe. */
  localSessionId: string;
  localHeadUuid: string;
  /** 0 when the anchor isn't in the local base (nothing to measure from). */
  localEntriesSinceAnchor: number;
  localLastActiveAt: string;
  hubHeadUuid: string;
  hubEntriesSinceAnchor: number;
  hubLastActiveAt: string;
  /**
   * False when the anchor is absent from the local session (compacted or
   * unrelated history) — `adopt-hub` is then refused and falls back to
   * `fragment`, because there is no point to cut the local branch at.
   */
  adoptAvailable: boolean;
  /** What actually happened, which is not always what was asked for. */
  resolution: OnDivergenceMode;
  /**
   * Set only when `resolution === "adopt-hub"`: the new session holding the
   * local branch. It has NO thread mapping, so the next push publishes it as
   * a thread of its own.
   */
  preservedSessionId?: string;
}

export interface HubPullListResult {
  success: true;
  command: "pull";
  pickRequired: true;
  threads: WhereisThread[];
  warnings: string[];
}

/**
 * The hub is readable and its indexes resolved a thread, but specific BUNDLE
 * FILES those indexes reference have not landed on this machine's copy of the
 * hub directory yet (a synced folder mid-copy, on-demand hydration).
 *
 * The narrow one of the pair: see `HubUnreachableResult` for why "the hub
 * itself could not be read" is a different result and not a second spelling of
 * this. Reaching this exit means the reachability gate already passed, which is
 * what makes `missing` a real, enumerable list.
 */
export interface NotYetSyncedResult {
  success: false;
  command: "pull";
  reason: "not-yet-synced";
  missing: string[];
  suggestion: string;
}

export interface HubReindexResult {
  success: true;
  command: "hub-reindex";
  projects: Array<{ projectId: string; threads: number; bundlesScanned: number }>;
  /**
   * Bundle files in this machine's own bundle directory whose names the rebuild
   * could not parse, so nothing they contain reached the index. Absent on an
   * ordinary rebuild. Foreign files in that directory are the ordinary cause;
   * a sync client's conflict copy (`… (conflicted copy).tar.gz`) is the one to
   * expect.
   */
  unrecognizedBundleFiles?: string[];
  /**
   * Bundle records the rebuild DROPPED because this machine's sync-state has no
   * thread mapping for the session they carry — the rebuilt index is missing
   * them, and a bundle no index references is invisible to every other machine.
   *
   * Typed rather than left to `warnings` because it is data loss, not advice:
   * `skills/session-porter/SKILL.md` forbids branching on warning text, so
   * without a field the only way to notice was to regex the prose. Absent when
   * nothing was dropped.
   */
  droppedBundles?: Array<{ sessionId: string; file: string }>;
  /**
   * Bundle ids the PREVIOUS index listed that the rebuild no longer references.
   *
   * Distinct from `droppedBundles`, and the difference is which side is
   * missing: that one is a bundle **on disk** the rebuild could not attribute
   * to a thread; this one is a record **in the old index** the rebuild could
   * not reproduce at all — usually because its file is gone.
   *
   * Reported rather than repaired, on purpose. `reindex` writes exactly what
   * the bundles plus this machine's sync-state derive, because that
   * derivability is the invariant it exists to enforce; copying a record
   * forward because the old file had it would recreate the unre-derivable index
   * being repaired. Absent when nothing was lost, never `[]`.
   */
  droppedFromPriorIndex?: string[];
  warnings: string[];
}

/**
 * `hub reindex` refused before it rebuilt anything. Additive (#29): every
 * reindex failure used to be an untyped `ErrorResult`, so a caller could only
 * tell the cases apart by regexing `error`.
 *
 * The busy-lock refusal is NOT here — it is `HubLockBusyResult`, the same shape
 * push, pull and `hub unlink` return, so "wait and retry" stays one branch
 * across every verb that takes the project lock.
 */
export interface HubReindexFailedResult {
  success: false;
  command: "hub-reindex";
  /**
   * `unlinked` — this directory is linked to no hub project, so there is
   * nothing to rebuild from. Deliberately not `HubUnlinkedResult`: reindex
   * returns before a backend exists, so it has no candidate list to offer, and
   * its remedy is "push first", not "pick a project".
   */
  reason: "unlinked";
  error: string;
  suggestion: string;
}

/**
 * The result of the `hub unlink` verb: this directory's hub link was removed
 * (or was already absent).
 *
 * **Not to be confused with `HubUnlinkedResult`** (with the "ed"), which is the
 * REFUSAL a push/pull/whereis returns when it needs a link and finds none.
 * This one is a success: the link is gone because the user asked for it to be.
 *
 * Unlinking is deliberately the narrowest possible act — it removes one file
 * and writes nothing to the hub — so most of what a caller needs to relay is
 * about what was NOT touched. Hence `projectId` (kept so a re-link can pass
 * `--project-id` and keep this project's sync bookkeeping meaningful) and
 * `warnings` (the sync-state that stays behind, a lock that was skipped).
 */
export interface HubUnlinkResult {
  success: true;
  command: "hub-unlink";
  /** false = idempotent no-op: nothing was linked here to begin with. */
  wasLinked: boolean;
  /** The hub project this directory was linked to, so a re-link can name it. */
  projectId: string | null;
  /** The one file that was removed, or null when there was none. */
  removedPath: string | null;
  /**
   * Both Claude Code hooks are inert for this directory now. Linking IS the
   * consent gate (`evaluateHookGate` reads exactly this file), so removing it
   * disarms the SessionEnd auto-push and the SessionStart notice at once —
   * for THIS directory only.
   */
  automationDisarmed: boolean;
  warnings: string[];
}

/**
 * A pull refused because the project it targets is RETIRED — some machine has
 * written a tombstone for it on the hub (#43).
 *
 * A refusal in the strict sense: nothing was fetched, nothing local changed, and
 * the project's bundles are all still on the hub. It is emitted from the pull's
 * resolve stage, before the machine registration and before any link write, so
 * "nothing happened" is literal.
 *
 * **The fields exist so the skill layer never has to read the prose**, and the
 * one that decides which advice is even possible is `retiredByThisMachine`:
 * retraction is asymmetric — only the machine that wrote a tombstone can remove
 * it — so "un-retire it" is actionable for exactly one of the two audiences.
 * `deleteEligibleAt` is the other load-bearing one: it is the moment from which
 * the retiring machine's `hub delete` stops refusing, i.e. the deadline for
 * getting anything off the hub with `pull --ignore-retirement`.
 */
export interface HubProjectRetiredResult {
  success: false;
  command: "pull";
  reason: "project-retired";
  projectId: string;
  retiredByMachineId: string;
  /** null when the hub has no readable `machines/<id>.json` record. */
  retiredByMachineName: string | null;
  retiredByThisMachine: boolean;
  retiredAt: string;
  /** The free text `hub retire --reason` recorded, or null. Never interpreted. */
  retirementReason: string | null;
  /** null when `retiredAt` could not be read as a time — an unknown age. */
  deleteEligibleAt: string | null;
  suggestion: string;
}

/**
 * `hub retire` succeeded: this machine's tombstone for the project was written
 * (or, with `--undo`, removed).
 *
 * Phase 1 of retirement, and the result says what phase 1 is NOT: nothing was
 * deleted, every bundle is where it was, and this is reversible from this
 * machine. `deleteEligibleAt` is when phase 2 becomes possible.
 */
export interface HubRetireResult {
  success: true;
  command: "hub-retire";
  projectId: string;
  /** false = `--undo`: the assertion was withdrawn. */
  retired: boolean;
  /** Was there already a tombstone from this machine? Makes both verbs idempotent. */
  wasRetired: boolean;
  /**
   * The assertion's timestamp — the ORIGINAL one when this run re-asserted an
   * existing tombstone, since re-running `hub retire` must not silently restart
   * the grace clock. null on `--undo`.
   */
  retiredAt: string | null;
  /** null on `--undo`, and when `retiredAt` cannot be read as a time. */
  deleteEligibleAt: string | null;
  reason: string | null;
  warnings: string[];
}

/**
 * `hub delete` succeeded: phase 2, the project's files are gone from the hub.
 *
 * The one irreversible result this CLI can produce, and the only caller of
 * `HubBackend.delete` anywhere in `src/`.
 */
export interface HubDeleteResult {
  success: true;
  command: "hub-delete";
  projectId: string;
  /** Files removed under `projects/<projectId>/`. */
  deletedFiles: number;
  /**
   * Files the backend refused to remove, with the reason. A non-empty list still
   * comes back `success: true` — the project is no longer linkable either way
   * (its `project.json` is deleted first) — but the leftovers are named, because
   * nothing else will ever mention them again.
   */
  failed: Array<{ path: string; error: string }>;
  /** Was this directory's `.sesh-mover-project.json` removed too? */
  localLinkRemoved: boolean;
  warnings: string[];
}

/**
 * `hub retire` / `hub delete` refused. Typed reasons rather than prose, on the
 * rule `skills/session-porter/SKILL.md` states: a caller may branch on `reason`
 * and never on message text.
 *
 * - `unlinked` — this directory is linked to no hub project and no `--project-id`
 *   was passed, so there is nothing named to retire.
 * - `project-gone` — the hub has no `projects/<id>/project.json`. Already
 *   deleted, or a link to a hub this directory has never reached.
 * - `not-owner` — this machine did not create the project. Both phases are
 *   owner-only; see `src/hub/retire.ts` for why the "any machine may retire an
 *   EMPTY project" escape hatch from the slice-3 design did not survive being
 *   chained to a deletion.
 * - `not-retired` — `hub delete` with no tombstone from this machine. Phase 2
 *   cannot be reached without phase 1, ever: the tombstone is not a formality,
 *   it is what starts the clock the delete is waiting on.
 * - `grace-period` — the tombstone exists and is younger than
 *   `RETIREMENT_GRACE_MS`. **Class 2 (refusal), not class 3
 *   (environment-not-ready)**, and the distinction is real: class 3 means "retry
 *   this unchanged in a moment", and this one is measured in days. The command
 *   was understood and declined.
 */
export interface HubRetireFailedResult {
  success: false;
  command: "hub-retire" | "hub-delete";
  reason: "unlinked" | "project-gone" | "not-owner" | "not-retired" | "grace-period";
  /** Present once an id is known — absent for `unlinked`. */
  projectId?: string;
  /** `not-owner`: who may retire and delete this project. */
  ownerMachineId?: string;
  ownerMachineName?: string | null;
  /** `grace-period`: the assertion this delete is waiting on. */
  retiredAt?: string;
  deleteEligibleAt?: string | null;
  /** `grace-period`: whole seconds still to wait, null when `retiredAt` is unreadable. */
  remainingSeconds?: number | null;
  error: string;
  suggestion: string;
}

export type CliResult =
  | ExportResult
  | ExportPayloadPlanResult
  | ImportResult
  | DryRunResult
  | MigrateResult
  | BrowseResult
  | ConfigureResult
  | HubInitResult
  | HubStatusResult
  | HubPushResult
  | HubPushFailedResult
  | WhereisResult
  | HubUnlinkedResult
  | HubNoSuchProjectResult
  | HubUnreachableResult
  | HubUnlinkResult
  | HubLockBusyResult
  | HubProjectRetiredResult
  | HubRetireResult
  | HubDeleteResult
  | HubRetireFailedResult
  | HubPullResult
  | HubPullListResult
  | NotYetSyncedResult
  | HubReindexResult
  | HubReindexFailedResult
  | ErrorResult;

// --- Exit codes ---

/**
 * The CLI's process exit codes: **one per CLASS of outcome**, so a shell caller
 * can branch on `$?` without parsing the JSON body (#76).
 *
 * Before this existed the split was an accident of which output helper a call
 * site happened to reach — `output()` returned and every typed refusal exited
 * 0, `outputError()` exited 1 — so `success: false` did not imply non-zero and
 * `sesh-mover hub pull || handle_failure` was silently a no-op for the entire
 * refusal class. The classes below are the stated rule; `exitCodeForResult` is
 * the single place a result is mapped onto one.
 *
 * The class list is finite and deliberately small. It is a CONTRACT: adding a
 * fifth class, or moving a result between two of them, is a breaking change for
 * anyone scripting this CLI.
 *
 * **The two hook endpoints (`hub hook-session-end`, `hub hook-session-start`)
 * are outside this scheme entirely and ALWAYS exit 0**, whatever happens. That
 * is Claude Code's hook protocol, not a style choice — see the stdout-contract
 * comments on both endpoints in `src/cli.ts` and the guards in
 * `tests/hub-hooks.test.ts`. Neither endpoint calls the output helpers, which is
 * what keeps the two schemes from meeting.
 */
export const EXIT_OK = 0;

/**
 * The command did not run: a bad invocation, or an unexpected failure.
 *
 * Commander's own argument validation already exits 1, and so does every
 * exception that reaches a command's `catch` (`outputError` in `src/cli.ts`).
 * Retrying the same invocation unchanged is not expected to help.
 */
export const EXIT_FAILED = 1;

/**
 * The command was understood and declined: nothing was done, and the JSON body
 * says why. `unlinked`, `no-such-project`, "already up to date", and the
 * pick-required listing are this class.
 *
 * A refusal is not an error — the caller is meant to read the shape and decide
 * — but it is emphatically not a success either, which is the whole reason it
 * no longer shares an exit code with one.
 */
export const EXIT_REFUSED = 2;

/**
 * The invocation was fine and the machine simply is not ready: an unmounted
 * share, a synced folder mid-copy, another sesh-mover operation holding the
 * project lock.
 *
 * This is exactly the set worth RETRYING, unchanged, in a moment — which is the
 * property that makes it worth a code of its own rather than folding it into
 * the refusals.
 */
export const EXIT_NOT_READY = 3;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_FAILED
  | typeof EXIT_REFUSED
  | typeof EXIT_NOT_READY;

/**
 * Every `reason` discriminator a `CliResult` can carry, derived from the union
 * rather than restated — so a new refusal shape lands here automatically.
 */
type CliResultReason = Extract<CliResult, { reason: string }>["reason"];

/**
 * The class each typed refusal belongs to.
 *
 * `Record<CliResultReason, ExitCode>` is load-bearing: it is EXHAUSTIVE over the
 * union above, so a new result type carrying a new `reason` fails to compile
 * until someone decides which class it is in. That is the guard against the
 * defect this whole scheme replaces — a result shape silently inheriting
 * whichever exit code its call site happened to produce.
 */
const REASON_EXIT_CODE: Record<CliResultReason, ExitCode> = {
  // Refusals: the command was understood, and declined.
  unlinked: EXIT_REFUSED,
  "no-such-project": EXIT_REFUSED,
  // Retirement (#43), all four of them refusals rather than failures: each is a
  // command that ran, decided, and changed nothing.
  //
  // `grace-period` is the one worth arguing about, because "wait and try again"
  // sounds like class 3. It is not: class 3 is the set worth retrying UNCHANGED
  // IN A MOMENT (an unmounted share, a busy lock), and this one is a deliberate
  // multi-day hold whose whole purpose is that nobody retries it in a moment.
  // Class 3 would also invite a caller to loop on it.
  "project-retired": EXIT_REFUSED,
  "project-gone": EXIT_REFUSED,
  "not-owner": EXIT_REFUSED,
  "not-retired": EXIT_REFUSED,
  "grace-period": EXIT_REFUSED,
  // Environment-not-ready: same invocation, retry once the machine catches up.
  "hub-unreachable": EXIT_NOT_READY,
  "lock-busy": EXIT_NOT_READY,
  "not-yet-synced": EXIT_NOT_READY,
  /**
   * NOT a refusal, and the one class assignment #76's decision comment did not
   * name. `HubPushFailedResult` is a push that THREW after the identity
   * decision — it may have left the project linked, an orphan hub project, or a
   * bundle no index references. "I declined and nothing happened" is exactly
   * what it is not, and it is not retryable the way class 3 is either. It is a
   * failure, so it takes the failure code.
   */
  "failed-after-link": EXIT_FAILED,
};

/**
 * The single mapping from a result SHAPE to an exit code.
 *
 * Shape-driven on purpose (#76): the code is a property of what the command
 * produced, not of which helper printed it, so the two cannot drift apart again.
 *
 * Three rules, in order:
 *
 * 1. `success: true` exits 0 — **except** the pick-required listing, which is
 *    the one place a `success: true` result exits non-zero. `sesh-mover pull`
 *    with neither `--thread` nor `--latest` pulls nothing; it answers with the
 *    list of threads and waits to be told which. A caller that treats that as
 *    "the pull happened" is wrong, and `|| handle` catching it is the point of
 *    the whole change. The skill layer reads `pickRequired` from the JSON and is
 *    unaffected.
 * 2. A typed `reason` takes its class from `REASON_EXIT_CODE` above.
 * 3. Anything else that is `success: false` is a REFUSAL (2).
 *
 * Rule 3's default is 2 rather than 1 because of what reaches it: an
 * `ErrorResult` that a command RETURNED as a value, having got far enough to
 * describe the outcome — "already up to date with the source machine", "no
 * thread <id> found", the self-migration block. An exception never reaches here
 * at all; `outputError` handles those and always exits 1. So the line is "a
 * result the code composed" versus "a throw it did not".
 *
 * The imprecision that line leaves, stated rather than hidden: a few untyped
 * `ErrorResult`s are caught exceptions converted to results (`hubInit`'s mkdir
 * failure, `importSession`'s unreadable bundle) and are really class 1. Giving
 * them their right code needs a `reason` discriminator on the producing module,
 * not a smarter classifier here — matching on `error` text is forbidden
 * (`skills/session-porter/SKILL.md`) and would be exactly the fragility this
 * function exists to remove. They exit 2 today: non-zero, one class off.
 */
export function exitCodeForResult(result: CliResult): ExitCode {
  if (result.success) {
    return "pickRequired" in result && result.pickRequired ? EXIT_REFUSED : EXIT_OK;
  }
  if ("reason" in result) return REASON_EXIT_CODE[result.reason];
  return EXIT_REFUSED;
}

// --- Version Adapters ---

export interface VersionAdapter {
  fromVersion: string;
  toVersion: string;
  description: string;
  applies(entry: JsonlEntry): boolean;
  transform(entry: JsonlEntry): JsonlEntry;
}

// --- Path Rewrite ---

export interface PathMapping {
  from: string;
  to: string;
  description: string;
}

export interface RewriteReport {
  mappings: PathMapping[];
  entriesRewritten: number;
  fieldsRewritten: number;
  warnings: string[];
}

// --- Progress ---

export interface ProgressEvent {
  phase:
    | "export-copy"
    | "import-rewrite"
    | "import-verify"
    | "archive"
    | "extract"
    | "hub-push"
    | "hub-pull";
  sessionId?: string;
  /**
   * 0-BASED, AND NOT MONOTONIC WITHIN A PHASE (#16/#29). Every emitter derives
   * it from `Array.prototype.entries()`, so a "session i of N" renderer must add
   * one — but it must NOT assume the sequence only ever climbs.
   *
   * `export-copy` is emitted from two consecutive loops over two different
   * arrays — the sessions copied whole and the sessions shipped as
   * continuations (`src/exporter.ts`) — and each numbers from 0 against its
   * OWN length. One export carrying two of each therefore emits `0/2, 1/2,
   * 0/2, 1/2`, which a naive renderer shows as the progress bar restarting
   * mid-phase. `sessionCount` is the size of the current sub-batch, never of
   * the export.
   *
   * Absent entirely on the two hub phases: `hub-push`/`hub-pull` events carry
   * `percent` only, and the per-session detail under them comes from the
   * exporter/importer events the hub verb forwards.
   *
   * THE TERMINAL-EVENT CONTRACT for those two phases (#74), because a consumer
   * that waits for one has to know when it is entitled to it. Once `hubPush`/
   * `hubPull` has acquired the project lock, it emits exactly one
   * `{percent: 0}` and, from its `finally`, exactly one `{percent: 100}` —
   * **on every outcome**, including a typed refusal, a mid-chain abort and a
   * thrown exception. `percent: 100` therefore means "the operation is over",
   * not "everything succeeded"; the returned result says which, and a throw
   * still throws. The one exit BEFORE the lock (`lock-busy`, plus a non-busy
   * throw out of the lock itself) emits nothing at all, which is the contract
   * rather than an oversight: a consumer gets either no events or a matched
   * pair, never an opening event with no close.
   */
  sessionIndex?: number;
  /** See `sessionIndex`: the current sub-batch's size, not the whole phase's. */
  sessionCount?: number;
  bytesProcessed?: number;
  bytesTotal?: number;
  percent?: number;
}

// --- Discovery ---

export interface DiscoveredSession {
  sessionId: string;
  projectPath: string;
  encodedProjectDir: string;
  jsonlPath: string;
  slug: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  gitBranch: string;
  entrypoint: string;
  hasSubagents: boolean;
  hasToolResults: boolean;
  hasFileHistory: boolean;
}

// --- Incremental sync types ---

export interface MachineIdentity {
  id: string;
  name: string;
  createdAt: string;
}

export interface SyncStateSessionSent {
  headEntryUuid: string;
  messageCount: number;
  sentAsType: "full" | "continuation";
  sentAsSessionId: string;
}

export interface SyncStateSessionReceived {
  localSessionId: string;
  type: "full" | "continuation";
  importedAt: string;
}

export interface SyncStatePeer {
  name: string;
  lastSentAt: string | null;
  lastReceivedAt: string | null;
  sent: Record<string, SyncStateSessionSent>;
  received: Record<string, SyncStateSessionReceived>;
  /**
   * The `memoryDigest` of the last bundle this machine successfully delivered
   * to this peer — the whole-file counterpart of `sent`, which tracks the same
   * "already has it" question per session.
   *
   * `memory/` has no delta representation, so "incremental" for it can only mean
   * "do not re-send an identical copy". This is that ledger, and it obeys the
   * same rule as `sent`: written only once the bundle has actually reached the
   * peer, never at export time. Recording it early would make the next export
   * skip a directory the peer never received.
   *
   * Absent means "nothing known" and therefore "ship it" — which is what makes
   * the first push to a peer carry memory, and what makes a lost or reset state
   * file fail toward re-sending rather than toward silence.
   *
   * Additive and version-neutral on purpose: it lives on the peer entry rather
   * than in the `hub` block (where the workspace ledger lives) so that a plain
   * `export --incremental --to <peer>` user gains it without their state file
   * being promoted to `schemaVersion` 2 — see `setThreadId` for why that
   * promotion is not free.
   */
  memoryDigest?: string;
}

export interface SyncStateLineage {
  sourceMachineId: string;
  sourceSessionId: string;
  importedAt: string;
  type: "full" | "continuation";
  continuationOf?: string;
  postRewriteHash?: string;
}

export interface SyncStateImported {
  localSessionId: string;
  importedAt: string;
  registered: boolean;
}

/**
 * A pointer at one workspace generation stored on the hub.
 *
 * Only a pointer: the hub keeps the tree, because every workspace payload is a
 * full snapshot generation.
 *
 * Neither timestamp participates in any decision. `syncedAt` is this machine's
 * clock and `pushedAt` is the *pushing* machine's clock — the hub is a passive
 * filesystem and stamps nothing — so no comparison between two machines'
 * generations can be drawn from either. Which generation a merge uses is
 * decided by SET MEMBERSHIP (`knownWorkspaceGenerations`), never by time; the
 * stamps are diagnostics.
 */
export interface WorkspaceGenerationRef {
  bundleId: string;
  /** Hub-relative path of the bundle carrying this generation. */
  file: string;
  /** When this machine pushed or applied it (this machine's clock). */
  syncedAt: string;
  /** When the bundle was published (the PUSHING machine's clock). Diagnostic only. */
  pushedAt?: string;
}

export interface SyncState {
  projectPath: string;
  schemaVersion: 1 | 2;
  peers: Record<string, SyncStatePeer>;
  lineage: Record<string, SyncStateLineage>;
  imported: Record<string, SyncStateImported>;
  hub?: {
    hubId: string;
    threadByLocalSession: Record<string, string>;
    /**
     * The workspace generation this machine last pushed or applied — i.e. the
     * head of `workspaceGenerations`, and what a push declares as its
     * `basedOn`.
     *
     * Absent until this project first pushes or pulls a workspace payload,
     * which is why a plain sessions-only hub user never grows the field.
     */
    lastWorkspace?: WorkspaceGenerationRef;
    /**
     * Every workspace generation this machine's tree has passed through, most
     * recent first and bounded (see `MAX_WORKSPACE_GENERATIONS`), with
     * `lastWorkspace` as its head.
     *
     * This is the merge's whole ancestor mechanism: a generation may be used as
     * a 3-way merge base only if it is common to BOTH trees, and membership in
     * this list is exactly the "we held it too" half of that test — no clocks
     * involved. See `hub/pull-apply-workspace.ts`'s `chooseMergeAncestor`, which intersects it
     * with what the incoming chain declares it descends from.
     */
    workspaceGenerations?: WorkspaceGenerationRef[];
    /**
     * What the last SessionEnd auto-push had to say for itself.
     *
     * The auto-push runs detached with its stdout closed and its stderr shown
     * only in Claude Code's debug output, so everything it computes for a human
     * is discarded — including the disclosures that exist precisely to be read:
     * `carry.trackedIgnored` (gitignored-but-TRACKED files whose contents left
     * the machine in the patch) and the re-included `.sesh-mover-include` paths. It is
     * also where a chronically failing push (an unmounted share) would
     * otherwise be invisible. This is the durable breadcrumb for both, surfaced
     * by `hub status`.
     *
     * Written only by the auto-push endpoint, and only best-effort: it is a
     * record OF a push, never an input TO one, so nothing reads it back.
     */
    lastAutoPush?: {
      at: string;
      ok: boolean;
      /** Capped at `MAX_AUTO_PUSH_NOTES`; `noteCount` is how many there were. */
      notes: string[];
      noteCount: number;
    };
  };
}
