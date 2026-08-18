import { readTextLf } from "./helpers/eol.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { createRealProject, FIXTURE_ENCODED } from "./helpers/hub-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import {
  cleanTwin, git, gitProject, listFiles, writeTree,
} from "./helpers/project-tree.js";
import { scanGitRemotes } from "../src/payload/git-scan.js";
import type { ErrorResult, ExportResult, ImportResult } from "../src/types.js";

/**
 * EXPORT/IMPORT PAYLOAD PARITY (#47).
 *
 * `push`/`pull` and `export`/`import` are the same operation with different
 * transports, and until #47 only the hub path carried the project's FILES. This
 * file covers the two halves that arrived: the capture on `export`, and the
 * bootstrap apply on `import`.
 *
 * Every fixture is a real temp directory with real `git` — the conventions
 * forbid mocking the filesystem, and the guards under test (the
 * `NEVER_INCLUDABLE` floor, symlink refusals, the base-commit and dirty-tree
 * gates) are all about what the filesystem and git actually do.
 */

describe("export/import payload parity (#47)", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;
  let homeOverride: HomeOverrideHandle;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-payload-"));
    homeOverride = overrideHome(tempDir);
    const fixture = createFixtureTree(tempDir);
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
  });

  afterEach(() => {
    homeOverride.restore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Export the fixture session with a REAL project directory behind it.
   *
   * `createRealProject` re-encodes the fixture's config-dir project folder under
   * the real path, so `discoverSessions` finds the same transcript while
   * `projectPath` points at a directory that exists — which is what a payload
   * capture needs and what the shared fixture alone cannot give.
   */
  const exportFrom = async (
    projectPath: string,
    opts: { includeWorkspace?: boolean; includeCarry?: boolean; name?: string } = {}
  ): Promise<ExportResult> => {
    const { exportSession } = await import("../src/exporter.js");
    const result = await exportSession({
      configDir,
      projectPath,
      sessionId,
      outputDir: join(tempDir, "exports"),
      name: opts.name ?? `export-${Math.random().toString(36).slice(2, 8)}`,
      excludeLayers: [],
      claudeVersion: "2.1.81",
      includeWorkspace: opts.includeWorkspace,
      includeCarry: opts.includeCarry,
    });
    if (!result.success) throw new Error(`export failed: ${result.error}`);
    return result;
  };

  /** A real project directory whose sessions the fixture config dir already has. */
  const realProject = (name: string, files: Record<string, string> = {}): string => {
    const p = createRealProject(tempDir, configDir, name);
    writeTree(p, files);
    return p;
  };

  /**
   * Give an ALREADY-CREATED directory the fixture's sessions, by copying the
   * fixture's config-dir project folder under that path's encoding.
   *
   * `createRealProject` mints the directory itself, which is no use for a git
   * repository that has to be initialized first — and an export whose
   * `projectPath` the config dir knows nothing about discovers no sessions and
   * fails before it ever reaches the payload.
   */
  const linkSessions = (projectPath: string): string => {
    cpSync(
      join(configDir, "projects", FIXTURE_ENCODED),
      join(configDir, "projects", encodeProjectPath(projectPath)),
      { recursive: true }
    );
    return projectPath;
  };

  const importInto = async (
    bundle: string,
    targetProjectPath: string,
    filePayload: Partial<{
      applyWorkspace: boolean; applyCarry: boolean; forceWorkspace: boolean;
    }> = {}
  ): Promise<ImportResult | ErrorResult> => {
    const { importSession } = await import("../src/importer.js");
    const targetConfigDir = mkdtempSync(join(tempDir, "target-"));
    mkdirSync(join(targetConfigDir, "projects"), { recursive: true });
    const result = await importSession({
      exportPath: bundle,
      targetConfigDir,
      targetProjectPath,
      targetClaudeVersion: "2.1.81",
      dryRun: false,
      // PASSED THROUGH UNCOERCED, and that is the point rather than laziness.
      // This helper used to write `applyWorkspace: filePayload.applyWorkspace
      // === true`, which performed the very coercion under test before the
      // value reached `importSession` — so every "no flag asked for it" case
      // handed it an explicit `false`, and `=== true` was indistinguishable
      // from `!== false`. Found by mutation, not by reading: flipping the
      // orchestrator to `!== false` left this whole file green while two real
      // project files landed in a directory nobody consented to write.
      filePayload,
    });
    return result as ImportResult | ErrorResult;
  };

  // =========================================================================
  // CAPTURE
  // =========================================================================

  describe("capture: what an export puts in the bundle", () => {
    it("carries no project files by default, even from a dirty git project", async () => {
      // THE DEFAULT IS THE SECURITY DECISION. `hub push` builds its payload
      // unless told not to; an export bundle's destination is unknown at capture
      // time, so nothing travels unless the user asks. A test that only checked
      // the flag ON would pass with the default inverted.
      const project = realProject("plain-default", { "src/app.ts": "export const a = 1;\n" });
      const result = await exportFrom(project);

      expect(result.hasWorkspace).toBe(false);
      expect(result.carry).toBeUndefined();
      expect(existsSync(join(result.exportPath, "workspace"))).toBe(false);
      expect(existsSync(join(result.exportPath, "carry"))).toBe(false);

      const manifest = JSON.parse(readFileSync(join(result.exportPath, "manifest.json"), "utf-8"));
      expect(manifest.workspace).toBeUndefined();
      expect(manifest.carry).toBeUndefined();
    });

    it("takes the workspace snapshot for a project with no git remote", async () => {
      const project = realProject("plain-ws", {
        "src/app.ts": "export const a = 1;\n",
        "docs/notes.md": "notes\n",
      });
      // The premise, asserted rather than assumed: a stray `.git` in an ancestor
      // of the temp dir would make this `unknown` and the whole test vacuous.
      expect(scanGitRemotes(project).kind).toBe("none");

      const result = await exportFrom(project, { includeWorkspace: true });
      expect(result.hasWorkspace).toBe(true);

      const carried = listFiles(join(result.exportPath, "workspace"));
      expect(carried).toContain("src/app.ts");
      expect(carried).toContain("docs/notes.md");

      const manifest = JSON.parse(readFileSync(join(result.exportPath, "manifest.json"), "utf-8"));
      expect(manifest.workspace.fileCount).toBe(carried.length);
      // NO `basedOn`, ever. A workspace generation is identified by a hub bundle
      // id and is the one input `chooseMergeAncestor` treats as PROOF that a
      // generation was common to two trees; an export mints none, so declaring
      // one would put an id no hub bundle has into that set.
      expect(manifest.workspace.basedOn).toBeUndefined();
    });

    it("takes the carry, not the snapshot, for a project WITH a git remote", async () => {
      const project = linkSessions(gitProject("cap-carry"));
      writeFileSync(join(project, "tracked.txt"), "v2\n");
      writeFileSync(join(project, "new.txt"), "untracked\n");

      const { exportSession } = await import("../src/exporter.js");
      const result = await exportSession({
        configDir,
        projectPath: project,
        sessionId,
        outputDir: join(tempDir, "exports"),
        name: "git-carry",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        // BOTH requested. The git scan decides which one applies, not the user —
        // so this also pins that a remote-ful project gets no whole-tree copy.
        includeWorkspace: true,
        includeCarry: true,
      });
      if (!result.success) throw new Error("export failed");

      expect(result.hasWorkspace).toBe(false);
      expect(existsSync(join(result.exportPath, "workspace"))).toBe(false);
      expect(result.carry).toBeDefined();
      expect(existsSync(join(result.exportPath, "carry", "changes.patch"))).toBe(true);
      expect(readFileSync(join(result.exportPath, "carry", "untracked", "new.txt"), "utf-8"))
        .toBe("untracked\n");
      rmSync(project, { recursive: true, force: true });
    });

    it("captures NEITHER payload when git cannot be asked about this project", async () => {
      // The third arm of `GitRemoteScan`, and the security-critical one: reading
      // "I could not ask git" as "there is no remote" takes the whole-tree
      // snapshot — which does not read .gitignore — on a git project. There was
      // no export-side twin for this before #47.
      const project = realProject("unknown-arm", { "secret.env": "TOKEN=hunter2\n" });
      // A `.git` DIRECTORY with a HEAD is a repository marker, so the path is
      // "inside a repository"; with PATH emptied, `git remote` cannot run, and
      // the scan must answer `unknown` rather than `none`.
      mkdirSync(join(project, ".git"), { recursive: true });
      writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");

      const realPath = process.env.PATH;
      process.env.PATH = join(tempDir, "no-git-here");
      try {
        expect(scanGitRemotes(project).kind).toBe("unknown");
        const result = await exportFrom(project, {
          includeWorkspace: true, includeCarry: true, name: "unknown-arm-export",
        });
        expect(result.hasWorkspace).toBe(false);
        expect(result.carry).toBeUndefined();
        expect(existsSync(join(result.exportPath, "workspace"))).toBe(false);
        expect(existsSync(join(result.exportPath, "carry"))).toBe(false);
        expect(result.warnings.join(" ")).toMatch(
          /No project files or uncommitted work were included in this export/
        );
      } finally {
        process.env.PATH = realPath;
      }
    });

    it("does not snapshot its own staging directory on a project-scope export", async () => {
      // A project-scope export writes into `<project>/.sesh-mover/<name>/`,
      // which is INSIDE the tree being snapshotted. `.sesh-mover` is
      // `PROJECT_DIR_NAME`, so it is both a built-in convenience exclude and on
      // the NEVER_INCLUDABLE floor — but push stages into a temp dir, so no
      // existing test covers this self-nesting shape at all.
      //
      // MEASURED, so the claim is about the right rule: removing
      // `PROJECT_DIR_NAME` from `DEFAULT_WORKSPACE_EXCLUDES` leaves this green,
      // and removing it from `PLUGIN_STATE_NAMES` (which feeds the floor) turns
      // it red. The FLOOR is what holds here, which is what
      // `src/payload/workspace.ts` says load-bearing means — the convenience
      // excludes are documented as not a security boundary, and this is that
      // documentation being true.
      const project = realProject("self-nest", { "src/app.ts": "x\n" });
      const { exportSession } = await import("../src/exporter.js");
      const result = await exportSession({
        configDir,
        projectPath: project,
        sessionId,
        outputDir: join(project, ".sesh-mover"),
        name: "inside",
        excludeLayers: [],
        claudeVersion: "2.1.81",
        includeWorkspace: true,
      });
      if (!result.success) throw new Error("export failed");
      const carried = listFiles(join(result.exportPath, "workspace"));
      expect(carried).toContain("src/app.ts");
      expect(carried.some((p) => p.includes(".sesh-mover"))).toBe(false);
    });

    it("keeps trackedIgnored apart from reIncluded on the export path too", async () => {
      // The tracked-vs-untracked asymmetry, re-run through export. `.gitignore`
      // filters the UNTRACKED enumeration; `git diff HEAD` describes every
      // TRACKED file that changed and no carry rule filters the patch. That is
      // tolerable on a hub you own and is the whole risk in an artifact you hand
      // to someone, so the two disclosures must not merge.
      const project = linkSessions(gitProject("tracked-ignored"));
      writeFileSync(join(project, ".env"), "TOKEN=old\n");
      git(project, ["add", "-A"]);
      git(project, ["commit", "-q", "-m", "add env"]);
      writeFileSync(join(project, ".gitignore"), ".env\n");
      git(project, ["add", ".gitignore"]);
      git(project, ["commit", "-q", "-m", "ignore it"]);
      writeFileSync(join(project, ".env"), "TOKEN=new-secret\n");

      const { exportSession } = await import("../src/exporter.js");
      const result = await exportSession({
        configDir, projectPath: project, sessionId,
        outputDir: join(tempDir, "exports"), name: "tracked-ignored",
        excludeLayers: [], claudeVersion: "2.1.81", includeCarry: true,
      });
      if (!result.success) throw new Error("export failed");

      expect(result.carry?.trackedIgnoredCount).toBe(1);
      expect(result.carry?.trackedIgnored).toEqual([".env"]);
      // NOT folded in: the include list did not put this in the bundle and
      // removing an include-list line will not take it out.
      expect(result.carry?.reIncludedCount).toBe(0);
      // And the secret really is in the patch — otherwise the disclosure above
      // would be passing for a reason unrelated to what it claims to warn about.
      const patch = readFileSync(join(result.exportPath, "carry", "changes.patch"), "utf-8");
      expect(patch).toContain("TOKEN=new-secret");
      expect(result.warnings.join(" ")).toMatch(/git TRACKS/);
      expect(result.warnings.join(" ")).toMatch(/git rm --cached/);
      rmSync(project, { recursive: true, force: true });
    });

    it("measures a payload without writing one, for the pre-write disclosure", async () => {
      const project = gitProject("measure");
      writeFileSync(join(project, "tracked.txt"), "v2\n");
      writeFileSync(join(project, "new.txt"), "untracked\n");
      const before = listFiles(project).filter((p) => !p.startsWith(".git/"));

      const { planExportPayload } = await import("../src/exporter.js");
      const plan = await planExportPayload({ projectPath: project, includeCarry: true });

      expect(plan.payloadPlan).toBe(true);
      expect(plan.decision).toBe("carry");
      expect(plan.carry?.untrackedCount).toBe(1);
      expect(plan.carry?.patchBytes).toBeGreaterThan(0);
      // NOTHING was written — not into the project, not anywhere. That is the
      // entire reason the measure exists rather than "capture and offer to
      // abort": the alternative writes the secrets to local disk before the user
      // has consented to anything.
      expect(listFiles(project).filter((p) => !p.startsWith(".git/"))).toEqual(before);
      expect(existsSync(join(project, "carry"))).toBe(false);
      // Tense: a measure has not carried anything yet, and this is the sentence
      // the user reads AT the confirm gate.
      expect(plan.warnings.join(" ")).not.toMatch(/are in this export bundle now/);
      rmSync(project, { recursive: true, force: true });
    });

    it("measures the workspace snapshot with the same numbers the real capture lands", async () => {
      const project = realProject("measure-ws", {
        "a.txt": "aaa\n", "b/c.txt": "cc\n", "b/d.txt": "d\n",
      });
      const { planExportPayload } = await import("../src/exporter.js");
      const plan = await planExportPayload({ projectPath: project, includeWorkspace: true });
      expect(plan.decision).toBe("workspace");
      expect(existsSync(join(project, "workspace"))).toBe(false);

      const real = await exportFrom(project, { includeWorkspace: true, name: "measure-ws-real" });
      const manifest = JSON.parse(readFileSync(join(real.exportPath, "manifest.json"), "utf-8"));
      // The preview and the run come off one decision, so their counts agree.
      // (Bytes too: nothing between the two passes touches the tree.)
      expect(plan.workspace?.fileCount).toBe(manifest.workspace.fileCount);
      expect(plan.workspace?.byteSize).toBe(manifest.workspace.byteSize);
    });

    it("still verifies its own sessionsDigest with the payload fields set", async () => {
      // CHARACTERIZATION, not a guard, and labelled so after measuring it:
      // rewriting the exporter to patch both fields in AFTER `writeManifest`
      // (push's shape) leaves this test GREEN. That is correct rather than a
      // gap — `sessionsDigest` covers the session list and nothing else, which
      // is exactly why `hub/push.ts` may patch `workspace`/`carry`/`projectId`
      // into a staged manifest at all.
      //
      // So what this pins is the property that matters to a BUNDLE: adding the
      // payload fields invalidates no digest, on either transport. It does NOT
      // pin where export sets them, and nothing can — the difference is a
      // readability choice (export has no ordering problem, so it needs no
      // patch), not a behavioural one.
      const project = realProject("digest", { "a.txt": "a\n" });
      const result = await exportFrom(project, { includeWorkspace: true, name: "digest-export" });
      const { readManifest, verifySessionsDigest } = await import("../src/manifest.js");
      const manifest = readManifest(result.exportPath);
      expect(manifest.workspace).toBeDefined();
      expect(verifySessionsDigest(manifest)).toBeNull();
    });
  });

  // =========================================================================
  // APPLY
  // =========================================================================

  describe("apply: what an import writes into the project", () => {
    it("round-trips a workspace payload from export through import", async () => {
      const source = realProject("rt-src", {
        "src/app.ts": "export const a = 1;\n",
        "docs/deep/note.md": "deep\n",
      });
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "rt" });

      const target = join(tempDir, "rt-target");
      mkdirSync(target, { recursive: true });
      const result = await importInto(bundle.exportPath, target, { applyWorkspace: true });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.workspaceUnpacked?.path).toBe(target);
      expect(listFiles(target)).toEqual(["README.md", "docs/deep/note.md", "src/app.ts"]);
      expect(readFileSync(join(target, "src", "app.ts"), "utf-8")).toBe("export const a = 1;\n");
      // The sessions landed too — the payload is the optional half.
      expect(result.importedSessions).toHaveLength(1);
    });

    it("writes no project file when the bundle carries a workspace payload and no flag asked for it", async () => {
      // "The bundle carried one, so it was applied" is precisely the reading
      // #36's ruling forbids: a payload's presence is not a request to write it.
      const source = realProject("optin-src", { "src/app.ts": "x\n" });
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "optin" });

      const target = join(tempDir, "optin-target");
      mkdirSync(target, { recursive: true });
      const result = await importInto(bundle.exportPath, target);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(listFiles(target)).toEqual([]);
      expect(result.workspaceUnpacked).toBeUndefined();
      // Declined, and DISCLOSED — silence about a payload we chose not to write
      // is what makes an opt-in feel like a bug.
      expect(result.workspaceSkipped).toBe(2);
      expect(result.warnings.join(" ")).toMatch(/--apply-workspace` was not passed/);
      // And the write set counts NONE of them, rather than listing paths
      // nothing writes. (The bundle's `memory/` still lands — that layer is
      // opt-OUT — so the total is the memory layer's alone.)
      expect(result.writeSet!.entries.filter((e) => e.layer === "workspace")).toEqual([]);
      expect(result.writeSet!.entries.every((e) => e.layer === "memory")).toBe(true);
      expect(result.writeSet!.total).toBe(result.writeSet!.entries.length);
      expect(
        result.writeSet!.roots.find((r) => r.layer === "workspace")
      ).toEqual({ layer: "workspace", path: target, scope: "project", applied: false, enumerated: true });
    });

    it("refuses a non-empty target and merges nothing", async () => {
      const source = realProject("refuse-src", { "src/app.ts": "theirs\n" });
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "refuse" });

      const target = join(tempDir, "refuse-target");
      mkdirSync(join(target, "src"), { recursive: true });
      writeFileSync(join(target, "src", "app.ts"), "mine\n");
      writeFileSync(join(target, "only-mine.txt"), "keep\n");

      const result = await importInto(bundle.exportPath, target, { applyWorkspace: true });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/exists and is not empty/);
      // REFUSED, not merged: both local files are byte-identical afterwards and
      // nothing of theirs arrived. Export -> import is bootstrap; a user who
      // wants two trees combined wants the hub.
      expect(readFileSync(join(target, "src", "app.ts"), "utf-8")).toBe("mine\n");
      expect(listFiles(target)).toEqual(["only-mine.txt", "src/app.ts"]);
      expect(result.suggestion).toMatch(/--force-workspace/);
      // `--force-workspace` may never be DESCRIBED as a merge: it means unpack
      // OVER what is there, and calling it a merge is how a user consents to an
      // overwrite believing their files will be combined. The refusal is allowed
      // to say what it is NOT — and does — so the check is on the flag's own
      // sentence, not on the word.
      const suggestion = result.suggestion ?? "";
      expect(suggestion).toMatch(/OVERWRITING any file of the same name/);
      expect(suggestion).toMatch(/does not combine the two/);
      expect(/--force-workspace[^.]*merge/i.test(suggestion)).toBe(false);
    });

    it("treats a target holding only plugin state as empty", async () => {
      // An import plants `.sesh-mover-project.json` into the project root when
      // the bundle carries an id, so a raw `readdirSync().length > 0` would make
      // the SECOND import of the same bundle refuse a directory the FIRST one
      // created the contents of.
      const source = realProject("state-src", { "src/app.ts": "x\n" });
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "state" });

      const target = join(tempDir, "state-target");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, ".sesh-mover-project.json"), "{}\n");
      mkdirSync(join(target, ".sesh-mover"), { recursive: true });

      const result = await importInto(bundle.exportPath, target, { applyWorkspace: true });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(existsSync(join(target, "src", "app.ts"))).toBe(true);
    });

    it("refuses a payload path naming plugin or VCS internals, in every folded spelling", async () => {
      // The apply-side floor. A CURRENT sesh-mover never writes such a bundle,
      // so this one is hand-planted into a real bundle's workspace directory —
      // which is exactly the shape a hand-made or damaged bundle has.
      const source = realProject("floor-src", { "keep.txt": "kept\n" });
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "floor" });
      const ws = join(bundle.exportPath, "workspace");
      writeTree(ws, {
        ".git/config": "[remote]\n",
        ".GIT/hooks/pre-commit": "#!/bin/sh\n",
        ".sesh-mover-include/x": "*\n",
        "nested/.sesh-mover-ignore": "*\n",
      });

      const target = join(tempDir, "floor-target");
      mkdirSync(target, { recursive: true });
      const result = await importInto(bundle.exportPath, target, { applyWorkspace: true });
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(listFiles(target)).toEqual(["README.md", "keep.txt"]);
      // `.GIT` is asserted only when the filesystem could actually HOLD it as a
      // second entry. On a case-insensitive one — macOS and Windows by default —
      // `.git/config` and `.GIT/hooks/pre-commit` are the same directory, so the
      // bundle physically cannot carry both spellings and the refusal list is
      // one shorter. That is the payload being unable to express the attack, not
      // the floor failing to catch it, and asserting a fixed list turned a
      // filesystem property into a red build on two platforms.
      //
      // The case-folding rule itself still has teeth here: the surviving
      // spelling is refused whichever one it is, and `tests/hub-workspace.test.ts`
      // covers the folded predicates directly, where no real directory is created.
      // READDIR, not existsSync: on a case-insensitive filesystem
      // `existsSync(".GIT/...")` RESOLVES to the `.git` directory and returns
      // true, so an existence probe cannot detect the very condition it is for.
      // Two distinct directory entries is the only honest question.
      const spellings = readdirSync(ws);
      const bothSpellings = spellings.includes(".git") && spellings.includes(".GIT");
      expect(result.workspaceRefused).toEqual(
        expect.arrayContaining([
          ...(bothSpellings ? [".git", ".GIT"] : [spellings.includes(".git") ? ".git" : ".GIT"]),
          ".sesh-mover-include",
          "nested/.sesh-mover-ignore",
        ])
      );
      // The refused paths are not in the write set either — a gate that listed a
      // path the run then refused would be describing a different run.
      const listed = result.writeSet!.entries.map((e) => e.path);
      expect(listed.some((p) => p.includes(".sesh-mover-include"))).toBe(false);
    });

    it("applies a carry into a clean twin, and refuses the guards it refused on the hub", async () => {
      const source = linkSessions(gitProject("apply-carry"));
      // A second TRACKED file, committed before the carry is captured, so it is
      // at the same HEAD on both sides and the patch does not name it. It is
      // what makes the dirty-tree case below the one the gate is actually for.
      writeFileSync(join(source, "other.txt"), "untouched by the patch\n");
      git(source, ["add", "-A"]);
      git(source, ["commit", "-q", "-m", "second file"]);
      writeFileSync(join(source, "tracked.txt"), "v2\n");
      writeFileSync(join(source, "new.txt"), "brought along\n");

      const { exportSession } = await import("../src/exporter.js");
      const exported = await exportSession({
        configDir, projectPath: source, sessionId,
        outputDir: join(tempDir, "exports"), name: "carry-apply",
        excludeLayers: [], claudeVersion: "2.1.81", includeCarry: true,
      });
      if (!exported.success) throw new Error("export failed");

      // --- dirty tree: refused, and the tree is untouched.
      //
      // The dirt is in `other.txt`, which the patch does NOT name — and that
      // choice is the whole value of this case. Dirtying `tracked.txt` (the file
      // the patch changes) makes `git apply` refuse on its own, so removing the
      // dirty-tree gate would only degrade the reason code from `dirty-tree` to
      // `apply-failed` and the test would still pass its `applied: false`
      // assertion for a reason that has nothing to do with the guard. With dirt
      // ELSEWHERE the patch applies cleanly, which is exactly the irreversible
      // mixing the gate exists to prevent: the user's own uncommitted work and
      // a peer's would then share one `git checkout -- .`.
      const dirty = cleanTwin(source, "dirty");
      writeFileSync(join(dirty, "other.txt"), "unrelated local work\n");
      const dirtyResult = await importInto(exported.exportPath, dirty, { applyCarry: true });
      expect(dirtyResult.success).toBe(true);
      if (!dirtyResult.success) return;
      expect(dirtyResult.carryApplied?.applied).toBe(false);
      expect(dirtyResult.carryApplied && !dirtyResult.carryApplied.applied
        ? dirtyResult.carryApplied.reason : null).toBe("dirty-tree");
      // Nothing of theirs arrived, and nothing of the user's own work moved.
      expect(readTextLf(join(dirty, "other.txt"))).toBe("unrelated local work\n");
      expect(readTextLf(join(dirty, "tracked.txt"))).toBe("v1\n");
      expect(existsSync(join(dirty, "new.txt"))).toBe(false);

      // --- wrong base: refused too
      const moved = cleanTwin(source, "moved");
      writeFileSync(join(moved, "other.txt"), "later commit\n");
      git(moved, ["add", "-A"]);
      git(moved, ["commit", "-q", "-m", "move HEAD"]);
      const movedResult = await importInto(exported.exportPath, moved, { applyCarry: true });
      expect(movedResult.success).toBe(true);
      if (!movedResult.success) return;
      expect(movedResult.carryApplied && !movedResult.carryApplied.applied
        ? movedResult.carryApplied.reason : null).toBe("wrong-base");
      expect(existsSync(join(moved, "new.txt"))).toBe(false);

      // --- clean twin at the right commit: applied
      const twin = cleanTwin(source, "clean");
      const ok = await importInto(exported.exportPath, twin, { applyCarry: true });
      expect(ok.success).toBe(true);
      if (!ok.success) return;
      expect(ok.carryApplied?.applied).toBe(true);
      // THE TWO LINES BELOW DELIBERATELY DIFFER, and folding them together
      // would delete a real guard. `tracked.txt` is materialised by `git apply`,
      // so under Windows' `core.autocrlf` it legitimately comes back CRLF and is
      // read through `readTextLf`. `new.txt` is UNTRACKED: it travels through
      // the carry code's own byte copy, never through git's filters, so it must
      // stay byte-exact — that assertion is what would catch a text-mode
      // transform sneaking into the copy path. See `tests/helpers/eol.ts`.
      expect(readTextLf(join(twin, "tracked.txt"))).toBe("v2\n");
      expect(readFileSync(join(twin, "new.txt"), "utf-8")).toBe("brought along\n");

      rmSync(source, { recursive: true, force: true });
      rmSync(dirty, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
      rmSync(twin, { recursive: true, force: true });
    });

    it("writes nothing at all — not even a saved copy — when --apply-carry is absent", async () => {
      // The deliberate divergence from `hub pull`. A pull's decline SAVES the
      // payload beside the project, because by then the bundle is recorded as
      // received and its extraction directory is about to be deleted: there is
      // no second chance. An import's bundle is a file the user still has, so
      // writing a payload they declined into their own project is exactly what
      // the opt-in exists to prevent.
      const source = linkSessions(gitProject("no-flag"));
      writeFileSync(join(source, "tracked.txt"), "v2\n");
      const { exportSession } = await import("../src/exporter.js");
      const exported = await exportSession({
        configDir, projectPath: source, sessionId,
        outputDir: join(tempDir, "exports"), name: "no-flag",
        excludeLayers: [], claudeVersion: "2.1.81", includeCarry: true,
      });
      if (!exported.success) throw new Error("export failed");

      const twin = cleanTwin(source, "no-flag-twin");
      const before = listFiles(twin).filter((p) => !p.startsWith(".git/"));
      const result = await importInto(exported.exportPath, twin);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(listFiles(twin).filter((p) => !p.startsWith(".git/"))).toEqual(before);
      expect(existsSync(join(twin, ".sesh-mover"))).toBe(false);
      expect(result.carryApplied).toBeUndefined();
      // Still DISCLOSED — the sender's claim, read from the manifest.
      expect(result.carryAvailable?.baseCommit).toBe(exported.carry!.baseCommit);
      expect(result.warnings.join(" ")).toMatch(/--apply-carry` was not passed/);

      rmSync(source, { recursive: true, force: true });
      rmSync(twin, { recursive: true, force: true });
    });

    it("reports a declared workspace payload the bundle does not contain, without crashing", async () => {
      const source = realProject("missing-src", { "a.txt": "a\n" });
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "missing" });
      rmSync(join(bundle.exportPath, "workspace"), { recursive: true, force: true });

      const target = join(tempDir, "missing-target");
      mkdirSync(target, { recursive: true });
      const result = await importInto(bundle.exportPath, target, { applyWorkspace: true });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.workspaceDeclaredMissing).toBe(true);
      // The sessions are the primary artifact and are not made wrong by it.
      expect(result.importedSessions).toHaveLength(1);
    });

    it("discloses that the two rule files could not travel with the payload", async () => {
      // A CONSEQUENCE OF THE FLOOR, and one the whole point of the operation
      // makes acute: the destination is supposed to BE this project now, and it
      // has neither `.sesh-mover-include` nor `.sesh-mover-ignore`, so its next
      // push or export carries a different set than the source did. The floor
      // stays — a planted include list is an exfiltration primitive one push
      // later, empty target or not — so the cost is disclosed rather than fixed.
      const source = realProject("rules-src", { "a.txt": "a\n" });
      writeFileSync(join(source, ".sesh-mover-ignore"), "secrets\n");
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "rules" });
      // The premise: the payload really does not contain them.
      expect(listFiles(join(bundle.exportPath, "workspace"))).not.toContain(".sesh-mover-ignore");

      const target = join(tempDir, "rules-target");
      mkdirSync(target, { recursive: true });
      const result = await importInto(bundle.exportPath, target, { applyWorkspace: true });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(existsSync(join(target, ".sesh-mover-ignore"))).toBe(false);
      expect(result.warnings.join(" ")).toMatch(
        /could not carry .sesh-mover-include or .sesh-mover-ignore/
      );

      // And it says nothing when the destination already has them — a git clone
      // does, because they are meant to be committed.
      const withRules = join(tempDir, "rules-target-2");
      mkdirSync(withRules, { recursive: true });
      writeFileSync(join(withRules, ".sesh-mover-include"), "docs/\n");
      writeFileSync(join(withRules, ".sesh-mover-ignore"), "secrets\n");
      const quiet = await importInto(bundle.exportPath, withRules, { applyWorkspace: true });
      expect(quiet.success).toBe(true);
      if (!quiet.success) return;
      expect(quiet.warnings.join(" ")).not.toMatch(/could not carry/);
    });

    it("records no workspace generation, so a later hub pull merges in no-ancestor mode", async () => {
      // A generation is identified by a HUB BUNDLE ID and is the one input
      // `chooseMergeAncestor` treats as proof that a generation was common to
      // both trees. An import mints no such id, so it must record none — a "for
      // symmetry" `setLastWorkspace` here would put a lie in that set.
      const source = realProject("gen-src", { "a.txt": "a\n" });
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "gen" });
      const target = join(tempDir, "gen-target");
      mkdirSync(target, { recursive: true });
      await importInto(bundle.exportPath, target, { applyWorkspace: true });

      const { readSyncState, knownWorkspaceGenerations } = await import("../src/sync-state.js");
      const state = readSyncState(target);
      expect(state.hub?.lastWorkspace).toBeUndefined();
      expect(knownWorkspaceGenerations(state)).toEqual([]);
    });
  });

  // =========================================================================
  // THE WRITE SET
  // =========================================================================

  describe("the consent gate's write set covers the file payload", () => {
    it("is exactly the project files a real import created, and nothing else", async () => {
      // COMPLETENESS, checked against the filesystem rather than asserted —
      // the same trade `tests/importer.test.ts`'s config-dir diff makes, extended
      // to the target PROJECT directory, which is where a workspace payload
      // lands and where the config-dir snapshot cannot see it.
      const source = realProject("ws-set-src", {
        "src/app.ts": "a\n", "src/lib/deep.ts": "b\n", "top.md": "c\n",
      });
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "ws-set" });

      const target = join(tempDir, "ws-set-target");
      mkdirSync(target, { recursive: true });
      const before = new Set(listFiles(target));
      const result = await importInto(bundle.exportPath, target, { applyWorkspace: true });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const created = listFiles(target)
        .filter((p) => !before.has(p))
        .map((p) => join(target, ...p.split("/")))
        .sort();
      const promised = result.writeSet!.entries
        .filter((e) => e.layer === "workspace")
        .map((e) => e.path)
        .sort();

      expect(created.length).toBeGreaterThan(0);
      expect(promised).toEqual(created);
      expect(result.writeSet!.total).toBe(result.writeSet!.entries.length);
      // Every entry carries the escaped form, and the rule is per entry rather
      // than per suspicious entry — otherwise a renderer learns to use `path`.
      for (const e of result.writeSet!.entries) {
        expect(e.display).toBe(JSON.stringify(e.path));
      }
    });

    it("predicts exactly the set the real run writes", async () => {
      const source = realProject("plan-src", { "src/app.ts": "a\n", "b.md": "b\n" });
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "plan-set" });

      const { importSession } = await import("../src/importer.js");
      const targetConfigDir = mkdtempSync(join(tempDir, "plan-cfg-"));
      mkdirSync(join(targetConfigDir, "projects"), { recursive: true });
      const target = join(tempDir, "plan-target");
      mkdirSync(target, { recursive: true });
      const args = {
        exportPath: bundle.exportPath,
        targetConfigDir,
        targetProjectPath: target,
        targetClaudeVersion: "2.1.81",
        filePayload: { applyWorkspace: true, applyCarry: false, forceWorkspace: false },
      };

      const preview = await importSession({ ...args, dryRun: true });
      expect(preview.success).toBe(true);
      if (!preview.success || !("writeSet" in preview)) return;
      // A preview writes NOTHING.
      expect(listFiles(target)).toEqual([]);

      const real = await importSession({ ...args, dryRun: false });
      expect(real.success).toBe(true);
      if (!real.success || !("writeSet" in real)) return;
      expect(preview.writeSet).toEqual(real.writeSet);
      expect(preview.writeSet!.total).toBeGreaterThan(0);
    });

    it("keeps total honest when the enumeration is capped", async () => {
      // The bound the type has documented since #36: `entries` may be shorter
      // than `total`, and a presenter's "and N more" has to come from `total`.
      // 250 files is over the 200-entry cap by enough to be unambiguous.
      const files: Record<string, string> = {};
      for (let i = 0; i < 250; i++) files[`gen/f${i}.txt`] = `${i}\n`;
      const source = realProject("cap-src", files);
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "cap" });

      const target = join(tempDir, "cap-target");
      mkdirSync(target, { recursive: true });
      const result = await importInto(bundle.exportPath, target, { applyWorkspace: true });
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Every path under `gen/` landed, and `total` counts every one of them —
      // while `entries` stops at the cap. That gap is the whole point: a
      // presenter's "and N more" has to come from `total`, and computing it from
      // `entries.length` would under-report by 50 here.
      const landed = listFiles(target);
      expect(landed.filter((p) => p.startsWith("gen/")).length).toBe(250);
      // The cap is on the WORKSPACE enumeration alone: `memory` and `plans`
      // entries are never truncated, because they are few and one of their kinds
      // edits a file the user already had.
      expect(result.writeSet!.entries.filter((e) => e.layer === "workspace").length).toBe(200);
      expect(result.writeSet!.total).toBeGreaterThan(result.writeSet!.entries.length);
      // `total` is the count of paths WRITTEN, across every layer, so it equals
      // what actually appeared minus what was already there.
      const workspaceWrites = landed.filter((p) => p !== ".sesh-mover-project.json").length;
      expect(result.writeSet!.total).toBe(
        workspaceWrites + result.writeSet!.entries.filter((e) => e.layer === "memory").length
      );
      // Truncated, never invented: every entry shown is a path that was written.
      const real = new Set(landed.map((p) => join(target, ...p.split("/"))));
      for (const e of result.writeSet!.entries.filter((x) => x.layer === "workspace")) {
        expect(real.has(e.path)).toBe(true);
      }
    });

    it("marks an overwriting workspace file as `overwrite`, not `create`", async () => {
      // The one kind whose local copy does not survive anywhere. Only reachable
      // with --force-workspace, which is exactly when a gate most needs to say
      // it — `park` keeps the user's file, this replaces it.
      const source = realProject("ow-src", { "shared.txt": "theirs\n", "new.txt": "new\n" });
      const bundle = await exportFrom(source, { includeWorkspace: true, name: "ow" });

      const target = join(tempDir, "ow-target");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "shared.txt"), "mine\n");

      const result = await importInto(bundle.exportPath, target, {
        applyWorkspace: true, forceWorkspace: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const byName = new Map(
        result.writeSet!.entries.map((e) => [e.path.split(/[\\/]/).pop(), e.kind])
      );
      expect(byName.get("shared.txt")).toBe("overwrite");
      expect(byName.get("new.txt")).toBe("create");
      expect(readFileSync(join(target, "shared.txt"), "utf-8")).toBe("theirs\n");
    });

    it("discloses the carry as a root whose paths it does not enumerate", async () => {
      const source = linkSessions(gitProject("carry-root"));
      writeFileSync(join(source, "tracked.txt"), "v2\n");
      const { exportSession } = await import("../src/exporter.js");
      const exported = await exportSession({
        configDir, projectPath: source, sessionId,
        outputDir: join(tempDir, "exports"), name: "carry-root",
        excludeLayers: [], claudeVersion: "2.1.81", includeCarry: true,
      });
      if (!exported.success) throw new Error("export failed");

      const twin = cleanTwin(source, "carry-root-twin");
      const result = await importInto(exported.exportPath, twin, { applyCarry: true });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const root = result.writeSet!.roots.find((r) => r.layer === "carry");
      expect(root).toEqual({
        layer: "carry", path: twin, scope: "project", applied: true, enumerated: false,
      });
      // Not in `entries`, and — the half a gate must relay rather than round off
      // — not in `total` either.
      expect(result.writeSet!.entries.filter((e) => e.layer === "carry")).toEqual([]);
      expect(result.writeSet!.total).toBe(result.writeSet!.entries.length);
      // The other roots are enumerated, so `enumerated` really discriminates.
      for (const r of result.writeSet!.roots.filter((x) => x.layer !== "carry")) {
        expect(r.enumerated).toBe(true);
      }

      rmSync(source, { recursive: true, force: true });
      rmSync(twin, { recursive: true, force: true });
    });
  });
});
