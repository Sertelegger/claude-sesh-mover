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
// ---------------------------------------------------------------------------
// What to do about it: the push-side decision
// ---------------------------------------------------------------------------
/**
 * One census entry, rendered for a human. Never a path — `machineId` is display
 * only.
 *
 * Exported because `hub rekey` reaches the same conclusion about the same
 * machines and says something DIFFERENT about it (see `checkSelfIsRecipient`
 * for why the two verbs' premises differ). Sharing the rendering keeps the four
 * reasons described one way; sharing the decision would have been wrong.
 */
export function describeUnkeyed(u) {
    const who = u.name && u.name !== u.machineId ? `${u.name} (${u.machineId})` : u.machineId;
    switch (u.reason) {
        case "no-key":
            return `${who} — publishes no public key (a machine on a version that predates encryption, or one whose identity file was unreadable when it last checked in)`;
        case "bad-key":
            return `${who} — publishes something that is not an age recipient (a hand-edited or damaged record)`;
        case "unreadable-record":
            return `${who} — its machines/<id>.json did not parse, or vanished while this push was reading it`;
        case "unsafe-id":
            return `${who} — its file name is not usable as a hub path component, so the record was never opened`;
    }
}
export function checkSelfIsRecipient(input) {
    const { census } = input;
    if (input.thisMachineRecipient === null) {
        return {
            ok: false,
            refusal: "self-unkeyed",
            error: "This hub's bundles are encrypted and this machine cannot read its own identity key, so it could not produce a bundle it is able to read back.",
            suggestion: "Nothing was written to the hub. Encrypting a bundle this machine cannot read back is never the right answer, so this one refusal is not overridable. The key lives at ~/.sesh-mover/identity.age and is created on first use: check that the file is readable and holds an AGE-SECRET-KEY-1 line, restore it from a backup if you have one, or delete it to have a fresh identity minted — a fresh identity cannot read anything already on the hub, so try the first two first.",
        };
    }
    if (census.recipients.length === 0) {
        return {
            ok: false,
            refusal: "no-recipients",
            error: "This hub's bundles are encrypted and no registered machine publishes a usable public key, so there is nobody to encrypt to.",
            suggestion: "Nothing was written to the hub. A bundle encrypted to an empty recipient list is readable by nobody, which is worse than the plaintext this hub is refusing. Run any hub command on each machine you want to be able to read this project — registration publishes the public half of that machine's key on every push and pull — then try again.",
        };
    }
    if (!census.recipients.some((r) => r.recipient === input.thisMachineRecipient)) {
        return {
            ok: false,
            refusal: "self-unkeyed",
            error: `This hub's bundles are encrypted and the hub's record for this machine (${input.thisMachineId}) does not publish the key this machine actually holds, so a bundle addressed to that record could not be read back here.`,
            suggestion: "Nothing was written to the hub, and this is not overridable — a hub full of bundles the machine that wrote them cannot open is never the right answer. The usual cause is a registration that did not land: this machine's record on the hub carries an older public key, or none, because the identity file was unreadable the last time it checked in. Run `sesh-mover hub status` (or any hub command) so the record is rewritten with the current key, then try again. If instead the identity file was REPLACED, note that every bundle already encrypted to the old key stays unreadable here whatever you do next, so restore the old identity from a backup before going further.",
        };
    }
    return { ok: true, recipients: census.recipients.map((r) => r.recipient) };
}
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
export function planBundleEncryption(input) {
    const { policy, census } = input;
    const warnings = [];
    if (policy.malformedSetting) {
        warnings.push("This hub's hub.json has an `encrypt` value that is neither true nor false. It was read as ENCRYPTED, because a hand-edited `\"true\"` read the other way is a silent confidentiality loss and this direction is at worst a surprise on bundles you hold the keys to. Fix the value on the hub to settle it.");
    }
    if (!policy.required) {
        if (policy.unappliedPreference) {
            warnings.push("This machine prefers encryption at rest but this hub is not sealed, so this bundle went to the hub as PLAINTEXT and nothing can change that after the fact. The switch is hub-wide, not per machine — a machine that encrypted unilaterally would push bundles the rest of the hub cannot read. Seal the hub with `sesh-mover hub encrypt --enable` and later pushes from every machine are encrypted.");
        }
        return { kind: "plaintext", warnings };
    }
    const self = checkSelfIsRecipient(input);
    if (!self.ok) {
        return {
            kind: "refuse",
            refusal: self.refusal,
            error: self.error,
            suggestion: self.suggestion,
            warnings,
        };
    }
    if (census.unkeyed.length > 0) {
        const named = census.unkeyed.map(describeUnkeyed);
        if (!input.forceUnkeyed) {
            return {
                kind: "refuse",
                refusal: "unkeyed-machines",
                error: `This hub requires encrypted bundles and ${census.unkeyed.length} registered machine(s) cannot be encrypted to: ${named.join("; ")}.`,
                suggestion: "Nothing was uploaded, and nothing on the hub changed. A push writes a bundle once, addressed to the machines the hub lists at that moment, so a machine left out of it reads nothing of this thread until THIS machine re-addresses its own bundles with `sesh-mover hub rekey` — and never, if this machine is gone by then. Upgrade and run any hub command on each machine above so it publishes its key, or, if a machine is decommissioned, delete its machines/<id>.json from the hub directory. To upload anyway, accepting that those machines cannot read this bundle until a later rekey here, re-run with --force-unkeyed.",
                warnings,
            };
        }
        warnings.push(`--force-unkeyed: this bundle was encrypted WITHOUT ${census.unkeyed.length} registered machine(s), which therefore cannot read it — ${named.join("; ")}. A push writes a bundle once and never revisits it, so for everything this push uploaded that stands until those machines publish a key AND this machine re-addresses its own bundles with \`sesh-mover hub rekey\`; if this machine is decommissioned first, it stands for good.`);
    }
    return { kind: "encrypt", recipients: self.recipients, warnings };
}
//# sourceMappingURL=encryption.js.map