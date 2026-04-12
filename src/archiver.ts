import { readdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
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
      {
        gzip: true,
        file: archivePath,
        cwd: dirname(sourceDir),
      },
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
    await tar.extract({
      file: archivePath,
      cwd: targetDir,
      strip: 1, // strip the top-level directory
    });
  }

  // Path traversal protection: verify all extracted files are within targetDir
  validateExtractedPaths(targetDir);
}

function validateExtractedPaths(dir: string): void {
  const resolvedDir = resolve(dir);
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(
      entry.parentPath ?? (entry as any).path ?? dir,
      entry.name
    );
    if (!fullPath.startsWith(resolvedDir)) {
      throw new Error(
        `Path traversal detected: ${fullPath} is outside ${resolvedDir}`
      );
    }
  }
}

export function detectArchiveFormat(
  filePath: string
): CompressionType | null {
  if (filePath.endsWith(".tar.gz") || filePath.endsWith(".tgz")) {
    return "gzip";
  }
  if (filePath.endsWith(".tar.zst") || filePath.endsWith(".tar.zstd")) {
    return "zstd";
  }
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

async function createZstdArchive(
  sourceDir: string,
  archivePath: string
): Promise<void> {
  // Create tar first, then pipe through zstd
  const tarPath = archivePath.replace(/\.zst$/, "");
  await tar.create(
    {
      file: tarPath,
      cwd: dirname(sourceDir),
    },
    [basename(sourceDir)]
  );
  // Use execFileSync to avoid shell injection
  execFileSync("zstd", ["-f", tarPath, "-o", archivePath], { stdio: "ignore" });
  unlinkSync(tarPath);
}

async function extractZstdArchive(
  archivePath: string,
  targetDir: string
): Promise<void> {
  const tarPath = archivePath.replace(/\.zst$/, ".tar");
  // Use execFileSync to avoid shell injection
  execFileSync("zstd", ["-d", archivePath, "-o", tarPath], { stdio: "ignore" });
  await tar.extract({
    file: tarPath,
    cwd: targetDir,
    strip: 1,
  });
  unlinkSync(tarPath);
}
