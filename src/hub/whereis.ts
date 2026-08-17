import { join } from "node:path";
import { createFsBackend, type HubBackend } from "./backend.js";
import { machinePath, type HubMachineJson } from "./layout.js";
import { readLocalProjectId, resolveProjectIdentity } from "./identity.js";
import { describeHubUnreachable, probeHubReachable } from "./preflight.js";
import { readAllIndexes } from "./index-file.js";
// #44: `pullNeeded` is the same question `pull` asks, so it goes through the
// same function. The import direction makes this module and pull-select
// mutually referential (pull-select takes `shapeThreads` and
// `createMachineNameLookup` from here), which is safe and deliberate rather
// than accidental: both sides are hoisted `export function` declarations and
// neither module calls the other while its own body is evaluating, so the ESM
// cycle resolves before either is invoked. The alternative was a fourth copy
// of a selection rule that has already disagreed with itself once.
import { planThreadPull, pullSourceFor, sourcedKey } from "./threads.js";
import { resolveThreads, findUnfetchableBundles, type ResolvedThread } from "./threads.js";
import { loadOrCreateMachineId } from "../machine.js";
import { encodeProjectPath } from "../platform.js";
import { peekSyncState } from "../sync-state.js";
import type { SyncState, WhereisResult, WhereisThread } from "../types.js";

/**
 * Memoized `machines/<id>.json` name lookup, `null` for anything unreadable.
 *
 * SECURITY (Task 6 review, binding): the machineId field INSIDE a parsed index
 * file is never validated by readMachineIndex — only ids used in ITS OWN path
 * building (derived from the filename) are. A hostile index file can therefore
 * declare an internal machineId that is unsafe as a path component (e.g.
 * "../evil"). resolveThreads copies that internal field verbatim into
 * ThreadCopy.machineId, so this helper — which calls machinePath(id) — must be
 * the one to contain the resulting throw (machinePath asserts and throws on
 * unsafe ids), not let it escape and wedge the whole command. Every caller
 * that turns a hub-supplied machine id into a display name goes through here.
 */
export function createMachineNameLookup(
  backend: HubBackend
): (id: string) => Promise<string | null> {
  const names = new Map<string, string | null>();
  return async (id: string): Promise<string | null> => {
    if (!names.has(id)) {
      try {
        const raw = await backend.read(machinePath(id));
        names.set(id, (JSON.parse(raw.toString()) as HubMachineJson).name);
      } catch {
        names.set(id, null);
      }
    }
    return names.get(id)!;
  };
}

// Shared thread-shaping used by both whereis and pull's list mode (pull needs
// the identical WhereisThread[] shape when it returns a HubPullListResult).
//
// `state` is this machine's peer bookkeeping for the project, and it is what
// keeps `unfetchableBundles` from crying wolf: without it every thread whose
// history this machine already holds in full would still look split. Read it
// with peekSyncState — whereis must not write.
//
// `targetProjectDir` (`<configDir>/projects/<encoded project path>`) is the
// second half of that bookkeeping and arrived with #44: `pullSourceFor` trusts
// a receipt only while the local session file it names still exists, so
// answering "would a pull fetch anything" needs to know where a local session
// file WOULD be. It is only ever probed for existence; nothing is read or
// written there.
export async function shapeThreads(
  backend: HubBackend,
  resolved: ResolvedThread[],
  meId: string,
  state: SyncState,
  targetProjectDir: string
): Promise<WhereisThread[]> {
  const machineName = createMachineNameLookup(backend);

  const threads: WhereisThread[] = [];
  for (const t of resolved) {
    const localEntry = t.copies.find((c) => c.machineId === meId) ?? null;
    // HEAD EQUALITY, AND ONLY AS A DISPLAY FIELD. It says "the newest head the
    // hub knows of is the one my local file ends at" — a true and useful thing
    // to show, and NOT the question of whether a pull would fetch something
    // (#44). It fed `pullNeeded` until this fix, which is how `whereis` came to
    // report `pullNeeded: false` for a thread `pull --thread <id>` fetched.
    const current = localEntry !== null && localEntry.headEntryUuid === t.latest.headEntryUuid;
    // The pull's own selector, once, reused twice below — `pullNeeded` is
    // whether it found a source at all, and the plan it implies is what keeps
    // the disclosure beside it honest.
    const source = pullSourceFor(t, state, { machineId: meId, targetProjectDir });
    // MINUS WHAT A PULL WOULD ACTUALLY FETCH (#35). The heuristic answers "which
    // bundles do other machines list that the RESOLVED machine's list does not
    // offer", and chain assembly made most of those fetchable — so left
    // unsubtracted this field would tell a user a bundle is out of reach that
    // `pull` fetches on the next line. Same subtraction, same key builder, as
    // the select stage's: `whereis` exists to answer `pull`'s question before
    // the user runs it, so a second opinion here is a defect by construction.
    const fetching = new Set(
      source
        ? planThreadPull({
            thread: t, source, state, machineId: meId, targetProjectDir,
          }).needed.map((n) => sourcedKey(n.machineId, n.record.bundleId))
        : []
    );
    const unfetchable = findUnfetchableBundles({
      copies: t.copies,
      sourceMachineId: t.latest.machineId,
      localMachineId: meId,
      state,
    })
      .map((u) => ({
        machineId: u.machineId,
        bundleIds: u.bundleIds.filter((id) => !fetching.has(sourcedKey(u.machineId, id))),
      }))
      .filter((u) => u.bundleIds.length > 0);
    threads.push({
      threadId: t.threadId,
      slug: t.slug,
      summary: t.summary,
      latest: {
        machineId: t.latest.machineId,
        machineName: await machineName(t.latest.machineId),
        lastActiveAt: t.latest.lastActiveAt,
        messageCount: t.latest.messageCount,
      },
      copies: await Promise.all(
        t.copies.map(async (c) => ({
          machineId: c.machineId,
          machineName: await machineName(c.machineId),
          localSessionId: c.localSessionId,
          lastActiveAt: c.lastActiveAt,
          messageCount: c.messageCount,
          headEntryUuid: c.headEntryUuid,
        }))
      ),
      localCopy: localEntry
        ? { localSessionId: localEntry.localSessionId, headEntryUuid: localEntry.headEntryUuid, current }
        : null,
      // The pull's own selector, not a restatement of it: this is the field the
      // SessionStart notice filters on and the field the skill layer turns into
      // "run /sesh-mover:pull", so it has to be true exactly when a pull of
      // this thread would fetch a bundle. `pullSourceFor` covers the case where
      // the newest copy is ours too (a peer can still list something we never
      // received), and since #35 it asks the ASSEMBLED chain rather than one
      // machine's list — so this field went cross-machine-correct with no edit
      // here, which is the point of there being one selector.
      pullNeeded: source !== undefined,
      unfetchableBundles:
        unfetchable.length > 0
          ? await Promise.all(
              unfetchable.map(async (u) => ({
                machineId: u.machineId,
                machineName: await machineName(u.machineId),
                bundleIds: u.bundleIds,
              }))
            )
          : undefined,
    });
  }
  return threads;
}

