import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import type {
  ExportResult,
  ImportResult,
  DryRunResult,
  ErrorResult,
  ProgressEvent,
} from "../src/types.js";

describe("importer", () => {
  let tempDir: string;
  let sourceConfigDir: string;
  let targetConfigDir: string;
  let sessionId: string;
  let exportPath: string;
  let homeOverride: HomeOverrideHandle;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-importer-test-"));
    homeOverride = overrideHome(tempDir);

    // Create source fixture and export it
    const fixture = createFixtureTree(tempDir);
    sourceConfigDir = fixture.configDir;
    sessionId = fixture.sessionId;

    const { exportSession } = await import("../src/exporter.js");
    const exportDir = join(tempDir, "exports");
    const result = await exportSession({
      configDir: sourceConfigDir,
      projectPath: "/Users/testuser/Projects/testproject",
      sessionId,
      outputDir: exportDir,
      name: "test-export",
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });

    if (!result.success) throw new Error("Export failed in test setup");
    exportPath = (result as ExportResult).exportPath;

    // Create empty target config dir
    targetConfigDir = join(tempDir, "target-claude");
    mkdirSync(join(targetConfigDir, "projects"), { recursive: true });
  });

  afterEach(() => {
    homeOverride.restore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("importSession", () => {
    it("imports a session to a new project path", async () => {
      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.importedSessions).toHaveLength(1);
      expect(result.importedSessions[0].originalId).toBe(sessionId);
      expect(result.importedSessions[0].newId).not.toBe(sessionId);

      // Verify files exist in target
      const encoded = "-Users-newuser-Projects-newproject";
      const newId = result.importedSessions[0].newId;
      expect(
        existsSync(
          join(targetConfigDir, "projects", encoded, `${newId}.jsonl`)
        )
      ).toBe(true);

      // Verify path rewriting
      const jsonl = readFileSync(
        join(targetConfigDir, "projects", encoded, `${newId}.jsonl`),
        "utf-8"
      );
      expect(jsonl).toContain("/Users/newuser/Projects/newproject");
      expect(jsonl).not.toContain("/Users/testuser/Projects/testproject");
    });

    it("emits import-verify and import-rewrite progress with session context", async () => {
      const { importSession } = await import("../src/importer.js");
      const events: ProgressEvent[] = [];
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
        onProgress: (ev) => events.push(ev),
      });
      expect(result.success).toBe(true);
      expect(
        events.some((e) => e.phase === "import-verify" && e.sessionCount === 1)
      ).toBe(true);
      const rewrites = events.filter((e) => e.phase === "import-rewrite");
      expect(rewrites.length).toBeGreaterThan(0);
      expect(rewrites[rewrites.length - 1].percent).toBe(100);
      // throttled: no more events than distinct integer percents + phase starts
      expect(rewrites.length).toBeLessThanOrEqual(101);
    });

    it("dry-run returns report without writing", async () => {
      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect((result as DryRunResult).dryRun).toBe(true);
      // Verify nothing was written
      const encoded = "-Users-newuser-Projects-newproject";
      expect(
        existsSync(join(targetConfigDir, "projects", encoded))
      ).toBe(false);
    });

    it("imports specific sessions from multi-session export", async () => {
      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
        sessionIds: [sessionId],
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.importedSessions).toHaveLength(1);
    });

    // --- Shared-namespace auxiliary layers: memory/ and plans/ (#49) ---
    //
    // The fixture bundle carries memory/MEMORY.md (one pointer line, target
    // `test_memory.md`) and memory/test_memory.md, plus plans/test-plan.md.
    //
    // The predecessor of this block was titled "merges memory files without
    // overwriting existing" and seeded `existing.md` — a name the bundle does
    // NOT contain — so it only ever exercised copy-if-absent. The conflict
    // branch had zero coverage, which is how a live import came to land ten
    // memory files and strand every one of them.
    const TARGET_PROJECT = "/Users/newuser/Projects/newproject";
    const targetMemDir = () =>
      join(targetConfigDir, "projects", "-Users-newuser-Projects-newproject", "memory");
    const seedMemory = (name: string, content: string) => {
      mkdirSync(targetMemDir(), { recursive: true });
      writeFileSync(join(targetMemDir(), name), content);
    };
    const readMemory = (name: string) => readFileSync(join(targetMemDir(), name), "utf-8");
    const runImport = async (opts?: { dryRun?: boolean; from?: string }) => {
      const { importSession } = await import("../src/importer.js");
      return importSession({
        exportPath: opts?.from ?? exportPath,
        targetConfigDir,
        targetProjectPath: TARGET_PROJECT,
        targetClaudeVersion: "2.1.81",
        dryRun: opts?.dryRun ?? false,
      });
    };
    /**
     * Re-export the fixture session after planting extra files in the SOURCE
     * memory directory, so a bundle with a different memory layer is produced
     * by the real exporter rather than hand-assembled.
     */
    const exportWithMemory = async (
      files: Record<string, string>,
      name = "memory-export"
    ): Promise<string> => {
      const srcMem = join(
        sourceConfigDir,
        "projects",
        "-Users-testuser-Projects-testproject",
        "memory"
      );
      for (const [file, content] of Object.entries(files)) {
        writeFileSync(join(srcMem, file), content);
      }
      const { exportSession } = await import("../src/exporter.js");
      const result = await exportSession({
        configDir: sourceConfigDir,
        projectPath: "/Users/testuser/Projects/testproject",
        sessionId,
        outputDir: join(tempDir, "exports-2"),
        name,
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });
      if (!result.success) throw new Error("re-export failed in test setup");
      return (result as ExportResult).exportPath;
    };

    it("unions a conflicting MEMORY.md instead of stranding what arrived", async () => {
      const local = "# Memory Index\n\n- [Local note](local-note.md) — mine\n";
      seedMemory("MEMORY.md", local);
      seedMemory("local-note.md", "local\n");

      const result = await runImport();
      expect(result.success).toBe(true);
      if (!result.success || !("memoryIndex" in result)) return;

      const index = readMemory("MEMORY.md");
      // Local content survives verbatim, in its original order…
      expect(index.startsWith(local)).toBe(true);
      // …and the entry that makes the arriving file reachable is appended.
      expect(index).toContain("- [Test memory](test_memory.md) — remembering test patterns");
      expect(existsSync(join(targetMemDir(), "test_memory.md"))).toBe(true);

      expect(result.memoryIndex).toEqual({
        added: ["test_memory.md"],
        alreadyPresent: 0,
        droppedProse: false,
        unindexed: [],
      });
      // The index is an outcome, not a conflict.
      expect(result.memoryConflicts).toBeUndefined();
      expect(result.warnings.some((w) => w.includes("added 1 entry"))).toBe(true);
    });

    it("dedups the union by link target and keeps the local line byte-for-byte", async () => {
      // Same memory, retitled and re-described on this machine.
      const local = "- [Renamed by me](test_memory.md) — my own words\n";
      seedMemory("MEMORY.md", local);

      const result = await runImport();
      expect(result.success).toBe(true);
      if (!result.success || !("memoryIndex" in result)) return;

      expect(readMemory("MEMORY.md")).toBe(local);
      expect(result.memoryIndex?.added).toEqual([]);
      expect(result.memoryIndex?.alreadyPresent).toBe(1);
    });

    it("preserves a header, trailing prose and CRLF, appending after the last pointer", async () => {
      const local =
        "# Memory Index\r\n\r\n- [Local note](local-note.md) — mine\r\n\r\nRead these before starting.\r\n";
      seedMemory("MEMORY.md", local);

      const result = await runImport();
      expect(result.success).toBe(true);

      const index = readMemory("MEMORY.md");
      const lines = index.split("\r\n");
      // Every line ends CRLF: no line was rewritten with a bare \n.
      expect(index.split("\n").length - 1).toBe(index.split("\r\n").length - 1);
      expect(lines[0]).toBe("# Memory Index");
      // Appended after the last POINTER line, not at end of file — otherwise
      // the new entry lands below the prose and reads as commentary.
      const appendedAt = lines.findIndex((l) => l.includes("(test_memory.md)"));
      const proseAt = lines.findIndex((l) => l === "Read these before starting.");
      expect(appendedAt).toBeGreaterThan(0);
      expect(appendedAt).toBeLessThan(proseAt);
    });

    it("appends an incoming pointer whose target is not in the bundle, and never deletes a local one", async () => {
      // Local index points at a memory that no longer exists on disk.
      seedMemory("MEMORY.md", "- [Gone](gone.md) — deleted long ago\n");
      const from = await exportWithMemory({
        "MEMORY.md":
          "- [Test memory](test_memory.md) — remembering test patterns\n" +
          "- [Elsewhere](arrived-earlier.md) — not in this bundle\n",
      });

      const result = await runImport({ from });
      expect(result.success).toBe(true);
      if (!result.success || !("memoryIndex" in result)) return;

      const index = readMemory("MEMORY.md");
      expect(index).toContain("- [Gone](gone.md) — deleted long ago");
      expect(index).toContain("(arrived-earlier.md)");
      expect(result.memoryIndex?.added).toEqual(["test_memory.md", "arrived-earlier.md"]);
    });

    it("parks a conflicting prose memory, indexes it, and reports it", async () => {
      seedMemory("MEMORY.md", "- [Test memory](test_memory.md) — my version\n");
      seedMemory("test_memory.md", "---\nname: Test memory\n---\n\nMine, not theirs.\n");

      const result = await runImport();
      expect(result.success).toBe(true);
      if (!result.success || !("memoryConflicts" in result)) return;

      // The local file is never touched.
      expect(readMemory("test_memory.md")).toContain("Mine, not theirs.");
      // The incoming text is on disk…
      expect(readMemory("test_memory.incoming.md")).toContain("Use vitest for testing.");
      // …and reachable.
      expect(readMemory("MEMORY.md")).toContain("(test_memory.incoming.md)");

      // The skill layer is told where to read both texts, rather than having
      // to re-derive the project-path encoding in markdown.
      expect(result.memoryDir).toBe(targetMemDir());
      expect(result.memoryConflicts).toHaveLength(1);
      const conflict = result.memoryConflicts![0];
      expect(conflict.filename).toBe("test_memory.md");
      expect(conflict.parkedAs).toBe("test_memory.incoming.md");
      expect(conflict.existingHash).not.toBe(conflict.incomingHash);

      // Tier 3's precondition: once the bundle is gone (cli.ts deletes an
      // archive's extract dir before returning), both texts must still be
      // readable from the target, or the skill layer has nothing to merge.
      rmSync(exportPath, { recursive: true, force: true });
      expect(readMemory("test_memory.md")).toContain("Mine, not theirs.");
      expect(readMemory("test_memory.incoming.md")).toContain("Use vitest for testing.");
    });

    it("indexes a parked copy even when the index never mentioned the original", async () => {
      // The local index knows nothing about test_memory.md, and neither the
      // union nor the copy branch would add a line for the parked copy.
      seedMemory("MEMORY.md", "# Memory Index\n\n- [Local note](local-note.md) — mine\n");
      seedMemory("test_memory.md", "different\n");
      const from = await exportWithMemory({ "MEMORY.md": "# Memory Index\n" }, "no-pointer-export");

      const result = await runImport({ from });
      expect(result.success).toBe(true);
      if (!result.success || !("memoryIndex" in result)) return;

      expect(result.memoryIndex?.added).toEqual([]);
      expect(readMemory("MEMORY.md")).toContain("(test_memory.incoming.md)");
      expect(existsSync(join(targetMemDir(), "test_memory.incoming.md"))).toBe(true);
    });

    it("uniquifies a second parked copy instead of eating the first", async () => {
      seedMemory("test_memory.md", "mine, and staying mine\n");
      const first = await runImport();
      expect(first.success).toBe(true);
      const parkedOnce = readMemory("test_memory.incoming.md");

      // The same memory, changed again on the other machine, still conflicting.
      const from = await exportWithMemory({ "test_memory.md": "theirs, round two\n" });
      const second = await runImport({ from });
      expect(second.success).toBe(true);
      if (!second.success || !("memoryConflicts" in second)) return;

      // The first parked copy is not eaten, and the second gets its own name.
      expect(readMemory("test_memory.incoming.md")).toBe(parkedOnce);
      expect(readMemory("test_memory.incoming-2.md")).toBe("theirs, round two\n");
      expect(second.memoryConflicts?.[0].parkedAs).toBe("test_memory.incoming-2.md");
      const index = readMemory("MEMORY.md");
      expect(index).toContain("(test_memory.incoming.md)");
      expect(index).toContain("(test_memory.incoming-2.md)");
    });

    it("reuses an identical parked copy instead of planting one per bundle", async () => {
      // A hub pull applies a CHAIN of bundles, one importSession call each. If
      // every one parked its own copy of an unchanged memory, a five-bundle
      // pull would leave five identical files and five index lines.
      seedMemory("test_memory.md", "mine\n");
      const first = await runImport();
      expect(first.success).toBe(true);

      const second = await runImport();
      expect(second.success).toBe(true);
      if (!second.success || !("memoryConflicts" in second)) return;

      expect(second.memoryConflicts?.[0].parkedAs).toBe("test_memory.incoming.md");
      expect(existsSync(join(targetMemDir(), "test_memory.incoming-2.md"))).toBe(false);
      // …and exactly one index line for it.
      const lines = readMemory("MEMORY.md").split("\n");
      expect(lines.filter((l) => l.includes("(test_memory.incoming.md)"))).toHaveLength(1);
    });

    it("reconciles memory on a re-import where every session is a duplicate", async () => {
      const first = await runImport();
      expect(first.success).toBe(true);
      if (!first.success) return;
      expect(first.importedSessions).toHaveLength(1);

      // The memories go missing (a stray delete, a half-restored machine) and
      // the user's instinct is to re-run the import.
      rmSync(join(targetMemDir(), "test_memory.md"), { force: true });
      seedMemory("MEMORY.md", "- [Local note](local-note.md) — mine\n");

      const second = await runImport();
      expect(second.success).toBe(true);
      if (!second.success || !("memoryIndex" in second)) return;

      expect(second.importedSessions).toEqual([]);
      expect(second.skippedSessions).toHaveLength(1);
      // …and this time the re-run actually does something.
      expect(existsSync(join(targetMemDir(), "test_memory.md"))).toBe(true);
      expect(second.memoryIndex?.added).toEqual(["test_memory.md"]);
    });

    it("is idempotent: a third import changes no byte of the index", async () => {
      seedMemory("MEMORY.md", "# Memory Index\n\n- [Local note](local-note.md) — mine\n");
      await runImport();
      const afterFirst = readMemory("MEMORY.md");
      await runImport();
      await runImport();
      expect(readMemory("MEMORY.md")).toBe(afterFirst);
    });

    it("reports bundle memories that no index lists, without inventing a pointer", async () => {
      const from = await exportWithMemory({ "orphan.md": "# Orphan\n\nNobody points here.\n" });

      const result = await runImport({ from });
      expect(result.success).toBe(true);
      if (!result.success || !("memoryIndex" in result)) return;

      // It lands (it is content the user asked for) and it is named as
      // unreachable — adopting it would mean guessing a title and writing it
      // into the file that decides what future sessions read, to repair a
      // condition that predates the transfer.
      expect(existsSync(join(targetMemDir(), "orphan.md"))).toBe(true);
      expect(result.memoryIndex?.unindexed).toEqual(["orphan.md"]);
      expect(readMemory("MEMORY.md")).not.toContain("orphan.md");
      expect(result.warnings.some((w) => w.includes("listed in no index"))).toBe(true);
    });

    it("drops incoming prose from the index and says so", async () => {
      seedMemory("MEMORY.md", "- [Local note](local-note.md) — mine\n");
      const from = await exportWithMemory({
        "MEMORY.md":
          "# Memory Index\n\nRead the machine notes first.\n\n- [Test memory](test_memory.md) — theirs\n",
      });

      const result = await runImport({ from });
      expect(result.success).toBe(true);
      if (!result.success || !("memoryIndex" in result)) return;

      expect(result.memoryIndex?.droppedProse).toBe(true);
      expect(readMemory("MEMORY.md")).not.toContain("Read the machine notes first.");
      expect(readMemory("MEMORY.md")).toContain("(test_memory.md)");
      expect(result.warnings.some((w) => w.includes("not an index entry"))).toBe(true);
    });

    it("never fails the import when the memory index cannot be read", async () => {
      // A directory where MEMORY.md should be: readFileSync raises EISDIR.
      mkdirSync(join(targetMemDir(), "MEMORY.md"), { recursive: true });

      const result = await runImport();
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.importedSessions).toHaveLength(1);
      expect(
        result.warnings.some((w) => w.includes("Could not read the existing memory index"))
      ).toBe(true);
    });

    it("previews the memory step with the function that performs it", async () => {
      seedMemory("MEMORY.md", "- [Local note](local-note.md) — mine\n");
      seedMemory("test_memory.md", "mine\n");

      const preview = await runImport({ dryRun: true });
      expect(preview.success).toBe(true);
      if (!preview.success || !("memoryPlan" in preview)) return;
      expect(preview.memoryPlan).toEqual([
        {
          filename: "MEMORY.md",
          verdict: "index-union",
          added: ["test_memory.md"],
          alreadyPresent: 0,
        },
        { filename: "test_memory.md", verdict: "park", parkedAs: "test_memory.incoming.md" },
      ]);
      // A dry run writes nothing.
      expect(existsSync(join(targetMemDir(), "test_memory.incoming.md"))).toBe(false);
      expect(readMemory("MEMORY.md")).toBe("- [Local note](local-note.md) — mine\n");

      // The real run then does exactly what the preview said.
      const real = await runImport();
      expect(real.success).toBe(true);
      if (!real.success || !("memoryIndex" in real)) return;
      expect(real.memoryIndex?.added).toEqual(["test_memory.md"]);
      expect(real.memoryConflicts?.[0].parkedAs).toBe("test_memory.incoming.md");
    });

    it("reports a colliding plan instead of discarding it in silence", async () => {
      const plansDir = join(targetConfigDir, "plans");
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(join(plansDir, "test-plan.md"), "# My own plan\n");

      const result = await runImport();
      expect(result.success).toBe(true);
      if (!result.success || !("planConflicts" in result)) return;

      expect(readFileSync(join(plansDir, "test-plan.md"), "utf-8")).toBe("# My own plan\n");
      expect(result.planConflicts).toHaveLength(1);
      expect(result.planConflicts![0].filename).toBe("test-plan.md");
      expect(result.planConflicts![0].existingHash).not.toBe(
        result.planConflicts![0].incomingHash
      );
      expect(result.warnings.some((w) => w.includes('Plan "test-plan.md"'))).toBe(true);
    });

    it("still copies memory and plans that do not collide", async () => {
      seedMemory("existing.md", "---\nname: existing\n---\nExisting memory\n");

      const result = await runImport();
      expect(result.success).toBe(true);
      if (!result.success || !("planConflicts" in result)) return;

      expect(existsSync(join(targetMemDir(), "existing.md"))).toBe(true);
      expect(existsSync(join(targetMemDir(), "MEMORY.md"))).toBe(true);
      expect(existsSync(join(targetMemDir(), "test_memory.md"))).toBe(true);
      expect(existsSync(join(targetConfigDir, "plans", "test-plan.md"))).toBe(true);
      expect(result.memoryConflicts).toBeUndefined();
      expect(result.planConflicts).toBeUndefined();
    });

    it("refuses a bundle whose manifest sessionId escapes the bundle (no file read outside)", async () => {
      const { importSession } = await import("../src/importer.js");
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } =
        await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const root = mkdtempSync(join(tmpdir(), "sesh-mover-exfil-"));
      try {
        // A secret two levels above the bundle's sessions/ dir.
        mkdirSync(join(root, "secret"), { recursive: true });
        writeFileSync(join(root, "secret", "pwned.jsonl"), "TOP_SECRET_MARKER\n");
        const bundle = join(root, "bundle");
        mkdirSync(join(bundle, "sessions"), { recursive: true });
        writeFileSync(
          join(bundle, "manifest.json"),
          JSON.stringify({
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
                sessionId: "../../secret/pwned",
                slug: "evil",
                summary: "",
                createdAt: "",
                lastActiveAt: "",
                messageCount: 1,
                gitBranch: "",
                entrypoint: "cli",
                integrityHash: "sha256:x",
              },
            ],
          })
        );
        const targetConfig = join(root, "target");
        mkdirSync(join(targetConfig, "projects"), { recursive: true });

        const result = await importSession({
          exportPath: bundle,
          targetConfigDir: targetConfig,
          targetProjectPath: "/home/victim/proj",
          targetClaudeVersion: "2.1.114",
          dryRun: false,
          noRegister: true,
        });

        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toMatch(/unsafe session id|manifest/i);
        // Nothing written; the secret never reached the target store.
        const projDir = join(targetConfig, "projects", "-home-victim-proj");
        const leaked =
          existsSync(projDir) &&
          readdirSync(projDir).some((f) =>
            f.endsWith(".jsonl") &&
            readFileSync(join(projDir, f), "utf-8").includes("TOP_SECRET_MARKER")
          );
        expect(leaked).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("verifies integrity hash on import", async () => {
      const { importSession } = await import("../src/importer.js");
      // Corrupt the JSONL file in the export
      const { writeFileSync } = await import("node:fs");
      const jsonlPath = join(
        exportPath,
        "sessions",
        `${sessionId}.jsonl`
      );
      writeFileSync(jsonlPath, "corrupted data\n");

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: "/Users/newuser/Projects/newproject",
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.warnings.some((w) => w.includes("integrity"))).toBe(true);
    });

    it("fails with rollback when an integrity-passing session contains an unparseable line", async () => {
      const { importSession } = await import("../src/importer.js");
      const { appendFileSync, readdirSync } = await import("node:fs");
      const { readManifest, writeManifest, computeIntegrityHash } = await import(
        "../src/manifest.js"
      );
      const { encodeProjectPath } = await import("../src/platform.js");

      // Corrupt the exported JSONL with an unparseable trailing line, then
      // recompute the manifest's integrityHash from the NEW content so the
      // integrity check still PASSES — only parseability should fail.
      const jsonlPath = join(exportPath, "sessions", `${sessionId}.jsonl`);
      appendFileSync(jsonlPath, "{not json\n");
      const newContent = readFileSync(jsonlPath, "utf-8");

      const manifest = readManifest(exportPath);
      const target = manifest.sessions.find((s) => s.sessionId === sessionId)!;
      target.integrityHash = computeIntegrityHash([newContent]);
      writeManifest(exportPath, manifest);

      const targetProjectPath = "/Users/newuser/Projects/newproject";
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(false);
      expect((result as ErrorResult).error).toContain("validation failed");

      // Rollback: no session JSONL landed in the target project dir.
      const written = readdirSync(
        join(targetConfigDir, "projects", encodeProjectPath(targetProjectPath))
      ).filter((f) => f.endsWith(".jsonl"));
      expect(written).toHaveLength(0);
    });
  });

  /**
   * Bundle-level integrity. Everything here is about the bundle NOT being what
   * its manifest says it is — as opposed to a session whose bytes don't match
   * their own hash, which is the pre-existing warn-and-import case above.
   */
  describe("bundle integrity", () => {
    const targetProjectPath = "/Users/newuser/Projects/newproject";

    /** Every .jsonl now in the target project dir. */
    async function landedSessions(): Promise<string[]> {
      const { encodeProjectPath } = await import("../src/platform.js");
      const { readdirSync, existsSync } = await import("node:fs");
      const dir = join(targetConfigDir, "projects", encodeProjectPath(targetProjectPath));
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
    }

    it("refuses a bundle whose manifest declares a session the bundle does not contain", async () => {
      const { importSession } = await import("../src/importer.js");
      const { rmSync } = await import("node:fs");

      // The measured signature of a truncated transfer or a half-finished
      // unpack: manifest.json intact, session data gone. Before this check the
      // answer was `success: true, importedSessions: [1 entry], warnings: []`
      // for a bundle holding no session data at all — the existsSync gate that
      // used to wrap the hash check meant a missing file was never CHECKED.
      rmSync(join(exportPath, "sessions", `${sessionId}.jsonl`));

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(false);
      const err = result as ErrorResult;
      expect(err.error).toContain("no session file in the bundle");
      expect(err.error).toContain(sessionId);
      // The whole point: nothing may be reported as imported, and nothing may
      // reach disk. A `migrate` deletes its source on the strength of that list.
      expect((result as unknown as ImportResult).importedSessions).toBeUndefined();
      expect(await landedSessions()).toHaveLength(0);
    });

    it("refuses the same bundle on a dry run rather than previewing an import it cannot do", async () => {
      const { importSession } = await import("../src/importer.js");
      const { rmSync } = await import("node:fs");
      rmSync(join(exportPath, "sessions", `${sessionId}.jsonl`));

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: true,
      });
      expect(result.success).toBe(false);
    });

    it("still imports the sessions that ARE present when --session-id names them", async () => {
      // The refusal is scoped to what this invocation was asked to import, so
      // the suggestion it prints is one the user can actually act on.
      const { importSession } = await import("../src/importer.js");
      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
        sessionIds: [sessionId],
      });
      expect(result.success).toBe(true);
      expect(await landedSessions()).toHaveLength(1);
    });

    it("refuses a bundle whose manifest session list no longer hashes to its own digest", async () => {
      const { importSession } = await import("../src/importer.js");
      const { readFileSync, writeFileSync } = await import("node:fs");

      // Edited in RAW JSON, not through writeManifest: writeManifest restamps
      // the digest, which is exactly why it is the single place that computes
      // it. This is what damage looks like from outside the tool.
      const manifestPath = join(exportPath, "manifest.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(m.sessionsDigest).toMatch(/^sha256:/);
      m.sessions[0].messageCount = 999;
      writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });
      expect(result.success).toBe(false);
      expect((result as ErrorResult).error).toContain("Bundle integrity check failed");
      expect(await landedSessions()).toHaveLength(0);
    });

    it("refuses a manifest that lost a session record entirely — the case per-session hashes cannot see", async () => {
      const { importSession } = await import("../src/importer.js");
      const { readFileSync, writeFileSync } = await import("node:fs");
      const manifestPath = join(exportPath, "manifest.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
      m.sessions = [];
      writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });
      // Not "No matching sessions found in export" — the inventory is damaged,
      // which is a different statement from "this bundle is empty".
      expect(result.success).toBe(false);
      expect((result as ErrorResult).error).toContain("Bundle integrity check failed");
    });

    it("imports a pre-0.6.0 bundle that declares no digest at all, unchanged", async () => {
      const { importSession } = await import("../src/importer.js");
      const { readFileSync, writeFileSync } = await import("node:fs");
      const manifestPath = join(exportPath, "manifest.json");
      const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
      delete m.sessionsDigest;
      for (const s of m.sessions) delete s.layerDigests;
      writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect((result as ImportResult).warnings).toEqual([]);
      expect(await landedSessions()).toHaveLength(1);
    });

    it("does not copy a file-history layer whose digest fails, imports the transcript, and says so", async () => {
      const { importSession } = await import("../src/importer.js");
      const { writeFileSync, existsSync, readFileSync } = await import("node:fs");

      // A corrupted backup is the layer that matters: Claude Code restores
      // file-history over the user's own file.
      const backup = join(exportPath, "file-history", sessionId, "abc123@v1");
      expect(existsSync(backup)).toBe(true);
      const manifest = JSON.parse(readFileSync(join(exportPath, "manifest.json"), "utf-8"));
      expect(manifest.sessions[0].layerDigests["file-history"]).toMatch(/^sha256:/);
      writeFileSync(backup, "corrupted backup content\n");

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      const r = result as ImportResult;
      expect(r.importedSessions).toHaveLength(1);
      expect(r.warnings.some((w) => w.includes("file-history") && w.includes("NOT copied"))).toBe(true);
      // The transcript arrived; the unverifiable backup did not.
      expect(await landedSessions()).toHaveLength(1);
      const newId = r.importedSessions[0].newId;
      expect(existsSync(join(targetConfigDir, "file-history", newId))).toBe(false);
      // Untouched layers are unaffected — this is per layer, not per bundle.
      const { encodeProjectPath } = await import("../src/platform.js");
      expect(
        existsSync(
          join(targetConfigDir, "projects", encodeProjectPath(targetProjectPath), newId, "subagents")
        )
      ).toBe(true);
    });

    it("warns when the manifest declares a layer the bundle does not contain", async () => {
      const { importSession } = await import("../src/importer.js");
      const { rmSync } = await import("node:fs");
      rmSync(join(exportPath, "file-history", sessionId), { recursive: true, force: true });

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        (result as ImportResult).warnings.some((w) => w.includes('declares a "file-history" layer'))
      ).toBe(true);
    });
  });

  it("records lineage and peer state when importing an incremental bundle", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { importSession } = await import("../src/importer.js");
    const { readSyncState } = await import("../src/sync-state.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-import-inc-"));
    const tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-import-inc-home-"));
    const innerHome = overrideHome(tempHome);

    try {
      const fx = createFixtureTree(tempDir);
      const outputDir = join(tempDir, "exports");
      mkdirSync(outputDir, { recursive: true });

      const exportResult = await exportAllSessions({
        configDir: fx.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "inc-import-test",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {},
        },
      });
      expect(exportResult.success).toBe(true);

      const targetConfig = join(tempDir, "target-config");
      mkdirSync(targetConfig, { recursive: true });
      const importResult = await importSession({
        exportPath: (exportResult as { exportPath: string }).exportPath,
        targetConfigDir: targetConfig,
        targetProjectPath: "/Users/target/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(importResult.success).toBe(true);

      const state = readSyncState("/Users/target/Projects/testproject");
      expect(state.peers["machine-A"]).toBeDefined();
      expect(state.peers["machine-A"].name).toBe("A");
      expect(Object.keys(state.peers["machine-A"].received).length).toBe(1);
      expect(Object.keys(state.lineage).length).toBe(1);
      const [newLocalId] = Object.keys(state.lineage);
      expect(state.lineage[newLocalId].sourceMachineId).toBe("machine-A");
      expect(state.lineage[newLocalId].type).toBe("full");
      expect(state.lineage[newLocalId].postRewriteHash).toMatch(/^sha256:/);

      expect(Object.keys(state.peers["machine-A"].sent).length).toBe(1);
    } finally {
      innerHome.restore();
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("skips an already-received full session on second import (idempotent)", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { importSession } = await import("../src/importer.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-import-idem-"));
    const tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-import-idem-home-"));
    const innerHome = overrideHome(tempHome);

    try {
      const fx = createFixtureTree(tempDir);
      const outputDir = join(tempDir, "exports");
      mkdirSync(outputDir, { recursive: true });

      const exportResult = await exportAllSessions({
        configDir: fx.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "inc-idem",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {},
        },
      });
      expect(exportResult.success).toBe(true);

      const targetConfig = join(tempDir, "target-config");
      mkdirSync(targetConfig, { recursive: true });

      const first = await importSession({
        exportPath: (exportResult as { exportPath: string }).exportPath,
        targetConfigDir: targetConfig,
        targetProjectPath: "/Users/target/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(first.success).toBe(true);

      const second = await importSession({
        exportPath: (exportResult as { exportPath: string }).exportPath,
        targetConfigDir: targetConfig,
        targetProjectPath: "/Users/target/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(second.success).toBe(true);
      expect(
        (second as { warnings: string[] }).warnings.some((w) =>
          /already received/i.test(w)
        )
      ).toBe(true);
      expect((second as { importedSessions: unknown[] }).importedSessions.length).toBe(0);
    } finally {
      innerHome.restore();
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("re-imports an incremental bundle when the received session's JSONL file is gone even though a peer record exists", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { exportAllSessions } = await import("../src/exporter.js");
    const { importSession } = await import("../src/importer.js");
    const { createFixtureTree } = await import("./fixtures/create-fixtures.js");

    const tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-import-idem-heal-"));
    const tempHome = mkdtempSync(join(tmpdir(), "sesh-mover-import-idem-heal-home-"));
    const innerHome = overrideHome(tempHome);

    try {
      const fx = createFixtureTree(tempDir);
      const outputDir = join(tempDir, "exports");
      mkdirSync(outputDir, { recursive: true });

      const exportResult = await exportAllSessions({
        configDir: fx.configDir,
        projectPath: "/Users/testuser/Projects/testproject",
        outputDir,
        name: "inc-idem-heal",
        excludeLayers: [],
        claudeVersion: "2.1.114",
        incremental: {
          sourceMachineId: "machine-A",
          sourceMachineName: "A",
          targetMachineId: "machine-B",
          targetMachineName: "B",
          peerSent: {},
        },
      });
      expect(exportResult.success).toBe(true);

      const targetConfig = join(tempDir, "target-config");
      mkdirSync(targetConfig, { recursive: true });

      const first = await importSession({
        exportPath: (exportResult as { exportPath: string }).exportPath,
        targetConfigDir: targetConfig,
        targetProjectPath: "/Users/target/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(first.success).toBe(true);
      if (!first.success) return;
      const firstNewId = (first as ImportResult).importedSessions[0].newId;

      // Delete the previously-imported JSONL: the sync-state peer record
      // still references it, but the file itself is gone.
      const encoded = "-Users-target-Projects-testproject";
      const priorJsonl = join(targetConfig, "projects", encoded, `${firstNewId}.jsonl`);
      expect(existsSync(priorJsonl)).toBe(true);
      rmSync(priorJsonl);

      const second = await importSession({
        exportPath: (exportResult as { exportPath: string }).exportPath,
        targetConfigDir: targetConfig,
        targetProjectPath: "/Users/target/Projects/testproject",
        targetClaudeVersion: "2.1.114",
        dryRun: false,
        noRegister: false,
      });
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect((second as ImportResult).importedSessions).toHaveLength(1);
      expect((second as ImportResult).skippedSessions).toHaveLength(0);
    } finally {
      innerHome.restore();
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("skips re-import of an identical non-incremental bundle and reports skippedSessions", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    };
    const first = await importSession(opts);
    expect(first.success).toBe(true);

    const second = await importSession(opts);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.importedSessions).toHaveLength(0);
    expect((second as any).skippedSessions).toEqual([
      { originalId: sessionId, reason: "duplicate" },
    ]);
    expect(second.warnings.some((w) => /already imported/i.test(w))).toBe(true);
  });

  it("a registered import proceeds over a prior --no-register copy", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    };
    const first = await importSession({ ...opts, noRegister: true });
    expect(first.success).toBe(true);

    const second = await importSession(opts); // registered run
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.importedSessions).toHaveLength(1);
    expect(second.resumable).toBe(true);
    expect(second.warnings.some((w) => /unregistered/i.test(w))).toBe(true);

    const third = await importSession(opts); // now a registered copy exists
    expect(third.success).toBe(true);
    if (!third.success) return;
    expect(third.importedSessions).toHaveLength(0);
    expect((third as any).skippedSessions[0].reason).toBe("duplicate");
  });

  it("a --no-register re-import of an unregistered copy is still skipped", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
      noRegister: true,
    };
    await importSession(opts);
    const second = await importSession(opts);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.importedSessions).toHaveLength(0);
  });

  it("--allow-duplicates re-imports an already-present bundle", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    };
    await importSession(opts);
    const second = await importSession({ ...opts, allowDuplicates: true });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.importedSessions).toHaveLength(1);
  });

  it("re-imports when the registry hash record exists but the prior JSONL file is gone", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    };
    const first = await importSession(opts);
    expect(first.success).toBe(true);
    if (!first.success) return;
    const firstNewId = (first as ImportResult).importedSessions[0].newId;

    // Simulate data loss: the previously-imported JSONL file disappeared
    // (e.g. a migrate deleted it), but the registry record still points at it.
    const encoded = "-Users-newuser-Projects-newproject";
    const priorJsonl = join(targetConfigDir, "projects", encoded, `${firstNewId}.jsonl`);
    expect(existsSync(priorJsonl)).toBe(true);
    rmSync(priorJsonl);

    const second = await importSession(opts);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect((second as ImportResult).importedSessions).toHaveLength(1);
    expect((second as ImportResult).skippedSessions).toHaveLength(0);
  });

  it("dry-run of a fully-duplicate bundle still reports dryRun: true", async () => {
    const { importSession } = await import("../src/importer.js");
    const opts = {
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    };
    const first = await importSession(opts);
    expect(first.success).toBe(true);

    const secondDryRun = await importSession({ ...opts, dryRun: true });
    expect(secondDryRun.success).toBe(true);
    if (!secondDryRun.success) return;
    expect((secondDryRun as DryRunResult).dryRun).toBe(true);
    expect((secondDryRun as DryRunResult).importedSessions).toHaveLength(0);
    expect((secondDryRun as DryRunResult).skippedSessions).toHaveLength(1);
  });

  it("migrate cleans up source sessions that were skipped as duplicates at target", async () => {
    const { migrateSession } = await import("../src/migrator.js");
    const { importSession } = await import("../src/importer.js");
    // Pre-import the bundle to the migrate target so the migrate's own
    // import skips everything as duplicate…
    const pre = await importSession({
      exportPath,
      targetConfigDir,
      targetProjectPath: "/Users/newuser/Projects/newproject",
      targetClaudeVersion: "2.1.81",
      dryRun: false,
    });
    expect(pre.success).toBe(true);

    const result = await migrateSession({
      sourceConfigDir,
      targetConfigDir,
      sourceProjectPath: "/Users/testuser/Projects/testproject",
      targetProjectPath: "/Users/newuser/Projects/newproject",
      scope: "current",
      sessionId,
      excludeLayers: [],
      claudeVersion: "2.1.81",
      currentCwd: "/Users/testuser",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // …but the source is still cleaned up: identical content already lives
    // at the target, so migrate semantics are satisfied.
    expect(
      existsSync(
        join(sourceConfigDir, "projects", "-Users-testuser-Projects-testproject", `${sessionId}.jsonl`)
      )
    ).toBe(false);
    // Verify skippedSessions are surfaced on MigrateResult
    expect((result as any).skippedSessions).toEqual([
      { originalId: sessionId, reason: "duplicate" },
    ]);
  });
});
