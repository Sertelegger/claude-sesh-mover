import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_VERSION } from "../src/version.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function jsonAt(...rel: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, ...rel), "utf-8")) as Record<string, unknown>;
}

/**
 * `PLUGIN_VERSION` is a literal, not a runtime read of `package.json` (see
 * `src/version.ts` for why). This is the price of that: five files carry six
 * copies of the version, and they move together or the suite fails.
 *
 * It stopped being cosmetic when `registerMachine` began stamping
 * `pluginVersion` into `machines/<id>.json` — a drifted constant now puts a
 * WRONG claim on a shared hub, where another machine reads it to decide whether
 * this one is too old to be told about encryption, rather than merely printing
 * the wrong thing after `--version`.
 */
describe("PLUGIN_VERSION", () => {
  it("matches package.json", () => {
    expect(PLUGIN_VERSION).toBe(jsonAt("package.json").version);
  });

  it("matches the plugin manifest and the marketplace listing", () => {
    expect(jsonAt(".claude-plugin", "plugin.json").version).toBe(PLUGIN_VERSION);
    const marketplace = jsonAt(".claude-plugin", "marketplace.json") as {
      metadata: { version: string };
    };
    expect(marketplace.metadata.version).toBe(PLUGIN_VERSION);
  });

  /**
   * `package-lock.json` carries the root version twice — top-level `version`
   * and `packages[""].version` — and nothing pinned either until 0.13.0. It sat
   * at 0.8.0 for two releases before 0.12.0's release prep noticed (f02f46b).
   * Nothing at runtime reads it, so a drift costs no behaviour; it is pinned
   * because a release-prep bump that misses it is exactly the drift this file
   * exists to make impossible.
   */
  it("matches both root versions in package-lock.json", () => {
    const lock = jsonAt("package-lock.json") as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(PLUGIN_VERSION);
    expect(lock.packages[""]?.version).toBe(PLUGIN_VERSION);
  });
});
