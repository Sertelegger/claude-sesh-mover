import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { platform, tmpdir } from "node:os";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import type {
  ExportResult,
  ImportResult,
  DryRunResult,
  ErrorResult,
  ProgressEvent,
} from "../src/types.js";

const isWindows = platform() === "win32";

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
    /**
     * `includePlans` is passed explicitly by every test that means to exercise
     * the plans half of the step, because the layer is OPT-IN (#74) — its
     * destination is `<configDir>/plans`, which every project on this machine
     * shares. Leaving it off is not a shortcut: a plans test that omits it
     * passes trivially, since nothing is written at all. That is precisely how
     * "does not write a bundle plan through a dangling symlink at its name"
     * would have gone on passing while covering none of its guard.
     */
    const runImport = async (opts?: {
      dryRun?: boolean;
      from?: string;
      includePlans?: boolean;
      noMemory?: boolean;
    }) => {
      const { importSession } = await import("../src/importer.js");
      return importSession({
        exportPath: opts?.from ?? exportPath,
        targetConfigDir,
        targetProjectPath: TARGET_PROJECT,
        targetClaudeVersion: "2.1.81",
        dryRun: opts?.dryRun ?? false,
        includePlans: opts?.includePlans,
        noMemory: opts?.noMemory,
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

      const result = await runImport({ includePlans: true });
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

      const result = await runImport({ includePlans: true });
      expect(result.success).toBe(true);
      if (!result.success || !("planConflicts" in result)) return;

      expect(existsSync(join(targetMemDir(), "existing.md"))).toBe(true);
      expect(existsSync(join(targetMemDir(), "MEMORY.md"))).toBe(true);
      expect(existsSync(join(targetMemDir(), "test_memory.md"))).toBe(true);
      expect(existsSync(join(targetConfigDir, "plans", "test-plan.md"))).toBe(true);
      expect(result.memoryConflicts).toBeUndefined();
      expect(result.planConflicts).toBeUndefined();
    });

    // --- plans/ is opt-in on the receive side too (#74) ---
    //
    // `<configDir>/plans` is config-dir-GLOBAL: it has no project filter, so a
    // bundle's plans layer writes files every project on this machine shares.
    // CLAUDE.md already records the send-side half ("`plans/` deliberately does
    // NOT travel to the hub … fix the payload's scope before widening its
    // transport"); this is the receive side of the same argument.
    it("does not write a bundle's plans by default, and --include-plans on the re-run lands them", async () => {
      const plansDir = join(targetConfigDir, "plans");

      const first = await runImport();
      expect(first.success).toBe(true);
      if (!first.success || !("plansSkipped" in first)) return;

      // Not written, and not silent about it: the count is the disclosure.
      expect(existsSync(join(plansDir, "test-plan.md"))).toBe(false);
      expect(first.plansSkipped).toBe(1);
      expect(first.planConflicts).toBeUndefined();
      expect(
        first.warnings.some((w) => w.includes("carries 1 plan file(s), and they were NOT written"))
      ).toBe(true);
      // The OTHER shared layer is unaffected — memory stays default-on, because
      // it lands in this project's own directory.
      expect(existsSync(join(targetMemDir(), "test_memory.md"))).toBe(true);

      // The remedy the warning names actually reaches the payload. The re-run
      // is a fully-duplicate import (every session already here), which is the
      // path that returns before the session write loop — so this also pins
      // that the flag is threaded through THAT branch, not just the main one.
      const second = await runImport({ includePlans: true });
      expect(second.success).toBe(true);
      if (!second.success || !("plansSkipped" in second)) return;
      expect(existsSync(join(plansDir, "test-plan.md"))).toBe(true);
      expect(second.plansSkipped).toBeUndefined();
    });

    it("previews the plans skip on a dry run with the same count the real run reports", async () => {
      const preview = await runImport({ dryRun: true });
      expect(preview.success).toBe(true);
      if (!preview.success || !("plansSkipped" in preview)) return;
      expect(preview.plansSkipped).toBe(1);
      expect(existsSync(join(targetConfigDir, "plans"))).toBe(false);
    });

    // --- memory/ is opt-OUT, and the opposite default is the decision (#36) ---
    //
    // The ruling on the apply boundary is one explicit per-import decision over
    // every payload that lands outside a minted session id — not a path filter,
    // now or ever. `plans/` answers that with an opt-in because its destination
    // is machine-global; `memory/` answers it with an off switch and keeps its
    // default, because it lands in the target project's OWN directory, is
    // add-only, parks conflicts rather than overwriting them, and is the layer a
    // future session reads prose out of. What was actually missing was that the
    // CLI honored no way to decline it at all.
    it("does not write a bundle's memory when --no-memory is passed, and the re-run without it lands them", async () => {
      const first = await runImport({ noMemory: true });
      expect(first.success).toBe(true);
      if (!first.success || !("memorySkipped" in first)) return;

      // Not written — and the directory is not even created, so nothing about
      // the target project's memory folder changed.
      expect(existsSync(targetMemDir())).toBe(false);
      expect(first.memorySkipped).toBe(2);
      expect(first.memoryConflicts).toBeUndefined();
      expect(
        first.warnings.some((w) =>
          w.includes("carries 2 memory file(s), and they were NOT written")
        )
      ).toBe(true);
      // The OTHER shared layer is unaffected by this flag: plans were already
      // skipped for their own (opt-in) reason, and stay that way.
      expect(first.plansSkipped).toBe(1);

      // The remedy the warning names reaches the payload. The re-run is a
      // fully-duplicate import — the branch that returns before the session
      // write loop — so this also pins that `noMemory` is threaded through THAT
      // branch and not only the main one.
      const second = await runImport();
      expect(second.success).toBe(true);
      if (!second.success || !("memorySkipped" in second)) return;
      expect(existsSync(join(targetMemDir(), "test_memory.md"))).toBe(true);
      expect(existsSync(join(targetMemDir(), "MEMORY.md"))).toBe(true);
      expect(second.memorySkipped).toBeUndefined();
      expect(second.importedSessions).toEqual([]);
    });

    it("previews the memory skip on a dry run with the same count the real run reports", async () => {
      const preview = await runImport({ dryRun: true, noMemory: true });
      expect(preview.success).toBe(true);
      if (!preview.success || !("memorySkipped" in preview)) return;
      expect(preview.memorySkipped).toBe(2);
      expect(preview.memoryPlan).toEqual([]);
      expect(preview.memoryDir).toBeUndefined();
      expect(existsSync(targetMemDir())).toBe(false);
    });

    // --- the write set: the consent gate's input (#36) ---
    //
    // The gate `commands/import.md` step 8 runs is only worth anything if the
    // set is COMPLETE. "Complete" is not a claim a reader can check by reading
    // `reconcileSharedLayers`, so it is checked against the filesystem: snapshot
    // the target config dir, run a real import, and compare what actually
    // changed with what the result promised. Content hashes rather than a
    // name list, because `index-append` MODIFIES a file that was already there
    // and a created-files diff cannot see it.
    /** Every file under `dir`, absolute, with its bytes. Directories excluded. */
    const snapshotTree = (dir: string): Map<string, string> => {
      const out = new Map<string, string>();
      const walk = (d: string): void => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out.set(p, readFileSync(p).toString("base64"));
        }
      };
      walk(dir);
      return out;
    };

    it("discloses a write set that is exactly the files it touched outside the minted sessions", async () => {
      // A bundle exercising BOTH shared layers and all three entry kinds:
      //  - MEMORY.md exists locally and differs      -> index-append
      //  - test_memory.md exists locally and differs -> park
      //  - fresh_note.md is absent locally           -> create (memory)
      //  - plans/test-plan.md is absent              -> create (plans)
      const from = await exportWithMemory(
        { "fresh_note.md": "arrived with the bundle\n" },
        "write-set-export"
      );
      seedMemory("MEMORY.md", "# Memory Index\n\n- [Local note](local-note.md) — mine\n");
      seedMemory("local-note.md", "local\n");
      seedMemory("test_memory.md", "a different local version\n");

      const before = snapshotTree(targetConfigDir);
      const result = await runImport({ from, includePlans: true });
      expect(result.success).toBe(true);
      if (!result.success || !("writeSet" in result) || result.dryRun) return;
      const after = snapshotTree(targetConfigDir);

      const minted = result.importedSessions.map((s) => s.newId);
      expect(minted.length).toBeGreaterThan(0);
      const touched = [...after]
        .filter(([p, bytes]) => before.get(p) !== bytes)
        .map(([p]) => p)
        // The two documented exclusions from the write set's SCOPE, and nothing
        // else: everything under an id this import minted seconds ago (which
        // collides with nothing by construction), and this machine's own
        // resume-list bookkeeping (which carries no bundle-chosen byte at a
        // bundle-chosen name).
        .filter((p) => !minted.some((id) => p.includes(id)))
        .filter((p) => basename(p) !== "history.jsonl")
        .sort();

      expect(touched.length).toBeGreaterThan(0);
      expect(result.writeSet!.entries.map((e) => e.path).sort()).toEqual(touched);
      expect(result.writeSet!.total).toBe(result.writeSet!.entries.length);

      // The kinds are the part a human is asked to consent to, so pin them by
      // value rather than by count. `index-append` is the only kind that edits a
      // file the user already had.
      const byName = new Map(result.writeSet!.entries.map((e) => [basename(e.path), e.kind]));
      expect(byName.get("MEMORY.md")).toBe("index-append");
      expect(byName.get("test_memory.incoming.md")).toBe("park");
      expect(byName.get("fresh_note.md")).toBe("create");
      expect(byName.get("test-plan.md")).toBe("create");
      // The local file a park sits beside is NOT in the set — it is not written.
      expect(byName.has("test_memory.md")).toBe(false);
      expect(byName.has("local-note.md")).toBe(false);

      // Roots carry the blast radius, which is the whole reason the two layers
      // have opposite defaults.
      expect(
        result.writeSet!.roots.map((r) => [r.layer, r.scope, r.applied])
      ).toEqual([
        ["memory", "project", true],
        ["plans", "machine", true],
      ]);
    });

    it("previews exactly the write set the real run produces", async () => {
      seedMemory("test_memory.md", "a different local version\n");

      const preview = await runImport({ dryRun: true, includePlans: true });
      expect(preview.success).toBe(true);
      if (!preview.success || !("writeSet" in preview)) return;
      // Nothing was written by the preview — the set is a prediction.
      expect(existsSync(join(targetMemDir(), "test_memory.incoming.md"))).toBe(false);
      expect(existsSync(join(targetConfigDir, "plans"))).toBe(false);

      const real = await runImport({ includePlans: true });
      expect(real.success).toBe(true);
      if (!real.success || !("writeSet" in real)) return;

      expect(preview.writeSet).toEqual(real.writeSet);
      expect(preview.writeSet!.total).toBeGreaterThan(0);
      // The other direction of the `create` / `index-append` split: no local
      // index was seeded here, so the bundle's own MEMORY.md lands as a NEW
      // file. Pinned in both tests so a kind hard-coded either way is caught.
      const index = preview.writeSet!.entries.find((e) => basename(e.path) === "MEMORY.md");
      expect(index?.kind).toBe("create");
    });

    it("does not list a parked copy that was already on disk with the same bytes", async () => {
      seedMemory("test_memory.md", "a different local version\n");
      const first = await runImport();
      expect(first.success).toBe(true);
      if (!first.success || !("writeSet" in first)) return;
      expect(
        first.writeSet!.entries.some((e) => basename(e.path) === "test_memory.incoming.md")
      ).toBe(true);

      // The second import is the chain-pull shape the reuse branch exists for:
      // the same conflicting memory, already parked with these exact bytes. It
      // writes NOTHING, and the write set has to say nothing — a set that
      // over-reports is as wrong as one that under-reports, because the gate's
      // whole claim is that it is what the run does.
      const before = snapshotTree(targetConfigDir);
      const second = await runImport();
      expect(second.success).toBe(true);
      if (!second.success || !("writeSet" in second)) return;
      const touched = [...snapshotTree(targetConfigDir)]
        .filter(([p, bytes]) => before.get(p) !== bytes)
        .map(([p]) => p)
        .filter((p) => basename(p) !== "history.jsonl");

      expect(touched).toEqual([]);
      expect(second.writeSet!.entries).toEqual([]);
      expect(second.writeSet!.total).toBe(0);
      // Still a conflict, still parked, still reported — the reuse is about the
      // WRITE, not about the finding.
      expect(second.memoryConflicts?.[0].parkedAs).toBe("test_memory.incoming.md");
    });

    it("reports an empty write set rather than omitting it when nothing lands outside the session", async () => {
      const result = await runImport({ noMemory: true });
      expect(result.success).toBe(true);
      if (!result.success || !("writeSet" in result)) return;
      // Present, not absent: an omitted write set and an empty one are the same
      // JSON, so a gate could not tell "nothing lands outside the session" from
      // "nobody computed it".
      expect(result.writeSet).toBeDefined();
      expect(result.writeSet!.total).toBe(0);
      expect(result.writeSet!.entries).toEqual([]);
      // Both layers are still DISCLOSED, with the flag-declined state and the
      // scope that explains why each has the default it has.
      expect(
        result.writeSet!.roots.map((r) => [r.layer, r.scope, r.applied])
      ).toEqual([
        ["memory", "project", false],
        ["plans", "machine", false],
      ]);
    });

    // `applySharedLayers` is the fifth caller of `reconcileSharedLayers` — the
    // hub-pull splice path, which handles a bundle without importing a session.
    // It is a one-line delegation on purpose, so a rule added to the reconcile
    // reaches it with no edit. The delegation itself was unpinned: no shipped
    // caller passes either layer flag, so dropping one from its signature would
    // be a type error for nobody, and the flag would silently stop crossing.
    it("threads both layer flags through applySharedLayers, the splice path's entry point", async () => {
      const { applySharedLayers } = await import("../src/importer.js");
      const targetProjectDir = join(
        targetConfigDir,
        "projects",
        "-Users-newuser-Projects-newproject"
      );
      mkdirSync(targetProjectDir, { recursive: true });

      const declined = applySharedLayers({
        exportPath,
        targetProjectDir,
        targetConfigDir,
        noMemory: true,
      });
      expect(existsSync(targetMemDir())).toBe(false);
      expect(declined.memorySkipped).toBe(2);
      expect(declined.writeSet!.total).toBe(0);

      const applied = applySharedLayers({ exportPath, targetProjectDir, targetConfigDir });
      expect(existsSync(join(targetMemDir(), "test_memory.md"))).toBe(true);
      expect(applied.memorySkipped).toBeUndefined();
      expect(applied.writeSet!.entries.length).toBeGreaterThan(0);
      // Plans stay opt-in through this entry point too, and it matters MORE
      // here than on import: this path runs unattended from a hook, which has
      // no channel to disclose a machine-global write.
      expect(existsSync(join(targetConfigDir, "plans"))).toBe(false);
      expect(applied.plansSkipped).toBe(1);
    });

    it.skipIf(isWindows)(
      "quotes a bundle-chosen path in the write set instead of relaying it raw",
      async () => {
        // The write set interpolates a `readdirSync` basename out of the bundle
        // into a list `commands/import.md` renders as markdown. That is the same
        // sink #79 closed for MEMORY.md pointer lines and #38 closed for
        // `git apply --summary`, and a newline is legal in a Linux filename.
        const hostile = "note\n## Injected heading\n.md";
        const from = await exportWithMemory({ [hostile]: "planted\n" }, "hostile-memory");

        const result = await runImport({ from, dryRun: true });
        expect(result.success).toBe(true);
        if (!result.success || !("writeSet" in result)) return;

        const entry = result.writeSet!.entries.find((e) => e.path.includes("Injected"));
        expect(entry).toBeDefined();
        // The fixture really is hostile — otherwise the assertion below passes
        // for a reason that has nothing to do with escaping.
        expect(entry!.path).toContain("\n");
        expect(entry!.display).not.toContain("\n");
        expect(entry!.display).toBe(JSON.stringify(entry!.path));
        // The rule is per entry and not per hostile entry: an ordinary name has
        // to carry the same escaped form, or a renderer learns to use `path`.
        for (const e of result.writeSet!.entries) {
          expect(e.display).toBe(JSON.stringify(e.path));
        }
      }
    );

    // --- MEMORY.md pointer injection ---
    //
    // The parked-copy pointer is the one index line this plugin CONSTRUCTS
    // rather than copies, and every argument it interpolates is bundle-supplied
    // and validated by nothing: a stem and a parked name derived from a filename
    // inside the bundle, and `sourceMachineName`, which is free text on the
    // manifest. A newline in any of them split the line and appended arbitrary
    // entries to the user's index — the same shape as the measured
    // `git apply --summary` defect in `hub/carry.ts`.
    //
    // Note what does NOT cover this: `unionMemoryIndex`'s incoming lines are
    // newline-free *because they came out of `splitIndexLines`*, and a line
    // built here never did.
    /** Index lines, ignoring the file's trailing terminator. */
    const indexLines = (text: string): string[] =>
      text.split(/\r\n|\n|\r/).filter((l, i, a) => !(i === a.length - 1 && l === ""));

    it("gains exactly one index line from a bundle whose machine name carries a newline", async () => {
      const { readManifest, writeManifest } = await import("../src/manifest.js");
      const { memoryIndexTargets } = await import("../src/memory-index.js");

      const manifest = readManifest(exportPath);
      manifest.sourceMachineName =
        "laptop\n- [pwned](pwned.md) — injected by the bundle\n- [also-pwned](also-pwned.md) — and again";
      writeManifest(exportPath, manifest);

      // A conflicting prose memory is what makes the importer BUILD a pointer.
      const local = "# Memory Index\n\n- [Test memory](test_memory.md) — mine\n";
      seedMemory("MEMORY.md", local);
      seedMemory("test_memory.md", "mine, not theirs\n");

      const before = indexLines(readMemory("MEMORY.md")).length;
      const result = await runImport();
      expect(result.success).toBe(true);
      if (!result.success || !("memoryConflicts" in result)) return;

      const after = readMemory("MEMORY.md");
      expect(indexLines(after).length).toBe(before + 1);
      // …and the one line that was added is the parked copy's, not theirs.
      expect(memoryIndexTargets(after)).toEqual(["test_memory.md", "test_memory.incoming.md"]);
      // The payload survives as inert TEXT inside the description — it is
      // degraded, not dropped — but it is no longer a line, and so no longer an
      // entry. That distinction is the whole fix.
      expect(after).not.toMatch(/^[-*+]\s+\[pwned\]/m);
      expect(after).toContain("laptop");
      expect(result.memoryConflicts?.[0].parkedAs).toBe("test_memory.incoming.md");
    });

    it.skipIf(isWindows)(
      "gains exactly one index line from a bundle whose memory filename carries a newline",
      async () => {
        const { memoryIndexTargets } = await import("../src/memory-index.js");
        // A POSIX filename may contain anything but `/` and NUL, so the parked
        // name derived from it may too. Windows forbids it outright, which is
        // why this is the one half of the pair that is platform-guarded.
        const hostile = "notes\n- [pwned](pwned.md) — injected.md";

        const from = await exportWithMemory(
          { [hostile]: "theirs\n" },
          "hostile-memory-filename-export"
        );
        // The local index already lists the bundle's own memory, so the union
        // adds nothing: every line this test counts comes from a parked-copy
        // pointer, which is the code path under test.
        seedMemory("MEMORY.md", "# Memory Index\n\n- [Test memory](test_memory.md) — mine\n");
        seedMemory("test_memory.md", "mine, not theirs\n");
        seedMemory(hostile, "mine, not theirs\n");

        const before = indexLines(readMemory("MEMORY.md")).length;
        const result = await runImport({ from });
        expect(result.success).toBe(true);
        if (!result.success || !("memoryConflicts" in result)) return;

        const after = readMemory("MEMORY.md");
        // Exactly one: the pointer for `test_memory.md`'s parked copy. The
        // hostile name gets NO line — it cannot be written as a link target, so
        // it is refused rather than escaped into something that points nowhere.
        expect(indexLines(after).length).toBe(before + 1);
        expect(memoryIndexTargets(after)).toEqual(["test_memory.md", "test_memory.incoming.md"]);
        expect(after).not.toMatch(/^[-*+]\s+\[pwned\]/m);
        // Refused, and SAID: the parked copy is on disk and named in the typed
        // field, so nothing is lost silently.
        const hostileParked = `${hostile.slice(0, -".md".length)}.incoming.md`;
        expect(result.memoryConflicts?.some((c) => c.parkedAs === hostileParked)).toBe(true);
        const refusal = result.warnings.find((w) =>
          w.includes("cannot be written as a markdown link")
        );
        expect(refusal).toBeDefined();
        // The refusal names the hostile filename, so it is the one message
        // certain to interpolate one — it quotes rather than pastes.
        expect(refusal!.includes("\n")).toBe(false);
        expect(refusal).toContain(JSON.stringify(hostile));
      }
    );

    /**
     * The SIBLING CLASS the test above deliberately left alone.
     *
     * #79 quoted one message — the link-target refusal — on the argument that
     * it is the only one guaranteed to interpolate a hostile name. The other
     * ~10 in `importer.ts` interpolated a bundle filename as a hand-written
     * `"${file}"`, which is an argument about the usual input rather than about
     * the message. The transport is not the defence: a `warnings` entry rides
     * out as JSON, where a newline is `\n` and corrupts nothing, and then
     * `commands/import.md` relays it into markdown for a human — which is the
     * same sink #79 closed for `MEMORY.md` pointer lines.
     *
     * Three names, each reaching a DIFFERENT message, plus one assertion over
     * the whole array. The last one is the guard: it is about the class, so a
     * new warning added to this step is covered the day it is written.
     */
    it.skipIf(isWindows)(
      "quotes every bundle-chosen name it echoes, so no warning can carry a forged line",
      async () => {
        // POSIX filenames may contain anything but `/` and NUL. Windows cannot
        // hold these at all, which is why this is platform-guarded — the same
        // reason as the pair above.
        const conflicting = "notes\nMEM-INJECTED-CONFLICT.md";
        const orphan = "loose\nMEM-INJECTED-ORPHAN.md";
        const notAFile = "dir\nMEM-INJECTED-NOTAFILE.md";

        const from = await exportWithMemory(
          { [conflicting]: "theirs\n", [orphan]: "theirs\n" },
          "hostile-name-warning-export"
        );
        // A DIRECTORY inside the bundle's memory folder: the third message.
        // Planted after the export because the exporter copies files only.
        mkdirSync(join(from, "memory", notAFile), { recursive: true });
        // A local copy that differs is what makes the park/differ branch run.
        seedMemory(conflicting, "mine, not theirs\n");

        const result = await runImport({ from });
        expect(result.success).toBe(true);
        if (!result.success || !("memoryIndex" in result)) return;

        const find = (needle: string): string => {
          const w = result.warnings.find((x) => x.includes(needle));
          expect(w, `no warning contained ${JSON.stringify(needle)}`).toBeDefined();
          return w!;
        };

        // Each of the three names arrives QUOTED — `JSON.stringify` supplies
        // the quotes, so for an ordinary name the rendering is unchanged and
        // for these it escapes the newline into a visible `\n`.
        expect(find("differs from the copy in this bundle")).toContain(
          JSON.stringify(conflicting)
        );
        expect(find("is not a regular file")).toContain(JSON.stringify(notAFile));
        expect(find("listed in no index")).toContain(JSON.stringify(orphan));

        // THE CLASS, not those three lines: nothing this import said can carry
        // a line break, so nothing it said can forge a bullet, a heading or a
        // pointer in the markdown the skill layer renders it into.
        for (const w of result.warnings) {
          expect(w, `warning carries a raw line break: ${JSON.stringify(w)}`).not.toMatch(
            /[\r\n]/
          );
        }
      }
    );

    it("quotes each unindexed memory separately, so a name containing the separator is unambiguous", async () => {
      // The join at that site has a second defect, independent of control
      // characters and not fixed by escaping them: `, ` is a legal filename
      // substring, so `unindexed.join(", ")` renders ONE file named `a, b.md`
      // and TWO files named `a` and `b.md` identically. Quoting per element —
      // rather than quoting the joined string — is what tells them apart.
      const from = await exportWithMemory({ "a, b.md": "one file, not two\n" }, "comma-name-export");

      const result = await runImport({ from });
      expect(result.success).toBe(true);
      if (!result.success || !("memoryIndex" in result)) return;

      expect(result.memoryIndex?.unindexed).toContain("a, b.md");
      const warn = result.warnings.find((w) => w.includes("listed in no index"));
      expect(warn).toBeDefined();
      // The quoted TOKEN, not the bare substring: `toContain("a, b.md")` passes
      // against the unquoted join too and would assert nothing.
      expect(warn).toContain('"a, b.md"');
    });

    // --- #64: a destination is claimed by an EXCLUSIVE write, never by a
    // check standing in front of one ---
    //
    // `existsSync` follows symlinks, so a DANGLING symlink at a destination
    // answers "absent" and the `copyFileSync` behind it wrote THROUGH the
    // link, landing wherever it pointed — outside the memory or plans
    // directory entirely. `O_CREAT|O_EXCL` refuses a symlink path outright,
    // which is why the fix is the exclusive write and not an `lstatSync` in
    // front of the same call.
    //
    // Every test here plants exactly that link and asserts the escape hatch
    // stayed empty. Each one FAILS against the pre-#64 code — a symlink test
    // that passes against the broken version asserts nothing.
    //
    // #64 spelled that exclusive write `copyFileSync(..., COPYFILE_EXCL)`,
    // which is `O_CREAT|O_EXCL` on POSIX and `CopyFileW(…, bFailIfExists)` on
    // Windows — where it resolves a reparse point and asks about the LINK'S
    // TARGET. These tests are the ones that caught it: green on Linux and
    // macOS, and on `windows-latest` the bundle's file was sitting in the
    // escape directory. They stay unguarded by platform for exactly that
    // reason (#68), and they are the ONLY place the Windows half of the guard
    // is observable — on POSIX the exclusive create covers it either way.
    const escapeDir = () => join(tempDir, "escape-hatch");
    /** Plant a symlink at `dst` pointing at a path that does not exist. */
    const plantDanglingSymlink = (dst: string): void => {
      mkdirSync(escapeDir(), { recursive: true });
      mkdirSync(dirname(dst), { recursive: true });
      symlinkSync(join(escapeDir(), `${basename(dst)}.escaped`), dst);
    };
    /** Nothing was written through the link, and the link itself is untouched. */
    const expectNothingEscaped = (link: string) => {
      expect(readdirSync(escapeDir())).toEqual([]);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    };

    // #68: the contract the four tests below rest on, asserted directly and on
    // EVERY platform, so a failure says which half broke — the write primitive,
    // or the reconcile logic sitting on top of it. It is `copyToNewFile` and
    // not `copyFileSync(..., COPYFILE_EXCL)` because those two are the same
    // call on POSIX and are NOT the same call on Windows, where the copy
    // resolves a reparse point at the destination and asks its "already
    // exists?" question about the link's target. On POSIX this passes on the
    // exclusive create alone; on Windows it is the explicit `lstat` refusal
    // inside `copyToNewFile` that has to hold it up.
    it("refuses a symlink destination instead of following it, live or dangling", async () => {
      const { copyToNewFile } = await import("../src/sidecar.js");
      const dir = join(tempDir, "exclusive-create-contract");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "src"), "SRC\n");
      writeFileSync(join(dir, "victim"), "VICTIM\n");
      symlinkSync(join(dir, "victim"), join(dir, "live"));
      symlinkSync(join(dir, "nothere"), join(dir, "dangling"));

      for (const link of ["live", "dangling"]) {
        expect(() => copyToNewFile(join(dir, "src"), join(dir, link))).toThrow(
          expect.objectContaining({ code: "EEXIST" })
        );
      }
      expect(readFileSync(join(dir, "victim"), "utf-8")).toBe("VICTIM\n");
      expect(existsSync(join(dir, "nothere"))).toBe(false);
      // A free name still works, and the bytes are the source's.
      copyToNewFile(join(dir, "src"), join(dir, "free"));
      expect(readFileSync(join(dir, "free"), "utf-8")).toBe("SRC\n");
    });

    it("does not write the bundle's index through a dangling symlink at MEMORY.md", async () => {
      const link = join(targetMemDir(), "MEMORY.md");
      plantDanglingSymlink(link);

      const result = await runImport();
      expect(result.success).toBe(true);
      if (!result.success) return;

      expectNothingEscaped(link);
      // The layer degrades rather than aborting: the prose memory still lands,
      // the index is reported unreadable rather than replaced, and the session
      // import is untouched by any of it.
      expect(existsSync(join(targetMemDir(), "test_memory.md"))).toBe(true);
      expect(
        result.warnings.some((w) => w.includes("Could not read the existing memory index"))
      ).toBe(true);
      expect(result.importedSessions).toHaveLength(1);
    });

    it("does not write a bundle memory through a dangling symlink at its name", async () => {
      const link = join(targetMemDir(), "test_memory.md");
      plantDanglingSymlink(link);

      const result = await runImport();
      expect(result.success).toBe(true);
      if (!result.success) return;

      expectNothingEscaped(link);
      // EEXIST fell through to the compare branch, which cannot read the link
      // and so keeps local — and did not abort the layer: the index landed.
      expect(
        result.warnings.some((w) =>
          w.includes('Memory file "test_memory.md" could not be compared')
        )
      ).toBe(true);
      expect(existsSync(join(targetMemDir(), "MEMORY.md"))).toBe(true);
    });

    it("does not write a bundle plan through a dangling symlink at its name", async () => {
      const plansDir = join(targetConfigDir, "plans");
      const link = join(plansDir, "test-plan.md");
      plantDanglingSymlink(link);

      const result = await runImport({ includePlans: true });
      expect(result.success).toBe(true);
      if (!result.success) return;

      // `plans/` is config-dir-GLOBAL, so a link planted here is reachable
      // from every project on the machine, not just this one.
      expectNothingEscaped(link);
      expect(readdirSync(plansDir)).toEqual(["test-plan.md"]);
      expect(result.importedSessions).toHaveLength(1);
    });

    it("does not write the merged index through a dangling symlink when the bundle carries none", async () => {
      // The index has a SECOND write site — the one that appends a pointer to
      // a parked copy — and it is reachable with no index anywhere: not in the
      // bundle (removed from the exported directory, which nothing verifies —
      // see step 3b) and not locally, where the name is a dangling symlink.
      const from = await exportWithMemory({}, "no-index-export");
      rmSync(join(from, "memory", "MEMORY.md"), { force: true });

      seedMemory("test_memory.md", "mine, and staying mine\n");
      const link = join(targetMemDir(), "MEMORY.md");
      plantDanglingSymlink(link);

      const result = await runImport({ from });
      expect(result.success).toBe(true);
      if (!result.success || !("memoryConflicts" in result)) return;

      expectNothingEscaped(link);
      // Parking is unaffected — it writes a name of its own, exclusively.
      expect(result.memoryConflicts?.[0].parkedAs).toBe("test_memory.incoming.md");
      expect(readMemory("test_memory.md")).toBe("mine, and staying mine\n");
      expect(readMemory("test_memory.incoming.md")).toContain("Use vitest for testing.");
    });

    // #68. The three sites above are not the only exclusive write in this step:
    // parking goes through `sidecar.ts`'s `copyToUniqueName`, whose suffix loop
    // uses EEXIST as its "try the next name" signal — so the SAME hazard lives
    // there, and a link at the parked name would be written through rather than
    // stepped over. This is also the one test that covers `copyToUniqueName` on
    // every platform: `hub-merge.test.ts`'s sidecar symlink tests are
    // `skipIf(isWindows)`, so the shared helper's other caller cannot see it.
    it("does not park an incoming memory through a dangling symlink at the parked name", async () => {
      seedMemory("test_memory.md", "mine, not theirs\n");
      const link = join(targetMemDir(), "test_memory.incoming.md");
      plantDanglingSymlink(link);

      const result = await runImport();
      expect(result.success).toBe(true);
      if (!result.success || !("memoryConflicts" in result)) return;

      expectNothingEscaped(link);
      // The occupied name was stepped over, not written through: the parked
      // copy took the next name and the local file is still the local file.
      expect(result.memoryConflicts?.[0].parkedAs).toBe("test_memory.incoming-2.md");
      expect(readMemory("test_memory.incoming-2.md")).toContain("Use vitest for testing.");
      expect(readMemory("test_memory.md")).toBe("mine, not theirs\n");
      expect(readMemory("MEMORY.md")).toContain("(test_memory.incoming-2.md)");
    });

    it("treats EEXIST as an answer, not a failure: real files still compare, park and report", async () => {
      // No symlink here. The point is the control flow: after #64 the
      // exclusive write is the ONLY thing that decides a destination is taken,
      // so every ordinary collision reaches the compare branch via EEXIST.
      // Swallowing it, or letting it abort the layer, shows up here as a
      // skipped union, an unparked memory, or a missing plan conflict.
      seedMemory("MEMORY.md", "# Memory Index\n\n- [Local note](local-note.md) — mine\n");
      seedMemory("test_memory.md", "mine, not theirs\n");
      const plansDir = join(targetConfigDir, "plans");
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(join(plansDir, "test-plan.md"), "# My own plan\n");

      const result = await runImport({ includePlans: true });
      expect(result.success).toBe(true);
      if (!result.success || !("memoryConflicts" in result)) return;

      // Index: unioned, local line verbatim and still first.
      const index = readMemory("MEMORY.md");
      expect(index.startsWith("# Memory Index\n\n- [Local note](local-note.md) — mine\n")).toBe(
        true
      );
      expect(index).toContain("(test_memory.md)");
      expect(index).toContain("(test_memory.incoming.md)");
      // Prose memory: local bytes untouched, incoming parked beside it.
      expect(readMemory("test_memory.md")).toBe("mine, not theirs\n");
      expect(result.memoryConflicts?.[0].parkedAs).toBe("test_memory.incoming.md");
      expect(readMemory("test_memory.incoming.md")).toContain("Use vitest for testing.");
      // Plan: local bytes untouched, conflict reported, nothing parked.
      expect(readFileSync(join(plansDir, "test-plan.md"), "utf-8")).toBe("# My own plan\n");
      expect(result.planConflicts?.[0].filename).toBe("test-plan.md");
      expect(readdirSync(plansDir)).toEqual(["test-plan.md"]);
    });

    it("skips a symlinked memory in a directory-form bundle instead of reading through it", async () => {
      // Source side, same class: a directory export is handed to the importer
      // as-is (only `archiver.ts` rejects symlink entries, and only at
      // extraction), so a memory file can be a link to anything on this
      // machine. `statSync().isFile()` would have copied its CONTENT into the
      // target's memory folder under an innocuous name.
      const secret = join(tempDir, "secret.md");
      writeFileSync(secret, "TOP_SECRET_MARKER\n");
      const from = await exportWithMemory({}, "symlink-memory-export");
      symlinkSync(secret, join(from, "memory", "borrowed.md"));

      const result = await runImport({ from });
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(existsSync(join(targetMemDir(), "borrowed.md"))).toBe(false);
      expect(
        result.warnings.some((w) => w.includes('Ignored "borrowed.md"'))
      ).toBe(true);
      // The real memories in the same bundle still arrive.
      expect(existsSync(join(targetMemDir(), "test_memory.md"))).toBe(true);
    });

    // --- #68 part 1: the layer ROOT is probed with lstat too ---
    //
    // #64 closed every per-FILE read (`isRegularFile`) and every destination
    // write, but the two probes that decide whether to WALK a layer at all were
    // still `existsSync`, which resolves links. A directory-form bundle whose
    // `memory/` is itself a symlink to `~/.ssh` therefore had its real files
    // enumerated and copied into the target's memory folder — a read-side
    // gather into the directory a later session reads prose out of.
    //
    // `"junction"` as the link type so these run on Windows as well as POSIX:
    // a directory symlink needs elevation there, a junction does not, and
    // `lstat` reports both as symbolic links. A `skipIf(isWindows)` here would
    // turn a real hole into a green check on the one platform whose primitives
    // differ (see `copyToNewFile`).
    const secretLayerDir = (name: string, files: Record<string, string>): string => {
      const dir = join(tempDir, name);
      mkdirSync(dir, { recursive: true });
      for (const [f, content] of Object.entries(files)) {
        writeFileSync(join(dir, f), content);
      }
      return dir;
    };

    it("refuses a symlinked memory ROOT in a directory-form bundle instead of walking it", async () => {
      const secret = secretLayerDir("memory-root-secrets", {
        "id_rsa.md": "TOP_SECRET_MARKER\n",
        "MEMORY.md": "- [Theirs](id_rsa.md) — planted\n",
      });
      const from = await exportWithMemory({}, "symlink-memory-root-export");
      rmSync(join(from, "memory"), { recursive: true, force: true });
      symlinkSync(secret, join(from, "memory"), "junction");

      const result = await runImport({ from });
      expect(result.success).toBe(true);
      if (!result.success || !("memoryIndex" in result)) return;

      // Nothing was enumerated through the link. The target memory directory is
      // not even created, so no file behind it can have landed under any name.
      expect(existsSync(targetMemDir())).toBe(false);
      expect(result.memoryDir).toBeUndefined();
      expect(result.memoryIndex).toBeUndefined();
      expect(
        result.warnings.some((w) => w.includes("memory folder in this bundle is a symlink"))
      ).toBe(true);
      // The layer degrades; it does not abort the import.
      expect(result.importedSessions).toHaveLength(1);
    });

    it("refuses a symlinked plans ROOT in a directory-form bundle instead of walking it", async () => {
      // `plans/` is config-dir-GLOBAL, so files gathered through a symlinked
      // bundle root land in a directory every project on this machine shares.
      const secret = secretLayerDir("plans-root-secrets", {
        "stolen.md": "TOP_SECRET_MARKER\n",
      });
      const from = await exportWithMemory({}, "symlink-plans-root-export");
      rmSync(join(from, "plans"), { recursive: true, force: true });
      symlinkSync(secret, join(from, "plans"), "junction");

      const result = await runImport({ from });
      expect(result.success).toBe(true);
      if (!result.success || !("memoryIndex" in result)) return;

      expect(existsSync(join(targetConfigDir, "plans"))).toBe(false);
      expect(result.planConflicts).toBeUndefined();
      expect(
        result.warnings.some((w) => w.includes("plans folder in this bundle is a symlink"))
      ).toBe(true);
      expect(result.importedSessions).toHaveLength(1);
      // The bundle's OTHER shared layer is untouched by the refusal.
      expect(existsSync(join(targetMemDir(), "test_memory.md"))).toBe(true);
    });

    // --- #68 part 2: an unreadable plans destination is disclosed ---
    it("says so when a plans destination cannot be read, instead of delivering nothing in silence", async () => {
      // A directory standing where the incoming plan's name goes: the exclusive
      // create answers EEXIST, and the compare then cannot read it (EISDIR).
      // Before #68 that fell straight through to `continue` — no warning, no
      // `planConflicts`, nothing at all in a result the skill layer branches on
      // since #59. The memory side already warns in exactly this situation.
      const plansDir = join(targetConfigDir, "plans");
      mkdirSync(join(plansDir, "test-plan.md"), { recursive: true });

      const result = await runImport({ includePlans: true });
      expect(result.success).toBe(true);
      if (!result.success || !("memoryIndex" in result)) return;

      expect(
        result.warnings.some((w) =>
          w.includes('Plan "test-plan.md" could not be compared with the incoming copy')
        )
      ).toBe(true);
      // A warning and NOT a `planConflicts` entry — the same class the memory
      // side produces. An `AuxiliaryConflict` asserts the two copies differ and
      // carries a hash of each, and here one of them could not be read at all.
      expect(result.planConflicts).toBeUndefined();
      // Nothing was written into the directory occupying the name.
      expect(readdirSync(join(plansDir, "test-plan.md"))).toEqual([]);
      expect(result.importedSessions).toHaveLength(1);
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

    it("refuses a bundle whose manifest declares an absent session, and --session-id imports the rest", async () => {
      // The proof behind the refusal's own suggestion: it says to re-run with
      // `--session-id` naming the sessions that ARE present, so this test runs
      // exactly that. A `pull` surfaces the same sentence verbatim, which is
      // why the message names `sesh-mover import` with the flag.
      const { importSession } = await import("../src/importer.js");
      const { readManifest, writeManifest } = await import("../src/manifest.js");
      const { readdirSync, statSync } = await import("node:fs");

      /** Every path under the target config dir, with its size — repo-relative. */
      const configDirState = (): string[] => {
        const walk = (rel: string): string[] =>
          readdirSync(join(targetConfigDir, rel), { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))
            .flatMap((e) =>
              e.isDirectory()
                ? [`${rel}/${e.name}/`, ...walk(`${rel}/${e.name}`)]
                : [`${rel}/${e.name} ${statSync(join(targetConfigDir, rel, e.name)).size}`]
            );
        return walk("");
      };

      // Declare a SECOND session the bundle does not contain. Written through
      // writeManifest, so `sessionsDigest` is restamped and the manifest stays
      // internally consistent — the only thing wrong is the missing FILE,
      // which is what a truncated transfer or a half-finished unpack leaves.
      const ghostId = "11111111-2222-3333-4444-555555555555";
      const manifest = readManifest(exportPath);
      manifest.sessions.push({
        ...manifest.sessions[0],
        sessionId: ghostId,
        slug: "ghost-session",
      });
      writeManifest(exportPath, manifest);

      const before = configDirState();
      const refused = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(refused.success).toBe(false);
      const err = refused as ErrorResult;
      expect(err.error).toContain("Bundle integrity check failed");
      expect(err.error).toContain("no session file in the bundle");
      expect(err.error).toContain(ghostId);
      expect(err.suggestion ?? "").toContain("--session-id");
      // "before any write" is the claim the message rests on: the target config
      // dir has to be byte-identical, not merely free of session JSONLs.
      expect(configDirState()).toEqual(before);
      expect(await landedSessions()).toHaveLength(0);

      // The advised re-run. The refusal is scoped to what the invocation asked
      // for, so naming the present session skips the absent one entirely.
      const second = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
        sessionIds: [sessionId],
      });
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect((second as ImportResult).importedSessions).toHaveLength(1);
      expect((second as ImportResult).importedSessions[0].originalId).toBe(sessionId);
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
        // The claim is "no digest, no complaint" — so the plans layer has to be
        // applied here rather than skipped, or the empty-warnings assertion
        // would be satisfied by the opt-in notice being the only thing missing.
        includePlans: true,
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

  /**
   * The importer is one of the five `readManifest` callers #72 audits. Its
   * failure contract is the loudest of them — `readManifest` already sits
   * inside a try/catch that returns a typed `ErrorResult` — which is most of
   * the argument for folding the shape guard into `readManifest` rather than
   * repeating it at five call sites: this site absorbs it verbatim.
   */
  describe("manifest shape refusal (#72)", () => {
    const targetProjectPath = "/Users/newuser/Projects/newproject";

    /** Rewrite the export's manifest.json with `sessions` set to `value`. */
    async function setSessions(value: unknown): Promise<void> {
      const raw = JSON.parse(readFileSync(join(exportPath, "manifest.json"), "utf-8"));
      raw.sessions = value;
      writeFileSync(join(exportPath, "manifest.json"), JSON.stringify(raw, null, 2));
    }

    /** Every .jsonl now in the target project dir. */
    async function landedSessions(): Promise<string[]> {
      const { encodeProjectPath } = await import("../src/platform.js");
      const dir = join(targetConfigDir, "projects", encodeProjectPath(targetProjectPath));
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
    }

    it('refuses `sessions: "abc"` as a typed error, without fabricating a count', async () => {
      const { importSession } = await import("../src/importer.js");
      await setSessions("abc");

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(result.success).toBe(false);
      const err = result as ErrorResult;
      expect(err.command).toBe("import");
      expect(err.error).toMatch(/not a sesh-mover bundle manifest/i);
      // Before the guard this reached step 1b instead, which iterated the
      // string's characters and reported `3 session(s) declared by
      // manifest.json` — a session count invented from a string's length, by
      // the very check whose job is refusing invented inventories.
      expect(err.error).not.toMatch(/3 session\(s\)/);
      expect(await landedSessions()).toHaveLength(0);
      expect(existsSync(join(targetConfigDir, "history.jsonl"))).toBe(false);
    });

    it('refuses `sessions: "abc"` with --session-id too, where it used to TypeError', async () => {
      // The sharper half. `targetSessions = manifest.sessions.filter(...)` sits
      // OUTSIDE the try/catch around `readManifest`, so with a string list and
      // a --session-id this used to throw `manifest.sessions.filter is not a
      // function` straight out of `importSession` — an unhandled rejection on a
      // path that has three callers (import, migrate, hub pull).
      const { importSession } = await import("../src/importer.js");
      await setSessions("abc");

      const result = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
        sessionIds: [sessionId],
      });

      expect(result.success).toBe(false);
      expect((result as ErrorResult).error).toMatch(/not a sesh-mover bundle manifest/i);
      expect(await landedSessions()).toHaveLength(0);
    });
  });

  /**
   * The durable-bookkeeping tail (#28). Three steps run after the write loop's
   * rollback is out of reach, and each one used to throw the whole in-memory
   * `SyncState` away with the rejected promise — leaving the sessions on disk
   * and `state.imported` unwritten, so the next attempt imported them all over
   * again. Each test drives the real failure with an EISDIR (a directory where
   * a file has to be written), which reproduces on any uid.
   */
  describe("durable bookkeeping survives a failing tail (#28)", () => {
    const targetProjectPath = "/Users/newuser/Projects/newproject";

    async function importOnce(): Promise<ImportResult | ErrorResult> {
      const { importSession } = await import("../src/importer.js");
      return (await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      })) as ImportResult | ErrorResult;
    }

    it("a project dir that cannot take the identity file does not cost the import registry", async () => {
      // `writeLocalProjectId` writes into the user's PROJECT directory, the one
      // place in this tail that is outside the config dir. A project dir the
      // importing user cannot write made it throw deterministically — every
      // retry, forever — and the retry is what created the duplicates.
      const { readSyncState } = await import("../src/sync-state.js");
      const { PROJECT_JSON_FILE_NAME } = await import("../src/paths.js");

      const projectDir = join(tempDir, "proj");
      mkdirSync(projectDir, { recursive: true });
      // A DIRECTORY where the identity file goes: writeFileSync -> EISDIR.
      mkdirSync(join(projectDir, PROJECT_JSON_FILE_NAME), { recursive: true });

      // The bundle has to carry a projectId for that write to be attempted.
      const raw = JSON.parse(readFileSync(join(exportPath, "manifest.json"), "utf-8"));
      raw.projectId = "11111111-1111-1111-1111-111111111111";
      writeFileSync(join(exportPath, "manifest.json"), JSON.stringify(raw, null, 2));

      const { importSession } = await import("../src/importer.js");
      const first = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: projectDir,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });

      expect(first.success).toBe(true);
      if (!first.success) return;
      expect(
        (first as ImportResult).warnings.some((w) =>
          w.includes("Could not write the project identity file")
        )
      ).toBe(true);

      // The registry reached disk, which is the whole point.
      const state = readSyncState(projectDir);
      expect(Object.keys(state.imported)).toHaveLength(1);

      // And the consequence that used to follow is gone: a re-run is a
      // duplicate, not a second copy.
      const second = await importSession({
        exportPath,
        targetConfigDir,
        targetProjectPath: projectDir,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });
      expect(second.success).toBe(true);
      if (!second.success) return;
      expect((second as ImportResult).importedSessions).toHaveLength(0);
      expect((second as ImportResult).skippedSessions).toEqual([
        { originalId: sessionId, reason: "duplicate" },
      ]);
    });

    it("a history.jsonl that cannot be appended records registered:false rather than throwing", async () => {
      const { readSyncState } = await import("../src/sync-state.js");
      // A DIRECTORY named history.jsonl: appendFileSync -> EISDIR.
      mkdirSync(join(targetConfigDir, "history.jsonl"), { recursive: true });

      const result = await importOnce();
      expect(result.success).toBe(true);
      if (!result.success) return;
      const ok = result as ImportResult;

      expect(ok.warnings.some((w) => w.includes("resume list"))).toBe(true);
      // `resumable` has to tell the truth: the session imported, but Claude
      // Code will not offer it.
      expect(ok.resumable).toBe(false);
      expect(ok.importedSessions).toHaveLength(1);

      const state = readSyncState(targetProjectPath);
      const entries = Object.values(state.imported);
      expect(entries).toHaveLength(1);
      // The flag that the dedup filter reads. Recorded as it HAPPENED, so the
      // next import re-imports (correct: the session is not resumable yet)
      // rather than skipping it forever as a registered duplicate.
      expect(entries[0].registered).toBe(false);
    });

    it("does not blame --no-register for an unregistered copy the user never asked for", async () => {
      // The misattribution found in #78's round. `registered` is written as
      // `!noRegister && !registrationFailed.has(id)`, so it is `false` for TWO
      // causes — the flag, and a `history.jsonl` append that THREW — and
      // `SyncStateImported` carries that single boolean and no reason. This run
      // takes the second cause and passes no flag at all, so a message naming
      // `--no-register` as THE cause names a flag the user never typed.
      const { readSyncState } = await import("../src/sync-state.js");
      const historyDir = join(targetConfigDir, "history.jsonl");
      mkdirSync(historyDir, { recursive: true });

      const first = await importOnce();
      expect(first.success).toBe(true);
      if (!first.success) return;
      // The premise, asserted rather than assumed: this import passed no flag
      // and still recorded `registered: false`.
      expect(Object.values(readSyncState(targetProjectPath).imported)[0].registered).toBe(false);

      // Clear the blockage so the next import CAN register, which is the branch
      // that emits the warning.
      rmSync(historyDir, { recursive: true, force: true });

      const second = await importOnce();
      expect(second.success).toBe(true);
      if (!second.success) return;
      const warn = (second as ImportResult).warnings.find((w) => w.includes("unregistered"));
      expect(warn).toBeDefined();

      // The two causes are NOT distinguishable from what is recorded, so the
      // message must offer both and assert neither. It may still NAME the flag
      // — as one of two possibilities, which is true — and it must still name
      // the other, which is the half that was missing.
      expect(warn).toMatch(/either because/i);
      expect(warn).toContain("could not write");
      expect(warn).toContain("--no-register");

      // …and the behaviour the sentence describes is unchanged: a registered
      // copy really is imported.
      expect((second as ImportResult).importedSessions).toHaveLength(1);
      expect((second as ImportResult).resumable).toBe(true);
    });

    it("a sync-state that cannot be written is a warning, not a discarded import", async () => {
      // The last step of the tail, and the only one whose failure the import
      // genuinely survives: files written, sessions registered. Throwing there
      // discarded a COMPLETED import — and on `migrate` it left the source
      // sessions undeleted beside the copies that had already landed.
      const { syncStatePath } = await import("../src/sync-state.js");
      // A DIRECTORY where the state file goes: writeSyncState's rename -> EISDIR.
      mkdirSync(syncStatePath(targetProjectPath), { recursive: true });

      const result = await importOnce();
      expect(result.success).toBe(true);
      if (!result.success) return;
      const ok = result as ImportResult;
      expect(ok.importedSessions).toHaveLength(1);
      // The consequence has to be stated, because it is the one thing the user
      // can act on: the next import of this bundle will not be deduped.
      expect(
        ok.warnings.some((w) => w.includes("sync-state could not be saved"))
      ).toBe(true);
      expect(ok.warnings.some((w) => w.includes("second copy"))).toBe(true);
    });

    it("a __proto__ session id from a new peer keeps its receipt as an own key", async () => {
      // sync-state.ts's rule is "anything that BUILDS one of these records must
      // use foreignKeyedRecord". The importer BUILDS one, for a peer it has
      // never seen — so it does not inherit the container-level guarantee. On a
      // plain object `received["__proto__"] = receipt` invokes the inherited
      // setter, creates no own key, and serializes as `{}`.
      const { readSyncState } = await import("../src/sync-state.js");
      const { writeManifest, readManifest, computeIntegrityHashFromFile } = await import(
        "../src/manifest.js"
      );
      const { renameSync } = await import("node:fs");

      const manifest = readManifest(exportPath);
      renameSync(
        join(exportPath, "sessions", `${sessionId}.jsonl`),
        join(exportPath, "sessions", "__proto__.jsonl")
      );
      manifest.sessions[0].sessionId = "__proto__";
      manifest.sessions[0].integrityHash = await computeIntegrityHashFromFile(
        join(exportPath, "sessions", "__proto__.jsonl")
      );
      manifest.sourceMachineId = "peer-never-seen-before";
      manifest.sourceMachineName = "laptop";
      writeManifest(exportPath, manifest);

      const result = await importOnce();
      expect(result.success).toBe(true);
      if (!result.success) return;

      const state = readSyncState(targetProjectPath);
      const peer = state.peers["peer-never-seen-before"];
      expect(peer).toBeDefined();
      expect(Object.hasOwn(peer.received, "__proto__")).toBe(true);
      expect(peer.received["__proto__"].localSessionId).toBe(
        (result as ImportResult).importedSessions[0].newId
      );
      // The receipt has to survive the round trip to disk, which is where the
      // prototype write lost it: JSON.stringify reads own enumerable keys only.
      expect(JSON.stringify(peer.received)).toContain("__proto__");
    });
  });
});

