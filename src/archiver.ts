import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";

export type CompressionType = "gzip" | "zstd";

export async function createArchive(
  sourceDir: string,
  archivePath: string,
  compression: CompressionType
): Promise<void> {
  if (compression === "zstd") {
    await createZstdArchive(sourceDir, archivePath);
  } else {
    await tar.create(
      { gzip: true, file: archivePath, cwd: dirname(sourceDir) },
      [basename(sourceDir)]
    );
  }
}

export async function extractArchive(
  archivePath: string,
  targetDir: string
): Promise<void> {
  const format = detectArchiveFormat(archivePath);
  if (format === "zstd") {
    await extractZstdArchive(archivePath, targetDir);
  } else {
    await assertSafeEntries(archivePath);
    await tar.extract({ file: archivePath, cwd: targetDir, strip: 1 });
  }
}

/**
 * Validate all tar entry metadata BEFORE extraction. node-tar has its own
 * runtime protections, but we refuse outright: absolute paths, any `..`
 * segment, and link entries (sesh-mover exports never contain links, so any
 * link entry is malicious or corrupt).
 * Works on .tar and .tar.gz inputs (tar.list auto-detects gzip).
 */
export async function assertSafeEntries(tarFile: string): Promise<void> {
  const offenders: string[] = [];
  await tar.list({
    file: tarFile,
    onReadEntry: (entry) => {
      const p = String(entry.path);
      if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
        offenders.push(`${p} (absolute path)`);
      } else if (p.split("/").includes("..")) {
        offenders.push(`${p} (parent traversal)`);
      } else if (entry.type === "SymbolicLink" || entry.type === "Link") {
        offenders.push(`${p} (${entry.type})`);
      }
    },
  });
  if (offenders.length > 0) {
    throw new Error(`Unsafe archive entries detected: ${offenders.join(", ")}`);
  }
}

export function detectArchiveFormat(
  filePath: string
): CompressionType | null {
  if (filePath.endsWith(".tar.gz") || filePath.endsWith(".tgz")) return "gzip";
  if (filePath.endsWith(".tar.zst") || filePath.endsWith(".tar.zstd")) return "zstd";
  return null;
}

export async function isZstdAvailable(): Promise<boolean> {
  try {
    execFileSync("zstd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function createZstdArchive(sourceDir: string, archivePath: string): Promise<void> {
  // All intermediate .tar work happens in a private temp dir — never next to
  // the destination, so we can never clobber or delete a user's file.
  const workDir = mkdtempSync(join(tmpdir(), "sesh-mover-zstd-"));
  const tarPath = join(workDir, "bundle.tar");
  try {
    await tar.create({ file: tarPath, cwd: dirname(sourceDir) }, [basename(sourceDir)]);
    execFileSync("zstd", ["-f", tarPath, "-o", archivePath], { stdio: "ignore" });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function extractZstdArchive(archivePath: string, targetDir: string): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "sesh-mover-zstd-"));
  const tarPath = join(workDir, "bundle.tar");
  try {
    execFileSync("zstd", ["-d", archivePath, "-o", tarPath], { stdio: "ignore" });
    await assertSafeEntries(tarPath);
    await tar.extract({ file: tarPath, cwd: targetDir, strip: 1 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
