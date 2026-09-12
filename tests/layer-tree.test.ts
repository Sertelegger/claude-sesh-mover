/**
 * # Nested layer directories (#121)
 *
 * Claude Code writes `subagents/workflows/<wf_id>/` for any session that has
 * run a Workflow. Every layer walk in this codebase was a flat `readdirSync`
 * feeding `copyFileSync`, and what that did when it met the directory depended
 * on the filesystem — which is why it took so long to be recognised as ONE bug:
 *
 * - a NON-EMPTY directory threw, because `copyFileSync` sizes its copy loop
 *   from `st_size` (`EISDIR` on Linux; on macOS `copyfile(3)` reports any
 *   non-regular file as "operation not supported on socket", which sent the
 *   first reporter hunting for a socket that did not exist). Export failed, and
 *   with it `push` and the SessionEnd auto-push.
 * - an EMPTY directory on a filesystem that reports `st_size` 0 for directories
 *   — btrfs, measured — threw nothing and wrote a ZERO-BYTE FILE named
 *   `workflows` into the bundle, which then passed the bundle's own integrity
 *   check because the digest hashed it as an ordinary file.
 *
 * The fix is one shared walk (`layerFiles`) behind all four sites: the digest,
 * the export copy, the importer, and the hub pull. The tests below are written
 * against the ways that could be half-done, because a half-done version is
 * worse than the bug: an exporter that recurses while the importer does not
 * converts a loud export failure into a rollback on the receiving machine.
 *
 * Every guard here is filesystem and byte comparison, so its proof lives on
 * Linux; there is no platform-specific behaviour to chase on the Windows job
 * beyond the separator normalisation pinned in `manifest.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureTree } from "./fixtures/create-fixtures.js";

const SRC_CWD = "/Users/testuser/Projects/testproject";

/** One workflow journal line — NOT a transcript: no uuid, no cwd, no sessionId. */
const JOURNAL_LINE = JSON.stringify({
  type: "result",
  key: "v2:abc",
  agentId: "a1234567890abcdef",
  label: "review:bugs",
  phase: "Review",
});

