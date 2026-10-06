/**
 * The seed's evidence read is BOUNDED, and a read it cannot finish makes the
 * decision stricter, never looser.
 *
 * `joined-hubs.ts` ties a hub id to an address through each project's own
 * `hub.path`, which means opening `<project>/.sesh-mover/config.json` for every
 * project this machine holds hub data for. Those directories are anywhere —
 * including on a network mount — and the read runs inside push's project lock
 * and on the unattended SessionEnd auto-push. Read synchronously, one project
 * on a hung mount wedged an UNRELATED project's push: the failure class #71
 * fixed for hub I/O, re-opened through the back door.
 *
 * So each config read is raced against the same per-syscall bound as every hub
 * syscall (`withHubIoTimeout`), and a read that times out or fails leaves the
 * tie INCOMPLETE — the decision then falls to the union of every hub id this
 * machine knows. The union is a superset of any tie, and the seed takes only a
 * set of exactly one id, so an incomplete tie can only refuse more. An ABSENT
 * config is "no override" only inside a project directory that is there: a
 * missing directory (an unmounted share, a deleted project) is incomplete too.
 *
 * A FIFO stands in for the hung mount, exactly as in tests/hub-lock-orphan.test.ts:
 * `open(…, O_RDONLY)` on one blocks in the kernel until a writer appears, and
 * nothing in userspace can cancel it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overrideHome, homeEnv, type HomeOverrideHandle } from "./helpers/env.js";
import { cliPath, runCli } from "./helpers/run-cli.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { encodeProjectPath } from "../src/platform.js";
import { checkJoinedHubIdentity, joinedHubsFilePath, localHubIdEvidence, readJoinedHubs } from "../src/hub/joined-hubs.js";
import { setConfigOverride, writeConfigOverrides } from "../src/config.js";
import { userSeshMoverDir } from "../src/paths.js";
import { findPin, readPins, recordPin } from "../src/hub/pins.js";
import { hubInit } from "../src/hub/init.js";

const NOW = "2026-09-30T00:00:00.000Z";
const isWindows = process.platform === "win32";

const canMkfifo = ((): boolean => {
  if (isWindows) return false;
  const probe = mkdtempSync(join(tmpdir(), "sesh-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(probe, "f")], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/**
 * Hand every reader blocked on `fifo` an EOF. Non-blocking, so it cannot hang
 * the runner when nobody is waiting (ENXIO → false).
 */
