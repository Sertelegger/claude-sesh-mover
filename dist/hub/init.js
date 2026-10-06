import { mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createFsBackend } from "./backend.js";
import { withHubIoTimeout } from "./io-timeout.js";
import { HUB_JSON, machinePath } from "./layout.js";
import { expandLeadingTilde, hubAddress, normalizeHubPathInput } from "./hub-path.js";
import { describeHubIdEvidence, describeHubNotPresent, evidenceContradiction, findJoinedHub, localHubIdEvidence, proseHubId, readJoinedHubs, recordJoinedHub, tiedEvidence, } from "./joined-hubs.js";
import { carryPinsForward } from "./pins.js";
import { hubIdentityChangedRefusal } from "./preflight.js";
import { errorMessage } from "../errors.js";
import { loadOrCreateMachineId } from "../machine.js";
import { loadOrCreateIdentity } from "../crypto/identity-file.js";
import { loadOrCreateSigningKey } from "../crypto/signing-key.js";
import { detectPlatform } from "../platform.js";
import { PLUGIN_VERSION } from "../version.js";
import { readConfigOverrides, writeConfigOverrides, setConfigOverride } from "../config.js";
import { projectSeshMoverDir, userSeshMoverDir } from "../paths.js";
/**
 * The configured hub path, as every verb uses it.
 *
 * A leading `~` is expanded here too (#162), not only at the write sites: a
 * `configure --set hub.path=~/hub` from before the fix stored the literal, and
 * every verb then resolved it against its own working directory — a different
 * hub per project. A stored RELATIVE value is left as it is; see `hub-path.ts`
 * for why that belongs to #112.
 */
export function resolveHubPath(config) {
    return config.hub.path ? expandLeadingTilde(config.hub.path) : null;
}
/**
 * The hub layout's top-level directories — everything `layout.ts`'s path
 * builders create besides `hub.json` (`machinePath` → `machines/`, and every
 * per-project builder → `projects/`). Their presence without a `hub.json` is
 * what the init guard refuses on.
 */
const HUB_CONTENT_DIRS = ["machines", "projects"];
/**
 * Refresh this machine's registration file. Called by init and by every
 * push/pull (cheap single-file write, owned solely by this machine).
 *
 * ### It publishes this machine's public key, unconditionally
 *
 * Not gated on encryption being enabled, and that is the decision rather than an
 * oversight. The recipient list has to be complete BEFORE the first encrypted
 * push, not after it. Gate publication on `hub.encrypt` and enabling encryption
 * on machine A produces bundles readable only by A — machine B is absent from
 * the recipient list until its own next push, and A's bundles from that window
 * stay unreadable to B afterwards until A runs `hub rekey` — only A may re-wrap
 * A's bundles (per-machine ownership), so the repair depends on A still
 * existing. Publishing on every check-in is what makes enabling encryption
 * later a switch rather than a flag day, and it is also what keeps that repair
 * cheap instead of impossible.
 *
 * The cost is that a machine which has never encrypted anything mints a keypair
 * on its next ordinary push and publishes 62 characters beside the id, name,
 * platform and timestamp it already published. A public key is not a secret, and
 * generating one is 32 bytes of `randomBytes`.
 *
 * The SIGNING key (#86) is published on the same unconditional schedule for the
 * parallel reason: the key has to be on the hub before the first bundle signed
 * with it is pulled, or the puller has nothing to pin. Same cost, same
 * non-secret, one more mint on first check-in.
 *
 * ### It never fails a push over a key
 *
 * `loadOrCreateIdentity` returns a result and does not throw, and this function
 * does not turn `ok: false` into a refusal. A machine that has never enabled
 * encryption must not lose the ability to push plaintext because its identity
 * file is unreadable. The hard failure rule belongs at the ENCRYPTING call site,
 * where "no key" actually means "no confidentiality".
 *
 * The signing key (#86) rides the same rule, with a stronger owner ruling
 * behind it: even the SIGNING call site in push.ts warns and pushes unsigned
 * rather than refusing, so a fortiori a broken key file must not stop the
 * check-in that merely publishes its public half.
 *
 * ### A key it cannot prove is carried forward, never retracted
 *
 * If the identity cannot be read this run, the previously published
 * `ageRecipient` on this machine's own record is preserved instead of being
 * dropped by the overwrite. `writeAtomic` replaces the whole file, so the naive
 * version silently de-registers this machine as a recipient on any transient
 * read failure — a full disk, a permission blip — and the other machines quietly
 * stop encrypting to a key this machine still holds. Carrying it forward fails
 * toward "still a recipient", which is the safe direction: a stanza wrapped for
 * a key nobody holds costs 100 bytes, and being dropped costs the ability to
 * read anything ever again. Reading this machine's own record before writing it
 * is squarely inside per-machine ownership.
 *
 * `signingPublicKey` gets the identical carry-forward, and the safe direction
 * is the same one for a different reason: the published key is what `hub
 * trust` fingerprints and what a first-contact pin records, so a transient
 * read failure that retracted it would hand the next machine to pull an empty
 * slot where the pinnable key was — while a stale-but-real key costs nothing,
 * because verification reads the key off the signed statement and checks it
 * against the PIN, never against this record.
 */
