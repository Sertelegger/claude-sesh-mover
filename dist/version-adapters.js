"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareVersions = compareVersions;
exports.classifyVersionDifference = classifyVersionDifference;
exports.getApplicableAdapters = getApplicableAdapters;
exports.applyAdapters = applyAdapters;
/**
 * Registry of version adapters. Add new adapters here as Claude Code
 * evolves its session format. Keep them ordered by fromVersion.
 */
const ADAPTER_REGISTRY = [
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
function compareVersions(a, b) {
    const partsA = a.split(".").map(Number);
    const partsB = b.split(".").map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const numA = partsA[i] ?? 0;
        const numB = partsB[i] ?? 0;
        if (numA !== numB)
            return numA - numB;
    }
    return 0;
}
function classifyVersionDifference(sourceVersion, targetVersion) {
    const cmp = compareVersions(sourceVersion, targetVersion);
    if (cmp === 0)
        return "same";
    if (cmp > 0)
        return "source-newer";
    return "target-newer";
}
function getApplicableAdapters(sourceVersion, targetVersion) {
    if (compareVersions(sourceVersion, targetVersion) >= 0) {
        // Source is same or newer — no upgrade adapters needed
        return [];
    }
    // Source is older — find adapters between source and target
    return ADAPTER_REGISTRY.filter((adapter) => compareVersions(adapter.fromVersion, sourceVersion) >= 0 &&
        compareVersions(adapter.toVersion, targetVersion) <= 0);
}
function applyAdapters(entry, adapters) {
    let current = entry;
    const applied = [];
    for (const adapter of adapters) {
        try {
            if (adapter.applies(current)) {
                current = adapter.transform(current);
                applied.push(adapter.description);
            }
        }
        catch {
            // Best-effort: skip adapter if it fails
        }
    }
    return { entry: current, applied };
}
//# sourceMappingURL=version-adapters.js.map