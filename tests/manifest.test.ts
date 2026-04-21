import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
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
    it("round-trips a manifest to disk", async () => {
      const { writeManifest, readManifest } = await import(
        "../src/manifest.js"
      );
      const manifest = makeTestManifest();
      writeManifest(tempDir, manifest);
      const readBack = readManifest(tempDir);
      expect(readBack).toEqual(manifest);
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
});
