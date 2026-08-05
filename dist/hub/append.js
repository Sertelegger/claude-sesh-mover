import { appendFileSync, closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync, truncateSync, } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { isConversationEntry, readLastEntryUuid, MAX_ENTRY_SCAN_BYTES } from "../jsonl.js";
import { rewriteJsonlStream, buildPathMappings } from "../rewriter.js";
import { detectPlatform } from "../platform.js";
/**
 * How recently a base session must have been written for the append to be
 * treated as "a live Claude Code session is probably still appending to it".
 */
export const APPEND_LIVE_WINDOW_MS = 5 * 60 * 1000;
const CONTINUATION_MARKER = "[sesh-mover continuation]";
/**
 * Bounded read of a continuation bundle's chain endpoints: the leading lines up
 * to and including the first CONVERSATION entry (capped at
 * `MAX_ENTRY_SCAN_BYTES`), plus one cheap tail read.
 *
 * `buildContinuationStream` slices the tail of a session from a known index, so
 * the first entry after the cut carries a `parentUuid` equal to the uuid the
 * slice was cut after — that value is the chain guard's input.
 *
 * The cut lands on the first line the peer has not seen, which is usually a
 * uuid-less bookkeeping entry (`last-prompt` / `mode` / …, written right after
 * each assistant turn). Those lines carry no `parentUuid` at all, so the anchor
 * is taken from the first entry that is actually IN the chain, not from
 * whatever line happens to sit under the header.
 */
