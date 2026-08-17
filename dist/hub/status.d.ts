import type { HubStatusResult } from "../types.js";
/**
 * Report the hub's state; never refuse on it.
 *
 * **`hub status` deliberately does NOT return `hub-unreachable`** (#75's gate is
 * wired into push, pull and `hub reindex` instead). The argument is not that
 * status is unimportant — it is that the refusal would answer a different
 * question than the one asked. A user runs this command *to find out* whether
 * the hub is reachable; a `success: false` whose whole content is "the hub is
 * unreachable" would make the command fail in exactly the situation it exists
 * to describe, and would take `hubPath`, `machineRegistered`, `project.linked`
 * and `lastAutoPush` down with it — every one of which is still knowable, and
 * three of which are answers the user needs precisely *then*. `lastAutoPush` is
 * the sharpest: an unreachable hub is the commonest cause of a failed unattended
 * push, and this result is the only surviving record of one.
 *
 * What it takes from the gate is the CLASSIFICATION, not the refusal
 * (`probeHubReachable`). That is not tidiness either: `reachable` used to mean
 * "hub.json exists", so a `hub.json` carrying no `hubId` — what a sync client
 * mid-copy actually leaves behind — reported `reachable: true, hubId: undefined`
 * here while push and pull refused the same directory as `not-a-hub`. The two
 * now answer from one probe and cannot disagree.
 */
export declare function hubStatus(opts: {
    cwd: string;
}): Promise<HubStatusResult>;
//# sourceMappingURL=status.d.ts.map