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
import { createFsBackend } from "./backend.js";
import { listMachineIds, readMachineRecord } from "./machines.js";
import { hubUnreachableRefusal, probeHubReachable } from "./preflight.js";
import { findPin, readPins, recordPin } from "./pins.js";
import { keyFingerprint } from "../crypto/signing-key.js";
import { loadOrCreateMachineId } from "../machine.js";
/** Compare two fingerprints as a human meant them — case and grouping are noise. */
function sameFingerprint(a, b) {
    const norm = (s) => s.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    return norm(a) !== "" && norm(a) === norm(b);
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
export async function hubTrust(opts) {
    const backend = createFsBackend(opts.hubPath);
    const probe = await probeHubReachable(opts.hubPath, backend);
    if (probe.state !== "ok")
        return hubUnreachableRefusal("hub-trust", probe.state);
    const warnings = [];
    // The probe already parsed `hub.json` — take its copy rather than opening a
    // second read of the same file, which is the consolidation `preflight.ts`
    // exists for.
    const hubId = probe.hub?.hubId ?? "";
    const me = loadOrCreateMachineId();
    const pins = readPins();
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const machines = await collectMachines(backend, hubId, pins, me.id);
    if (opts.machineId !== undefined) {
        const target = machines.find((m) => m.machineId === opts.machineId);
        if (!target) {
            return refuse("no-such-machine", `No machine ${opts.machineId} is registered on this hub.`, "Run `sesh-mover hub trust` with no arguments to list the machines this hub knows about, and confirm one of those.", warnings);
        }
        if (!target.signingPublicKey || !target.fingerprint) {
            return refuse("no-key-published", `Machine ${opts.machineId} has published no signing key, so there is nothing to confirm.`, "That machine has not pushed since signing shipped, or its key file was unreadable when it last checked in. One push or pull from it publishes the key; then run this again.", warnings);
        }
        if (!opts.fingerprint || !sameFingerprint(opts.fingerprint, target.fingerprint)) {
            // THE REFUSAL THAT MAKES THE CEREMONY REAL. Confirming without checking
            // would be the user typing yes to whatever the hub published — TOFU with
            // extra steps, and worse, with a false sense of having verified.
            return refuse("fingerprint-mismatch", opts.fingerprint
                ? `The fingerprint you gave does not match the key this hub publishes for ${opts.machineId}.`
                : `Confirming a key requires the fingerprint from the other machine.`, `Run \`sesh-mover hub trust\` ON MACHINE ${opts.machineId} and read its fingerprint from there — over a channel that is not this hub. Then re-run with --fingerprint. If the two genuinely differ, do not confirm: either that machine re-minted its key, or something is publishing a key it does not hold.`, warnings);
        }
        const outcome = recordPin({
            hubId,
            machineId: target.machineId,
            publicKey: target.signingPublicKey,
            origin: "confirmed",
            nowIso,
        });
        if (outcome.kind === "failed") {
            return refuse("pin-write-failed", `The fingerprint matched, but the pin could not be saved: ${outcome.detail}`, "Fix the permissions on ~/.sesh-mover and run this again. Until it is saved, this machine will keep treating that key as unconfirmed.", warnings);
        }
        if (outcome.kind === "conflict") {
            // Unreachable via this path (a `confirmed` origin replaces a conflicting
            // pin by design) and handled anyway rather than asserted away: this
            // module must not be the one that throws on a shape it did not expect.
            return refuse("fingerprint-mismatch", `A different key is already pinned for ${opts.machineId}.`, "Confirm the fingerprint on that machine again before replacing the pin.", warnings);
        }
        return {
            success: true,
            command: "hub-trust",
            hubId,
            machines: await collectMachines(backend, hubId, readPins(), me.id),
            confirmed: { machineId: target.machineId, fingerprint: target.fingerprint },
            warnings,
        };
    }
    const unconfirmed = machines.filter((m) => m.machineId !== me.id && m.pinned === "tofu").length;
    if (unconfirmed > 0) {
        warnings.push(`${unconfirmed} machine(s) are pinned on first use but not confirmed out of band. That is the default and is not an error — it means this machine trusted the hub once for those keys. Confirming a fingerprint is the only step in signing that does not depend on trusting the hub.`);
    }
    const conflicts = machines.filter((m) => m.conflict);
    if (conflicts.length > 0) {
        warnings.push(`${conflicts.length} machine(s) publish a key that differs from what is pinned here. Pulling a bundle from them will refuse until this is resolved. That is not proof of an attack — a machine that lost its key and re-minted looks exactly the same from here — which is why nothing resolves it automatically.`);
    }
    return { success: true, command: "hub-trust", hubId, machines, warnings };
}
function refuse(refusal, error, suggestion, warnings) {
    return { success: false, command: "hub-trust", reason: "trust-refused", refusal, error, suggestion, warnings };
}
async function collectMachines(backend, hubId, pins, meId) {
    const out = [];
    for (const id of await listMachineIds(backend)) {
        const read = await readMachineRecord(backend, id);
        const record = read.ok ? read.record : null;
        const key = record?.signingPublicKey ?? null;
        const pin = findPin(pins, hubId, id);
        out.push({
            machineId: id,
            machineName: record?.name ?? null,
            signingPublicKey: key,
            fingerprint: key ? keyFingerprint(key) : null,
            // This machine's own key is never "pinned" — it holds the private half,
            // so there is nothing to trust and a pin would be self-referential.
            pinned: id === meId ? null : (pin?.origin ?? null),
            conflict: id !== meId && pin !== null && key !== null && pin.publicKey !== key,
        });
    }
    out.sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
    return out;
}
//# sourceMappingURL=trust.js.map