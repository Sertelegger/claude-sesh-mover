/**
 * The two questions encryption at rest asks of the HUB, answered here and
 * nowhere else: *must this hub's bundles be encrypted*, and *to whom*.
 *
 * Nothing in this file encrypts anything, and that survives the wiring change:
 * the bytes move in `bundle-io.ts` and the primitives live in `crypto/age.ts`,
 * so "does the crypto work" and "does the bundle path use it correctly" stay
 * separately judgeable. What was added here is the third question the first two
 * do not answer — *what happens when a registered machine cannot be encrypted
 * to* — as a pure function, because that is a decision to be argued rather than
 * a pipeline to be wired (`planBundleEncryption`).
 *
 * **Nothing in this file is on the READ path.** A reader branches on the bundle
 * file's suffix and never on `resolveHubEncryption`; see `bundle-io.ts` for why
 * reaching for this module there fails in both directions at once.
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
/**
 * One census entry, rendered for a human. Never a path — `machineId` is display
 * only.
 *
 * Exported because `hub rekey` reaches the same conclusion about the same
 * machines and says something DIFFERENT about it (see `checkSelfIsRecipient`
 * for why the two verbs' premises differ). Sharing the rendering keeps the four
 * reasons described one way; sharing the decision would have been wrong.
 */
export declare function describeUnkeyed(u: UnkeyedMachine): string;
/**
 * The push's answer to "this hub is sealed — encrypt to whom, or refuse".
 *
 * Pure, and separate from `push.ts`, so the decision can be argued and tested
 * without a hub, an export and an archive around it.
 */
export type BundleEncryptionPlan = {
    kind: "plaintext";
    warnings: string[];
} | {
    kind: "encrypt";
    recipients: string[];
    warnings: string[];
} | {
    kind: "refuse";
    refusal: EncryptionRefusal;
    error: string;
    suggestion: string;
    /**
     * Disclosures collected before the refusal. **A refusal is not a reason to
     * withhold what was already found** — the same rule `ErrorResult.warnings`
     * states. The case that makes it load-bearing rather than tidy: a
     * malformed `encrypt` value is WHY encryption was required at all, so a
     * refusal that reports the un-keyed machine and drops that note explains
     * the symptom and hides the cause.
     */
    warnings: string[];
};
/**
 * WHICH of the three refusals, as a discriminator rather than as prose.
 *
 * It exists because the three have different remedies and only ONE of them
 * takes `--force-unkeyed`, so a caller has to tell them apart — and the obvious
 * way to do that, checking whether `unkeyedMachines` is empty, is wrong for two
 * of the three: the census is reported WHOLE, so `self-unkeyed` carries this
 * machine's own entry and `no-recipients` carries every machine on the hub.
 * Branching on the message text is banned everywhere else in this codebase for
 * the same reason it would be wrong here.
 *
 * - `unkeyed-machines` — machines OTHER than this one publish no usable key.
 *   The only one `--force-unkeyed` applies to.
 * - `self-unkeyed` — the pushing machine publishes no usable key of its own.
 *   Not overridable; the remedy is local (`~/.sesh-mover/identity.age`).
 * - `no-recipients` — nobody on the hub publishes a usable key, so there is
 *   nothing to encrypt to. Not overridable: a bundle encrypted to an empty
 *   recipient list is readable by nobody, which is worse than the plaintext
 *   being refused.
 */
export type EncryptionRefusal = "unkeyed-machines" | "self-unkeyed" | "no-recipients";
/**
 * "Can this machine read back what it is about to write to this hub, and to
 * whom would it be writing?" — the half of the encryption decision that is the
 * same for every verb that produces ciphertext.
 *
 * ### Why it is a function of its own, and what it deliberately leaves out
 *
 * It answers the two questions whose answers cannot differ between callers: the
 * SELF check (refusals 1 and 3 below) and the empty-set check (refusal 2). It
 * says nothing about machines OTHER than this one, because that is exactly
 * where two callers legitimately disagree:
 *
 * - **`hub push` refuses** when another registered machine publishes no usable
 *   key, and takes `--force-unkeyed` to proceed. Its premise is permanence: the
 *   bundle is written once, and a machine left out of that one recipient list
 *   cannot be added to it by anything the pushing machine does later.
 * - **`hub rekey` proceeds** and discloses, with no flag at all. Its premise is
 *   the opposite, and it is a fact rather than a preference: a re-wrap is
 *   idempotent and re-runnable, so a machine left out of THIS re-wrap is added
 *   by the NEXT one, as soon as it publishes a key. Refusing would block a
 *   strictly widening operation to prevent a loss that does not occur.
 *
 * Those are two different decisions over one census, which is why the census is
 * data (`HubRecipientSet`) and this function stops short of it.
 *
 * ### The self check is decided from the KEY THIS MACHINE HOLDS, never from the
 * hub's roster
 *
 * `registerMachine` deliberately CARRIES FORWARD a previously published
 * `ageRecipient` when the identity file cannot be read this run — the right
 * call there, because a transient read failure must not de-register this
 * machine as a recipient for everyone else. But it means the roster can say
 * this machine is keyed while the key is gone, so a self-check that asked the
 * census would pass, encrypt to a stanza nobody here can open, and fill the hub
 * with bundles this machine can never read back. The same hole opens the other
 * way if the identity file is REPLACED: the roster still carries the old public
 * half until the next successful check-in.
 *
 * So the test is membership: **the recipient this machine can derive right now
 * must be one of the recipients this file will be addressed to.** That is exact
 * in both directions, and it is a local fact rather than a hub one.
 *
 * ORDER IS LOAD-BEARING, and all three arms are reachable only in it. The local
 * no-key case comes first because it is the sharpest and most actionable, and
 * it subsumes the others: a machine that cannot read its own key has one
 * problem to fix and the state of the roster is beside the point. The empty
 * census comes next, so "nobody on this hub publishes a key" is not reported as
 * "your own registration is stale" — which is what the membership test would
 * say about it, since nothing is a member of an empty list. Only then the
 * membership test, which by that point really does mean what it says.
 */
