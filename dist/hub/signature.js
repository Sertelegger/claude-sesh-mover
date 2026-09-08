/**
 * # The signed statement a bundle carries (#86)
 *
 * A signature over "the bundle" would not be enough, and would not even name
 * one file. Two facts decide the whole shape of this module.
 *
 * ## 1. It signs a DIGEST OF PLAINTEXT, not the uploaded bytes
 *
 * The uploaded bytes are the wrong thing to sign, and `hub rekey` is what
 * proves it: a re-wrap replaces a bundle's age header in place, under the same
 * name, without touching the payload. A signature over ciphertext would die at
 * every rekey — and re-signing after one would make the signature's validity
 * depend on an operation whose entire point is that no index anywhere learns it
 * ran. Over plaintext, a rekey is a non-event.
 *
 * It is also not a signature over any of the three existing hash layers.
 * `sessionsDigest` deliberately excludes `workspace`, `carry` and `projectId`,
 * because `hub/push.ts` patches those into the staged manifest afterwards — so
 * a signature over it would attest the transcripts and say nothing about the
 * file payload, which is precisely the surface #86 exists for.
 *
 * On CLAUDE.md's "do not add a fourth hash": that rule is about a hash over
 * CIPHERTEXT, whose stated problems are that the AEAD tag already answers that
 * question better and that it would have nowhere to live. This is over
 * plaintext, answers a different question — *who wrote this* — and lives
 * outside the archive because it covers the archive. The three layers do not
 * move and nothing here reads them.
 *
 * ## 2. It signs TWO files, because #91 split the payload
 *
 * The workspace tree is its own hub artifact now, and `ExportManifest.workspace`
 * carries `fileCount`/`byteSize` — counts, never content. So **no existing
 * digest anywhere reaches the workspace payload**, and a statement that covered
 * only the bundle would leave the file payload unattested: the exact hole #86's
 * motivating example lives in. `workspaceDigest` closes it.
 *
 * ## The context binding, and what it stops
 *
 * A bare `{digest, signature}` pair is forgeable by MOVING it. Whoever can
 * write the hub can take a validly-signed bundle and re-file it under another
 * project, another thread's chain slot, or another name — every byte still
 * verifies, because the signature never said where the bundle belonged. So the
 * statement names its own context, and the verifier checks each field against
 * the record it actually came from. A statement that verifies cryptographically
 * but describes a different location is a failure, not a pass.
 *
 * The domain string is the same convention `manifest.ts` uses: it stops a
 * signature minted for one purpose being replayed as another, which matters as
 * soon as this key signs a second kind of thing.
 */
import { createHash } from "node:crypto";
import { canonicalize } from "../manifest.js";
import { signBytes, verifyBytes } from "../crypto/signing-key.js";
/** Bumped only for an incompatible statement shape. Part of the signed bytes. */
export const SIGNATURE_DOMAIN = "sesh-mover/bundle-sig/1";
/**
 * The exact bytes signed and verified.
 *
 * ONE function, used by both sides, because a signer and a verifier that
 * serialize differently produce a mismatch that reads as tampering — the most
 * misleading failure this feature could have.
 */
export function statementBytes(statement) {
    return Buffer.from(JSON.stringify(canonicalize(statement)), "utf-8");
}
export function signStatement(privateKey, statement, publicKey) {
    return { statement, signature: signBytes(privateKey, statementBytes(statement)), publicKey };
}
/**
 * Verify a signature against the context it arrived in.
 *
 * **The key is taken from the statement, then checked against the pin.** That
 * ordering looks backwards and is deliberate: taking it from the statement lets
 * a bundle be verified as internally consistent, and the pin comparison — the
 * step that supplies the actual trust — is a SEPARATE, explicit answer the
 * caller cannot skip by accident. A `pinnedKey` of `null` means this machine
 * has no pin yet, which is a decision for the caller (trust-on-first-use), not
 * something to be silently resolved here.
 *
 * Order of checks is deliberate too: cryptographic validity first, then
 * context, then the pin. A caller reporting the first failure gets the most
 * specific true statement — "these bytes are not what was signed" outranks
 * "and also the key is unpinned", because a forged statement's key is
 * uninteresting.
 */
export function verifyStatement(args) {
    const { signature: sig, context, pinnedKey } = args;
    if (!verifyBytes(sig.publicKey, statementBytes(sig.statement), sig.signature)) {
        return { ok: false, failure: { kind: "bad-signature" } };
    }
    const fields = [
        ["domain", SIGNATURE_DOMAIN, sig.statement.domain],
        ["hubId", context.hubId, sig.statement.hubId],
        ["projectId", context.projectId, sig.statement.projectId],
        ["machineId", context.machineId, sig.statement.machineId],
        ["bundleId", context.bundleId, sig.statement.bundleId],
        ["bundleFile", context.bundleFile, sig.statement.bundleFile],
    ];
    for (const [field, expected, found] of fields) {
        if (expected !== found) {
            return { ok: false, failure: { kind: "context-mismatch", field, expected, found } };
        }
    }
    if (pinnedKey !== null && pinnedKey !== sig.publicKey) {
        return { ok: false, failure: { kind: "unpinned-key", pinned: pinnedKey, found: sig.publicKey } };
    }
    return { ok: true };
}
/** sha256 of a file, in the `sha256:<hex>` form every digest in this codebase uses. */
export async function digestFile(path) {
    const { createReadStream } = await import("node:fs");
    const hash = createHash("sha256");
    await new Promise((resolve, reject) => {
        const s = createReadStream(path);
        s.on("data", (c) => hash.update(c));
        s.on("error", reject);
        s.on("end", () => resolve());
    });
    return `sha256:${hash.digest("hex")}`;
}
//# sourceMappingURL=signature.js.map