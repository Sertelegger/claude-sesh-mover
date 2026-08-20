/**
 * This machine's X25519 identity: where the private half lives, how it is
 * created, and — the part that matters most — how the three states it can be in
 * are told apart.
 *
 * ---------------------------------------------------------------------------
 * Why a file of its own
 * ---------------------------------------------------------------------------
 *
 * `~/.sesh-mover/machine-id.json` already exists, is user-scope and is created
 * on first use, and it is the obvious place to put a key. It is the wrong place:
 * several paths read it, nothing treats it as a secret, and its whole content is
 * published to the hub verbatim. A private key added to it would be one careless
 * `JSON.stringify(identity)` away from the hub. So the secret goes in
 * `~/.sesh-mover/identity.age`, mode 0600, and the two files never mix.
 *
 * The directory is `userSeshMoverDir()` and never a hand-written `.sesh-mover`
 * literal — same rule as everywhere else (`paths.ts`). The *file* name is
 * spelled here, beside its only reader, exactly as `machine-id.json` is spelled
 * in `machine.ts`: `paths.ts` owns the names that appear inside a user's
 * PROJECT, where a second copy of the list is a security hole (the
 * `NEVER_INCLUDABLE` floor). Nothing in a project is named `identity.age`.
 *
 * ---------------------------------------------------------------------------
 * Absent is not the same as unreadable, and conflating them destroys a key
 * ---------------------------------------------------------------------------
 *
 * The obvious shape is `readIdentity(): string | null` with `null` for "no
 * usable key", and `loadOrCreate` minting one when it gets `null`. That is a key
 * shredder. A file that exists but does not parse — a truncated write, a sync
 * client's conflict copy, half a restore — would be silently replaced by a fresh
 * identity, and every bundle on the hub encrypted to the old public key becomes
 * permanently unreadable by this machine. The old key was RIGHT THERE on disk,
 * possibly recoverable by hand, until we overwrote it.
 *
 * So the read is three-valued (`absent` / `unreadable` / `present`) and the
 * create half **never writes over a file that exists**, whatever its contents.
 * It opens with `wx`, which is also what makes two concurrent first-uses safe:
 * the loser gets `EEXIST` and re-reads rather than clobbering the winner.
 *
 * ---------------------------------------------------------------------------
 * File permissions, and what Windows actually does
 * ---------------------------------------------------------------------------
 *
 * POSIX: created with mode 0600 and then `chmod`ed to 0600. Both, because the
 * `mode` argument is masked by `umask` — it is a ceiling, never a floor — so it
 * alone cannot promise an exact mode, while `chmod` alone would leave a window
 * during which the file exists at the umask-derived mode. Since that mode is
 * already <= 0600, the `chmod` can only restore bits within owner-only; it
 * cannot widen access to group or other.
 *
 * **Windows: there is no 0600.** Node maps the `mode` argument onto the
 * read-only attribute and nothing else; a private key file there is protected by
 * the ACL it inherits from `%USERPROFILE%\.sesh-mover`, which by default grants
 * the owning user, SYSTEM and the local Administrators group. That is weaker
 * than 0600 — an administrator can read it without impersonating the user — and
 * this module does not pretend otherwise: `insecureMode` is reported as `false`
 * on Windows because the POSIX bits carry no meaning there, NOT because the file
 * has been checked and found safe.
 */
/** The private half of this machine's identity. Never transported, ever. */
export declare const IDENTITY_FILE_NAME = "identity.age";
/** `~/.sesh-mover/identity.age`. */
export declare function identityFilePath(): string;
/**
 * Why a present-but-unusable identity file is unusable. Two causes, because
 * they have different remedies and only one of them is a lost key:
 *
 * - `io` — the bytes could not be read at all (a directory at the path, a
 *   permission failure, a dead mount). The key may be perfectly intact. Retrying
 *   after fixing the filesystem is the remedy.
 * - `malformed` — the bytes were read and are not an age identity. The key is
 *   gone unless a backup exists; minting a new one is a decision with
 *   consequences (every bundle encrypted to the old public key stays unreadable
 *   here), so it is the user's to make, not ours.
 */
export type IdentityFileCause = "io" | "malformed";
/**
 * A note for whoever first surfaces one of these to a user: the `detail` string
 * is a DIAGNOSTIC, not a message. An `io` detail is a Node error message and so
 * carries the identity file's absolute path — the same thing `preflight.ts`
 * deliberately keeps out of its refusals ("No path in any of it"). A `malformed`
 * detail comes from `age.ts`/`bech32.ts`, which never echo more than one
 * character of their input, so it cannot carry key material; that is a property
 * of those modules, checked, not an assumption about error strings in general.
 */
export type IdentityFileState = {
    state: "absent";
} | {
    state: "unreadable";
    cause: IdentityFileCause;
    detail: string;
} | {
    state: "present";
    /** `AGE-SECRET-KEY-1…`. */
    identity: string;
    /** `age1…`, derived from the identity — never read from the file's comment. */
    recipient: string;
    /**
     * POSIX only: the file is readable by group or other. `false` on Windows,
     * where the mode bits mean nothing — see the header. Advisory: a caller
     * that acts on it should warn, not refuse, because refusing would turn a
     * cosmetic permission drift into a machine that cannot push.
     */
    insecureMode: boolean;
};
/**
 * Read the identity file without creating anything.
 *
 * Deliberately does NOT trust the `# public key:` comment: the recipient is
 * always re-derived from the secret. A comment is a claim; the derivation is the
 * fact, and publishing a recipient nobody holds the key for is exactly the kind
 * of silent mismatch that only surfaces as "I cannot decrypt my own bundles".
 */
export declare function readIdentityFile(): IdentityFileState;
export type IdentityLoad = {
    ok: true;
    identity: string;
    recipient: string;
    /** This call minted it. `false` when an existing file was read. */
    created: boolean;
    insecureMode: boolean;
} | {
    ok: false;
    cause: IdentityFileCause;
    detail: string;
};
/**
 * Read this machine's identity, minting one on first use.
 *
 * **Returns a result and never throws**, which is a decision about the caller
 * rather than a style: `registerMachine` runs on every push and pull, including
 * the detached, unattended SessionEnd auto-push, and a machine that has never
 * encrypted anything must not lose the ability to push plaintext because its key
 * file is broken. A caller that is about to ENCRYPT must treat `ok: false` as
 * fatal — that is the failure rule in `age.ts`'s header, and it belongs at the
 * encrypting call site, not here.
 *
 * `ok: false` is returned rather than a fresh key for the reason in the header:
 * a present-but-unreadable file is never overwritten.
 */
export declare function loadOrCreateIdentity(): IdentityLoad;
//# sourceMappingURL=identity-file.d.ts.map