// sesh-mover core library exports
// NOTE: decodeProjectPath intentionally not provided — encoding is lossy for hyphenated paths.
// Use readProjectPathFromJsonl in discovery.ts or read cwd from JSONL entries instead.
export * from "./types.js";
export * from "./version.js";
export * from "./platform.js";
export * from "./paths.js";
export * from "./config.js";
export * from "./manifest.js";
export * from "./discovery.js";
export * from "./jsonl.js";
export * from "./summary.js";
export * from "./continuation.js";
export * from "./rewriter.js";
export * from "./archiver.js";
export * from "./version-adapters.js";
export * from "./progress.js";
export * from "./sidecar.js";
export * from "./memory-index.js";
export * from "./exporter.js";
export * from "./importer.js";
export * from "./migrator.js";
export * from "./machine.js";
export * from "./sync-state.js";
export * from "./hub/backend.js";
export * from "./hub/layout.js";
export * from "./hub/machines.js";
export * from "./hub/encryption.js";
// The plaintext/ciphertext seam and the verb that flips the hub-wide switch.
export * from "./hub/bundle-io.js";
export * from "./hub/encrypt.js";
export * from "./hub/identity.js";
export * from "./hub/threads.js";
export * from "./hub/index-file.js";
// The transport-independent payload layer (#47). `hub/` is a CONSUMER of these,
// alongside `exporter`/`importer` — they name a project directory and a
// destination directory and know nothing about a hub.
export * from "./payload/workspace.js";
export * from "./payload/carry.js";
export * from "./payload/git-scan.js";
export * from "./payload/capture.js";
export * from "./hub/merge.js";
export * from "./hub/lock.js";
export * from "./hub/append.js";
export * from "./hub/init.js";
export * from "./hub/status.js";
export * from "./hub/push.js";
export * from "./hub/whereis.js";
export * from "./hub/pull.js";
export * from "./hub/reindex.js";
export * from "./hub/rekey.js";
export * from "./hub/unlink.js";
export * from "./hub/tombstone.js";
export * from "./hub/retire.js";
export * from "./hub/hooks.js";
