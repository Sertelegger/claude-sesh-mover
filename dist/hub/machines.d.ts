/**
 * The hub's machine roster: which machines are registered, and what each one's
 * record says.
 *
 * **This exists so there is exactly ONE rule for "what counts as a machine
 * record".** `hub status` had that rule privately, and the moment a second
 * reader needed it (the recipient list, `encryption.ts`) it became the kind of
 * thing that ends up implemented twice and disagreeing — a hub where `hub
 * status` says three machines and the recipient list encrypts to two is a hub
 * where one machine silently cannot read anything.
 */
import type { HubBackend } from "./backend.js";
import { type HubMachineJson } from "./layout.js";
/**
 * Every machine id registered on this hub, sorted, deduped.
 *
 * **Immediate `.json` children of `machines/` only** — the rule `readAllIndexes`
 * applies to `index/`, for the identical reason (#28). `backend.list` walks
 * RECURSIVELY and filters only a `.tmp-` marker in a basename, and the hub is
 * documented as a shared or synced directory, so foreign entries beside the
 * records are the EXPECTED case rather than a hostile one: a Syncthing
 * `.stversions/` adds one entry per retained version of a single record, a
 * Dropbox conflict directory adds a nested copy of one, and a `.DS_Store`,
 * `Thumbs.db` or editor swap file adds one each. Counting those inflated `hub
 * status`'s machine count silently; feeding them to the recipient list would
 * turn each into a phantom "machine with no key".
 *
 * The `seen` set is the belt for a future backend whose `list` is a flat prefix
 * listing over an object store with no real directories.
 *
 * Sorted so that every consumer gets a deterministic order — the recipient list
 * becomes stanza order in an age header, and a test that pins it must not be
 * hostage to `readdir` order.
 *
 * **Does not read or validate the files, and does not filter unsafe ids.** Both
 * are the caller's job and they differ by caller: `hub status` counts (a corrupt
 * record is still a machine that joined, and nothing there turns the name into a
 * path), while `readMachineRecord` builds a path from the id and so has to
 * check it. Dropping unsafe ids here would hide them from the consumer that
 * needs to disclose them.
 */
export declare function listMachineIds(backend: HubBackend): Promise<string[]>;
/**
 * Why a machine record did not yield a usable record object.
 *
 * `unsafe-id` is separate from `unreadable` on purpose: the file was never READ.
 * An id that fails `isSafeSessionId` cannot be turned into a hub-relative path
 * without becoming a traversal, so the only safe handling is to decline to open
 * it — and to say so, rather than to let it vanish into the same bucket as a
 * record that was opened and found corrupt.
 */
export type MachineRecordProblem = "absent" | "unreadable" | "unsafe-id";
export type MachineRecordRead = {
    ok: true;
    record: HubMachineJson;
} | {
    ok: false;
    problem: MachineRecordProblem;
};
/**
 * Read one `machines/<id>.json`.
 *
 * A record is accepted as long as it parses to an object; individual fields are
 * validated by whoever uses them (`encryption.ts` re-parses `ageRecipient`
 * through `parseRecipient` rather than trusting the string, because a recipient
 * that does not parse is a *different* fact from one that is absent).
 */
export declare function readMachineRecord(backend: HubBackend, machineId: string): Promise<MachineRecordRead>;
//# sourceMappingURL=machines.d.ts.map