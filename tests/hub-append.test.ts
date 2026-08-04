import { describe, it, expect, vi } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptHubBranch,
  tryAppendContinuation,
  readDeltaChainInfo,
  identityRewriteContext,
  APPEND_LIVE_WINDOW_MS,
} from "../src/hub/append.js";
import { buildImportRewriteContext } from "../src/rewriter.js";
import { detectPlatform } from "../src/platform.js";
import type { VersionAdapter } from "../src/types.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const HEADER = {
  uuid: "hdr-1",
  timestamp: "2026-07-21T10:00:00Z",
  sessionId: "delta-sid",
  cwd: "/p",
  version: "2.1.81",
  type: "user",
  message: {
    role: "user",
    content: "[sesh-mover continuation]\nThis session continues session `x` from machine `y`.",
  },
};

function entry(uuid: string, parentUuid: string | null, sessionId = "delta-sid") {
  return {
    uuid,
    parentUuid: parentUuid ?? undefined,
    timestamp: "2026-07-21T10:01:00Z",
    sessionId,
    cwd: "/p",
    version: "2.1.81",
    type: "user",
    message: { role: "user", content: `msg ${uuid}` },
  };
}

// String members are written verbatim (used to plant unparseable lines).
function writeJsonl(path: string, objs: unknown[], trailingNewline = true): void {
  const body = objs
    .map((o) => (typeof o === "string" ? o : JSON.stringify(o)))
    .join("\n");
  writeFileSync(path, trailingNewline ? body + "\n" : body, "utf-8");
}

/** Age a file past the live window so the mtime guard passes. */
function ageOut(path: string): void {
  const old = new Date(Date.now() - APPEND_LIVE_WINDOW_MS - 60_000);
  utimesSync(path, old, old);
}

/**
 * Put a file's mtime inside the live window but STRICTLY in the past. Using
 * "now" here is a race: `opNowMs` is captured from `Date.now()` in the same
 * millisecond, the self-write exemption (`mtime >= opNowMs`) fires, and the
 * liveness guard never runs.
 */
function ageToLive(path: string): void {
  const recent = new Date(Date.now() - 30_000);
  utimesSync(path, recent, recent);
}

/** Only for the self-write exemption, which needs mtime >= opNowMs. */
function touchNow(path: string): void {
  const now = new Date();
  utimesSync(path, now, now);
}

/**
 * Loads a private copy of append.ts whose `rewriteJsonlStream` runs a callback
 * right after the real rewrite — i.e. inside the O(delta) preparation window,
 * after the up-front guards have read the base and before the append. That is
 * the only place a concurrent Claude Code write can be simulated
 * deterministically. Sanctioned targeted fake: the real rewriter still does the
 * work; the wrapper only interleaves the foreign write.
 */
async function loadModuleWithConcurrentWrite(
  write: () => void
): Promise<typeof import("../src/hub/append.js")> {
  vi.resetModules();
  // One-shot: adoptHubBranch rewrites twice (the delta, then the preserved
  // copy). Only the FIRST call is the pre-truncate window under test; firing
  // again afterwards would be a second, unrelated race.
  let fired = false;
  vi.doMock("../src/rewriter.js", async () => {
    const actual = await vi.importActual<typeof import("../src/rewriter.js")>(
      "../src/rewriter.js"
    );
    return {
      ...actual,
      rewriteJsonlStream: async (
        ...args: Parameters<typeof actual.rewriteJsonlStream>
      ) => {
        const report = await actual.rewriteJsonlStream(...args);
        if (!fired) {
          fired = true;
          write();
        }
        return report;
      },
    };
  });
  return import("../src/hub/append.js");
}

async function loadAppendWithConcurrentWrite(
  write: () => void
): Promise<typeof import("../src/hub/append.js").tryAppendContinuation> {
  return (await loadModuleWithConcurrentWrite(write)).tryAppendContinuation;
}

async function loadAdoptWithConcurrentWrite(
  write: () => void
): Promise<typeof import("../src/hub/append.js").adoptHubBranch> {
  return (await loadModuleWithConcurrentWrite(write)).adoptHubBranch;
}

function unloadConcurrentWriteMock(): void {
  vi.doUnmock("../src/rewriter.js");
  vi.resetModules();
}

function makeBaseAt(
  dir: string,
  filename: string,
  entries: unknown[],
  trailingNewline = true
): string {
  const p = join(dir, filename);
  writeJsonl(p, entries, trailingNewline);
  ageOut(p);
  return p;
}

function makeBase(dir: string): string {
  return makeBaseAt(dir, "base.jsonl", [
    entry("b1", null, "base-sid"),
    entry("b2", "b1", "base-sid"),
    entry("b3", "b2", "base-sid"),
  ]);
}

function makeDelta(dir: string, anchorUuid: string, filename = "delta.jsonl"): string {
  const p = join(dir, filename);
  writeJsonl(p, [HEADER, entry("d1", anchorUuid), entry("d2", "d1")]);
  return p;
}

