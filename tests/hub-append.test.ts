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
  tryAppendContinuation,
  readDeltaChainInfo,
  identityRewriteContext,
  APPEND_LIVE_WINDOW_MS,
} from "../src/hub/append.js";
import { buildImportRewriteContext } from "../src/rewriter.js";
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
async function loadAppendWithConcurrentWrite(
  write: () => void
): Promise<typeof import("../src/hub/append.js").tryAppendContinuation> {
  vi.resetModules();
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
        write();
        return report;
      },
    };
  });
  const mod = await import("../src/hub/append.js");
  return mod.tryAppendContinuation;
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
