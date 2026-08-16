import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

describe("exporter", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-exporter-test-"));
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("exportSession", () => {
    it("exports a single session with all layers", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-output");
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "test-export",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessions).toHaveLength(1);

      // Verify exported files
      const exportPath = result.exportPath;
      expect(existsSync(join(exportPath, "manifest.json"))).toBe(true);
      expect(existsSync(join(exportPath, "sessions", `${sessionId}.jsonl`))).toBe(true);
      expect(existsSync(join(exportPath, "memory", "MEMORY.md"))).toBe(true);
      expect(existsSync(join(exportPath, "memory", "test_memory.md"))).toBe(true);

      // Verify manifest
      const manifest = JSON.parse(
        readFileSync(join(exportPath, "manifest.json"), "utf-8")
      );
      expect(manifest.version).toBe(1);
      expect(manifest.plugin).toBe("sesh-mover");
      expect(manifest.sessions[0].sessionId).toBe(sessionId);
      expect(manifest.sessions[0].integrityHash).toMatch(/^sha256:/);
    });

    it("respects layer exclusions", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-no-history");
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "no-history",
        excludeLayers: ["file-history", "plans"],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        existsSync(join(result.exportPath, "file-history"))
      ).toBe(false);
      expect(existsSync(join(result.exportPath, "plans"))).toBe(false);
      expect(
        existsSync(join(result.exportPath, "sessions", `${sessionId}.jsonl`))
      ).toBe(true);
    });

    it("detects name collision", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-collision");

      // First export
      await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "same-name",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      // Second export with same name
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "same-name",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        collisionCheck: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.collision).toBe(true);
    });

    it("uses slug-only summaries when noSummary is set (generic slug)", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const { writeFileSync } = await import("node:fs");
      const genId = "770e8400-e29b-41d4-a716-446655440000";
      writeFileSync(
        join(configDir, "projects", "-Users-testuser-Projects-testproject", `${genId}.jsonl`),
        JSON.stringify({
          uuid: "g1",
          timestamp: "2026-07-13T00:00:00Z",
          sessionId: genId,
          cwd: "/Users/testuser/Projects/testproject",
          version: "2.1.81",
          slug: "new-session",
          type: "user",
          message: { role: "user", content: "SECRET first message" },
        }) + "\n"
      );
      const outputDir = join(tempDir, "export-nosummary");
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId: genId,
        outputDir,
        name: "nosummary",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        noSummary: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const manifest = JSON.parse(
        readFileSync(join(result.exportPath, "manifest.json"), "utf-8")
      );
      expect(manifest.sessions[0].summary).toBe("new-session");
      expect(JSON.stringify(manifest)).not.toContain("SECRET");
    });
  });

  describe("exportAllSessions", () => {
    it("exports all sessions for a project", async () => {
      const { exportAllSessions } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-all");
      const result = await exportAllSessions({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "all-sessions",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    });

    // Extra fixture sessions for the sessionIds filter tests below.
    function writeExtraSession(id: string, slug: string): void {
      writeFileSync(
        join(configDir, "projects", "-Users-testuser-Projects-testproject", `${id}.jsonl`),
        JSON.stringify({
          uuid: `${slug}-e1`,
          timestamp: "2026-07-20T00:00:00Z",
          sessionId: id,
          cwd: "/Users/testuser/Projects/testproject",
          version: "2.1.81",
          slug,
          type: "user",
          message: { role: "user", content: `hello from ${slug}` },
        }) + "\n"
      );
    }

    it("sessionIds filters the export to exactly the requested subset", async () => {
      const { exportAllSessions } = await import("../src/exporter.js");
      const idB = "660e8400-e29b-41d4-a716-446655440001";
      const idC = "660e8400-e29b-41d4-a716-446655440002";
      writeExtraSession(idB, "session-b");
      writeExtraSession(idC, "session-c");

      const outputDir = join(tempDir, "export-subset");
      const result = await exportAllSessions({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "subset",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        sessionIds: [sessionId, idB],
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessions.map((s) => s.originalId).sort()).toEqual(
        [sessionId, idB].sort()
      );
      const manifest = JSON.parse(
        readFileSync(join(result.exportPath, "manifest.json"), "utf-8")
      );
      expect(manifest.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(
        [sessionId, idB].sort()
      );
      expect(existsSync(join(result.exportPath, "sessions", `${idC}.jsonl`))).toBe(false);
    });

    it("sessionIds with a missing id returns an error naming it", async () => {
      const { exportAllSessions } = await import("../src/exporter.js");
      const outputDir = join(tempDir, "export-subset-missing");
      const result = await exportAllSessions({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "subset-missing",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        sessionIds: [sessionId, "00000000-0000-0000-0000-00000000dead"],
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("Session 00000000-0000-0000-0000-00000000dead not found");
    });
  });

  it("incremental export emits continuation session for a session with new entries", async () => {
    const { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { readManifest } = await import("../src/manifest.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-inc-export-"));
    try {
      const fx = createFixtureTree(tempDir);
      const outputDir = join(tempDir, "exports");
      mkdirSync(outputDir, { recursive: true });

      const result = await exportAllSessions({
        configDir: fx.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "inc-test",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {
            [fx.sessionId]: {
              headEntryUuid: "entry-2",
              messageCount: 2,
              sentAsType: "full",
              sentAsSessionId: fx.sessionId,
            },
          },
        },
      });

      expect(result.success).toBe(true);
      const manifest = readManifest((result as { exportPath: string }).exportPath);
      expect(manifest.incremental).toBe(true);
      expect(manifest.sourceMachineId).toBe("machine-A");
      expect(manifest.baseline?.targetMachineId).toBe("machine-B");
      expect(manifest.sessions.length).toBe(1);
      const s = manifest.sessions[0];
      expect(s.type).toBe("continuation");
      expect(s.continuation?.fromEntryIndex).toBe(2);
      expect(s.continuation?.fromEntryUuid).toBe("entry-3");
      // The anchor is the head this delta was diffed AGAINST — the peerSent
      // record's own headEntryUuid, and the parent of the first entry shipped.
      // It is what the hub's index record links on; fromEntryUuid above is its
      // child and links nothing (#35 / spec §0b).
      expect(s.continuation?.anchorEntryUuid).toBe("entry-2");
      expect(s.continuation?.continuesLocalSessionId).toBe(fx.sessionId);

      // The manifest is stamped by writeManifest, which recomputes
      // sessionsDigest over whatever the session list then holds — so the new
      // field is INSIDE the digest and the manifest still verifies against
      // itself. A back-filled or defaulted anchor between read and verify would
      // break exactly this.
      const { verifySessionsDigest } = await import("../src/manifest.js");
      expect(manifest.sessionsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(verifySessionsDigest(manifest)).toBeNull();

      const jsonlPath = join(
        (result as { exportPath: string }).exportPath,
        "sessions",
        `${s.sessionId}.jsonl`
      );
      expect(existsSync(jsonlPath)).toBe(true);
      const firstLine = JSON.parse(
        readFileSync(jsonlPath, "utf-8").split("\n")[0]
      );
      expect(firstLine.message.content).toContain("[sesh-mover continuation]");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("incremental export skips unchanged sessions", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { readManifest } = await import("../src/manifest.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-inc-unchanged-"));
    try {
      const fx = createFixtureTree(tempDir);
      const outputDir = join(tempDir, "exports");
      mkdirSync(outputDir, { recursive: true });

      const result = await exportAllSessions({
        configDir: fx.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "inc-unchanged",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {
            [fx.sessionId]: {
              headEntryUuid: "entry-3",
              messageCount: 3,
              sentAsType: "full",
              sentAsSessionId: fx.sessionId,
            },
          },
        },
      });

      expect(result.success).toBe(true);
      const manifest = readManifest((result as { exportPath: string }).exportPath);
      expect(manifest.sessions.length).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("incremental continuation export includes subagents, tool-results, and file-history layers", async () => {
    const { mkdtempSync, rmSync, existsSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { readManifest } = await import("../src/manifest.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-cont-layers-"));
    try {
      const fx = createFixtureTree(tempDir);
      const outputDir = join(tempDir, "exports");
      mkdirSync(outputDir, { recursive: true });

      const result = await exportAllSessions({
        configDir: fx.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "cont-layers",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {
            [fx.sessionId]: {
              headEntryUuid: "entry-2",
              messageCount: 2,
              sentAsType: "full",
              sentAsSessionId: fx.sessionId,
            },
          },
        },
      });
      expect(result.success).toBe(true);
      const exportPath = (result as { exportPath: string }).exportPath;
      const manifest = readManifest(exportPath);
      const cont = manifest.sessions.find((s) => s.type === "continuation")!;
      expect(cont).toBeDefined();

      // Fixture has all three layers populated for the source session.
      expect(
        existsSync(join(exportPath, "sessions", cont.sessionId, "subagents", "agent-sub1.jsonl"))
      ).toBe(true);
      expect(
        existsSync(join(exportPath, "sessions", cont.sessionId, "tool-results", "toolu_test.txt"))
      ).toBe(true);
      expect(
        existsSync(join(exportPath, "file-history", cont.sessionId, "abc123@v1"))
      ).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --- #53: the manifest must declare what the bundle carries, and memory
  // --- must actually reach an incremental bundle.

  describe("declared layers vs carried layers", () => {
    it("plain export: includedLayers equals the layers on disk, and every layer is there", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const { readManifest } = await import("../src/manifest.js");
      const outputDir = join(tempDir, "layers-full");
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "full",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      // The fixture populates all six, so this is also the "nothing silently
      // went missing" assertion.
      expect(layersOnDisk(result.exportPath)).toEqual([
        "jsonl",
        "subagents",
        "file-history",
        "tool-results",
        "memory",
        "plans",
      ]);
      expect(readManifest(result.exportPath).includedLayers).toEqual(
        layersOnDisk(result.exportPath)
      );
      expect(result.sessions[0].exportedLayers).toEqual(layersOnDisk(result.exportPath));
    });

    it("--exclude: includedLayers equals the layers on disk, excluded ones in neither", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const { readManifest } = await import("../src/manifest.js");
      const outputDir = join(tempDir, "layers-excluded");
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "excluded",
        excludeLayers: ["file-history", "plans", "memory"],
        claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const onDisk = layersOnDisk(result.exportPath);
      expect(onDisk).toEqual(["jsonl", "subagents", "tool-results"]);
      const manifest = readManifest(result.exportPath);
      expect(manifest.includedLayers).toEqual(onDisk);
      expect(manifest.memoryDigest).toBeUndefined();
      expect(result.sessions[0].exportedLayers).toEqual(onDisk);
    });

    it("a layer the source does not have is not declared either", async () => {
      const { exportSession } = await import("../src/exporter.js");
      const { readManifest } = await import("../src/manifest.js");
      // Requested, but absent at the source: the old code declared it anyway,
      // because the list was policy rather than content.
      rmSync(join(configDir, "projects", ENCODED, sessionId, "subagents"), {
        recursive: true,
        force: true,
      });
      const outputDir = join(tempDir, "layers-missing-source");
      const result = await exportSession({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir,
        name: "missing-source",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const onDisk = layersOnDisk(result.exportPath);
      expect(onDisk).not.toContain("subagents");
      expect(readManifest(result.exportPath).includedLayers).toEqual(onDisk);
    });
  });

  describe("incremental export and the whole-file layers", () => {
    // The peerSent record the fixture's session is at the head of, so every
    // test here produces an incremental bundle with NO new session content and
    // the memory decision is the only thing under test.
    const atHead = (id: string) => ({
      [id]: {
        headEntryUuid: "entry-3",
        messageCount: 3,
        sentAsType: "full" as const,
        sentAsSessionId: id,
      },
    });

    async function incrementalExport(
      name: string,
      peerMemoryDigest?: string | null
    ) {
      const { exportAllSessions } = await import("../src/exporter.js");
      const outputDir = join(tempDir, name);
      const result = await exportAllSessions({
        configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name,
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: atHead(sessionId),
          peerMemoryDigest,
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("export failed");
      return result;
    }

    it("nothing known about the peer: memory ships and is declared", async () => {
      const { readManifest } = await import("../src/manifest.js");
      const result = await incrementalExport("inc-memory-first");

      // The regression this whole issue is about: an incremental bundle used
      // to carry no memory at all, on any push, ever.
      expect(existsSync(join(result.exportPath, "memory", "MEMORY.md"))).toBe(true);
      expect(existsSync(join(result.exportPath, "memory", "test_memory.md"))).toBe(true);

      const manifest = readManifest(result.exportPath);
      expect(manifest.includedLayers).toContain("memory");
      expect(manifest.includedLayers).toEqual(layersOnDisk(result.exportPath));
      expect(manifest.memoryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("peer already holds this exact memory: skipped, and not declared", async () => {
      const { readManifest } = await import("../src/manifest.js");
      const first = await incrementalExport("inc-memory-a");
      const digest = readManifest(first.exportPath).memoryDigest!;

      const second = await incrementalExport("inc-memory-b", digest);
      expect(existsSync(join(second.exportPath, "memory"))).toBe(false);
      const manifest = readManifest(second.exportPath);
      expect(manifest.includedLayers).not.toContain("memory");
      expect(manifest.includedLayers).toEqual(layersOnDisk(second.exportPath));
      // Nothing was shipped, so nothing may be credited to the peer.
      expect(manifest.memoryDigest).toBeUndefined();
    });

    it("memory changed since that digest: ships again, with a new digest", async () => {
      const { readManifest } = await import("../src/manifest.js");
      const first = await incrementalExport("inc-memory-c");
      const digest = readManifest(first.exportPath).memoryDigest!;

      writeFileSync(
        join(configDir, "projects", ENCODED, "memory", "test_memory.md"),
        "---\nname: Test memory\n---\n\nSomething new was learned.\n"
      );

      const second = await incrementalExport("inc-memory-d", digest);
      expect(existsSync(join(second.exportPath, "memory", "test_memory.md"))).toBe(true);
      expect(
        readFileSync(join(second.exportPath, "memory", "test_memory.md"), "utf-8")
      ).toContain("Something new was learned.");
      const manifest = readManifest(second.exportPath);
      expect(manifest.includedLayers).toContain("memory");
      expect(manifest.memoryDigest).toBeDefined();
      expect(manifest.memoryDigest).not.toBe(digest);
    });

    it("memory digest describes the BUNDLE's copy, not the live source", async () => {
      const { readManifest } = await import("../src/manifest.js");
      const { computeLayerDigest } = await import("../src/manifest.js");
      const result = await incrementalExport("inc-memory-bundle-digest");
      expect(readManifest(result.exportPath).memoryDigest).toBe(
        await computeLayerDigest(join(result.exportPath, "memory"))
      );
    });

    it("plans stay off the incremental path, and the manifest says so", async () => {
      const { readManifest } = await import("../src/manifest.js");
      const result = await incrementalExport("inc-plans");
      // Deliberate: <configDir>/plans is config-global with no project filter,
      // so an incremental (hub) bundle would ship every plan on the machine to
      // a shared directory via the unattended auto-push. Deferred until the
      // payload is scoped — but no longer advertised.
      expect(existsSync(join(result.exportPath, "plans"))).toBe(false);
      const manifest = readManifest(result.exportPath);
      expect(manifest.includedLayers).not.toContain("plans");
      expect(manifest.includedLayers).toEqual(layersOnDisk(result.exportPath));
    });
  });
});

const ENCODED = "-Users-testuser-Projects-testproject";

const ALL_LAYERS = [
  "jsonl",
  "subagents",
  "file-history",
  "tool-results",
  "memory",
  "plans",
] as const;

/**
 * The layers a bundle ACTUALLY carries, read off the extracted/staged bundle
 * directory rather than out of its manifest. Deliberately an independent
 * re-derivation: asserting the manifest against itself would have passed
 * throughout #53's entire lifetime.
 */
function layersOnDisk(exportPath: string): string[] {
  const found = new Set<string>();
  const sessionsDir = join(exportPath, "sessions");
  if (existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir)) {
      const p = join(sessionsDir, name);
      if (statSync(p).isFile()) {
        if (name.endsWith(".jsonl")) found.add("jsonl");
        continue;
      }
      if (existsSync(join(p, "subagents"))) found.add("subagents");
      if (existsSync(join(p, "tool-results"))) found.add("tool-results");
    }
  }
  const fileHistory = join(exportPath, "file-history");
  if (existsSync(fileHistory) && readdirSync(fileHistory).length > 0) found.add("file-history");
  if (existsSync(join(exportPath, "memory"))) found.add("memory");
  if (existsSync(join(exportPath, "plans"))) found.add("plans");
  return ALL_LAYERS.filter((l) => found.has(l));
}