function unblockFifo(fifo: string): boolean {
  let fd: number;
  try {
    fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  closeSync(fd);
  return true;
}

/** A sync-state file naming `hubId` for `projectPath`, as a hub push or pull writes one. */
function writeSyncState(home: string, projectPath: string, hubId: string): void {
  const dir = join(home, ".sesh-mover", "sync-state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${encodeProjectPath(projectPath)}.json`),
    JSON.stringify({
      projectPath, schemaVersion: 2, peers: {}, lineage: {}, imported: {},
      hub: { hubId, threadByLocalSession: {} },
    })
  );
}

/** `<project>/.sesh-mover/config.json` as a FIFO: the read never returns on its own. */
function hangingProjectConfig(projectPath: string): string {
  mkdirSync(join(projectPath, ".sesh-mover"), { recursive: true });
  const fifo = join(projectPath, ".sesh-mover", "config.json");
  execFileSync("mkfifo", [fifo]);
  return fifo;
}

describe("the seed's evidence read, in-process", () => {
  let home: string;
  let restore: HomeOverrideHandle;
  let savedBound: string | undefined;
  const fifos: string[] = [];

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "sm-evidence-bound-")));
    restore = overrideHome(home);
    savedBound = process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS;
  });
  afterEach(() => {
    // Release any pool thread still parked on a FIFO before the tree goes.
    for (const f of fifos.splice(0)) unblockFifo(f);
    if (savedBound === undefined) delete process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS;
    else process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS = savedBound;
    restore.restore();
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * Two projects: `projA` inherits the user-scope hub.path (this hub) and
   * recorded `id-a`; `projH` recorded `id-h`, and its config is whatever the
   * row makes it. With `projH` readable and pointed elsewhere, the tie for this
   * hub is exactly `{id-a}` and `id-a` seeds — the control every row departs from.
   */
  function arrange(): { hub: string; projA: string; projH: string } {
    const hub = join(home, "hub");
    const projA = join(home, "projA");
    const projH = join(home, "projH");
    writeConfigOverrides(userSeshMoverDir(), setConfigOverride({}, "hub.path", hub));
    // projA's directory is there with no config of its own: "no override".
    mkdirSync(projA, { recursive: true });
    writeSyncState(home, projA, "id-a");
    writeSyncState(home, projH, "id-h");
    return { hub, projA, projH };
  }

  it("control — every config readable: the tie decides, and id-a seeds", async () => {
    const { hub, projH } = arrange();
    writeConfigOverrides(join(projH, ".sesh-mover"), setConfigOverride({}, "hub.path", join(home, "other-hub")));
    const evidence = await localHubIdEvidence(hub, { readTie: "always" });
    expect(evidence).toEqual({ known: ["id-a", "id-h"], here: ["id-a"], tie: "complete", unresolved: [] });
    expect(await checkJoinedHubIdentity({ hubPath: hub, hubId: "id-a", seed: true, nowIso: NOW })).toMatchObject({
      kind: "match",
    });
    expect(readJoinedHubs().hubs).toEqual([expect.objectContaining({ hubId: "id-a", origin: "seeded" })]);
  });

  it.skipIf(!canMkfifo)(
    "a project config that hangs is abandoned at the bound, and the union decides — refused, not hung",
    async () => {
      const { hub, projH } = arrange();
      fifos.push(hangingProjectConfig(projH));
      process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS = "300";

      const t0 = Date.now();
      const evidence = await localHubIdEvidence(hub, { readTie: "always" });
      expect(evidence.tie).toBe("incomplete");
      expect(evidence.known).toEqual(["id-a", "id-h"]);

      const check = await checkJoinedHubIdentity({ hubPath: hub, hubId: "id-a", seed: true, nowIso: NOW });
      const elapsed = Date.now() - t0;
      // Two bounded reads, one per call — nowhere near a hang, and nowhere near
      // an aggregate budget either.
      expect(elapsed).toBeLessThan(5_000);
      expect(check).toMatchObject({
        kind: "changed",
        change: { currentHubId: "id-a", expectedHubIds: ["id-a", "id-h"], basis: "evidence" },
      });
      // Nothing was seeded while the tie could not be completed.
      expect(existsSync(joinedHubsFilePath())).toBe(false);
    },
    15_000
  );

  it("a project config that fails to read (not a hang) forces the union too — and so does a missing project directory", async () => {
    const { hub, projH } = arrange();
    // A directory where the file should be: EISDIR, on every platform.
    mkdirSync(join(projH, ".sesh-mover", "config.json"), { recursive: true });
    expect((await localHubIdEvidence(hub, { readTie: "always" })).tie).toBe("incomplete");
    expect(await checkJoinedHubIdentity({ hubPath: hub, hubId: "id-a", seed: true, nowIso: NOW })).toMatchObject({
      kind: "changed",
      change: { expectedHubIds: ["id-a", "id-h"] },
    });

    // So does one that reads but does not parse — a verb run there would fall
    // back to the user scope, but a torn write is not a fact to tie ids with.
    rmSync(join(projH, ".sesh-mover", "config.json"), { recursive: true });
    writeFileSync(join(projH, ".sesh-mover", "config.json"), '{ "hub": { "path": ');
    expect((await localHubIdEvidence(hub, { readTie: "always" })).tie).toBe("incomplete");

    // A project directory that is THERE with no config file is not a
    // failure: it has no override, so it inherits the user scope exactly as a
    // verb run there would.
    rmSync(join(projH, ".sesh-mover"), { recursive: true, force: true });
    expect(await localHubIdEvidence(hub, { readTie: "always" })).toEqual({
      known: ["id-a", "id-h"], here: ["id-a", "id-h"], tie: "complete", unresolved: [],
    });

    // A project directory that is NOT there is a failure: its own hub.path
    // is unseen, not absent — an unmounted share, or a deleted project — and
    // attributing it to the user scope would decide on the part that was
    // visible. (This row read "complete" until the directory was checked.)
    rmSync(projH, { recursive: true, force: true });
    expect(await localHubIdEvidence(hub, { readTie: "always" })).toMatchObject({
      known: ["id-a", "id-h"], tie: "incomplete", unresolved: [expect.objectContaining({ projectPath: projH, cause: "directory-missing" })],
    });
  });

  it.skipIf(!canMkfifo)(
    "the seed opens no project config at all when the union cannot be split — a single-hub machine's seed never waits",
    async () => {
      // Every id this machine knows is id-a. Whatever the tie says, the rule's
      // answer is the same, so it is not read — with the SHIPPED 30s bound in
      // force, which is what makes a read observable here as a stall.
      const { hub, projH } = arrange();
      writeSyncState(home, projH, "id-a");
      fifos.push(hangingProjectConfig(projH));
      delete process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS;

      const t0 = Date.now();
      expect(await localHubIdEvidence(hub, { readTie: "when-it-can-decide" })).toEqual({
        known: ["id-a"], here: [], tie: "not-read", unresolved: [],
      });
      expect(await checkJoinedHubIdentity({ hubPath: hub, hubId: "id-a", seed: true, nowIso: NOW })).toMatchObject({
        kind: "match",
      });
      expect(Date.now() - t0).toBeLessThan(5_000);
      // Nobody was left waiting on the FIFO.
      expect(unblockFifo(fifos[0])).toBe(false);
    },
    10_000
  );
});

