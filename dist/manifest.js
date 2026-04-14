"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeManifest = writeManifest;
exports.readManifest = readManifest;
exports.computeIntegrityHash = computeIntegrityHash;
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
    return JSON.parse(raw);
}
function computeIntegrityHash(contents) {
    const hash = (0, node_crypto_1.createHash)("sha256");
    for (const content of contents) {
        hash.update(content);
    }
    return `sha256:${hash.digest("hex")}`;
}
function verifyIntegrity(contents, expectedHash) {
    const actual = computeIntegrityHash(contents);
    return actual === expectedHash;
}
//# sourceMappingURL=manifest.js.map