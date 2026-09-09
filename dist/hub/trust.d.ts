/**
 * # `hub trust` — turning a hub-supplied key into a human-confirmed one (#86)
 *
 * ## What this verb is for, and why it is not optional in the design
 *
 * Signature verification pins a machine's key on first contact (TOFU), and
 * everything after that is loud. But first contact trusts whatever the hub
 * says — and on the filesystem backend, anyone who can tamper with a bundle can
 * also rewrite the victim's `machines/<id>.json` and publish a key of their
 * own. So TOFU covers the realistic timeline (hub honest when the fleet was set
 * up, compromised or migrated later) and covers nothing about an attacker who
 * was already there.
 *
 * This verb is the answer to that residue: print a fingerprint, let a human
 * compare it against the same fingerprint shown on the other machine, and
 * record the result as `confirmed`. That is the only step in this feature that
 * does not depend on trusting the hub, and it is why #86's "Done when" clause
 * is achievable at all.
 *
 * **It is optional by owner ruling**, because a single-owner fleet may
 * reasonably decline the ceremony — and a feature nobody runs is worse than one
 * that is honest about being unrun. So `hub status`-style reporting shows which
 * machines are `tofu` and which are `confirmed`, rather than nagging.
 *
 * ## The comparison is done by a person, and the output is shaped for that
 *
 * The fingerprint is printed in grouped hex blocks because an unbroken run of
 * base64 is where a human comparison actually fails — people check the first
 * few characters and the last few and skip the middle. Grouping makes a
 * mid-string difference visible.
 *
 * **The fingerprint is never what verification compares.** That uses the full
 * key. A truncated fingerprint is a smaller search space, and no automated
 * check should ever settle for one; this abbreviation exists solely because a
 * human cannot compare 43 characters reliably.
 *
 * ## What it deliberately will not do
 *
 * It will not confirm a key it has not been shown. `--machine` names the key and
 * `--fingerprint` takes the
 * fingerprint the user read off the other machine and refuses if it does not
 * match what the hub is currently publishing — otherwise the "ceremony" would
 * be the user typing yes to whatever the hub said, which is TOFU with extra
 * steps and a false sense of having checked.
 */
import type { HubUnreachableResult } from "../types.js";
export interface TrustedMachine {
    machineId: string;
    machineName: string | null;
    /** Absent when that machine has never published one (older version, or an unreadable key file). */
    signingPublicKey: string | null;
    fingerprint: string | null;
    /** `null` when this machine has never seen a signed bundle from it. */
    pinned: "tofu" | "confirmed" | null;
    /**
     * True when the hub is currently publishing a key that differs from the pin.
     * Never resolved here — see `pins.ts`: nothing local can tell a re-mint from
     * an attack, so the decision is a human's.
     */
    conflict: boolean;
}
export interface HubTrustResult {
    success: true;
    command: "hub-trust";
    hubId: string;
    machines: TrustedMachine[];
    /** Set when `--machine` + `--fingerprint` matched and a pin was written. */
    confirmed?: {
        machineId: string;
        fingerprint: string;
    };
    warnings: string[];
}
export interface HubTrustRefusedResult {
    success: false;
    command: "hub-trust";
    reason: "trust-refused";
    refusal: "no-such-machine" | "no-key-published" | "fingerprint-mismatch" | "pin-write-failed";
    error: string;
    suggestion: string;
    warnings: string[];
}
/**
 * NO `HubLockBusyResult` — this verb takes no project lock, so it cannot
 * return one. It was in this union until an audit noticed the verb has no
 * `acquireProjectLock` call at all, and a union member a function cannot
 * produce is worse than noise: it tells every caller to write a branch that
 * can never run, and tells the next reader this verb contends with pushes.
 * It writes only this machine's own local pin file (see `hubTrust`).
 */
export type HubTrustOutcome = HubTrustResult | HubTrustRefusedResult | HubUnreachableResult;
export interface HubTrustOptions {
    projectPath: string;
    hubPath: string;
    /** Confirm this machine's key. Requires `fingerprint`. */
    machineId?: string;
    /** The fingerprint the user read off the OTHER machine. */
    fingerprint?: string;
    nowIso?: string;
}
/**
 * List every machine's signing key with its pin state, and optionally confirm
 * one.
 *
 * **Takes no project lock and writes nothing on the hub.** It reads the machine
 * roster and writes only this machine's own local pin file, so there is nothing
 * for two machines to contend over — the same reasoning that lets `hub escrow`
 * run lockless.
 */
export declare function hubTrust(opts: HubTrustOptions): Promise<HubTrustOutcome>;
//# sourceMappingURL=trust.d.ts.map