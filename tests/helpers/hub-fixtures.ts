/**
 * Shared HubIndexJson fixture builders for hub tests (moved out of
 * hub-threads.test.ts in Task 9 so hub-whereis.test.ts can reuse the same
 * shorthand instead of copy-pasting it).
 */
import type { HubIndexJson } from "../../src/hub/layout.js";

export function idx(machineId: string, threads: HubIndexJson["threads"]): HubIndexJson {
  return {
    schemaVersion: 1,
    agent: "claude-code",
    projectId: "p",
    machineId,
    updatedAt: "t",
    projectPath: "/x",
    threads,
  };
}

export function entry(over: Partial<HubIndexJson["threads"][string]>): HubIndexJson["threads"][string] {
  return {
    localSessionId: "s",
    slug: "slug",
    summary: "sum",
    headEntryUuid: "u",
    messageCount: 1,
    lastActiveAt: "2026-07-21T00:00:00Z",
    bundles: [],
    ...over,
  };
}
