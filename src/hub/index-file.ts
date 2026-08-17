import type { HubBackend } from "./backend.js";
import { indexPath, indexDirPath, assertHubRelPath, type HubBundleRecord, type HubIndexJson, type HubThreadEntry } from "./layout.js";
import { getThreadId } from "../sync-state.js";
import { isSafeSessionId } from "../manifest.js";
import type { SyncState } from "../types.js";

/**
 * What this projection reads out of a prior index: every `HubThreadEntry` field
 * EXCEPT `summary`.
 *
 * The omission is the enforcement, not documentation of one. `summary` is
 * derived from `slug` inside `buildIndexFile` and nowhere else, so a caller that
 * wants to hand one in — `hub reindex`'s synthetic prior did, straight out of a
 * bundle manifest, which is where the message excerpt lived — has no field to
 * hand it in through.
 *
 * A real `HubIndexJson` read off the hub satisfies this structurally, so
 * `readMachineIndex`'s return value is passed unchanged.
 */
export type PriorThreadEntry = Omit<HubThreadEntry, "summary">;

/**
 * The prior index as a projection INPUT.
 *
 * Only `threads` is read, which is also why `hub reindex` can hand over a
 * synthetic one without inventing an index envelope (`machineId`, `updatedAt`,
 * …) that the rebuild would then have to keep consistent with the real thing.
 */
export interface PriorIndexView {
  threads: Record<string, PriorThreadEntry>;
}

export interface IndexBuildInputs {
  projectId: string;
  machineId: string;
  projectPath: string;
  /**
   * The project's live local sessions.
   *
   * NO `summary` FIELD, deliberately — see the block above `buildIndexFile`.
   * Every caller used to pass `summary: s.slug` here, three copies of one
   * decision, and the fourth writer (through `priorIndex`) passed something
   * else entirely.
   */
  sessions: Array<{
    sessionId: string; slug: string;
    headEntryUuid: string; messageCount: number; lastActiveAt: string;
  }>;
  state: SyncState;
  priorIndex: PriorIndexView | null;
  newBundles: Array<{ threadId: string; record: HubBundleRecord }>;
  now: string;
}

