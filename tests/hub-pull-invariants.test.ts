import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HUB_DIR = new URL("../src/hub/", import.meta.url).pathname;

function hubPullBody(): string {
  const src = readFileSync(join(HUB_DIR, "pull.ts"), "utf-8");
  const start = src.indexOf("export async function hubPull(");
  expect(start, "hubPull must exist in src/hub/pull.ts").toBeGreaterThan(-1);
  return src.slice(start);
}

/**
 * Every wall-clock read inside `hubPull` that exists today, verbatim and
 * trimmed. This is an ALLOWLIST, not a count: the point is that adding a
 * clock read to the pull pipeline has to be a deliberate, reviewed act.
 *
 * Only the first entry is the operation-scope capture. The other two are
 * audited exceptions that do NOT feed append.ts's self-write exemption:
 *
 * - `baseAgeMs` is the adopt-hub divergence heuristic — an age used for a
 *   freshness window and a human-readable "modified Ns ago" message. The
 *   exemption on the same line is still `opNowMs` (`baseMtimeMs < opNowMs`).
 * - `timestamp` is a history.jsonl display record for the preserved local
 *   branch. It is not a liveness input at all.
 *
 * If a stage extraction moves either exception into a `pull-*.ts` file, it
 * must be turned into a parameter first — the second test below forbids a
 * clock read in a stage file outright, deliberately, and that rule wins.
 */
const ALLOWED_CLOCK_READS_IN_HUB_PULL = [
  "const opNowMs = Date.now();",
  "const baseAgeMs = Date.now() - baseMtimeMs;",
  "timestamp: Date.now(),",
];

/**
 * `opNowMs` must be read exactly once, in pull.ts, and passed into stages.
 * A stage file that calls Date.now() re-arms append.ts's liveness guard
 * against this operation's own writes (spec §3).
 */
describe("pull pipeline clock discipline", () => {
  it("captures opNowMs exactly once in hubPull and never reassigns it", () => {
    const body = hubPullBody();
    const captures = body.match(/opNowMs\s*=\s*Date\.now\(\)/g) ?? [];
    expect(
      captures.length,
      "opNowMs is captured once per operation, never per bundle or per stage"
    ).toBe(1);
    expect(body).toContain("const opNowMs = Date.now();");
    // The capture is the only assignment: any second `opNowMs =` is a
    // re-read, whatever it is assigned from.
    const assignments = body.match(/\bopNowMs\s*=(?!=)/g) ?? [];
    expect(assignments.length, "opNowMs must never be reassigned").toBe(1);
  });

  it("adds no unaudited wall-clock read inside hubPull", () => {
    const body = hubPullBody();
    const found = body
      .split("\n")
      .filter((l) => l.includes("Date.now()"))
      .map((l) => l.trim());
    expect(
      found,
      "a new Date.now() in hubPull must be justified and added to ALLOWED_CLOCK_READS_IN_HUB_PULL, or (better) receive opNowMs"
    ).toEqual(ALLOWED_CLOCK_READS_IN_HUB_PULL);
  });

  it("no pull stage file reads the wall clock", () => {
    const stageFiles = readdirSync(HUB_DIR).filter(
      (f) => f.startsWith("pull-") && f.endsWith(".ts")
    );
    expect(stageFiles.length).toBeGreaterThan(0);
    for (const f of stageFiles) {
      const src = readFileSync(join(HUB_DIR, f), "utf-8");
      expect(src, `${f} must receive opNowMs as a parameter`).not.toMatch(/Date\.now\(\)/);
    }
  });
});
