import type { HubBackend } from "./backend.js";
import {
  tombstoneDirPath, tombstonePath, type HubTombstoneJson,
} from "./layout.js";
import { createMachineNameLookup } from "./whereis.js";
import { isSafeSessionId } from "../manifest.js";
import type { HubProjectRetiredResult } from "../types.js";

/**
 * How long a tombstone must have existed before `hub delete` will destroy a
 * project's bytes. **48 hours.**
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE SHORTENING IT. It is the load-bearing comment of the whole
 * retirement feature.
 *
 * **A TOMBSTONE IS A NEW-START GATE, NOT A MUTUAL-EXCLUSION PRIMITIVE.** It
 * makes `hub pull` refuse, which stops a machine *beginning* work against a
 * project that is being retired. It does not, and cannot, do more than that.
 * Two windows stay open after it lands, and neither is closed by anything the
 * tombstone does:
 *
 *   1. **A pull already in flight keeps going.** The gate is evaluated once, in
 *      the pull's resolve stage; a pull that passed it a second earlier is
 *      fetching bundles, splicing transcripts and merging a workspace for as
 *      long as that takes. Nothing interrupts it, and nothing should — the
 *      alternative is aborting a half-applied transcript splice.
 *   2. **The tombstone may not have arrived.** The documented hub backend is a
 *      shared or SYNCED directory. A machine that has not received
 *      `tombstones/<id>.json` yet has not seen the assertion and legitimately
 *      starts a pull; on a synced folder that is the ordinary case, not an
 *      exotic one, because propagation waits for both machines to be online.
 *
 * **So the safety comes from two phases plus TIME, and this constant is the
 * time.** The window is sized against SYNC PROPAGATION — hours, not seconds —
 * and `hub delete` refuses while the tombstone is younger than it. Anybody
 * tempted to shorten this because "the pull is already blocked" has read the
 * tombstone as doing something it does not do.
 *
 * **Why 48 hours specifically.** The unit of propagation delay on a synced
 * folder is "when is that machine next switched on", not "how fast is the
 * network": a laptop closed on Friday receives nothing until Monday, and a
 * sync client that is running still has its own catch-up before a small file
 * in a rarely-touched directory lands. 48 hours covers a machine that is off
 * for a full day plus that catch-up, which is the smallest window that
 * survives an ordinary weekday absence. It is not derived from a measurement,
 * because there is nothing here to measure — the delay belongs to a sync client
 * this plugin does not control.
 *
 * **Its failure direction is the opposite of `LOCK_STALE_MS`'s, which is why it
 * errs LONG.** A lock stolen too early costs concurrency: two operations
 * overlap, and the residual is documented in `lock.ts`. A grace window that is
 * too short costs DATA: a machine that never saw the tombstone starts a pull
 * against bundles that are being deleted underneath it — a half-fetched
 * archive, or a chain whose base bundle vanished mid-walk. Doubling this
 * constant costs one user two more days of waiting, once. Halving it costs
 * somebody a session. When in doubt, longer.
 * ---------------------------------------------------------------------------
 */
export const RETIREMENT_GRACE_MS = 48 * 60 * 60 * 1000;

/** `RETIREMENT_GRACE_MS` in whole hours, for prose that has to name it. */
export const RETIREMENT_GRACE_HOURS = Math.round(RETIREMENT_GRACE_MS / (60 * 60 * 1000));

/**
 * Where a tombstone stands relative to the grace window.
 *
 * `remainingMs === null` means the recorded `retiredAt` could not be read as a
 * time at all, which is **not** "the window has passed": an unparseable
 * timestamp is an unknown age, and the only safe answer to an unknown age is to
 * keep refusing. Every caller treats `null` as "not eligible".
 */
export interface GraceState {
  eligibleAt: string | null;
  remainingMs: number | null;
  eligible: boolean;
}

export function graceState(retiredAt: string, nowMs: number): GraceState {
  const at = Date.parse(retiredAt);
  if (Number.isNaN(at)) return { eligibleAt: null, remainingMs: null, eligible: false };
  const eligibleAtMs = at + RETIREMENT_GRACE_MS;
  // A tombstone dated in the FUTURE (a clock that moved backwards, a hand-edited
  // file) yields a remaining time larger than the window rather than a negative
  // age that would race past the check. Clamping the other way — treating the
  // future as "already elapsed" — is the one arithmetic mistake here that
  // deletes data early.
  return {
    eligibleAt: new Date(eligibleAtMs).toISOString(),
    remainingMs: Math.max(0, eligibleAtMs - nowMs),
    eligible: nowMs >= eligibleAtMs,
  };
}

