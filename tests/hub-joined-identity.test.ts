/**
 * # Which hub this machine joined, remembered locally — at CLI level
 *
 * Signing-key pins are keyed `(hubId, machineId)`, and until this suite existed
 * the `hubId` half of that key was whatever the hub's own `hub.json` said on
 * the current run. So anyone who could write the hub could rewrite ONE field
 * and every receiver's pin lookup missed: a substituted signing key was pinned
 * as a first sighting (a `confirmed` pin included — it was simply never
 * consulted) and the unsigned-downgrade warning disappeared with it.
 *
 * The fix remembers, under `~/.sesh-mover/joined-hubs.json`, which hub identity
 * this machine joined at each hub address, and refuses every hub verb on a
 * mismatch until the user deliberately re-joins with `hub init
 * --accept-new-hub-id`.
 *
 * Everything here runs the SHIPPED `dist/cli.js` with a scratch home per
 * machine, because the property is about three machines and one shared
 * directory, and because a src-only mutation is invisible to it (run
 * `npm run build` after breaking something on purpose).
 *
 * The three machines, as in the verification that found the defect:
 *
 * - **A** pushes a real session.
 * - **C** joins and pulls it, so C holds a pin for A's signing key.
 * - **X** pushes under A's machine id (a copied `machine-id.json`) and signs
 *   with a key of its own — the substituted key.
 */
import { describe, it, expect } from "vitest";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli } from "./helpers/run-cli.js";
import { homeEnv } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";
import { writeLocalProjectId } from "../src/hub/identity.js";

const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";
const ATTACKER_HUB_ID = "00000000-attacker-hub-id";
const PLANTED = "planted by the substituted signer";
const TIMEOUT = 240_000;

interface Machine {
  home: string;
  configDir: string;
}

interface Run {
  status: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  stdout: string;
  stderr: string;
}

