import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, renameSync, writeFileSync, readFileSync, statSync, } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { finished } from "node:stream/promises";
import { assertHubRelPath } from "./layout.js";
export function createFsBackend(rootDir) {
    const abs = (relPath) => {
        assertHubRelPath(relPath);
        return join(rootDir, ...relPath.split("/"));
    };
    return {
        async read(relPath) {
            return readFileSync(abs(relPath));
        },
        async writeAtomic(relPath, data) {
            const target = abs(relPath);
            mkdirSync(dirname(target), { recursive: true });
            const tmp = `${target}.tmp-${randomUUID()}`;
            writeFileSync(tmp, data);
            renameSync(tmp, target);
        },
        async list(relPrefix) {
            assertHubRelPath(relPrefix);
            const root = join(rootDir, ...relPrefix.split("/"));
            if (!existsSync(root))
                return [];
            const out = [];
            const walk = (dir, rel) => {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    const childRel = `${rel}/${entry.name}`;
                    if (entry.isDirectory())
                        walk(join(dir, entry.name), childRel);
                    else if (entry.isFile() && !entry.name.includes(".tmp-"))
                        out.push(childRel);
                }
            };
            if (!statSync(root).isDirectory())
                return [relPrefix];
            walk(root, relPrefix);
            return out;
        },
        async exists(relPath) {
            return existsSync(abs(relPath));
        },
        async delete(relPath) {
            rmSync(abs(relPath), { force: true });
        },
        async readStream(relPath) {
            return createReadStream(abs(relPath));
        },
        async writeStreamAtomic(relPath) {
            const target = abs(relPath);
            mkdirSync(dirname(target), { recursive: true });
            const tmp = `${target}.tmp-${randomUUID()}`;
            const stream = createWriteStream(tmp);
            // A stream error occurring before commit()/abort() is called would
            // otherwise be an unhandled 'error' event with zero listeners
            // attached, which crashes the process outright (same hazard as
            // rewriter.ts's rewriteJsonlStream). Latch it here immediately so
            // commit() can surface it as a rejection instead.
            let streamError = null;
            stream.once("error", (err) => {
                streamError = err;
            });
            return {
                stream,
                async commit() {
                    // On any failure, remove the temp file before rethrowing — a
                    // caller that awaited commit() won't also call abort(), so this
                    // is the only chance to avoid orphaning the temp.
                    try {
                        if (streamError)
                            throw streamError;
                        if (!stream.writableEnded)
                            stream.end();
                        await finished(stream);
                        if (streamError)
                            throw streamError;
                        renameSync(tmp, target);
                    }
                    catch (err) {
                        rmSync(tmp, { force: true });
                        throw err;
                    }
                },
                async abort() {
                    // WAIT FOR THE FD TO CLOSE BEFORE UNLINKING. `createWriteStream`
                    // opens its fd asynchronously and `destroy()` on a still-pending open
                    // is DEFERRED until that open completes — so a bare
                    // `destroy(); rmSync(tmp)` pair unlinks a path the file has not
                    // reached yet, and the open then creates it. Measured on Linux (not a
                    // Windows-only EBUSY race, which is what this was filed as), 5/5
                    // runs: the bundle directory reads empty the instant `abort()`
                    // returns and holds a full-size `<name>.tmp-<uuid>` 100ms later.
                    // Nothing ever reaps it — `list()` filters `.tmp-` out, so it is
                    // invisible to `hub status`, to `reindex` and to the user, while
                    // whatever syncs the hub replicates it to every machine.
                    //
                    // `finished` rejects with ERR_STREAM_PREMATURE_CLOSE on a destroyed
                    // stream; here that is the expected path, not a failure.
                    stream.destroy();
                    await finished(stream).catch(() => { });
                    // NOTHING IN abort() MAY THROW, and awaiting real I/O above is
                    // precisely what makes that worth stating. Its callers run it from a
                    // catch block (`hub/push.ts`: `await w.abort(); throw e;`), where a
                    // rejection REPLACES the pipeline's real failure — and push's failure
                    // is the payload of its own disclosure machinery, so `ENOSPC: no
                    // space left on device` would be recorded in the durable auto-push
                    // breadcrumb as an unlink error. An orphaned temp file is the lesser
                    // of those two; `rmSync(force)` swallows ENOENT but not EPERM/EBUSY.
                    try {
                        rmSync(tmp, { force: true });
                    }
                    catch {
                        /* best effort — see above; a stale temp beats a masked error */
                    }
                },
            };
        },
    };
}
//# sourceMappingURL=backend.js.map