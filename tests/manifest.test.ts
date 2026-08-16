import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExportManifest } from "../src/types.js";

describe("manifest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-manifest-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeTestManifest(): ExportManifest {
    return {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: "2026-04-11T14:32:00Z",
      sourcePlatform: "darwin",
      sourceProjectPath: "/Users/sascha/Projects/foo",
      sourceConfigDir: "/Users/sascha/.claude",
      sourceClaudeVersion: "2.1.81",
      sessionScope: "current",
      includedLayers: ["jsonl", "subagents", "memory"],
      sessions: [
        {
          sessionId: "abc-123",
          slug: "test-session",
          summary: "A test session",
          createdAt: "2026-04-11T12:00:00Z",
          lastActiveAt: "2026-04-11T14:00:00Z",
          messageCount: 10,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash: "sha256:abc123",
        },
      ],
    };
  }

  describe("writeManifest / readManifest", () => {
    it("round-trips a manifest to disk, stamping the sessions digest", async () => {
      const { writeManifest, readManifest, computeSessionsDigest } = await import(
        "../src/manifest.js"
      );
      const manifest = makeTestManifest();
      writeManifest(tempDir, manifest);
      const readBack = readManifest(tempDir);
      // writeManifest is the single place the digest is computed, so a caller
      // that edits the session list can never leave a stale one behind — and
      // the input object is not mutated on the way through.
      expect(manifest.sessionsDigest).toBeUndefined();
      expect(readBack).toEqual({
        ...manifest,
        sessionsDigest: computeSessionsDigest(manifest.sessions),
      });
    });
  });

  describe("computeIntegrityHash", () => {
    it("returns consistent sha256 hash for same content", async () => {
      const { computeIntegrityHash } = await import("../src/manifest.js");
      const hash1 = computeIntegrityHash(["line1\n", "line2\n"]);
      const hash2 = computeIntegrityHash(["line1\n", "line2\n"]);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("returns different hash for different content", async () => {
      const { computeIntegrityHash } = await import("../src/manifest.js");
      const hash1 = computeIntegrityHash(["line1\n"]);
      const hash2 = computeIntegrityHash(["line2\n"]);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("verifyIntegrity", () => {
    it("returns true when hash matches", async () => {
      const { computeIntegrityHash, verifyIntegrity } = await import(
        "../src/manifest.js"
      );
      const content = ["line1\n", "line2\n"];
      const hash = computeIntegrityHash(content);
      expect(verifyIntegrity(content, hash)).toBe(true);
    });

    it("returns false when hash mismatches", async () => {
      const { verifyIntegrity } = await import("../src/manifest.js");
      expect(verifyIntegrity(["line1\n"], "sha256:wrong")).toBe(false);
    });
  });

  it("readManifest tolerates older manifests without sourceMachineId / incremental", async () => {
    const { readManifest } = await import("../src/manifest.js");
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "sesh-mover-manifest-compat-"));
    try {
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
          version: 1,
          plugin: "sesh-mover",
          exportedAt: "2026-04-19T00:00:00Z",
          sourcePlatform: "darwin",
          sourceProjectPath: "/p",
          sourceConfigDir: "/c",
          sourceClaudeVersion: "2.1.114",
          sessionScope: "current",
          includedLayers: ["jsonl"],
          sessions: [
            {
              sessionId: "s1",
              slug: "s",
              summary: "",
              createdAt: "",
              lastActiveAt: "",
              messageCount: 1,
              gitBranch: "",
              entrypoint: "cli",
              integrityHash: "sha256:abc",
            },
          ],
        })
      );
      const m = readManifest(dir);
      expect(m.sourceMachineId).toBeUndefined();
      expect(m.incremental).toBeUndefined();
      expect(m.sessions[0].type).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("assertSafeManifestIds / readManifest validation", () => {
    function manifestWithSessionId(id: string): ExportManifest {
      return {
        version: 1,
        plugin: "sesh-mover",
        exportedAt: "2026-07-14T00:00:00Z",
        sourcePlatform: "linux",
        sourceProjectPath: "/p",
        sourceConfigDir: "/c",
        sourceClaudeVersion: "2.1.114",
        sessionScope: "current",
        includedLayers: ["jsonl"],
        sessions: [
          {
            sessionId: id,
            slug: "s",
            summary: "",
            createdAt: "",
            lastActiveAt: "",
            messageCount: 1,
            gitBranch: "",
            entrypoint: "cli",
            integrityHash: "sha256:x",
          },
        ],
      };
    }

    it("isSafeSessionId accepts UUIDs, rejects traversal and separators", async () => {
      const { isSafeSessionId } = await import("../src/manifest.js");
      expect(isSafeSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
      for (const bad of [
        "../../secret/pwned",
        "..",
        ".",
        "a/b",
        "a\\b",
        "..\\..\\x",
        "foo/../bar",
        "",
        "x\0y",
      ]) {
        expect(isSafeSessionId(bad)).toBe(false);
      }
    });

    it("readManifest throws on a traversal sessionId", async () => {
      const { readManifest, writeManifest } = await import("../src/manifest.js");
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "sesh-mover-mal-manifest-"));
      try {
        // write bypasses validation intentionally (raw), so craft the file directly
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          join(dir, "manifest.json"),
          JSON.stringify(manifestWithSessionId("../../secret/pwned"))
        );
        expect(() => readManifest(dir)).toThrow(/unsafe session id/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("readManifest throws on a traversal continuesLocalSessionId", async () => {
      const { readManifest } = await import("../src/manifest.js");
      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "sesh-mover-mal-cont-"));
      try {
        const m = manifestWithSessionId("550e8400-e29b-41d4-a716-446655440000");
        m.sessions[0].type = "continuation";
        m.sessions[0].continuation = {
          continuesLocalSessionId: "../../../etc/shadow",
          fromEntryIndex: 0,
          fromEntryUuid: "u",
        };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
        expect(() => readManifest(dir)).toThrow(/unsafe session id/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("computeIntegrityHashFromFile", () => {
    it("matches the string-based hash for the same content (old bundles keep verifying)", async () => {
      const { computeIntegrityHash, computeIntegrityHashFromFile } = await import("../src/manifest.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-hash-"));
      try {
        const content = '{"uuid":"a","type":"user"}\n{"uuid":"b","type":"assistant"}\n';
        const file = join(dir, "s.jsonl");
        writeFileSync(file, content, "utf-8");
        expect(await computeIntegrityHashFromFile(file)).toBe(
          computeIntegrityHash([content])
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("computeLayerDigest", () => {
    // The gap this closes: until 0.6.0 only session JSONL carried a hash, so a
    // corrupted file-history backup rode through import silently and was later
    // restored over the user's own file.
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "sesh-layer-"));
      mkdirSync(join(dir, "file-history"), { recursive: true });
      writeFileSync(join(dir, "file-history", "aaa@v1"), "backup one\n");
      writeFileSync(join(dir, "file-history", "bbb@v1"), "backup two\n");
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("is null for a directory that does not exist, and stable for one that does", async () => {
      const { computeLayerDigest } = await import("../src/manifest.js");
      expect(await computeLayerDigest(join(dir, "nope"))).toBeNull();
      const a = await computeLayerDigest(join(dir, "file-history"));
      const b = await computeLayerDigest(join(dir, "file-history"));
      expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(a).toBe(b);
    });

    it("changes when a file's CONTENT changes, at identical name and size", async () => {
      const { computeLayerDigest } = await import("../src/manifest.js");
      const before = await computeLayerDigest(join(dir, "file-history"));
      writeFileSync(join(dir, "file-history", "aaa@v1"), "backup 0ne\n"); // same length
      expect(await computeLayerDigest(join(dir, "file-history"))).not.toBe(before);
    });

    it("changes when a file is added or removed", async () => {
      const { computeLayerDigest } = await import("../src/manifest.js");
      const before = await computeLayerDigest(join(dir, "file-history"));
      writeFileSync(join(dir, "file-history", "ccc@v1"), "backup three\n");
      const added = await computeLayerDigest(join(dir, "file-history"));
      expect(added).not.toBe(before);
      rmSync(join(dir, "file-history", "ccc@v1"));
      rmSync(join(dir, "file-history", "bbb@v1"));
      expect(await computeLayerDigest(join(dir, "file-history"))).not.toBe(before);
    });

    it("ignores directories, so it covers exactly the flat file set the copy paths copy", async () => {
      const { computeLayerDigest } = await import("../src/manifest.js");
      const before = await computeLayerDigest(join(dir, "file-history"));
      mkdirSync(join(dir, "file-history", "sub"));
      writeFileSync(join(dir, "file-history", "sub", "x"), "ignored\n");
      expect(await computeLayerDigest(join(dir, "file-history"))).toBe(before);
    });
  });

  describe("computeSessionsDigest", () => {
    it("is independent of key order and of array identity", async () => {
      const { computeSessionsDigest } = await import("../src/manifest.js");
      const a = makeTestManifest().sessions;
      const reordered = a.map((s) => {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(s).reverse()) out[k] = (s as Record<string, unknown>)[k];
        return out as unknown as (typeof a)[number];
      });
      expect(computeSessionsDigest(reordered)).toBe(computeSessionsDigest(a));
    });

    it("treats an absent optional field and an explicitly-undefined one as the same", async () => {
      const { computeSessionsDigest } = await import("../src/manifest.js");
      // The export path builds `type: incremental ? "full" : undefined`, which
      // JSON.stringify drops on the way to disk. The digest is computed over
      // the in-memory object at write time and over the parsed one at read
      // time, so those two spellings have to agree or every bundle would fail
      // its own check on import.
      const withUndefined = makeTestManifest().sessions.map((s) => ({ ...s, type: undefined }));
      expect(computeSessionsDigest(withUndefined)).toBe(
        computeSessionsDigest(makeTestManifest().sessions)
      );
    });

    it("changes when any declared hash, layer digest or count changes", async () => {
      const { computeSessionsDigest } = await import("../src/manifest.js");
      const base = computeSessionsDigest(makeTestManifest().sessions);

      const rehashed = makeTestManifest().sessions;
      rehashed[0].integrityHash = "sha256:deadbeef";
      expect(computeSessionsDigest(rehashed)).not.toBe(base);

      const relayered = makeTestManifest().sessions;
      relayered[0].layerDigests = { "file-history": "sha256:cafe" };
      expect(computeSessionsDigest(relayered)).not.toBe(base);

      // The case per-session hashes structurally cannot catch: a session record
      // dropped from the inventory. Every surviving record still verifies.
      expect(computeSessionsDigest([])).not.toBe(base);
    });
  });

  describe("verifySessionsDigest", () => {
    it("passes a pre-0.6.0 manifest that declares no digest at all", async () => {
      const { verifySessionsDigest } = await import("../src/manifest.js");
      expect(verifySessionsDigest(makeTestManifest())).toBeNull();
    });

    it("passes a stamped manifest and names the mismatch on an edited one", async () => {
      const { verifySessionsDigest, computeSessionsDigest } = await import(
        "../src/manifest.js"
      );
      const m = makeTestManifest();
      m.sessionsDigest = computeSessionsDigest(m.sessions);
      expect(verifySessionsDigest(m)).toBeNull();
      m.sessions[0].messageCount = 999;
      expect(verifySessionsDigest(m)).toMatch(/hashes to sha256:/);
    });
  });

  /**
   * #53 changed what `includedLayers` MEANS (policy → content) and added a
   * bundle-level `memoryDigest`. Both are outside `computeSessionsDigest`,
   * which covers `manifest.sessions` and nothing else — so no bundle written
   * before either change can be retroactively invalidated. This is the pin on
   * that, because "widening the digest would make every hub bundle fail its own
   * check" is a mistake with no loud failure mode at the site that makes it.
   */
  describe("bundle-level layer fields are outside the sessions digest (#53)", () => {
    it("a bundle written before the change still verifies against its own digest", async () => {
      const { readManifest, verifySessionsDigest, computeSessionsDigest } = await import(
        "../src/manifest.js"
      );
      // A pre-#53 hub bundle, verbatim in shape: `includedLayers` declaring the
      // two whole-file layers the bundle demonstrably does not carry, and no
      // `memoryDigest` field at all.
      const sessions = [
        {
          sessionId: "s1",
          slug: "s",
          summary: "",
          createdAt: "2026-07-21T00:00:00Z",
          lastActiveAt: "2026-07-21T00:00:00Z",
          messageCount: 3,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash: "sha256:deadbeef",
          type: "full" as const,
        },
      ];
      writeFileSync(
        join(tempDir, "manifest.json"),
        JSON.stringify({
          version: 1,
          plugin: "sesh-mover",
          exportedAt: "2026-07-21T00:00:00Z",
          sourcePlatform: "linux",
          sourceProjectPath: "/p",
          sourceConfigDir: "/c",
          sourceClaudeVersion: "2.1.114",
          sessionScope: "all",
          includedLayers: [
            "jsonl",
            "subagents",
            "file-history",
            "tool-results",
            "memory",
            "plans",
          ],
          sessions,
          sessionsDigest: computeSessionsDigest(sessions),
          incremental: true,
        })
      );
      const m = readManifest(tempDir);
      expect(m.includedLayers).toContain("memory");
      expect(m.memoryDigest).toBeUndefined();
      expect(verifySessionsDigest(m)).toBeNull();
    });

    it("neither field participates in the digest, however it is edited", async () => {
      const { computeSessionsDigest, verifySessionsDigest, writeManifest, readManifest } =
        await import("../src/manifest.js");
      const m = makeTestManifest();
      const before = computeSessionsDigest(m.sessions);

      m.includedLayers = [];
      m.memoryDigest = "sha256:" + "0".repeat(64);
      expect(computeSessionsDigest(m.sessions)).toBe(before);

      // ...and through the real write/read path, where the stamp happens.
      writeManifest(tempDir, m);
      const readBack = readManifest(tempDir);
      expect(readBack.sessionsDigest).toBe(before);
      expect(readBack.memoryDigest).toBe(m.memoryDigest);
      expect(verifySessionsDigest(readBack)).toBeNull();

      // A session-list edit still moves it — the digest is narrow, not inert.
      readBack.sessions[0].messageCount = 11;
      expect(verifySessionsDigest(readBack)).toMatch(/hashes to sha256:/);
    });
  });
});
