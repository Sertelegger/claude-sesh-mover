import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
  return JSON.parse(raw) as ExportManifest;
}

export function computeIntegrityHash(contents: string[]): string {
  const hash = createHash("sha256");
  for (const content of contents) {
    hash.update(content);
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
