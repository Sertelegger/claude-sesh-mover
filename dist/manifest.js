"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeManifest = writeManifest;
exports.readManifest = readManifest;
exports.isSafeSessionId = isSafeSessionId;
exports.assertSafeManifestIds = assertSafeManifestIds;
exports.computeIntegrityHash = computeIntegrityHash;
exports.computeIntegrityHashFromFile = computeIntegrityHashFromFile;
exports.verifyIntegrity = verifyIntegrity;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
function writeManifest(exportDir, manifest) {
    const manifestPath = (0, node_path_1.join)(exportDir, "manifest.json");
    (0, node_fs_1.writeFileSync)(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}
function readManifest(exportDir) {
    const manifestPath = (0, node_path_1.join)(exportDir, "manifest.json");
    if (!(0, node_fs_1.existsSync)(manifestPath)) {
        throw new Error(`No manifest.json found in ${exportDir}`);
    }
    const raw = (0, node_fs_1.readFileSync)(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);
    assertSafeManifestIds(manifest);
    return manifest;
}
// A session id is safe iff it is a non-empty string with no path separators,
// no NUL byte, and isn't "." or "..". Real Claude session ids are UUIDs, so
// this accepts them while rejecting anything path-traversal-shaped. Any value
// containing "/" or "\" already covers "../" and "..\" segments — the bare
// "."/".." checks cover the separator-less forms.
function isSafeSessionId(id) {
    if (typeof id !== "string" || id.length === 0)
        return false;
    if (id.includes("/") || id.includes("\\") || id.includes("\0"))
        return false;
    if (id === "." || id === "..")
        return false;
    return true;
}
// Single chokepoint: every manifest read that will later be used to build a
// filesystem path (session JSONL, subagents dir, tool-results dir, etc.)
// must run through this before the manifest is trusted. Guards
// session.sessionId and both continuation-linkage ids, since all three get
// interpolated into join() calls downstream (importer.ts, sync-state.ts).
function assertSafeManifestIds(manifest) {
    for (const s of manifest.sessions) {
        const ids = [
            s.sessionId,
            s.continuation?.continuesLocalSessionId,
            s.continuation?.continuesPeerSessionId,
        ];
        for (const id of ids) {
            if (id !== undefined && !isSafeSessionId(id)) {
                throw new Error(`Unsafe session id in manifest: ${JSON.stringify(id)} (path separators and ".." are not allowed)`);
            }
        }
    }
}
function computeIntegrityHash(contents) {
    const hash = (0, node_crypto_1.createHash)("sha256");
    for (const content of contents) {
        hash.update(content);
    }
    return `sha256:${hash.digest("hex")}`;
}
// Streaming twin of computeIntegrityHash: sha256 over raw file bytes.
// For valid UTF-8 files (all session JSONL) this yields the same digest as
// computeIntegrityHash([readFileSync(path, "utf-8")]) — hash.update(string)
// encodes utf-8 — so manifests from pre-streaming exports keep verifying.
async function computeIntegrityHashFromFile(path) {
    const hash = (0, node_crypto_1.createHash)("sha256");
    for await (const chunk of (0, node_fs_1.createReadStream)(path)) {
        hash.update(chunk);
    }
    return `sha256:${hash.digest("hex")}`;
}
function verifyIntegrity(contents, expectedHash) {
    const actual = computeIntegrityHash(contents);
    return actual === expectedHash;
}
//# sourceMappingURL=manifest.js.map