/**
 * The two questions encryption at rest asks of the HUB, answered here and
 * nowhere else: *must this hub's bundles be encrypted*, and *to whom*.
 *
 * Nothing in this file encrypts anything. It is the seam the wiring change
 * plugs into, and it is separate from that change on purpose: "does the crypto
 * work" (`crypto/age.ts`) and "does the bundle path use it correctly" stay
 * separately judgeable.
 */
import type { HubBackend } from "./backend.js";
import type { HubJson } from "./layout.js";
export interface HubRecipient {
    machineId: string;
    /** From the machine record; `null` when the record carries no usable name. */
    name: string | null;
    /** `age1…`, already validated by `parseRecipient`. */
    recipient: string;
}
/**
 * Why a registered machine is not in the recipient list.
 *
 * - `no-key` — the record has no `ageRecipient` at all: a machine on a version
 *   that predates this field, or one whose identity file was unreadable when it
 *   last checked in.
 * - `bad-key` — the field is there and is not an age recipient. A hand-edited
 *   or damaged record, or a hostile one.
 * - `unreadable-record` — `machines/<id>.json` did not parse, or vanished
 *   between the listing and the read.
 * - `unsafe-id` — the file name is not usable as a hub path component, so the
 *   record was never opened. Reported, never read, and never turned into a path.
 */
export type UnkeyedReason = "no-key" | "bad-key" | "unreadable-record" | "unsafe-id";
export interface UnkeyedMachine {
    /**
     * The id as it appeared on the hub. **Display only.** For `unsafe-id` this is
     * by definition a string that must not be interpolated into a path.
     */
    machineId: string;
    name: string | null;
    reason: UnkeyedReason;
}
/**
 * A CENSUS of the hub's machines, split into those that can be encrypted to and
 * those that cannot — never a filtered list of the former.
 *
 * **This shape is the whole point of the function.** The obvious signature
 * returns `string[]` of recipients, and it has a silent, permanent failure mode:
 * a machine that publishes no public key is dropped, the bundle is encrypted to
 * everyone else, and that machine can never read it. Nobody finds out at write
 * time — the push succeeds — and at read time it surfaces on the *other*
 * machine as `no-matching-identity`, which looks like corruption. A dropped
 * recipient is indistinguishable, at the call site, from a machine that does not
 * exist. So the un-keyed machines come back as DATA, and refusing (or
 * proceeding, on an explicit override) is the caller's decision to make and to
 * disclose.
 */
export interface HubRecipientSet {
    recipients: HubRecipient[];
    unkeyed: UnkeyedMachine[];
}
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
export declare function collectHubRecipients(backend: HubBackend): Promise<HubRecipientSet>;
export interface HubEncryptionPolicy {
    /**
     * Ciphertext is required for this hub. **The HUB's answer, not this
     * machine's** — see `resolveHubEncryption`.
     */
    required: boolean;
    /** This machine's local `hub.encrypt` config value. */
    preferred: boolean;
    /**
     * This machine wants encryption and the hub does not require it. Not a
     * refusal and not an enable: a machine that encrypted unilaterally would push
     * bundles the rest of the hub cannot read. It is a disclosure — the remedy is
     * to turn the switch on for the hub, not for this machine.
     */
    unappliedPreference: boolean;
    /**
     * `hub.json`'s `encrypt` was present and was neither `true` nor `false`. See
     * `resolveHubEncryption` for why that resolves to `required: true`.
     */
    malformedSetting: boolean;
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
export declare function resolveHubEncryption(hub: HubJson, preference: boolean): HubEncryptionPolicy;
//# sourceMappingURL=encryption.d.ts.map