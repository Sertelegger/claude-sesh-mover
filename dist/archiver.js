"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createArchive = createArchive;
exports.extractArchive = extractArchive;
exports.detectArchiveFormat = detectArchiveFormat;
exports.isZstdAvailable = isZstdAvailable;
const node_fs_1 = require("node:fs");
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
const tar = __importStar(require("tar"));
async function createArchive(sourceDir, archivePath, compression) {
    if (compression === "zstd") {
        await createZstdArchive(sourceDir, archivePath);
    }
    else {
        await tar.create({
            gzip: true,
            file: archivePath,
            cwd: (0, node_path_1.dirname)(sourceDir),
        }, [(0, node_path_1.basename)(sourceDir)]);
    }
}
async function extractArchive(archivePath, targetDir) {
    const format = detectArchiveFormat(archivePath);
    if (format === "zstd") {
        await extractZstdArchive(archivePath, targetDir);
    }
    else {
        await tar.extract({
            file: archivePath,
            cwd: targetDir,
            strip: 1, // strip the top-level directory
        });
    }
    // Path traversal protection: verify all extracted files are within targetDir
    validateExtractedPaths(targetDir);
}
function validateExtractedPaths(dir) {
    const resolvedDir = (0, node_path_1.resolve)(dir);
    const entries = (0, node_fs_1.readdirSync)(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
        const fullPath = (0, node_path_1.resolve)(entry.parentPath ?? entry.path ?? dir, entry.name);
        if (!fullPath.startsWith(resolvedDir)) {
            throw new Error(`Path traversal detected: ${fullPath} is outside ${resolvedDir}`);
        }
    }
}
function detectArchiveFormat(filePath) {
    if (filePath.endsWith(".tar.gz") || filePath.endsWith(".tgz")) {
        return "gzip";
    }
    if (filePath.endsWith(".tar.zst") || filePath.endsWith(".tar.zstd")) {
        return "zstd";
    }
    return null;
}
async function isZstdAvailable() {
    try {
        (0, node_child_process_1.execFileSync)("zstd", ["--version"], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
async function createZstdArchive(sourceDir, archivePath) {
    // Create tar first, then pipe through zstd
    const tarPath = archivePath.replace(/\.zst$/, "");
    await tar.create({
        file: tarPath,
        cwd: (0, node_path_1.dirname)(sourceDir),
    }, [(0, node_path_1.basename)(sourceDir)]);
    try {
        // Use execFileSync to avoid shell injection
        (0, node_child_process_1.execFileSync)("zstd", ["-f", tarPath, "-o", archivePath], { stdio: "ignore" });
    }
    finally {
        if ((0, node_fs_1.existsSync)(tarPath))
            (0, node_fs_1.unlinkSync)(tarPath);
    }
}
async function extractZstdArchive(archivePath, targetDir) {
    const tarPath = archivePath.replace(/\.zst$/, ".tar");
    try {
        // Use execFileSync to avoid shell injection
        (0, node_child_process_1.execFileSync)("zstd", ["-d", archivePath, "-o", tarPath], { stdio: "ignore" });
        await tar.extract({
            file: tarPath,
            cwd: targetDir,
            strip: 1,
        });
    }
    finally {
        if ((0, node_fs_1.existsSync)(tarPath))
            (0, node_fs_1.unlinkSync)(tarPath);
    }
}
//# sourceMappingURL=archiver.js.map