export type SelfRecipientCheck = {
    ok: true;
    recipients: string[];
} | {
    ok: false;
    /** `self-unkeyed` covers both self arms — see `EncryptionRefusal`. */
    refusal: Exclude<EncryptionRefusal, "unkeyed-machines">;
    error: string;
    suggestion: string;
};
export declare function checkSelfIsRecipient(input: {
    census: HubRecipientSet;
    /** `loadOrCreateMachineId().id` — this operation's own machine. Display only. */
    thisMachineId: string;
    /**
     * The `age1…` recipient this machine can derive from its own identity file
     * RIGHT NOW, or `null` when that file is absent or unreadable. Deliberately
     * not read from the census; see above.
     */
    thisMachineRecipient: string | null;
}): SelfRecipientCheck;
/**
 * ## The decision: an un-keyed machine REFUSES the push, and the override is a flag
 *
 * `collectHubRecipients` hands back a census precisely so this call site has to
 * choose, and there are only three choices. Two of them are defensible and the
 * third is not:
 *
 * - **Silently encrypt to everyone else.** Rejected outright. The push
 *   succeeds, and the machine that was dropped cannot read that bundle — not
 *   after it upgrades, not after it publishes a key, not until the machine that
 *   WROTE it runs `hub rekey`, and not ever if that machine is gone, because
 *   only its owner may re-wrap it (per-machine ownership). The loss surfaces on
 *   the OTHER machine, at an arbitrary later time, as `no-matching-identity`,
 *   which reads like corruption. Every property of that failure is wrong:
 *   silent, remote, misdiagnosed, and repairable only from a third place.
 * - **Refuse.** The default, because the push side is the only moment where the
 *   fact is known, the remedy is cheap, and nothing has been lost yet. A push
 *   COPIES — nothing local is deleted and nothing on the hub is overwritten —
 *   so a refusal costs a retry and no data. That asymmetry is the whole
 *   argument: refusing costs bytes and time, proceeding costs a machine's
 *   access to a thread, forever.
 * - **Proceed on an explicit override, with the excluded machines named.**
 *   `--force-unkeyed`, because a blanket refusal has a real dead end: nothing
 *   in this codebase ever deletes a `machines/<id>.json` (`hub retire` deletes
 *   a project's files, never a machine record), so one decommissioned machine
 *   would block every encrypted push on the hub for good. The override is a
 *   FLAG and deliberately not a config key — same rule as `push --full` — so
 *   the unattended SessionEnd auto-push can never take it. The cost of that
 *   rule is worth stating: with encryption on and one un-keyed machine, the
 *   auto-push refuses at every session end, and the only place the user sees it
 *   is `hub status`'s `lastAutoPush`.
 *
 * **The self-exception is not overridable, and it is decided from the KEY THIS
 * MACHINE HOLDS — never from the hub's roster.** If the pushing machine cannot
 * read back what it is about to write, `--force-unkeyed` is refused, because the
 * override's premise ("I know those machines do not need this bundle") is
 * definitionally false about the machine writing it. That half lives in
 * `checkSelfIsRecipient`, shared with `hub rekey`, together with the reason the
 * roster is the wrong source for it — this function adds only the decision
 * about OTHER machines, which is the half the two verbs answer differently.
 *
 * **An empty recipient list refuses whatever the flags say.** `AgeEncryptStream`
 * refuses it too, but as a throw at the moment bytes start moving; answered here
 * it is a diagnosis instead of a stack trace.
 */
export declare function planBundleEncryption(input: {
    policy: HubEncryptionPolicy;
    census: HubRecipientSet;
    /** `loadOrCreateMachineId().id` — this push's own machine. Display only. */
    thisMachineId: string;
    /**
     * The `age1…` recipient this machine can derive from its own identity file
     * RIGHT NOW, or `null` when that file is absent or unreadable.
     *
     * Deliberately not read from the census: see `checkSelfIsRecipient` for why
     * the roster's answer to this question can be stale in both directions, and
     * why a stale answer is silent and permanent.
     */
    thisMachineRecipient: string | null;
    forceUnkeyed: boolean;
}): BundleEncryptionPlan;
//# sourceMappingURL=encryption.d.ts.map