describe.skipIf(!canMkfifo)("the seed's evidence read, through the shipped CLI", () => {
  const FIXTURE_ENCODED = "-Users-testuser-Projects-testproject";
  let root: string;
  const fifos: string[] = [];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sm-evidence-bound-cli-")));
  });
  afterEach(() => {
    for (const f of fifos.splice(0)) unblockFifo(f);
    rmSync(root, { recursive: true, force: true });
  });

  it("a push of one project, while an UNRELATED project's config hangs, returns — refused on the union, lock released", () => {
    const home = join(root, "home");
    const hub = join(root, "hub");
    mkdirSync(join(home, ".sesh-mover"), { recursive: true });
    mkdirSync(hub, { recursive: true });
    writeFileSync(
      join(hub, "hub.json"),
      JSON.stringify({ schemaVersion: 1, hubId: "id-a", createdAt: NOW, pluginVersion: "0.12.0", encrypt: false }) + "\n"
    );
    writeFileSync(join(home, ".sesh-mover", "config.json"), JSON.stringify({ hub: { path: hub } }) + "\n");

    const { configDir } = createFixtureTree(join(root, "fixture"));
    const projA = join(root, "projA");
    mkdirSync(projA, { recursive: true });
    cpSync(
      join(configDir, "projects", FIXTURE_ENCODED),
      join(configDir, "projects", encodeProjectPath(projA)),
      { recursive: true }
    );
    writeSyncState(home, projA, "id-a");
    // The unrelated project, on a mount that has stopped answering.
    const projH = join(root, "mnt", "projH");
    writeSyncState(home, projH, "id-h");
    fifos.push(hangingProjectConfig(projH));

    const r = spawnSync(
      "node",
      [cliPath(), "push", "--project-path", projA, "--create-project", "--no-workspace", "--source-config-dir", configDir],
      {
        encoding: "utf-8",
        env: { ...process.env, ...homeEnv(home), CLAUDE_CONFIG_DIR: configDir, SESH_MOVER_HUB_IO_TIMEOUT_MS: "1000" },
        cwd: root,
        // The backstop, not the expectation: a push that hangs is killed here
        // and the assertions below then fail on it.
        timeout: 30_000,
      }
    );
    expect(r.error, "the push did not return on its own").toBeUndefined();
    // It abandoned a read, so `cli.ts` leaves by signal once the result is
    // flushed (see io-timeout.ts's fact 3) — or with the refusal's own code.
    expect(r.signal === "SIGKILL" || r.status === 2, `status=${r.status} signal=${r.signal} ${r.stderr}`).toBe(true);
    const json = JSON.parse(r.stdout);
    expect(json).toMatchObject({
      success: false,
      command: "push",
      reason: "hub-identity-changed",
      basis: "evidence",
      currentHubId: "id-a",
      expectedHubIds: ["id-a", "id-h"],
    });
    // Nothing seeded, and the project lock was released on the way out.
    expect(existsSync(join(home, ".sesh-mover", "joined-hubs.json"))).toBe(false);
    expect(existsSync(join(home, ".sesh-mover", "locks", `${encodeProjectPath(projA)}.lock`))).toBe(false);

    // The control, through the same binary: with the unrelated project's
    // config readable (and pointed at another hub), the same push is not
    // refused by the evidence check — the tie is {id-a}, and id-a seeds.
    rmSync(fifos[0]);
    writeFileSync(fifos[0], JSON.stringify({ hub: { path: join(root, "other-hub") } }) + "\n");
    const control = runCli(
      ["push", "--project-path", projA, "--create-project", "--no-workspace", "--source-config-dir", configDir],
      { env: { ...homeEnv(home), CLAUDE_CONFIG_DIR: configDir }, cwd: root }
    );
    expect(control.status, control.stdout).toBe(0);
    expect(JSON.parse(control.stdout).success).toBe(true);
  }, 120_000);
});