describe("nested layer directories (#121)", () => {
  let base: string;
  let configDir: string;
  let projectDir: string;
  let sessionId: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "sm-layertree-"));
    ({ configDir, projectDir, sessionId } = createFixtureTree(base));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** The shape Claude Code actually writes, added to the fixture's flat layer. */
  function addWorkflowTree(opts: { empty?: boolean } = {}): string {
    const wf = join(projectDir, sessionId, "subagents", "workflows", "wf_abc123");
    mkdirSync(wf, { recursive: true });
    if (opts.empty) return wf;
    writeFileSync(
      join(wf, "agent-anested01.jsonl"),
      JSON.stringify({
        uuid: "nested-1",
        timestamp: "2026-04-10T12:05:00Z",
        sessionId,
        cwd: SRC_CWD,
        version: "2.1.81",
        type: "user",
        message: { role: "user", content: "nested agent turn" },
        isSidechain: true,
        agentId: "anested01",
      }) + "\n"
    );
    writeFileSync(join(wf, "agent-anested01.meta.json"), JSON.stringify({ agentType: "general" }));
    writeFileSync(join(wf, "journal.jsonl"), JOURNAL_LINE + "\n");
    return wf;
  }

  async function exportTo(name: string) {
    const { exportSession } = await import("../src/exporter.js");
    return exportSession({
      configDir,
      projectPath: SRC_CWD,
      sessionId,
      outputDir: join(base, "exports"),
      name,
      excludeLayers: [],
      claudeVersion: "2.1.81",
    });
  }

  it("exports a session whose subagents/ holds a directory — the #121 regression", async () => {
    addWorkflowTree();
    const result = await exportTo("nested");
    expect(result.success).toBe(true);
    if (!result.success || !("exportPath" in result)) return;

    const out = join(result.exportPath, "sessions", sessionId, "subagents", "workflows", "wf_abc123");
    expect(existsSync(join(out, "agent-anested01.jsonl"))).toBe(true);
    expect(existsSync(join(out, "agent-anested01.meta.json"))).toBe(true);
    expect(existsSync(join(out, "journal.jsonl"))).toBe(true);
    // The flat siblings still travel.
    expect(
      existsSync(join(result.exportPath, "sessions", sessionId, "subagents", "agent-sub1.jsonl"))
    ).toBe(true);
  });

  /**
   * The SILENT half, and the reason this is not merely an availability bug. On
   * btrfs an empty directory reports `st_size` 0, `copyFileSync` does not
   * throw, and the bundle gets a zero-byte regular file where a directory
   * belongs — indistinguishable, to every later reader, from a file the session
   * really had.
   */
  it("does not turn an EMPTY nested directory into a zero-byte file", async () => {
    addWorkflowTree({ empty: true });
    const result = await exportTo("empty-nested");
    expect(result.success).toBe(true);
    if (!result.success || !("exportPath" in result)) return;

    const planted = join(result.exportPath, "sessions", sessionId, "subagents", "workflows");
    // Either absent (an empty directory carries no files, so nothing to copy)
    // or a real directory — never a file.
    if (existsSync(planted)) {
      const { statSync } = await import("node:fs");
      expect(statSync(planted).isFile()).toBe(false);
    }
  });

  it("covers nested files in the layer digest, so a tampered one is caught", async () => {
    addWorkflowTree();
    const result = await exportTo("digest");
    expect(result.success).toBe(true);
    if (!result.success || !("exportPath" in result)) return;

    const { readManifest } = await import("../src/manifest.js");
    const manifest = readManifest(result.exportPath);
    const declared = manifest.sessions[0]?.layerDigests?.subagents;
    expect(declared).toBeTruthy();

    const { computeLayerDigest } = await import("../src/manifest.js");
    const layerDir = join(result.exportPath, "sessions", sessionId, "subagents");
    expect(await computeLayerDigest(layerDir)).toBe(declared);

    // Edit a NESTED file: before #121 this changed nothing the manifest knew about.
    writeFileSync(join(layerDir, "workflows", "wf_abc123", "agent-anested01.meta.json"), "{}");
    expect(await computeLayerDigest(layerDir)).not.toBe(declared);
  });

  it("round-trips through import: nested transcripts are PATH-REWRITTEN, the journal is not", async () => {
    addWorkflowTree();
    const exported = await exportTo("roundtrip");
    expect(exported.success).toBe(true);
    if (!exported.success || !("exportPath" in exported)) return;

    const targetBase = mkdtempSync(join(tmpdir(), "sm-layertree-target-"));
    const targetConfig = join(targetBase, ".claude");
    mkdirSync(targetConfig, { recursive: true });
    const targetProject = "/home/other/work/testproject";

    const { importSession } = await import("../src/importer.js");
    const imported = await importSession({
      exportPath: exported.exportPath,
      targetConfigDir: targetConfig,
      targetProjectPath: targetProject,
      targetClaudeVersion: "2.1.81",
      noRegister: true,
    });
    expect(imported.success).toBe(true);
    if (!imported.success || !("importedSessions" in imported)) return;
    const newId = imported.importedSessions[0].newId;

    const { encodeProjectPath } = await import("../src/platform.js");
    const landed = join(
      targetConfig, "projects", encodeProjectPath(targetProject), newId,
      "subagents", "workflows", "wf_abc123"
    );

    // 1. The nested tree arrived at all.
    expect(existsSync(join(landed, "agent-anested01.jsonl"))).toBe(true);

    // 2. The nested TRANSCRIPT was rewritten: new project path, new session id.
    const t = JSON.parse(readFileSync(join(landed, "agent-anested01.jsonl"), "utf-8").trim());
    expect(t.cwd).toBe(targetProject);
    expect(t.sessionId).toBe(newId);

    // 3. The JOURNAL was NOT. It is a `.jsonl` and it is not a transcript, so
    //    the rewrite would have stamped a `sessionId` into a schema that has
    //    none — `rewriteEntry` assigns it unconditionally. Byte-identical is
    //    the assertion, because "no sessionId" alone would pass against a
    //    rewrite that happened to drop the field.
    expect(readFileSync(join(landed, "journal.jsonl"), "utf-8")).toBe(JOURNAL_LINE + "\n");

    rmSync(targetBase, { recursive: true, force: true });
  });
});
