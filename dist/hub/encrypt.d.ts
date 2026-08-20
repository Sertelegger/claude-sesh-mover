/**
 * `hub encrypt` — read the hub-wide encryption switch, or turn it on.
 *
 * ## What enabling does, and the one sentence that has to reach the user
 *
 * **Enabling encryption does not make an existing hub private. It makes it
 * private going forward.** Everything already on the hub stays readable by
 * anyone with read access to the directory, forever. That is not an
 * implementation shortcut: in-place re-encryption would mean one machine
 * rewriting *other machines'* bundle files, which per-machine ownership — the
 * invariant that makes concurrent push and pull safe without a distributed lock
 * — forbids outright. The remedies are a fresh hub, or each machine re-writing
 * its own bundles, which is a different verb and is not in this slice.
 *
 * So a hub is permanently MIXED, and every reader branches on the bundle file's
 * suffix rather than on this switch. See `bundle-io.ts`.
 *
 * ## The refusal, and what a version field can and cannot buy
 *
 * `--enable` refuses when a registered machine last checked in on a plugin
 * version that predates encryption, and names it. That machine does not read
 * `hub.json`'s `encrypt` field at all — push and pull read `hubId` and check
 * nothing else, `schemaVersion` included — so it keeps pushing plaintext into a
 * hub the user now believes is sealed, and nothing anywhere says so.
 *
 * **A version field cannot stop an old plugin; it can only let a new one
 * notice.** This is the noticing, and it is a diagnosis rather than an
 * enforcement. The gate is deliberately not overridable: the honest remedies are
 * to upgrade that machine and let it run any hub command once, or — if it is
 * decommissioned — to delete its record from the hub, which is the same remedy
 * `collectHubRecipients` already names for the fact that the machine roster only
 * ever grows. An override here would be a flag on the verb whose whole job is to
 * ask the question, offered to the user least equipped to answer it; the place
 * where the same trade-off IS offered is `push --force-unkeyed`, where the
 * consequence is concrete and scoped to one upload.
 *
 * **This machine is exempt from the version gate, tautologically**: the process
 * evaluating the gate is by construction running a build that implements
 * encryption, whatever `PLUGIN_VERSION` happens to say. Its roster entry is
 * refreshed by the `registerMachine` call below before anything is read.
 */
import type { ErrorResult, HubEncryptRefusedResult, HubEncryptResult, HubUnreachableResult } from "../types.js";
/**
 * The first plugin version that can produce and consume an encrypted bundle.
 *
 * A constant rather than `PLUGIN_VERSION`, and the difference is the whole
 * point: this is a fact about the FEATURE's history, and it must not move when
 * the plugin's version does. Comparing against `PLUGIN_VERSION` would make every
 * release silently declare every machine that has not upgraded to it "too old
 * for encryption", which is a different and much harsher claim.
 */
export declare const MIN_ENCRYPTION_PLUGIN_VERSION = "0.10.0";
/**
 * Does this recorded version understand encrypted bundles?
 *
 * Absent → **no**, and that is the common real case rather than an edge one: the
 * field itself postdates most hubs, and a machine that has not checked in since
 * it was added records nothing. Unparseable → **no** as well, explicitly rather
 * than via `compareVersions`'s `NaN` arithmetic, because a gate whose safe
 * direction depends on how `NaN >= 0` evaluates is a gate nobody can read.
 */
export declare function isEncryptionCapableVersion(recorded: string | undefined): boolean;
export interface StaleMachine {
    machineId: string;
    name: string | null;
    pluginVersion: string | null;
    lastSeenAt: string | null;
}
export interface HubEncryptOptions {
    hubPath: string;
    /**
     * Flip the hub-wide switch on. Absent = report.
     *
     * A read still writes ONE thing: this machine's own `machines/<id>.json`, via
     * the `registerMachine` call every hub verb makes. Saying "writes nothing"
     * would be the convenient simplification and it is false — and the write is
     * useful rather than incidental, since it is what publishes this machine's
     * public key and so makes it a recipient of everything pushed afterwards.
     * What a read does not touch is `hub.json`, which is the switch.
     */
    enable?: boolean;
    /** Where to record the local `hub.encrypt` preference when enabling. */
    configScope?: "user" | "project";
    /**
     * This machine's local `hub.encrypt` config value as it stands BEFORE this
     * command, resolved by the caller from `computeEffectiveConfig`.
     *
     * Supplied rather than read here for the reason every other verb states: this
     * module is handed a decision, not a config directory. It also stops
     * `HubEncryptResult.preference` being a fabrication — it used to be
     * initialised as a copy of `enabled`, i.e. a field documented as "this
     * machine's local preference" that reported the HUB's setting and never once
     * consulted local config.
     */
    preference?: boolean;
    /**
     * The project directory the `project` config scope writes under.
     *
     * Must be the SAME directory whose config the caller resolved, or
     * `--scope project` records the preference somewhere the next command will not
     * read it back from.
     */
    cwd: string;
}
export declare function hubEncrypt(opts: HubEncryptOptions): Promise<HubEncryptResult | HubEncryptRefusedResult | HubUnreachableResult | ErrorResult>;
//# sourceMappingURL=encrypt.d.ts.map