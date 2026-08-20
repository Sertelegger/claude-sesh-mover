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
import { isSafeSessionId } from "../manifest.js";
import { machinePath } from "./layout.js";
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
export async function listMachineIds(backend) {
    const prefix = "machines/";
    const seen = new Set();
    for (const file of await backend.list("machines")) {
        if (!file.startsWith(prefix))
            continue;
        const name = file.slice(prefix.length);
        if (name.includes("/"))
            continue;
        if (!name.endsWith(".json"))
            continue;
        seen.add(name.slice(0, -".json".length));
    }
    return [...seen].sort();
}
/**
 * Read one `machines/<id>.json`.
 *
 * A record is accepted as long as it parses to an object; individual fields are
 * validated by whoever uses them (`encryption.ts` re-parses `ageRecipient`
 * through `parseRecipient` rather than trusting the string, because a recipient
 * that does not parse is a *different* fact from one that is absent).
 */
export async function readMachineRecord(backend, machineId) {
    if (!isSafeSessionId(machineId))
        return { ok: false, problem: "unsafe-id" };
    let raw;
    try {
        raw = await backend.read(machinePath(machineId));
    }
    catch {
        // Routinely absent rather than exotic: a machine that pushed before its
        // record landed, a pruned hub, a sync still in flight (`whereis.ts` carries
        // the longer note on this).
        return { ok: false, problem: "absent" };
    }
    try {
        const parsed = JSON.parse(raw.toString());
        if (parsed === null || typeof parsed !== "object") {
            return { ok: false, problem: "unreadable" };
        }
        return { ok: true, record: parsed };
    }
    catch {
        return { ok: false, problem: "unreadable" };
    }
}
//# sourceMappingURL=machines.js.map