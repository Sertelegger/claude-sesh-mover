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
  return a.headEntryUuid <= b.headEntryUuid ? a : b;
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
  resolved.sort((a, b) => (a.latest.lastActiveAt < b.latest.lastActiveAt ? 1 : -1));
  return resolved;
}