// Every temp root is realpath'd: Claude Code hands a hook the PHYSICAL cwd, and
// `hub status` keys by process.cwd(), which is physical too. On macOS tmpdir()
// is /var/… → /private/var/…, so an unresolved root files the hook's record
// under one spelling and reads it under the other (failed on macos-latest only).
function cli(m: Machine, args: string[], cwd: string): Run {
  const r = runCli(args, {
    env: { ...homeEnv(m.home), CLAUDE_CONFIG_DIR: m.configDir },
    cwd,
  });
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function ok(r: Run, what: string): Run {
  if (r.status !== 0 || !r.json?.success) {
    throw new Error(`${what} failed (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
  return r;
}

/** A machine whose Claude config dir holds the standard fixture session. */
function machineWithFixture(root: string, name: string): Machine {
  const home = join(root, `home${name}`);
  mkdirSync(home, { recursive: true });
  const { configDir } = createFixtureTree(join(root, `fix${name}`));
  return { home, configDir };
}

function bareMachine(root: string, name: string): Machine {
  const home = join(root, `home${name}`);
  const configDir = join(home, ".claude");
  mkdirSync(configDir, { recursive: true });
  return { home, configDir };
}

/** A real, git-less project directory carrying the fixture session. */
function projectWithFixture(root: string, m: Machine, name: string): string {
  const projectPath = join(root, name);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, "README.md"), "hello\n");
  cpSync(
    join(m.configDir, "projects", FIXTURE_ENCODED),
    join(m.configDir, "projects", encodeProjectPath(projectPath)),
    { recursive: true }
  );
  return projectPath;
}

function linkProject(projectPath: string, projectId: string): void {
  mkdirSync(projectPath, { recursive: true });
  writeLocalProjectId(projectPath, {
    projectId, name: "proj", createdAt: new Date().toISOString(), createdByMachine: "machine-a",
  });
}

function pinFile(m: Machine): string {
  return join(m.home, ".sesh-mover", "key-pins.json");
}

function joinedFile(m: Machine): string {
  return join(m.home, ".sesh-mover", "joined-hubs.json");
}

function readBytes(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

interface Pin {
  hubId: string;
  machineId: string;
  publicKey: string;
  origin: "tofu" | "confirmed";
}

function pins(m: Machine): Pin[] {
  const raw = readBytes(pinFile(m));
  return raw === null ? [] : (JSON.parse(raw).pins as Pin[]);
}

function hubId(hub: string): string {
  return JSON.parse(readFileSync(join(hub, "hub.json"), "utf-8")).hubId as string;
}

/** The attack: ONE field of `hub.json` replaced, everything else untouched. */
function rewriteHubId(hub: string, newId: string): void {
  const p = join(hub, "hub.json");
  const j = JSON.parse(readFileSync(p, "utf-8"));
  j.hubId = newId;
  writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}

/** Does any transcript under this machine's config dir carry X's planted text? */
function holdsPlanted(m: Machine): boolean {
  const projects = join(m.configDir, "projects");
  if (!existsSync(projects)) return false;
  for (const dir of readdirSync(projects)) {
    const d = join(projects, dir);
    for (const f of readdirSync(d)) {
      if (f.endsWith(".jsonl") && readFileSync(join(d, f), "utf-8").includes(PLANTED)) return true;
    }
  }
  return false;
}

interface Fleet {
  root: string;
  hub: string;
  A: Machine;
  C: Machine;
  projectId: string;
  machineIdA: string;
  originalHubId: string;
  projC: string;
}

/** A joins and pushes; C joins and pulls, so C pins A's key on first use. */
function arrangeFleet(root: string, opts: { cPulls?: boolean } = {}): Fleet {
  const hub = join(root, "hub");
  mkdirSync(hub, { recursive: true });

  const A = machineWithFixture(root, "A");
  const projA = projectWithFixture(root, A, "projA");
  ok(cli(A, ["hub", "init", "--path", hub], root), "A hub init");
  const push = ok(
    cli(A, ["push", "--project-path", projA, "--create-project", "--no-workspace",
      "--source-config-dir", A.configDir], root),
    "A push"
  );
  const projectId = push.json.projectId as string;
  const machineIdA = JSON.parse(
    readFileSync(join(A.home, ".sesh-mover", "machine-id.json"), "utf-8")
  ).id as string;

  const C = bareMachine(root, "C");
  ok(cli(C, ["hub", "init", "--path", hub], root), "C hub init");
  const projC = join(root, "projC");
  linkProject(projC, projectId);
  if (opts.cPulls !== false) {
    const pulled = ok(
      cli(C, ["pull", "--latest", "--project-path", projC, "--source-config-dir", C.configDir], root),
      "C pull"
    );
    expect(pulled.json.importedSessions).toHaveLength(1);
    // The precondition every row depends on: C holds a pin for A.
    expect(pins(C).filter((p) => p.machineId === machineIdA)).toHaveLength(1);
  }
  return { root, hub, A, C, projectId, machineIdA, originalHubId: hubId(hub), projC };
}

/**
 * X pushes a NEW session under A's machine id, signed with X's own key. Returns
 * the thread id X's push minted, which is what C is then asked to pull.
 */
function substitutedSignerPushes(f: Fleet): string {
  const X = bareMachine(f.root, "X");
  mkdirSync(join(X.home, ".sesh-mover"), { recursive: true });
  cpSync(join(f.A.home, ".sesh-mover", "machine-id.json"), join(X.home, ".sesh-mover", "machine-id.json"));
  ok(cli(X, ["hub", "init", "--path", f.hub], f.root), "X hub init");

  const projX = join(f.root, "projX");
  linkProject(projX, f.projectId);
  const sid = "7b1e2c4d-0000-4000-8000-00000000000a";
  const slot = join(X.configDir, "projects", encodeProjectPath(projX));
  mkdirSync(slot, { recursive: true });
  const base = { sessionId: sid, cwd: projX, version: "2.1.81", gitBranch: "main", slug: "x-session" };
  writeFileSync(
    join(slot, `${sid}.jsonl`),
    [
      { ...base, uuid: "x-1", parentUuid: null, timestamp: "2026-09-20T10:00:00.000Z", type: "user",
        message: { role: "user", content: PLANTED } },
      { ...base, uuid: "x-2", parentUuid: "x-1", timestamp: "2026-09-20T10:00:05.000Z", type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  const push = ok(
    cli(X, ["push", "--project-path", projX, "--no-workspace", "--source-config-dir", X.configDir], f.root),
    "X push"
  );
  const threadId = push.json.pushedSessions[0].threadId as string;
  expect(threadId).toBeTruthy();
  return threadId;
}

/** Read A's own fingerprint off A — the out-of-band half of `hub trust`. */
function fingerprintOfA(f: Fleet): string {
  const report = ok(cli(f.A, ["hub", "trust"], f.root), "A hub trust");
  const self = (report.json.machines as Array<{ machineId: string; fingerprint: string }>).find(
    (m) => m.machineId === f.machineIdA
  );
  if (!self?.fingerprint) throw new Error("A published no fingerprint");
  return self.fingerprint;
}

function pullThread(f: Fleet, threadId: string): Run {
  return cli(
    f.C,
    ["pull", "--thread", threadId, "--project-path", f.projC, "--source-config-dir", f.C.configDir],
    f.root
  );
}

function expectIdentityRefusal(r: Run, f: Fleet, verb: string): void {
  expect(r.status, `${verb}: ${r.stdout}${r.stderr}`).toBe(2);
  expect(r.json?.success, verb).toBe(false);
  expect(r.json?.reason, `${verb}: ${r.stdout}`).toBe("hub-identity-changed");
  expect(r.json.currentHubId, verb).toBe(ATTACKER_HUB_ID);
  expect(r.json.expectedHubIds, verb).toEqual([f.originalHubId]);
  expect(r.json.hubPath, verb).toBe(resolve(f.hub));
}

/**
 * C's second hub, H1, reached through a PROJECT-scope hub.path: D pushes a
 * project there and C pulls it into `proj1`, so C's sync-state for `proj1` and
 * its pins name H1's id.
 */
function secondHub(f: Fleet): { h1: string; h1Id: string; proj1: string } {
  const h1 = join(f.root, "h1");
  mkdirSync(h1, { recursive: true });
  const D = machineWithFixture(f.root, "D");
  const projD = projectWithFixture(f.root, D, "projD");
  ok(cli(D, ["hub", "init", "--path", h1], f.root), "D hub init");
  const pushedD = ok(
    cli(D, ["push", "--project-path", projD, "--create-project", "--no-workspace",
      "--source-config-dir", D.configDir], f.root),
    "D push"
  );
  const proj1 = join(f.root, "proj1");
  mkdirSync(proj1, { recursive: true });
  ok(cli(f.C, ["hub", "init", "--path", h1, "--scope", "project"], proj1), "C joins h1 for proj1");
  linkProject(proj1, pushedD.json.projectId as string);
  ok(
    cli(f.C, ["pull", "--latest", "--project-path", proj1, "--source-config-dir", f.C.configDir], proj1),
    "C pulls from h1"
  );
  const h1Id = hubId(h1);
  expect(pins(f.C).map((p) => p.hubId).sort()).toEqual([f.originalHubId, h1Id].sort());
  return { h1, h1Id, proj1 };
}

/**
 * Point one project's hub.path at another hub — "the project moved". Its
 * sync-state keeps the hub id it was first stamped with (`setThreadId` stamps
 * once and never updates), which is exactly the stale id these rows are about.
 */
function moveProject(m: Machine, projectPath: string, toHub: string): void {
  ok(cli(m, ["configure", "--scope", "project", "--set", `hub.path=${toHub}`], projectPath), "move project");
}

/** The evidence refusal every seed-rule row expects, and that nothing moved. */
function expectEvidenceRefusal(r: Run, currentHubId: string, expected: string[]): void {
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
  expect(r.json?.success).toBe(false);
  expect(r.json?.reason, r.stdout).toBe("hub-identity-changed");
  expect(r.json.basis).toBe("evidence");
  expect(r.json.currentHubId).toBe(currentHubId);
  expect(r.json.expectedHubIds).toEqual([...expected].sort());
  // The suggestion names every id this machine's records hold for the path,
  // says stop, and names the explicit first join as the deliberate remedy.
  for (const id of expected) expect(r.json.suggestion).toContain(id);
  expect(r.json.suggestion).toMatch(/stop/i);
  expect(r.json.suggestion).toMatch(/hub init --path/);
}

describe("a rewritten hub.json hubId cannot reset this machine's pins", () => {
  it("control — hub.json untouched: the substituted key is refused as unpinned", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-control-")));
    try {
      const f = arrangeFleet(root);
      const threadId = substitutedSignerPushes(f);
      const pinsBefore = readBytes(pinFile(f.C));

      const r = pullThread(f, threadId);
      expect(r.status, r.stdout).toBe(2);
      expect(r.json.success).toBe(false);
      expect(r.json.error).toMatch(/not the one pinned for machine/);
      expect(holdsPlanted(f.C)).toBe(false);
      expect(readBytes(pinFile(f.C))).toBe(pinsBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("attack — only hub.json's hubId replaced: every hub verb refuses, nothing applied, no new pin", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-attack-")));
    try {
      const f = arrangeFleet(root);
      rewriteHubId(f.hub, ATTACKER_HUB_ID);
      const threadId = substitutedSignerPushes(f);
      const pinsBefore = readBytes(pinFile(f.C));
      const joinedBefore = readBytes(joinedFile(f.C));
      const machineRecordC = join(
        f.hub, "machines",
        `${JSON.parse(readFileSync(join(f.C.home, ".sesh-mover", "machine-id.json"), "utf-8")).id}.json`
      );
      const machineRecordBefore = readBytes(machineRecordC);

      const r = pullThread(f, threadId);
      expectIdentityRefusal(r, f, "pull");
      expect(r.json.error).toContain(f.originalHubId);
      expect(r.json.error).toContain(ATTACKER_HUB_ID);
      expect(holdsPlanted(f.C)).toBe(false);

      const cfg = ["--project-path", f.projC, "--source-config-dir", f.C.configDir];
      const verbs: Array<[string, string[]]> = [
        ["push", ["push", ...cfg]],
        ["hub trust", ["hub", "trust", ...cfg]],
        ["hub reindex", ["hub", "reindex", ...cfg]],
        ["hub retire", ["hub", "retire", ...cfg]],
        ["hub delete", ["hub", "delete", ...cfg]],
        ["hub encrypt", ["hub", "encrypt", ...cfg]],
        ["hub rekey", ["hub", "rekey", ...cfg]],
        ["hub compact", ["hub", "compact", "--thread", threadId, ...cfg]],
        ["hub init", ["hub", "init", "--path", f.hub]],
      ];
      for (const [name, args] of verbs) expectIdentityRefusal(cli(f.C, args, f.root), f, name);

      // The two READS report the state inside success:true, as they do the
      // other unusable-hub states.
      for (const args of [["hub", "status"], ["whereis", ...cfg]]) {
        const s = cli(f.C, args, f.projC);
        expect(s.status, s.stdout).toBe(0);
        expect(s.json.success).toBe(true);
        expect(s.json.hubState).toBe("identity-changed");
        expect(s.json.reachable).toBe(false);
      }

      // Nothing moved: no pin was added, the joined-hub record still names the
      // original id, and no verb re-registered C on the hub.
      expect(readBytes(pinFile(f.C))).toBe(pinsBefore);
      expect(pins(f.C).some((p) => p.hubId === ATTACKER_HUB_ID)).toBe(false);
      expect(readBytes(joinedFile(f.C))).toBe(joinedBefore);
      expect(readBytes(machineRecordC)).toBe(machineRecordBefore);
      expect(holdsPlanted(f.C)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("attack after hub trust confirmed the real key: the same refusal, and the confirmed pin stands", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-confirmed-")));
    try {
      const f = arrangeFleet(root);
      ok(
        cli(f.C, ["hub", "trust", "--machine", f.machineIdA, "--fingerprint", fingerprintOfA(f)], f.root),
        "C confirms A"
      );
      expect(pins(f.C).find((p) => p.machineId === f.machineIdA)?.origin).toBe("confirmed");

      rewriteHubId(f.hub, ATTACKER_HUB_ID);
      const threadId = substitutedSignerPushes(f);
      const pinsBefore = readBytes(pinFile(f.C));

      expectIdentityRefusal(pullThread(f, threadId), f, "pull");
      expectIdentityRefusal(cli(f.C, ["hub", "trust"], f.root), f, "hub trust");
      expect(holdsPlanted(f.C)).toBe(false);
      expect(readBytes(pinFile(f.C))).toBe(pinsBefore);
      expect(pins(f.C)).toHaveLength(1);
      expect(pins(f.C)[0]).toMatchObject({ hubId: f.originalHubId, origin: "confirmed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("attack on an upgraded two-hub machine — hub.json given the OTHER hub's id: refused, not seeded", () => {
    // The seed trusts a hub id this machine already knows. Before the seed was
    // tied to the address, "already knows" meant ANY hub's id: a writer of one
    // hub could give it another hub's id and the probe seeded it, so the pins
    // this machine holds for the first hub were looked up under an id that has
    // none — the pin reset again, with no user action at all.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-twohub-")));
    try {
      const f = arrangeFleet(root);
      const { h1Id, proj1 } = secondHub(f);

      // An install from before joined-hubs.json existed…
      rmSync(joinedFile(f.C), { force: true });
      // …and the attack: the hub C pulls projC from now claims to be H1.
      rewriteHubId(f.hub, h1Id);
      const threadId = substitutedSignerPushes(f);
      const pinsBefore = readBytes(pinFile(f.C));

      const r = pullThread(f, threadId);
      expect(r.status, r.stdout).toBe(2);
      expect(r.json.reason).toBe("hub-identity-changed");
      expect(r.json.basis).toBe("evidence");
      expect(r.json.currentHubId).toBe(h1Id);
      // Only the id this machine's own records tie to THIS address.
      expect(r.json.expectedHubIds).toEqual([f.originalHubId]);
      // The remedy names the scope that supplied hub.path, and says plainly
      // that a first join carries no pin over.
      expect(r.json.suggestion).toContain(`hub init --path "${resolve(f.hub)}" --scope user`);
      expect(r.json.suggestion).toMatch(/pinned afresh on first use/);
      expect(holdsPlanted(f.C)).toBe(false);
      expect(readBytes(pinFile(f.C))).toBe(pinsBefore);
      expect(existsSync(joinedFile(f.C))).toBe(false);

      // The other hub is untouched by this: its own address still seeds.
      const atH1 = cli(f.C, ["hub", "trust"], proj1);
      expect(atH1.status, atH1.stdout).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe("the seed takes only an unambiguous match — a project moved between hubs", () => {
  // A project's sync-state keeps the hub id it was first stamped with, so on a
  // machine where a project moved from one hub to another that id is STALE:
  // it names a hub the project's path no longer serves. Before this rule the
  // seed accepted any id in the evidence set, so a hub writer could hand the
  // hub that stale id — it was "known" — and every pin this machine held under
  // the hub's real id was then looked up under one with none of them. The rule
  // now: seed only when the evidence names nothing at all, or exactly one id
  // and it is the one hub.json carries. T6 and T7 are the re-review's two rows,
  // one per evidence set.

  it("T6 — tied evidence: the moved project's stale id beside the path's real one refuses, nothing imported, no new pin", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-t6-")));
    try {
      const f = arrangeFleet(root);
      const { h1Id, proj1 } = secondHub(f);
      // proj1 moves from H1 to the fleet hub. Now TWO projects on this machine
      // tie the fleet hub's path: projC under its real id, proj1 under H1's.
      moveProject(f.C, proj1, f.hub);
      // An install from before joined-hubs.json existed…
      rmSync(joinedFile(f.C), { force: true });
      // …and the attack: the fleet hub now claims the moved project's stale id.
      rewriteHubId(f.hub, h1Id);
      const threadId = substitutedSignerPushes(f);
      const pinsBefore = readBytes(pinFile(f.C));

      const r = pullThread(f, threadId);
      expectEvidenceRefusal(r, h1Id, [f.originalHubId, h1Id]);
      expect(holdsPlanted(f.C)).toBe(false);
      expect(readBytes(pinFile(f.C))).toBe(pinsBefore);
      expect(existsSync(joinedFile(f.C))).toBe(false);

      // Any ambiguity refuses — the honest hub.json too, since this machine's
      // records cannot say which of the two ids this path is — and the
      // deliberate first join the suggestion names is what settles it.
      rewriteHubId(f.hub, f.originalHubId);
      expectEvidenceRefusal(cli(f.C, ["hub", "trust"], root), f.originalHubId, [f.originalHubId, h1Id]);
      expect(existsSync(joinedFile(f.C))).toBe(false);
      const joined = ok(cli(f.C, ["hub", "init", "--path", f.hub], root), "C joins explicitly");
      expect(joined.json.identity).toBe("recorded");
      expect(cli(f.C, ["hub", "trust"], root).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("T7 — no project ties the path, so every id this machine knows decides: two of them refuse, nothing imported, no new pin", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-t7-")));
    try {
      const f = arrangeFleet(root);
      const { h1, h1Id } = secondHub(f);
      // projC moves from the fleet hub to H1, so no project on this machine is
      // tied to the fleet hub's path any more, and the decision falls to the
      // union of every hub id this machine's sync-state and pins name.
      moveProject(f.C, f.projC, h1);
      rmSync(joinedFile(f.C), { force: true });
      rewriteHubId(f.hub, h1Id);
      const threadId = substitutedSignerPushes(f);
      const pinsBefore = readBytes(pinFile(f.C));

      // A fresh clone of the fleet hub's project, inheriting the user-scope
      // hub.path, with no sync-state of its own.
      const projN = join(root, "projN");
      linkProject(projN, f.projectId);
      const r = cli(
        f.C,
        ["pull", "--thread", threadId, "--project-path", projN, "--source-config-dir", f.C.configDir],
        root
      );
      expectEvidenceRefusal(r, h1Id, [f.originalHubId, h1Id]);
      // projN — the project running this pull — DOES use the path; it just
      // holds no hub records yet, so the wording must not say no project
      // uses it.
      expect(r.json.suggestion).toMatch(/none of its projects with hub records uses that path/);
      expect(holdsPlanted(f.C)).toBe(false);
      expect(existsSync(join(f.C.configDir, "projects", encodeProjectPath(projN)))).toBe(false);
      expect(readBytes(pinFile(f.C))).toBe(pinsBefore);
      expect(existsSync(joinedFile(f.C))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe("the hook endpoints keep their contract on a changed hub identity", () => {
  it("SessionEnd exits 0 and records the refusal; SessionStart exits 0 and says so in one notice", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-hooks-")));
    try {
      const f = arrangeFleet(root);
      rewriteHubId(f.hub, ATTACKER_HUB_ID);
      const env = { env: { ...homeEnv(f.C.home), CLAUDE_CONFIG_DIR: f.C.configDir }, cwd: root };
      const payload = (event: string): string =>
        JSON.stringify({ session_id: "s", cwd: f.projC, hook_event_name: event, source: "startup", reason: "other" });

      const end = runCli(["hub", "hook-session-end"], { ...env, input: payload("SessionEnd") });
      expect(end.status).toBe(0);
      expect(end.stdout).toBe("");
      const status = cli(f.C, ["hub", "status"], f.projC);
      expect(status.json.hubState).toBe("identity-changed");
      expect(status.json.lastAutoPush.ok).toBe(false);
      expect(status.json.lastAutoPush.notes[0]).toMatch(/Hub identity changed/);

      const start = runCli(["hub", "hook-session-start"], { ...env, input: payload("SessionStart") });
      expect(start.status).toBe(0);
      const out = JSON.parse(start.stdout);
      expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(out.hookSpecificOutput.additionalContext).toMatch(/is not the hub identity this machine knows for it/);
      // The notice carries nothing read off the hub.
      expect(out.hookSpecificOutput.additionalContext).not.toContain(ATTACKER_HUB_ID);
      expect(pins(f.C).some((p) => p.hubId === ATTACKER_HUB_ID)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe("hub init --accept-new-hub-id", () => {
  it("carries pins forward, so accepting a rewritten id does not let a substituted key in", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-carry-")));
    try {
      const f = arrangeFleet(root);
      ok(
        cli(f.C, ["hub", "trust", "--machine", f.machineIdA, "--fingerprint", fingerprintOfA(f)], f.root),
        "C confirms A"
      );
      rewriteHubId(f.hub, ATTACKER_HUB_ID);
      const threadId = substitutedSignerPushes(f);

      // The user accepts the change (wrongly, here — but the flag must not be
      // the thing that resets trust).
      const accepted = ok(
        cli(f.C, ["hub", "init", "--path", f.hub, "--accept-new-hub-id"], f.root),
        "C accepts"
      );

      // The property first: after acceptance the substituted key still meets
      // A's pin, carried to the new id, and is refused.
      const r = pullThread(f, threadId);
      expect(r.status, r.stdout).toBe(2);
      expect(r.json.error).toMatch(/not the one pinned for machine/);
      expect(holdsPlanted(f.C)).toBe(false);

      expect(accepted.json.created).toBe(false);
      expect(accepted.json.hubId).toBe(ATTACKER_HUB_ID);
      expect(accepted.json.identity).toBe("accepted-change");
      expect(accepted.json.previousHubId).toBe(f.originalHubId);
      expect(accepted.json.pinsCarried).toBe(1);
      expect(accepted.json.warnings.join(" ")).toMatch(/did not re-create this hub/);

      // The carried pin keeps its key AND its origin: confirmed stays confirmed.
      const carried = pins(f.C).find((p) => p.hubId === ATTACKER_HUB_ID && p.machineId === f.machineIdA);
      const old = pins(f.C).find((p) => p.hubId === f.originalHubId && p.machineId === f.machineIdA);
      expect(carried?.origin).toBe("confirmed");
      expect(carried?.publicKey).toBe(old?.publicKey);

      const joined = JSON.parse(readFileSync(joinedFile(f.C), "utf-8"));
      expect(joined.hubs).toHaveLength(1);
      expect(joined.hubs[0]).toMatchObject({
        address: resolve(f.hub), hubId: ATTACKER_HUB_ID, origin: "accepted-change",
        previousHubIds: [f.originalHubId],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("a deliberately re-created hub: pull refuses, --accept-new-hub-id re-joins, and bundles signed under the old id still pull", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-recreate-")));
    try {
      // C joins but has not pulled A's bundle yet — it is still signed under
      // the ORIGINAL hub id when C finally fetches it.
      const f = arrangeFleet(root, { cPulls: false });

      // The owner loses hub.json and re-creates it on purpose. Without the flag
      // the guard refuses (the directory holds hub content); with it, a new id.
      rmSync(join(f.hub, "hub.json"));
      const guarded = cli(f.A, ["hub", "init", "--path", f.hub], root);
      expect(guarded.status, guarded.stdout).toBe(3);
      expect(guarded.json.reason).toBe("hub-content-without-identity");
      expect(existsSync(join(f.hub, "hub.json"))).toBe(false);
      const recreated = ok(cli(f.A, ["hub", "init", "--path", f.hub, "--accept-new-hub-id"], root), "A re-creates");
      expect(recreated.json.created).toBe(true);
      const newId = recreated.json.hubId as string;
      expect(newId).not.toBe(f.originalHubId);
      expect(recreated.json.identity).toBe("accepted-change");

      const pullArgs = ["pull", "--latest", "--project-path", f.projC, "--source-config-dir", f.C.configDir];
      const refused = cli(f.C, pullArgs, root);
      expect(refused.status, refused.stdout).toBe(2);
      expect(refused.json.reason).toBe("hub-identity-changed");
      expect(refused.json.suggestion).toMatch(/--accept-new-hub-id/);

      ok(cli(f.C, ["hub", "init", "--path", f.hub, "--accept-new-hub-id"], root), "C re-joins");
      const pulled = cli(f.C, pullArgs, root);
      expect(pulled.status, pulled.stdout).toBe(0);
      expect(pulled.json.importedSessions).toHaveLength(1);
      // First contact with A's key under the new id, pinned there.
      expect(pins(f.C).some((p) => p.hubId === newId && p.machineId === f.machineIdA)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe("seeding an address this machine has no record for (every install after upgrade)", () => {
  it("seeds when local evidence agrees, and refuses when it contradicts — writing nothing", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-seed-")));
    try {
      const f = arrangeFleet(root);
      // A pre-upgrade install: pins and sync-state name the hub, and there is
      // no joined-hubs record at all.
      rmSync(joinedFile(f.C), { force: true });

      // Contradicting branch first: evidence says originalHubId, hub.json says
      // something else, and nothing records it as the joined hub.
      rewriteHubId(f.hub, ATTACKER_HUB_ID);
      const refused = cli(f.C, ["hub", "trust"], root);
      expect(refused.status, refused.stdout).toBe(2);
      expect(refused.json.reason).toBe("hub-identity-changed");
      expect(refused.json.basis).toBe("evidence");
      expect(refused.json.expectedHubIds).toEqual([f.originalHubId]);
      expect(refused.json.suggestion).toMatch(/stop/i);
      expect(existsSync(joinedFile(f.C))).toBe(false);

      // Agreeing branch: hub.json names a hub this machine's own records know.
      rewriteHubId(f.hub, f.originalHubId);
      const status = cli(f.C, ["hub", "status"], f.projC);
      expect(status.json.hubState).toBe("ok");
      // A read does not seed: hub status, whereis and the SessionStart hook
      // (which runs whereis) write nothing.
      expect(existsSync(joinedFile(f.C))).toBe(false);
      const where = cli(f.C, ["whereis", "--project-path", f.projC, "--source-config-dir", f.C.configDir], f.projC);
      expect(where.status, where.stdout).toBe(0);
      expect(where.json.hubState).toBe("ok");
      expect(existsSync(joinedFile(f.C))).toBe(false);
      const start = runCli(["hub", "hook-session-start"], {
        env: { ...homeEnv(f.C.home), CLAUDE_CONFIG_DIR: f.C.configDir },
        cwd: root,
        input: JSON.stringify({ session_id: "s", cwd: f.projC, hook_event_name: "SessionStart", source: "startup" }),
      });
      expect(start.status).toBe(0);
      expect(existsSync(joinedFile(f.C))).toBe(false);
      ok(cli(f.C, ["hub", "trust"], root), "C hub trust after seeding");
      const joined = JSON.parse(readFileSync(joinedFile(f.C), "utf-8"));
      expect(joined.hubs).toEqual([
        expect.objectContaining({ address: resolve(f.hub), hubId: f.originalHubId, origin: "seeded" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe("an evidence refusal is settled by an explicit first join", () => {
  it("refuses a hub this machine has no record of, and records it after hub init --path", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-evidence-")));
    try {
      const f = arrangeFleet(root);
      // An install that predates joined-hubs.json, pointed (by configure, not
      // by init) at a DIFFERENT hub it has never used.
      rmSync(joinedFile(f.C), { force: true });
      const other = join(root, "other-hub");
      const D = bareMachine(root, "D");
      ok(cli(D, ["hub", "init", "--path", other], root), "D creates another hub");
      ok(cli(f.C, ["configure", "--scope", "user", "--set", `hub.path=${other}`], root), "C switches hub.path");

      const refused = cli(f.C, ["hub", "trust"], root);
      expect(refused.status, refused.stdout).toBe(2);
      expect(refused.json.reason).toBe("hub-identity-changed");
      expect(refused.json.basis).toBe("evidence");
      expect(refused.json.suggestion).toMatch(/hub init --path/);
      // A first join is not a re-join: it carries no pin, and says so.
      expect(refused.json.suggestion).toMatch(/pinned afresh on first use/);
      expect(existsSync(joinedFile(f.C))).toBe(false);

      // The user did switch on purpose: an explicit first join records it
      // (trust-on-first-use, like a first pin) — no flag needed, because
      // nothing was recorded for this address to contradict.
      const joinedOther = ok(cli(f.C, ["hub", "init", "--path", other], root), "C joins other");
      expect(joinedOther.json.identity).toBe("recorded");
      expect(joinedOther.json.pinsCarried).toBeUndefined();
      expect(joinedOther.json.warnings.join(" ")).toMatch(/pinned afresh on first use/);
      const trusted = cli(f.C, ["hub", "trust"], root);
      expect(trusted.status, trusted.stdout).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});

describe("hub init on a directory holding hub content but no hub.json", () => {
  it("refuses with exit 3 and writes nothing; --accept-new-hub-id creates and records", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-guard-")));
    try {
      // What a second machine sees while the first sync is still in flight:
      // other machines' files have arrived and hub.json has not.
      const hub = join(root, "hub");
      mkdirSync(join(hub, "machines"), { recursive: true });
      writeFileSync(join(hub, "machines", "m-other.json"), JSON.stringify({ id: "m-other" }) + "\n");
      mkdirSync(join(hub, "projects", "p-other"), { recursive: true });
      writeFileSync(join(hub, "projects", "p-other", "project.json"), "{}\n");
      const B = bareMachine(root, "B");

      const r = cli(B, ["hub", "init", "--path", hub], root);
      expect(r.status, r.stdout).toBe(3);
      expect(r.json.success).toBe(false);
      expect(r.json.reason).toBe("hub-content-without-identity");
      expect(r.json.found).toEqual(["machines", "projects"]);
      expect(r.json.suggestion).toMatch(/sync/);
      expect(existsSync(join(hub, "hub.json"))).toBe(false);
      expect(readdirSync(join(hub, "machines"))).toEqual(["m-other.json"]);
      expect(existsSync(join(B.home, ".sesh-mover"))).toBe(false);

      const created = cli(B, ["hub", "init", "--path", hub, "--accept-new-hub-id"], root);
      expect(created.status, created.stdout).toBe(0);
      expect(created.json.created).toBe(true);
      expect(created.json.identity).toBe("recorded");
      expect(existsSync(join(hub, "hub.json"))).toBe(true);
      const joined = JSON.parse(readFileSync(joinedFile(B), "utf-8"));
      expect(joined.hubs).toEqual([
        expect.objectContaining({ address: resolve(hub), hubId: created.json.hubId, origin: "init" }),
      ]);

      // The other half of the advice: when the sync DOES deliver hub.json, the
      // same invocation, unchanged, joins the existing hub.
      const synced = join(root, "synced-hub");
      mkdirSync(join(synced, "machines"), { recursive: true });
      writeFileSync(join(synced, "machines", "m-other.json"), JSON.stringify({ id: "m-other" }) + "\n");
      const E = bareMachine(root, "E");
      const early = cli(E, ["hub", "init", "--path", synced], root);
      expect(early.status, early.stdout).toBe(3);
      writeFileSync(
        join(synced, "hub.json"),
        JSON.stringify({ schemaVersion: 1, hubId: "the-real-hub", createdAt: "2026-09-01T00:00:00.000Z", pluginVersion: "0.12.0", encrypt: true }) + "\n"
      );
      const late = cli(E, ["hub", "init", "--path", synced], root);
      expect(late.status, late.stdout).toBe(0);
      expect(late.json.created).toBe(false);
      expect(late.json.hubId).toBe("the-real-hub");
      // Joining never rewrote the sealed hub's policy.
      expect(JSON.parse(readFileSync(join(synced, "hub.json"), "utf-8")).encrypt).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("refuses to mint a new hub where this machine joined a different one (an unmounted mount point)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-unmounted-")));
    try {
      const hub = join(root, "hub");
      mkdirSync(hub);
      const B = bareMachine(root, "B");
      const first = ok(cli(B, ["hub", "init", "--path", hub], root), "B hub init");
      // The share is not mounted now: the mount point is an empty directory.
      rmSync(hub, { recursive: true, force: true });
      mkdirSync(hub);

      const r = cli(B, ["hub", "init", "--path", hub], root);
      // Class 3, not 2: mounting the share (or waiting for the sync) is the
      // remedy, and after it the SAME invocation joins.
      expect(r.status, r.stdout).toBe(3);
      expect(r.json.reason).toBe("hub-identity-not-present");
      expect(r.json.basis).toBe("recorded");
      expect(r.json.expectedHubIds).toEqual([first.json.hubId]);
      expect(r.json.hubPath).toBe(resolve(hub));
      expect(r.json.suggestion).toMatch(/not mounted/);
      expect(readdirSync(hub)).toEqual([]);

      // A mount point that is not even a directory any more (a macOS
      // /Volumes/<share> after unmount): the refusal must not create it.
      rmSync(hub, { recursive: true, force: true });
      const gone = cli(B, ["hub", "init", "--path", hub], root);
      expect(gone.status, gone.stdout).toBe(3);
      expect(gone.json.reason).toBe("hub-identity-not-present");
      expect(gone.json.suggestion).toMatch(/Nothing was created or written/);
      expect(existsSync(hub)).toBe(false);

      // The share comes back: the unchanged invocation joins the hub it was.
      mkdirSync(hub);
      writeFileSync(join(hub, "hub.json"), JSON.stringify({
        schemaVersion: 1, hubId: first.json.hubId, createdAt: "2026-09-01T00:00:00.000Z", pluginVersion: "0.12.0", encrypt: false,
      }) + "\n");
      const back = cli(B, ["hub", "init", "--path", hub], root);
      expect(back.status, back.stdout).toBe(0);
      expect(back.json.identity).toBe("unchanged");
      rmSync(hub, { recursive: true, force: true });
      mkdirSync(hub);

      // The hub really is gone and the user is replacing it on purpose.
      const replaced = cli(B, ["hub", "init", "--path", hub, "--accept-new-hub-id"], root);
      expect(replaced.status, replaced.stdout).toBe(0);
      expect(replaced.json.created).toBe(true);
      expect(replaced.json.identity).toBe("accepted-change");
      expect(replaced.json.previousHubId).toBe(first.json.hubId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
  it("refuses to mint where this machine's own projects tie the path to a hub, with no record there (an unmounted share after upgrade)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-unmounted-evidence-")));
    try {
      const hub = join(root, "hub");
      mkdirSync(hub);
      const A = machineWithFixture(root, "A");
      const projA = projectWithFixture(root, A, "projA");
      const first = ok(cli(A, ["hub", "init", "--path", hub], root), "A hub init");
      ok(
        cli(A, ["push", "--project-path", projA, "--create-project", "--no-workspace",
          "--source-config-dir", A.configDir], root),
        "A push"
      );
      const realId = first.json.hubId as string;
      // An install from before joined-hubs.json existed: projA's sync-state
      // ties this path to realId through the user-scope hub.path, and nothing
      // is recorded for it.
      rmSync(joinedFile(A), { force: true });
      const userConfig = join(A.home, ".sesh-mover", "config.json");
      const configBefore = readBytes(userConfig);

      // The share is unmounted and its mount point is gone.
      const mounted = join(root, "hub-mounted");
      renameSync(hub, mounted);
      const gone = cli(A, ["hub", "init", "--path", hub], root);
      expect(gone.status, gone.stdout).toBe(3);
      expect(gone.json.reason).toBe("hub-identity-not-present");
      expect(gone.json.basis).toBe("evidence");
      expect(gone.json.expectedHubIds).toEqual([realId]);
      expect(gone.json.hubPath).toBe(resolve(hub));
      expect(gone.json.suggestion).toContain(realId);
      expect(gone.json.suggestion).toMatch(/not mounted/);
      expect(gone.json.suggestion).toMatch(/Nothing was created or written/);
      expect(existsSync(hub)).toBe(false);
      expect(existsSync(joinedFile(A))).toBe(false);
      expect(readBytes(userConfig)).toBe(configBefore);

      // The mount point is back as an empty directory: the same refusal.
      mkdirSync(hub);
      const empty = cli(A, ["hub", "init", "--path", hub], root);
      expect(empty.status, empty.stdout).toBe(3);
      expect(empty.json.reason).toBe("hub-identity-not-present");
      expect(readdirSync(hub)).toEqual([]);

      // The share mounts: the unchanged command joins the hub it was.
      rmSync(hub, { recursive: true, force: true });
      renameSync(mounted, hub);
      const back = ok(cli(A, ["hub", "init", "--path", hub], root), "A joins once mounted");
      expect(back.json.created).toBe(false);
      expect(back.json.hubId).toBe(realId);
      expect(back.json.warnings).toEqual([]);

      // Unmounted again, still no record, and this time the old hub is being
      // replaced on purpose: the flag mints, and the result says the new id is
      // not the one this machine's own records tie to the path.
      rmSync(joinedFile(A), { force: true });
      renameSync(hub, mounted);
      mkdirSync(hub);
      const replaced = cli(A, ["hub", "init", "--path", hub, "--accept-new-hub-id"], root);
      expect(replaced.status, replaced.stdout).toBe(0);
      expect(replaced.json.created).toBe(true);
      expect(replaced.json.hubId).not.toBe(realId);
      expect(replaced.json.identity).toBe("recorded");
      const warned = (replaced.json.warnings as string[]).join(" ");
      expect(warned).toContain(realId);
      expect(warned).toMatch(/pinned afresh on first use/);

      // A path no project on this machine uses is not refused: a brand-new hub
      // still mints without a flag and without a warning.
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere);
      const fresh = cli(A, ["hub", "init", "--path", join(root, "fresh-hub"), "--scope", "project"], elsewhere);
      expect(fresh.status, fresh.stdout).toBe(0);
      expect(fresh.json.created).toBe(true);
      expect(fresh.json.warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it("refuses to mint where a project on the same unmounted share used the path for its hub — a missing project directory is undetermined, not 'no override'", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-joined-unmounted-project-")));
    try {
      // One network share holds both the hub and a project that uses it
      // through its OWN config (`hub init --scope project`); there is no
      // user-scope hub.path at all.
      const nas = join(root, "nas");
      const hub = join(nas, "hub");
      mkdirSync(hub, { recursive: true });
      const A = machineWithFixture(root, "A");
      const projP = projectWithFixture(root, A, join("nas", "projP"));
      const first = ok(cli(A, ["hub", "init", "--path", hub, "--scope", "project"], projP), "A hub init --scope project");
      ok(
        cli(A, ["push", "--project-path", projP, "--create-project", "--no-workspace",
          "--source-config-dir", A.configDir], projP),
        "A push"
      );
      const realId = first.json.hubId as string;
      expect(existsSync(join(A.home, ".sesh-mover", "config.json"))).toBe(false);
      // An install from before joined-hubs.json existed.
      rmSync(joinedFile(A), { force: true });

      // The share is unmounted, and its mount point is left behind empty.
      renameSync(nas, `${nas}-away`);
      mkdirSync(nas);
      const r = cli(A, ["hub", "init", "--path", hub], root);
      // Before: projP's config read ENOENT, so projP was taken to inherit the
      // user scope (no hub), the tie read as complete and EMPTY, and this
      // minted a new hub at the mount point with exit 0.
      expect(r.status, r.stdout).toBe(3);
      expect(r.json.reason).toBe("hub-identity-not-present");
      expect(r.json.basis).toBe("evidence");
      expect(r.json.expectedHubIds).toEqual([realId]);
      expect(existsSync(hub)).toBe(false);
      expect(readdirSync(nas)).toEqual([]);
      expect(existsSync(joinedFile(A))).toBe(false);
      // It names the project it could not resolve, and why, so the user knows
      // what to mount.
      expect(r.json.unresolvedProjects).toEqual([
        expect.objectContaining({ projectPath: projP, cause: "directory-missing" }),
      ]);
      expect(r.json.suggestion).toContain(projP);
      expect(r.json.suggestion).toMatch(/not mounted/);

      // A macOS /Volumes/<share> after unmount: the mount point is gone too,
      // and the refusal must not create it.
      rmSync(nas, { recursive: true, force: true });
      const gone = cli(A, ["hub", "init", "--path", hub], root);
      expect(gone.status, gone.stdout).toBe(3);
      expect(gone.json.reason).toBe("hub-identity-not-present");
      expect(gone.json.expectedHubIds).toEqual([realId]);
      expect(existsSync(nas)).toBe(false);

      // The share mounts: the same join records the hub it always was.
      renameSync(`${nas}-away`, nas);
      const back = ok(cli(A, ["hub", "init", "--path", hub, "--scope", "project"], projP), "A joins once mounted");
      expect(back.json.created).toBe(false);
      expect(back.json.hubId).toBe(realId);
      expect(back.json.warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
