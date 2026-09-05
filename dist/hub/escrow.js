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
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { errorMessage } from "../errors.js";
import { AGE_SCRYPT_LOG_N, AgeDecryptStream, AgeEncryptStream, AgeError } from "../crypto/age.js";
import { identityFilePath, readIdentityFile } from "../crypto/identity-file.js";
import { PROJECT_DIR_NAME, PROJECT_JSON_FILE_NAME, userSeshMoverDir } from "../paths.js";
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
export const ESCROW_RECORD_FILE_NAME = "escrow.json";
export function escrowRecordPath() {
    return join(userSeshMoverDir(), ESCROW_RECORD_FILE_NAME);
}
/**
 * Directory names that mean "a third party syncs this". NAMES ONLY, matched
 * case-insensitively against each ancestor directory, plus a handful of marker
 * files the clients drop.
 *
 * Deliberately conservative on both sides. `Box` and `Sync` on their own are
 * omitted — they are ordinary directory names and a false refusal here is a
 * feature the user cannot use. And see `ESCROW_DESTINATION_LIMITS`: the honest
 * statement of what this list is, is "the obvious mistake", not "detection".
 */
const SYNCED_DIR_NAMES = [
    "dropbox",
    "google drive",
    "googledrive",
    "my drive",
    "onedrive",
    "icloud drive",
    "icloudrive",
    "mobile documents",
    "nextcloud",
    "owncloud",
    "syncthing",
    "pcloud",
    "pclouddrive",
    "box sync",
    "mega",
    "megasync",
    "yandex.disk",
    "yandexdisk",
    "seafile",
    "creative cloud files",
    "tresorit",
    "proton drive",
    "protondrive",
    "resilio sync",
    "insync",
];
/** Marker files a sync client leaves in the directory it manages. */
const SYNCED_MARKER_FILES = [
    ".dropbox",
    ".dropbox.cache",
    ".stfolder",
    ".stversions",
    ".csync_journal.db",
    ".owncloudsync.log",
    ".nextcloudsync.log",
];
/**
 * THE LIMIT, stated wherever the check is. It is disclosed on every result —
 * success and refusal alike — because a refusal that fires makes the check look
 * more capable than it is, and that is the moment a user concludes the
 * destination they picked instead must be safe.
 */
