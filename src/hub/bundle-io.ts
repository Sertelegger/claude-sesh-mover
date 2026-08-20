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
 * `rewrapBundleFile` is the one exception that proves the rule rather than
 * breaking it: it rewrites a bundle in place, and the only bundles it is ever
 * handed are the calling machine's OWN, which is what keeps per-machine
 * ownership intact. It also never changes a name, so no index anywhere has to
 * learn that it ran.
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

import { createWriteStream } from "node:fs";
import { finished, pipeline } from "node:stream/promises";
import {
  AgeDecryptStream, AgeEncryptStream, AgeError, AgeRewrapStream, parseIdentity, parseRecipient,
} from "../crypto/age.js";
import { readIdentityFile, type IdentityFileState } from "../crypto/identity-file.js";
import type { HubBackend } from "./backend.js";
import { isEncryptedBundleFile } from "./layout.js";

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
 *   bundle's recipients. Permanent FROM HERE, by construction: only the machine
 *   that owns a bundle may re-wrap it (`rewrapBundleFile`, reached by `hub
 *   rekey`), so nothing this machine does reaches it and nothing ever will if
 *   that machine is gone. Distinguishing it from `no-identity` is the
 *   difference between "fix your key file" and "this bundle was never addressed
 *   to you".
 * - `ciphertext-rejected` — the header MAC or a chunk's AEAD tag refused the
 *   bytes, or the file is not an age v1 file we can read. Damage or tampering;
 *   the AEAD does not say which, and neither does this.
 */
export type BundleFetchFailureKind =
  | "transfer"
  | "no-identity"
  | "no-matching-identity"
  | "ciphertext-rejected";

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

export type BundleFetchOutcome =
  | { ok: true; encrypted: boolean }
  | { ok: false; encrypted: boolean; failure: BundleFetchFailure };

/**
 * Tear a stream down and swallow whatever it reports on the way.
 *
 * Used only on a failure path where the real diagnosis is already in hand. A
 * stream that has lost its `pipeline` has no error listener left, so an error
 * still in flight becomes an unhandled one — a run-failing event under vitest,
 * and in production a crash on the path whose whole job is to fail politely.
 */

/**
 * Attach a no-op `'error'` listener so the stream can never emit an unhandled
 * one, for as long as it exists.
 *
 * This is a companion to `absorbLateError`, not a replacement: that one tears a
 * stream down and awaits its close on the failure path, this one guarantees
 * there is no instant — before `pipeline` is wired, between its rejection and
 * the `catch`, or after everything has settled — at which an emitted error has
 * nobody listening. `pipeline` is unaffected; it tracks completion itself
 * rather than by being the sole listener.
 */
function swallowErrors(s: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  (s as { on?: (ev: string, fn: () => void) => void }).on?.("error", () => {});
}

async function absorbLateError(s: NodeJS.ReadableStream | NodeJS.WritableStream): Promise<void> {
  (s as { destroy?: () => void }).destroy?.();
  await finished(s as NodeJS.ReadableStream).catch(() => {});
}

/**
 * One exception, one of the four kinds. **Shared by both directions**, which is
 * the point: a re-wrap and a fetch fail for the same four reasons and must not
 * describe them two ways — "this machine is not a recipient" in particular is
 * the same fact whether it was found while reading a bundle or while trying to
 * re-address one.
 */
export function classifyBundleFailure(e: unknown): BundleFetchFailure {
  const message = (e as Error).message;
  if (!(e instanceof AgeError)) return { kind: "transfer", message };
  switch (e.code) {
    case "no-matching-identity":
      return { kind: "no-matching-identity", message };
    // `bad-key` here can only be OUR identity: the recipient side never reaches
    // this function, and `readIdentityFile` re-derives rather than trusting the
    // file's comment, so a key that parses at read time and fails at use time is
    // a key problem and not a bundle problem. `no-recipients` is unreachable on
    // the read path at all — it is the encryptor's refusal — and is listed
    // rather than left to `default` precisely because it is: routed there it
    // would be reported as damaged ciphertext, which is the wrong remedy for a
    // fact about keys.
    case "bad-key":
    case "no-recipients":
      return { kind: "no-identity", message };
    default:
      return { kind: "ciphertext-rejected", message };
  }
}

/**
 * This machine's identity as raw key bytes, or the failure that explains why
 * not — the one step both directions take before they can touch ciphertext.
 *
 * Shared rather than written twice because the DISTINCTION it draws is the
 * valuable part and is easy to lose: "no usable key here" (`no-identity`) is a
 * different fact from "this key is not one of the file's recipients"
 * (`no-matching-identity`), and only the first has a local remedy. A second
 * copy is how one of the two callers ends up reporting a permission problem as
 * "this bundle was never addressed to you".
 */