describe("readDeltaChainInfo", () => {
  it("reports the header and the first real entry's parentUuid", async () => {
    const dir = tmp("sesh-append-");
    try {
      const info = await readDeltaChainInfo(makeDelta(dir, "b3"));
      expect(info.headerPresent).toBe(true);
      expect(info.firstEntryParentUuid).toBe("b3");
      expect(info.lastEntryUuid).toBe("d2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles a header-less bundle: line 0 is the first real entry", async () => {
    const dir = tmp("sesh-append-");
    try {
      const p = join(dir, "raw.jsonl");
      writeJsonl(p, [entry("d1", "b3"), entry("d2", "d1")]);
      const info = await readDeltaChainInfo(p);
      expect(info.headerPresent).toBe(false);
      expect(info.firstEntryParentUuid).toBe("b3");
      expect(info.lastEntryUuid).toBe("d2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("identityRewriteContext", () => {
  it("carries no path mappings and identical source/target platform+user", () => {
    const ctx = identityRewriteContext();
    expect(ctx.mappings).toEqual([]);
    expect(ctx.sourcePlatform).toBe(ctx.targetPlatform);
    expect(ctx.sourceUser).toBe(ctx.targetUser);
  });
});

describe("tryAppendContinuation", () => {
  it("appends when the chain matches and the base is not recently active", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      const delta = makeDelta(dir, "b3");
      const before = readFileSync(base, "utf-8");
      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
      });
      expect(r.kind).toBe("appended");
      if (r.kind !== "appended") return;
      expect(r.entriesAppended).toBe(2);
      expect(r.newHeadUuid).toBe("d2");

      const after = readFileSync(base, "utf-8");
      expect(after.startsWith(before)).toBe(true); // base preserved verbatim
      const lines = after
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toHaveLength(5); // 3 base + 2 delta, header dropped
      expect(lines[3].uuid).toBe("d1");
      expect(lines[3].parentUuid).toBe("b3"); // chain intact
      expect(lines.every((l) => l.sessionId === "base-sid")).toBe(true); // ids rewritten
      expect(after).not.toContain("[sesh-mover continuation]"); // header stripped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The delta is another machine's bytes. Splicing it through the identity
  // context would embed that machine's paths and an un-migrated schema into a
  // local transcript, which is exactly what an ordinary import never does —
  // so the caller-supplied ctx and adapters have to reach the rewrite pass.
  it("applies the caller's rewrite context and version adapters to the spliced entries", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      const delta = join(dir, "foreign.jsonl");
      writeJsonl(delta, [
        HEADER,
        { ...entry("d1", "b3"), cwd: "C:\\Users\\alice\\proj" },
        { ...entry("d2", "d1"), cwd: "C:\\Users\\alice\\proj" },
      ]);

      const adapter: VersionAdapter = {
        fromVersion: "2.0.0",
        toVersion: "2.1.0",
        description: "test adapter",
        applies: (e) => (e as unknown as { type?: string }).type === "user",
        transform: (e) => ({ ...e, adapted: true }) as typeof e,
      };

      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        ctx: buildImportRewriteContext(
          {
            sourcePlatform: "win32",
            sourceProjectPath: "C:\\Users\\alice\\proj",
            sourceConfigDir: "C:\\Users\\alice\\.claude",
          },
          "/local/proj",
          "/local/.claude"
        ),
        adapters: [adapter],
        opNowMs: Date.now(),
        force: false,
      });
      expect(r.kind).toBe("appended");

      const spliced = readFileSync(base, "utf-8")
        .trim()
        .split("\n")
        .slice(3)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(spliced).toHaveLength(2);
      expect(spliced.every((e) => e.cwd === "/local/proj")).toBe(true);
      expect(spliced.every((e) => e.adapted === true)).toBe(true);
      expect(readFileSync(base, "utf-8")).not.toContain("alice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Task 6b's headline case. Claude Code appends uuid-less bookkeeping after
  // conversation entries, so roughly half the real transcripts on a machine end
  // with one. Deriving the head from the literal last line made it `null`, the
  // chain guard could never match, and pull silently fell back to a fragment
  // session — the exact thread fragmentation this milestone exists to remove.
  // Reverting only jsonl.ts's scan turns this back into `chain-mismatch`.
  it("appends onto a base whose final lines are uuid-less bookkeeping", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBaseAt(dir, "bk-base.jsonl", [
        entry("b1", null, "base-sid"),
        entry("b2", "b1", "base-sid"),
        entry("b3", "b2", "base-sid"),
        // Real shapes, keys verbatim from live transcripts. Two of the three
        // stacked here carry a `timestamp`; none carries a `uuid`.
        { type: "last-prompt", lastPrompt: "go on", leafUuid: "b3", sessionId: "base-sid" },
        {
          type: "file-history-delta",
          messageId: "b3",
          snapshotMessageId: "b1",
          trackingPath: "/p/notes.md",
          backup: "abc123",
          timestamp: "2026-08-02T12:00:00.000Z",
          sessionId: "base-sid",
        },
        {
          type: "pr-link",
          sessionId: "base-sid",
          prNumber: 9,
          prUrl: "https://example.test/9",
          prRepository: "o/r",
          timestamp: "2026-08-02T12:00:01.000Z",
        },
      ]);
      // The delta anchors on the real conversation head, NOT on the bookkeeping.
      const delta = makeDelta(dir, "b3", "bk-delta.jsonl");
      const before = readFileSync(base, "utf-8");

      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
      });

      expect(r.kind).toBe("appended");
      if (r.kind !== "appended") return;
      expect(r.entriesAppended).toBe(2);
      expect(r.newHeadUuid).toBe("d2");

      const after = readFileSync(base, "utf-8");
      expect(after.startsWith(before)).toBe(true); // bookkeeping preserved verbatim
      const lines = after
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toHaveLength(8); // 3 conversation + 3 bookkeeping + 2 delta
      expect(lines[6].uuid).toBe("d1");
      expect(lines[6].parentUuid).toBe("b3"); // chain intact across the bookkeeping
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The delta comes off a live session too, so ITS final line is bookkeeping
  // just as often. `readDeltaChainInfo.lastEntryUuid` was `null` there, which
  // declined as `no-delta-entries` before the base was ever consulted.
  it("appends a delta whose own final lines are uuid-less bookkeeping", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      const delta = join(dir, "bk-tail-delta.jsonl");
      writeJsonl(delta, [
        HEADER,
        entry("d1", "b3"),
        entry("d2", "d1"),
        { type: "mode", mode: "normal", sessionId: "delta-sid" },
        { type: "permission-mode", permissionMode: "auto", sessionId: "delta-sid" },
      ]);

      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
      });

      expect(r.kind).toBe("appended");
      if (r.kind !== "appended") return;
      expect(r.newHeadUuid).toBe("d2"); // post-append verify agrees with the delta's head
      expect(r.entriesAppended).toBe(4); // bookkeeping is carried across, not dropped
      const lines = readFileSync(base, "utf-8").trim().split("\n");
      expect(JSON.parse(lines[5]).type).toBe("mode"); // 3 base + d1 + d2 + mode
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A live Claude Code session writing `mode` / `last-prompt` between the two
  // chain checks does not move the head, so the O(delta) window no longer
  // aborts the splice over bookkeeping. What it MUST still abort on is a real
  // conversation entry (covered by the existing TOCTOU test below).
  it("survives bookkeeping written into the base during the O(delta) window", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      const delta = makeDelta(dir, "b3");
      const appendMod = await loadAppendWithConcurrentWrite(() => {
        appendFileSync(
          base,
          JSON.stringify({ type: "mode", mode: "plan", sessionId: "base-sid" }) + "\n",
          "utf-8"
        );
      });
      try {
        const r = await appendMod({
          basePath: base,
          baseSessionId: "base-sid",
          deltaPath: delta,
          ctx: identityRewriteContext(),
          opNowMs: Date.now(),
          force: true, // the concurrent write bumps mtime into the live window
        });
        expect(r.kind).toBe("appended");
        const lines = readFileSync(base, "utf-8").trim().split("\n");
        // The interloper's line survives, ahead of the spliced entries.
        expect(JSON.parse(lines[3]).mode).toBe("plan");
        expect(JSON.parse(lines[4]).uuid).toBe("d1");
      } finally {
        unloadConcurrentWriteMock();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declines chain-mismatch and leaves the base byte-identical", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      const delta = makeDelta(dir, "SOMETHING-ELSE");
      const before = readFileSync(base, "utf-8");
      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
      });
      expect(r.kind).toBe("declined");
      if (r.kind === "declined") expect(r.reason).toBe("chain-mismatch");
      expect(readFileSync(base, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declines when the base was modified inside the live window", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      ageToLive(base); // "live" session: recent, but before opNowMs
      const before = readFileSync(base, "utf-8");
      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: makeDelta(dir, "b3"),
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
      });
      expect(r.kind).toBe("declined");
      if (r.kind === "declined") expect(r.reason).toBe("recently-active");
      expect(readFileSync(base, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("force skips the mtime guard but NEVER the chain guard", async () => {
    const dir = tmp("sesh-append-");
    try {
      // Live base + matching chain: force overrides the mtime guard.
      const base = makeBase(dir);
      ageToLive(base);
      const ok = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: makeDelta(dir, "b3"),
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: true,
      });
      expect(ok.kind).toBe("appended");

      // A second, independent base whose head does NOT match the delta anchor:
      // force must not get it appended.
      const base2 = makeBaseAt(dir, "base2.jsonl", [entry("z1", null, "base-sid")]);
      ageToLive(base2);
      const before2 = readFileSync(base2, "utf-8");
      const bad = await tryAppendContinuation({
        basePath: base2,
        baseSessionId: "base-sid",
        deltaPath: makeDelta(dir, "not-z1", "delta2.jsonl"),
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: true,
      });
      expect(bad.kind).toBe("declined");
      if (bad.kind === "declined") expect(bad.reason).toBe("chain-mismatch");
      expect(readFileSync(base2, "utf-8")).toBe(before2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("self-write exemption: a base written by THIS operation still appends", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      touchNow(base); // just written by our own pull
      const opNowMs = Date.now() - 1000; // operation started before that write
      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: makeDelta(dir, "b3"),
        ctx: identityRewriteContext(),
        opNowMs,
        force: false,
      });
      expect(r.kind).toBe("appended"); // exemption applies, no --force needed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back byte-exact when the append fails mid-flight", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      const before = readFileSync(base, "utf-8");
      const beforeSize = statSync(base).size;
      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: makeDelta(dir, "b3"),
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
        // Sanctioned test seam: fires after the delta is written into the base,
        // before head verification — the only window where a rollback has real
        // bytes to undo.
        __injectFailure: () => {
          throw new Error("injected");
        },
      });
      expect(r.kind).toBe("declined");
      if (r.kind === "declined") {
        expect(r.reason).toBe("rolled-back");
        expect(r.detail).toContain("injected");
      }
      expect(readFileSync(base, "utf-8")).toBe(before);
      expect(statSync(base).size).toBe(beforeSize);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Call site 5 of the head reader: the rollback's own head verification. It
  // compares the RESTORED head against the head read before the splice, and
  // both now skip bookkeeping — so a base with a bookkeeping tail must still
  // report a clean restore rather than "rollback could not restore the head".
  it("verifies the restored head across a bookkeeping tail", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBaseAt(dir, "rb-base.jsonl", [
        entry("b1", null, "base-sid"),
        entry("b2", "b1", "base-sid"),
        entry("b3", "b2", "base-sid"),
        { type: "mode", mode: "normal", sessionId: "base-sid" },
        { type: "last-prompt", lastPrompt: "hold", leafUuid: "b3", sessionId: "base-sid" },
      ]);
      const before = readFileSync(base, "utf-8");
      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: makeDelta(dir, "b3", "rb-delta.jsonl"),
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
        __injectFailure: () => {
          throw new Error("injected");
        },
      });
      expect(r.kind).toBe("declined");
      if (r.kind !== "declined") return;
      expect(r.reason).toBe("rolled-back");
      expect(r.detail).toContain("restored to");
      expect(r.detail).not.toContain("could not restore");
      expect(readFileSync(base, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a delta containing an unparseable line without touching the base at all", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      const before = readFileSync(base, "utf-8");
      const mtimeBefore = statSync(base).mtimeMs;
      const delta = join(dir, "corrupt.jsonl");
      writeJsonl(delta, [HEADER, entry("d1", "b3"), "{not json", entry("d2", "d1")]);
      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
      });
      expect(r.kind).toBe("declined");
      if (r.kind === "declined") {
        // NOT "rolled-back": nothing was written, so the user must not be told
        // their transcript was modified and reverted.
        expect(r.reason).toBe("delta-unusable");
        expect(r.detail).toContain("unparseable");
      }
      expect(readFileSync(base, "utf-8")).toBe(before);
      // A no-op truncate would still bump mtime, and Claude Code orders
      // /resume by mtime.
      expect(statSync(base).mtimeMs).toBe(mtimeBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declines a bundle with no appendable entries", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      const before = readFileSync(base, "utf-8");
      const delta = join(dir, "header-only.jsonl");
      writeJsonl(delta, [HEADER]);
      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
      });
      expect(r.kind).toBe("declined");
      if (r.kind === "declined") expect(r.reason).toBe("no-delta-entries");
      expect(readFileSync(base, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-checks the chain right before writing: a base that grew mid-splice is declined", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir); // head b3
      const delta = makeDelta(dir, "b3");
      const before = readFileSync(base, "utf-8");
      // A live Claude Code session appends while we prepare the delta. The
      // up-front chain guard already passed; only the pre-write re-check can
      // catch this, and post-append verification never could (the final head
      // would still be the delta's last uuid).
      const concurrent = JSON.stringify(entry("live-1", "b3", "base-sid")) + "\n";
      const run = await loadAppendWithConcurrentWrite(() =>
        appendFileSync(base, concurrent, "utf-8")
      );
      const r = await run({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
      });
      expect(r.kind).toBe("declined");
      if (r.kind === "declined") expect(r.reason).toBe("chain-mismatch");
      // Our bytes absent; the concurrent writer's bytes intact.
      expect(readFileSync(base, "utf-8")).toBe(before + concurrent);
    } finally {
      unloadConcurrentWriteMock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back to the RE-MEASURED length, never discarding a concurrent writer's bytes", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir); // head b3
      const delta = makeDelta(dir, "b3");
      const before = readFileSync(base, "utf-8");
      // Growth that does NOT move the head — the one shape that gets past the
      // re-check — so the rollback length is the only thing under test.
      const concurrent = JSON.stringify(entry("b3", "b2", "base-sid")) + "\n";
      const run = await loadAppendWithConcurrentWrite(() =>
        appendFileSync(base, concurrent, "utf-8")
      );
      const r = await run({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
        __injectFailure: () => {
          throw new Error("injected");
        },
      });
      expect(r.kind).toBe("declined");
      if (r.kind === "declined") expect(r.reason).toBe("rolled-back");
      // Truncating to the STALE pre-prep length would have eaten `concurrent`.
      expect(readFileSync(base, "utf-8")).toBe(before + concurrent);
    } finally {
      unloadConcurrentWriteMock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The residual the re-measurement CANNOT close: a writer that lands between
  // `rollbackBytes = fresh.size` and the moment our own bytes are all in the
  // file. Before this milestone such a write made the head read return null and
  // the attempt decline (accidentally safe); now the head skips bookkeeping, the
  // splice proceeds, and a blind truncate back to `rollbackBytes` would delete
  // the other writer's line while reporting a clean restore.
  //
  // The injected failure writes the interloper's line and then throws, which is
  // also the realistic production shape: a live Claude Code session appends a
  // conversation entry right after our splice, post-append head verification
  // fails because the head is no longer the delta's last uuid, and the rollback
  // path is entered with foreign bytes past `rollbackBytes`.
  it("refuses to roll back over another writer's bytes, and says so instead of claiming a clean restore", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir); // head b3
      const delta = makeDelta(dir, "b3");
      const interloper = JSON.stringify(entry("live-1", "d2", "base-sid")) + "\n";
      const beforeSize = statSync(base).size;

      let err: Error | undefined;
      try {
        await tryAppendContinuation({
          basePath: base,
          baseSessionId: "base-sid",
          deltaPath: delta,
          ctx: identityRewriteContext(),
          opNowMs: Date.now(),
          force: false,
          __injectFailure: () => {
            appendFileSync(base, interloper, "utf-8");
            throw new Error("injected");
          },
        });
      } catch (e) {
        err = e as Error;
      }

      // Loud, and not mistakable for `{ reason: "rolled-back" }`.
      expect(err).toBeDefined();
      expect(err?.message).toContain("rollback was REFUSED");
      expect(err?.message).toContain("injected");
      // The interloper's line survived, and so did everything else.
      const after = readFileSync(base, "utf-8");
      expect(after).toContain("live-1");
      expect(after.endsWith(interloper)).toBe(true);
      expect(statSync(base).size).toBeGreaterThan(beforeSize);
      // Every line is still parseable — nothing was cut mid-line.
      for (const line of after.trim().split("\n")) JSON.parse(line);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The other half of the same guard: when the tail really is only ours, the
  // arithmetic holds and the rollback proceeds exactly as before. Without this,
  // the test above would pass just as well against a version that never rolls
  // back at all.
  it("still rolls back when every byte past the rollback point is its own", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      const before = readFileSync(base, "utf-8");
      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: makeDelta(dir, "b3"),
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
        __injectFailure: () => {
          throw new Error("injected");
        },
      });
      expect(r.kind).toBe("declined");
      if (r.kind === "declined") expect(r.reason).toBe("rolled-back");
      expect(readFileSync(base, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-throws a fault that lands before any byte is written, attempting no rollback", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBase(dir);
      const delta = makeDelta(dir, "b3");
      // The base vanishes during preparation: the pre-write re-check faults
      // while `wroteBytes` is still false.
      const run = await loadAppendWithConcurrentWrite(() => rmSync(base));
      let err: Error | undefined;
      try {
        await run({
          basePath: base,
          baseSessionId: "base-sid",
          deltaPath: delta,
          ctx: identityRewriteContext(),
          opNowMs: Date.now(),
          force: false,
        });
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toContain("ENOENT");
      // No rollback was attempted — there was nothing of ours to undo.
      expect(err?.message).not.toContain("rollback");
      expect(existsSync(base)).toBe(false);
    } finally {
      unloadConcurrentWriteMock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the file valid when the base has no trailing newline", async () => {
    const dir = tmp("sesh-append-");
    try {
      const base = makeBaseAt(
        dir,
        "nonl.jsonl",
        [entry("b1", null, "base-sid"), entry("b3", "b1", "base-sid")],
        false // no trailing newline
      );
      const before = readFileSync(base, "utf-8");
      expect(before.endsWith("\n")).toBe(false);
      const r = await tryAppendContinuation({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: makeDelta(dir, "b3"),
        ctx: identityRewriteContext(),
        opNowMs: Date.now(),
        force: false,
      });
      expect(r.kind).toBe("appended");
      const after = readFileSync(base, "utf-8");
      expect(after.startsWith(before)).toBe(true);
      const lines = after
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>); // throws if a line got glued
      expect(lines).toHaveLength(4);
      expect(lines[2].uuid).toBe("d1");
      expect(lines.every((l) => l.sessionId === "base-sid")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adoptHubBranch", () => {
  /**
   * A forked base: b1 -> b2 is the common history, L1 -> L2 the local branch.
   * The hub's branch (H1 -> H2) hangs off the same anchor, b2.
   */
  function makeForkedBase(dir: string, trailingNewline = true): string {
    return makeBaseAt(
      dir,
      "base.jsonl",
      [
        entry("b1", null, "base-sid"),
        entry("b2", "b1", "base-sid"),
        entry("L1", "b2", "base-sid"),
        entry("L2", "L1", "base-sid"),
      ],
      trailingNewline
    );
  }

  function makeHubBranch(dir: string): string {
    const p = join(dir, "delta.jsonl");
    writeJsonl(p, [HEADER, entry("H1", "b2"), entry("H2", "H1")]);
    return p;
  }

  async function anchorOffsetOf(path: string, uuid: string): Promise<number> {
    const { findEntryOffsetByUuid } = await import("../src/jsonl.js");
    const offset = await findEntryOffsetByUuid(path, uuid);
    if (offset === null) throw new Error(`test setup: no ${uuid} in ${path}`);
    return offset;
  }

  it("preserves the full local history, splices the hub branch onto the anchor", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = makeForkedBase(dir);
      const delta = makeHubBranch(dir);
      const anchorOffset = await anchorOffsetOf(base, "b2");
      const preservedPath = join(dir, "preserved.jsonl");

      const r = await adoptHubBranch({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        anchorOffset,
        preservedSessionId: "preserved-sid",
        preservedPath,
        ctx: identityRewriteContext(),
      });
      expect(r.kind).toBe("adopted");
      if (r.kind !== "adopted") return;
      expect(r.newHeadUuid).toBe("H2");
      expect(r.entriesAppended).toBe(2); // the synthetic header is stripped
      expect(r.preservedSessionId).toBe("preserved-sid");

      const baseLines = readFileSync(base, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(baseLines.map((l) => l.uuid)).toEqual(["b1", "b2", "H1", "H2"]);
      expect(baseLines.every((l) => l.sessionId === "base-sid")).toBe(true);
      expect(readFileSync(base, "utf-8")).not.toContain("[sesh-mover continuation]");

      const preservedLines = readFileSync(preservedPath, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      // The FULL local history, not just the divergent tail — a session that
      // starts mid-conversation is the fragment problem all over again.
      expect(preservedLines.map((l) => l.uuid)).toEqual(["b1", "b2", "L1", "L2"]);
      expect(preservedLines.every((l) => l.sessionId === "preserved-sid")).toBe(true);
      // No synthetic marker entry is injected into the preserved transcript.
      expect(readFileSync(preservedPath, "utf-8")).not.toContain("sesh-mover");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Call sites 6-8 of the head reader: the pre-mutation snapshot head (read
  // off the backup), the live-file re-check head, and the post-adopt
  // verification. All three used to be `null` on a bookkeeping-tailed base or
  // delta — and a `null` delta head aborted adoption outright with
  // "continuation bundle has no entries".
  it("adopts across bookkeeping tails on both the base and the hub branch", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = makeBaseAt(dir, "bk-fork.jsonl", [
        entry("b1", null, "base-sid"),
        entry("b2", "b1", "base-sid"),
        entry("L1", "b2", "base-sid"),
        entry("L2", "L1", "base-sid"),
        { type: "mode", mode: "normal", sessionId: "base-sid" },
        { type: "last-prompt", lastPrompt: "hold", leafUuid: "L2", sessionId: "base-sid" },
      ]);
      const delta = join(dir, "bk-hub-branch.jsonl");
      writeJsonl(delta, [
        HEADER,
        entry("H1", "b2"),
        entry("H2", "H1"),
        { type: "permission-mode", permissionMode: "auto", sessionId: "delta-sid" },
      ]);
      const anchorOffset = await anchorOffsetOf(base, "b2");
      const preservedPath = join(dir, "bk-preserved.jsonl");

      const r = await adoptHubBranch({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        anchorOffset,
        preservedSessionId: "preserved-sid",
        preservedPath,
        ctx: identityRewriteContext(),
      });
      expect(r.kind).toBe("adopted");
      if (r.kind !== "adopted") return;
      expect(r.newHeadUuid).toBe("H2"); // post-adopt verify saw past the delta's tail

      const baseLines = readFileSync(base, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(baseLines.map((l) => l.uuid ?? l.type)).toEqual([
        "b1",
        "b2",
        "H1",
        "H2",
        "permission-mode",
      ]);
      // The preserved copy keeps the local branch AND its bookkeeping.
      const preservedLines = readFileSync(preservedPath, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(preservedLines.map((l) => l.uuid ?? l.type)).toEqual([
        "b1",
        "b2",
        "L1",
        "L2",
        "mode",
        "last-prompt",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the base byte-for-byte and writes no preserved file when the splice fails", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = makeForkedBase(dir);
      const delta = makeHubBranch(dir);
      const anchorOffset = await anchorOffsetOf(base, "b2");
      const preservedPath = join(dir, "preserved.jsonl");
      const before = readFileSync(base);

      const r = await adoptHubBranch({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        anchorOffset,
        preservedSessionId: "preserved-sid",
        preservedPath,
        ctx: identityRewriteContext(),
        __injectFailure: () => {
          throw new Error("boom");
        },
      });
      expect(r.kind).toBe("failed");
      if (r.kind !== "failed") return;
      expect(r.detail).toContain("boom");

      expect(readFileSync(base).equals(before)).toBe(true);
      expect(existsSync(preservedPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The twin of tryAppendContinuation's rollback guard, and strictly worse if
  // missing: the restore here OVERWRITES the whole file with a snapshot taken
  // before the adoption began, so a writer that lands in the window the
  // pre-truncate re-check cannot see would be erased outright.
  it("refuses to restore over another writer's bytes, keeping the snapshot for the user", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = makeForkedBase(dir);
      const delta = makeHubBranch(dir);
      const anchorOffset = await anchorOffsetOf(base, "b2");
      const preservedPath = join(dir, "preserved.jsonl");
      const interloper = JSON.stringify(entry("live-1", "H2", "base-sid")) + "\n";

      let err: Error | undefined;
      try {
        await adoptHubBranch({
          basePath: base,
          baseSessionId: "base-sid",
          deltaPath: delta,
          anchorOffset,
          preservedSessionId: "preserved-sid",
          preservedPath,
          ctx: identityRewriteContext(),
          __injectFailure: () => {
            appendFileSync(base, interloper, "utf-8");
            throw new Error("boom");
          },
        });
      } catch (e) {
        err = e as Error;
      }

      expect(err).toBeDefined();
      expect(err?.message).toContain("restore was REFUSED");
      expect(err?.message).toContain("boom");
      const after = readFileSync(base, "utf-8");
      expect(after).toContain("live-1"); // the other writer's bytes survived
      expect(existsSync(preservedPath)).toBe(false);

      // The pre-adoption snapshot is named in the error and still on disk —
      // it is the user's only copy of the branch the truncate cut away.
      const backupPath = /before adoption is at (.+?)\. Exit/.exec(err?.message ?? "")?.[1];
      expect(backupPath).toBeDefined();
      expect(existsSync(backupPath!)).toBe(true);
      expect(readFileSync(backupPath!, "utf-8")).toContain("L2");
      rmSync(backupPath!, { force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The guard findEntryOffsetByUuid's JSDoc demands. Its offset for a file
  // whose final line has no trailing newline is 1 PAST EOF, and truncateSync
  // past EOF does not error — it EXTENDS the file with a NUL byte, producing a
  // corrupt JSONL line with no exception anywhere.
  it("refuses an offset past EOF instead of NUL-extending the base", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = makeForkedBase(dir, false); // final line unterminated
      const delta = makeHubBranch(dir);
      const size = statSync(base).size;
      const anchorOffset = await anchorOffsetOf(base, "L2"); // = size + 1
      expect(anchorOffset).toBe(size + 1);
      const preservedPath = join(dir, "preserved.jsonl");
      const before = readFileSync(base);

      const r = await adoptHubBranch({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        anchorOffset,
        preservedSessionId: "preserved-sid",
        preservedPath,
        ctx: identityRewriteContext(),
      });
      expect(r.kind).toBe("failed");
      if (r.kind !== "failed") return;
      expect(r.detail).toContain("line boundary");

      const after = readFileSync(base);
      expect(after.equals(before)).toBe(true);
      expect(after.includes(0x00)).toBe(false); // no NUL extension
      expect(existsSync(preservedPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The other half of the same guard: findEntryOffsetByUuid undercounts CRLF
  // files by one byte per line, so its offset lands ON the "\n" and truncating
  // there would leave a bare "\r" that glues the anchor line to the first
  // spliced entry.
  it("refuses a CRLF offset that would truncate mid-terminator", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = join(dir, "base.jsonl");
      writeFileSync(
        base,
        [entry("b1", null, "base-sid"), entry("b2", "b1", "base-sid"), entry("L1", "b2", "base-sid")]
          .map((e) => JSON.stringify(e))
          .join("\r\n") + "\r\n",
        "utf-8"
      );
      ageOut(base);
      const delta = makeHubBranch(dir);
      const anchorOffset = await anchorOffsetOf(base, "b2");
      const preservedPath = join(dir, "preserved.jsonl");
      const before = readFileSync(base);

      const r = await adoptHubBranch({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        anchorOffset,
        preservedSessionId: "preserved-sid",
        preservedPath,
        ctx: identityRewriteContext(),
      });
      expect(r.kind).toBe("failed");
      if (r.kind !== "failed") return;
      expect(r.detail).toContain("line boundary");
      expect(readFileSync(base).equals(before)).toBe(true);
      expect(existsSync(preservedPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a delta with unparseable lines before touching the base", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = makeForkedBase(dir);
      const delta = join(dir, "delta.jsonl");
      // Mid-stream, so the chain endpoints still read cleanly and the refusal
      // has to come from the rewrite's parse-failure count.
      writeJsonl(delta, [HEADER, entry("H1", "b2"), "{not json", entry("H2", "H1")]);
      const anchorOffset = await anchorOffsetOf(base, "b2");
      const preservedPath = join(dir, "preserved.jsonl");
      const before = readFileSync(base);

      const r = await adoptHubBranch({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        anchorOffset,
        preservedSessionId: "preserved-sid",
        preservedPath,
        ctx: identityRewriteContext(),
      });
      expect(r.kind).toBe("failed");
      if (r.kind !== "failed") return;
      expect(r.detail).toContain("unparseable");
      expect(readFileSync(base).equals(before)).toBe(true);
      expect(existsSync(preservedPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The mirror of tryAppendContinuation's pre-write re-check, and the reason
  // it matters MORE here: an append that races is merely spliced after entries
  // it doesn't chain to, but a truncate that races DELETES them — and they are
  // not in the backup either, because the backup predates them. Without the
  // re-check the entry vanishes from the base AND the preserved copy, with no
  // error anywhere.
  it("abandons the adoption when the base grows during preparation, leaving the writer's bytes intact", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = makeForkedBase(dir);
      const delta = makeHubBranch(dir);
      const anchorOffset = await anchorOffsetOf(base, "b2");
      const preservedPath = join(dir, "preserved.jsonl");
      const before = readFileSync(base, "utf-8");

      // A live Claude Code session extends the LOCAL branch while we prepare.
      const concurrent = JSON.stringify(entry("L3-LIVE", "L2", "base-sid")) + "\n";
      const run = await loadAdoptWithConcurrentWrite(() =>
        appendFileSync(base, concurrent, "utf-8")
      );
      const r = await run({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        anchorOffset,
        preservedSessionId: "preserved-sid",
        preservedPath,
        ctx: identityRewriteContext(),
      });

      expect(r.kind).toBe("failed");
      if (r.kind !== "failed") return;
      expect(r.detail).toContain("base changed during adoption");
      expect(r.detail).toContain("nothing was written");

      // The live entry is still there, in the file it was written to...
      const after = readFileSync(base, "utf-8");
      expect(after).toBe(before + concurrent);
      expect(after).toContain("L3-LIVE");
      // ...and nothing was spliced or preserved.
      expect(after).not.toContain("H1");
      expect(existsSync(preservedPath)).toBe(false);
    } finally {
      unloadConcurrentWriteMock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Same race, head-preserving shape: a concurrent write that leaves the head
  // uuid alone is still caught, because the size moved.
  it("abandons the adoption when the base grows without moving its head", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = makeForkedBase(dir);
      const delta = makeHubBranch(dir);
      const anchorOffset = await anchorOffsetOf(base, "b2");
      const preservedPath = join(dir, "preserved.jsonl");
      const before = readFileSync(base, "utf-8");

      const concurrent = JSON.stringify(entry("L2", "L1", "base-sid")) + "\n";
      const run = await loadAdoptWithConcurrentWrite(() =>
        appendFileSync(base, concurrent, "utf-8")
      );
      const r = await run({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        anchorOffset,
        preservedSessionId: "preserved-sid",
        preservedPath,
        ctx: identityRewriteContext(),
      });

      expect(r.kind).toBe("failed");
      if (r.kind !== "failed") return;
      expect(r.detail).toContain("base changed during adoption");
      expect(readFileSync(base, "utf-8")).toBe(before + concurrent);
      expect(existsSync(preservedPath)).toBe(false);
    } finally {
      unloadConcurrentWriteMock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when the preserved path already exists, so a rollback can never delete it", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = makeForkedBase(dir);
      const delta = makeHubBranch(dir);
      const anchorOffset = await anchorOffsetOf(base, "b2");
      const preservedPath = join(dir, "preserved.jsonl");
      const squatter = "someone else's file\n";
      writeFileSync(preservedPath, squatter, "utf-8");
      const before = readFileSync(base);

      const r = await adoptHubBranch({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        anchorOffset,
        preservedSessionId: "preserved-sid",
        preservedPath,
        ctx: identityRewriteContext(),
      });

      expect(r.kind).toBe("failed");
      if (r.kind !== "failed") return;
      expect(r.detail).toContain("already exists");
      expect(readFileSync(base).equals(before)).toBe(true);
      expect(readFileSync(preservedPath, "utf-8")).toBe(squatter); // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the caller's rewrite context to the spliced branch, never to the preserved copy", async () => {
    const dir = tmp("sesh-adopt-");
    try {
      const base = makeForkedBase(dir);
      const delta = makeHubBranch(dir);
      const anchorOffset = await anchorOffsetOf(base, "b2");
      const preservedPath = join(dir, "preserved.jsonl");

      // A context that maps the delta's "/p" cwd onto a local path. The
      // preserved copy is local bytes and must NOT be run through it.
      const platform = detectPlatform();
      const ctx = {
        mappings: [{ from: "/p", to: "/local", description: "test" }],
        sourcePlatform: platform,
        targetPlatform: platform,
        sourceUser: "u",
        targetUser: "u",
      };

      const r = await adoptHubBranch({
        basePath: base,
        baseSessionId: "base-sid",
        deltaPath: delta,
        anchorOffset,
        preservedSessionId: "preserved-sid",
        preservedPath,
        ctx,
      });
      expect(r.kind).toBe("adopted");

      const baseLines = readFileSync(base, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(baseLines[2].cwd).toBe("/local"); // spliced entries translated
      expect(baseLines[0].cwd).toBe("/p"); // pre-anchor history untouched

      const preservedLines = readFileSync(preservedPath, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(preservedLines.every((l) => l.cwd === "/p")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