export async function registerMachine(hubPath) {
    const backend = createFsBackend(hubPath);
    const identity = loadOrCreateMachineId();
    const key = loadOrCreateIdentity();
    let ageRecipient = key.ok ? key.recipient : undefined;
    const signing = loadOrCreateSigningKey();
    let signingPublicKey = signing.ok ? signing.publicKey : undefined;
    if (ageRecipient === undefined || signingPublicKey === undefined) {
        try {
            const prior = JSON.parse((await backend.read(machinePath(identity.id))).toString());
            if (ageRecipient === undefined && typeof prior.ageRecipient === "string" && prior.ageRecipient.length > 0) {
                ageRecipient = prior.ageRecipient;
            }
            if (signingPublicKey === undefined &&
                typeof prior.signingPublicKey === "string" &&
                prior.signingPublicKey.length > 0) {
                signingPublicKey = prior.signingPublicKey;
            }
        }
        catch {
            // No prior record, or an unreadable one. Nothing to carry forward, and
            // this is the ordinary first-registration path — never an error.
        }
    }
    const record = {
        id: identity.id,
        name: identity.name,
        platform: detectPlatform(),
        lastSeenAt: new Date().toISOString(),
        pluginVersion: PLUGIN_VERSION,
        ...(ageRecipient === undefined ? {} : { ageRecipient }),
        ...(signingPublicKey === undefined ? {} : { signingPublicKey }),
    };
    await backend.writeAtomic(machinePath(identity.id), JSON.stringify(record, null, 2) + "\n");
    return record;
}
export async function hubInit(opts) {
    // BEFORE the mkdir (#162): a relative path would be created under the
    // working directory, which is how a hub came to live inside the project it
    // was meant to sync — and to ride out in that project's own payloads.
    const input = normalizeHubPathInput(opts.hubPath);
    if (!input.ok) {
        return {
            success: false,
            command: "hub-init",
            reason: "hub-path-not-absolute",
            given: input.given,
            error: `Hub path "${input.given}" is not absolute, so it would name a different directory from every working directory. Nothing was created.`,
            suggestion: "Pass an absolute --path — the full path to the synced folder or share. A leading ~ is expanded to your home directory; ~user is not.",
        };
    }
    const hubPath = input.path;
    const nowIso = new Date().toISOString();
    const address = hubAddress(hubPath);
    // What this machine joined here before, if anything. Read BEFORE the mkdir
    // and before any hub write, because every refusal below must leave both the
    // hub and this machine exactly as they were — including not creating the
    // directory: a leftover `/Volumes/<share>` makes the next mount of that share
    // land at `<share> 1`, and a phantom hub directory is what `hub status`
    // would then report as "not a hub" instead of "not mounted".
    const joined = readJoinedHubs();
    const recorded = findJoinedHub(joined, address);
    const accept = opts.acceptNewHubId === true;
    // With no record here, what this machine's own records tie to this address
    // (`tiedEvidence`). Read at most once, and only where it matters: a
    // directory with nothing in it, and the warning when one is minted over
    // anyway. It opens every hub-using project's config — and, where there is
    // none, checks that the project directory is there — each call bounded.
    let tied = null;
    const tiedHere = async () => (tied ??= tiedEvidence(await localHubIdEvidence(address, { readTie: "always" })));
    // The unmounted-mount-point refusal, for both the recorded and the evidence
    // case — `null` when neither says a hub was ever here.
    const notPresent = async (directoryMissing) => {
        if (recorded) {
            return hubNotPresentRefusal({
                hubPath, address, expectedHubIds: [recorded.hubId], basis: "recorded", directoryMissing,
                configScope: opts.configScope,
            });
        }
        const evidence = await tiedHere();
        return evidence.ids.length === 0
            ? null
            : hubNotPresentRefusal({
                hubPath, address, expectedHubIds: evidence.ids, basis: "evidence", evidenceSource: evidence.source,
                unresolved: evidence.unresolved, directoryMissing, configScope: opts.configScope,
            });
    };
    if (!accept && (await hubDirectoryMissing(hubPath))) {
        const refusal = await notPresent(true);
        if (refusal)
            return refusal;
    }
    try {
        // One of the two hub syscalls in this codebase that do not go through
        // `HubBackend` (the other is `hubDirectoryMissing`'s `stat`, just above) —
        // it has to, because it is what creates the directory the backend is then
        // pointed at. It gets the same bound for the same reason
        // (#71): on a hung mount a synchronous `mkdirSync` here blocked forever
        // before any backend existed to be non-blocking, which would have left a
        // hole in the fix exactly where `hub init` is most likely to be run (a
        // share the user is still setting up).
        await withHubIoTimeout("mkdir", () => mkdir(hubPath, { recursive: true }));
    }
    catch (e) {
        return {
            success: false,
            command: "hub-init",
            error: `Cannot create hub directory ${hubPath}: ${errorMessage(e)}`,
            suggestion: "Check that the path is writable (network share mounted, sync folder present).",
        };
    }
    const backend = createFsBackend(hubPath);
    let created = false;
    let hub;
    if (await backend.exists(HUB_JSON)) {
        try {
            hub = JSON.parse((await backend.read(HUB_JSON)).toString());
            if (hub.schemaVersion !== 1 || !hub.hubId)
                throw new Error("unrecognized hub.json shape");
        }
        catch (e) {
            return {
                success: false,
                command: "hub-init",
                error: `Existing hub.json is not readable: ${errorMessage(e)}`,
                suggestion: "Point --path at an empty directory or a valid sesh-mover hub.",
            };
        }
        // A JOIN at an address this machine already joined under a different id.
        // The explicit first join at an address with no record is trust-on-first-
        // use, exactly like a first pin, and records without further question.
        if (recorded && recorded.hubId !== hub.hubId && !accept) {
            return hubIdentityChangedRefusal("hub-init", {
                address, currentHubId: hub.hubId, expectedHubIds: [recorded.hubId], basis: "recorded",
                configScope: opts.configScope,
            });
        }
    }
    else {
        // No hub.json. Two refusals before minting one, and the ORDER matters: hub
        // content without an identity is most likely a sync still in flight (class
        // 3, retry), which is the more useful thing to say even when this machine
        // also has a record here.
        const found = [];
        for (const dir of HUB_CONTENT_DIRS) {
            if (await backend.exists(dir))
                found.push(dir);
        }
        if (found.length > 0 && !accept) {
            return {
                success: false,
                command: "hub-init",
                reason: "hub-content-without-identity",
                hubPath,
                found,
                error: `${hubPath} already holds hub content (${found.map((d) => `${d}/`).join(", ")}) but no hub.json, so it cannot be joined, and minting a new identity over it would split the hub in two. Nothing was written.`,
                suggestion: "If this is a synced folder, its first sync is probably still in flight — hub.json has not arrived yet. Wait for the sync client to finish and re-run `sesh-mover hub init` with the same --path; it will join the existing hub. Only if hub.json is truly lost, re-run with --accept-new-hub-id to mint a new identity for this directory — and know what that costs: every machine already using this hub then refuses it until someone deliberately re-joins there, and a machine that never joined under the old identity reads the bundles signed under it as tampering.",
            };
        }
        // An EMPTY directory where this machine joined a hub before — or, with no
        // record, where its own projects say a hub lives, or where it cannot rule
        // that out because some project's hub path is unsettled: the unmounted mount
        // point (the directory-not-there case was refused before the mkdir, which
        // here was a no-op on a directory that already existed). Minting here
        // would shadow the real hub the moment it mounts, with a different id.
        if (!accept) {
            const refusal = await notPresent(false);
            if (refusal)
                return refusal;
        }
        hub = {
            schemaVersion: 1,
            hubId: randomUUID(),
            createdAt: nowIso,
            pluginVersion: PLUGIN_VERSION,
            // Written explicitly rather than left absent, even though absent means the
            // same thing. `hub.json` is the file a user opens to find out what their
            // hub's policy IS, and a policy field you can only discover by reading
            // source is not a policy a user can check. See `HubJson.encrypt`.
            //
            // **Always `false`, and deliberately NOT seeded from the local
            // `hub.encrypt` preference.** Bundles can be encrypted now — which is
            // exactly why this must stay `false`: `hub encrypt --enable` is the
            // one place this field flips from `false` to `true`, and that
            // transition (`changed`, below) is what triggers its two disclosure
            // warnings — that enabling doesn't protect what's already on the hub,
            // and that its authentication proves the group holds the key, not the
            // sender. Seed `true` here instead and the hub is born already
            // "sealed": the transition never happens, so neither warning is ever
            // shown for it. The preference still reaches `hub.json` — through that
            // verb, where the warnings travel with the write.
            encrypt: false,
        };
        await backend.writeAtomic(HUB_JSON, JSON.stringify(hub, null, 2) + "\n");
        created = true;
    }
    // NOTE: joining an existing hub deliberately does NOT restamp `pluginVersion`
    // or touch `encrypt`. `hub.json` is the one hub file no machine owns, and
    // rewriting a shared file to advertise a version would spend the invariant
    // that makes concurrent push/pull safe without a distributed lock. The
    // per-machine record below is where this machine's version goes.
    await registerMachine(hubPath);
    const warnings = [];
    const identity = await recordIdentity({ address, hub, nowIso, accept, recorded, created, tiedHere, warnings });
    const configDir = opts.configScope === "project"
        ? projectSeshMoverDir(opts.cwd)
        : userSeshMoverDir();
    // Overrides, not a defaults-backfilled config: `hub init --scope project`
    // writing every default into the project file would pin them over the user
    // scope for this project (the same defect the `configure --set` path had).
    writeConfigOverrides(configDir, setConfigOverride(readConfigOverrides(configDir), "hub.path", hubPath));
    return {
        success: true,
        command: "hub-init",
        hubPath,
        hubId: hub.hubId,
        created,
        machineRegistered: true,
        configScope: opts.configScope,
        ...identity,
        warnings,
    };
}
/**
 * Is there nothing at all at the hub path? A bounded `stat` (#71's rule: this
 * is `hub init`, the verb most likely to be run at a share the user is still
 * setting up). Only a definite ENOENT answers yes; anything else — a timeout
 * included — answers no and leaves the mkdir below to report it.
 */