function identityBytes(
  key: IdentityFileState
): { ok: true; raw: Buffer } | { ok: false; failure: BundleFetchFailure } {
  if (key.state !== "present") {
    return {
      ok: false,
      failure: {
        kind: "no-identity",
        message:
          key.state === "absent"
            ? "this machine has no ~/.sesh-mover/identity.age"
            : // The detail carries the identity file's own absolute path on an
              // `io` cause. Kept, unlike the hub path the preflight refusals
              // withhold: this one is a fixed, documented, local path the user
              // already knows, and EACCES-vs-EISDIR is the entire diagnosis.
              `~/.sesh-mover/identity.age is unreadable (${key.cause}): ${key.detail}`,
      },
    };
  }
  try {
    return { ok: true, raw: parseIdentity(key.identity) };
  } catch (e) {
    return { ok: false, failure: classifyBundleFailure(e) };
  }
}

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
export async function fetchBundleArchive(input: {
  backend: HubBackend;
  file: string;
  destPath: string;
  identity?: IdentityFileState;
}): Promise<BundleFetchOutcome> {
  const encrypted = isEncryptedBundleFile(input.file);

  let identityRaw: Buffer | null = null;
  if (encrypted) {
    const key = identityBytes(input.identity ?? readIdentityFile());
    if (!key.ok) return { ok: false, encrypted, failure: key.failure };
    identityRaw = key.raw;
  }

  const out = createWriteStream(input.destPath);
  // ATTACHED AT CREATION, and that timing is the whole point. `absorbLateError`
  // below closes the window *after* `pipeline` settles; it does not close the
  // window *before* it, and an `'error'` emitted in between lands on a stream
  // with no listener, which Node reports as an unhandled error — a run-failing
  // event under vitest and a crash in production, on the path whose entire job
  // is to fail politely.
  //
  // Measured: with only the after-the-fact absorber, the download-abort test
  // failed roughly 1 run in 12 on a loaded runner (macOS CI and locally alike),
  // and it failed at HEAD too — so narrowing the window was never the same as
  // closing it. A permanently attached no-op listener means there is no moment
  // at which an error is unhandled. `pipeline` still rejects: it tracks
  // completion itself rather than relying on being the only listener.
  swallowErrors(out);
  // Declared out here so the catch can reach them: whichever end fails first,
  // the OTHERS still have an error in flight that nobody is listening for.
  let src: NodeJS.ReadableStream | undefined;
  let dec: AgeDecryptStream | undefined;
  try {
    // `input.file` is hub-sourced (read out of another machine's index file) and
    // becomes a path immediately below — the backend's `assertHubRelPath`
    // (hub/layout.ts, enforced inside every HubBackend method) is the
    // containment that rejects traversal/absolute paths before anything touches
    // the filesystem.
    //
    // The `pipeline` is inside the `try` and not merely the call that looks
    // risky: an ENOENT never comes out of `readStream` at all on some backends —
    // it arrives as a stream error and surfaces as the `pipeline` rejection.
    src = await input.backend.readStream(input.file);
    swallowErrors(src);
    if (identityRaw) {
      dec = new AgeDecryptStream(identityRaw);
      swallowErrors(dec);
      await pipeline(src, dec, out);
    } else {
      await pipeline(src, out);
    }
  } catch (e) {
    // ABSORB THE LATE ERRORS before returning, or one lands on a stream nobody
    // is listening to any more and Node reports it as unhandled — which vitest
    // fails the whole run for, and which in production is a crash on a path
    // whose entire purpose is to fail politely.
    //
    // `createWriteStream` opens lazily and ASYNCHRONOUSLY, and `out` is created
    // above the `try` (it has to be — `pipeline` needs it). So when the SOURCE
    // errors first, which is the common case because a missing hub file fails
    // fast, `pipeline` rejects and detaches while `out`'s `open()` is still in
    // flight. That open then resolves against a temp directory the caller may
    // already have torn down. Observed as an intermittent ENOENT on a loaded CI
    // runner, never locally.
    //
    // EVERY end, not just the destination — macOS proved the asymmetry was a
    // bug. `pipeline` settles on whichever stream fails FIRST and then detaches
    // its listeners; the others' errors arrive afterwards with nobody
    // listening. The decrypt transform joins the list for the same reason, and
    // it is the one most likely to be the failing end: an `AgeError` is raised
    // in the middle of a pipeline whose source is still pushing bytes.
    //
    // The errors discarded here are never the ones worth reporting: `e` already
    // says why, and these only say that a stream being torn down was torn down.
    await absorbLateError(out);
    if (dec !== undefined) await absorbLateError(dec);
    if (src !== undefined) await absorbLateError(src);
    return { ok: false, encrypted, failure: classifyBundleFailure(e) };
  }
  return { ok: true, encrypted };
}

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
export function bundleEncryptStream(recipients: readonly string[]): AgeEncryptStream {
  return new AgeEncryptStream(recipients.map((r) => parseRecipient(r)));
}


