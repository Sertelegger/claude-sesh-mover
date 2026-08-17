/**
 * End-to-end guard for a peer machineId that is an `Object.prototype` name.
 *
 * `ThreadCopy.machineId` is the id an index file carries, and the check it
 * passes is `isSafeSessionId`, which accepts `__proto__` and `constructor`
 * because it answers a question about path SHAPES, not about JavaScript keys.
 * That id then becomes the peer key every ledger write in a pull uses.
 *
 * HOW THE FIXTURE GOT HERE CHANGED WITH #28 (2026-08-17), THE DEFECT DID NOT.
 * This file used to rename the peer's index from the INSIDE and leave its
 * filename alone, because the content-declared id was validated by nothing and
 * that divergence was the whole reason `ThreadCopy.machineId` was untrusted.
 * `readMachineIndex` now reconciles the two and the filename wins, so a file
 * renamed only on the inside is skipped and never reaches a pull at all —
 * which would have made this test pass while exercising nothing. It now
 * republishes the peer's index under the prototype-name identity, filename and
 * content together (see `republishPeerIndexAs`). That is still admitted, by
 * exactly the same rule: `isSafeSessionId("__proto__")` is true, so
 * `index/__proto__.json` is a legal hub filename and the id it derives becomes
 * the peer key. The reconciliation closed a path-safety hole; it is not, and
 * was never claimed to be, a prototype-key filter.
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
import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hubPull } from "../src/hub/pull.js";
import { readSyncState } from "../src/sync-state.js";
import { arrangeContinuation } from "./helpers/hub-fixtures.js";
import type { HubPullResult } from "../src/types.js";

/**
 * Republish the OTHER machine's index under a prototype-name identity — the
 * FILENAME and the declared `machineId` together, since #28 those must agree or
 * the file is skipped before any of this is reachable.
 *
 * The bundle records inside keep pointing at `bundles/<the real id>/…`, which
 * is a hub-relative path the backend validates on its own, so the payload is
 * still fetchable and only the IDENTITY the pull books it under moves.
 */
function republishPeerIndexAs(hub: string, projectId: string, localMachineId: string, spoofed: string): void {
  const dir = join(hub, "projects", projectId, "index");
  const names = readdirSync(dir).filter((n) => n.endsWith(".json") && n !== `${localMachineId}.json`);
  expect(names, "the peer must have published exactly one index file").toHaveLength(1);
  const p = join(dir, names[0]);
  const parsed = JSON.parse(readFileSync(p, "utf-8")) as { machineId: string };
  parsed.machineId = spoofed;
  writeFileSync(join(dir, `${spoofed}.json`), JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  rmSync(p);
}

describe.each(["__proto__", "constructor"])(
  "a peer whose index declares machineId %s",
  (spoofed) => {
    it("splices its continuation and records the receipt against an own peer key", async () => {
      const a = await arrangeContinuation();
      const proto = Object.prototype as unknown as Record<string, unknown>;
      try {
        const { readMachineId } = await import("../src/machine.js");
        republishPeerIndexAs(a.hub, a.projectId, readMachineId()!.id, spoofed);

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
