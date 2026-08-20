/**
 * The one place a bundle crosses the plaintext/ciphertext boundary.
 *
 * `HubBackend`'s streaming half (`readStream`/`writeStreamAtomic`) carries
 * bundles and nothing else — every JSON metadata file goes through `read`/
 * `writeAtomic` — so the boundary is a seam rather than a policy applied per
 * call site. This module is that seam, in both directions.
 *
 * ### The reader branches on the FILE SUFFIX, never on config
 *
 * A hub is permanently MIXED. Enabling encryption never rewrites an existing
 * bundle — that would be one machine rewriting *other machines'* files, which
 * per-machine ownership forbids outright — so plaintext and ciphertext sit side
 * by side forever, and the decision has to be per file. `isEncryptedBundleFile`
 * (hub/layout.ts) is the whole of it.
 *
 * Reaching for `resolveHubEncryption` here instead is the mistake this comment
 * exists to prevent, and it fails in BOTH directions: on a hub whose switch has
 * just been flipped it strands every bundle pushed before the flip, and on a
 * machine that has not noticed the flip it tries to gunzip ciphertext. Neither
 * shows up on the machine that made the change.
 *
 * ### Streaming, still
 *
 * `AgeEncryptStream`/`AgeDecryptStream` are `Transform`s and go INTO the two
 * existing pipelines rather than around them. There is deliberately no
 * whole-buffer helper in `crypto/age.ts`, and adding one here would give back
 * the memory ceiling that the bundle path is the main beneficiary of: the
 * default-on SessionEnd auto-push is the largest writer in this codebase.
 *
 * The decrypted archive still lands in a temp FILE, because `extractArchive`
 * takes a path and reads it twice (`assertSafeEntries`, then the extract). That
 * is the same plaintext-on-disk exposure a pull has always had — the extracted
 * tree is plaintext too — and every caller here puts it under a private
 * `mkdtemp` root it removes in a `finally`.
 */
import { AgeEncryptStream } from "../crypto/age.js";
import { type IdentityFileState } from "../crypto/identity-file.js";
import type { HubBackend } from "./backend.js";
/**
 * Why a bundle did not arrive as a readable local archive.
 *
 * Four kinds, because the remedies share nothing:
 *
 * - `transfer` — the bytes could not be moved at all. The pre-encryption
 *   failure: the share went away, a synced folder de-hydrated the file, the
 *   local temp could not be written.
 * - `no-identity` — the file is encrypted and this machine has no usable
 *   `~/.sesh-mover/identity.age`. The key may be perfectly intact behind a
 *   permission problem, so this is NOT "you are not a recipient".
 * - `no-matching-identity` — this machine holds a key and it is not one of the
 *   bundle's recipients. Permanent for this bundle, by construction: a bundle
 *   is written once and never re-wrapped by anyone but the machine that owns
 *   it. Distinguishing it from `no-identity` is the difference between "fix
 *   your key file" and "this bundle was never addressed to you".
 * - `ciphertext-rejected` — the header MAC or a chunk's AEAD tag refused the
 *   bytes, or the file is not an age v1 file we can read. Damage or tampering;
 *   the AEAD does not say which, and neither does this.
 */
export type BundleFetchFailureKind = "transfer" | "no-identity" | "no-matching-identity" | "ciphertext-rejected";
export interface BundleFetchFailure {
    kind: BundleFetchFailureKind;
    /**
     * The underlying diagnosis, kept WHOLE. It is the discriminator inside a
     * kind — `zlib: incorrect data check` versus `ENOENT`, or which of the four
     * age header/payload refusals fired — and the callers' own sentences name the
     * remedies for the kind. Same rule as the unpack abort in `pull-fetch.ts`.
     */
    message: string;
}
export type BundleFetchOutcome = {
    ok: true;
    encrypted: boolean;
} | {
    ok: false;
    encrypted: boolean;
    failure: BundleFetchFailure;
};
/**
 * Download one bundle from the hub into a local PLAINTEXT `.tar.gz`,
 * decrypting on the way when the hub-side name says it is encrypted.
 *
 * **Returns a result and never throws**, which is a decision about the callers
 * rather than a style. All three of them — the pull's fetch stage, the merge
 * ancestor fetch, and `hub reindex` — are handed a hub path out of an index
 * file some other machine wrote, i.e. untrusted input on the sharpest surface
 * this codebase has. An uncaught throw out of the pull's fetch stage costs the
 * `suggestion` field AND every disclosure the bundles already applied in that
 * chain collected, because the CLI's outer catch builds its `ErrorResult` from
 * the exception alone.
 *
 * `destPath` keeps the `.tar.gz` spelling whatever the hub-side name was: the
 * archiver picks its container format from the LOCAL name (`detectArchiveFormat`),
 * and what lands here is a gzip archive either way.
 *
 * @param identity injected only by tests that need a specific key state; the
 *   default reads this machine's real identity file. Read lazily — a plaintext
 *   bundle must not need a key, which is what makes a mixed hub work on a
 *   machine that has never encrypted anything.
 */
export declare function fetchBundleArchive(input: {
    backend: HubBackend;
    file: string;
    destPath: string;
    identity?: IdentityFileState;
}): Promise<BundleFetchOutcome>;
/**
 * The `Transform` a push inserts between the staged archive and the hub.
 *
 * Separate from the recipient CENSUS (`collectHubRecipients`) on purpose: by
 * the time bytes are moving, the decision about `unkeyed` machines has been
 * made and disclosed. This function takes the list that decision produced and
 * nothing else, so there is no shape in which a machine can be dropped here.
 *
 * Throws `AgeError("no-recipients")` on an empty list rather than producing a
 * file readable by nobody. Callers refuse the push before reaching this — the
 * throw is the belt.
 */
export declare function bundleEncryptStream(recipients: readonly string[]): AgeEncryptStream;
//# sourceMappingURL=bundle-io.d.ts.map