export const ESCROW_DESTINATION_LIMITS = [
    "This check is a guard against the obvious mistake, not a guarantee. It matches directory NAMES " +
        "and marker files for common cloud-sync clients, plus git work trees, sesh-mover projects and the " +
        "configured hub directory.",
    "It CANNOT tell that your home directory — or any parent of it — is itself a synced folder, a " +
        "network mount, a backup target or a shared volume. If it is, an accepted destination is still " +
        "the wrong one and only you can know that.",
];
// ---------------------------------------------------------------------------
// The destination check.
// ---------------------------------------------------------------------------
/** Every directory from `start` up to the filesystem root, nearest first. */
function ancestors(start) {
    const out = [];
    let d = start;
    const root = parse(start).root;
    for (;;) {
        out.push(d);
        if (d === root)
            break;
        const up = dirname(d);
        if (up === d)
            break;
        d = up;
    }
    return out;
}
function isInside(child, parent) {
    const c = foldPath(child);
    const p = foldPath(parent);
    if (c === p)
        return true;
    return c.startsWith(p.endsWith(sep) ? p : p + sep);
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
export function canonicalPath(p) {
    try {
        return realpathSync.native(p);
    }
    catch {
        try {
            return realpathSync(p);
        }
        catch {
            return p;
        }
    }
}
/**
 * Windows path comparison is case-insensitive; POSIX is not, and folding case
 * there would make `/home/Dev` and `/home/dev` the same directory when they
 * are two. Belt-and-braces beside `realish` — the OS canonicalizes casing too,
 * but only for a path that resolved.
 */
const foldPath = (p) => process.platform === "win32" ? p.toLowerCase() : p;
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
export function homeDirs() {
    const dirs = [canonicalPath(homedir())];
    try {
        dirs.push(canonicalPath(userInfo().homedir));
    }
    catch {
        // userInfo() throws when the uid has no passwd entry — containers and some
        // CI images. homedir()'s answer is then the only one there is.
    }
    return dirs;
}
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
export function checkEscrowDestination(outPath, ctx) {
    const requested = resolve(outPath);
    const parent = dirname(requested);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
        return {
            ok: false,
            rule: "no-parent-directory",
            path: requested,
            detail: "the directory that would hold the escrow does not exist",
            suggestion: "Create the directory yourself and run this again. This command does not create " +
                "directories at a path you named — a typo would silently make one.",
        };
    }
    const dir = canonicalPath(parent);
    const path = join(dir, basename(requested));
    if (existsSync(path)) {
        return {
            ok: false,
            rule: "exists",
            path,
            detail: "a file is already there",
            suggestion: "Choose a path that does not exist. Nothing is overwritten here: the file already " +
                "there may be an earlier escrow, and replacing it would destroy the only copy of a key " +
                "whose passphrase you may still remember.",
        };
    }
    const chain = ancestors(dir);
    const homes = homeDirs();
    // Priority is fixed rather than "whichever ancestor is nearest": the rules
    // answer different questions and the most specific answer is the most useful
    // one to print, regardless of how deep the directory that triggered it was.
    const hubReal = ctx.hubPath ? canonicalPath(ctx.hubPath) : null;
    if (hubReal && isInside(dir, hubReal)) {
        return {
            ok: false,
            rule: "inside-hub",
            path,
            detail: "this is inside the configured hub directory",
            suggestion: "Put the escrow somewhere the hub does not reach. Writing it here escrows the key into " +
                "the very thing the key protects: anyone who can read the hub would hold both the " +
                "bundles and a passphrase-guarded copy of the key that opens them.",
        };
    }
    const cwdReal = canonicalPath(resolve(ctx.cwd));
    const projectDir = chain.find((d) => existsSync(join(d, PROJECT_JSON_FILE_NAME)) ||
        // `~/.sesh-mover` is the USER-scope directory and is not a project. The
        // marker only means "project" below a home directory — see homeDirs()
        // for why "a home" is two answers rather than one.
        (!homes.some((h) => foldPath(h) === foldPath(d)) &&
            existsSync(join(d, PROJECT_DIR_NAME))));
    if (isInside(dir, cwdReal) || projectDir) {
        return {
            ok: false,
            rule: "inside-project",
            path,
            // NAME THE DIRECTORY. Which ancestor tripped the rule is the only part
            // the user can act on — "somewhere above you is a project" sends them
            // hunting — and `looks-synced` below has always named its own. It is
            // also the difference between diagnosing a cross-platform failure and
            // guessing at it: this rule fires on an ancestor the caller never chose
            // and, on Windows, may not know is above the temp root.
            detail: projectDir
                ? `this is inside a sesh-mover project (${projectDir})`
                : `this is inside the project directory this command is running for (${cwdReal})`,
            suggestion: "Put the escrow outside every project. A project's tree is what `push` uploads to the " +
                "hub — as a workspace snapshot when there is no git remote, and as a carry otherwise — " +
                "so an escrow left here is an escrow the next session-end push sends to the hub.",
        };
    }
    const gitDir = chain.find((d) => existsSync(join(d, ".git")));
    if (gitDir) {
        return {
            ok: false,
            rule: "inside-git-work-tree",
            path,
            detail: `this is inside a git work tree (${gitDir})`,
            suggestion: "Put the escrow outside every repository. One `git add -A` and one push and the escrow " +
                "is wherever that remote is, permanently and for everyone with read access — a dotfiles " +
                "repository is the usual way this happens.",
        };
    }
    const synced = chain.find((d) => SYNCED_DIR_NAMES.includes(basename(d).toLowerCase()) ||
        basename(d).toLowerCase().startsWith("onedrive - ") ||
        SYNCED_MARKER_FILES.some((m) => existsSync(join(d, m))));
    if (synced) {
        return {
            ok: false,
            rule: "looks-synced",
            path,
            detail: `an enclosing directory looks like a synced folder (${synced})`,
            suggestion: "Put the escrow somewhere that is not uploaded anywhere. A synced folder hands the file " +
                "to a third party, which turns the escrow's strength into the strength of the " +
                "passphrase alone against an attacker who can grind it offline.",
        };
    }
    const warnings = [];
    if (isInside(dir, canonicalPath(userSeshMoverDir()))) {
        warnings.push("The escrow is in ~/.sesh-mover, beside the identity file it copies. That is not a leak, " +
            "but it is not recovery either: anything that loses one loses both. An escrow earns its " +
            "keep on different media.");
    }
    return { ok: true, path, warnings };
}
// ---------------------------------------------------------------------------
// The record file.
// ---------------------------------------------------------------------------
function readRecord() {
    const p = escrowRecordPath();
    if (!existsSync(p))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(p, "utf-8"));
        if (!parsed || typeof parsed !== "object")
            return null;
        const r = parsed;
        if (typeof r.path !== "string" || typeof r.recipient !== "string")
            return null;
        return {
            schemaVersion: 1,
            path: r.path,
            recipient: r.recipient,
            createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
            workFactorLogN: typeof r.workFactorLogN === "number" ? r.workFactorLogN : AGE_SCRYPT_LOG_N,
        };
    }
    catch {
        // A pointer file, not a key. An unreadable one is "no record", which costs
        // a status line and never a recovery — the escrow FILE is untouched.
        return null;
    }
}
function writeRecord(r) {
    mkdirSync(userSeshMoverDir(), { recursive: true, mode: 0o700 });
    writeFileSync(escrowRecordPath(), JSON.stringify(r, null, 2) + "\n", {
        encoding: "utf-8",
        mode: 0o600,
    });
}
/**
 * A SHAPE check, not a validation: does the file at `p` begin like an age file
 * addressed to a passphrase, and what work factor does its stanza claim?
 *
 * It cannot tell whether the escrow still opens — that needs the passphrase,
 * which `status` deliberately does not collect. What it does catch is the
 * failure a user cannot see: the file was replaced, truncated, or is somebody
 * else's.
 */
