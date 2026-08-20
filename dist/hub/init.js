import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createFsBackend } from "./backend.js";
import { withHubIoTimeout } from "./io-timeout.js";
import { HUB_JSON, machinePath } from "./layout.js";
import { loadOrCreateMachineId } from "../machine.js";
import { loadOrCreateIdentity } from "../crypto/identity-file.js";
import { detectPlatform } from "../platform.js";
import { PLUGIN_VERSION } from "../version.js";
import { readConfigOverrides, writeConfigOverrides, setConfigOverride } from "../config.js";
import { projectSeshMoverDir, userSeshMoverDir } from "../paths.js";
export function resolveHubPath(config) {
    return config.hub.path ? config.hub.path : null;
}
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
 * ### It never fails a push over a key
 *
 * `loadOrCreateIdentity` returns a result and does not throw, and this function
 * does not turn `ok: false` into a refusal. A machine that has never enabled
 * encryption must not lose the ability to push plaintext because its identity
 * file is unreadable. The hard failure rule belongs at the ENCRYPTING call site,
 * where "no key" actually means "no confidentiality".
 *
 * ### A recipient it cannot prove is carried forward, never retracted
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
 */
export async function registerMachine(hubPath) {
    const backend = createFsBackend(hubPath);
    const identity = loadOrCreateMachineId();
    const key = loadOrCreateIdentity();
    let ageRecipient = key.ok ? key.recipient : undefined;
    if (ageRecipient === undefined) {
        try {
            const prior = JSON.parse((await backend.read(machinePath(identity.id))).toString());
            if (typeof prior.ageRecipient === "string" && prior.ageRecipient.length > 0) {
                ageRecipient = prior.ageRecipient;
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
    };
    await backend.writeAtomic(machinePath(identity.id), JSON.stringify(record, null, 2) + "\n");
    return record;
}
export async function hubInit(opts) {
    const hubPath = resolve(opts.hubPath);
    try {
        // The ONE hub syscall in this codebase that does not go through
        // `HubBackend` — it has to, because it is what creates the directory the
        // backend is then pointed at. It gets the same bound for the same reason
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
            error: `Cannot create hub directory ${hubPath}: ${e.message}`,
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
                error: `Existing hub.json is not readable: ${e.message}`,
                suggestion: "Point --path at an empty directory or a valid sesh-mover hub.",
            };
        }
    }
    else {
        hub = {
            schemaVersion: 1,
            hubId: randomUUID(),
            createdAt: new Date().toISOString(),
            pluginVersion: PLUGIN_VERSION,
            // Written explicitly rather than left absent, even though absent means the
            // same thing. `hub.json` is the file a user opens to find out what their
            // hub's policy IS, and a policy field you can only discover by reading
            // source is not a policy a user can check. See `HubJson.encrypt`.
            //
            // **Always `false`, and deliberately NOT seeded from the local
            // `hub.encrypt` preference.** Nothing in this version can encrypt a
            // bundle, so a hub created with `encrypt: true` would be one that every
            // machine — this one included — must refuse to push to. The preference
            // becomes an input to hub state when there is an enable verb to apply it,
            // and that verb is the place to check the machine roster's
            // `pluginVersion` first.
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
    };
}
//# sourceMappingURL=init.js.map