/**
 * `formatMemoryPointer` is the chokepoint that stops a bundle writing lines of
 * its choosing into the user's `MEMORY.md`. These are unit tests over the rule
 * itself; the two importer tests above are the same rule seen end to end.
 *
 * The module under test has no other test file, so the ordinary-case round trip
 * is asserted here too — a guard that only ever sees hostile input is one
 * refactor away from refusing everything and still passing.
 */
describe("memory index pointer construction", () => {
  /** ESC, spelled by code point so no literal control byte sits in this file. */
  const ESC = String.fromCharCode(0x1b);
  /** Everything a pointer line may not carry: C0, DEL, C1, and U+2028/9. */
  const CONTROLISH = new RegExp("[\\u0000-\\u001f\\u007f\\u0080-\\u009f\\u2028\\u2029]");

  it("round-trips an ordinary pointer through this module's own parser", async () => {
    const { formatMemoryPointer, pointerTarget, splitIndexLines } = await import(
      "../src/memory-index.js"
    );
    const line = formatMemoryPointer(
      "notes (incoming copy)",
      "notes.incoming.md",
      "incoming version of notes.md from laptop — differs from your copy, not merged"
    );
    expect(line).toBe(
      "- [notes (incoming copy)](notes.incoming.md) — incoming version of notes.md from laptop — differs from your copy, not merged"
    );
    expect(splitIndexLines(line!)).toHaveLength(1);
    expect(pointerTarget(line!)).toBe("notes.incoming.md");
  });

  it("cannot emit a second line, whatever a bundle puts in the title or description", async () => {
    const { formatMemoryPointer, memoryIndexTargets, splitIndexLines } = await import(
      "../src/memory-index.js"
    );
    const PAYLOAD = "- [pwned](pwned.md) — injected";
    for (const hostile of [
      "x\n" + PAYLOAD,
      "x\r" + PAYLOAD,
      "x\r\n" + PAYLOAD,
      "x " + PAYLOAD,
      "x" + ESC + "[2K\r" + PAYLOAD,
    ]) {
      for (const line of [
        formatMemoryPointer(hostile, "real.md", "d"),
        formatMemoryPointer("t", "real.md", hostile),
      ]) {
        expect(line, JSON.stringify(hostile)).not.toBeNull();
        expect(splitIndexLines(line!)).toHaveLength(1);
        // Not merely "one line to `splitIndexLines`": a lone CR is a line ending
        // to CommonMark and to a terminal, and an ESC redraws one.
        expect(CONTROLISH.test(line!), JSON.stringify(line)).toBe(false);
        expect(memoryIndexTargets(line!)).toEqual(["real.md"]);
      }
    }
  });

  it("keeps a title from stealing the link destination with a bare `](`", async () => {
    const { formatMemoryPointer, pointerTarget } = await import("../src/memory-index.js");
    // No newline needed for this one: `pointerTarget` reads the FIRST `](` on
    // the line, so a `]` in the title forges the key the union dedups on. A
    // backslash escape would satisfy a renderer and not this parser, which is
    // why the `]` is removed rather than escaped.
    const line = formatMemoryPointer("x](pwned.md) — injected [y", "real.md", "d");
    expect(line).not.toBeNull();
    expect(pointerTarget(line!)).toBe("real.md");
  });

  it("refuses a target it cannot express, instead of emitting a link that points elsewhere", async () => {
    const { formatMemoryPointer } = await import("../src/memory-index.js");
    for (const target of [
      "we)ird.md", // closes the destination early
      "we(ird.md", // unbalanced the other way
      "two words.md", // a markdown destination ends at the first space
      "tab\tname.md",
      "carriage\rreturn.md", // NOT whitespace to normalizeMemoryTarget: it would round-trip
      "line\nbreak.md",
      "./relative.md", // normalizeMemoryTarget strips the prefix, so it is not the key
      "../escape.md",
      "/absolute.md",
      "https://example.com/x.md",
      "",
      "   ",
    ]) {
      expect(formatMemoryPointer("t", target, "d"), `target ${JSON.stringify(target)}`).toBeNull();
    }
  });

  it("accepts a target the parser really can express, so the refusal is not a blanket one", async () => {
    const { formatMemoryPointer, pointerTarget } = await import("../src/memory-index.js");
    // A `]` is legal in a markdown DESTINATION (only parens, whitespace and the
    // `<>` form matter there) and it round-trips, so it is not refused. This is
    // the round-trip check earning its keep: a hand-written denylist of
    // "characters that break links" would have rejected this one for symmetry
    // with the title rule, and cost the user a reachable memory for nothing.
    const line = formatMemoryPointer("t", "we]ird.md", "d");
    expect(line).not.toBeNull();
    expect(pointerTarget(line!)).toBe("we]ird.md");
  });

  it("degrades an unsafe display character rather than dropping the whole pointer", async () => {
    const { sanitizePointerText } = await import("../src/memory-index.js");
    // A space, not nothing: "a\nb" must not silently read as "ab".
    expect(sanitizePointerText("a\nb")).toBe("a b");
    expect(sanitizePointerText("a" + ESC + "[31mb")).toBe("a [31mb");
    expect(sanitizePointerText("plain (text) — ok")).toBe("plain (text) — ok");
  });
});
