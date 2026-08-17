/**
 * End-to-end guard for a peer machineId that is an `Object.prototype` name.
 *
 * `ThreadCopy.machineId` is the id an index file's CONTENT declares — nothing
 * validates it (`readMachineIndex` uses its `machineId` ARGUMENT only to build
 * the path it reads), and the id that IS checked, the filename-derived one, is
 * checked with `isSafeSessionId`, which accepts `__proto__` and `constructor`
 * because it answers a question about path shapes. That id then becomes the
 * peer key every ledger write in a pull uses.
 *
 * The site with the worst blast radius is `recordSplice` in hub/pull.ts: it
 * runs AFTER the user's transcript has already been extended, so on a plain
 * record `st.peers[id] ??= {…}` did not create the entry, `peer.name` and
 * `peer.lastReceivedAt` landed on `Object.prototype` ITSELF, and the very next
 * line threw — leaving the splice unrecorded, so the next pull re-needs the
 * bundle, chain-mismatches against the now-longer base and lands the same
 * entries again as a fragment.
 *
 * Reproduced against the committed dist/ before the fix, for both ids.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hubPull } from "../src/hub/pull.js";
import { readSyncState } from "../src/sync-state.js";
import { arrangeContinuation } from "./helpers/hub-fixtures.js";
import type { HubPullResult } from "../src/types.js";

/**
 * Rename the OTHER machine's index from the inside — its filename (which is
 * what `readAllIndexes` derives its id from, and dedupes on) is left alone.
 * That divergence is exactly what makes `ThreadCopy.machineId` untrusted.
 */
function declareMachineId(hub: string, projectId: string, localMachineId: string, spoofed: string): void {
  const dir = join(hub, "projects", projectId, "index");
  const names = readdirSync(dir).filter((n) => n.endsWith(".json") && n !== `${localMachineId}.json`);
  expect(names, "the peer must have published exactly one index file").toHaveLength(1);
  const p = join(dir, names[0]);
  const parsed = JSON.parse(readFileSync(p, "utf-8")) as { machineId: string };
  parsed.machineId = spoofed;
  writeFileSync(p, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
}

describe.each(["__proto__", "constructor"])(
  "a peer whose index declares machineId %s",
  (spoofed) => {
    it("splices its continuation and records the receipt against an own peer key", async () => {
      const a = await arrangeContinuation();
      const proto = Object.prototype as unknown as Record<string, unknown>;
      try {
        const { readMachineId } = await import("../src/machine.js");
        declareMachineId(a.hub, a.projectId, readMachineId()!.id, spoofed);

        const pull = await hubPull({
          configDir: a.configDirA, projectPath: a.projectA, hubPath: a.hub,
          latest: true, claudeVersion: "2.1.81",
        });
        expect(pull.success, JSON.stringify(pull)).toBe(true);
        // The splice really happened — this is the path recordSplice guards.
        expect((pull as HubPullResult).appended).toBeDefined();

        // The receipt is an OWN key, so it survives JSON.stringify and the next
        // pull will not re-need the bundle it just applied.
        const state = readSyncState(a.projectA);
        expect(Object.hasOwn(state.peers, spoofed)).toBe(true);
        expect(Object.keys(state.peers[spoofed].received)).toHaveLength(1);
        expect(state.peers[spoofed].lastReceivedAt).not.toBeNull();

        // ...and nothing of ours reached Object.prototype on the way.
        expect(Object.hasOwn(proto, "lastReceivedAt")).toBe(false);
        expect(Object.hasOwn(proto, "name")).toBe(false);
      } finally {
        delete proto.lastReceivedAt;
        delete proto.name;
        a.cleanup();
      }
    });
  }
);
