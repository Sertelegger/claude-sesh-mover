#!/usr/bin/env node
/**
 * Print one version's CHANGELOG section, for use as a GitHub release body.
 *
 * The release workflow used to call `gh release create --generate-notes`, which
 * lists merged PR titles and a compare link. For v0.7.0 — a release that renamed
 * every path the plugin owns on disk and broke project-level config — that
 * produced exactly one line, while CHANGELOG.md carried ninety. The changelog
 * entry is written deliberately and reviewed in the PR that ships it, so it is
 * the better source; this makes it the actual release body.
 *
 * Usage:  node scripts/changelog-section.mjs v0.8.0 [--changelog CHANGELOG.md]
 *
 * Exits non-zero with a message on stderr if the section is missing or empty,
 * so a release fails loudly rather than publishing blank notes. That is the
 * whole point: a silent empty release is the failure mode being fixed.
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const tag = argv.find((a) => !a.startsWith("--"));
const fileIdx = argv.indexOf("--changelog");
const file = fileIdx === -1 ? "CHANGELOG.md" : argv[fileIdx + 1];

if (!tag) {
  console.error("usage: changelog-section.mjs <tag> [--changelog <path>]");
  process.exit(2);
}

// Accept `v0.8.0` or `0.8.0`; headings are `## [0.8.0] — 2026-08-08`.
const version = tag.replace(/^v/, "");

let text;
try {
  text = readFileSync(file, "utf-8");
} catch (e) {
  console.error(`cannot read ${file}: ${e.message}`);
  process.exit(1);
}

const lines = text.split("\n");
// Match the heading by its bracketed version only — never by the date or the
// dash, so a change of date format cannot silently stop matching.
const isHeading = (l) => /^##\s+\[/.test(l);
const start = lines.findIndex((l) => isHeading(l) && l.includes(`[${version}]`));

if (start === -1) {
  console.error(
    `no CHANGELOG section found for [${version}] in ${file}.\n` +
      `Add a "## [${version}] — <date>" heading before tagging; the release body comes from it.`
  );
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (isHeading(lines[i])) {
    end = i;
    break;
  }
}

// Drop the heading itself: GitHub already titles the release with the tag, so
// repeating "## [0.8.0]" as the first line of the body is noise.
const body = lines.slice(start + 1, end).join("\n").trim();

if (!body) {
  console.error(`the [${version}] section in ${file} is empty.`);
  process.exit(1);
}

process.stdout.write(body + "\n");
