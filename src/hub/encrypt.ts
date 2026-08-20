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

import { HUB_JSON, type HubMachineJson } from "./layout.js";
import { createFsBackend } from "./backend.js";
import { collectHubRecipients, resolveHubEncryption } from "./encryption.js";
import { registerMachine } from "./init.js";
import { listMachineIds, readMachineRecord } from "./machines.js";
import { hubUnreachableRefusal, probeHubReachable } from "./preflight.js";
import { loadOrCreateMachineId } from "../machine.js";
import { compareVersions } from "../version-adapters.js";
import { readConfigOverrides, writeConfigOverrides, setConfigOverride } from "../config.js";
import { projectSeshMoverDir, userSeshMoverDir } from "../paths.js";
import type {
  ErrorResult, HubEncryptRefusedResult, HubEncryptResult, HubUnreachableResult,
} from "../types.js";

/**
 * The first plugin version that can produce and consume an encrypted bundle.
 *
 * A constant rather than `PLUGIN_VERSION`, and the difference is the whole
 * point: this is a fact about the FEATURE's history, and it must not move when
 * the plugin's version does. Comparing against `PLUGIN_VERSION` would make every
 * release silently declare every machine that has not upgraded to it "too old
 * for encryption", which is a different and much harsher claim.
 */
export const MIN_ENCRYPTION_PLUGIN_VERSION = "0.10.0";

/**
 * Does this recorded version understand encrypted bundles?
 *
 * Absent → **no**, and that is the common real case rather than an edge one: the
 * field itself postdates most hubs, and a machine that has not checked in since
 * it was added records nothing. Unparseable → **no** as well, explicitly rather
 * than via `compareVersions`'s `NaN` arithmetic, because a gate whose safe
 * direction depends on how `NaN >= 0` evaluates is a gate nobody can read.
 */
export function isEncryptionCapableVersion(recorded: string | undefined): boolean {
  if (typeof recorded !== "string" || !/^\d+(?:\.\d+)*$/.test(recorded.trim())) return false;
  return compareVersions(recorded.trim(), MIN_ENCRYPTION_PLUGIN_VERSION) >= 0;
}

export interface StaleMachine {
  machineId: string;
  name: string | null;
  pluginVersion: string | null;
  lastSeenAt: string | null;
}

function describeStale(m: StaleMachine): string {
  const who = m.name && m.name !== m.machineId ? `${m.name} (${m.machineId})` : m.machineId;
  const version = m.pluginVersion ? `version ${m.pluginVersion}` : "no recorded version";
  const seen = m.lastSeenAt ? `, last seen ${m.lastSeenAt}` : "";
  return `${who} — ${version}${seen}`;
}

/**
 * Every registered machine that would push plaintext into a sealed hub.
 *
 * Reads the roster, never local config. A record that will not parse is
 * reported as stale with `pluginVersion: null`: it is not evidence of an old
 * plugin, but it is equally not evidence of a new one, and the direction to fail
 * in is the one that names a machine rather than the one that seals a hub on an
 * assumption.
 */