/**
 * A project on an unmounted share is UNDETERMINED, not "no override".
 *
 * Reading a project's config and getting ENOENT used to mean "this project has
 * no override, so it inherits the user scope". That is only true when the
 * project DIRECTORY is there. When the directory itself is missing — an
 * unmounted network share with its empty mount point left behind, a macOS
 * `/Volumes/<share>` that is gone, a deleted project — the project's own
 * `hub.path` is simply unseen, and attributing it to the user scope let the
 * tie read as complete on the part that was visible: a failed read that made
 * the decision LOOSER, which rule 4 forbids. The init half of the same shape
 * is in tests/hub-joined-identity.test.ts, through the shipped CLI.
 */
describe("a project whose directory is missing leaves the tie undetermined — the seed", () => {
  let root: string;
  let home: string;
  let restore: HomeOverrideHandle;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sm-evidence-unmounted-")));
    home = join(root, "home");
    mkdirSync(home);
    restore = overrideHome(home);
  });
  afterEach(() => {
    restore.restore();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Hub Q, and no user-scope hub.path. Project R's own config points at Q, and
   * its sync-state names `stale-s` — it moved to Q from another hub, and a
   * sync-state keeps the id it was first stamped with. Project P lives on a
   * network share at `<root>/nas`; its own config points at Q too, and its
   * sync-state names `real-q`, the id Q really has. This machine holds a
   * CONFIRMED pin under `real-q` — the thing a wrong seed would orphan.
   */
  function arrange(): { q: string; nas: string; p: string } {
    const q = join(root, "hub-q");
    const r = join(root, "projR");
    const nas = join(root, "nas");
    const p = join(nas, "projP");
    writeConfigOverrides(join(r, ".sesh-mover"), setConfigOverride({}, "hub.path", q));
    writeConfigOverrides(join(p, ".sesh-mover"), setConfigOverride({}, "hub.path", q));
    writeSyncState(home, r, "stale-s");
    writeSyncState(home, p, "real-q");
    recordPin({ hubId: "real-q", machineId: "m-peer", publicKey: "k-peer", origin: "confirmed", nowIso: NOW });
    return { q, nas, p };
  }

  it("the stale id does not seed while P's share is unmounted — with the empty mount point left, and with it gone", async () => {
    const { q, nas, p } = arrange();

    // Control, mounted: Q is tied to both ids, so a hub.json naming the stale
    // one is refused.
    expect(await localHubIdEvidence(q, { readTie: "always" })).toMatchObject({
      here: ["real-q", "stale-s"], tie: "complete",
    });
    expect(await checkJoinedHubIdentity({ hubPath: q, hubId: "stale-s", seed: true, nowIso: NOW })).toMatchObject({
      kind: "changed", change: { expectedHubIds: ["real-q", "stale-s"], evidenceSource: "tied" },
    });

    for (const shape of ["the empty mount point is left behind", "the mount point is gone too"] as const) {
      renameSync(nas, `${nas}-away`);
      if (shape === "the empty mount point is left behind") mkdirSync(nas);

      // The only record naming real-q for Q is P's, and P cannot be read. Were
      // P attributed to the user scope (which names no hub), Q would be tied
      // to stale-s alone and hub.json = stale-s would seed.
      const check = await checkJoinedHubIdentity({ hubPath: q, hubId: "stale-s", seed: true, nowIso: NOW });
      expect(check, shape).toMatchObject({
        kind: "changed",
        change: {
          currentHubId: "stale-s", expectedHubIds: ["real-q", "stale-s"], basis: "evidence",
          evidenceSource: "undetermined",
        },
      });
      expect(existsSync(joinedHubsFilePath()), shape).toBe(false);
      expect(findPin(readPins(), "real-q", "m-peer"), shape).toMatchObject({ origin: "confirmed" });

      // And the project that could not be resolved is named, with why.
      const evidence = await localHubIdEvidence(q, { readTie: "always" });
      expect(evidence.tie, shape).toBe("incomplete");
      expect(evidence.unresolved, shape).toEqual([
        { projectPath: p, syncStateFile: join(home, ".sesh-mover", "sync-state", `${encodeProjectPath(p)}.json`), cause: "directory-missing" },
      ]);

      rmSync(nas, { recursive: true, force: true });
      renameSync(`${nas}-away`, nas);
    }

    // A project directory that IS there with no config file still means "no
    // override": P mounted, its config removed, it inherits the user scope
    // (no hub), and Q is tied to stale-s alone — the tie is complete.
    rmSync(join(p, ".sesh-mover"), { recursive: true, force: true });
    expect(await localHubIdEvidence(q, { readTie: "always" })).toEqual({
      known: ["real-q", "stale-s"], here: ["stale-s"], tie: "complete", unresolved: [],
    });
  });
});

