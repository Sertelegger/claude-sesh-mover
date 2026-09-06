/**
 * # The pin store (#86) — where signing actually gets its teeth
 *
 * **Read this before deciding the pin store is an optimization.** Without it,
 * signature verification against a hub-published key detects exactly one
 * adversary: a tamperer who edits a bundle and then declines to re-sign it.
 * Anyone else who can write to the hub can rewrite the victim's
 * `machines/<id>.json`, substitute their own signing key, and sign whatever
 * they like. The codebase already states this about the recipient list —
 * "**Not a trust decision.** Whoever can write `machines/<id>.json` can add
 * themselves as a recipient of every future bundle" — and the identical
 * reasoning applies here.
 *
 * On the Slice-1 filesystem backend, "peer" and "hub operator" are not even
 * distinct adversaries: every participating machine has full write access to
 * the whole hub, and per-machine ownership is a convention, not an enforcement.
 * So this file is not a hardening pass on top of signing. It is the part that
 * makes signing mean anything, and it ships in the same slice as the signature.
 *
 * ## What TOFU does and does not buy, stated plainly
 *
 * First contact trusts whatever the hub says. After that, the key is fixed
 * locally and a change is loud. That covers the realistic timeline — hub honest
 * when the fleet was set up, compromised or migrated later — and covers nothing
 * about an attacker who was already there before this machine ever pulled.
 *
 * `hub trust` is the answer to that residue: a fingerprint the user compares
 * out of band, once, which converts a hub-supplied key into a human-confirmed
 * one. It is optional by owner ruling, because a single-owner fleet may
 * reasonably decline the ceremony — but the option has to exist, or #86's
 * "does not depend on trusting the hub to vouch for a key" is simply false
 * rather than partially satisfied.
 *
 * ## Local, per hub, and never on the hub
 *
 * Pins live under `~/.sesh-mover/`, keyed by `(hubId, machineId)`. Putting them
 * on the hub would be circular — an attacker who can rewrite the key can
 * rewrite the pin that vouches for it — and per-hub because the same machine id
 * on two different hubs is two different trust decisions.
 *
 * A `confirmed` pin (via `hub trust`) is never silently replaced by a TOFU
 * write; that is the whole difference between the two, and it is enforced in
 * `recordPin` rather than left to callers.
 */
export interface KeyPin {
    hubId: string;
    machineId: string;
    /** Base64url raw Ed25519 public key. */
    publicKey: string;
    /**
     * How this pin came to be. `tofu` trusted the hub once; `confirmed` means a
     * human compared a fingerprint out of band via `hub trust`.
     *
     * The distinction is not cosmetic: a `confirmed` pin outranks anything the
     * hub says, and a re-pin of one requires the user to say so again.
     */
    origin: "tofu" | "confirmed";
    firstSeenAt: string;
    /**
     * Set when a pin is deliberately replaced, so a machine that legitimately
     * re-minted a key leaves a trail rather than looking identical to an attack
     * in the record afterwards.
     */
    replacedAt?: string;
    previousKey?: string;
}
interface PinFile {
    schemaVersion: 1;
    pins: KeyPin[];
}
export declare function pinFilePath(): string;
/**
 * Read the pin store.
 *
 * **A store that cannot be read is EMPTY, never an error** — and that is a
 * deliberate weakening with a stated reason. The alternative, refusing every
 * pull until the pin file is repaired, turns a local file problem into total
 * loss of function, and the failure it would be protecting against (an attacker
 * who deletes the pin file to force re-TOFU) already requires local write
 * access, at which point the attacker can edit the pins instead. So an
 * unreadable store degrades to first-contact behaviour, which is loud in a
 * different way: every machine re-pins and `hub trust` shows unconfirmed.
 */
export declare function readPins(): PinFile;
export declare function findPin(pins: PinFile, hubId: string, machineId: string): KeyPin | null;
export type PinOutcome = {
    kind: "unchanged";
    pin: KeyPin;
} | {
    kind: "pinned";
    pin: KeyPin;
}
/** A different key than pinned. NOT written — the caller decides. */
 | {
    kind: "conflict";
    pinned: KeyPin;
    found: string;
} | {
    kind: "failed";
    detail: string;
};
/**
 * Record a key for a machine, refusing to overwrite a conflicting pin.
 *
 * **This never resolves a conflict**, which is the point: a key that differs
 * from the pin is either a machine that re-minted or an attacker, and nothing
 * available here can tell those apart. Returning `conflict` and writing nothing
 * pushes the decision to a human, which is where it belongs.
 *
 * `confirmed` may overwrite `tofu` for the SAME key (an out-of-band
 * confirmation of what was already there) — an upgrade in trust with no change
 * in fact. It may also replace a conflicting pin, because that is exactly what
 * `hub trust` is for after a legitimate re-mint, and the old key is kept in
 * `previousKey` so the change stays visible.
 */
export declare function recordPin(args: {
    hubId: string;
    machineId: string;
    publicKey: string;
    origin: "tofu" | "confirmed";
    nowIso: string;
}): PinOutcome;
export {};
//# sourceMappingURL=pins.d.ts.map