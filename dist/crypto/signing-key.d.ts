/**
 * This machine's Ed25519 SIGNING key — a second keypair, deliberately.
 *
 * ---------------------------------------------------------------------------
 * Why not reuse the X25519 identity, which is right there
 * ---------------------------------------------------------------------------
 *
 * Two reasons, and the first is that it is not possible without writing curve
 * arithmetic from scratch.
 *
 * **Measured on Node 22.23.1, and the check is easy to get backwards.**
 * `node:crypto` will happily import the X25519 secret's 32 bytes as an Ed25519
 * JWK `d`, which looks exactly like reuse working. It is not: Ed25519's `d` is a
 * SEED, expanded through SHA-512 into a scalar, where X25519's is the scalar
 * itself. The same 32 bytes therefore produce two unrelated keypairs — verified
 * by deriving both public halves and comparing them. An XEdDSA-style conversion
 * needs Edwards-curve point arithmetic, which is precisely what `age.ts`
 * avoided (every curve operation there goes through `diffieHellman`; only DER
 * prefixes are hand-built, "fiddly, not dangerous"). There is also no
 * convenient oracle for it — no equivalent of the `age` binary to check against.
 *
 * **And it would be wrong even if it worked.** Using one scalar for key
 * agreement and for signatures is cross-protocol key reuse: each primitive's
 * security argument assumes the key is used only in that protocol, and the
 * composed system has no proof. It would also weld the two keys' lifecycles —
 * the age identity is escrowable, so an escrow passphrase would become a
 * signature-forgery capability. That is the reason the owner ruled the signing
 * key is NOT escrowed (see below).
 *
 * ---------------------------------------------------------------------------
 * Losing this key is cheap, and that asymmetry drives the design
 * ---------------------------------------------------------------------------
 *
 * Losing `identity.age` is permanent: every bundle encrypted to that recipient
 * stays unreadable, forever, which is why `hub escrow` exists and why
 * `identity-file.ts` will not overwrite a present-but-unreadable file.
 *
 * Losing THIS key costs a new keypair and one re-pin round with peers. Old
 * bundles stay verifiable against the old public key wherever it is pinned, and
 * the change surfaces as a pin mismatch a human confirms. So:
 *
 * - It gets `identity-file.ts`'s FILE discipline in full (0600, `wx` create,
 *   three-valued read, never overwrite a present-but-unreadable file) — a key
 *   this machine still holds must not be shredded by a transient read failure,
 *   even when re-minting is survivable.
 * - It gets NO escrow (owner ruling). Escrowing it would widen `hub escrow`'s
 *   blast radius from "can read this machine's bundles" to "can also forge this
 *   machine's signatures", to buy back a loss that costs a re-pin.
 *
 * ---------------------------------------------------------------------------
 * The file, and why it is not inside `identity.age`
 * ---------------------------------------------------------------------------
 *
 * `~/.sesh-mover/signing.key`, beside the identity and never inside it:
 * `identity.age` must stay a valid age identity file, because `age -d -i
 * ~/.sesh-mover/identity.age <bundle>` recovering a bundle with this plugin
 * uninstalled is the whole reason the wire format is age's. Appending a
 * non-age line to it would break that for a tool that has no reason to tolerate
 * it.
 *
 * And not in `machine-id.json`, for the reason `identity-file.ts` gives about
 * the same file: its entire content is published to the hub verbatim, so a
 * private key there is one careless `JSON.stringify` from the hub.
 *
 * Format is PKCS#8 PEM — what `node:crypto` exports natively, so there is no
 * hand-built encoding here at all and nothing to get subtly wrong.
 */
import { type KeyObject } from "node:crypto";
/** `~/.sesh-mover/signing.key`. Spelled here, beside its only reader. */
export declare function signingKeyPath(): string;
/**
 * Why a signing key could not be read. Same split, same reason, as
 * `IdentityFileCause`: `io` means the bytes did not come back and the key may
 * be perfectly intact behind a permission problem; `malformed` means they did
 * come back and are not a key. The remedies share nothing — restore access
 * versus mint a replacement and re-pin — so a caller must be able to tell them
 * apart without matching on message text.
 */
