/**
 * `hub rekey` — re-address this machine's OWN encrypted bundles to the hub's
 * current recipient set.
 *
 * ## The two states this exists for
 *
 * Encryption at rest wraps each bundle's file key once, in one stanza per
 * recipient, at the moment it is written. That design is what makes joining a
 * hub cheap — no key exchange, no flag day — and it leaves exactly two states
 * with no remedy:
 *
 * 1. **A machine joins and cannot read history.** New bundles reach it
 *    immediately and old ones do not, because the old headers name a set it was
 *    not in.
 * 2. **A machine rotates or loses its key.** Its own past bundles stop being
 *    readable *by it*.
 *
 * This verb answers (1) and, read carefully, **does not answer (2)**. A re-wrap
 * requires unwrapping the file key first, so a machine that cannot open a
 * bundle cannot re-address it either: those files come back in `failed` with
 * `no-matching-identity`, and no verb anywhere recovers them. What recovers the
 * SESSIONS is that a push copies and never deletes — `push --full` re-sends the
 * transcript whole from the machine that still holds it.
 *
 * ## Per machine, over its own bundles only
 *
 * Machine A re-wraps A's bundles; nobody re-wraps anybody else's. This composes
 * with per-machine ownership rather than fighting it — the same invariant that
 * made #95 refuse in-place re-encryption of the hub and made #43's tombstones
 * an assertion rather than a deletion — so a rekey needs no distributed lock
 * and cannot be raced by another machine doing the same thing.
 *
 * **The residual is real and is named rather than worked around: a
 * decommissioned machine can never re-wrap its bundles**, so its history stays
 * unreadable to any machine that joined after it left. That is structurally the
 * same dead end as the chain-assembly spec's "the creating machine is gone"
 * case, and it gets the same treatment. There is no authority to invent here:
 * the only party that can open those files is a machine that no longer exists.
 *
 * ## Re-wrap, and deliberately not re-encryption
 *
 * The header is replaced; the payload ciphertext is copied byte for byte
 * (`AgeRewrapStream`). The file key does not change, which has two consequences
 * worth stating out loud:
 *
 * - It is cheap and it is safe to run often. It is also idempotent — running it
 *   twice is running it once — which is why an un-keyed peer is a DISCLOSURE
 *   here and a refusal on a push (see `checkSelfIsRecipient`).
 * - **It grants access; it can never revoke it.** A machine that already
 *   unwrapped this file key still holds it. Dropping a machine from the roster
 *   and rekeying does not lock it out of bytes it has already read, and
 *   pretending otherwise would be the most dangerous thing this file could say.
 *
 * A full decrypt/re-encrypt (`--reencrypt` in the spec) is NOT in this verb, and
 * the reason is not effort. Its two unique capabilities are turning a plaintext
 * bundle into an encrypted one and rotating the file key. The first changes the
 * file's NAME — the reader branches on the `.age` suffix and on nothing else —
 * so it is a hub-visible state change that must also delete the original, and
 * physical removal has exactly one home in this codebase (retirement, later
 * compaction), pinned by a source scan. The second is a revocation, which the
 * paragraph above says cannot be achieved by rewriting a file on a directory
 * everyone can read. So: plaintext bundles are reported as `skipped`, with the
 * state visible rather than absent, and the operation that would rewrite them
 * is left with the verb that already owns deletion.
 *
 * ## It never reads `hub.json`'s `encrypt` switch
 *
 * A rekey's premise is per FILE — *these bytes are already ciphertext* — which
 * is the same fact the reader branches on. Gating it on the hub-wide switch
 * would strand a hub whose switch was turned off after bundles were encrypted,
 * for no gain: nothing here creates ciphertext that did not already exist.
 *
 * ## Order, and what a crash leaves behind
 *
 * Bundles first, then workspace artifacts; each group oldest first, which the
 * timestamp-prefixed file name makes a lexical sort. Both halves are the
 * failure contract rather than a preference:
 *
 * - **Oldest first**, because a pull walks a thread's chain from its base: with
 *   bundles 1..K re-addressed a joining machine reads the first K of the
 *   thread, while the same prefix at the other end reads nothing at all.
 * - **Bundles before workspaces**, because a bundle it cannot open aborts a
 *   puller's whole chain, while a workspace artifact it cannot open degrades to
 *   keep-local plus a warning.
 *
 * Each file is replaced atomically (temp + rename) or not at all, and the
 * self-check guarantees the new set contains this machine, so **every file is
 * readable by someone at every instant, and by this machine at every instant**.
 * A run that dies at file K leaves K-1 files re-addressed and the rest exactly
 * as they were — the larger state, in #92's phrasing — and re-running simply
 * redoes the lot.
 *
 * A per-file failure does not stop the run. The alternative fails the whole
 * project because of one damaged file, which is the opposite of what a repair
 * verb is for; the failures come back as data, one entry each.
 */
