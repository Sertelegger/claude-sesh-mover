import { isConversationEntry } from "./jsonl.js";
import type { DiscoveredSession, SyncStateSessionSent } from "./types.js";

export interface ContinuationPlanItem {
  session: DiscoveredSession;
  fromEntryIndex: number;
  /** Uuid of the first entry this delta SHIPS — one past the anchor. May be `""`. */
  fromEntryUuid: string;
  /**
   * The recorded head this delta was built AGAINST — the peer's own
   * `headEntryUuid` for this session. Always a non-empty uuid: an empty or
   * missing recorded head is a full push (see the two guards below), so this is
   * only ever reached with a head that was found in the transcript.
   *
   * This is the value a cross-machine chain walk links on. `fromEntryUuid` is
   * NOT — it is the anchor's child and equals no bundle's head, which is why a
   * head-keyed walk over it found zero links on any real hub.
   */
  anchorEntryUuid: string;
}

export interface DiffPlan {
  full: DiscoveredSession[];
  continuation: ContinuationPlanItem[];
  unchanged: DiscoveredSession[];
  warnings: string[];
}

export function computeIncrementalPlan(
  localSessions: DiscoveredSession[],
  peerSent: Record<string, SyncStateSessionSent>,
  readEntries: (session: DiscoveredSession) => Array<{ uuid: string }>
): DiffPlan {
  const plan: DiffPlan = {
    full: [],
    continuation: [],
    unchanged: [],
    warnings: [],
  };

  for (const session of localSessions) {
    const record = peerSent[session.sessionId];

    if (!record) {
      plan.full.push(session);
      continue;
    }

    if (!record.headEntryUuid) {
      plan.warnings.push(
        `Session ${session.sessionId}: recorded head UUID is empty; sending whole.`
      );
      plan.full.push(session);
      continue;
    }

    const entries = readEntries(session);

    if (entries.length < record.messageCount) {
      plan.warnings.push(
        `Session ${session.sessionId} is shorter than recorded (${entries.length} < ${record.messageCount}); sending whole.`
      );
      plan.full.push(session);
      continue;
    }

    const headIndex = entries.findIndex((e) => e.uuid === record.headEntryUuid);
    if (headIndex === -1) {
      plan.warnings.push(
        `Session ${session.sessionId}: recorded head UUID ${record.headEntryUuid} not found; sending whole.`
      );
      plan.full.push(session);
      continue;
    }

    if (headIndex === entries.length - 1) {
      plan.unchanged.push(session);
      continue;
    }

    // The slice starts at the first line the peer has not seen — uuid-less
    // bookkeeping included, so nothing is dropped in transit. But if the whole
    // remainder is bookkeeping there is no chain entry in it: the recorded head
    // is still the transcript's head, `tryAppendContinuation` would decline the
    // bundle as `no-delta-entries`, and pull would land it as a content-free
    // fragment session. Defer instead — those lines ship with the next real
    // message, whose slice starts at this same index.
    //
    // "Deferred, not dropped" holds only for a session that CONTINUES. A
    // session whose last conversation entry is its last one ever — abandoned,
    // or simply finished — never ships that trailing run at all, so the peer's
    // copy is missing the final turn's `file-history-snapshot` /
    // `file-history-delta` / `mode` lines forever. That is the accepted cost:
    // the alternative sends a bundle with no chain entry, which lands as a
    // content-free fragment session on every pull, and none of those types is
    // read back by anything in this codebase (they are Claude Code's own
    // undo/display bookkeeping). Revisit if a bookkeeping type ever becomes
    // load-bearing for resumption.
    if (!entries.slice(headIndex + 1).some((e) => isConversationEntry(e))) {
      plan.unchanged.push(session);
      continue;
    }

    const fromEntryIndex = headIndex + 1;
    plan.continuation.push({
      session,
      fromEntryIndex,
      fromEntryUuid: entries[fromEntryIndex].uuid,
      // `entries[headIndex]`, by construction — but taken from the RECORD, not
      // re-read out of the array, so the value that travels is the peer's own
      // spelling of the head rather than this machine's reading of the line
      // that happens to sit at that index.
      anchorEntryUuid: record.headEntryUuid,
    });
  }

  return plan;
}
