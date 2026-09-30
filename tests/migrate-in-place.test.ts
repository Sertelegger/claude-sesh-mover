import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  realpathSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { encodeProjectPath, legacyEncodeProjectPath } from "../src/platform.js";
import { homeEnv } from "./helpers/env.js";
import { runCli, type RunCliResult } from "./helpers/run-cli.js";

/**
 * A migrate whose target files its sessions in a folder the source's sessions
 * were FOUND in leaves the sessions found there where they are, and moves only
 * the rest (#126's remedy, reopened by #149's review).
 *
 * Discovery reads two folders for one project path — `encodeProjectPath(R)`,
 * where Claude Code files R's sessions, and `legacyEncodeProjectPath(R)`, where
 * a pre-0.12.0 import misfiled them for any path with a `.`, a `_` or a space —
 * while the import writes only the first. So `migrate R -> R` is exactly how
 * the stranded ones are put back, which is what 0.12.0's CHANGELOG promised; a
 * blanket "onto itself" refusal blocked it. What the refusal protected is kept:
 * a session already in the write folder is never re-imported there under a new
 * id (the old id would stop resuming, and the hub would lose which thread it
 * belongs to), and when nothing else is left the migrate is refused.
 *
 * CLI-LEVEL, all of it: these spawn `dist/cli.js`, so a mutation to `src/` is
 * invisible until `npm run build` runs.
 */
const isWindows = platform() === "win32";
const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";
const FIXTURE_CWD = "/Users/testuser/Projects/testproject";
const NATIVE_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_ID = "22222222-2222-4222-8222-222222222222";