/**
 * Rule 4, arm by arm: every way a project's `hub.path` can fail to be settled
 * forces the union — on the SEED side (`checkJoinedHubIdentity`) and on the
 * INIT side (`hubInit` at a path nothing resolvable uses) — and loosening any
 * one arm changes an outcome here.
 *
 * The fixture is built so that it does. There is NO user-scope hub.path, so a
 * project attributed to "no override" ties nothing; `projA`'s own config points
 * at `hub` and it recorded `id-a`; `projH` recorded `id-h` and is shaped by
 * the arm. Settled either way, `projH` could not tie `hub`, so:
 *
 * - the SEED of `id-a` at `hub` succeeds exactly when `projH` is (wrongly)
 *   settled, and refuses on the union `{id-a, id-h}` when it is not;
 * - `hub init` at `fresh-hub` — which no settled project uses — mints exactly
 *   when `projH` is (wrongly) settled, and refuses on the union when it is not.
 *
 * An arm that answered `no-hub` (or "no override") instead of `unresolved`
 * therefore seeds, and mints: both halves fail. The control row is the
 * fixture with `projH` settled for real, which proves the fixture is not
 * refusing for some reason of its own.
 */
describe("every read that cannot settle a project's hub.path forces the union — seed side and init side", () => {
  let home: string;
  let restore: HomeOverrideHandle;
  let savedBound: string | undefined;
  const fifos: string[] = [];

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "sm-evidence-arms-")));
    restore = overrideHome(home);
    savedBound = process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS;
    process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS = "300";
  });
  afterEach(() => {
    for (const f of fifos.splice(0)) unblockFifo(f);
    if (savedBound === undefined) delete process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS;
    else process.env.SESH_MOVER_HUB_IO_TIMEOUT_MS = savedBound;
    restore.restore();
    rmSync(home, { recursive: true, force: true });
  });

  const syncStateDir = (): string => join(home, ".sesh-mover", "sync-state");

  /** `projA` ties `hub` to id-a through its own config; `projH` (at `projH`, or named by no path) recorded id-h. */
  function arrange(projH: string | null): { hub: string; fresh: string; projHSyncState: string } {
    const hub = join(home, "hub");
    const projA = join(home, "projA");
    writeConfigOverrides(join(projA, ".sesh-mover"), setConfigOverride({}, "hub.path", hub));
    writeSyncState(home, projA, "id-a");
    let projHSyncState: string;
    if (projH === null) {
      mkdirSync(syncStateDir(), { recursive: true });
      projHSyncState = join(syncStateDir(), "-no-project-path.json");
      writeFileSync(
        projHSyncState,
        JSON.stringify({ schemaVersion: 2, peers: {}, lineage: {}, imported: {}, hub: { hubId: "id-h", threadByLocalSession: {} } })
      );
    } else {
      writeSyncState(home, projH, "id-h");
      projHSyncState = join(syncStateDir(), `${encodeProjectPath(projH)}.json`);
    }
    return { hub, fresh: join(home, "fresh-hub"), projHSyncState };
  }

  const projConfig = (proj: string): string => join(proj, ".sesh-mover", "config.json");
  const writeProjConfig = (proj: string, text: string): void => {
    mkdirSync(join(proj, ".sesh-mover"), { recursive: true });
    writeFileSync(projConfig(proj), text);
  };

  interface Arm {
    name: string;
    /** Where projH's sync-state says it lives; `null` for a sync-state that names none. */
    projectPath: (home: string) => string | null;
    /** Make projH's config unsettleable in this arm's way. */
    shape: (projH: string | null) => void;
    cause: string;
    fifo?: true;
  }

  const ARMS: Arm[] = [
    {
      name: "the project directory is not there (an unmounted share with no mount point, or a deleted project)",
      projectPath: (h) => join(h, "nas", "projH"),
      shape: () => {},
      cause: "directory-missing",
    },
    {
      name: "the project directory is not there, and its empty mount point is (an unmounted share)",
      projectPath: (h) => join(h, "nas", "projH"),
      shape: () => mkdirSync(join(home, "nas")),
      cause: "directory-missing",
    },
    {
      name: "a component of the project path is a file (ENOTDIR from both the read and the stat)",
      projectPath: (h) => join(h, "a-file", "projH"),
      shape: () => writeFileSync(join(home, "a-file"), "not a directory\n"),
      cause: "directory-missing",
    },
    {
      name: "the project path is a regular file, not a directory",
      projectPath: (h) => join(h, "projH"),
      shape: (p) => writeFileSync(p!, "not a directory\n"),
      cause: "directory-missing",
    },
    {
      name: "the config cannot be read (a directory where the file should be: EISDIR)",
      projectPath: (h) => join(h, "projH"),
      shape: (p) => mkdirSync(projConfig(p!), { recursive: true }),
      cause: "unreadable",
    },
    {
      name: "the config does not answer within the bound (a FIFO standing in for a hung mount)",
      projectPath: (h) => join(h, "projH"),
      shape: (p) => fifos.push(hangingProjectConfig(p!)),
      cause: "timed-out",
      fifo: true,
    },
    {
      name: "the config does not parse (a torn write)",
      projectPath: (h) => join(h, "projH"),
      shape: (p) => writeProjConfig(p!, '{ "hub": { "path": '),
      cause: "unparseable",
    },
    {
      name: "the config parses to something that is not an object",
      projectPath: (h) => join(h, "projH"),
      shape: (p) => writeProjConfig(p!, "42\n"),
      cause: "unparseable",
    },
    {
      name: "the config's hub.path is not a string",
      projectPath: (h) => join(h, "projH"),
      shape: (p) => writeProjConfig(p!, JSON.stringify({ hub: { path: 42 } })),
      cause: "hub-path-unusable",
    },
    {
      name: "the config's hub.path is relative (each verb resolves it against its own working directory)",
      projectPath: (h) => join(h, "projH"),
      shape: (p) => writeProjConfig(p!, JSON.stringify({ hub: { path: "relative/hub" } })),
      cause: "hub-path-unusable",
    },
    {
      name: "the sync-state names no project directory at all",
      projectPath: () => null,
      shape: () => {},
      cause: "no-project-path",
    },
  ];

  it("control — projH settled for real (its directory is there, with no config): id-a seeds, and nothing ties fresh-hub", async () => {
    const projH = join(home, "projH");
    const { hub, fresh } = arrange(projH);
    mkdirSync(projH);
    expect(await localHubIdEvidence(fresh, { readTie: "always" })).toEqual({
      known: ["id-a", "id-h"], here: [], tie: "complete", unresolved: [],
    });
    expect(await checkJoinedHubIdentity({ hubPath: hub, hubId: "id-a", seed: true, nowIso: NOW })).toMatchObject({
      kind: "match",
    });
  });

  it("hub init names EVERY project that answered unresolved, in its result and its suggestion; the seed stops at the first", async () => {
    const gone = join(home, "nas", "projH");
    const { hub, fresh } = arrange(gone);
    const torn = join(home, "projK");
    writeSyncState(home, torn, "id-k");
    writeProjConfig(torn, '{ "hub": ');

    // The seed's answer is the union from the first failure on, so it reads
    // no further.
    const seedEvidence = await localHubIdEvidence(hub, { readTie: "when-it-can-decide" });
    expect(seedEvidence.tie).toBe("incomplete");
    expect(seedEvidence.unresolved).toHaveLength(1);

    const init = await hubInit({ hubPath: fresh, configScope: "user", cwd: home });
    expect(init).toMatchObject({
      success: false, reason: "hub-identity-not-present", basis: "evidence", expectedHubIds: ["id-a", "id-h", "id-k"],
    });
    if (!("unresolvedProjects" in init) || init.unresolvedProjects === undefined) throw new Error(JSON.stringify(init));
    expect(init.unresolvedProjects.map((u) => `${u.projectPath} ${u.cause}`).sort()).toEqual(
      [`${gone} directory-missing`, `${torn} unparseable`].sort()
    );
    expect(init.suggestion).toContain(gone);
    expect(init.suggestion).toContain(torn);
    expect(init.error).toMatch(/hub configuration of 2 projects could not be settled/);
    expect(existsSync(fresh)).toBe(false);
  });

  it.skipIf(!canMkfifo)(
    "hub init stops at the first project that does not answer, rather than park a thread on every dead one",
    async () => {
      const projH = join(home, "projH");
      const { fresh } = arrange(projH);
      fifos.push(hangingProjectConfig(projH));
      const projK = join(home, "projK");
      writeSyncState(home, projK, "id-k");
      fifos.push(hangingProjectConfig(projK));

      const init = await hubInit({ hubPath: fresh, configScope: "user", cwd: home });
      expect(init).toMatchObject({ success: false, reason: "hub-identity-not-present", basis: "evidence" });
      if (!("unresolvedProjects" in init) || init.unresolvedProjects === undefined) throw new Error(JSON.stringify(init));
      // Exactly one of the two hung configs was waited on; the other was not
      // opened at all, and the suggestion says the check stopped there.
      expect(init.unresolvedProjects).toHaveLength(1);
      expect(init.unresolvedProjects[0].cause).toBe("timed-out");
      expect(init.suggestion).toMatch(/stopped at the one that did not answer/);
      expect(existsSync(fresh)).toBe(false);
    },
    15_000
  );

  for (const arm of ARMS) {
    describe(arm.name, () => {
      it.skipIf(arm.fifo === true && !canMkfifo)("seed: the union decides, so id-a is refused and nothing is recorded", async () => {
        const projH = arm.projectPath(home);
        const { hub } = arrange(projH);
        arm.shape(projH);
        // id-a is tied to `hub` by projA alone once projH is set aside, so a
        // looser arm SEEDS it here.
        const seed = await checkJoinedHubIdentity({ hubPath: hub, hubId: "id-a", seed: true, nowIso: NOW });
        expect(seed).toMatchObject({
          kind: "changed",
          change: {
            currentHubId: "id-a", expectedHubIds: ["id-a", "id-h"], basis: "evidence", evidenceSource: "undetermined",
          },
        });
        expect(existsSync(joinedHubsFilePath())).toBe(false);
      }, 15_000);

      it.skipIf(arm.fifo === true && !canMkfifo)("init: refuses at a path nothing settled uses, creates nothing, and names the project", async () => {
        const projH = arm.projectPath(home);
        const { fresh, projHSyncState } = arrange(projH);
        arm.shape(projH);
        // Nothing settled uses fresh-hub, so a looser arm MINTS here.
        const init = await hubInit({ hubPath: fresh, configScope: "user", cwd: home });
        expect(init).toMatchObject({
          success: false, reason: "hub-identity-not-present", basis: "evidence", expectedHubIds: ["id-a", "id-h"],
        });
        expect(existsSync(fresh)).toBe(false);
        expect(existsSync(joinedHubsFilePath())).toBe(false);
        // Named, with why — so the user knows what to mount or fix.
        expect(init).toMatchObject({
          unresolvedProjects: [{ projectPath: projH, syncStateFile: projHSyncState, cause: arm.cause }],
        });
      }, 15_000);
    });
  }
});
