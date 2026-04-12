// sesh-mover core library exports
// NOTE: decodeProjectPath intentionally not provided — encoding is lossy for hyphenated paths.
// Use readProjectPathFromJsonl in discovery.ts or read cwd from JSONL entries instead.
export * from "./types.js";
export * from "./platform.js";
export * from "./config.js";
export * from "./manifest.js";
export * from "./discovery.js";
export * from "./summary.js";
export * from "./rewriter.js";
export * from "./archiver.js";
export * from "./version-adapters.js";
export * from "./exporter.js";
export * from "./importer.js";
export * from "./migrator.js";
