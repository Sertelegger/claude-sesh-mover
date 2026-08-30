/**
 * Identity escrow: a passphrase-wrapped copy of THIS machine's
 * `~/.sesh-mover/identity.age`, written to a path the user names.
 *
 * ---------------------------------------------------------------------------
 * What this is, and the design it replaced
 * ---------------------------------------------------------------------------
 *
 * The spec (§2.3, §6 Q2) proposed escrowing every BUNDLE — "an scrypt stanza
 * alongside the X25519 ones", one field, no key transported. **That cannot be
 * built.** The age spec forbids the mix with a MUST, and it was measured
 * against age 1.2.1 using a hand-built header the CLI cannot produce: a mixed
 * file is accepted with `-i` and REJECTED with a passphrase. So a mixed bundle
 * reads perfectly on every ordinary pull, on every machine, forever, and fails
 * at exactly one moment — when someone reaches for the escrow passphrase, which
 * is by definition after the key is already lost. Do not attempt it again; see
 * block #4 in `crypto/age.ts` for the enforcement that keeps it unattemptable.
 *
 * What ships instead escrows the IDENTITY. `age -e -p identity.age` produces a
 * file age itself documents as usable as an identity file, so recovery is one
 * standard-tool step and needs nothing from this plugin:
 *
 *     age -d -i <escrow file> <bundle>.tar.gz.age     # prompts, then decrypts
 *
 * Three properties fall out of that choice, and they are why it is the better
 * shape rather than merely the possible one. It is **one small file**, not a
 * second full-size ciphertext per artifact. It is **one-time and attended**, so
 * the 256 MiB / ~0.5 s scrypt derivation never lands on the unattended
 * SessionEnd push, and the passphrase never has to be readable by a detached
 * TTY-less process — i.e. never at rest on disk. And it changes **nothing** on
 * the bundle path: `push`, `pull`, `rekey`, `retire` and `reindex` do not know
 * this file exists.
 *
 * What it gives up is squarely §2.3's *"no private key is ever transported"*,
 * and that is the whole of the trade. Hence: default off, and a warning at the
 * point of enabling that is not softened anywhere.
 *
 * ---------------------------------------------------------------------------
 * RECOVERY ONLY. It is not a backfill mechanism, and the difference matters
 * ---------------------------------------------------------------------------
 *
 * Restoring an escrow onto a rebuilt machine restores **that machine's own**
 * identity, so no key moves between machines and the per-machine design is
 * intact.
 *
 * Using it to give a DIFFERENT machine access does move a key, and it collapses
 * two machines into one identity: from then on, revoking either means revoking
 * both, and every future bundle addressed to "machine A" is readable by two
 * places. Per-machine revocation is the reason the identities are per-machine
 * at all. `hub rekey` already does backfill — it re-addresses a machine's own
 * bundles to today's roster without moving a key — so there is a correct tool
 * for the job the misuse is reaching for, and every doc says so.
 *
 * ---------------------------------------------------------------------------
 * The passphrase never comes from this process's argv, env or config
 * ---------------------------------------------------------------------------
 *
 * A flag lands in shell history. A config file sits in plaintext beside the
 * thing it protects. An environment variable leaks through `/proc/<pid>/environ`
 * AND is inherited by every subprocess — including the `git` this repo spawns on
 * user data, since `gitChildEnv()` scrubs `GIT_*` and would pass anything else
 * straight through to git, its credential helper and its hooks. So: stdin,
 * once, and nothing else. `cli.ts` reads it; this module receives bytes.
 *
 * **And the obvious answer is the dangerous one.** "Have the skill layer prompt
 * for it" and "the passphrase lands in a transcript this plugin then uploads to
 * the hub" are the same event: a passphrase typed into a Claude Code session is
 * written into the JSONL that the default-on SessionEnd auto-push ships —
 * encrypted to a key that very passphrase unwraps. `browse --prune` delegating
 * its prompt to the skill layer is not a precedent, because nothing it collects
 * is a secret. `commands/hub-escrow.md` therefore tells the user what to run in
 * their own shell and must never ask them in-chat.
 */
import type { HubEscrowRefusedResult, HubEscrowResult } from "../types.js";
/**
 * The pointer file. Not a secret and not a key: it records WHERE an escrow was
 * written, WHICH public key it corresponds to, and WHEN — so `status` can say
 * "the escrow you made is for a key this machine no longer has", which is the
 * one question a user cannot answer by looking at the file.
 *
 * Named here beside its only reader rather than in `paths.ts`, for the reason
 * `identity-file.ts` gives: `paths.ts` owns names that appear inside a user's
 * PROJECT, where a second copy of the list is a hole in the `NEVER_INCLUDABLE`
 * floor. Nothing in a project is named `escrow.json`.
 */
export declare const ESCROW_RECORD_FILE_NAME = "escrow.json";
export declare function escrowRecordPath(): string;
/**
 * How the passphrase reached (or failed to reach) this module. Three cases
 * rather than `Buffer | null`, because the three have different remedies and
 * the "you are about to type a secret where it will be echoed" one is the whole
 * reason the TTY case is refused instead of read.
 */
export type EscrowPassphraseInput = {
    kind: "given";
    bytes: Buffer;
}
/** `--passphrase-stdin` was not passed. */
 | {
    kind: "not-requested";
}
/** It was, but stdin is a terminal — reading would echo the passphrase. */
 | {
    kind: "terminal";
};
export type EscrowRefusal = "no-identity" | "no-out" | "unsafe-out" | "passphrase" | "not-enabled";
/**
 * Why a destination was refused. Each is a way the escrow ends up somewhere
 * that copies it to a place the identity it wraps was never meant to reach.
 */