export type SigningKeyCause = "io" | "malformed";
export type SigningKeyState = {
    state: "absent";
} | {
    state: "unreadable";
    cause: SigningKeyCause;
    detail: string;
} | {
    state: "present";
    privateKey: KeyObject;
    /** Base64url of the raw 32-byte Ed25519 public key. What gets published. */
    publicKey: string;
    /** POSIX only; always `false` on Windows — see identity-file.ts's header. */
    insecureMode: boolean;
};
/**
 * The raw 32-byte public key, base64url — the form that goes on
 * `HubMachineJson.signingPublicKey` and into a pin.
 *
 * Raw rather than PEM or DER because it is what a fingerprint is computed over
 * and what a human compares: a PEM public key is 100+ characters of mostly
 * fixed prefix, and two different keys look identical at a glance.
 */
export declare function publicKeyToBase64Url(key: KeyObject): string;
/** Rebuild a verifying key from the published base64url form. */
export declare function publicKeyFromBase64Url(x: string): KeyObject;
/**
 * A short, human-comparable fingerprint of a published key.
 *
 * **For a person reading two screens side by side**, which is the only thing it
 * is for — `hub trust` prints it and a user compares it against the other
 * machine. It is deliberately NOT what verification compares: that uses the
 * full key, because a truncated fingerprint is a smaller search space and no
 * automated check should ever settle for one.
 *
 * Grouped into blocks because an unbroken run of characters is where a human
 * comparison actually fails.
 */
export declare function keyFingerprint(publicKeyBase64Url: string): string;
/**
 * Read the signing key, three-valued.
 *
 * Never throws, and never mints. See `identity-file.ts`'s header for why the
 * three states must stay apart: a two-valued read plus a mint-on-null is a key
 * shredder, and it is a shredder here too even though the loss is cheaper — a
 * key silently replaced during a transient read failure invalidates nothing,
 * but it does make every peer's pin alarm fire for no reason, which trains
 * users to click through the one alarm that matters.
 */
export declare function readSigningKey(): SigningKeyState;
export type SigningKeyLoad = {
    ok: true;
    privateKey: KeyObject;
    publicKey: string;
    created: boolean;
    insecureMode: boolean;
} | {
    ok: false;
    cause: SigningKeyCause;
    detail: string;
};
/**
 * Read the signing key, minting one on first use.
 *
 * **Returns a result and never throws**, for `loadOrCreateIdentity`'s reason
 * and one more. `registerMachine` calls it on every push and pull including the
 * detached, unattended SessionEnd auto-push — and per the owner ruling, an
 * unreadable signing key WARNS AND PUSHES UNSIGNED rather than refusing. So a
 * throw here would convert a disclosed degradation into a failed push, which is
 * the opposite of the decision.
 *
 * `ok: false` rather than a fresh key when the file is present-but-unreadable:
 * the never-clobber rule, unchanged.
 */
export declare function loadOrCreateSigningKey(): SigningKeyLoad;
/** Sign bytes with this machine's key. Ed25519 is pure — no pre-hash, no options. */
export declare function signBytes(privateKey: KeyObject, data: Buffer): string;
/**
 * Verify a signature, returning a boolean and never throwing.
 *
 * Never throwing is the contract the caller depends on: verification runs
 * inside `pull-fetch.ts`, where every untrusted-input call must return a typed
 * abort rather than raise (#96 finding 5's whole lesson). A malformed key or a
 * truncated signature is a verification FAILURE — the same answer as a wrong
 * one, because both mean "this did not come from the key it claims".
 */
export declare function verifyBytes(publicKeyBase64Url: string, data: Buffer, signature: string): boolean;
//# sourceMappingURL=signing-key.d.ts.map