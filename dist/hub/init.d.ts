import { type HubMachineJson } from "./layout.js";
import type { ErrorResult, HubInitResult, SeshMoverConfig } from "../types.js";
export declare function resolveHubPath(config: SeshMoverConfig): string | null;
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
export declare function registerMachine(hubPath: string): Promise<HubMachineJson>;
export declare function hubInit(opts: {
    hubPath: string;
    configScope: "user" | "project";
    cwd: string;
}): Promise<HubInitResult | ErrorResult>;
//# sourceMappingURL=init.d.ts.map