/** The two outcomes of `rewrapBundleFile`. */
export type BundleRewrapOutcome =
  | {
      ok: true;
      /**
       * How many recipient stanzas the file carried BEFORE this call, or `null`
       * if the stream never reported (it always does on success). Compare it
       * with the size of the new set to notice that a rekey NARROWED the
       * readership; which machines were dropped is not recoverable, because a
       * stanza carries an ephemeral share and never a public key.
       */
      previousRecipientStanzas: number | null;
    }
  | { ok: false; failure: BundleFetchFailure };

/**
 * Re-address one of THIS machine's own encrypted bundles to a new recipient
 * set, in place, without decrypting the payload.
 *
 * The primitive under `hub rekey`, and the seam compaction (#92) reaches for
 * when it needs the same thing. Everything about which files, in what order,
 * and what to do when one fails belongs to the caller; this function moves one
 * file's bytes and classifies one failure.
 *
 * ### In place, under the SAME NAME, and that is the whole reason it is cheap
 *
 * The name is what every index on the hub records, and a rekey changes no name:
 * the file was `….tar.gz.age` before and is `….tar.gz.age` after, so this
 * machine's index needs no rewrite, no other machine's index goes stale, and
 * nothing has to be deleted. That is also why it cannot turn a PLAINTEXT bundle
 * into an encrypted one — that changes the suffix, which the reader branches on
 * — and why the caller filters by `isEncryptedBundleFile` before calling.
 *
 * ### The failure contract, which is what makes a partial run safe
 *
 * `writeStreamAtomic` writes a temp file and renames, so this either replaces
 * the bundle whole or leaves it exactly as it was; there is no state in which
 * the file is half a header. Combined with the caller's self-check — the new
 * recipient set must contain the machine running this — every bundle is
 * readable by this machine before the call and after it, whichever way the call
 * goes. A run that dies at file K therefore leaves K-1 files re-addressed and
 * the rest untouched, and no file unreadable by anyone.
 *
 * **Returns a result and never throws**, on the same reasoning
 * `fetchBundleArchive` states: the caller is a loop over files, and one file's
 * exception must not cost the diagnosis for the rest.
 *
 * @param identity read ONCE by the caller and passed down, so the key that
 *   satisfied the self-check is provably the key every unwrap uses — re-reading
 *   here would leave a window in which the file changes mid-run.
 */
export async function rewrapBundleFile(input: {
  backend: HubBackend;
  /** Hub-relative path to one of THIS machine's own bundle/workspace files. */
  file: string;
  /** The new set, in full — `age1…` strings, as the census reports them. */
  recipients: readonly string[];
  identity: IdentityFileState;
}): Promise<BundleRewrapOutcome> {
  const key = identityBytes(input.identity);
  if (!key.ok) return { ok: false, failure: key.failure };

  let rewrap: AgeRewrapStream;
  try {
    // Both throws land here on purpose: a recipient string the census admitted
    // and `parseRecipient` rejects, and an empty list. Neither is reachable
    // from `hub rekey` (the census re-parses, and the self-check guarantees at
    // least this machine), so this is the belt — and it is a `no-identity`
    // classification for a `bad-key`, which is the right remedy for both.
    rewrap = new AgeRewrapStream(key.raw, input.recipients.map((r) => parseRecipient(r)));
  } catch (e) {
    return { ok: false, failure: classifyBundleFailure(e) };
  }
  swallowErrors(rewrap);

  let w;
  try {
    // Opened BEFORE the read, and it only creates the temp file — the target is
    // untouched until `commit()` renames over it.
    w = await input.backend.writeStreamAtomic(input.file);
  } catch (e) {
    return { ok: false, failure: classifyBundleFailure(e) };
  }
  swallowErrors(w.stream);

  let src: NodeJS.ReadableStream | undefined;
  try {
    src = await input.backend.readStream(input.file);
    swallowErrors(src);
    await pipeline(src, rewrap, w.stream);
    // WAIT FOR THE SOURCE FD TO CLOSE BEFORE COMMITTING. `commit()` renames the
    // temp over the file this pipeline was just reading, and on Windows a
    // rename over a path with an open handle fails outright. `pipeline`
    // destroys the source when it settles, but the close is asynchronous, so
    // awaiting it is what makes the ordering real rather than likely. The
    // rejection this can produce (`ERR_STREAM_PREMATURE_CLOSE` on a destroyed
    // stream) is the expected path, not a failure.
    await finished(src).catch(() => {});
    await w.commit();
  } catch (e) {
    // `abort()` removes the temp and never throws, so the bundle on the hub is
    // exactly what it was. The transform and the source still have errors in
    // flight that `pipeline` stopped listening for — same reasoning, and the
    // same measured failure, as `fetchBundleArchive`'s catch.
    await w.abort();
    await absorbLateError(rewrap);
    if (src !== undefined) await absorbLateError(src);
    return { ok: false, failure: classifyBundleFailure(e) };
  }
  return { ok: true, previousRecipientStanzas: rewrap.previousRecipientStanzas };
}