function parseTombstone(raw: Buffer, machineIdFromName: string): HubTombstoneJson | null {
  let parsed: HubTombstoneJson;
  try {
    parsed = JSON.parse(raw.toString()) as HubTombstoneJson;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (typeof parsed.retiredAt !== "string" || parsed.retiredAt.length === 0) return null;
  return {
    schemaVersion: 1,
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
    // THE FILENAME IS THE IDENTITY, exactly as for an index file (#28) — and
    // here it is not merely authoritative, it is the entire payload's meaning:
    // the file says "the machine that owns this file asserts retirement", and
    // the machine that owns `tombstones/<id>.json` is `<id>` by construction. A
    // disagreeing field is a copied or hand-edited file, never a second machine,
    // so it is overwritten rather than believed.
    machineId: machineIdFromName,
    retiredAt: parsed.retiredAt,
    reason: typeof parsed.reason === "string" && parsed.reason ? parsed.reason : null,
  };
}

/**
 * Every readable tombstone on this project.
 *
 * Costs one `list` (a single `stat` when the directory is absent, which is the
 * healthy case) plus one read per tombstone — which is why the pull can afford
 * to ask on every run.
 *
 * Skips what `readAllIndexes` skips and for the same measured reasons:
 * non-immediate children (a Syncthing `.stversions/` copy, a Dropbox conflict
 * directory), names that are not `.json` (ordinary filesystem litter), and names
 * that are not path-safe ids. An unreadable or malformed tombstone is skipped
 * silently — it is an assertion nobody can act on, and the caller's next move
 * (refuse a pull, refuse a delete) must not depend on prose.
 */
export async function readTombstones(
  backend: HubBackend,
  projectId: string
): Promise<HubTombstoneJson[]> {
  const dir = tombstoneDirPath(projectId);
  const prefix = `${dir}/`;
  const out: HubTombstoneJson[] = [];
  const seen = new Set<string>();
  for (const file of await backend.list(dir)) {
    if (!file.startsWith(prefix)) continue;
    const name = file.slice(prefix.length);
    if (name.includes("/")) continue;
    if (!name.endsWith(".json")) continue;
    const machineId = name.slice(0, -".json".length);
    if (!isSafeSessionId(machineId)) continue;
    if (seen.has(machineId)) continue;
    seen.add(machineId);
    let parsed: HubTombstoneJson | null;
    try {
      parsed = parseTombstone(await backend.read(file), machineId);
    } catch {
      continue; // not landed yet, unreadable — no assertion to act on
    }
    if (parsed) out.push(parsed);
  }
  return out;
}

/** This project's tombstone written by ONE machine, or null. */
export async function readTombstone(
  backend: HubBackend,
  projectId: string,
  machineId: string
): Promise<HubTombstoneJson | null> {
  const p = tombstonePath(projectId, machineId);
  if (!(await backend.exists(p))) return null;
  try {
    return parseTombstone(await backend.read(p), machineId);
  } catch {
    return null;
  }
}

export async function writeTombstone(
  backend: HubBackend,
  tombstone: HubTombstoneJson
): Promise<void> {
  await backend.writeAtomic(
    tombstonePath(tombstone.projectId, tombstone.machineId),
    JSON.stringify(tombstone, null, 2) + "\n"
  );
}

/**
 * The tombstone a reader should act on when several exist: the OLDEST, by
 * `retiredAt`.
 *
 * Oldest rather than newest because the only number a reader does anything with
 * is the grace deadline, and the deadline that matters is the first one to
 * arrive — it is the machine that asserted earliest whose `hub delete` becomes
 * eligible earliest. An unparseable `retiredAt` sorts last (it can authorize
 * nothing) but is still returned when it is all there is, so the pull gate still
 * fires on it.
 */
export function primaryTombstone(tombstones: HubTombstoneJson[]): HubTombstoneJson | null {
  let best: HubTombstoneJson | null = null;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const t of tombstones) {
    const at = Date.parse(t.retiredAt);
    const key = Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
    if (best === null || key < bestAt) {
      best = t;
      bestAt = key;
    }
  }
  return best;
}

