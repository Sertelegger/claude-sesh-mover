import {
  mkdtempSync, rmSync, rmdirSync, readFileSync, writeFileSync, existsSync, createReadStream,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFsBackend } from "./backend.js";
import { HUB_JSON, bundleDir, bundleFileName, type HubBundleRecord, type HubJson } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import {
  resolveProjectIdentity, createHubProject, linkToHubProject, scanGitRemotes,
  readLocalProjectId, localProjectIdPath, type GitRemoteScan, type LocalProjectId,
} from "./identity.js";
import { registerMachine } from "./init.js";
import { buildIndexFile, readMachineIndex, writeMachineIndex } from "./index-file.js";
import { snapshotWorkspace, hubincludePath, isNeverIncludable } from "./workspace.js";
import { captureCarry, gitChildEnv, type CarryMeta } from "./carry.js";
import { exportAllSessions } from "../exporter.js";
import { createArchive } from "../archiver.js";
import { discoverSessions } from "../discovery.js";
import { loadOrCreateMachineId } from "../machine.js";
import { readManifest } from "../manifest.js";
import { readLastEntryUuid } from "../jsonl.js";
import {
  readSyncState, writeSyncState, recordSentFromBundle, getThreadId, setThreadId, setLastWorkspace,
} from "../sync-state.js";
import type { ErrorResult, HubLockBusyResult, HubPushResult, HubUnlinkedResult, ProgressEvent } from "../types.js";
import { userDirWarnings } from "../paths.js";

export interface HubPushOptions {
  configDir: string;
  projectPath: string;
  hubPath: string;
  sessionIds?: string[];
  noWorkspace?: boolean;
  /**
   * Skip the git-diff carry (design §6.1). Off by default: for a project with
   * a git remote the carry is the only thing that moves work-in-progress, and
   * it never copies a gitignored UNTRACKED file unless `hubinclude` names it.
   * (A gitignored file that git TRACKS is a different matter: the patch carries
   * its changes and no carry rule filters the patch — see `trackedIgnored`.)
   */
  noCarry?: boolean;
  /**
   * Byte budgets for the two optional payloads, resolved from `hub.carryMaxMb`
   * and `hub.workspaceMaxMb`, plus whatever resolving them had to say.
   *
   * Resolved by the CALLER rather than read here, for the same reason
   * `noWorkspace`/`noCarry` are: this module is handed a decision, not a config
   * directory, and there is exactly one resolver (`resolveHubBudgets`) so the
   * SessionEnd auto-push and the manual push cannot drift. Absent means "use
   * the module defaults", which is what a programmatic caller gets.
   */
  budgets?: { carryMaxBytes: number; workspaceMaxBytes: number; warnings: string[] };
  projectIdOverride?: string;
  createProject?: boolean;
  claudeVersion: string;
  /**
   * Suppress everything whose only purpose is to be read by a human. Set by the
   * SessionEnd auto-push hook, whose contract is that session exit is never
   * interrupted or narrated (design §4.2) — today that means skipping the
   * `ignoredNotCarried` discovery scan, which also spares an unattended push a
   * `git ls-files` walk of the whole working tree.
   */
  quiet?: boolean;
  onProgress?: (ev: ProgressEvent) => void;
}

/** Cap on `ignoredNotCarried`: a sample the user can recognize, not an inventory. */
const MAX_IGNORED_REPORTED = 10;

/**
 * Top-level gitignored paths, as `git` spells them — `docs/` for a wholly
 * ignored directory, `src/generated.ts` for a single ignored file inside a
 * carried one. Each is a valid `hubinclude` pattern for exactly that thing.
 *
 * `-z` is not a nicety: without it git applies `core.quotePath`, so a name with
 * a space, a quote, a newline or any non-ASCII character comes back C-quoted
 * and octal-escaped, and a newline in a filename would split one entry into
 * two. This list is shown to a user and offered as a pattern to paste, so it
 * has to be the real bytes.
 *
 * Every failure — no git, not a repo, timeout, output past `maxBuffer` — is the
 * same answer: no discovery aid this time. It is a hint, never a gate.
 */
