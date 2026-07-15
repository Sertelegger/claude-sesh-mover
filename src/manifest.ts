import { readFileSync, writeFileSync, existsSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExportManifest } from "./types.js";

export function writeManifest(
  exportDir: string,
  manifest: ExportManifest
): void {
  const manifestPath = join(exportDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

export function readManifest(exportDir: string): ExportManifest {
  const manifestPath = join(exportDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json found in ${exportDir}`);
  }
  const raw = readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as ExportManifest;
  assertSafeManifestIds(manifest);
  return manifest;
}

// A session id is safe iff it is a non-empty string with no path separators,
// no NUL byte, and isn't "." or "..". Real Claude session ids are UUIDs, so
// this accepts them while rejecting anything path-traversal-shaped. Any value
// containing "/" or "\" already covers "../" and "..\" segments — the bare
// "."/".." checks cover the separator-less forms.
export function isSafeSessionId(id: unknown): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  if (id === "." || id === "..") return false;
  return true;
}

// Single chokepoint: every manifest read that will later be used to build a
// filesystem path (session JSONL, subagents dir, tool-results dir, etc.)
// must run through this before the manifest is trusted. Guards
// session.sessionId and both continuation-linkage ids, since all three get
// interpolated into join() calls downstream (importer.ts, sync-state.ts).
export function assertSafeManifestIds(manifest: ExportManifest): void {
  for (const s of manifest.sessions) {
    const ids = [
      s.sessionId,
      s.continuation?.continuesLocalSessionId,
      s.continuation?.continuesPeerSessionId,
    ];
    for (const id of ids) {
      if (id !== undefined && !isSafeSessionId(id)) {
        throw new Error(
          `Unsafe session id in manifest: ${JSON.stringify(id)} (path separators and ".." are not allowed)`
        );
      }
    }
  }
}

export function computeIntegrityHash(contents: string[]): string {
  const hash = createHash("sha256");
  for (const content of contents) {
    hash.update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}

// Streaming twin of computeIntegrityHash: sha256 over raw file bytes.
// For valid UTF-8 files (all session JSONL) this yields the same digest as
// computeIntegrityHash([readFileSync(path, "utf-8")]) — hash.update(string)
// encodes utf-8 — so manifests from pre-streaming exports keep verifying.
export async function computeIntegrityHashFromFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function verifyIntegrity(
  contents: string[],
  expectedHash: string
): boolean {
  const actual = computeIntegrityHash(contents);
  return actual === expectedHash;
}
