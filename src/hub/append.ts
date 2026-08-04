import {
  appendFileSync,
  closeSync,
  createReadStream,
  createWriteStream,
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
 * truncated fragment. Strips the synthetic continuation header and rewrites
 * every appended entry's `sessionId` onto the base session.
 *
 * PRECONDITION — the delta must already be local-ready. This is a same-machine
 * splice: it rewrites `sessionId` and NOTHING else (see
 * `identityRewriteContext`), and it applies no version adapters. The CALLER
 * must hand over a bundle whose paths are already rewritten for this machine
 * and whose schema is already adapted to the local Claude Code version.
 * Splicing a raw cross-platform or cross-version continuation would embed
 * foreign paths and an un-migrated schema into a local transcript.
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

    // 2. rewrite ids onto the base session
    const rewritten = join(work, "rewritten.jsonl");
    const report = await rewriteJsonlStream(stripped, rewritten, identityRewriteContext(), {
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
    if (rollbackBytes > 0 && !endsWithNewline(a.basePath, rollbackBytes)) {
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

function endsWithNewline(path: string, size: number): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1);
    const read = readSync(fd, buf, 0, 1, size - 1);
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
