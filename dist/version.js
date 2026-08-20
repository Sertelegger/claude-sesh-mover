/**
 * This plugin's version, as one in-code constant.
 *
 * It exists because the version stopped being cosmetic: `hub.json` and each
 * `machines/<id>.json` now carry a `pluginVersion` (see `hub/layout.ts`), so a
 * version string that drifts from `package.json` would put a wrong claim on the
 * hub — where another machine reads it — rather than merely printing the wrong
 * thing after `--version`.
 *
 * **It is deliberately a literal, not a runtime read of `package.json`.** The
 * package ships as `files: ["dist"]` and is *also* installed as a Claude Code
 * plugin straight from the repo, so `dist/version.js` resolving `../package.json`
 * works in both layouts today and is one directory-layout change away from
 * throwing at module load on the unattended auto-push path. A constant cannot
 * fail to load. The drift it costs is bought back by `tests/version.test.ts`,
 * which pins this against `package.json`, `.claude-plugin/plugin.json` and
 * `.claude-plugin/marketplace.json` — all four move together or the suite fails.
 */
export const PLUGIN_VERSION = "0.10.0";
//# sourceMappingURL=version.js.map