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
  symlinkSync,
  cpSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";
import { homeEnv } from "./helpers/env.js";
import { runCli, type RunCliResult } from "./helpers/run-cli.js";

const isWindows = platform() === "win32";

/**
 * #149 — a WRITE-destination project path is encoded, stamped into every
 * transcript's `cwd` and used as the sync-state key, and Claude Code keys a
 * project's folder on the PHYSICAL absolute directory: symlinks followed, never
 * a relative spelling. So `import`/`migrate`/`pull` given a symlinked or
 * relative target reported success into a folder `claude --continue` in that
 * directory never opens.
 *
 * CLI-LEVEL, because the resolution is at the CLI boundary — where every
 * caller-typed path enters — and nowhere below it: `importSession` and friends
 * take the path they are handed. These spawn `dist/cli.js`, so a mutation to
 * `src/` is invisible until `npm run build` runs.
 *
 * The symlink cases are POSIX-only, and not merely because creating a link on
 * Windows needs a privilege: Windows deliberately does not resolve links here
 * yet (see `physicalProjectPath`), so there is nothing on that platform for
 * them to assert. The relative-path case runs everywhere.
 */
const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";

describe("a write-destination project path is resolved to the physical directory (#149)", () => {
  let tempDir: string;
  let configDir: string;
  let sessionId: string;
  let bundle: string;
  let targetConfig: string;

  beforeEach(() => {
    // realpath'd once, so every expected value below is physical on macOS too,
    // where the temp root itself sits behind the /var -> /private/var link.
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "sesh-physical-target-")));
    const fixture = createFixtureTree(join(tempDir, "fixture"));
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
    const out = join(tempDir, "exports");
    mkdirSync(out, { recursive: true });
    const exported = cli([
      "export", "--scope", "current", "--session-id", sessionId,
      "--source-config-dir", configDir, "--project-path", "/Users/testuser/Projects/testproject",
      "--format", "dir", "--name", "b", "--output", out,
    ]);
    expect(exported.status, exported.stdout).toBe(0);
    bundle = join(out, "b");
    targetConfig = join(tempDir, "target-claude");
    mkdirSync(join(targetConfig, "projects"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function cli(args: string[], cwd?: string): RunCliResult {
    return runCli(args, {
      env: { ...homeEnv(join(tempDir, "home")), CLAUDE_CONFIG_DIR: join(tempDir, "unused-claude") },
      ...(cwd ? { cwd } : {}),
    });
  }

  const importTo = (target: string, cwd?: string): { warnings: string[] } => {
    const r = cli(
      ["import", "--from", bundle, "--target-project-path", target, "--target-config-dir", targetConfig],
      cwd
    );
    expect(r.status, r.stdout).toBe(0);
    return JSON.parse(r.stdout);
  };

  /** The one project folder the import wrote, and the `cwd` its transcript records. */
  const landed = (): { folder: string; cwd: string } => {
    const folders = readdirSync(join(targetConfig, "projects"));
    expect(folders).toHaveLength(1);
    const dir = join(targetConfig, "projects", folders[0]);
    const jsonl = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
    const first = JSON.parse(readFileSync(join(dir, jsonl), "utf-8").split("\n")[0]);
    return { folder: folders[0], cwd: first.cwd };
  };

  it.skipIf(isWindows)("import through a symlinked directory lands under the directory it points at", () => {
    const real = join(tempDir, "realproj");
    mkdirSync(real);
    const link = join(tempDir, "linkproj");
    symlinkSync(real, link, "dir");

    const result = importTo(link);
    const { folder, cwd } = landed();
    expect(folder).toBe(encodeProjectPath(real));
    expect(cwd).toBe(real);
    // The resume registry names the same spelling as the folder.
    const history = readFileSync(join(targetConfig, "history.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { project: string });
    expect(history.map((h) => h.project)).toEqual([real]);
    // Said, because the user typed something else.
    const note = result.warnings.find((w) => w.includes("--target-project-path"));
    expect(note).toBeDefined();
    expect(note).toContain(JSON.stringify(link));
    expect(note).toContain(JSON.stringify(real));
  });

  it.skipIf(isWindows)("a target that does not exist yet resolves through its nearest existing ancestor", () => {
    const realParent = join(tempDir, "realparent");
    mkdirSync(realParent);
    const linkParent = join(tempDir, "linkparent");
    symlinkSync(realParent, linkParent, "dir");

    importTo(join(linkParent, "not-yet", "proj"));
    const expected = join(realParent, "not-yet", "proj");
    expect(landed()).toEqual({ folder: encodeProjectPath(expected), cwd: expected });
  });

  it("a relative target is resolved against the working directory, never encoded as typed", () => {
    const work = join(tempDir, "work", "here");
    mkdirSync(work, { recursive: true });

    const result = importTo(join("..", "sibling"), work);
    const expected = join(tempDir, "work", "sibling");
    expect(landed()).toEqual({ folder: encodeProjectPath(expected), cwd: expected });
    expect(result.warnings.some((w) => w.includes("--target-project-path"))).toBe(true);
  });

  /**
   * CHARACTERIZATION — passes against the unfixed code too, and is here for
   * the other direction: the slash commands pass Claude Code's own working
   * directory, which is already physical, and that path must come through
   * byte-identical and without a note.
   */
  it("a physical absolute target is used byte-identically, with nothing to say", () => {
    const real = join(tempDir, "plainproj");
    mkdirSync(real);
    const result = importTo(real);
    expect(landed()).toEqual({ folder: encodeProjectPath(real), cwd: real });
    expect(result.warnings.some((w) => w.includes("--target-project-path"))).toBe(false);
  });

  it("a trailing separator is tidied away, and that alone is not worth a note", () => {
    const real = join(tempDir, "slashproj");
    mkdirSync(real);
    // Encoded as typed, this was `…-slashproj-`: a folder Claude Code never
    // names, since no working directory ends in a separator.
    const result = importTo(real + sep);
    expect(landed()).toEqual({ folder: encodeProjectPath(real), cwd: real });
    expect(result.warnings.some((w) => w.includes("--target-project-path"))).toBe(false);
  });

  it.skipIf(isWindows)("migrate through a symlinked target lands under the directory it points at", () => {
    // A same-config-dir migrate between two real directories.
    const source = join(tempDir, "srcproj");
    mkdirSync(source);
    cpSync(
      join(configDir, "projects", FIXTURE_ENCODED),
      join(configDir, "projects", encodeProjectPath(source)),
      { recursive: true }
    );
    const real = join(tempDir, "realdest");
    mkdirSync(real);
    const link = join(tempDir, "linkdest");
    symlinkSync(real, link, "dir");

    const r = cli(
      [
        "migrate", "--source-project-path", source, "--target-project-path", link,
        "--source-config-dir", configDir, "--target-config-dir", configDir, "--scope", "all",
      ],
      tempDir
    );
    expect(r.status, r.stdout).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.importedSessions).toHaveLength(1);
    const newId = result.importedSessions[0].newId as string;
    expect(existsSync(join(configDir, "projects", encodeProjectPath(real), `${newId}.jsonl`))).toBe(true);
    expect(existsSync(join(configDir, "projects", encodeProjectPath(link)))).toBe(false);
    expect(result.warnings.some((w: string) => w.includes("--target-project-path"))).toBe(true);
  });

  /**
   * A leading `~` is SHELL syntax. Quoted — the way every command line in
   * `commands/*.md` quotes a path — or passed as `--flag=~/x`, no shell expands
   * it, so it reached the CLI literally and resolved to a directory named `~`
   * inside the working directory: an import filed its sessions under it, and a
   * `migrate --rename-dir` MOVED THE PROJECT into it. Refused as a bad
   * invocation (exit 1) before anything is read or written.
   */
  it("a target starting with ~ is refused before anything is written, never taken as a directory named ~", () => {
    const work = join(tempDir, "work");
    mkdirSync(work);

    const imported = cli(
      ["import", "--from", bundle, "--target-project-path", "~/x", "--target-config-dir", targetConfig],
      work
    );
    expect(imported.status, imported.stdout).toBe(1);
    expect(JSON.parse(imported.stdout).error).toContain(JSON.stringify("~/x"));
    expect(readdirSync(join(targetConfig, "projects"))).toEqual([]);

    // The costly one: with --rename-dir, the project directory itself.
    const source = join(tempDir, "tildesrc");
    mkdirSync(source);
    writeFileSync(join(source, "README.md"), "hello\n");
    cpSync(
      join(configDir, "projects", FIXTURE_ENCODED),
      join(configDir, "projects", encodeProjectPath(source)),
      { recursive: true }
    );
    const migrated = cli(
      [
        "migrate", "--source-project-path", source, "--target-project-path", "~/moved",
        "--source-config-dir", configDir, "--target-config-dir", configDir, "--scope", "all",
        "--rename-dir",
      ],
      work
    );
    expect(migrated.status, migrated.stdout).toBe(1);
    expect(existsSync(join(source, "README.md"))).toBe(true);
    expect(existsSync(join(work, "~"))).toBe(false);
    expect(
      readdirSync(join(configDir, "projects", encodeProjectPath(source))).filter((f) => f.endsWith(".jsonl"))
    ).toEqual([`${sessionId}.jsonl`]);
  });

  /**
   * A migrate whose target files its sessions in the folder the source's
   * sessions are in leaves them there — re-importing one into that folder
   * would only change its id — and when nothing else is left to move it is
   * refused. #149 widened the ways to reach that from the target's side: a
   * target through a symlink to the source, or with a trailing separator, now
   * resolves to the source itself. The rule, its legacy-folder half and its
   * `provenBy` live in `tests/migrate-in-place.test.ts`; these are the
   * spellings #149 added.
   */
  const migrateInPlace = (source: string, target: string): RunCliResult => {
    cpSync(
      join(configDir, "projects", FIXTURE_ENCODED),
      join(configDir, "projects", encodeProjectPath(source)),
      { recursive: true }
    );
    return cli(
      [
        "migrate", "--source-project-path", source, "--target-project-path", target,
        "--source-config-dir", configDir, "--target-config-dir", configDir, "--scope", "all",
      ],
      tempDir
    );
  };

  it.skipIf(isWindows)("a migrate whose target is a symlink to its own source is refused, naming both spellings", () => {
    const source = join(tempDir, "selfproj");
    mkdirSync(source);
    const link = join(tempDir, "selflink");
    symlinkSync(source, link, "dir");

    const r = migrateInPlace(source, link);
    // A refusal: understood, declined, nothing done.
    expect(r.status, r.stdout).toBe(2);
    const result = JSON.parse(r.stdout);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Nothing to move/);
    const folder = join(configDir, "projects", encodeProjectPath(source));
    expect(readdirSync(folder).filter((f) => f.endsWith(".jsonl"))).toEqual([`${sessionId}.jsonl`]);
    const note = (result.warnings as string[] | undefined)?.find((w) => w.includes("--target-project-path"));
    expect(note).toContain(JSON.stringify(link));
    expect(note).toContain(JSON.stringify(source));
  });

  it("a migrate whose target is its own source with a trailing separator is refused", () => {
    const source = join(tempDir, "selfslash");
    mkdirSync(source);

    const r = migrateInPlace(source, source + sep);
    expect(r.status, r.stdout).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/^Nothing to move/);
    const folder = join(configDir, "projects", encodeProjectPath(source));
    expect(readdirSync(folder).filter((f) => f.endsWith(".jsonl"))).toEqual([`${sessionId}.jsonl`]);
  });

  /**
   * A LIBRARY caller hands `migrateSession` its target unresolved, and the
   * importer writes under exactly the spelling it is handed. So a symlinked
   * spelling given as both source and target reads the link's folder and
   * writes the link's folder — the re-mint in place, whatever the link points
   * at. (From the CLI the same two flags are a real move: it resolves the
   * target first. That is the loop above.)
   */
  it.skipIf(isWindows)("a library migrate handed the same symlinked spelling for both paths is refused", async () => {
    const { overrideHome } = await import("./helpers/env.js");
    const { migrateSession } = await import("../src/migrator.js");
    const real = join(tempDir, "libreal");
    mkdirSync(real);
    const link = join(tempDir, "liblink");
    symlinkSync(real, link, "dir");
    const folder = await filedUnder(link);
    const before = readdirSync(folder).sort();

    const home = overrideHome(join(tempDir, "home"));
    try {
      const refused = await migrateSession({
        sourceConfigDir: configDir,
        targetConfigDir: configDir,
        sourceProjectPath: link,
        targetProjectPath: link,
        scope: "all",
        excludeLayers: [],
        claudeVersion: "2.1.81",
      });
      expect(refused.success, JSON.stringify(refused)).toBe(false);
      if (refused.success) return;
      expect(refused.error).toMatch(/^Nothing to move/);
    } finally {
      home.restore();
    }
    expect(readdirSync(folder).sort()).toEqual(before);
  });

  /**
   * Two DIFFERENT directories whose names encode alike share one project
   * folder, so the sessions in it are already where the import would write
   * the target's: moving them would re-import each one into that same folder
   * under a new id and delete the original. They stay, and with nothing else
   * to move the migrate is refused, on every platform. That the directories
   * differ does not make it a real move: the folder is what the import
   * writes, and rewriting a `cwd` is not worth a session id.
   */
  it("a migrate between two directories that encode to the same folder leaves the sessions in it, and is refused with nothing else to move", async () => {
    const source = join(tempDir, "enc-alike");
    const target = join(tempDir, "enc.alike");
    mkdirSync(source);
    expect(encodeProjectPath(target)).toBe(encodeProjectPath(source));
    const folder = await filedUnder(source);
    const before = readdirSync(folder).sort();

    const r = cli(
      [
        "migrate", "--source-project-path", source, "--target-project-path", target,
        "--source-config-dir", configDir, "--target-config-dir", configDir, "--scope", "all",
      ],
      tempDir
    );
    expect(r.status, r.stdout).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/^Nothing to move/);
    expect(readdirSync(folder).sort()).toEqual(before);
    expect(recordedCwd(folder)).toBe(source);
  });

  /**
   * Files the bundle's one session under `spelling` exactly as handed, with
   * `spelling` as every `cwd`. For a spelling Claude Code never uses — a
   * symlink, a trailing separator — that is the state #149's bug left behind,
   * reproduced rather than hand-built: the pre-#149 CLI handed a typed
   * `--target-project-path` to `importSession` verbatim, and the library still
   * takes the path it is handed.
   */
  const filedUnder = async (spelling: string): Promise<string> => {
    const { overrideHome } = await import("./helpers/env.js");
    const { importSession } = await import("../src/importer.js");
    const home = overrideHome(join(tempDir, "home"));
    try {
      const imported = await importSession({
        exportPath: bundle,
        targetConfigDir: configDir,
        targetProjectPath: spelling,
        targetClaudeVersion: "2.1.81",
        dryRun: false,
      });
      expect(imported.success, JSON.stringify(imported)).toBe(true);
    } finally {
      home.restore();
    }
    const folder = join(configDir, "projects", encodeProjectPath(spelling));
    expect(recordedCwd(folder)).toBe(spelling);
    return folder;
  };

  /**
   * What a moved-away folder must no longer hold: the transcript and its
   * session directory. `memory/` is left out on purpose — it is a shared layer
   * migrate reconciles into the target and has never deleted from the source.
   */
  const sessionsLeftIn = (folder: string): string[] =>
    readdirSync(folder).filter((n) => n !== "memory");

  /**
   * The MOVE #149 names as the remedy — sessions its bug filed under a
   * symlinked spelling, migrated to the directory the link points at — must
   * not be mistaken for a migrate onto itself. Discovery reads the source AS
   * TYPED, so the sessions are found in the link's own folder, and the import
   * writes the physical path's — a different folder, so they move. (Comparing
   * the source's PHYSICAL path instead would refuse this, because the link
   * resolves to the very directory it is being moved to.) And typing the
   * link for both flags is the same move: the CLI resolves only the target.
   */
  for (const [what, typedTarget] of [
    ["the directory it points at", "real"],
    ["the same symlinked spelling, which the CLI resolves to that directory", "link"],
  ] as const) {
    it.skipIf(isWindows)(`sessions filed under a symlinked spelling migrate to ${what}, and are not refused as onto itself`, async () => {
      const real = join(tempDir, "misfiledreal");
      mkdirSync(real);
      const link = join(tempDir, "misfiledlink");
      symlinkSync(real, link, "dir");
      const linkFolder = await filedUnder(link);

      const r = cli(
        [
          "migrate", "--source-project-path", link,
          "--target-project-path", typedTarget === "real" ? real : link,
          "--source-config-dir", configDir, "--target-config-dir", configDir, "--scope", "all",
        ],
        tempDir
      );
      expect(r.status, r.stdout).toBe(0);
      const result = JSON.parse(r.stdout);
      expect(result.importedSessions).toHaveLength(1);
      expect(result.targetPath).toBe(real);
      const realFolder = join(configDir, "projects", encodeProjectPath(real));
      expect(existsSync(join(realFolder, `${result.importedSessions[0].newId}.jsonl`))).toBe(true);
      expect(recordedCwd(realFolder)).toBe(real);
      expect(sessionsLeftIn(linkFolder)).toEqual([]);
    });
  }

  /**
   * The same rule for the other source spelling #149 misfiled: a typed
   * trailing separator encoded to `…-proj-`, a folder Claude Code never names.
   * Moving those sessions to the tidied path reads one folder and writes
   * another, so it is a real move — and runs on every platform, needing no
   * link. (A trailing separator on the TARGET is tidied by the CLI, so it
   * writes the source's own folder and is refused: see above.)
   */
  it("sessions filed under a trailing-separator spelling migrate to the tidied path, and are not refused as onto itself", async () => {
    const real = join(tempDir, "misfiledslash");
    mkdirSync(real);
    const slashFolder = await filedUnder(real + sep);

    const r = cli(
      [
        "migrate", "--source-project-path", real + sep, "--target-project-path", real,
        "--source-config-dir", configDir, "--target-config-dir", configDir, "--scope", "all",
      ],
      tempDir
    );
    expect(r.status, r.stdout).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.importedSessions).toHaveLength(1);
    const realFolder = join(configDir, "projects", encodeProjectPath(real));
    expect(existsSync(join(realFolder, `${result.importedSessions[0].newId}.jsonl`))).toBe(true);
    expect(recordedCwd(realFolder)).toBe(real);
    expect(sessionsLeftIn(slashFolder)).toEqual([]);
  });

  /**
   * The fixture session pushed from machine A through a real hub, machine B's
   * CLI joined to the same hub, and a directory B can pull from that carries
   * the hub project's identity — at `anchorAt`, which the caller spells.
   */
  const pushedToHub = async (anchorAt: string) => {
    const homeA = join(tempDir, "homeA");
    const homeB = join(tempDir, "homeB");
    const hubDir = join(tempDir, "hub");
    for (const d of [homeA, homeB, hubDir]) mkdirSync(d, { recursive: true });
    const project = join(tempDir, "pushed");
    mkdirSync(project);
    writeFileSync(join(project, "README.md"), "hello\n");
    const pushedDir = join(configDir, "projects", encodeProjectPath(project));
    cpSync(join(configDir, "projects", FIXTURE_ENCODED), pushedDir, { recursive: true });
    // The transcript has to record the directory it is pushed from, or the
    // pull has no source path to rewrite and the `cwd` assertions would be
    // about the fixture rather than the target.
    const pushedJsonl = join(pushedDir, `${sessionId}.jsonl`);
    writeFileSync(
      pushedJsonl,
      readFileSync(pushedJsonl, "utf-8").replaceAll("/Users/testuser/Projects/testproject", project)
    );
    const asA = (args: string[]) =>
      runCli(args, { env: { ...homeEnv(homeA), CLAUDE_CONFIG_DIR: configDir } });
    expect(asA(["hub", "init", "--path", hubDir]).status).toBe(0);
    const pushed = asA([
      "push", "--project-path", project, "--create-project", "--no-workspace",
      "--source-config-dir", configDir,
    ]);
    expect(pushed.status, pushed.stdout).toBe(0);
    const projectId = JSON.parse(pushed.stdout).projectId as string;

    const configDirB = join(homeB, ".claude");
    const asB = (args: string[]) =>
      runCli(args, { env: { ...homeEnv(homeB), CLAUDE_CONFIG_DIR: configDirB } });
    expect(asB(["hub", "init", "--path", hubDir]).status).toBe(0);
    mkdirSync(anchorAt, { recursive: true });
    const { writeLocalProjectId } = await import("../src/hub/identity.js");
    writeLocalProjectId(anchorAt, {
      projectId, name: "pushed", createdAt: new Date().toISOString(), createdByMachine: "a",
    });
    return { configDirB, asB };
  };

  /** The `cwd` the one transcript in `folder` records. */
  const recordedCwd = (folder: string): string => {
    const jsonl = readdirSync(folder).find((f) => f.endsWith(".jsonl"))!;
    return JSON.parse(readFileSync(join(folder, jsonl), "utf-8").split("\n")[0]).cwd;
  };

  /**
   * The ORDINARY pull, not the bootstrap: no `--target-path`, so the sessions
   * land under `--project-path` — the slash command's own cwd in the usual
   * case, and anything at all when typed at the CLI.
   */
  it.skipIf(isWindows)("a pull through a symlinked --project-path lands under the directory it points at", async () => {
    const real = join(tempDir, "realanchor");
    const { configDirB, asB } = await pushedToHub(real);
    const link = join(tempDir, "linkanchor");
    symlinkSync(real, link, "dir");

    const r = asB(["pull", "--latest", "--project-path", link, "--source-config-dir", configDirB]);
    expect(r.status, r.stdout).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.importedSessions).toHaveLength(1);
    expect(recordedCwd(join(configDirB, "projects", encodeProjectPath(real)))).toBe(real);
    expect(existsSync(join(configDirB, "projects", encodeProjectPath(link)))).toBe(false);
    const note = (result.warnings as string[]).find((w) => w.includes("--project-path"));
    expect(note).toBeDefined();
    expect(note).toContain(JSON.stringify(link));
    expect(note).toContain(JSON.stringify(real));
  });

  it.skipIf(isWindows)("a bootstrap pull into a --target-path under a symlinked parent lands under the physical path", async () => {
    // The directory the pull runs from, which carries the hub identity.
    const anchor = join(tempDir, "anchor");
    const { configDirB, asB } = await pushedToHub(anchor);
    const realParent = join(tempDir, "realparent");
    mkdirSync(realParent);
    const linkParent = join(tempDir, "linkparent");
    symlinkSync(realParent, linkParent, "dir");

    const r = asB([
      "pull", "--latest", "--project-path", anchor, "--target-path", join(linkParent, "fresh"),
      "--source-config-dir", configDirB,
    ]);
    expect(r.status, r.stdout).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.importedSessions).toHaveLength(1);
    const expected = join(realParent, "fresh");
    expect(recordedCwd(join(configDirB, "projects", encodeProjectPath(expected)))).toBe(expected);
    expect(existsSync(join(configDirB, "projects", encodeProjectPath(join(linkParent, "fresh"))))).toBe(false);
    expect(result.warnings.some((w: string) => w.includes("--target-path"))).toBe(true);
  });
});
