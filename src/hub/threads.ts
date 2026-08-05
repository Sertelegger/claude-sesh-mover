import type { HubBundleRecord, HubIndexJson } from "./layout.js";

export interface ThreadCopy {
  machineId: string;
  localSessionId: string;
  slug: string;
  summary: string;
  headEntryUuid: string;
  messageCount: number;
  lastActiveAt: string;
  bundles: HubBundleRecord[];
}

export interface ResolvedThread {
  threadId: string;
  slug: string;
  summary: string;
  copies: ThreadCopy[];
  latest: ThreadCopy;
}

// Deterministic latest-copy ordering (spec §2): max lastActiveAt, then higher
// messageCount, then headEntryUuid lexical ascending. This tiebreak is
// load-bearing across the whole product ("which machine has my latest
// work") — it must produce the same answer regardless of machine/index
// iteration order, so every branch is a strict total order over the copy
// set, never insertion order.
function newer(a: ThreadCopy, b: ThreadCopy): ThreadCopy {
  if (a.lastActiveAt !== b.lastActiveAt) return a.lastActiveAt > b.lastActiveAt ? a : b;
  if (a.messageCount !== b.messageCount) return a.messageCount > b.messageCount ? a : b;
  if (a.headEntryUuid !== b.headEntryUuid) return a.headEntryUuid < b.headEntryUuid ? a : b;
  // Total tie. Without this last key the answer was the reduce ACCUMULATOR,
  // i.e. whichever index file the hub directory listed first — exactly the
  // insertion-order dependence the comment above forbids, and it is reachable
  // from the ordinary round trip (A pushes, B continues, A pulls the
  // continuation back and splices it: both copies then carry the same
  // lastActiveAt, messageCount and head). The two copies list DIFFERENT
  // bundles, so this decides what a third machine's pull actually fetches.
  // machineId is arbitrary as a preference and that is fine — it is stable,
  // which is the property being bought here.
  return a.machineId <= b.machineId ? a : b;
}

export function resolveThreads(indexes: HubIndexJson[]): ResolvedThread[] {
  const byThread = new Map<string, ThreadCopy[]>();
  for (const index of indexes) {
    for (const [threadId, entry] of Object.entries(index.threads)) {
      const copy: ThreadCopy = { machineId: index.machineId, ...entry };
      const list = byThread.get(threadId) ?? [];
      list.push(copy);
      byThread.set(threadId, list);
    }
  }
  const resolved: ResolvedThread[] = [];
  for (const [threadId, copies] of byThread) {
    const latest = copies.reduce(newer);
    resolved.push({ threadId, slug: latest.slug, summary: latest.summary, copies, latest });
  }
  // Same invariant as `newer` above, one level up: never depend on iteration
  // order. The obvious `a < b ? 1 : -1` is an INCONSISTENT comparator — it
  // returns -1 for equal values, so two equal-timestamped threads swap and
  // fourteen come back fully reversed when the input order reverses. Both
  // consumers pick positionally (`pull --latest` takes the first non-current
  // thread, the SessionStart notice takes the most recent stale one), so an
  // arbitrary winner among ties is a user-visible arbitrary answer.
  resolved.sort((a, b) => {
    if (a.latest.lastActiveAt !== b.latest.lastActiveAt) {
      return a.latest.lastActiveAt < b.latest.lastActiveAt ? 1 : -1;
    }
    return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
  });
  return resolved;
}
