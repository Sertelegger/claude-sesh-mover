import { closeSync, fchmodSync, fstatSync, lstatSync, openSync, readSync, unlinkSync, writeSync, } from "node:fs";
/**
 * Bounded so a directory already full of parked copies cannot spin. Shared by
 * both callers, so a message quoting the number cannot drift from the loop.
 */
export const MAX_SIDECAR_ATTEMPTS = 100;
/** Read/write chunk for `copyToNewFile`. Bounded so a big payload file is not held whole in memory. */
const COPY_CHUNK_BYTES = 64 * 1024;
/**
 * Is the FINAL component of `dstPath` a symlink — dangling or not?
 *
 * `lstatSync`, so the link is never followed; a failure (nothing there,
 * `EACCES` on the parent) answers "no" and leaves the verdict to the exclusive
 * create, which is the authority for every OTHER way a name can be taken.
 *
 * It deliberately asks about a LINK and not about occupancy in general. A name
 * held by a real file or a directory is the exclusive create's job — asking
 * here as well would move that decision back in front of the write, which is
 * the check-then-write #64 removed, and (measured) would mask its loss: with
 * an occupancy pre-check in place, deleting the `x` from the create leaves
 * every test in both suites green.
 */
function isSymbolicLinkPath(dstPath) {
    try {
        return lstatSync(dstPath).isSymbolicLink();
    }
    catch {
        return false;
    }
}
/** The `EEXIST` every caller keys on, for the refusals this module decides itself. */
function nameTakenError(dstPath) {
    const err = new Error(`EEXIST: file already exists, open '${dstPath}'`);
    err.code = "EEXIST";
    err.syscall = "open";
    err.path = dstPath;
    return err;
}
/**
 * Copy `srcPath`'s bytes to `dstPath`, **which must not already exist** — a
 * name anything else occupies raises `EEXIST` and nothing is written, and
 * "anything" includes a symlink whose target does not exist.
 *
 * ## Why this is not `copyFileSync(..., COPYFILE_EXCL)` (#68)
 *
 * On POSIX that flag IS `open(O_CREAT|O_EXCL)`, which the kernel refuses on a
 * symlink at the destination, live or dangling — the write is the check, and
 * that is all #64 needed. On Windows it is `CopyFileW(src, dst, bFailIfExists)`
 * (libuv `fs__copyfile`), which resolves a reparse point at the destination and
 * therefore asks its "already exists?" question about the LINK'S TARGET. A
 * dangling link answers "no" and the payload lands at the far end of it,
 * outside the directory the caller meant to write into. MEASURED: the three
 * planted-symlink tests over `copyIfAbsent` are green on Linux and macOS and
 * were red on `windows-latest`, with the bundle's file sitting in the escape
 * directory.
 *
 * ## Why the exclusive open is not, by itself, the fix
 *
 * It is tempting to read that failure as "wrong spelling of exclusive create"
 * and just switch to `openSync(dst, "wx")`. **That is not a fix on Windows**,
 * and shipping it as one would be the worst available outcome: a green POSIX
 * suite over a live hole. The sources, all primary:
 *
 * - libuv `src/win/fs.c` (v1.x): `fs__open` maps `O_CREAT|O_EXCL` to
 *   `CreateFileW(..., CREATE_NEW, ...)` and passes NO
 *   `FILE_FLAG_OPEN_REPARSE_POINT` — the flag that makes a create refuse a
 *   reparse point instead of resolving it. It appears six times in that file,
 *   never inside `fs__open`.
 * - That exact omission is **CVE-2025-0913** (Go issue #73702): on Windows
 *   `O_CREATE|O_EXCL` "creates a file in the location referenced by the link".
 *   Go fixed it by adding `FILE_FLAG_OPEN_REPARSE_POINT` (commit adcad7b);
 *   Rust sets the same flag for `create_new` (RFC 1252: "nothing is allowed to
 *   exist on the target location, also no (dangling) symlink").
 * - **libuv never took that fix.** Node's `wx` on Windows has the pre-CVE
 *   behaviour, and Node exposes no way to ask for the flag — there is no
 *   `O_NOFOLLOW` on Windows either. This cannot be fixed by spelling.
 *
 * The same page that documents the copy's behaviour makes the pair explicit:
 * with `COPY_FILE_FAIL_IF_EXISTS` and no `COPY_FILE_COPY_SYMLINK`, the copy
 * "fails only if the target of the symbolic link exists".
 *
 * ## What actually guards this write, in order
 *
 * 1. **`lstat` says the name is not a symlink** (`isSymbolicLinkPath`).
 *    Platform-independent, and on Windows it is the LOAD-BEARING half: a link
 *    planted before the run — every case anyone has actually hit — is refused
 *    here, and nothing is created anywhere. It asks ONLY about a link, so the
 *    exclusive create below stays the authority on every other kind of
 *    collision, and stays mutation-visible.
 * 2. **The create is exclusive** (`wx`). On POSIX this is the whole guard and
 *    step 1 is redundant: the kernel refuses the link atomically, so no window
 *    exists between the check and the write. #64's rule is intact where the
 *    platform can honour it, and this is still what refuses a name held by a
 *    real file or a directory on either platform.
 * 3. **The name we opened is verified not to be a link**, BEFORE a single
 *    payload byte is written. On Windows that catches a link planted inside
 *    step 1's window: the create is redirected, we notice, and we refuse. What
 *    it leaves behind in that (race-only) case is a ZERO-byte file at the
 *    target; it is deliberately not cleaned up, because deleting a path an
 *    attacker chose is a worse primitive than creating an empty file there.
 *
 * **The two platforms are NOT equivalent here, and saying they were would be
 * worse than the gap itself.** On POSIX the kernel decides, atomically, and
 * there is no window. On Windows this is a check-then-write: between step 1's
 * `lstat` and step 2's create, a link planted in that window is followed, and
 * step 3 then reduces the damage from "the payload lands outside the directory"
 * to "an empty file does". Closing it needs the create Go and Rust use and
 * libuv does not expose. That is the state of the art from Node today, not a
 * shortcut taken here.
 *
 * ## Behaviour it preserves from the copy it replaces
 *
 * **The source's mode is carried over**, by `fchmod` on the descriptor we just
 * created rather than by a `chmod` on the path (nothing can be swapped in
 * underneath a descriptor). That is what `copyFileSync` does, MEASURED — a 0664
 * source lands 0664 even under a umask that would have stripped the group bit,
 * so libuv is setting the mode after creating the file rather than letting
 * `open` do it — and `merge.ts` relies on that to hand a merged file back its
 * own mode. A plain `open` would instead produce `0666 & ~umask`, which
 * silently drops an executable bit on a parked copy of a script and would have
 * been an invisible behaviour change riding along with a security fix.
 *
 * What it does NOT reproduce, none of it load-bearing for these callers: the
 * copy is a read/write pump rather than `copy_file_range`, so a sparse source
 * lands fully allocated, and (as with `copyFileSync`) timestamps do not travel.
 *
 * Errors are the caller's to interpret: `EEXIST` means the name is taken (the
 * answer every caller acts on), and anything else propagates. A destination
 * created and then failed part-way through is removed, so a partial file never
 * survives as a "successful" copy.
 */