// Pure projection: local sessions (with thread mappings) + prior bundle
// history + this push's new bundle records. Sessions never pushed (no thread
// mapping) are omitted — the hub only knows what was shared with it.
//
// ---------------------------------------------------------------------------
// `HubThreadEntry.summary` IS WRITTEN HERE, AND NOWHERE ELSE — and what it
// holds is the SLUG.
//
// An index file is plaintext by design (it is the one thing a hub reader has to
// be able to project without opening a bundle), so whatever it carries is
// readable by anything with access to the shared directory. The field's NAME
// promised a session summary; three of its four writers wrote `slug` anyway,
// and the fourth — `hub reindex`, building a synthetic prior out of bundle
// manifests — wrote a genuine `SessionManifest.summary`: up to 100 characters
// of the first user message. Not an exotic path either. `discovery.ts` falls
// back to the session id when a transcript carries no slug, and
// `extractSummaryFromFile` rejects a UUID slug, so an untitled session's
// manifest summary is an excerpt by construction.
//
// Deriving the value here instead of accepting it makes "one writer" a property
// of the TYPE rather than a convention three call sites happened to share.
// Neither door can carry an excerpt now:
//
//   - the SESSIONS door has no `summary` field to supply (`IndexBuildInputs`);
//   - the PRIOR-INDEX door is overwritten from the entry's own `slug` below,
//     which SCRUBS an index an older version poisoned rather than copying it
//     forward. That mattered: a poisoned entry survived every later ordinary
//     push and pull, because both read the prior index back and carried a
//     vanished thread's entry over verbatim. There was no self-healing.
//
// The scrub cannot discard anything legitimate. The only value that has ever
// differed from `slug` here is the excerpt, and the replacement is not a
// disclosure of its own: `slug` is Claude Code's own session title (or the
// session id), it is already published in the very same entry, and it is
// written from the same source on the same line.
//
// LIMIT, and it is structural rather than an oversight: this scrubs THIS
// MACHINE'S OWN index. Per-machine ownership means a machine never writes
// another machine's index file, so every machine that has ever pushed has to
// run one push, pull or `hub reindex` of its own to clean its own copy. Machine
// B cannot fix machine A's, and nothing here should try.
// ---------------------------------------------------------------------------
export function buildIndexFile(inputs: IndexBuildInputs): HubIndexJson {
  // NO PROTOTYPE, and it is enforcement rather than tidiness. Every `threadId`
  // below comes from `getThreadId`, i.e. from this machine's sync-state, where a
  // pull ADOPTS whatever thread id a foreign index published — and the only
  // filter that id passed is `isSafeSessionId`, which accepts `__proto__`,
  // `constructor` and every other `Object.prototype` name. On a plain `{}` each
  // of the three `threads[threadId]` guards below reads a value that is already
  // "present" (`Object.prototype`, or the `Object` constructor), so an existing
  // thread is compared against a non-entry, a rebuilt one is skipped as a
  // duplicate, and `threads["__proto__"] = …` re-parents the map instead of
  // adding to it — after which `JSON.stringify` publishes an index with the
  // thread simply missing.
  const threads: Record<string, HubThreadEntry> = Object.create(null);

  // Same hazard on the PRIOR index, which is a foreign-shaped record read off
  // the hub. `inputs.priorIndex?.threads[threadId]?.bundles.slice()` looked
  // guarded and was not: for a prototype key the optional chain finds a truthy
  // value whose `.bundles` is `undefined`, and the `.slice()` threw a raw
  // `TypeError` straight out of `hub push` (measured against shipped `dist/`).
  // An own-property read is the whole fix — `Object.hasOwn` rather than
  // rebuilding the map, because this projection may not mutate its inputs.
  const priorThreads = inputs.priorIndex?.threads;
  const priorBundles = (threadId: string): HubBundleRecord[] =>
    priorThreads && Object.hasOwn(priorThreads, threadId)
      ? priorThreads[threadId].bundles.slice()
      : [];

  for (const s of inputs.sessions) {
    const threadId = getThreadId(inputs.state, s.sessionId);
    if (!threadId) continue;
    // Multiple local session files can map to the same thread — a
    // continuation pull mints a brand-new local file thread-mapped onto a
    // thread an earlier (now older) local file already represented (see
    // hub/pull.ts's setThreadId call). Keep whichever is genuinely more
    // recent; never just "whichever appears last in inputs.sessions" —
    // discoverSessions happens to return most-recent-first, so blindly
    // overwriting would silently keep the OLDEST one and report a stale head
    // for a thread this machine just updated.
    const existing = threads[threadId];
    if (existing) {
      const held = new Date(existing.lastActiveAt).getTime();
      const candidate = new Date(s.lastActiveAt).getTime();
      // On an EXACT tie, `>=` kept whichever session `inputs.sessions`
      // happened to yield first — i.e. discoverSessions' order, which is a
      // directory listing, not a decision. Two sessions carrying the same
      // lastActiveAt is not exotic: a pull splices a continuation onto a new
      // local file and both files' mtimes land in the same millisecond.
      // sessionId is the secondary key because it is stable, present on every
      // session, and independent of listing order; lower wins, matching the
      // arbitrary-but-stable convention threads.ts uses for machineId.
      //
      // Deliberately NOT newerThreadCopy from threads.ts, despite the shape
      // rhyming: its second key is messageCount, and here the two candidates
      // are the same thread's base and its continuation — the continuation is
      // the one to keep, and it can legitimately carry FEWER messages than the
      // base it was spliced from, so that key would prefer the stale copy.
      if (held > candidate || (held === candidate && existing.localSessionId <= s.sessionId)) {
        continue;
      }
    }
    threads[threadId] = {
      localSessionId: s.sessionId,
      slug: s.slug,
      // Derived, never supplied — the sessions door. See the block above.
      summary: s.slug,
      headEntryUuid: s.headEntryUuid,
      messageCount: s.messageCount,
      lastActiveAt: s.lastActiveAt,
      bundles: priorBundles(threadId),
    };
  }
  // Threads whose local session vanished (deleted locally) keep their bundle
  // history from the prior index — the hub copy is still pullable elsewhere.
  //
  // This is the ONLY door a summary an older version wrote can come back
  // through, and `summary: entry.slug` (after the spread, so it wins over the
  // copied key) is what closes it. Everything else about the entry is carried
  // over verbatim, as before.
  if (inputs.priorIndex) {
    for (const [threadId, entry] of Object.entries(inputs.priorIndex.threads)) {
      if (!threads[threadId]) {
        threads[threadId] = { ...entry, summary: entry.slug, bundles: entry.bundles.slice() };
      }
    }
  }
  for (const nb of inputs.newBundles) {
    if (!threads[nb.threadId]) continue; // defensive: record must belong to a known thread
    threads[nb.threadId].bundles.push(nb.record);
  }

  return {
    schemaVersion: 1,
    agent: "claude-code",
    projectId: inputs.projectId,
    machineId: inputs.machineId,
    updatedAt: inputs.now,
    projectPath: inputs.projectPath,
    threads,
  };
}

