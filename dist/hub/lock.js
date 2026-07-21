import { mkdirSync, openSync, closeSync, writeSync, rmSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeProjectPath } from "../platform.js";
export const LOCK_STALE_MS = 10 * 60 * 1000;
export class LockBusyError extends Error {
    holderPid;
    ageMs;
    constructor(holderPid, ageMs) {
        super(`another sesh-mover hub operation holds the project lock` +
            (holderPid ? ` (pid ${holderPid}${ageMs !== null ? `, ${Math.round(ageMs / 1000)}s old` : ""})` : ""));
        this.holderPid = holderPid;
        this.ageMs = ageMs;
    }
}
function lockPath(projectPath) {
    return join(homedir(), ".claude-sesh-mover", "locks", `${encodeProjectPath(projectPath)}.lock`);
}
// Cross-platform advisory lock for hub operations on a given project. Uses
// exclusive-create ("wx") for atomicity: two processes racing to create the
// same lock file can never both succeed, unlike a check-then-write pair.
// Locks older than LOCK_STALE_MS are stolen — a crashed/killed process
// (SIGKILL, power loss) never runs its release(), so without a steal path a
// dead holder would wedge the project's hub operations forever.
export function acquireProjectLock(projectPath) {
    const p = lockPath(projectPath);
    mkdirSync(join(homedir(), ".claude-sesh-mover", "locks"), { recursive: true });
    const tryAcquire = () => {
        try {
            return openSync(p, "wx"); // atomic create-if-absent
        }
        catch {
            return null;
        }
    };
    let stoleStale = false;
    let fd = tryAcquire();
    if (fd === null) {
        let holderPid = null;
        let ageMs = null;
        try {
            const parsed = JSON.parse(readFileSync(p, "utf-8"));
            holderPid = parsed.pid ?? null;
            if (parsed.acquiredAt)
                ageMs = Date.now() - Date.parse(parsed.acquiredAt);
        }
        catch {
            try {
                ageMs = Date.now() - statSync(p).mtimeMs;
            }
            catch {
                /* vanished between the failed open and this read — treat as busy, not stale */
            }
        }
        if (ageMs !== null && ageMs > LOCK_STALE_MS) {
            rmSync(p, { force: true }); // stale — steal
            stoleStale = true;
            fd = tryAcquire();
        }
        if (fd === null)
            throw new LockBusyError(holderPid, ageMs);
    }
    writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    closeSync(fd);
    return {
        stoleStale,
        release() {
            rmSync(p, { force: true });
        },
    };
}
//# sourceMappingURL=lock.js.map