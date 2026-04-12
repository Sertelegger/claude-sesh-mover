import type { VersionAdapter } from "./types.js";

/**
 * Registry of version adapters. Add new adapters here as Claude Code
 * evolves its session format. Keep them ordered by fromVersion.
 */
const ADAPTER_REGISTRY: VersionAdapter[] = [
  // No adapters yet — this is the initial release.
  // Example adapter for future use:
  // {
  //   fromVersion: "2.1.0",
  //   toVersion: "2.2.0",
  //   description: "Rename thinkingMetadata to thinkingMeta",
  //   applies(entry) {
  //     return entry.type === "assistant" && "thinkingMetadata" in entry;
  //   },
  //   transform(entry) {
  //     const { thinkingMetadata, ...rest } = entry as any;
  //     return { ...rest, thinkingMeta: thinkingMetadata };
  //   },
  // },
];

export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

export function classifyVersionDifference(
  sourceVersion: string,
  targetVersion: string
): "same" | "source-newer" | "target-newer" {
  const cmp = compareVersions(sourceVersion, targetVersion);
  if (cmp === 0) return "same";
  if (cmp > 0) return "source-newer";
  return "target-newer";
}

export function getApplicableAdapters(
  sourceVersion: string,
  targetVersion: string
): VersionAdapter[] {
  if (compareVersions(sourceVersion, targetVersion) >= 0) {
    // Source is same or newer — no upgrade adapters needed
    return [];
  }

  // Source is older — find adapters between source and target
  return ADAPTER_REGISTRY.filter(
    (adapter) =>
      compareVersions(adapter.fromVersion, sourceVersion) >= 0 &&
      compareVersions(adapter.toVersion, targetVersion) <= 0
  );
}

export function applyAdapters(
  entry: Record<string, unknown>,
  adapters: VersionAdapter[]
): { entry: Record<string, unknown>; applied: string[] } {
  let current = entry;
  const applied: string[] = [];

  for (const adapter of adapters) {
    try {
      if (adapter.applies(current as unknown as import("./types.js").JsonlEntry)) {
        current = adapter.transform(current as unknown as import("./types.js").JsonlEntry) as unknown as Record<string, unknown>;
        applied.push(adapter.description);
      }
    } catch {
      // Best-effort: skip adapter if it fails
    }
  }

  return { entry: current, applied };
}
