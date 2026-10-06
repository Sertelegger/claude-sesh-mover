import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";
import { homeEnv } from "./helpers/env.js";
import { runCli, type RunCliResult } from "./helpers/run-cli.js";

/**
 * #140 — #124's walk-past disclosure ("this session's folder also holds X,
 * which sesh-mover does not carry") on the two paths it never reached: `push`,
 * which dropped every warning its export produced, and a CONTINUATION, whose
 * exporter loop never listed the folder at all. `push` is incremental by
 * construction, so after a session's first push every later push of it is a
 * continuation — together the two gaps meant no push ever said it.
 *
 * CLI-LEVEL on purpose: what the skill layer relays is the JSON `push` and
 * `export` print, and `push`'s half of the defect was a field it never copied
 * onto that output. These spawn `dist/cli.js`, so a mutation to `src/` is
 * invisible to them until `npm run build` runs.
 *
 * The names are ones no version of this plugin has heard of, for the reason
 * `tests/migrator.test.ts`'s #124 test gives: `workflows/` would pin today's
 * known unknown and pass just as well against a fix that special-cased it.
 */
const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";
const UNKNOWN_DIR = "some-future-feature";
const UNKNOWN_FILE = "stray-diagnostic.txt";

describe("the walk-past disclosure on push and on continuations (#140)", () => {
  let tempDir: string;
  let home: string;
  let hubDir: string;
  let configDir: string;
  let sessionId: string;
  let project: string;
  let transcript: string;
  let appended: number;
  let head: string;

  beforeEach(() => {
    appended = 0;
    head = "entry-3"; // the fixture transcript's last conversation entry
    tempDir = mkdtempSync(join(tmpdir(), "sesh-walk-past-"));
    home = join(tempDir, "home");
    hubDir = join(tempDir, "hub");
    mkdirSync(home, { recursive: true });
    mkdirSync(hubDir, { recursive: true });
    const fixture = createFixtureTree(join(tempDir, "fixture"));
    configDir = fixture.configDir;
    sessionId = fixture.sessionId;
    // A real, git-less directory: push writes the link file into it.
    project = join(tempDir, "proj");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "README.md"), "hello\n");
    const encoded = join(configDir, "projects", encodeProjectPath(project));
    cpSync(join(configDir, "projects", FIXTURE_ENCODED), encoded, { recursive: true });
    transcript = join(encoded, `${sessionId}.jsonl`);
    const sessionDir = join(encoded, sessionId);
    mkdirSync(join(sessionDir, UNKNOWN_DIR), { recursive: true });
    writeFileSync(join(sessionDir, UNKNOWN_DIR, "state.json"), "{}\n");
    writeFileSync(join(sessionDir, UNKNOWN_FILE), "boom\n");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const cli = (args: string[]): RunCliResult =>
    runCli(args, { env: { ...homeEnv(home), CLAUDE_CONFIG_DIR: configDir } });

  const push = (extra: string[] = []): Record<string, unknown> & { warnings: string[] } => {
    const r = cli([
      "push", "--project-path", project, "--source-config-dir", configDir, "--no-workspace", ...extra,
    ]);
    expect(r.status, r.stdout).toBe(0);
    return JSON.parse(r.stdout);
  };

  /** One more conversation entry, chained onto the current head. */
  const appendEntry = (): void => {
    const uuid = `walk-past-${++appended}`;
    appendFileSync(
      transcript,
      JSON.stringify({
        type: "user", uuid, parentUuid: head, timestamp: new Date().toISOString(),
        cwd: project, sessionId, version: "2.1.81",
        message: { role: "user", content: `more ${appended}` },
      }) + "\n"
    );
    head = uuid;
  };

  /** The warnings that name the uncarried entries — the disclosure itself. */
  const disclosures = (warnings: string[]): string[] =>
    warnings.filter((w) => w.includes(UNKNOWN_DIR) || w.includes(UNKNOWN_FILE));

  it("a first push and a continuation push each name what they did not carry, in ONE warning", () => {
    expect(cli(["hub", "init", "--path", hubDir]).status).toBe(0);

    const first = push(["--create-project"]);
    expect((first.pushedSessions as Array<{ type: string }>)[0].type).toBe("full");
    // One warning for the whole push, not one per entry per session: the
    // SessionEnd auto-push keeps only its first five notes, and a note per
    // entry would crowd out the carry disclosure `commands/push.md` relays.
    const onFirst = disclosures(first.warnings);
    expect(onFirst).toHaveLength(1);
    expect(onFirst[0]).toContain(JSON.stringify(UNKNOWN_DIR));
    expect(onFirst[0]).toContain(JSON.stringify(UNKNOWN_FILE));
    expect(onFirst[0]).toContain("1 session");
    // Worded for a push: there is no migrate here to leave anything in place.
    expect(onFirst[0]).not.toMatch(/migrate/);

    appendEntry();
    const second = push();
    expect((second.pushedSessions as Array<{ type: string }>)[0].type).toBe("continuation");
    const onSecond = disclosures(second.warnings);
    expect(onSecond).toHaveLength(1);
    expect(onSecond[0]).toContain(JSON.stringify(UNKNOWN_DIR));
    expect(onSecond[0]).toContain(JSON.stringify(UNKNOWN_FILE));
  });

  it("a push that falls back to sending a session whole says why", () => {
    expect(cli(["hub", "init", "--path", hubDir]).status).toBe(0);
    push(["--create-project"]);
    appendEntry();
    appendEntry();
    expect(
      (push().pushedSessions as Array<{ type: string }>)[0].type
    ).toBe("continuation");

    // Drop the two entries the hub now holds as this session's head.
    const lines = readFileSync(transcript, "utf-8").split("\n").filter((l) => l !== "");
    writeFileSync(transcript, lines.slice(0, -2).join("\n") + "\n");
    const third = push();
    expect((third.pushedSessions as Array<{ type: string }>)[0].type).toBe("full");
    // The planner's reason, which push used to drop: a bigger upload and a new
    // full bundle, with nothing saying why.
    const whole = third.warnings.filter((w) => /sending whole/.test(w));
    expect(whole).toHaveLength(1);
    expect(whole[0]).toContain(sessionId);
    // Folded into one push-worded note, however many sessions it covers.
    expect(whole[0]).toMatch(/^This push sent a session whole rather than as a delta/);
  });

  it("an incremental export's continuation discloses too", () => {
    const out = join(tempDir, "exports");
    mkdirSync(out, { recursive: true });
    const base = [
      "--scope", "all", "--source-config-dir", configDir, "--project-path", project,
      "--format", "dir", "--output", out,
    ];
    const ref = cli(["export", ...base, "--name", "ref"]);
    expect(ref.status, ref.stdout).toBe(0);

    appendEntry();
    const inc = cli(["export", ...base, "--name", "inc", "--incremental", "--since", join(out, "ref")]);
    expect(inc.status, inc.stdout).toBe(0);
    const result = JSON.parse(inc.stdout) as { warnings: string[] };
    const manifest = JSON.parse(readFileSync(join(out, "inc", "manifest.json"), "utf-8"));
    expect(manifest.sessions.map((s: { type: string }) => s.type)).toEqual(["continuation"]);

    const said = disclosures(result.warnings).join("\n");
    expect(said).toContain(JSON.stringify(UNKNOWN_DIR));
    expect(said).toContain(JSON.stringify(UNKNOWN_FILE));
  });
});
