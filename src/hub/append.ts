import {
  appendFileSync,
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { readLastEntryUuid } from "../jsonl.js";
import { rewriteJsonlStream, buildPathMappings, type RewriteContext } from "../rewriter.js";
import { detectPlatform } from "../platform.js";
import type { VersionAdapter } from "../types.js";

/**
 * How recently a base session must have been written for the append to be
 * treated as "a live Claude Code session is probably still appending to it".
 */
export const APPEND_LIVE_WINDOW_MS = 5 * 60 * 1000;

const CONTINUATION_MARKER = "[sesh-mover continuation]";

export interface DeltaChainInfo {
  /** First line is the synthetic `[sesh-mover continuation]` header. */
  headerPresent: boolean;
  /** Anchor: the parentUuid of the first REAL (non-header) entry. */
  firstEntryParentUuid: string | null;
  lastEntryUuid: string | null;
}

/**
 * Bounded read of a continuation bundle's chain endpoints: at most the first
 * two non-empty lines plus one cheap last-line read.
 *
 * `buildContinuationStream` slices the tail of a session from a known index, so
 * the first REAL entry's `parentUuid` is exactly the uuid the slice was cut
 * after — that value is the chain guard's input.
 */
export async function readDeltaChainInfo(deltaPath: string): Promise<DeltaChainInfo> {
  const input = createReadStream(deltaPath, { encoding: "utf-8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let headerPresent = false;
  let firstEntryParentUuid: string | null = null;
  let seen = 0;
  try {
    for await (const line of rl) {
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        break; // unparseable head — no anchor; tryAppendContinuation declines
      }
      if (seen === 0) {
        const msg = obj.message as { content?: unknown } | undefined;
        const content = typeof msg?.content === "string" ? msg.content : "";
        if (content.startsWith(CONTINUATION_MARKER)) {
          headerPresent = true;
          seen++;
          continue; // the real first entry is the next line
        }
      }
      firstEntryParentUuid = (obj.parentUuid as string | undefined) ?? null;
      break;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return { headerPresent, firstEntryParentUuid, lastEntryUuid: readLastEntryUuid(deltaPath) };
}

/**
 * Rewrite context for a same-machine session copy: identical platform and user,
 * and no path mappings (source and target paths are equal, so
 * `buildPathMappings` emits none). `rewriteEntry` therefore touches ONLY the
 * `sessionId` — cwd, tool results and snapshot keys pass through untouched.
 *
 * NOTE — no production caller. Every real splice comes off the hub, i.e. from
 * another machine, and goes through `buildImportRewriteContext` (see
 * `AppendAttempt.ctx`). This exists for tests and for a hypothetical
 * same-machine splice; if you reach for it against bundle content, you are
 * almost certainly about to embed another machine's paths in a local
 * transcript.
 */
export function identityRewriteContext(): RewriteContext {
  const platform = detectPlatform();
  return {
    mappings: buildPathMappings(platform, platform, "/x", "/x", "/y", "/y", "u", "u"),
    sourcePlatform: platform,
    targetPlatform: platform,
    sourceUser: "u",
    targetUser: "u",
  };
}

export interface AppendAttempt {
  basePath: string;
  /** Session id every appended entry is rewritten to. */
  baseSessionId: string;
  deltaPath: string;
  /**
   * Source -> target rewrite context for the bundle the delta came out of.
   * REQUIRED, and deliberately not defaulted: the delta is another machine's
   * bytes, and splicing it in raw would embed that machine's `cwd`, tool
   * result paths and file-history keys into a local transcript. Build it with
   * `buildImportRewriteContext(manifest, targetProjectPath, targetConfigDir)`
   * — the same call importer.ts makes, so a spliced continuation and an
   * imported fragment come out identical. Pass `identityRewriteContext()`
   * only for a genuinely same-machine splice.
   */
  ctx: RewriteContext;
  /**
   * Version adapters for source -> target Claude Code versions, from
   * `getApplicableAdapters`. Same rationale as `ctx`: an un-migrated schema
   * spliced into a local transcript is as wrong as a foreign path.
   */
  adapters?: VersionAdapter[];
  /** Pull-operation start time — enables the self-write mtime exemption. */
  opNowMs: number;
  /** `--force-append`: skips the mtime guard ONLY, never the chain guard. */
  force: boolean;
  /**
   * Test seam: forced failure after the delta has been appended but before head
   * verification — the only window in which rollback has real bytes to undo.
   * Never set in production code.
   */
  __injectFailure?: () => never;
}

export type AppendDeclineReason =
  /** The base's head uuid is not the delta's anchor (checked twice: before and after the O(delta) prep). */
  | "chain-mismatch"
  /** The base looks like a live session and `force` was not set. */
  | "recently-active"
  /** The bundle carries nothing appendable (empty, or a full session with no anchor). */
  | "no-delta-entries"
  /** The bundle itself is unusable. Aborted BEFORE the base was touched — it is byte- and mtime-identical. */
  | "delta-unusable"
  /** Bytes were appended, then something failed and the base was truncated back. */
  | "rolled-back";

export type AppendOutcome =
  | { kind: "appended"; entriesAppended: number; newHeadUuid: string }
  | { kind: "declined"; reason: AppendDeclineReason; detail: string };

/**
 * Splices a continuation bundle onto the end of an existing local session so
 * the conversation stays ONE resumable transcript instead of a base plus a
 * truncated fragment. Strips the synthetic continuation header, applies
 * `a.adapters` and `a.ctx` to every appended entry (identical treatment to
 * what importer.ts gives a fragment, so the two paths can't diverge), and
 * rewrites each entry's `sessionId` onto the base session.
 *
 * Two guards, in order:
 * 1. **Chain** (never skippable, not even with `force`): the delta's anchor
 *    (`parentUuid` of its first real entry) must equal the base's current head
 *    uuid. Without this the splice would fabricate a broken parent chain. It is
 *    checked TWICE — once up front, and again immediately before the write,
 *    because the preparation between them is O(delta) and Claude Code (which
 *    the project lock does not cover) may append to the base in that window.
 * 2. **Liveness** (`force` skips it): declines when the base was modified
 *    inside `APPEND_LIVE_WINDOW_MS`, unless the modification came from this
 *    very operation (`mtime >= opNowMs`) — that exemption is what lets one
 *    pull write a fresh base and then splice its own continuations onto it.
 *
 * The base is only ever EXTENDED, so rollback is a truncate back to its byte
 * length as re-measured at that second check — byte-exact by construction, and
 * measured late enough that it can never discard a concurrent writer's bytes.
 * Rollback also re-verifies the restored head uuid, and is skipped entirely
 * when nothing was written (so a decline never even bumps the base's mtime —
 * Claude Code orders `/resume` by mtime).
 *
 * Every anticipated failure is reported as a `declined` outcome. Raw IO faults
 * still throw: an unreadable delta path, a fault before any byte was written,
 * and — loudest of all — a rollback that itself failed, which is the one case
 * where the base may be left corrupt.
 */
export async function tryAppendContinuation(a: AppendAttempt): Promise<AppendOutcome> {
  const info = await readDeltaChainInfo(a.deltaPath);
  if (!info.lastEntryUuid || info.firstEntryParentUuid === null) {
    return {
      kind: "declined",
      reason: "no-delta-entries",
      detail:
        "continuation bundle has no appendable entries (empty, unparseable, or a full-session bundle with no anchor)",
    };
  }

  // Guard 1 (never skippable): the delta must continue exactly this head.
  const baseHead = readLastEntryUuid(a.basePath);
  if (baseHead !== info.firstEntryParentUuid) {
    return {
      kind: "declined",
      reason: "chain-mismatch",
      detail: `local base head ${baseHead ?? "(none)"} != continuation anchor ${info.firstEntryParentUuid}`,
    };
  }

  // Guard 2 (skippable via force, exempt for our own writes): don't touch a
  // file a live Claude Code session is probably appending to.
  const baseStat = statSync(a.basePath);
  const mtimeMs = baseStat.mtimeMs;
  const selfWritten = mtimeMs >= a.opNowMs;
  const ageMs = Date.now() - mtimeMs;
  if (!a.force && !selfWritten && ageMs < APPEND_LIVE_WINDOW_MS) {
    return {
      kind: "declined",
      reason: "recently-active",
      detail: `base session was modified ${Math.round(ageMs / 1000)}s ago (possible live session); use --force-append to override`,
    };
  }

  // Rollback length and "did we touch the file at all" bookkeeping. The length
  // is re-measured after the O(delta) prep below; this initial value is only a
  // placeholder for the (impossible) case of a throw before that point.
  let rollbackBytes = baseStat.size;
  let wroteBytes = false;
  const work = mkdtempSync(join(tmpdir(), "sesh-append-"));
  try {
    // 1. header-stripped copy
    const stripped = join(work, "stripped.jsonl");
    const entriesAppended = await stripHeader(a.deltaPath, stripped, info.headerPresent);

    // 2. version-adapt + translate the source machine's paths onto this one,
    //    and rewrite ids onto the base session — one pass, same transform
    //    importer.ts runs over a fragment.
    const rewritten = join(work, "rewritten.jsonl");
    const report = await rewriteJsonlStream(stripped, rewritten, a.ctx, {
      adapters: a.adapters,
      newSessionId: a.baseSessionId,
    });
    // An unparseable line survives the rewrite verbatim — it would land in the
    // base still carrying the delta's sessionId. Refuse before touching the
    // base (mirrors importer.ts's strict-validation semantics).
    if (report.parseFailures > 0) {
      return {
        kind: "declined",
        reason: "delta-unusable",
        detail: `continuation contains ${report.parseFailures} unparseable JSONL line(s); refusing to splice (the base was not modified)`,
      };
    }

    // 3. Re-check the chain and re-measure the base. Everything above this
    //    point read the base BEFORE O(delta) work; a live Claude Code session
    //    (which no lock of ours covers) may have appended since. Without this,
    //    the delta could be spliced after entries it does not chain to — and
    //    post-append verification could not catch it, because the final head
    //    would still be the delta's last uuid. Re-measuring the size here also
    //    guarantees a later rollback can never truncate away another writer's
    //    bytes.
    const fresh = statSync(a.basePath);
    const freshHead = readLastEntryUuid(a.basePath);
    if (freshHead !== info.firstEntryParentUuid) {
      return {
        kind: "declined",
        reason: "chain-mismatch",
        detail: `base head moved during the splice (${baseHead ?? "(none)"} -> ${freshHead ?? "(none)"}, expected continuation anchor ${info.firstEntryParentUuid}); nothing was written`,
      };
    }
    rollbackBytes = fresh.size;

    // 4. append (a base whose final line lacks its newline would otherwise be
    //    glued to the delta's first entry)
    if (rollbackBytes > 0 && !isLineBoundary(a.basePath, rollbackBytes)) {
      wroteBytes = true;
      appendFileSync(a.basePath, "\n", "utf-8");
    }
    wroteBytes = true;
    await pipeline(createReadStream(rewritten), createWriteStream(a.basePath, { flags: "a" }));

    a.__injectFailure?.();

    // 5. verify the splice landed
    const newHead = readLastEntryUuid(a.basePath);
    if (newHead !== info.lastEntryUuid) {
      throw new Error(
        `post-append head ${newHead ?? "(none)"} != expected ${info.lastEntryUuid}`
      );
    }
    return { kind: "appended", entriesAppended, newHeadUuid: newHead };
  } catch (e) {
    // Nothing of ours reached the file: truncating would be a lie in the
    // outcome AND a real side effect, since even a same-size truncate bumps
    // mtime (which is how Claude Code orders /resume). Let the fault surface.
    if (!wroteBytes) throw e;

    const cause = (e as Error).message;
    try {
      truncateSync(a.basePath, rollbackBytes);
    } catch (rollbackError) {
      throw new Error(
        `append failed (${cause}) AND rollback failed — ${a.basePath} may be corrupt (expected ${rollbackBytes} bytes): ${(rollbackError as Error).message}`
      );
    }
    const restored = readLastEntryUuid(a.basePath);
    const detail =
      restored === baseHead
        ? `append aborted and the base was restored to ${rollbackBytes} bytes: ${cause}`
        : `append aborted and rollback could not restore the head (expected ${baseHead ?? "(none)"}, got ${restored ?? "(none)"}): ${cause}`;
    return { kind: "declined", reason: "rolled-back", detail };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface AdoptHubInput {
  basePath: string;
  /** Session id the adopted (hub) entries are rewritten to — the base's own. */
  baseSessionId: string;
  deltaPath: string;
  /**
   * Byte offset just past the common anchor entry, from
   * `findEntryOffsetByUuid`. Verified to sit on a line boundary before
   * anything is truncated (see `isLineBoundary`).
   */
  anchorOffset: number;
  /** Caller-minted uuid for the copy of the local branch. */
  preservedSessionId: string;
  /**
   * `<projectDir>/<preservedSessionId>.jsonl` — must not exist yet, and is
   * checked: the failure path deletes this file, so adopting onto an existing
   * one would let a rollback destroy something that was never ours.
   */
  preservedPath: string;
  /**
   * Source -> target rewrite context for the bundle the delta came out of.
   * REQUIRED for exactly the reason `AppendAttempt.ctx` is: the delta is
   * another machine's bytes. Build it with `buildImportRewriteContext`. The
   * PRESERVED copy is local bytes and is deliberately NOT run through this —
   * it only gets a new session id.
   */
  ctx: RewriteContext;
  /** Version adapters for source -> target Claude Code versions. */
  adapters?: VersionAdapter[];
  /**
   * Test seam: forced failure after the base has been rewritten but before
   * head verification — the window in which restore has real bytes to undo.
   * Never set in production code.
   */
  __injectFailure?: () => never;
}

export type AdoptOutcome =
  | {
      kind: "adopted";
      entriesAppended: number;
      newHeadUuid: string;
      preservedSessionId: string;
    }
  /**
   * Nothing was kept. Either the base was never touched (every refusal before
   * the truncate, including the concurrent-modification re-check), or it was
   * restored byte-for-byte from the snapshot this call took at its start.
   *
   * The distinction matters under a live writer: "restored" means restored to
   * THE SNAPSHOT, so a restore can only ever be byte-for-byte with respect to
   * the file as it was when adoption began. That is exactly why the re-check
   * exists — it makes the untouched case the only one a concurrent writer can
   * reach.
   */
  | { kind: "failed"; detail: string };

/**
 * Divergence adoption: make the hub's branch canonical WITHOUT losing local
 * work. Two branches hang off a common anchor; this cuts the local one off at
 * that anchor, splices the hub's on instead, and keeps the local branch as a
 * second, complete session (common history + local branch — a transcript that
 * starts mid-conversation is the fragment problem this whole path exists to
 * avoid).
 *
 * Order is the design:
 * 1. the full base is copied to a temp backup BEFORE any mutation, so a
 *    failure is a RESTORE rather than a reconstruction from two half-written
 *    files;
 * 2. every cheap refusal (no delta entries, an offset that isn't a line
 *    boundary, a preserved path that already exists) and all the O(delta)
 *    preparation happen while the base is still untouched, so the mutation
 *    window is a truncate plus one append;
 * 3. the base is re-measured immediately before the truncate and the adoption
 *    is abandoned if it moved — see below;
 * 4. the preserved session is materialised only AFTER the splice verifies —
 *    on failure there is no orphan file, and (because the caller registers it
 *    in `history.jsonl` only once this returns `adopted`) nothing to
 *    un-register either.
 *
 * Step 3 is the same defense `tryAppendContinuation` runs at its own step 3,
 * and it matters MORE here. No lock of ours covers Claude Code, the
 * preparation in step 2 is O(delta), and a live session may append in that
 * window. An append that raced would merely be spliced after entries it does
 * not chain to; a truncate that races DESTROYS those entries — and they would
 * not be in the backup either, because the backup was taken before they were
 * written. So the base's size and head uuid are captured from the BACKUP (the
 * snapshot that is actually restorable) and re-checked against the live file
 * just before the cut; any difference abandons the adoption with nothing
 * written, leaving the concurrent writer's bytes exactly where they are.
 *
 * No entry is injected into either transcript; the "preserved" labelling is
 * the caller's `history.jsonl` display name, not content.
 *
 * Anticipated failures come back as `failed`. The one case that throws is a
 * restore that itself failed — the only situation where the base may be left
 * inconsistent, and the temp backup is then deliberately NOT deleted so the
 * error can name a full copy of the user's session.
 */
export async function adoptHubBranch(input: AdoptHubInput): Promise<AdoptOutcome> {
  const work = mkdtempSync(join(tmpdir(), "sesh-adopt-"));
  const backup = join(work, "base-backup.jsonl");
  let keepWork = false;
  try {
    if (existsSync(input.preservedPath)) {
      return {
        kind: "failed",
        detail: `preserved session path ${input.preservedPath} already exists — refusing to adopt (the failure path deletes that file)`,
      };
    }

    copyFileSync(input.basePath, backup);
    // Measured off the BACKUP, not the live file: these describe exactly the
    // snapshot we hold and could restore, so if a write lands mid-copy the
    // re-check below sees a mismatch rather than silently trusting a torn or
    // stale reading of the original.
    const snapshotSize = statSync(backup).size;
    const snapshotHead = readLastEntryUuid(backup);

    const info = await readDeltaChainInfo(input.deltaPath);
    if (!info.lastEntryUuid) {
      return { kind: "failed", detail: "continuation bundle has no entries" };
    }

    if (!isLineBoundary(input.basePath, input.anchorOffset)) {
      return {
        kind: "failed",
        detail: `anchor offset ${input.anchorOffset} is not on a line boundary (past end of file, or a CRLF transcript) — refusing to truncate ${input.basePath}`,
      };
    }

    // Preparation, all of it before the base is touched: strip the synthetic
    // header, then version-adapt + path-translate + re-stamp the session id in
    // one pass, exactly as tryAppendContinuation does.
    const stripped = join(work, "stripped.jsonl");
    const entriesAppended = await stripHeader(input.deltaPath, stripped, info.headerPresent);
    const rewritten = join(work, "rewritten.jsonl");
    const report = await rewriteJsonlStream(stripped, rewritten, input.ctx, {
      adapters: input.adapters,
      newSessionId: input.baseSessionId,
    });
    if (report.parseFailures > 0) {
      return {
        kind: "failed",
        detail: `continuation contains ${report.parseFailures} unparseable JSONL line(s); refusing to adopt (the base was not modified)`,
      };
    }

    // Everything above read the base BEFORE the O(delta) preparation. If a
    // live Claude Code session appended in that window, cutting at the anchor
    // would delete entries that are in neither the new base nor the backup —
    // gone, with no error anywhere. Abandon instead: nothing has been written
    // yet, so there is nothing to restore and the writer's bytes stay put.
    const live = statSync(input.basePath);
    const liveHead = readLastEntryUuid(input.basePath);
    if (live.size !== snapshotSize || liveHead !== snapshotHead) {
      return {
        kind: "failed",
        detail: `base changed during adoption (${snapshotSize} bytes / head ${snapshotHead ?? "(none)"} -> ${live.size} bytes / head ${liveHead ?? "(none)"}) — nothing was written`,
      };
    }
    // Re-verified at the moment of truncation, not just before the prep: the
    // one guarantee findEntryOffsetByUuid's contract asks for is that THIS
    // offset is a line boundary in THIS file.
    if (!isLineBoundary(input.basePath, input.anchorOffset)) {
      return {
        kind: "failed",
        detail: `anchor offset ${input.anchorOffset} is no longer on a line boundary — nothing was written`,
      };
    }

    // Splice: cut the local divergence off at the anchor, append the hub's.
    truncateSync(input.basePath, input.anchorOffset);
    await pipeline(createReadStream(rewritten), createWriteStream(input.basePath, { flags: "a" }));

    input.__injectFailure?.();

    const newHead = readLastEntryUuid(input.basePath);
    if (newHead !== info.lastEntryUuid) {
      throw new Error(`post-adopt head ${newHead ?? "(none)"} != expected ${info.lastEntryUuid}`);
    }

    // Only now materialise the preserved copy: the pre-mutation backup is the
    // full local history, and identityRewriteContext leaves everything but the
    // session id alone (these are this machine's own bytes — running them
    // through the import context would translate paths that are already local).
    await rewriteJsonlStream(backup, input.preservedPath, identityRewriteContext(), {
      newSessionId: input.preservedSessionId,
    });

    return {
      kind: "adopted",
      entriesAppended,
      newHeadUuid: newHead,
      preservedSessionId: input.preservedSessionId,
    };
  } catch (e) {
    const cause = (e as Error).message;
    try {
      copyFileSync(backup, input.basePath); // byte-for-byte restore
      rmSync(input.preservedPath, { force: true }); // nothing half-written survives
    } catch (restoreError) {
      keepWork = true; // the backup is the user's only intact copy — keep it
      throw new Error(
        `adopt failed (${cause}) AND restoring ${input.basePath} failed — a complete copy of the session as it was is at ${backup}: ${(restoreError as Error).message}`
      );
    }
    return { kind: "failed", detail: cause };
  } finally {
    if (!keepWork) rmSync(work, { recursive: true, force: true });
  }
}

/**
 * True when `offset` sits exactly on a line boundary — i.e. the byte
 * immediately before it is `\n`. At `offset === size` that is "the file ends
 * with a newline"; at any other offset it is the pre-truncate guard
 * `findEntryOffsetByUuid` (jsonl.ts) demands, and it is the ONLY enforcement
 * of that contract in the codebase:
 *
 * - For a file whose final line has no trailing newline the helper's offset is
 *   1 PAST EOF, and `truncateSync` past EOF does not error — it EXTENDS the
 *   file with a NUL byte, i.e. silently writes a corrupt JSONL line. Here the
 *   read returns 0 bytes, so this returns false.
 * - For a CRLF file the helper undercounts one byte per line, landing the
 *   offset ON the `\n`; truncating there strips the terminator and glues the
 *   anchor line to whatever is appended next. Here the byte is `\r`, so this
 *   returns false.
 *
 * Clamping the offset to the file size (the obvious "fix") catches only the
 * first case and silently accepts the second.
 */
function isLineBoundary(path: string, offset: number): boolean {
  if (offset <= 0) return false;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1);
    const read = readSync(fd, buf, 0, 1, offset - 1);
    return read === 1 && buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Copies `src` to `dest` minus the synthetic header line; returns lines written. */
async function stripHeader(
  src: string,
  dest: string,
  headerPresent: boolean
): Promise<number> {
  const input = createReadStream(src, { encoding: "utf-8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const out = createWriteStream(dest, { encoding: "utf-8" });
  // Same three-part write-stream error protocol as rewriter.ts's
  // rewriteJsonlStream (see the comment there): latch the first 'error' so a
  // failed open can't hang the drain await, and mark it handled immediately so
  // an early rejection isn't an unhandled rejection.
  const outErrored: Promise<never> = new Promise<never>((_, reject) =>
    out.once("error", reject)
  );
  outErrored.catch(() => {});
  let skipped = !headerPresent;
  let count = 0;
  try {
    for await (const line of rl) {
      if (!line) continue;
      if (!skipped) {
        skipped = true;
        continue;
      }
      if (!out.write(line + "\n")) {
        await Promise.race([once(out, "drain"), outErrored]);
      }
      count++;
    }
    out.end();
    await Promise.race([finished(out), outErrored]);
  } catch (e) {
    out.destroy();
    throw e;
  } finally {
    rl.close();
    input.destroy();
  }
  return count;
}
