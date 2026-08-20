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
import { createWriteStream } from "node:fs";
import { finished, pipeline } from "node:stream/promises";
import { AgeDecryptStream, AgeEncryptStream, AgeError, parseIdentity, parseRecipient } from "../crypto/age.js";
import { readIdentityFile } from "../crypto/identity-file.js";
import { isEncryptedBundleFile } from "./layout.js";
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
function swallowErrors(s) {
    s.on?.("error", () => { });
}
async function absorbLateError(s) {
    s.destroy?.();
    await finished(s).catch(() => { });
}
function classify(e) {
    const message = e.message;
    if (!(e instanceof AgeError))
        return { kind: "transfer", message };
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
export async function fetchBundleArchive(input) {
    const encrypted = isEncryptedBundleFile(input.file);
    let identityRaw = null;
    if (encrypted) {
        const key = input.identity ?? readIdentityFile();
        if (key.state !== "present") {
            return {
                ok: false,
                encrypted,
                failure: {
                    kind: "no-identity",
                    message: key.state === "absent"
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
            identityRaw = parseIdentity(key.identity);
        }
        catch (e) {
            return { ok: false, encrypted, failure: classify(e) };
        }
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
    let src;
    let dec;
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
        }
        else {
            await pipeline(src, out);
        }
    }
    catch (e) {
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
        if (dec !== undefined)
            await absorbLateError(dec);
        if (src !== undefined)
            await absorbLateError(src);
        return { ok: false, encrypted, failure: classify(e) };
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
export function bundleEncryptStream(recipients) {
    return new AgeEncryptStream(recipients.map((r) => parseRecipient(r)));
}
//# sourceMappingURL=bundle-io.js.map