import { createFsBackend } from "./backend.js";
import { rewrapBundleFile } from "./bundle-io.js";
import { collectHubRecipients, checkSelfIsRecipient, describeUnkeyed } from "./encryption.js";
import { readLocalProjectId } from "./identity.js";
import { registerMachine } from "./init.js";
import { bundleDir, isEncryptedBundleFile, workspaceDir } from "./layout.js";
import { acquireProjectLock, LockBusyError } from "./lock.js";
import { hubUnreachableRefusal, probeHubReachable } from "./preflight.js";
import { readIdentityFile } from "../crypto/identity-file.js";
import { loadOrCreateMachineId } from "../machine.js";
export async function hubRekey(opts) {
    // Same order, and the same reasons, as `hub reindex`: the local link first
    // (a read of a file in the user's own project, whose answer cannot be wrong
    // because the hub is unmounted), then reachability (before the lock, so a
    // wedged concurrent operation cannot turn "unmounted share" into "lock
    // busy", and before `registerMachine`, which writes).
    const local = readLocalProjectId(opts.projectPath);
    if (!local) {
        return {
            success: false,
            command: "hub-rekey",
            reason: "unlinked",
            error: "This project is not linked to a hub project — it has nothing on the hub to re-address.",
            suggestion: "Run push (with --create-project or --project-id) to link and publish this project to the hub first.",
        };
    }
    const backend = createFsBackend(opts.hubPath);
    const probe = await probeHubReachable(opts.hubPath, backend);
    if (probe.state !== "ok")
        return hubUnreachableRefusal("hub-rekey", probe.state);
    let lock;
    try {
        // This machine's own files only, so no other machine can be writing them —
        // but this machine can (a push, another rekey), and the bundle a push is
        // streaming is the one file here that must not be rewritten underneath it.
        lock = acquireProjectLock(opts.projectPath);
    }
    catch (e) {
        if (e instanceof LockBusyError) {
            return {
                success: false,
                command: "hub-rekey",
                reason: "lock-busy",
                holderPid: e.holderPid,
                ageSeconds: e.ageMs === null ? null : Math.round(e.ageMs / 1000),
                error: e.message,
                suggestion: "Another sesh-mover hub operation is running for this project — wait for it or retry.",
            };
        }
        throw e;
    }
    try {
        const warnings = [];
        // BEFORE the roster is read, exactly as `hub encrypt` does it: this
        // publishes the key this machine holds right now, so the machine asking to
        // be a recipient of its own re-wrapped files is never the one the answer
        // trips over.
        await registerMachine(opts.hubPath);
        const machine = loadOrCreateMachineId();
        const census = await collectHubRecipients(backend);
        // ONE read, used for the self-check AND for every unwrap below. Re-reading
        // per file would leave a window in which the key that satisfied the check
        // is not the key that does the work.
        const identity = readIdentityFile();
        const self = checkSelfIsRecipient({
            census,
            thisMachineId: machine.id,
            // From the FILE, never from this machine's row in the census — see
            // `checkSelfIsRecipient` for why the roster can be stale in both
            // directions. A rekey that dropped the rekeying machine from the
            // recipients would make every bundle it touched unreadable to itself, in
            // bulk, which is the push-side failure with the volume turned up.
            thisMachineRecipient: identity.state === "present" ? identity.recipient : null,
        });
        if (!self.ok) {
            return {
                success: false,
                command: "hub-rekey",
                reason: "encryption-refused",
                refusal: self.refusal,
                error: self.error,
                suggestion: self.suggestion,
                unkeyedMachines: census.unkeyed,
            };
        }
        const rewrapped = [];
        const skipped = [];
        const failed = [];
        const narrowed = [];
        // The sortable timestamp prefix (`bundleFileName`) exists for exactly this:
        // a lexical sort of the names is chronological push order. `list` already
        // drops `.tmp-` names, so a concurrent write's staging file is invisible.
        const files = [
            ...(await backend.list(bundleDir(local.projectId, machine.id))).sort(),
            ...(await backend.list(workspaceDir(local.projectId, machine.id))).sort(),
        ];
        for (const file of files) {
            // The suffix, and nothing else — the same rule every reader uses. A
            // plaintext bundle cannot become ciphertext without being renamed, and a
            // rename is not this verb's to make.
            if (!isEncryptedBundleFile(file)) {
                skipped.push({ file, reason: "plaintext" });
                continue;
            }
            const out = await rewrapBundleFile({
                backend,
                file,
                recipients: self.recipients,
                identity,
            });
            if (!out.ok) {
                failed.push({ file, reason: out.failure.kind, message: out.failure.message });
                continue;
            }
            rewrapped.push(file);
            if (out.previousRecipientStanzas !== null &&
                out.previousRecipientStanzas > self.recipients.length) {
                narrowed.push({
                    file,
                    before: out.previousRecipientStanzas,
                    after: self.recipients.length,
                });
            }
        }
        if (rewrapped.length > 0) {
            warnings.push(`${rewrapped.length} of this machine's files on the hub are now addressed to ${self.recipients.length} machine(s). This grants access and cannot take it away: any machine that already held this file's key still does, because a re-wrap keeps the file key and replaces only the header.`);
        }
        if (skipped.length > 0) {
            warnings.push(`${skipped.length} of this machine's files are PLAINTEXT and were left exactly as they are — anyone with read access to the hub directory can read them, and that is not changed by anything this command does. Making them ciphertext would rename them (every index on the hub records the name) and delete the originals, which belongs to the verbs that own removal. A fresh hub is the other answer.`);
        }
        const unreadable = failed.filter((f) => f.reason === "no-matching-identity");
        if (unreadable.length > 0) {
            warnings.push(`${unreadable.length} of this machine's own files could not be opened by it: they are encrypted to a key this machine no longer holds, which is what a replaced or restored-from-elsewhere ~/.sesh-mover/identity.age looks like. A re-wrap has to unwrap the file key first, so nothing here — and nothing anywhere — recovers them; if the old identity file still exists, restoring it is the only route back. The sessions themselves are not lost: a push copies and never deletes, so the transcripts are still in this machine's Claude projects directory.`);
        }
        const other = failed.filter((f) => f.reason !== "no-matching-identity");
        if (other.length > 0) {
            warnings.push(`${other.length} of this machine's files could not be re-addressed and were left untouched (${other.map((f) => `${f.file}: ${f.message}`).join("; ")}). Nothing was half-written — each file is replaced atomically or not at all — so running this again after fixing the cause is safe and picks them up.`);
        }
        if (census.unkeyed.length > 0) {
            warnings.push(`${census.unkeyed.length} registered machine(s) publish no usable public key, so the new headers are not addressed to them: ${census.unkeyed.map(describeUnkeyed).join("; ")}. Unlike a push, that is not a refusal here — this operation is idempotent, so once those machines check in with a key, running it again includes them.`);
        }
        if (narrowed.length > 0) {
            warnings.push(`${narrowed.length} file(s) came out addressed to FEWER machines than they went in. A re-wrap addresses a file to the hub's roster as it stands, and a recipient stanza carries an ephemeral share rather than a public key, so which machines were dropped cannot be recovered from the file — only that some were. The usual cause is a machines/<id>.json that has been removed or damaged since the file was written. Fixing the roster and running this again re-includes them.`);
        }
        return {
            success: true,
            command: "hub-rekey",
            projectId: local.projectId,
            machineId: machine.id,
            recipients: census.recipients.map((r) => ({ machineId: r.machineId, name: r.name })),
            scanned: files.length,
            rewrapped,
            skipped,
            failed,
            narrowed,
            unkeyedMachines: census.unkeyed,
            warnings,
        };
    }
    finally {
        lock.release();
    }
}
//# sourceMappingURL=rekey.js.map