async function hubDirectoryMissing(hubPath) {
    try {
        await withHubIoTimeout("stat", () => stat(hubPath));
        return false;
    }
    catch (e) {
        return e?.code === "ENOENT";
    }
}
function hubNotPresentRefusal(args) {
    const { hubPath, expectedHubIds, basis, directoryMissing } = args;
    const ids = expectedHubIds.map(proseHubId).join(", ");
    // Named only when the refusal comes from them: an undetermined tie.
    const unresolved = basis === "evidence" && args.evidenceSource === "undetermined" ? (args.unresolved ?? []) : [];
    const n = unresolved.length;
    const where = basis === "recorded"
        ? `where this machine joined ${ids}`
        : n > 0
            ? `and this machine cannot rule out that the hub its records name (${ids}) lives there, because the hub configuration of ${n === 1 ? "1 project" : `${n} projects`} could not be settled`
            : `which this machine's own records tie to ${ids}`;
    return {
        success: false,
        command: "hub-init",
        reason: "hub-identity-not-present",
        hubPath,
        expectedHubIds,
        basis,
        ...(n > 0 ? { unresolvedProjects: unresolved } : {}),
        error: `No hub at ${hubPath} (${directoryMissing ? "the directory is not there" : "it holds no hub.json and no hub content"}), ${where}.`,
        suggestion: describeHubNotPresent({ ...args, unresolved }),
    };
}
/**
 * Record `address -> hubId` in `joined-hubs.json`, and on an accepted change
 * carry this machine's signing-key pins from the old id to the new one.
 *
 * After the hub write and the registration, so a refusal or a throw above
 * leaves the local record untouched — and not a reason to fail the join
 * itself when it cannot be written: the hub was joined, and a machine with no
 * record falls back to the evidence check on its next verb, which is weaker
 * than a record but still a check. The warning says which.
 *
 * **Pins are carried BEFORE the record changes.** The record is what lets
 * every other verb through under the new id; written first, a pull running in
 * the gap would pass the probe, find no pin under the new id and pin whatever
 * key it met. Carried first, the gap holds pins under an id nothing accepts
 * yet — inert, since every verb still refuses on the old record.
 */