async function findStaleMachines(
  backend: ReturnType<typeof createFsBackend>,
  exemptMachineId: string
): Promise<StaleMachine[]> {
  const stale: StaleMachine[] = [];
  for (const machineId of await listMachineIds(backend)) {
    if (machineId === exemptMachineId) continue;
    const read = await readMachineRecord(backend, machineId);
    if (!read.ok) {
      stale.push({ machineId, name: null, pluginVersion: null, lastSeenAt: null });
      continue;
    }
    const record: HubMachineJson = read.record;
    if (isEncryptionCapableVersion(record.pluginVersion)) continue;
    stale.push({
      machineId,
      name: typeof record.name === "string" ? record.name : null,
      pluginVersion: typeof record.pluginVersion === "string" ? record.pluginVersion : null,
      lastSeenAt: typeof record.lastSeenAt === "string" ? record.lastSeenAt : null,
    });
  }
  return stale;
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

export async function hubEncrypt(
  opts: HubEncryptOptions
): Promise<HubEncryptResult | HubEncryptRefusedResult | HubUnreachableResult | ErrorResult> {
  const backend = createFsBackend(opts.hubPath);

  // The same reachability probe push, pull and reindex take, and the same plain
  // refusal: an "is this hub encrypted" answer computed from a hub this machine
  // cannot see is not a degraded answer, it is a wrong one — and the write below
  // is the sharp part. `hub reindex` is in this group for a measured reason
  // (`writeAtomic` mkdir -p's a phantom hub into an unmounted mount point) and
  // this verb writes the same way.
  const probe = await probeHubReachable(opts.hubPath, backend);
  if (probe.state !== "ok") return hubUnreachableRefusal("hub-encrypt", probe.state);

  // The probe's own parse, reused: it is `JSON.parse`'s result cast to
  // `HubJson`, so at runtime it still carries every field a newer plugin wrote.
  // Re-reading here would cost a second round trip on a share and would open a
  // window where the two disagree.
  const hubRaw = probe.hub as unknown as Record<string, unknown>;
  const hubId = probe.hub.hubId;

  // BEFORE the roster is read. `registerMachine` refreshes this machine's own
  // record with the running plugin version AND publishes its public key, so the
  // machine asking the question is never the one the answer trips over — and
  // enabling encryption does not have to be preceded by a push to make this
  // machine a recipient of what comes next.
  await registerMachine(opts.hubPath);
  // No `assertSafeHubId` here: `registerMachine` above built this id into
  // `machinePath()`, which is the chokepoint, so an unsafe one could not have
  // reached this line. Below it is only ever compared as a string.
  const machine = loadOrCreateMachineId();

  const stale = await findStaleMachines(backend, machine.id);
  const census = await collectHubRecipients(backend);
  // THE SAME READER A PUSH USES, and it has to be. Reading `hubRaw.encrypt ===
  // true` here would be a second rule for one field, and the two disagree in
  // exactly the case the field's asymmetry exists for: a hand-edited
  // `encrypt: "true"` makes every push encrypt (`resolveHubEncryption` resolves
  // a malformed value toward encryption) while this verb, the one a user runs to
  // ASK, would answer `enabled: false`. `encryption.ts` says it is the single
  // reader of the pair; this is what honouring that costs.
  const policy = resolveHubEncryption(probe.hub, false);
  const currentlyEnabled = policy.required;

  if (opts.enable && stale.length > 0) {
    return {
      success: false,
      command: "hub-encrypt",
      reason: "stale-machines",
      error: `${stale.length} machine(s) registered on this hub last checked in on a plugin version that predates encryption at rest: ${stale.map(describeStale).join("; ")}.`,
      suggestion:
        `Nothing was changed. Those machines do not read this hub's encryption setting at all, so sealing the hub would not stop them pushing your sessions to it in the clear — it would only stop you noticing. Upgrade sesh-mover to ${MIN_ENCRYPTION_PLUGIN_VERSION} or later on each machine above and run any hub command there once, which refreshes its record; then try again. If a machine is decommissioned, delete its machines/<id>.json from the hub directory — that is also what stops it being carried as a recipient of every future bundle.`,
      staleMachines: stale,
    };
  }

  let changed = false;
  if (opts.enable && !currentlyEnabled) {
    // Patched in place on the RAW object rather than rebuilt from `HubJson`, so
    // a field written by a newer plugin survives this edit. `hub.json` is the
    // one hub file no single machine owns; this is the one operation that is
    // allowed to write it, because it is an explicit user act rather than the
    // opportunistic restamping `hub init` deliberately refuses on join. Two
    // machines enabling at once both write `true`, so the absence of a hub-wide
    // lock costs nothing here.
    hubRaw.encrypt = true;
    await backend.writeAtomic(HUB_JSON, JSON.stringify(hubRaw, null, 2) + "\n");
    changed = true;
  }

  const enabled = opts.enable ? true : currentlyEnabled;

  // The local preference follows the hub, so `configure --show` and this verb
  // cannot disagree about what this machine wants. It is still only a
  // preference: the switch that a push obeys is the one on the hub.
  // The value the caller read out of config, and it only moves if the write
  // below actually lands. Reporting the intended value regardless would make a
  // security-facing field say a preference was recorded when it was not.
  let preference = opts.preference === true;
  const preferenceWarnings: string[] = [];
  if (opts.enable) {
    const configDir =
      opts.configScope === "project" ? projectSeshMoverDir(opts.cwd) : userSeshMoverDir();
    try {
      writeConfigOverrides(
        configDir,
        setConfigOverride(readConfigOverrides(configDir), "hub.encrypt", true)
      );
      preference = true;
    } catch (e) {
      // Not a failure of this command: the hub is the authority and it has
      // already been written, so encryption IS on for every machine. But it is
      // not nothing either — the preference is what a later `configure --show`
      // will report, so a silent miss leaves the two disagreeing.
      preferenceWarnings.push(
        `The hub-wide setting was written, but this machine's local hub.encrypt preference could not be recorded (${(e as Error).message}). That affects nothing but what \`configure --show\` reports here.`
      );
    }
  }

  const warnings: string[] = [...preferenceWarnings];
  if (policy.malformedSetting) {
    // Reported wherever it is read, because a value that is neither `true` nor
    // `false` is the one state where "is this hub sealed" has a correct answer
    // that nobody would predict from the file.
    warnings.push(
      "This hub's hub.json has an `encrypt` value that is neither true nor false. Every machine reads it as ENCRYPTED, because a hand-edited `\"true\"` read the other way is a silent confidentiality loss. Fix the value on the hub to settle it."
    );
  }
  if (changed) {
    warnings.push(
      "Enabling encryption does not make this hub private. It makes it private GOING FORWARD: every bundle already on the hub stays readable by anyone with read access to the directory, forever, and nothing here rewrites them — one machine rewriting another machine's files is what per-machine ownership forbids. If the existing bundles matter, start a fresh hub."
    );
    warnings.push(
      "Bundles are encrypted to every machine registered on this hub, so the authentication an encrypted bundle carries proves it came from SOMEONE holding the file key — the group, not the sender. A hub operator who is not one of your machines can no longer author a payload at all; a machine that is on this hub still can. Per-machine signing is a separate step and is not in this release."
    );
  }
  if (enabled && census.unkeyed.length > 0) {
    warnings.push(
      `${census.unkeyed.length} registered machine(s) publish no usable public key, so a push to this hub will refuse until they check in: ${census.unkeyed.map((u) => u.machineId).join(", ")}.`
    );
  }

  return {
    success: true,
    command: "hub-encrypt",
    hubId,
    enabled,
    changed,
    preference,
    recipients: census.recipients.map((r) => ({ machineId: r.machineId, name: r.name })),
    unkeyedMachines: census.unkeyed,
    staleMachines: stale,
    warnings,
  };
}
