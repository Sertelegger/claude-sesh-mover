import { describe, it, expect } from "vitest";
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPush } from "../src/hub/push.js";
import { hubPull } from "../src/hub/pull.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import { readLastEntryUuid } from "../src/jsonl.js";
import { encodeProjectPath } from "../src/platform.js";
import type { HubPullResult } from "../src/types.js";

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
 * There is now exactly one, the operation-scope capture. `hubPull` used to
 * carry two audited exceptions alongside it — the adopt-hub `baseAgeMs`
 * heuristic and a history.jsonl display `timestamp` — and both left with the
 * `apply.sessions` stage. Neither was deleted: a stage file may not read the
 * clock at all (the last test below), so each became a parameter (`ageNowMs`,
 * `historyNowMs`, plus `historyNowDate` for the date string that reads no
 * clock but takes the same route), and `hubPull` passes `opNowMs` for them
 * today.
 *
 * That is deliberately NOT the same as folding them into `opNowMs`. The
 * parameters stay distinct because they are different kinds of value:
 * `opNowMs` is a boundary ("anything at or after this was written by us") and
 * must never be refreshed, while `ageNowMs` feeds a duration rendered to the
 * user as "modified Ns ago" and may legitimately be made fresher later. The
 * self-write exemption itself is untouched and still compares against
 * `opNowMs`.
 *
 * Passing `opNowMs` for `ageNowMs` today is a real, accepted behavior change,
 * and its direction is the opposite of what an earlier version of this comment
 * claimed. `opNowMs` is captured before the lock, so the reported age is SHORT
 * by the pull's runtime. A smaller age makes `looksLive` more likely true, so
 * `adopt-hub` gets refused where a fresh clock would have adopted — an
 * adoption can become a refusal, never a refusal a truncation. Making it exact
 * means a fresh `Date.now()` at the call site, which this list would then have
 * to permit.
 *
 * So a stage extraction that moves a clock read must parameterize it and
 * shrink this list in the same commit — the stage-file rule wins.
 */
const ALLOWED_CLOCK_READS_IN_HUB_PULL = ["const opNowMs = Date.now();"];

/**
 * `new Date()` is the same wall-clock read wearing a different hat, and it
 * slipped past the `Date.now()` grep below for the whole of Slice 2: the
 * history.jsonl display date on the adopt path was
 * `new Date().toISOString().slice(0, 10)`, sitting in the middle of a range
 * that was about to be extracted into a file this suite would then certify as
 * clock-free. An argument makes the call a formatter rather than a clock
 * (`new Date(opNowMs)`), so only the ZERO-argument form counts.
 *
 * Default is none: a stage file with no entry here may not contain one at all.
 * The single exemption is audited and pre-existing, moved verbatim by the
 * record-stage extraction:
 *
 * - `pull-record.ts` stamps `updatedAt` on this machine's own index file.
 *   The checkable fact that makes this safe, rather than merely plausible:
 *   **`updatedAt` is write-only across the whole of `src/`.** It is written
 *   here and in `reindex.ts` (which writes the empty string for it), and read
 *   nowhere — not by `resolveThreads`, not by the latest-copy tiebreak, not by
 *   any liveness guard. So no decision anywhere can depend on which clock
 *   produced it. Verify that claim before extending this list, and if
 *   `updatedAt` ever gains a reader, this entry must go.
 *
 *   The follow-up is to parameterize it the next time `pull-record.ts` is
 *   opened — `runRecordStage` already takes an input object, so it is a
 *   two-line change with no behavioral consequence — and then delete this
 *   entry to restore an unconditional ban.
 *
 * SCOPE, stated honestly: this loop matches `pull-*.ts`, which excludes
 * `pull.ts` itself, and `hubPullBody()` slices from `hubPull`'s declaration,
 * so helpers above it are outside both greps. `recordSplice` in `pull.ts`
 * contains a live `new Date().toISOString()` on the pull's write path today.
 * The guarantee here is "no STAGE FILE reads the clock", not "the pull
 * pipeline doesn't".
 */
const ALLOWED_BARE_NEW_DATE_BY_STAGE_FILE: Record<string, string[]> = {
  "pull-record.ts": ["now: new Date().toISOString(),"],
};

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
      // ...and the same rule for the other spelling — see
      // ALLOWED_BARE_NEW_DATE_BY_STAGE_FILE. An absent entry means an empty
      // list, i.e. the plain "no bare new Date() in a stage file" ban.
      const bare = src
        .split("\n")
        .filter((l) => /new Date\(\s*\)/.test(l))
        .map((l) => l.trim());
      expect(
        bare,
        `${f} must take its "now" as a parameter, not read one — or be listed in ALLOWED_BARE_NEW_DATE_BY_STAGE_FILE with a reason`
      ).toEqual(ALLOWED_BARE_NEW_DATE_BY_STAGE_FILE[f] ?? []);
    }
  });
});

