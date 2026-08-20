/**
 * The two questions encryption at rest asks of the HUB, answered here and
 * nowhere else: *must this hub's bundles be encrypted*, and *to whom*.
 *
 * Nothing in this file encrypts anything. It is the seam the wiring change
 * plugs into, and it is separate from that change on purpose: "does the crypto
 * work" (`crypto/age.ts`) and "does the bundle path use it correctly" stay
 * separately judgeable.
 */
import { parseRecipient } from "../crypto/age.js";
import { listMachineIds, readMachineRecord } from "./machines.js";
/**
 * Collect the recipient list from the machine records on the hub.
 *
 * **Hub-wide, not per project, and that is deliberate.** `machines/<id>.json` is
 * hub-global to begin with, but the reason not to narrow it to "machines that
 * have an index under this project" is sharper than tidiness: a machine that has
 * joined the hub and not yet pulled the project has no index there, so a
 * per-project set would exclude precisely the machine that is about to pull —
 * and it would be excluded from the bundle it needs, permanently. The hub's
 * threat model is "a directory shared between machines you own" (Slice 1), under
 * which every registered machine is a legitimate reader; narrowing it buys no
 * confidentiality against anyone who can read the hub directory at all.
 *
 * **Reads nothing but `machines/`, and writes nothing.** In particular it does
 * not consult local config or local state: the recipient list is derivable from
 * the hub itself, which is what keeps the derivable-indexes invariant intact and
 * what makes joining a machine be `hub init` plus a re-push rather than a
 * distribution step.
 *
 * **Known residual: this list only ever grows.** Nothing in this codebase
 * deletes a `machines/<id>.json` — `hub retire` deletes a project's files, never
 * a machine record — so a decommissioned machine stays a recipient of every
 * future bundle for as long as its record sits on the hub. The cost is one
 * ~100-byte stanza per bundle, and the remedy is deleting the record by hand.
 * That is worth knowing before adding a pruning verb, because pruning is a
 * REVOCATION and revocation of a machine that may still hold its key is a
 * different (and harsher) decision than tidying a listing.
 *
 * **Not a trust decision.** Whoever can write `machines/<id>.json` can add
 * themselves as a recipient of every future bundle. That is fine under Slice 1
 * and stops being fine when the hub is a service; recipient *pinning* is
 * phase-gated to 4b (spec §2.3) and is deliberately not implemented here. Do not
 * read this function's acceptance of a record as an assertion that the record is
 * trustworthy.
 */
export async function collectHubRecipients(backend) {
    const recipients = [];
    const unkeyed = [];
    for (const machineId of await listMachineIds(backend)) {
        const read = await readMachineRecord(backend, machineId);
        if (!read.ok) {
            unkeyed.push({
                machineId,
                name: null,
                reason: read.problem === "unsafe-id" ? "unsafe-id" : "unreadable-record",
            });
            continue;
        }
        const name = typeof read.record.name === "string" ? read.record.name : null;
        const published = read.record.ageRecipient;
        if (typeof published !== "string" || published.length === 0) {
            unkeyed.push({ machineId, name, reason: "no-key" });
            continue;
        }
        try {
            // Re-parsed rather than trusted. A string that is not an age recipient
            // would otherwise reach the encryptor and fail there, at a point where the
            // only honest thing left to do is abort the whole push; caught here it is
            // one named machine in a list the caller can act on.
            parseRecipient(published);
        }
        catch {
            unkeyed.push({ machineId, name, reason: "bad-key" });
            continue;
        }
        recipients.push({ machineId, name, recipient: published });
    }
    return { recipients, unkeyed };
}
/**
 * Resolve whether bundles pushed to this hub must be encrypted.
 *
 * **`hub.json` is authoritative; the local config key is a preference.** The
 * reason is the failure a local-only flag has: one machine that never set it
 * keeps pushing plaintext into a hub the user believes is sealed, and nothing
 * anywhere says so. Putting the switch in `hub.json` — which every push and pull
 * already reads through the preflight — means a machine that has not enabled it
 * locally still refuses to push plaintext.
 *
 * **A malformed value resolves to `required: true`, and the asymmetry is
 * chosen.** `encrypt: "true"` (a string, from a hand edit) read as `false` is a
 * silent confidentiality loss of exactly the kind this field exists to prevent;
 * read as `true` it is at worst a surprise the user can undo, on bundles they
 * hold the keys to. Absent stays `false` — that is every hub in existence today
 * and must not become an encrypted one by inference.
 *
 * ### What this CANNOT do, and it is the honest half
 *
 * It cannot make an old plugin obey. A version that predates this field does not
 * read `hub.json.encrypt`, does not read `hub.json.pluginVersion` either, and
 * pushes plaintext into an "encrypted" hub without noticing — the traced
 * behaviour is that push and pull read `hubId` and check nothing else. **A
 * version field cannot stop an old plugin; it can only let a new one notice.**
 * The place that noticing happens is the machine ROSTER, not this function: each
 * `machines/<id>.json` carries the `pluginVersion` its machine last checked in
 * with, so a new plugin can look at the roster and name the machines that will
 * push plaintext. That is a diagnosis offered to the user, never an enforcement.
 */
export function resolveHubEncryption(hub, preference) {
    // Destructured, not read as a property path, because the config key and the
    // hub.json field are spelled the same: a literal `hub.encrypt` in code reads
    // to the flag/key sweep in `tests/hub-warning-flags.test.ts` as a MESSAGE
    // advising a config key, and blunting that guard to accommodate one property
    // access is a bad trade. This being the only reader of the field is the design
    // anyway, so there is exactly one place to keep it this way.
    const { encrypt } = hub;
    const malformedSetting = encrypt !== undefined && typeof encrypt !== "boolean";
    const required = malformedSetting || encrypt === true;
    return {
        required,
        preferred: preference,
        unappliedPreference: preference && !required,
        malformedSetting,
    };
}
//# sourceMappingURL=encryption.js.map