describe("migrate leaves sessions already in the folder it writes, and moves the rest", () => {
  let tempDir: string;
  let configDir: string;
  let fixtureId: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "sesh-migrate-in-place-")));
    const fixture = createFixtureTree(join(tempDir, "fixture"));
    configDir = fixture.configDir;
    fixtureId = fixture.sessionId;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runMigrate(
    source: string,
    target: string,
    extra: string[] = [],
    opts: { env?: Record<string, string>; targetConfigDir?: string } = {}
  ): RunCliResult {
    const env = opts.env ?? {};
    return runCli(
      [
        "migrate", "--source-project-path", source, "--target-project-path", target,
        "--source-config-dir", configDir, "--target-config-dir", opts.targetConfigDir ?? configDir,
        "--scope", "all",
        ...extra,
      ],
      {
        env: { ...homeEnv(join(tempDir, "home")), CLAUDE_CONFIG_DIR: join(tempDir, "unused-claude"), ...env },
        cwd: tempDir,
      }
    );
  }

  /** A real project directory, so every spelling below is its physical one. */
  const project = (name: string): string => {
    const dir = join(tempDir, name);
    mkdirSync(dir);
    return dir;
  };

  /**
   * Files a copy of the fixture session under `encoded`, as `id`, recording
   * `cwd` — with its subagents/tool-results directory and its file-history,
   * which is keyed by id alone and so is shared by every copy of one id.
   */
  const plant = (encoded: string, id: string, cwd: string): string => {
    const from = join(configDir, "projects", FIXTURE_ENCODED);
    const folder = join(configDir, "projects", encoded);
    mkdirSync(folder, { recursive: true });
    const text = readFileSync(join(from, `${fixtureId}.jsonl`), "utf-8")
      .replaceAll(fixtureId, id)
      // JSON-escaped, so a Windows path's backslashes stay valid JSON.
      .replaceAll(FIXTURE_CWD, JSON.stringify(cwd).slice(1, -1));
    writeFileSync(join(folder, `${id}.jsonl`), text);
    cpSync(join(from, fixtureId), join(folder, id), { recursive: true });
    const history = join(configDir, "file-history", id);
    if (!existsSync(history)) {
      cpSync(join(configDir, "file-history", fixtureId), history, { recursive: true });
    }
    return folder;
  };

  /** Every file under `dir`, relative path → content: "keeps its files", exactly. */
  const snapshot = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[relative(dir, p).split(sep).join("/")] = readFileSync(p, "utf-8");
      }
    };
    walk(dir);
    return out;
  };

  const cwdOf = (folder: string, id: string): string =>
    JSON.parse(readFileSync(join(folder, `${id}.jsonl`), "utf-8").split("\n")[0]).cwd;

  it("moves a project's sessions out of the pre-0.12.0 folder when it is migrated onto its own path (#126)", () => {
    // A path where the two encoders disagree — the whole class #126 is about.
    const R = project("my.proj");
    expect(legacyEncodeProjectPath(R)).not.toBe(encodeProjectPath(R));
    const legacy = plant(legacyEncodeProjectPath(R), LEGACY_ID, R);
    const native = join(configDir, "projects", encodeProjectPath(R));

    const r = runMigrate(R, R);
    expect(r.status, r.stdout).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(true);
    expect(result.importedSessions.map((s: { originalId: string }) => s.originalId)).toEqual([LEGACY_ID]);
    const newId = result.importedSessions[0].newId as string;
    // Where Claude Code reads R's sessions, recording R.
    expect(cwdOf(native, newId)).toBe(R);
    expect(existsSync(join(native, newId, "subagents"))).toBe(true);
    expect(existsSync(join(configDir, "file-history", newId))).toBe(true);
    // And gone from where it was FOUND — the legacy folder, not R's own, which
    // is the only folder the cleanup used to look in: the moved session was
    // left behind as a duplicate there.
    expect(readdirSync(legacy)).toEqual([]);
    expect(existsSync(join(configDir, "file-history", LEGACY_ID))).toBe(false);
  });

  it("with sessions in both folders, moves only the legacy ones; the native ones keep their ids and files", () => {
    const R = project("both.proj");
    const native = plant(encodeProjectPath(R), NATIVE_ID, R);
    const legacy = plant(legacyEncodeProjectPath(R), LEGACY_ID, R);
    const nativeBefore = snapshot(native);
    const historyBefore = snapshot(join(configDir, "file-history", NATIVE_ID));

    // The preview says what the run will do, the in-place note included.
    const preview = runMigrate(R, R, ["--dry-run"]);
    expect(preview.status, preview.stdout).toBe(0);
    const planned = JSON.parse(preview.stdout);
    expect(planned.importedSessions.map((s: { originalId: string }) => s.originalId)).toEqual([LEGACY_ID]);
    expect(planned.warnings.some((w: string) => w.includes(NATIVE_ID) && w.includes("left where"))).toBe(true);
    expect(snapshot(native)).toEqual(nativeBefore);

    const r = runMigrate(R, R);
    expect(r.status, r.stdout).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.importedSessions.map((s: { originalId: string }) => s.originalId)).toEqual([LEGACY_ID]);
    expect(result.skippedSessions).toEqual([]);
    const note = (result.warnings as string[]).find((w) => w.includes(NATIVE_ID));
    expect(note).toBeDefined();
    expect(note).toContain("left where");
    const newId = result.importedSessions[0].newId as string;

    // The native session: same id, same bytes, same session directory, same
    // file-history — nothing re-minted in place.
    const nativeAfter = snapshot(native);
    for (const [rel, text] of Object.entries(nativeBefore)) expect(nativeAfter[rel], rel).toBe(text);
    expect(snapshot(join(configDir, "file-history", NATIVE_ID))).toEqual(historyBefore);
    // Beside it, the one moved session and nothing else new.
    expect(Object.keys(nativeAfter).filter((rel) => !(rel in nativeBefore)).every((rel) => rel.startsWith(newId))).toBe(true);
    expect(cwdOf(native, newId)).toBe(R);
    expect(readdirSync(legacy)).toEqual([]);
  });

  /**
   * The provenBy for the refusal's suggestion: it applied nothing, so the same
   * invocation with a different --target-project-path has the whole
   * migration left to perform.
   */
  it("refuses when every session is already in the folder it would write, and a different --target-project-path then migrates", () => {
    const R = project("native.proj");
    const native = plant(encodeProjectPath(R), NATIVE_ID, R);
    const before = snapshot(native);
    const projectsBefore = readdirSync(join(configDir, "projects")).sort();

    // One config dir in two spellings is one folder: the CLI resolves
    // neither config dir, so the migrate compares them physically.
    const linkedConfig = join(tempDir, "config-link");
    if (!isWindows) symlinkSync(configDir, linkedConfig, "dir");
    const refusals = [
      runMigrate(R, R),
      runMigrate(R, R, ["--dry-run"]),
      runMigrate(R, R, [], { targetConfigDir: configDir + sep }),
      ...(isWindows ? [] : [runMigrate(R, R, [], { targetConfigDir: linkedConfig })]),
      runMigrate(R, R, ["--scope", "current", "--session-id", NATIVE_ID]),
    ];
    for (const r of refusals) {
      // A refusal: understood, declined, nothing done.
      expect(r.status, r.stdout).toBe(2);
      const refused = JSON.parse(r.stdout);
      expect(refused.success).toBe(false);
      expect(refused.error).toMatch(/^Nothing to move/);
      expect(refused.error).toContain(JSON.stringify(native));
      expect(refused.suggestion).toContain("--target-project-path");
    }
    expect(snapshot(native)).toEqual(before);
    expect(readdirSync(join(configDir, "projects")).sort()).toEqual(projectsBefore);

    const elsewhere = project("elsewhere");
    const moved = runMigrate(R, elsewhere);
    expect(moved.status, moved.stdout).toBe(0);
    const result = JSON.parse(moved.stdout);
    expect(result.importedSessions.map((s: { originalId: string }) => s.originalId)).toEqual([NATIVE_ID]);
    expect(existsSync(join(native, `${NATIVE_ID}.jsonl`))).toBe(false);
  });

  /**
   * A symlink whose OWN path encodes the same as its target's (`a.b` -> `a-b`)
   * names the folder Claude Code files the target under, so a migrate from the
   * link's spelling to the target reads that folder and writes it. Comparing
   * the directories let it through as a move, and every session Claude Code
   * had filed for the target was re-minted in place. Now those stay, and only
   * what is elsewhere — here, a pre-0.12.0 import through the link — moves.
   * POSIX-only: Windows follows no link when resolving a target.
   */
  it.skipIf(isWindows)("a link whose own path encodes like its target's re-mints nothing in the target's folder", () => {
    const real = project("a-b");
    const link = join(tempDir, "a.b");
    symlinkSync(real, link, "dir");
    expect(encodeProjectPath(link)).toBe(encodeProjectPath(real));
    const native = plant(encodeProjectPath(real), NATIVE_ID, real);
    const legacy = plant(legacyEncodeProjectPath(link), LEGACY_ID, link);
    const before = snapshot(native);

    const r = runMigrate(link, real);
    expect(r.status, r.stdout).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.importedSessions.map((s: { originalId: string }) => s.originalId)).toEqual([LEGACY_ID]);
    const after = snapshot(native);
    for (const [rel, text] of Object.entries(before)) expect(after[rel], rel).toBe(text);
    expect(cwdOf(native, result.importedSessions[0].newId)).toBe(real);
    expect(readdirSync(legacy)).toEqual([]);
  });

  /**
   * file-history is keyed by session id ALONE, so a legacy copy that shares an
   * id with a session left in place shares its file-history too — and deleting
   * it with the moved copy would take the in-place session's `/rewind`
   * backups with it. Only reachable through a hand copy (every import mints a
   * new id), which is what someone repairing #126 by hand would have made.
   */
  it("a moved legacy copy sharing an id with a session left in place does not take its file-history", () => {
    const R = project("dup.proj");
    const native = plant(encodeProjectPath(R), NATIVE_ID, R);
    const legacy = plant(legacyEncodeProjectPath(R), NATIVE_ID, R);
    const history = join(configDir, "file-history", NATIVE_ID);
    const historyBefore = snapshot(history);

    const r = runMigrate(R, R);
    expect(r.status, r.stdout).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.importedSessions.map((s: { originalId: string }) => s.originalId)).toEqual([NATIVE_ID]);
    expect(readdirSync(legacy)).toEqual([]);
    expect(existsSync(join(native, `${NATIVE_ID}.jsonl`))).toBe(true);
    expect(snapshot(history)).toEqual(historyBefore);
  });

  /**
   * On macOS and Windows two spellings that differ only in letter case are ONE
   * directory, so a target typed in another case writes into the folder the
   * source's sessions are in, and re-minted them there. Proved on Linux by
   * running the CLI with `process.platform` stubbed to "darwin" through a
   * `--require` preload (the comparison reads it at call time); on a real
   * macOS or Windows runner the stub is not used and the platform answers for
   * itself.
   */
  it("a target differing from the source only in letter case is the same folder on darwin and win32", () => {
    const R = project("CaseProj");
    const native = plant(encodeProjectPath(R), NATIVE_ID, R);
    const before = snapshot(native);
    const stub = join(tempDir, "platform-darwin.cjs");
    writeFileSync(stub, `Object.defineProperty(process, "platform", { value: "darwin" });\n`);
    const env: Record<string, string> =
      platform() === "linux"
        ? { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require "${stub}"`].filter(Boolean).join(" ") }
        : {};

    const r = runMigrate(R, join(tempDir, "caseproj"), [], { env });
    expect(r.status, r.stdout).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/^Nothing to move/);
    expect(snapshot(native)).toEqual(before);
  });

  /**
   * The other half, and only Linux can run it: a case-sensitive filesystem
   * holds both spellings as two directories, so the same migrate is a real
   * move. It is what shows the comparison above is a platform rule and not a
   * blanket case-fold.
   */
  it.runIf(platform() === "linux")("the same letter-case target is a real move on a case-sensitive platform", () => {
    const R = project("CaseProj");
    plant(encodeProjectPath(R), NATIVE_ID, R);
    const lower = join(tempDir, "caseproj");

    const r = runMigrate(R, lower);
    expect(r.status, r.stdout).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.importedSessions.map((s: { originalId: string }) => s.originalId)).toEqual([NATIVE_ID]);
    expect(cwdOf(join(configDir, "projects", encodeProjectPath(lower)), result.importedSessions[0].newId)).toBe(lower);
  });
});