export function copyToNewFile(srcPath, dstPath) {
    // Source first, so a missing/unreadable source raises exactly what the copy
    // used to raise and leaves NO file at the destination.
    const src = openSync(srcPath, "r");
    try {
        if (isSymbolicLinkPath(dstPath))
            throw nameTakenError(dstPath);
        const dst = openSync(dstPath, "wx");
        /** Set once we know the file we hold is the NAME we asked for (guard 3). */
        let ourFileIsAtDstPath = false;
        let complete = false;
        try {
            // Guard 3, before any byte is written: on Windows the create above can be
            // redirected through a link planted since guard 1, and the only evidence
            // is that the name still lstats as a symlink.
            if (isSymbolicLinkPath(dstPath))
                throw nameTakenError(dstPath);
            ourFileIsAtDstPath = true;
            const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
            for (;;) {
                const read = readSync(src, buf, 0, buf.length, null);
                if (read <= 0)
                    break;
                let written = 0;
                while (written < read)
                    written += writeSync(dst, buf, written, read - written);
            }
            // `0o777`, so the permission bits travel and the setuid/setgid/sticky
            // bits never do — `copyFileSync` hands libuv the whole `st_mode`, and a
            // payload another machine built is the last thing that should be able to
            // plant a setuid bit here. Narrower than what it replaces, never wider.
            try {
                fchmodSync(dst, fstatSync(src).mode & 0o777);
            }
            catch (e) {
                // `EPERM` only: `fchmod` on a CIFS share fails EPERM unless the share
                // is mounted `noperm`, and failing a copy whose BYTES are already on
                // disk over a metadata call is the wrong trade — the mode is a
                // fidelity nicety here, the content is the point. Anything else is a
                // real failure of the write and still aborts (and unlinks).
                if (e.code !== "EPERM")
                    throw e;
            }
            complete = true;
        }
        finally {
            closeSync(dst);
            // Only ever the file WE created at the name we asked for. In the
            // redirected case `dstPath` is someone else's link, and unlinking it
            // would be us deleting it.
            if (ourFileIsAtDstPath && !complete) {
                try {
                    unlinkSync(dstPath);
                }
                catch { /* best effort */ }
            }
        }
    }
    finally {
        closeSync(src);
    }
}
/**
 * Copy `srcPath` to the first name `nameFor` yields that does not already
 * exist, and return that name — or `null` when every attempt collided.
 *
 * **This is the one copy of the park-without-overwriting rule.** Two places
 * park an incoming file beside a local one they refuse to overwrite:
 * `writeSidecar` in `src/hub/merge.ts` (workspace merge, `<name>.theirs-<stamp>`)
 * and the memory step in `src/importer.ts` (`<stem>.incoming.md`). The two
 * *names* diverge deliberately — a parked memory must end in `.md` or it is not
 * read as a memory at all, and it is user-facing and transient rather than
 * archaeological; each site carries a comment pointing at the other. The
 * *technique* must not diverge: the existence check and the write have to be
 * one atomic step (`copyToNewFile`'s exclusive create), or a second unresolved
 * transfer, or a user file that happens to match, is silently overwritten — the
 * exact defect a check-then-write would reintroduce on each new caller.
 *
 * `EEXIST` is this loop's "try the next name" signal, so the write underneath
 * has to raise it for every occupied name on every platform — including a name
 * held by a dangling symlink, which is why it is an exclusive `open` and not
 * `COPYFILE_EXCL` (see `copyToNewFile`).
 *
 * `resolve` maps a candidate name to the path to write, so a caller can keep
 * returning the name it wants back (a bundle-relative path, a bare filename)
 * while the loop stays identical.
 */
export function copyToUniqueName(srcPath, nameFor, resolve, maxAttempts = MAX_SIDECAR_ATTEMPTS) {
    for (let n = 0; n < maxAttempts; n++) {
        const name = nameFor(n);
        try {
            copyToNewFile(srcPath, resolve(name));
            return name;
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
        }
    }
    return null;
}
//# sourceMappingURL=sidecar.js.map