function listTopLevelIgnored(projectPath: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      {
        cwd: projectPath, encoding: "utf-8", timeout: 5000,
        // Not the inherited environment (see `gitChildEnv`): these paths are
        // offered to the user as `hubinclude` lines to paste, so they have to
        // come from the project's own repository and its own ignore rules.
        env: gitChildEnv(),
        stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024,
      }
    );
    const paths = new Set<string>();
    for (const entry of out.split("\0")) {
      // No trimming: with -z the bytes between separators ARE the path, and a
      // name may legitimately begin or end with a space.
      if (!entry) continue;
      if (isNeverIncludable(entry)) continue; // can never be carried, so never suggest it
      paths.add(entry);
      if (paths.size >= MAX_IGNORED_REPORTED) break;
    }
    return [...paths];
  } catch {
    return [];
  }
}

/**
 * What `commitIdentity` actually did, kept so a LATER failure knows how much of
 * it is this push's to undo.
 *
 * Linking is the hub's consent gate (see `commitIdentity`), so deferring the
 * write past the export only covers failures up to that point: a bundle upload
 * that throws, an index write that throws, a workspace file that turns out to
 * be unreadable — every one of those used to surface as a bare Error with the
 * project silently left linked and the default-on SessionEnd auto-push armed
 * for a push the user just watched fail (measured twice: an `ENOTDIR` at the
 * bundle destination, and an `EACCES` inside the workspace snapshot).
 */
interface CommittedLink {
  local: LocalProjectId;
  /** Already linked when this push started — someone else's link, not ours to undo. */
  preExisting: boolean;
  /** `--create-project` minted a NEW hub project, which nothing can remove. */
  mintedHubProject: boolean;
}

/**
 * Undo the LOCAL half of a link this push made.
 *
 * Only the local half: there is no `backend.delete` call anywhere in src/, so a
 * hub project a failed push created stays on the hub and in every machine's
 * `linkCandidates` (recorded as out of scope — hub-side deletion needs
 * ownership semantics this slice doesn't have). That asymmetry is why the
 * caller REPORTS what is left rather than claiming a clean rollback.
 *
 * Re-reads before removing: the file is only ours to delete while it still
 * names the project id this push wrote. Anything else means something changed
 * it underneath us, and a link the user (or a concurrent operation) put there
 * is not collateral for our failure.
 */
function rollbackLocalLink(
  projectPath: string,
  link: CommittedLink
): { removed: boolean; detail: string } {
  try {
    const still = readLocalProjectId(projectPath);
    if (!still) return { removed: true, detail: "" };
    if (still.projectId !== link.local.projectId) {
      return { removed: false, detail: "it now names a different hub project" };
    }
    const p = localProjectIdPath(projectPath);
    rmSync(p, { force: true });
    // The directory too, but only while it holds nothing else: `hubignore`,
    // `hubinclude` and a project-scope config.json are the user's files and
    // predate this push. rmdir on a non-empty directory simply fails.
    try { rmdirSync(dirname(p)); } catch { /* not empty, or already gone */ }
    return { removed: true, detail: "" };
  } catch (e) {
    return { removed: false, detail: (e as Error).message };
  }
}

/**
 * The result for a push that threw AFTER the identity was committed.
 *
 * Typed rather than thrown, like every other refusal in this file, because the
 * one thing the user has to be told is not in the exception: whether this
 * project is linked now. A link means the SessionEnd auto-push will run
 * unattended, and for a git-less project that push uploads the whole working
 * tree.
 */
function failedAfterLink(
  projectPath: string,
  link: CommittedLink,
  bundleCommitted: boolean,
  error: unknown
): ErrorResult {
  const cause = error instanceof Error ? error.message : String(error);
  // The bundle is atomic (`writeStreamAtomic`), so it is either on the hub or
  // it never existed — but the index that makes it findable is written after
  // it, and a failure in between leaves a real bundle no machine can see.
  const orphanBundle = bundleCommitted
    ? " The bundle itself did reach the hub before the failure, but this machine's index was not updated to reference it, so no other machine can see it."
    : "";
  if (link.preExisting) {
    return {
      success: false, command: "push",
      error: `The push failed: ${cause}`,
      details:
        `This project was already linked to hub project ${link.local.projectId} before this push, ` +
        `so it stays linked and nothing about the link changed.${orphanBundle}`,
      suggestion: "Fix the cause above and push again — the project stays linked either way.",
    };
  }
  const rollback = rollbackLocalLink(projectPath, link);
  return {
    success: false, command: "push",
    error: `The push failed after this project was linked to the hub: ${cause}`,
    details: rollback.removed
      ? `The link this push created was removed, so this project is NOT linked to the hub ` +
        `and the SessionEnd auto-push stays off for it.${orphanBundle}`
      : `The link this push created could NOT be removed (${rollback.detail}), so this project IS ` +
        `linked to hub project ${link.local.projectId} and the SessionEnd auto-push is armed for it — ` +
        `delete .sesh-mover-project.json to unlink it.${orphanBundle}`,
    suggestion: link.mintedHubProject
      ? `Hub project ${link.local.projectId} was created before the failure and nothing removes a hub project, so pass --project-id ${link.local.projectId} on a later push to link to that one instead of minting a second.`
      : "Fix the cause above and push again; the project links again once a push gets past this point.",
  };
}