/**
 * `assertHubRelPath` as a predicate.
 *
 * The consumer of `HubBundleRecord.file` is the backend: hub/pull.ts hands it
 * straight to `backend.exists(record.file)` / `backend.readStream(record.file)`,
 * and every HubBackend method runs it through `assertHubRelPath` (hub/backend.ts's
 * `abs`). Wrapping that exact function — rather than restating the rule — is what
 * makes "dropped at parse time" and "would have thrown at use time" the same set
 * of strings, including the non-string values on which it throws a TypeError.
 */
function isSafeHubRelPath(value: unknown): boolean {
  try {
    assertHubRelPath(value as string);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read one machine's index file.
 *
 * `null` means the file is absent or structurally unusable (missing, not JSON,
 * wrong schemaVersion, no threads map, or an identity that disagrees with its
 * own filename — see below). Everything finer-grained DEGRADES: a record whose
 * ids or `file` path are unsafe is dropped and reported through `warnings`, and
 * the rest of the index survives.
 *
 * That degradation is the point. `file` was never validated at all, so a single
 * poisoned record reached `backend.exists(record.file)` in hub/pull.ts and threw
 * `assertHubRelPath`'s raw internal message straight out of `hubPull` — one bad
 * record killed the pull and took every other bundle in the index with it. And
 * the ids that WERE checked did not degrade either: `assertSafeHubId` threw
 * inside the try, the catch returned null, and the whole index was discarded as
 * "unreadable". Both are the same mistake — the blast radius of a poisoned
 * record must be that record.
 *
 * THE FILENAME IS THE IDENTITY; A DISAGREEING `machineId` FIELD IS DAMAGE
 * (#28). Two things encode which machine wrote an index — the path
 * `index/<machineId>.json` and the `machineId` INSIDE it — and they could
 * disagree. The filename wins: it is what this machine controls, what
 * `indexPath` builds, what `readAllIndexes` dedupes on, and the only one of the
 * two that has passed `assertSafeHubId` (via `indexPath`) by the time the file
 * is read. Per-machine ownership is what makes that a rule rather than a
 * preference — `index/<id>.json` is BY CONSTRUCTION the file machine `<id>`
 * owns and the only one it ever writes, so a content field naming someone else
 * is a copied, hand-edited or corrupt file, never a legitimate state.
 *
 * SKIP-AND-WARN, not fatal, and not a repair. Not fatal because a sync client's
 * conflict copy must not turn into a failed pull, and because it is the same
 * degradation this reader already applies to hostile input — the difference is
 * that here the poisoned unit is the whole FILE, since its identity is what is
 * in question. Not a repair (overwriting the field from the filename) because
 * this machine does not own that file, and a silent rewrite in memory would
 * publish an id no writer stands behind. Fatal-on-mismatch is the right answer
 * once a second person's machine can write to this hub; that is not today.
 *
 * WHAT IT BUYS DOWNSTREAM: `HubIndexJson.machineId`, and therefore
 * `ThreadCopy.machineId` in threads.ts, is filename-reconciled for every index
 * that reached a consumer through this function — which is every one of them in
 * production (`readAllIndexes` is the only door). Two copies of one thread can
 * no longer carry the same `machineId` from two different files, and an
 * internal `machineId` can no longer be a path-unsafe string. Both of those had
 * accommodations built for them; see the notes in threads.ts, which say why
 * they stay.
 *
 * `warnings` is optional so the existing callers (pull.ts, push.ts, reindex.ts)
 * that only want the index need no change; readAllIndexes passes its own array.
 */
export async function readMachineIndex(
  backend: HubBackend,
  projectId: string,
  machineId: string,
  warnings?: string[]
): Promise<HubIndexJson | null> {
  const p = indexPath(projectId, machineId);
  if (!(await backend.exists(p))) return null;
  let parsed: HubIndexJson;
  try {
    parsed = JSON.parse((await backend.read(p)).toString()) as HubIndexJson;
  } catch {
    return null;
  }
  const where = `index for machine ${machineId}`;
  if (parsed === null || typeof parsed !== "object" || parsed.schemaVersion !== 1) return null;
  // The identity check, and the ONE null return that explains itself in
  // `warnings` (readAllIndexes leans on exactly that — see its call site).
  // `machineId` is the filename-derived id and has passed assertSafeHubId
  // inside indexPath, so it is safe to echo bare; the declared one has passed
  // nothing and is quoted like every other hub-supplied string.
  if (parsed.machineId !== machineId) {
    warnings?.push(
      `${where}: the file declares machineId ${JSON.stringify(parsed.machineId)} — skipped; ` +
        `an index file's NAME is the authoritative id (per-machine ownership), so a disagreement ` +
        `means a damaged index or a sync client's conflict copy, not a second machine.`
    );
    return null;
  }
  if (parsed.threads === null || typeof parsed.threads !== "object") return null;
  // Object.entries snapshots, so deleting from parsed.threads while iterating
  // it is safe.
  for (const [threadId, entry] of Object.entries(parsed.threads)) {
    if (!isSafeSessionId(threadId)) {
      // The poisoned unit here is the thread key itself, so the thread is what
      // gets dropped. Quote every hub-supplied string into a message (as
      // assertSafeHubId does) — JSON.stringify escapes the control characters
      // that make a terminal render a lie.
      delete parsed.threads[threadId];
      warnings?.push(`${where}: thread ${JSON.stringify(threadId)} has an unsafe id — dropped.`);
      continue;
    }
    if (entry === null || typeof entry !== "object" || !Array.isArray(entry.bundles)) {
      delete parsed.threads[threadId];
      warnings?.push(`${where}: thread ${JSON.stringify(threadId)} is malformed — dropped.`);
      continue;
    }
    entry.bundles = entry.bundles.filter((b: HubBundleRecord, i: number) => {
      const inThread = `${where}, thread ${JSON.stringify(threadId)}`;
      if (b === null || typeof b !== "object") {
        warnings?.push(`${inThread}: bundle #${i + 1} is malformed — dropped.`);
        return false;
      }
      // Identify the record by its bundleId when that id is itself safe to
      // echo, by position otherwise — a record is dropped precisely because
      // one of its fields is untrustworthy, so it must not be the field the
      // message leans on.
      const named = isSafeSessionId(b.bundleId)
        ? `bundle ${JSON.stringify(b.bundleId)} (#${i + 1})`
        : `bundle #${i + 1}`;
      const bad =
        !isSafeSessionId(b.bundleId) ? `an unsafe bundleId ${JSON.stringify(b.bundleId)}`
        : !isSafeSessionId(b.sessionIdInBundle) ? `an unsafe sessionIdInBundle ${JSON.stringify(b.sessionIdInBundle)}`
        : !isSafeHubRelPath(b.file) ? `an unsafe file path ${JSON.stringify(b.file)}`
        : null;
      if (bad === null) return true;
      warnings?.push(
        `${inThread}: ${named} has ${bad} — dropped; the rest of the index is still usable.`
      );
      return false;
    });
  }
  return parsed;
}

export async function writeMachineIndex(backend: HubBackend, index: HubIndexJson): Promise<void> {
  await backend.writeAtomic(
    indexPath(index.projectId, index.machineId),
    JSON.stringify(index, null, 2) + "\n"
  );
}

export async function readAllIndexes(
  backend: HubBackend,
  projectId: string
): Promise<{ indexes: HubIndexJson[]; warnings: string[] }> {
  const warnings: string[] = [];
  const indexes: HubIndexJson[] = [];
  const dir = indexDirPath(projectId);
  const prefix = `${dir}/`;
  const seen = new Set<string>();
  for (const file of await backend.list(dir)) {
    // IMMEDIATE children only. backend.list walks RECURSIVELY, but an index
    // file is always exactly `index/<machineId>.json` by construction (see
    // layout.ts's indexPath), so nothing nested can be one.
    //
    // The hub is documented as a shared or synced directory, which makes
    // nested content the EXPECTED case rather than a hostile one: Syncthing
    // parks superseded copies in `index/.stversions/<machineId>.json`, Dropbox
    // writes `index/<name>'s conflicted copy 2026-08-03/<machineId>.json`.
    // Recursing into those made the same machine appear twice, as two
    // independent copies, with no warning anywhere — and readAllIndexes feeds
    // resolveThreads, so a machine's own stale backup could be presented as a
    // rival copy of the user's latest work, and be pulled as one.
    if (!file.startsWith(prefix)) continue;
    const name = file.slice(prefix.length);
    if (name.includes("/")) continue;
    // A name that does not end in `.json` was never written by this tool
    // (indexPath always appends it), so it is not a corrupt index — it is
    // ordinary filesystem litter: `.DS_Store`, `Thumbs.db`, a Syncthing
    // `~syncthing~…tmp`, an editor swap file, a README someone dropped in.
    // Skip it SILENTLY, on purpose. A warning here fires on every pull and
    // every whereis against a perfectly healthy hub, and a warning that always
    // fires is one users learn to skim past — which costs them the warning
    // that matters (a genuinely corrupt index). It also retires a small lie:
    // the old code stripped a `.json` suffix that was not there and reported
    // "index file for machine README is unreadable", inventing a machine.
    if (!name.endsWith(".json")) continue;
    const machineId = name.slice(0, -".json".length);
    // Containment: a hostile/corrupt filename like ".json" (machineId "")
    // or "..json" (machineId ".") would make indexPath's assertSafeHubId
    // throw and wedge the whole-project read that whereis/pull depend on.
    // Skip + warn instead, naming the FILE (the derived id is the unsafe
    // part, so never echo it into a message as if it were an id).
    if (!isSafeSessionId(machineId)) {
      warnings.push(`index file ${file} has an unsafe name — skipped.`);
      continue;
    }
    // Defensive: with the immediate-children constraint above, a filesystem
    // backend cannot yield two entries for one machineId (directory names are
    // unique). A future backend whose `list` is a prefix listing over an
    // object store, with no real directories, can. Two entries for one machine
    // are two copies of ONE machine's index either way, and resolveThreads
    // must never count them as two machines' worth of copies.
    if (seen.has(machineId)) continue;
    seen.add(machineId);
    // ONE MESSAGE PER FILE. `readMachineIndex` returns null for several
    // reasons and explains exactly one of them (the filename/content identity
    // disagreement, #28) — everything else it rejects whole is genuinely just
    // "unreadable". The record-level warnings it pushes always come with a
    // non-null index, so in THIS branch a grown array means it named the
    // cause, and appending the generic line after it would report one damaged
    // file twice and describe a perfectly readable file as unreadable.
    const explained = warnings.length;
    const index = await readMachineIndex(backend, projectId, machineId, warnings);
    if (index) indexes.push(index);
    else if (warnings.length === explained) {
      warnings.push(`index file for machine ${machineId} is unreadable (corrupt or not yet synced) — skipped.`);
    }
  }
  return { indexes, warnings };
}