// ---- Warning emission order -------------------------------------------------

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";
const FIXTURE_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
/** Uuid of the fixture session's last entry — every continuation's anchor. */
const FIXTURE_HEAD_UUID = "entry-3";

/** Nine well-separated lines; `edits` replaces individual 1-based lines. */
function wsLines(edits: Record<number, string> = {}): string {
  return Array.from({ length: 9 }, (_, i) => edits[i + 1] ?? `L${i + 1}`).join("\n") + "\n";
}

function appendEntry(path: string, entry: Record<string, unknown>): void {
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * `fetch`, `apply.workspace` and `apply.sessions` are three PHASES OF ONE LOOP
 * BODY, not three linear stages, and the difference is only observable in the
 * order `HubPullResult.warnings` comes back in.
 *
 * Every other assertion on `warnings` in this suite is `join(" ")` +
 * `toContain`, `.some(...)` or `.find(...)` — all of them order-blind. So a
 * refactor that collects each stage's reasons and concatenates them
 * stage-major ships green while silently hoisting the workspace block out of
 * the middle of a multi-bundle chain to the front of the list, because
 * `workspaceBundleIndex` selects the NEWEST bundle carrying a payload (see
 * `initApplyState`), which on the ordinary two-push shape is bundle 1.
 *
 * The arrangement below is the one `tests/hub-pull.test.ts` builds for "a peer
 * that pushed twice since our last sync still merges, via the chain's older
 * base" and "a divergence skip alongside a workspace merge stays re-runnable",
 * combined so that BOTH halves warn:
 *
 *   bundle 0 -> session warning  (B forked the thread, so the first
 *                                 continuation cannot chain onto it)
 *   bundle 1 -> workspace warning (B deleted a file the shared generation
 *                                 carried, so the merge reports it)
 *   bundle 1 -> session warning   (none today: it splices cleanly)
 *
 * i.e. today's list interleaves as `[b0 session, b1 workspace]`, and a
 * stage-major concatenation would produce `[b1 workspace, b0 session]`.
 */
describe("pull warning order", () => {
  it("emits each bundle's warnings in loop order: bundle 0's session warning precedes bundle 1's workspace warning", async () => {
    const homeA = mkdtempSync(join(tmpdir(), "sesh-order-homeA-"));
    const homeB = mkdtempSync(join(tmpdir(), "sesh-order-homeB-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-order-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-order-fix-"));
    const projectB = mkdtempSync(join(tmpdir(), "sesh-order-projB-"));
    let restore = overrideHome(homeA);
    try {
      // --- A: a real, git-less project with two files, pushed once ----------
      const { configDir: configDirA } = createFixtureTree(base);
      const projectA = join(base, "projA-order");
      mkdirSync(projectA, { recursive: true });
      writeFileSync(join(projectA, "README.md"), "hello\n");
      writeFileSync(join(projectA, "shared.txt"), wsLines());
      const encodedA = encodeProjectPath(projectA);
      cpSync(join(configDirA, "projects", FIXTURE_ENCODED), join(configDirA, "projects", encodedA), {
        recursive: true,
      });
      const aJsonl = join(configDirA, "projects", encodedA, `${FIXTURE_SESSION_ID}.jsonl`);

      await hubInit({ hubPath: hub, configScope: "user", cwd: homeA });
      const push1 = await hubPush({
        configDir: configDirA, projectPath: projectA, hubPath: hub,
        createProject: true, claudeVersion: "2.1.81",
      });
      expect(push1.success).toBe(true);
      if (!push1.success) return;
      expect(push1.hasWorkspace).toBe(true);

      // --- B: links to the same hub project and bootstraps off push #1 ------
      restore.restore();
      restore = overrideHome(homeB);
      const configDirB = join(homeB, ".claude");
      writeLocalProjectId(projectB, {
        projectId: push1.projectId, name: "projA-order",
        createdAt: new Date().toISOString(), createdByMachine: "machine-a",
      });
      const bootstrap = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(bootstrap.success).toBe(true);
      if (!bootstrap.success) return;
      const bSessionId = (bootstrap as HubPullResult).localSessionId;
      expect(bSessionId, "B's bootstrap must land a local session").toBeTruthy();
      const bJsonl = join(configDirB, "projects", encodeProjectPath(projectB), `${bSessionId}.jsonl`);
      // The generation both trees now share carries BOTH files.
      expect(existsSync(join(projectB, "README.md"))).toBe(true);
      expect(readFileSync(join(projectB, "shared.txt"), "utf-8")).toBe(wsLines());

      // B forks the thread locally: bundle 0's continuation anchors at the
      // fixture head, which is no longer B's head, so it cannot be spliced.
      appendEntry(bJsonl, {
        uuid: "b-local-1", parentUuid: FIXTURE_HEAD_UUID, timestamp: "2026-05-01T10:00:00Z",
        sessionId: bSessionId, cwd: projectB, version: "2.1.81", type: "user",
        message: { role: "user", content: "meanwhile, on B" },
      });
      // State the base's age explicitly rather than leaning on append.ts's
      // self-write exemption (that exemption is a sub-ms clock coincidence,
      // never a fixture).
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(bJsonl, old, old);
      // ...and deletes a file the shared generation carried, which is what the
      // workspace merge reports on (`localDeleted`) without needing git.
      rmSync(join(projectB, "README.md"));

      // --- A pushes twice: a two-bundle chain, payload on the NEWER one -----
      restore.restore();
      restore = overrideHome(homeA);
      for (const [n, tree] of [
        [1, wsLines({ 2: "GEN-2" })],
        [2, wsLines({ 2: "GEN-2", 4: "GEN-3" })],
      ] as Array<[number, string]>) {
        writeFileSync(join(projectA, "shared.txt"), tree);
        const anchor = readLastEntryUuid(aJsonl);
        expect(anchor, "A's session must have a head entry").toBeTruthy();
        appendEntry(aJsonl, {
          uuid: `a-ws-${n}`, parentUuid: anchor,
          // Strictly newer than the fixture's entries, and well before B's
          // (unpublished) fork, so A stays the thread's latest copy.
          timestamp: new Date(Date.parse("2026-04-11T10:00:00Z") + n * 60_000).toISOString(),
          sessionId: FIXTURE_SESSION_ID, cwd: projectA, version: "2.1.81", type: "user",
          message: { role: "user", content: `more work on A (${n})` },
        });
        const push = await hubPush({
          configDir: configDirA, projectPath: projectA, hubPath: hub, claudeVersion: "2.1.81",
        });
        expect(push.success, `A's push #${n + 1} must succeed`).toBe(true);
        if (!push.success) return;
        expect(push.hasWorkspace, `A's push #${n + 1} must carry a workspace payload`).toBe(true);
      }

      // --- The act: one pull on B, walking both bundles ---------------------
      restore.restore();
      restore = overrideHome(homeB);
      const pull = await hubPull({
        configDir: configDirB, projectPath: projectB, hubPath: hub,
        latest: true, claudeVersion: "2.1.81",
      });
      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      // Preconditions, so a fixture drift fails HERE and not as a silently
      // vacuous ordering assertion below.
      //
      // 1. The applied workspace generation is bundle 1's, not bundle 0's.
      expect(readFileSync(join(projectB, "shared.txt"), "utf-8"))
        .toBe(wsLines({ 2: "GEN-2", 4: "GEN-3" }));
      // 2. Bundle 1's session half did NOT diverge (it spliced), so the one
      //    divergence warning in the list belongs to bundle 0.
      expect(p.divergence?.resolution).toBe("fragment");
      expect(p.appended).toHaveLength(1);
      // 3. The workspace half really did report the local deletion.
      expect(p.workspaceMerge?.localDeleted).toContain("README.md");

      const sessionIdx = p.warnings.findIndex((w) => w.includes("has diverged"));
      const workspaceIdx = p.warnings.findIndex((w) =>
        w.includes("in the last generation shared with the other machine")
      );
      // -1 < n is true for any n >= 0, so a missing warning would pass the
      // ordering assertion vacuously. Both have to be present first.
      expect(sessionIdx, "bundle 0's divergence warning must be present").toBeGreaterThanOrEqual(0);
      expect(workspaceIdx, "bundle 1's workspace-merge warning must be present").toBeGreaterThanOrEqual(0);
      expect(
        sessionIdx,
        "bundle 0's session warning must come BEFORE bundle 1's workspace warning — the three in-loop stages are phases of one loop body, so their reasons interleave per bundle and must never be concatenated stage-major"
      ).toBeLessThan(workspaceIdx);
    } finally {
      restore.restore();
      for (const d of [homeA, homeB, hub, base, projectB]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});