export async function hubPush(
  opts: HubPushOptions
): Promise<HubPushResult | HubUnlinkedResult | HubLockBusyResult | ErrorResult> {
  // An empty array is programmatically distinct from "omitted" but must mean
  // the same thing here — otherwise it mints zero threads (the filter below
  // matches nothing) while still exporting every session (exportAllSessions
  // treats [] as "no filter" today), silently over-exporting.
  const sessionIds = opts.sessionIds && opts.sessionIds.length > 0 ? opts.sessionIds : undefined;
  let lock;
  try {
    lock = acquireProjectLock(opts.projectPath);
  } catch (e) {
    if (e instanceof LockBusyError) {
      return {
        success: false, command: "push", reason: "lock-busy",
        holderPid: e.holderPid, ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
        suggestion: "Another sesh-mover hub operation is running for this project — wait for it or retry.",
      };
    }
    throw e;
  }

  // Staging is created inside the protecting try so a mkdtemp failure still
  // releases the lock in the finally (review fix: post-acquire throw window).
  let staging: string | null = null;
  // Declared out here so the catch below can see them: `committedLink` stays
  // null until `commitIdentity()` returns, which is exactly the line that
  // divides "a throw leaves nothing behind" from "a throw leaves this project
  // linked". `bundleCommitted` narrows what the resulting message may claim.
  let committedLink: CommittedLink | null = null;
  let bundleCommitted = false;
  try {
    staging = mkdtempSync(join(tmpdir(), "sesh-hub-push-"));
    const backend = createFsBackend(opts.hubPath);
    const warnings: string[] = [];
    // See hub/status.ts: the user-directory migration notice, if there is one.
    warnings.push(...userDirWarnings());
    // A budget that could not be read as written. Said once, up front, rather
    // than folded into the decline it causes — the two are different facts, and
    // on an unattended session-end push this is the only trace of the typo.
    warnings.push(...(opts.budgets?.warnings ?? []));
    if (lock.stoleStale) {
      warnings.push(
        "Stole a stale project lock left by a previous sesh-mover hub operation (likely crashed or was killed) — proceeding, but verify no other push/pull is genuinely in progress."
      );
    }
    const machine = loadOrCreateMachineId();

    // Identity — DECIDED here, COMMITTED after the export.
    //
    // Linking is the hub's consent gate: `.sesh-mover-project.json`
    // existing is what makes `evaluateHookGate` let the default-on SessionEnd
    // auto-push run, and for a git-less project that push uploads the WHOLE
    // project directory. So a link must not be a side effect of a push that
    // then failed. Measured: `push --create-project` in a directory with no
    // sessions returned the exporter's `success: false` ("No sessions found for
    // this project") while having already written project.json and created the
    // hub project — nothing in the result said so, commands/push.md says report
    // and stop, and the next session end uploaded the tree, `.env` included.
    //
    // Deferring the write past `exportAllSessions` closes exactly that: any
    // failure up to and including the export now leaves the project unlinked.
    // It is committed just BEFORE the up-to-date early return, so a push that
    // legitimately has nothing new to send still links (its `projectId` is part
    // of that result).
    type PendingIdentity =
      | { kind: "linked"; local: LocalProjectId }
      | { kind: "link"; projectId: string; note?: string }
      | { kind: "create" };
    let pendingIdentity: PendingIdentity;
    if (opts.projectIdOverride) {
      pendingIdentity = { kind: "link", projectId: opts.projectIdOverride };
    } else if (opts.createProject && !readLocalProjectId(opts.projectPath)) {
      pendingIdentity = { kind: "create" };
    } else {
      const resolution = await resolveProjectIdentity(backend, opts.projectPath);
      if (resolution.kind === "linked") pendingIdentity = { kind: "linked", local: resolution.local };
      else if (resolution.kind === "match") {
        pendingIdentity = {
          kind: "link",
          projectId: resolution.hubProject.projectId,
          note: `Linked to hub project ${resolution.hubProject.name} via git remote ${resolution.matchedRemote}.`,
        };
      } else {
        return {
          success: false, command: "push", reason: "unlinked",
          linkCandidates: resolution.candidates,
          suggestion: "Pass --project-id <id> to link to an existing hub project, or --create-project to mint a new one.",
        };
      }
    }
    const commitIdentity = async (): Promise<LocalProjectId> => {
      if (pendingIdentity.kind === "linked") return pendingIdentity.local;
      if (pendingIdentity.kind === "create") {
        return createHubProject(backend, opts.projectPath, machine.id);
      }
      if (pendingIdentity.note) warnings.push(pendingIdentity.note);
      return linkToHubProject(backend, opts.projectPath, pendingIdentity.projectId);
    };

    await registerMachine(opts.hubPath);
    const hub = JSON.parse((await backend.read(HUB_JSON)).toString()) as HubJson;
    const hubPeerId = `hub:${hub.hubId}`;
    opts.onProgress?.({ phase: "hub-push", percent: 0 });

    // Thread minting for every session in scope
    let sessions = discoverSessions(opts.configDir, opts.projectPath);
    if (sessionIds) sessions = sessions.filter((s) => sessionIds.includes(s.sessionId));
    const state = readSyncState(opts.projectPath);
    for (const s of sessions) {
      if (!getThreadId(state, s.sessionId)) setThreadId(state, hub.hubId, s.sessionId, randomUUID());
    }
    writeSyncState(state);

    // Incremental export against the hub pseudo-peer. One export path:
    // exportAllSessions honors sessionIds (undefined = all) and errors on
    // any requested id that doesn't exist.
    const bundleId = randomUUID();
    const exportResult = await exportAllSessions({
      configDir: opts.configDir,
      projectPath: opts.projectPath,
      sessionIds,
      outputDir: staging,
      name: "bundle",
      excludeLayers: [],
      claudeVersion: opts.claudeVersion,
      incremental: {
        sourceMachineId: machine.id,
        sourceMachineName: machine.name,
        targetMachineId: hubPeerId,
        targetMachineName: "hub",
        peerSent: state.peers[hubPeerId]?.sent ?? {},
      },
      onProgress: opts.onProgress,
    });
    if (!exportResult.success) {
      // Nothing is linked at this point — see `commitIdentity`. The `command`
      // is restated as this command's own: every CLI result is keyed by the
      // command the user ran (CLAUDE.md), and a `push` answering
      // `"command": "export"` sends a caller that branches on it down a path
      // that does not exist for push.
      return { ...exportResult, command: "push" };
    }
    const bundleStaging = exportResult.exportPath;
    const manifest = readManifest(bundleStaging);
    // The export produced something (even if it is "nothing new"), so this push
    // has earned the link. Everything above this line leaves an unlinked
    // project unlinked; everything BELOW it is covered by the catch at the
    // bottom of this try, which rolls the local link back (see `CommittedLink`).
    const local = await commitIdentity();
    committedLink = {
      local,
      preExisting: pendingIdentity.kind === "linked",
      mintedHubProject: pendingIdentity.kind === "create",
    };
    // ...which means the exporter ran BEFORE the link existed, and it reads the
    // project id off disk (`readLocalProjectId` in exporter.ts). On a
    // `--create-project` push the staged manifest therefore carries no
    // `projectId`, and importer.ts's identity-planting step is what leaves a
    // machine bootstrapping from that bundle linked. Stamp it now — the same
    // in-place manifest patch the workspace and carry blocks below already use.
    if (manifest.projectId !== local.projectId) {
      const manifestPath = join(bundleStaging, "manifest.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
      m.projectId = local.projectId;
      writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
      manifest.projectId = local.projectId;
    }
    if (manifest.sessions.length === 0) {
      // Every discovered session's head already matches what the hub has
      // recorded as sent — nothing to push. Return before any hub write
      // (no bundle archive, no index rewrite); the outer finally cleans up
      // staging.
      opts.onProgress?.({ phase: "hub-push", percent: 100 });
      return {
        success: true, command: "push", projectId: local.projectId,
        bundleId: null, pushedSessions: [], upToDate: true, hasWorkspace: false, warnings,
      };
    }

    // Memoized: `git remote -v` gates both the workspace payload and the
    // ignored-path discovery aid below, and neither runs on the up-to-date
    // early return above — so a quiet auto-push with no workspace still spawns
    // nothing, and a manual push of a git project spawns it once, not twice.
    let gitScanCache: GitRemoteScan | null = null;
    const gitScan = (): GitRemoteScan => (gitScanCache ??= scanGitRemotes(opts.projectPath));

    // Neither payload is built when git could not be asked about this project's
    // remotes (see `GitRemoteScan`). The workspace snapshot copies the whole
    // project directory WITHOUT reading .gitignore, so taking that path on a
    // repository whose remotes are merely unknown uploads secrets a git project
    // never intended to publish — and this push may be the unattended SessionEnd
    // one. The carry needs a working `git` by definition. Say so instead, in the
    // shape the declined-carry warning already uses: no remedy is named that
    // this invocation has already foreclosed.
    if (
      gitScan().kind === "unknown" &&
      (!opts.noWorkspace || !opts.noCarry) &&
      existsSync(opts.projectPath)
    ) {
      const scan = gitScan() as Extract<GitRemoteScan, { kind: "unknown" }>;
      warnings.push(
        `No project files or uncommitted work were included in this push: ${scan.detail}, so whether this project has a git remote could not be established. A full copy of the working tree is only safe for a project that genuinely has none — it does not read .gitignore — and the git-diff carry needs a working \`git\` of its own. The sessions pushed normally; once git can answer here, the files travel with the next push that has new session content.`
      );
    }

    // Workspace payload — projects with no git remotes (including
    // remote-less git repositories), since there's no remote to reconstruct
    // the working tree from otherwise.
    let hasWorkspace = false;
    if (!opts.noWorkspace && gitScan().kind === "none" && existsSync(opts.projectPath)) {
      const ws = await snapshotWorkspace(opts.projectPath, join(bundleStaging, "workspace"), {
        maxBytes: opts.budgets?.workspaceMaxBytes,
      });
      if (ws.symlinksSkipped > 0) warnings.push(`${ws.symlinksSkipped} symlink(s) skipped in workspace snapshot.`);
      // Rule-level diagnostics (a hubinclude past a cap, an exclude set that
      // swallowed the whole tree, a payload over the snapshot budget). Every
      // one of them fails CLOSED — fewer files — which is invisible from the
      // outside without this.
      warnings.push(...ws.warnings);
      // `skipped` = over the snapshot budget, nothing copied. The sessions
      // still push; there is simply no payload to declare and — critically —
      // no generation to record. Recording an un-applied generation is the one
      // way this feature loses data quietly: the next merge would read the
      // whole un-sent tree as "deleted here".
      if (!ws.skipped) {
        const manifestPath = join(bundleStaging, "manifest.json");
        const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
        // Declare what this snapshot descends from — read BEFORE the new
        // generation is recorded below. A puller intersects this id with its own
        // generation history, and only a hit makes a 3-way merge legal: it is the
        // proof that a generation was held by both trees, which neither side can
        // establish alone (see the field's doc in types.ts). `file` and
        // `pushedAt` ride along as diagnostics only — the puller resolves the
        // generation through its OWN record, so nothing here becomes a path or a
        // comparison on the other machine.
        const basedOnRef = readSyncState(opts.projectPath).hub?.lastWorkspace;
        m.workspace = {
          fileCount: ws.fileCount,
          byteSize: ws.byteSize,
          snapshotAt: new Date().toISOString(),
          basedOn: basedOnRef
            ? { bundleId: basedOnRef.bundleId, file: basedOnRef.file, pushedAt: basedOnRef.pushedAt }
            : null,
        };
        writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
        hasWorkspace = true;
      }
    }

    // Git-diff carry — the complement of the workspace snapshot: a project WITH
    // a remote reconstructs its committed state from git, so only the
    // uncommitted part has to travel (design §6.1). This is also what finally
    // gives `hubinclude` an effect on a git project: until this block existed
    // its only reader was `snapshotWorkspace`, which runs exactly when there
    // are NO remotes, so the discovery aid below offered a file that could not
    // do anything for the project being offered it.
    //
    // Gated on `rawCount > 0`, not on the normalized list: a self-hosted
    // `git@gitserver:team/repo.git` is a perfectly real remote that
    // `normalizeGitRemote` declines to canonicalize (no dot in the host), and
    // such a project must get the carry — the payload the .gitignore rules
    // apply to — rather than a whole-tree snapshot.
    let carryMeta: CarryMeta | undefined;
    if (!opts.noCarry && gitScan().kind === "remotes" && existsSync(opts.projectPath)) {
      const diagnostics: string[] = [];
      // Contained deliberately, unlike the workspace snapshot above: this
      // branch runs `git` against a real user repository whose state is
      // unbounded (mid-rebase, submodules, 200k untracked files, a filesystem
      // that refuses a read), and no failure of the OPTIONAL half of a push may
      // cost the user the session bundle that is the point of the operation.
      const cap = await captureCarry(opts.projectPath, join(bundleStaging, "carry"), {
        diagnostics, maxBytes: opts.budgets?.carryMaxBytes,
      })
        .catch((e: Error) => ({ captured: false, reason: "git-failed", detail: e.message } as const));
      warnings.push(...diagnostics);
      if (cap.captured) {
        carryMeta = cap.meta;
        const manifestPath = join(bundleStaging, "manifest.json");
        const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
        m.carry = cap.meta;
        writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
        if (cap.meta.reIncludedCount > 0) {
          // Say what left the machine. `.gitignore` is where `.env` lives, and
          // `ignoredNotCarried` exists so this choice is informed — reporting
          // the opt-in as a silent success would undercut it.
          const shown = cap.meta.reIncluded.join(", ");
          const more = cap.meta.reIncludedCount - cap.meta.reIncluded.length;
          warnings.push(
            `Carried ${cap.meta.reIncludedCount} gitignored file(s) because .sesh-mover-hubinclude names them: ${shown}${more > 0 ? `, and ${more} more` : ""}. They are on the hub now.`
          );
        }
        if (cap.meta.trackedIgnoredCount > 0) {
          // A different disclosure with a different remedy, which is why it is
          // not folded into the one above: hubinclude did not put these on the
          // hub and removing a hubinclude line will not take them off it. They
          // are gitignored files that git TRACKS, so the patch carries their
          // uncommitted contents and no carry rule filters the patch.
          const shown = cap.meta.trackedIgnored.join(", ");
          const more = cap.meta.trackedIgnoredCount - cap.meta.trackedIgnored.length;
          warnings.push(
            `The patch carries changes to ${cap.meta.trackedIgnoredCount} gitignored file(s) that git TRACKS, so .gitignore did not keep them off the hub: ${shown}${more > 0 ? `, and ${more} more` : ""}. They are on the hub now and nothing takes them off it; untrack them (git rm --cached) or push with --no-carry to keep the next push from carrying them again.`
          );
        }
        if (cap.meta.inProgress) {
          warnings.push(
            `Uncommitted changes were captured during an in-progress ${cap.meta.inProgress}: the patch records the working tree as it stands, conflict markers included, and the ${cap.meta.inProgress} itself does not travel.`
          );
        }
      } else if (cap.reason !== "clean" && cap.reason !== "not-git") {
        // "clean" is the ordinary case and "not-git" cannot happen here (this
        // branch already established a git remote), so everything else is a
        // capture the user expected and did not get.
        warnings.push(
          `Uncommitted changes were not carried: ${cap.detail ?? cap.reason}. They will be picked up by the next push that has new session content.`
        );
      }
    }

    // Archive + stream into hub
    const pushedAt = new Date().toISOString();
    const archiveTmp = join(staging, "bundle.tar.gz");
    await createArchive(bundleStaging, archiveTmp, "gzip");
    const hubFile = `${bundleDir(local.projectId, machine.id)}/${bundleFileName(pushedAt, bundleId)}`;
    const w = await backend.writeStreamAtomic(hubFile);
    try {
      await pipeline(createReadStream(archiveTmp), w.stream);
      await w.commit();
      bundleCommitted = true;
    } catch (e) {
      await w.abort();
      throw e;
    }

    // Peer bookkeeping from the staged bundle (snapshot, never live files)
    recordSentFromBundle(opts.projectPath, { id: hubPeerId, name: "hub" }, bundleStaging);

    // The workspace generation this machine's tree now shares with the hub —
    // the ancestor input for the next pull's 3-way merge (design §5.2). Only
    // recorded once the bundle is committed to the hub: a generation the hub
    // does not hold cannot be fetched back as an ancestor.
    //
    // It describes the SNAPSHOT, not the live tree: anything the user edited
    // between snapshotWorkspace above and this line is a local change against
    // this generation, which is exactly what the next merge should see.
    //
    // Read AFTER recordSentFromBundle — that helper rewrites the same file, so
    // mutating a copy read before it would be silently discarded.
    if (hasWorkspace) {
      const stateWs = readSyncState(opts.projectPath);
      setLastWorkspace(stateWs, hub.hubId, { bundleId, file: hubFile, pushedAt });
      writeSyncState(stateWs);
    }

    // Index projection
    const stateAfter = readSyncState(opts.projectPath);
    const records: Array<{ threadId: string; record: HubBundleRecord }> = [];
    const pushedSessions: HubPushResult["pushedSessions"] = [];
    for (const s of manifest.sessions) {
      const localSessionId =
        s.type === "continuation" && s.continuation ? s.continuation.continuesLocalSessionId : s.sessionId;
      const threadId = getThreadId(stateAfter, localSessionId);
      if (!threadId) { warnings.push(`no thread mapping for pushed session ${s.sessionId} — index skipped it.`); continue; }
      records.push({
        threadId,
        record: {
          bundleId, file: hubFile,
          type: s.type === "continuation" ? "continuation" : "full",
          sessionIdInBundle: s.sessionId,
          fromEntryUuid: s.continuation?.fromEntryUuid ?? null,
          headEntryUuid: readLastEntryUuid(join(bundleStaging, "sessions", `${s.sessionId}.jsonl`)) ?? "",
          messageCount: s.messageCount, pushedAt, hasWorkspace,
        },
      });
      pushedSessions.push({ threadId, sessionId: s.sessionId, type: s.type === "continuation" ? "continuation" : "full" });
    }
    const sessionsNow = discoverSessions(opts.configDir, opts.projectPath).map((s) => ({
      sessionId: s.sessionId, slug: s.slug, summary: s.slug,
      headEntryUuid: readLastEntryUuid(s.jsonlPath) ?? "",
      messageCount: s.messageCount, lastActiveAt: s.lastActiveAt,
    }));
    const prior = await readMachineIndex(backend, local.projectId, machine.id);
    await writeMachineIndex(backend, buildIndexFile({
      projectId: local.projectId, machineId: machine.id, projectPath: opts.projectPath,
      sessions: sessionsNow, state: stateAfter, priorIndex: prior, newBundles: records,
      now: pushedAt,
    }));

    // Discovery aid (design §6.0): name what .gitignore kept out, so the user
    // can opt paths back in via hubinclude without having to know the file
    // exists. Manual pushes only — the auto-push hook must stay silent — and
    // only until a hubinclude exists, at which point the user has met the
    // mechanism and further nagging is noise. Existence, not pattern count, is
    // the test: a file holding only comments still means "I know about this".
    let ignoredNotCarried: string[] | undefined;
    if (!opts.quiet && gitScan().kind === "remotes" && !existsSync(hubincludePath(opts.projectPath))) {
      const ignored = listTopLevelIgnored(opts.projectPath);
      if (ignored.length > 0) ignoredNotCarried = ignored;
    }

    opts.onProgress?.({ phase: "hub-push", percent: 100 });
    return {
      success: true, command: "push", projectId: local.projectId,
      bundleId, pushedSessions, upToDate: false, hasWorkspace, warnings,
      ...(ignoredNotCarried ? { ignoredNotCarried } : {}),
      ...(carryMeta ? { carry: carryMeta } : {}),
    };
  } catch (e) {
    // A throw before the identity was committed leaves nothing behind, so it
    // keeps its existing behavior exactly: rethrow, and cli.ts turns it into an
    // ErrorResult. Past that line the link exists and the failure has to say so.
    if (!committedLink) throw e;
    return failedAfterLink(opts.projectPath, committedLink, bundleCommitted, e);
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    lock.release();
  }
}