async function recordIdentity(args) {
    const { address, hub, nowIso, accept, recorded, created, tiedHere, warnings } = args;
    const carry = accept && recorded && recorded.hubId !== hub.hubId
        ? carryPinsForward({ fromHubId: recorded.hubId, toHubId: hub.hubId })
        : null;
    const outcome = recordJoinedHub({
        address, hubId: hub.hubId, origin: accept ? "accepted-change" : "init", nowIso,
    });
    switch (outcome.kind) {
        case "recorded": {
            // A first record at this address. Trust-on-first-use by design — but if
            // this machine's own records do not name exactly this identity for the
            // path, the user may think this is a re-join, and it is not: nothing
            // carries over, so say what that costs.
            if (!created) {
                const contradicted = evidenceContradiction(await localHubIdEvidence(address, { readTie: "when-it-can-decide" }), hub.hubId);
                if (contradicted !== null) {
                    warnings.push(`This machine had no record of joining a hub at ${address}, and ${describeHubIdEvidence(contradicted.ids, contradicted.source)}. The hub there, ${proseHubId(hub.hubId)}, is now recorded as this machine's hub at that path. ` +
                        `If it is the hub you meant to join, nothing is wrong. If you did not expect that identity there, this was not a re-join: no signing-key pin was carried over to it from any other identity, so every machine on it that is not already pinned under this identity will have its key pinned afresh on first use — stop and find out who can write to that directory before pulling anything.`);
                }
            }
            else {
                // A hub this run MINTED at a path this machine's own records tie to a
                // hub — reachable only with --accept-new-hub-id, since without it the
                // not-present and content-without-identity refusals come first.
                const evidence = await tiedHere();
                if (evidence.ids.length > 0) {
                    warnings.push(`This machine had no record of joining a hub at ${address}, but ${describeHubIdEvidence(evidence.ids, evidence.source)} — and a new hub, ${proseHubId(hub.hubId)}, was created there anyway because --accept-new-hub-id was passed. It is not any identity those records name. ` +
                        `With no record here there was no joined identity to carry signing-key pins from, so none were carried: every machine that joins this hub has its key pinned afresh on first use. ` +
                        `If the hub those records name is only unmounted or not synced here yet, this new one will shadow it the moment it appears, and every machine already using that hub will refuse this directory's identity.`);
                }
            }
            return { identity: "recorded" };
        }
        case "unchanged":
            return { identity: "unchanged" };
        case "changed": {
            // `recorded` was read before the hub write; a concurrent re-record in
            // between would make it differ from `previousHubId`. Carry from the id
            // actually replaced, if the early carry was from another.
            const effective = carry !== null && recorded?.hubId === outcome.previousHubId
                ? carry
                : carryPinsForward({ fromHubId: outcome.previousHubId, toHubId: hub.hubId });
            const pinsCarried = effective.kind === "carried" ? effective.carried : 0;
            warnings.push(`This hub's identity changed from ${proseHubId(outcome.previousHubId)} to ${proseHubId(hub.hubId)}, and this machine has now accepted that: --accept-new-hub-id was passed. ` +
                `${pinsCarried} signing-key pin(s) were carried forward to the new identity, so every machine's key stays exactly as trusted as it was — a key that differs from its pin still refuses. ` +
                `What the hub is recorded as already holding is kept per hub identity too, so this machine's next push re-sends its sessions in full, once. ` +
                `If you did not re-create this hub yourself, this acceptance was a mistake: someone who can write to it may have rewritten hub.json, and you should find out who before pulling anything.`);
            if (effective.kind === "failed") {
                warnings.push(`The signing-key pins could NOT be carried forward (${effective.detail}), so every machine on this hub will be pinned afresh on first use. Fix the permissions on ~/.sesh-mover before pulling from this hub.`);
            }
            else if (effective.conflicts.length > 0) {
                warnings.push(`Machine(s) ${effective.conflicts.join(", ")} were already pinned under the new identity with a DIFFERENT key than under the old one. Those pins were left as they are; compare fingerprints out of band before trusting either.`);
            }
            return { identity: "accepted-change", previousHubId: outcome.previousHubId, pinsCarried };
        }
        case "conflict":
            // The callers above refuse this case before any write, so reaching it
            // means another process recorded a different id between that read and
            // this write. Say so; never overwrite it silently.
            warnings.push(`Another sesh-mover process recorded ${proseHubId(outcome.recorded.hubId)} for this hub address while this one ran, so this join was not recorded. Run \`sesh-mover hub status\` to see which identity this machine now expects.`);
            return { identity: "not-recorded" };
        case "store-unreadable":
            warnings.push(`~/.sesh-mover/joined-hubs.json exists but could not be read (${outcome.detail}), so which hub this machine joined here was not recorded — and the file was left untouched rather than overwritten, because it holds the record for every other hub address too. Until it is repaired or moved aside, this machine checks this hub's identity against its sync-state and signing-key pins only.`);
            return { identity: "not-recorded" };
        case "failed":
            warnings.push(`Which hub this machine joined here could not be recorded (${outcome.detail}). Until it is, this machine checks this hub's identity against its sync-state and signing-key pins only.`);
            return { identity: "not-recorded" };
    }
}
//# sourceMappingURL=init.js.map