export async function readDeltaChainInfo(deltaPath) {
    const input = createReadStream(deltaPath, { encoding: "utf-8" });
    const rl = createInterface({ input, crlfDelay: Infinity });
    let headerPresent = false;
    let firstEntryParentUuid = null;
    let seen = 0;
    let scanned = 0;
    try {
        for await (const line of rl) {
            if (!line)
                continue;
            scanned += Buffer.byteLength(line, "utf8") + 1;
            if (scanned > MAX_ENTRY_SCAN_BYTES)
                break; // no anchor within the window
            let obj;
            try {
                obj = JSON.parse(line);
            }
            catch {
                break; // unparseable head — no anchor; tryAppendContinuation declines
            }
            if (seen === 0) {
                const msg = obj.message;
                const content = typeof msg?.content === "string" ? msg.content : "";
                seen++;
                if (content.startsWith(CONTINUATION_MARKER)) {
                    headerPresent = true;
                    continue; // the real first entry is below
                }
            }
            // The synthetic header has a uuid of its own, so this test only runs
            // once the header line (if any) is behind us.
            if (!isConversationEntry(obj))
                continue;
            firstEntryParentUuid = obj.parentUuid ?? null;
            break;
        }
    }
    finally {
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
export function identityRewriteContext() {
    const platform = detectPlatform();
    return {
        mappings: buildPathMappings(platform, platform, "/x", "/x", "/y", "/y", "u", "u"),
        sourcePlatform: platform,
        targetPlatform: platform,
        sourceUser: "u",
        targetUser: "u",
    };
}
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
 * length as re-measured at that second check. That re-measurement keeps the
 * length as fresh as it can be, but it does NOT by itself make the truncate
 * safe: bytes can still land between the measurement and our first write. So
 * the rollback path first proves the file is exactly as long as "what was
 * there" plus "what we wrote" and THROWS rather than truncating when it is not
 * — a rollback that would eat another writer's line is never performed, and is
 * never reported as a clean restore. Rollback also re-verifies the restored
 * head uuid, and is skipped entirely when nothing was written (so a decline
 * never even bumps the base's mtime — Claude Code orders `/resume` by mtime).
 *
 * Every anticipated failure is reported as a `declined` outcome. Raw IO faults
 * still throw: an unreadable delta path, a fault before any byte was written,
 * a rollback that could not be proven safe, and — loudest of all — a rollback
 * that itself failed. Those last two are the cases where the base may be left
 * holding bytes we did not intend it to keep.
 */
export async function tryAppendContinuation(a) {
    const info = await readDeltaChainInfo(a.deltaPath);
    if (!info.lastEntryUuid || info.firstEntryParentUuid === null) {
        return {
            kind: "declined",
            reason: "no-delta-entries",
            detail: "continuation bundle has no appendable entries (empty, unparseable, or a full-session bundle with no anchor)",
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
    // Deliberately imprecise in the exempting direction, twice over: mtimeMs is a
    // float but opNowMs comes from Date.now(), truncated to a whole millisecond,
    // and opNowMs is captured once for the WHOLE pull — so a foreign write landing
    // anywhere between op start and this guard reads as ours. Bounded by the chain
    // guard (a foreign *conversation* entry moves the head, so the splice declines
    // as chain-mismatch), then by the TOCTOU re-check and the rollback arithmetic.
    // Making this exact needs a recorded write-time, not a finer clock — see the
    // Task 7 carry in the SDD ledger. Never "fix" it by flooring mtimeMs: that
    // widens the window to a full millisecond instead of closing it.
    const selfWritten = mtimeMs >= a.opNowMs;
    const ageMs = Date.now() - mtimeMs;
    if (!a.force && !selfWritten && ageMs < APPEND_LIVE_WINDOW_MS) {
        return {
            kind: "declined",
            reason: "recently-active",
            // States the fact, never a remedy. This module cannot know what its
            // caller does with a decline, and the caller that has one — hub/pull.ts —
            // falls through to a fragment import that RECORDS the bundle, so naming
            // `--force-append` here produced a warning telling the user to re-run
            // with a flag that can no longer reach this bundle. Advice belongs where
            // the consequence is known.
            detail: `base session was modified ${Math.round(ageMs / 1000)}s ago (possible live session)`,
        };
    }
    // Rollback length and "did we touch the file at all" bookkeeping. The length
    // is re-measured after the O(delta) prep below; this initial value is only a
    // placeholder for the (impossible) case of a throw before that point.
    let rollbackBytes = baseStat.size;
    let wroteBytes = false;
    // Bytes THIS call put in the file, counted as they actually reach the fd (so
    // it stays exact when a write faults half-way). `rollbackBytes +
    // appendedBytes` is the only file length a rollback is entitled to truncate.
    let appendedBytes = 0;
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
        //    would still be the delta's last uuid.
        //
        //    Head FIRST, size SECOND, and that order is load-bearing now that the
        //    head skips bookkeeping. A concurrent `mode` / `last-prompt` write no
        //    longer moves the head, so this check legitimately passes over it and
        //    the splice proceeds — which means the rollback length must be measured
        //    AFTER the head was read, or a size captured before that write would
        //    truncate the other writer's line away on the rollback path. (Measuring
        //    size first was previously harmless only because such a write made the
        //    head read return null and the whole attempt declined.)
        //
        //    What this measurement does NOT do is make a later rollback safe. It
        //    closes the window that ends here; it cannot close the one that starts
        //    here, because `isLineBoundary` below is three more syscalls and the
        //    `pipeline` after it yields to the event loop. A writer that lands in
        //    THAT window puts bytes past `rollbackBytes` that are not ours, and for
        //    the same reason as above the splice no longer aborts over it. The
        //    rollback path is where that is caught — by arithmetic, not by hope.
        const freshHead = readLastEntryUuid(a.basePath);
        const fresh = statSync(a.basePath);
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
            appendedBytes += 1; // counted only once the write returned
        }
        wroteBytes = true;
        const sink = createWriteStream(a.basePath, { flags: "a" });
        try {
            await pipeline(createReadStream(rewritten), sink);
        }
        finally {
            // `bytesWritten` is incremented as each fs.write COMPLETES, so it never
            // over-counts what reached disk — but it can under-count. A fault with a
            // write still in flight (the read stream erroring mid-file, or the sink
            // destroyed mid-write) loses up to one 64 KB chunk. The direction is the
            // safe one: an under-count makes the rollback guard refuse to truncate
            // rather than truncate too far. What it costs is the diagnosis — the
            // refusal then reads like a concurrent writer when it was really our own
            // mid-file IO fault, which is why that message hedges its attribution.
            appendedBytes += sink.bytesWritten;
        }
        a.__injectFailure?.();
        // 5. verify the splice landed
        const newHead = readLastEntryUuid(a.basePath);
        if (newHead !== info.lastEntryUuid) {
            throw new Error(`post-append head ${newHead ?? "(none)"} != expected ${info.lastEntryUuid}`);
        }
        return { kind: "appended", entriesAppended, newHeadUuid: newHead };
    }
    catch (e) {
        // Nothing of ours reached the file: truncating would be a lie in the
        // outcome AND a real side effect, since even a same-size truncate bumps
        // mtime (which is how Claude Code orders /resume). Let the fault surface.
        if (!wroteBytes)
            throw e;
        const cause = e.message;
        // Rollback is a TRUNCATE, and a truncate is only ours to perform if every
        // byte past `rollbackBytes` is a byte we put there. Nothing upstream can
        // promise that: `rollbackBytes` is measured at step 3, and a live Claude
        // Code session (which no lock of ours covers) can append between that
        // measurement and our first write. Before this task such a write made the
        // head read return `null` and the whole attempt decline — accidental
        // safety, not a guarantee — but the head now steps over bookkeeping, so the
        // splice proceeds and the residual is reachable in the ordinary case. A
        // truncate then destroys the other writer's line AND reports a clean
        // restore while doing it. So prove the arithmetic, and refuse loudly when
        // it does not hold: leaving extra bytes in place is recoverable, deleting
        // someone else's is not.
        let liveSize;
        try {
            liveSize = statSync(a.basePath).size;
        }
        catch (statError) {
            throw new Error(`append failed (${cause}) AND the base could not be re-measured, so no rollback was attempted — ${a.basePath} was left exactly as it is: ${statError.message}`);
        }
        const oursToUndo = rollbackBytes + appendedBytes;
        if (liveSize !== oursToUndo) {
            throw new Error(`append failed (${cause}) AND rollback was REFUSED — ${a.basePath} is ${liveSize} bytes but only ${oursToUndo} can be accounted for (${rollbackBytes} before the splice + ${appendedBytes} written by it), so this rollback cannot be proven to delete only its own bytes: most likely something else wrote to this transcript mid-splice (a live Claude Code session), though a write that faulted with bytes still in flight can also leave fewer accounted for than reached disk. Truncating back to ${rollbackBytes} could therefore have deleted bytes that were not ours and called it a clean restore, so NOTHING was truncated: the file still holds everything it held, plus this continuation's entries, plus anything the other writer added. Exit any Claude Code session open on it and inspect the tail before re-running the pull.`);
        }
        try {
            truncateSync(a.basePath, rollbackBytes);
        }
        catch (rollbackError) {
            throw new Error(`append failed (${cause}) AND rollback failed — ${a.basePath} may be corrupt (expected ${rollbackBytes} bytes): ${rollbackError.message}`);
        }
        const restored = readLastEntryUuid(a.basePath);
        const detail = restored === baseHead
            ? `append aborted and the base was restored to ${rollbackBytes} bytes: ${cause}`
            : `append aborted and rollback could not restore the head (expected ${baseHead ?? "(none)"}, got ${restored ?? "(none)"}): ${cause}`;
        return { kind: "declined", reason: "rolled-back", detail };
    }
    finally {
        rmSync(work, { recursive: true, force: true });
    }
}
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
 * That re-check cannot cover the window it opens — between itself and the
 * truncate/append — so the failure path adds the arithmetic backstop: the
 * restore runs only if the file is exactly the size this call's own mutation
 * accounts for, and throws otherwise. Restoring is a whole-file overwrite, so
 * doing it over foreign bytes would not merely mis-report, it would erase them.
 *
 * No entry is injected into either transcript; the "preserved" labelling is
 * the caller's `history.jsonl` display name, not content.
 *
 * Anticipated failures come back as `failed`, and so does any fault that lands
 * BEFORE the truncate — the base is byte-identical there, so there is nothing
 * to restore and nothing for the user to reconcile. Two cases throw, both of
 * them after the base has been mutated: a restore that could not be proven safe,
 * and a restore that itself failed. Those are the situations where the base may
 * be left inconsistent, and in both the temp backup is deliberately NOT deleted
 * so the error can name a full copy of the user's session.
 */
export async function adoptHubBranch(input) {
    const work = mkdtempSync(join(tmpdir(), "sesh-adopt-"));
    const backup = join(work, "base-backup.jsonl");
    let keepWork = false;
    // Size the base should have if nothing but THIS call has written to it.
    // `null` until the truncate — i.e. `null` means "the base is still exactly as
    // we found it", which is why the failure path treats it as nothing to undo;
    // from then on it is what our own mutation accounts for, and the restore is
    // only entitled to run when the file actually has that size.
    let mutatedSize = null;
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
        mutatedSize = input.anchorOffset;
        const sink = createWriteStream(input.basePath, { flags: "a" });
        try {
            await pipeline(createReadStream(rewritten), sink);
        }
        finally {
            // Never over-counts what reached disk; may under-count by up to one
            // 64 KB chunk when a write was in flight at the fault. Same accounting,
            // and the same consequence for the refusal message, as in
            // tryAppendContinuation.
            mutatedSize = input.anchorOffset + sink.bytesWritten;
        }
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
    }
    catch (e) {
        const cause = e.message;
        // `mutatedSize === null` means the fault landed before the truncate — an
        // unreadable delta, a rewrite failure, an IO error during the O(delta)
        // prep. Every one of those happens while the base is still byte-identical
        // to the backup, so there is nothing of ours to undo: skipping the restore
        // is the whole remedy, and a whole-file overwrite here would only bump the
        // mtime Claude Code orders /resume by (and, if a live session appended in
        // the meantime, erase that writer's line while reporting a clean restore).
        // This is an ordinary `failed`, NOT a throw: the base is untouched, the
        // user has nothing to reconcile, and pull.ts handles `failed` by falling
        // through to the fragment import, so the hub's branch still arrives.
        if (mutatedSize === null)
            return { kind: "failed", detail: cause };
        // Past here we truncated and re-appended. The restore OVERWRITES the whole
        // base with the snapshot, so it destroys anything written to the file
        // since — exactly the hazard the re-check above exists for, in exactly the
        // window the re-check cannot see (between itself and the truncate/append).
        // Same rule as tryAppendContinuation's rollback: restore only what our own
        // mutation accounts for, and refuse loudly otherwise.
        let liveSize = null;
        try {
            liveSize = statSync(input.basePath).size;
        }
        catch {
            liveSize = null; // unreadable — fall through and let the restore try
        }
        if (liveSize !== null && liveSize !== mutatedSize) {
            keepWork = true; // the pre-mutation snapshot is the only intact copy
            // This path is ours by construction (it was proven not to exist at the
            // start), so removing a half-written copy of it is safe and touches
            // nothing the other writer owns.
            try {
                rmSync(input.preservedPath, { force: true });
            }
            catch {
                /* best effort — the throw below is the message that matters */
            }
            throw new Error(`adopt failed (${cause}) AND the restore was REFUSED — ${input.basePath} is ${liveSize} bytes but this operation accounts for ${mutatedSize}, so the restore cannot be proven to overwrite only its own bytes: most likely something else wrote to the transcript mid-adoption (a live Claude Code session), though a write that faulted with bytes still in flight can also leave fewer accounted for than reached disk. Restoring could therefore have overwritten bytes that were not ours and called it byte-for-byte, so the file was left exactly as it is; a complete copy of the session as it was before adoption is at ${backup}. Exit any Claude Code session open on it before reconciling the two by hand.`);
        }
        try {
            copyFileSync(backup, input.basePath); // byte-for-byte restore
            rmSync(input.preservedPath, { force: true }); // nothing half-written survives
        }
        catch (restoreError) {
            keepWork = true; // the backup is the user's only intact copy — keep it
            throw new Error(`adopt failed (${cause}) AND restoring ${input.basePath} failed — a complete copy of the session as it was is at ${backup}: ${restoreError.message}`);
        }
        return { kind: "failed", detail: cause };
    }
    finally {
        if (!keepWork)
            rmSync(work, { recursive: true, force: true });
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
function isLineBoundary(path, offset) {
    if (offset <= 0)
        return false;
    const fd = openSync(path, "r");
    try {
        const buf = Buffer.alloc(1);
        const read = readSync(fd, buf, 0, 1, offset - 1);
        return read === 1 && buf[0] === 0x0a;
    }
    finally {
        closeSync(fd);
    }
}
/** Copies `src` to `dest` minus the synthetic header line; returns lines written. */
async function stripHeader(src, dest, headerPresent) {
    const input = createReadStream(src, { encoding: "utf-8" });
    const rl = createInterface({ input, crlfDelay: Infinity });
    const out = createWriteStream(dest, { encoding: "utf-8" });
    // Same three-part write-stream error protocol as rewriter.ts's
    // rewriteJsonlStream (see the comment there): latch the first 'error' so a
    // failed open can't hang the drain await, and mark it handled immediately so
    // an early rejection isn't an unhandled rejection.
    const outErrored = new Promise((_, reject) => out.once("error", reject));
    outErrored.catch(() => { });
    let skipped = !headerPresent;
    let count = 0;
    try {
        for await (const line of rl) {
            if (!line)
                continue;
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
    }
    catch (e) {
        out.destroy();
        throw e;
    }
    finally {
        rl.close();
        input.destroy();
    }
    return count;
}
//# sourceMappingURL=append.js.map