/**
 * Is this project retired, as far as this machine can see?
 *
 * **Deliberately does not verify that the asserting machine had the authority to
 * write it** (only the project's creator may, and `hub retire` enforces that at
 * the WRITE). Two reasons. The check would cost a `project.json` read on every
 * pull of every project, on a share, for a file the ordinary pull never opens.
 * And its failure direction is benign: an unauthorized tombstone makes a pull
 * refuse, which loses nothing — no data moves, the refusal names the machine
 * that asserted it, and `--ignore-retirement` pulls anyway. The authority check
 * lives where being wrong is expensive instead: `hub delete`, which destroys
 * bytes, reads `project.json` and refuses for anyone but the owner.
 */
export async function findRetirement(
  backend: HubBackend,
  projectId: string
): Promise<HubTombstoneJson | null> {
  return primaryTombstone(await readTombstones(backend, projectId));
}

/** `2026-08-17T09:00:00.000Z` -> `2026-08-17 09:00 UTC`, for prose. */
export function formatStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The refusal a pull of a retired project returns.
 *
 * **"Refused" is the easy half; the user's next question is "why, and what do I
 * do", and the honest answer differs by who asserted it** — so the suggestion
 * has two arms rather than one generic sentence:
 *
 * - **This machine asserted it.** The remedy is entirely in the user's hands:
 *   retract it, or pull past it once. They are also the only person who can
 *   delete the project, so the deadline is stated as something they control.
 * - **Another machine asserted it.** Retraction is ASYMMETRIC — only the
 *   asserting machine can take its own assertion back — so telling this user to
 *   "un-retire it" would be telling them to do something they cannot. What they
 *   *can* do is (a) be told that nothing local changed, (b) get their work off
 *   the hub with `--ignore-retirement` before the bytes go, and (c) stop this
 *   directory asking again, with `hub unlink`. The deadline is the important
 *   one here, because it is the moment their unpulled work can disappear.
 *
 * Every hub-supplied string it interpolates is a machine NAME (through
 * `createMachineNameLookup`, which is memoized and swallows an absent record) or
 * a timestamp; the free-text `reason` is echoed, quoted, because it is the one
 * thing the retiring user wrote for this exact audience.
 */
export async function retiredPullRefusal(input: {
  backend: HubBackend;
  projectId: string;
  tombstone: HubTombstoneJson;
  thisMachineId: string;
  nowMs: number;
}): Promise<HubProjectRetiredResult> {
  const { backend, projectId, tombstone, thisMachineId, nowMs } = input;
  const mine = tombstone.machineId === thisMachineId;
  const name = await createMachineNameLookup(backend)(tombstone.machineId);
  const grace = graceState(tombstone.retiredAt, nowMs);
  const when = formatStamp(tombstone.retiredAt);
  const why = tombstone.reason ? ` (reason: ${JSON.stringify(tombstone.reason)})` : "";
  const deadline = grace.eligibleAt
    ? formatStamp(grace.eligibleAt)
    : `${RETIREMENT_GRACE_HOURS}h after it was retired`;
  // QUOTED, because it comes off the hub (`machines/<id>.json`, written by
  // whichever machine that is) — the rule `readMachineIndex` states for every
  // hub-supplied string it echoes. "another machine" is ours and is not.
  const who = name === null ? "Another machine" : JSON.stringify(name);

  const suggestion = mine
    ? `You retired this project from this machine on ${when}${why}. Nothing was pulled and nothing on this machine changed. ` +
      `Run \`sesh-mover hub retire --undo\` to take that assertion back, or \`sesh-mover pull --ignore-retirement\` to pull this once without retracting it. ` +
      `Every bundle is still on the hub: \`sesh-mover hub delete\` removes them permanently, and refuses until ${deadline}.`
    : `${who} retired this project on ${when}${why}. Nothing was pulled, and nothing on this machine changed — your own sessions are untouched, because retirement applies to the shared hub copy only. ` +
      `Only the machine that asserted it can take it back, so if this is unexpected, that is where to ask. ` +
      `If you still need work that is on the hub, \`sesh-mover pull --ignore-retirement\` fetches it anyway — do that before ${deadline}, after which that machine may delete this project's bundles from the hub for good. ` +
      `If you are done with this project here, \`sesh-mover hub unlink\` removes this directory's link and disarms its session-end auto-push.`;

  return {
    success: false,
    command: "pull",
    reason: "project-retired",
    projectId,
    retiredByMachineId: tombstone.machineId,
    retiredByMachineName: name,
    retiredByThisMachine: mine,
    retiredAt: tombstone.retiredAt,
    retirementReason: tombstone.reason,
    deleteEligibleAt: grace.eligibleAt,
    suggestion,
  };
}