// Read-only cross-machine thread view. Never mints a hub project and never
// links this project directory to one — linking happens on push/pull, not
// on a read. An unresolved identity (no local link, or only a git-remote
// "match") reports linked:false with candidates instead of guessing.
//
// AN UNREACHABLE HUB IS REPORTED, NOT REFUSED, and the precedent is this
// function's own `linked: false` (see HubUnlinkedResult's note on why `whereis`
// is not a member of it): a read answers with fields, not with a refusal, and
// `commands/whereis.md` plus the skill doc both promise there is no error case
// to catch here. Push and pull refuse the same condition because they were
// about to write; nothing here writes.
//
// What that costs if it is left implicit is measured rather than theoretical.
// `backend.list` returns `[]` for a directory that is not there, so on an
// unmounted share `readAllIndexes` found no indexes, `resolveThreads` shaped no
// threads, and a linked project came back `linked: true, threads: []` —
// character-for-character what a linked project nobody has pushed yet returns.
// The SessionStart notice reads exactly this result, so it also went quiet for
// the one reason it should have been loudest about.
export async function hubWhereis(opts: {
  configDir: string;
  projectPath: string;
  hubPath: string;
}): Promise<WhereisResult> {
  const backend = createFsBackend(opts.hubPath);
  const warnings: string[] = [];

  const probe = await probeHubReachable(opts.hubPath, backend);
  if (probe.state !== "ok") {
    // `linked` still answers, because it is a LOCAL fact — the presence of
    // `.sesh-mover-project.json` — and withholding it would lose the one thing
    // this result can still say truthfully. `readLocalProjectId` rather than
    // `resolveProjectIdentity`: the latter's other two arms are decided by
    // listing the hub's projects, which is the read that just failed.
    const local = readLocalProjectId(opts.projectPath);
    warnings.push(describeHubUnreachable(probe.state));
    warnings.push(
      "No thread information could be read, so the empty thread list here means UNKNOWN rather than none — this project may well have threads on the hub. The link state below is a local fact and says nothing about whether the hub still has that project."
    );
    return {
      success: true,
      command: "whereis",
      linked: local !== null,
      projectId: local?.projectId ?? null,
      // NO `linkCandidates` KEY AT ALL, not an empty one. An empty pick list is
      // documented to mean "this hub lists no projects", and the projects
      // listing is precisely the read that failed — an absent field is the only
      // honest spelling of "could not ask".
      threads: [],
      reachable: false,
      hubState: probe.state,
      warnings,
    };
  }

  const resolution = await resolveProjectIdentity(backend, opts.projectPath);
  if (resolution.kind !== "linked") {
    const candidates =
      resolution.kind === "match"
        ? [
            {
              projectId: resolution.hubProject.projectId,
              name: resolution.hubProject.name,
              gitRemotes: resolution.hubProject.matchers.gitRemotes,
            },
          ]
        : resolution.candidates;
    if (resolution.kind === "match") {
      warnings.push(
        `This project's git remote matches hub project "${resolution.hubProject.name}" — run push or pull to link it.`
      );
    }
    return {
      success: true,
      command: "whereis",
      linked: false,
      projectId: null,
      linkCandidates: candidates,
      threads: [],
      reachable: true,
      hubState: "ok",
      warnings,
    };
  }

  const projectId = resolution.local.projectId;
  const { indexes, warnings: indexWarnings } = await readAllIndexes(backend, projectId);
  warnings.push(...indexWarnings);
  const resolved = resolveThreads(indexes);

  const me = loadOrCreateMachineId();
  // The same path `hubPull` builds for the project it is about (pull.ts's
  // `targetProjectDir`), so `pullNeeded` and the pull agree about which local
  // session files exist. `configDir` was already on this options object and
  // unused; this is what it is for.
  const targetProjectDir = join(
    opts.configDir, "projects", encodeProjectPath(opts.projectPath)
  );
  const threads = await shapeThreads(
    backend, resolved, me.id, peekSyncState(opts.projectPath), targetProjectDir
  );

  return {
    success: true, command: "whereis", linked: true, projectId, threads,
    reachable: true, hubState: "ok", warnings,
  };
}