function inspectEscrowFile(p) {
    if (!existsSync(p))
        return { present: false, looksLikeEscrow: false, logN: null };
    let head = "";
    try {
        const fd = openSync(p, "r");
        try {
            const buf = Buffer.alloc(256);
            const n = readSync(fd, buf, 0, buf.length, 0);
            head = buf.subarray(0, n).toString("utf-8");
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return { present: true, looksLikeEscrow: false, logN: null };
    }
    const m = /^age-encryption\.org\/v1\n-> scrypt \S+ (\d+)\n/.exec(head);
    if (!m)
        return { present: true, looksLikeEscrow: false, logN: null };
    return { present: true, looksLikeEscrow: true, logN: Number(m[1]) };
}
// ---------------------------------------------------------------------------
// The verb.
// ---------------------------------------------------------------------------
/**
 * The recovery invocation, spelled once so the CLI, the command doc and the
 * README cannot drift. It is deliberately an `age` command and not a
 * `sesh-mover` one: key loss and plugin loss must not be the same event, and a
 * recovery step that needs this plugin installed is a recovery step that fails
 * on a machine rebuilt from nothing.
 */
export function escrowRecoverySteps(escrowPath) {
    return [
        `age -d -i ${escrowPath} <bundle>.tar.gz.age > <bundle>.tar.gz   # read a bundle directly`,
        `age -d ${escrowPath} > ${identityFilePath()} && chmod 600 ${identityFilePath()}   # restore this machine's identity`,
    ];
}
function refuse(refusal, error, suggestion, extra = {}) {
    return {
        success: false,
        command: "hub-escrow",
        reason: "escrow-refused",
        refusal,
        error,
        suggestion,
        limits: [...ESCROW_DESTINATION_LIMITS],
        ...extra,
    };
}
/**
 * The warning that is not softened anywhere. It is returned on every enable AND
 * repeated in `commands/hub-escrow.md`, where the skill states it BEFORE the
 * command runs — a CLI can only warn after it has already acted.
 */
function enableWarnings(input) {
    const w = [
        "This passphrase unwraps this machine's identity, which unwraps every hub bundle addressed to " +
            "this machine — past and future — for anyone who learns it.",
        "A leak cannot be revoked. `hub rekey` re-addresses bundles to a new roster but never changes a " +
            "file key, so every bundle a leaked key could already read stays readable by it permanently. " +
            "There is no command in this plugin, and no command in age, that takes that back.",
        "RECOVERY ONLY. Restoring this escrow on a rebuilt machine restores THIS machine's own identity, " +
            "and no key moves anywhere. Using it to give a DIFFERENT machine access collapses two machines " +
            "into one identity and destroys per-machine revocation — for backfill use `hub rekey`, which " +
            "gives a machine access to history without moving a key.",
        "Nothing was uploaded and nothing on the hub changed. The escrow is a local file, and keeping it " +
            "safe is now entirely yours.",
    ];
    if (input.passphraseBytes < 12) {
        w.push("That passphrase is short. The work factor slows a guess by a fixed amount; it does not make a " +
            "short passphrase hard. Everything above is only as strong as what you typed.");
    }
    if (input.insecureMode) {
        w.push("The identity file this escrow copies is readable by group or other on this machine. Fix its " +
            "mode (0600) — the escrow is not the leak to worry about first.");
    }
    return w;
}
export async function hubEscrow(opts) {
    const record = readRecord();
    if (opts.action === "status") {
        const identity = readIdentityFile();
        const file = record ? inspectEscrowFile(record.path) : null;
        const warnings = [];
        if (record && file && !file.present) {
            warnings.push("The escrow file recorded here is not at that path any more. Either you moved it — which is " +
                "fine, and this record is now just stale — or it is gone, in which case there is no escrow.");
        }
        if (record && file?.present && !file.looksLikeEscrow) {
            warnings.push("There is a file at the recorded path, but it does not begin like a passphrase-addressed age " +
                "file. This is a shape check only; it cannot tell you whether an escrow still opens.");
        }
        if (record && identity.state === "present" && identity.recipient !== record.recipient) {
            warnings.push("This escrow is for a key this machine no longer has. Restoring it would restore the OLD " +
                "identity, not the current one. Make a new escrow if you still want one.");
        }
        return {
            success: true,
            command: "hub-escrow",
            action: "status",
            enabled: record !== null,
            escrowPath: record?.path ?? null,
            recipient: record?.recipient ?? null,
            createdAt: record?.createdAt || null,
            filePresent: file?.present ?? false,
            fileLooksLikeEscrow: file?.looksLikeEscrow ?? false,
            current: record === null || identity.state !== "present"
                ? null
                : identity.recipient === record.recipient,
            workFactorLogN: file?.logN ?? record?.workFactorLogN ?? null,
            recovery: record ? escrowRecoverySteps(record.path) : [],
            warnings,
            limits: [...ESCROW_DESTINATION_LIMITS],
        };
    }
    if (opts.action === "disable") {
        if (!record) {
            return refuse("not-enabled", "No escrow is recorded on this machine.", "There is nothing to turn off. `hub escrow` with no flags reports the current state.");
        }
        try {
            rmSync(escrowRecordPath(), { force: true });
        }
        catch (e) {
            return refuse("not-enabled", `Could not remove the escrow record: ${errorMessage(e)}`, "Remove ~/.sesh-mover/escrow.json by hand. It is a pointer, not a key.");
        }
        return {
            success: true,
            command: "hub-escrow",
            action: "disabled",
            enabled: false,
            escrowPath: record.path,
            recipient: record.recipient,
            createdAt: record.createdAt || null,
            filePresent: existsSync(record.path),
            fileLooksLikeEscrow: false,
            current: null,
            workFactorLogN: null,
            // Still spelled out: the file is still there and still works, which is
            // exactly what the warning below says.
            recovery: escrowRecoverySteps(record.path),
            warnings: [
                // Deleting a file at a path the USER named is not ours to do: the path
                // was recorded once and the file there now may not be the one we wrote.
                "This forgot the record. It did NOT delete the escrow file, which is still at the path " +
                    "reported here and still unwraps this machine's identity for anyone with the passphrase. " +
                    "Deleting it is yours to do, deliberately.",
            ],
            limits: [...ESCROW_DESTINATION_LIMITS],
        };
    }
    // ---- enable ----
    if (opts.passphrase.kind === "not-requested") {
        return refuse("passphrase", "Enabling the escrow needs a passphrase, and the only way to supply one is --passphrase-stdin.", "Run this in YOUR OWN SHELL, never in a chat session:\n" +
            "  read -rs SESH_ESCROW && printf '%s' \"$SESH_ESCROW\" | " +
            "sesh-mover hub escrow --enable --passphrase-stdin --out <path>\n" +
            "There is no flag and no config key for it: a flag lands in shell history, a config file " +
            "sits in plaintext beside what it protects, and an environment variable leaks through " +
            "/proc and is inherited by every subprocess this plugin spawns, including git.");
    }
    if (opts.passphrase.kind === "terminal") {
        return refuse("passphrase", "Standard input is a terminal, so reading the passphrase would echo it.", "Pipe it instead:\n" +
            "  read -rs SESH_ESCROW && printf '%s' \"$SESH_ESCROW\" | " +
            "sesh-mover hub escrow --enable --passphrase-stdin --out <path>");
    }
    const passphrase = opts.passphrase.bytes;
    if (passphrase.length === 0) {
        return refuse("passphrase", "The passphrase was empty.", "An empty passphrase is not a weak escrow, it is a public one: every age implementation " +
            "would open the file. Nothing was written.");
    }
    if (passphrase.includes(0x0a) || passphrase.includes(0x0d)) {
        return refuse("passphrase", "The passphrase contains a line break.", "age reads a passphrase as a single line from the terminal, so a passphrase with a line " +
            "break in it could never be typed back in — the escrow would be unrecoverable by the " +
            "standard tool, which is the only tool recovery has. One trailing newline is stripped for " +
            "you; a line break in the middle is refused.");
    }
    if (!opts.outPath) {
        return refuse("no-out", "--out is required: the escrow is written to a path you name.", "There is no default. A default would put a passphrase-wrapped private key somewhere the " +
            "user did not choose, and the whole point of the escrow is that it lives somewhere the " +
            "machine's own disk failure does not reach.");
    }
    const identity = readIdentityFile();
    if (identity.state !== "present") {
        return refuse("no-identity", identity.state === "absent"
            ? "This machine has no identity to escrow yet."
            : `This machine's identity file cannot be read (${identity.cause}): ${identity.detail}`, identity.state === "absent"
            ? "An identity is minted the first time this machine registers on a hub. Run " +
                "`sesh-mover hub init` or one push or pull, then escrow it."
            : "Fix the identity file first. Escrowing is a copy — copying an unreadable key produces " +
                "an unreadable escrow, and nothing here overwrites or replaces the file.");
    }
    const dest = checkEscrowDestination(opts.outPath, { cwd: opts.cwd, hubPath: opts.hubPath });
    if (!dest.ok) {
        return refuse("unsafe-out", `Refusing to write the escrow there: ${dest.detail}.`, dest.suggestion, {
            unsafeOut: { rule: dest.rule, path: dest.path },
        });
    }
    const logN = opts.logN ?? AGE_SCRYPT_LOG_N;
    try {
        await pipeline(Readable.from([Buffer.from(identity.raw, "utf-8")]), new AgeEncryptStream({ passphrase, logN }), 
        // `wx` closes the gap between the existence check above and this write.
        // 0600 for the same reason the identity file has it: this is that file.
        createWriteStream(dest.path, { flags: "wx", mode: 0o600 }));
    }
    catch (e) {
        return {
            success: false,
            command: "hub-escrow",
            reason: "escrow-verify-failed",
            error: `The escrow could not be written: ${errorMessage(e)}`,
            suggestion: "Nothing usable was left behind. Fix the cause and run it again.",
            limits: [...ESCROW_DESTINATION_LIMITS],
        };
    }
    // Read it back, through the real reader, and compare. This catches a
    // truncated write, a wrong file, an unwritable disk that lied — and it does
    // NOT catch a defect symmetric in this module's own code, because a
    // self-round-trip is exactly what such a defect survives. That is what the
    // differential test against the real `age` binary is for, and this check is
    // not a substitute for it.
    try {
        const chunks = [];
        await pipeline(Readable.from([readFileSync(dest.path)]), new AgeDecryptStream({ passphrase }), async function* (source) {
            for await (const c of source)
                chunks.push(c);
        });
        if (Buffer.concat(chunks).toString("utf-8") !== identity.raw) {
            throw new AgeError("payload-authentication-failed", "the escrow did not read back identically");
        }
    }
    catch (e) {
        try {
            unlinkSync(dest.path);
        }
        catch {
            /* Reported below either way; the file is unusable, not dangerous. */
        }
        return {
            success: false,
            command: "hub-escrow",
            reason: "escrow-verify-failed",
            error: `The escrow was written but did not read back: ${errorMessage(e)}`,
            suggestion: "The file was removed. This is the failure mode worth catching now rather than during a " +
                "recovery: an escrow that does not open reaches you as \"my passphrase doesn't work\", " +
                "at the one moment there is no other copy of the key.",
            limits: [...ESCROW_DESTINATION_LIMITS],
        };
    }
    const createdAt = new Date().toISOString();
    const warnings = enableWarnings({
        passphraseBytes: passphrase.length,
        insecureMode: identity.insecureMode,
    });
    warnings.push(...dest.warnings);
    try {
        writeRecord({
            schemaVersion: 1,
            path: dest.path,
            recipient: identity.recipient,
            createdAt,
            workFactorLogN: logN,
        });
    }
    catch (e) {
        // The escrow itself is written and valid; only the bookkeeping failed. That
        // must not be reported as a failed escrow — the file the user needs exists.
        warnings.push(`The escrow was written and verified, but the record of it could not be saved ` +
            `(${errorMessage(e)}). \`hub escrow\` will report "not enabled" until that is fixed; ` +
            `the escrow file itself is fine and is at the path reported here.`);
    }
    return {
        success: true,
        command: "hub-escrow",
        action: "enabled",
        enabled: true,
        escrowPath: dest.path,
        recipient: identity.recipient,
        createdAt,
        filePresent: true,
        fileLooksLikeEscrow: true,
        current: true,
        workFactorLogN: logN,
        recovery: escrowRecoverySteps(dest.path),
        warnings,
        limits: [...ESCROW_DESTINATION_LIMITS],
    };
}
//# sourceMappingURL=escrow.js.map