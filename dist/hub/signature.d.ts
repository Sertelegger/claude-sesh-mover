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
import type { KeyObject } from "node:crypto";
/** Bumped only for an incompatible statement shape. Part of the signed bytes. */
export declare const SIGNATURE_DOMAIN = "sesh-mover/bundle-sig/1";
/**
 * What a machine asserts about a bundle it pushed.
 *
 * Every field is signed. `workspaceFile`/`workspaceDigest` are absent together
 * when the push carried no workspace artifact — and absent is not the same as
 * empty: `canonicalize` drops `undefined`, so a statement without them hashes
 * differently from one with them set to `""`, and a verifier cannot be talked
 * into treating a missing artifact as a matching one.
 */
export interface BundleStatement {
    domain: typeof SIGNATURE_DOMAIN;
    hubId: string;
    projectId: string;
    machineId: string;
    bundleId: string;
    pushedAt: string;
    /** Hub-relative path of the bundle, as the index records it. */
    bundleFile: string;
    /** sha256 of the PLAINTEXT `.tar.gz`, before any encryption. */
    bundleDigest: string;
    workspaceFile?: string;
    workspaceDigest?: string;
}
/**
 * What a bundle's signature says about its split workspace artifact (#91),
 * AFTER `verifyStatement` and the `bundleDigest` comparison have both passed —
 * minted only in `pull-fetch.ts`'s signature gate, which is the one place in a
 * pull where a statement is proved.
 *
 * THREE values rather than `{file,digest} | null`, and the third arm is the
 * point: "no signature at all" and "a verified signature that named no
 * artifact" are different facts with different handling. The first is the
 * permanent normal — every pre-#86 bundle on every hub — and must apply exactly
 * as it always has. Same reason `pins.ts` keeps `tofu`/`confirmed`/`null` as
 * three facts rather than a boolean.
 *
 * Narrow ON PURPOSE. A consumer must never be handed `record.signature`: that
 * field is raw out of another machine's index file, which is the exact file the
 * pin store exists to distrust, and handing it over invites a second
 * `verifyStatement`, a second pin read and a second policy.
 */
export type WorkspaceAttestation = 
/** No signature on this record. Permanent normal; no check runs. */
{
    kind: "unsigned";
}
/** Signed and verified; the statement named no workspace artifact. */
 | {
    kind: "signed-no-artifact";
}
/** Signed and verified. This is what the signer said about the artifact. */
 | {
    kind: "attested";
    file: string;
    digest: string;
};
/** What lands on `HubBundleRecord.signature`. */
export interface BundleSignature {
    statement: BundleStatement;
    /** Ed25519 over the canonical statement bytes, base64url. */
    signature: string;
    /** The public key this was signed with, base64url — see `verifyStatement`. */
    publicKey: string;
}
/**
 * The exact bytes signed and verified.
 *
 * ONE function, used by both sides, because a signer and a verifier that
 * serialize differently produce a mismatch that reads as tampering — the most
 * misleading failure this feature could have.
 */
export declare function statementBytes(statement: BundleStatement): Buffer;
export declare function signStatement(privateKey: KeyObject, statement: BundleStatement, publicKey: string): BundleSignature;
/** Why a signature did not verify. Each has a different remedy. */
export type SignatureFailure = 
/** The bytes do not match the signature under the stated key. Damage or tampering. */
{
    kind: "bad-signature";
}
/**
 * The signature is valid, but for a DIFFERENT location than the record it
 * arrived on — a statement lifted from elsewhere on the hub. The most
 * important arm: everything cryptographic about it checks out.
 */
 | {
    kind: "context-mismatch";
    field: string;
    expected: string;
    found: string;
}
/** The archive on disk is not the one the statement describes. */
 | {
    kind: "digest-mismatch";
    file: string;
}
/**
 * The signer's key is not the one pinned for this machine. NOT necessarily an
 * attack — a machine that lost its key and re-minted looks identical from
 * here — which is why it is reported separately and why the remedy is a human
 * confirming out of band rather than anything automatic.
 */
 | {
    kind: "unpinned-key";
    pinned: string;
    found: string;
};
export interface StatementContext {
    hubId: string;
    projectId: string;
    machineId: string;
    bundleId: string;
    bundleFile: string;
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
export declare function verifyStatement(args: {
    signature: BundleSignature;
    context: StatementContext;
    pinnedKey: string | null;
}): {
    ok: true;
} | {
    ok: false;
    failure: SignatureFailure;
};
/** sha256 of a file, in the `sha256:<hex>` form every digest in this codebase uses. */
export declare function digestFile(path: string): Promise<string>;
//# sourceMappingURL=signature.d.ts.map