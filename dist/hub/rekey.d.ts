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
import type { HubLockBusyResult, HubRekeyRefusedResult, HubRekeyResult, HubUnreachableResult } from "../types.js";
export interface HubRekeyOptions {
    /** The project directory whose hub link names the project to rekey. */
    projectPath: string;
    hubPath: string;
}
export declare function hubRekey(opts: HubRekeyOptions): Promise<HubRekeyResult | HubRekeyRefusedResult | HubLockBusyResult | HubUnreachableResult>;
//# sourceMappingURL=rekey.d.ts.map