export type UnsafeOutRule = "no-parent-directory" | "exists" | "inside-hub" | "inside-project" | "inside-git-work-tree" | "looks-synced";
export type DestinationVerdict = {
    ok: true;
    path: string;
    warnings: string[];
} | {
    ok: false;
    rule: UnsafeOutRule;
    path: string;
    detail: string;
    suggestion: string;
};
/**
 * THE LIMIT, stated wherever the check is. It is disclosed on every result —
 * success and refusal alike — because a refusal that fires makes the check look
 * more capable than it is, and that is the moment a user concludes the
 * destination they picked instead must be safe.
 */
export declare const ESCROW_DESTINATION_LIMITS: readonly string[];
export interface HubEscrowOptions {
    action: "status" | "enable" | "disable";
    /** Required for `enable`. */
    outPath?: string;
    passphrase: EscrowPassphraseInput;
    /** The project directory this invocation is for; the `--out` check uses it. */
    cwd: string;
    /** The configured hub directory, or null when none is configured. */
    hubPath: string | null;
    /**
     * Tests only, so the shape can be exercised without paying ~0.5 s and 256 MiB
     * per case. `cli.ts` never passes it — there is no flag, on purpose: there is
     * no MINIMUM work factor (logN 1 decrypts cleanly under age, measured), so a
     * silently weak escrow is accepted by every tool and the writer's choice is
     * the only protection that exists.
     */
    logN?: number;
}
/**
 * Canonicalize as far as the platform allows, degrading to the lexical path
 * rather than throwing.
 *
 * `.native` FIRST, and on Windows that is the whole point. The JS
 * implementation resolves symlinks but leaves an 8.3 SHORT NAME alone, so
 * `os.tmpdir()`'s `C:\Users\RUNNER~1\AppData\Local\Temp` stays short while
 * `userInfo().homedir` answers `C:\Users\runneradmin` — two spellings of one
 * directory that no string comparison can reconcile. `realpathSync.native`
 * asks the OS and gets the long form for both.
 *
 * EXPORTED, and one copy only. A test that compares against a path this module
 * reports has to canonicalize it the same way, and a second copy of the rule
 * in the fixture is precisely the disagreement being fixed here: the fixture
 * used the JS `realpathSync`, kept `RUNNER~1`, and failed against a product
 * that had correctly resolved it.
 *
 * Measured on the Windows runner, and it failed in BOTH directions, which is
 * why this is a product fix and not a test one. The exemption for a home's
 * user-scope store missed, so every temp path read as `inside-project`; and
 * the invoking-project rule compares a chain-derived path against `cwd`, so
 * the same mismatch would silently NOT fire it — a refusal that does not
 * happen, which is the direction that matters.
 */
export declare function canonicalPath(p: string): string;
/**
 * Every directory that is a home on this machine, realpath'd.
 *
 * TWO answers, because they disagree and the disagreement is the bug. `homedir()`
 * reads $HOME (or $USERPROFILE), so it MOVES whenever a test, a sandbox, a
 * service manager or a shell relocates the environment; `userInfo().homedir` is
 * the OS's own passwd/profile answer and does not move. `<home>/.sesh-mover` is
 * the USER-scope export store rather than a project under EITHER spelling, so
 * both are exempted below.
 *
 * This is a Windows problem and essentially only a Windows problem: the temp
 * root lives UNDER the profile there, so with $HOME pointed elsewhere the real
 * profile's user-scope store becomes an ancestor of every temp path and the
 * whole tree reads as "inside a sesh-mover project". On Linux and macOS the
 * temp root is not under the home and nothing notices. Measured: it turned all
 * 18 destination assertions into `inside-project`, and it would do the same to
 * any Windows user whose $HOME does not match their profile.
 *
 * Widening an exemption inside a security check is worth stating plainly: what
 * stops it mattering is that the OTHER two markers still fire on the same
 * directory. A home that genuinely is a project still carries
 * `.sesh-mover-project.json`, which is checked unconditionally, and a home that
 * is the invoking project is caught by the cwd rule.
 *
 * Exported for the same reason `checkEscrowDestination` is — a test can prove
 * both spellings are consulted without staging a fake profile, which is the one
 * thing that cannot work here (see the test). `src/index.ts` re-exports this
 * module wholesale, so that also puts it on the library's public surface;
 * deliberate rather than overlooked, and it is a pure function over `node:os`.
 */
export declare function homeDirs(): string[];
/**
 * Decide whether `outPath` is a safe place to put a passphrase-wrapped copy of
 * this machine's private key.
 *
 * The parent directory is REALPATH'd before anything else: a symlink named
 * `~/safe` pointing into a git work tree would otherwise pass every check
 * lexically and land the escrow in a repository. The file itself is not
 * realpath'd — it must not exist yet.
 *
 * Exported so the rules can be tested directly, without a passphrase, an
 * identity or a 256 MiB derivation.
 */
export declare function checkEscrowDestination(outPath: string, ctx: {
    cwd: string;
    hubPath: string | null;
}): DestinationVerdict;
/**
 * The recovery invocation, spelled once so the CLI, the command doc and the
 * README cannot drift. It is deliberately an `age` command and not a
 * `sesh-mover` one: key loss and plugin loss must not be the same event, and a
 * recovery step that needs this plugin installed is a recovery step that fails
 * on a machine rebuilt from nothing.
 */
export declare function escrowRecoverySteps(escrowPath: string): string[];
export declare function hubEscrow(opts: HubEscrowOptions): Promise<HubEscrowResult | HubEscrowRefusedResult>;
//# sourceMappingURL=escrow.d.ts.map