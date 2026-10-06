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
 * "Fixed locally" is only true because the `hubId` half of the key is ALSO
 * fixed locally. It used to be read off the hub's own `hub.json` on every run,
 * so rewriting that one field made every lookup here miss and re-pinned every
 * machine on first use — a `confirmed` pin included, which was simply never
 * consulted. `joined-hubs.ts` now remembers which hub identity this machine
 * joined at each address, and every hub verb refuses on a change BEFORE it
 * looks a pin up. Read that file before trusting the key below.
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
 * on two different hubs is two different trust decisions. The `hubId` is the
 * one this machine JOINED (`joined-hubs.ts`), never merely the one `hub.json`
 * happens to carry today; the two are equal by the time any caller gets here,
 * because a difference refuses the verb first.
 *
 * A deliberate re-join of a re-identified hub (`hub init --accept-new-hub-id`)
 * CARRIES every pin to the new id (`carryPinsForward`) rather than starting
 * over: same address, same machines, same keys. Without that, the flag that
 * accepts a changed identity would itself be the reset primitive.
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
     * hub says about that machine's key — on the hub identity this machine
     * joined, which `joined-hubs.ts` holds still — and a re-pin of one requires
     * the user to say so again.
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
    /**
     * Set on a pin `carryPinsForward` copied from an earlier id of the same hub
     * address, naming that id — so a carried pin is never mistaken for one this
     * machine formed on the new id by itself.
     */
    carriedFromHubId?: string;
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
export type CarryOutcome = {
    kind: "carried";
    carried: number;
    /**
     * Machines already pinned under the new id with a DIFFERENT key than the
     * old id's pin. Left exactly as they are — the same refusal `recordPin`
     * makes — and named, because two keys for one machine is a human's call.
     */
    conflicts: string[];
} | {
    kind: "failed";
    detail: string;
};
/**
 * Copy every pin `(fromHubId, m)` to `(toHubId, m)` where there is none,
 * preserving key, origin and history — `confirmed` stays `confirmed`. The old
 * pins stay where they are.
 *
 * Called by `hub init --accept-new-hub-id` and nothing else. The argument for
 * it is the one that makes the flag safe to offer: a re-identified hub at the
 * same address has the same machines holding the same keys, so the pins are
 * still true; and if acceptance started every machine over at first-use, the
 * flag would be exactly the reset the joined-hub check exists to stop — one
 * wrong "yes" and a substituted key sails in as a first sighting.
 *
 * Writes nothing when there is nothing to carry, which is also what keeps an
 * unreadable pin store (read as empty) from being overwritten here.
 */
export declare function carryPinsForward(args: {
    fromHubId: string;
    toHubId: string;
}): CarryOutcome;
export {};
//# sourceMappingURL=pins.d.ts.map