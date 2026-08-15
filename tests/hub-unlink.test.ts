import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  lstatSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { hubUnlink } from "../src/hub/unlink.js";
import { hubInit } from "../src/hub/init.js";
import { acquireProjectLock } from "../src/hub/lock.js";
import { evaluateHookGate } from "../src/hub/hooks.js";
import { bundleDir, projectDir, projectJsonPath } from "../src/hub/layout.js";
import {
  ignoreFilePath,
  includeFilePath,
  projectJsonFilePath,
  projectSeshMoverDir,
} from "../src/paths.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write the hub link file this command exists to remove. */
function linkProject(projectPath: string, projectId = PROJECT_ID): string {
  const p = projectJsonFilePath(projectPath);
  writeFileSync(
    p,
    JSON.stringify(
      { projectId, name: "proj", createdAt: "2026-07-21T00:00:00Z", createdByMachine: "m1" },
      null,
      2
    ) + "\n"
  );
  return p;
}

/**
 * Copied rather than imported from hub-hooks.test.ts: a helper shared between
 * two suites turns an edit for one of them into a silent change to the other.
 */
function writeSeshMoverConfig(dir: string, hub: Record<string, unknown>): void {
  const configDir = join(dir, ".sesh-mover");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ hub }, null, 2) + "\n");
}

/** Every path under `root`, relative + POSIX-spelled, mapped to a content hash. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1
    )) {
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join("/");
      if (e.isDirectory()) {
        out[`${rel}/`] = "<dir>";
        walk(full);
      } else {
        out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

describe("hub unlink", () => {
  it("removes the link file and reports the id it named", () => {
    const home = tmp("sesh-unlink-home-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    try {
      const linkPath = linkProject(project);
      const r = hubUnlink({ projectPath: project });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.command).toBe("hub-unlink");
      expect(r.wasLinked).toBe(true);
      // The id is read BEFORE the delete precisely so it can be reported here:
      // it is unrecoverable afterwards and is what makes a re-link cheap.
      expect(r.projectId).toBe(PROJECT_ID);
      expect(r.removedPath).toBe(linkPath);
      expect(r.automationDisarmed).toBe(true);
      expect(existsSync(linkPath)).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("is an idempotent no-op when nothing is linked here", () => {
    // The "user making sure the automation is off" case. Reporting it as an
    // error would push that user toward doing something further, when the
    // requested state is already the state.
    const home = tmp("sesh-unlink-home-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    try {
      const r = hubUnlink({ projectPath: project });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.wasLinked).toBe(false);
      expect(r.projectId).toBeNull();
      expect(r.removedPath).toBeNull();
      expect(r.automationDisarmed).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("refuses when a DIRECTORY sits where the link file should be", () => {
    // Nothing this plugin writes creates a directory at that path, so this is
    // someone else's, and the removal it would take is recursive. The narrow
    // act this command promises is "remove one FILE" — a refusal is the only
    // answer that keeps the promise.
    const home = tmp("sesh-unlink-home-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    try {
      const p = projectJsonFilePath(project);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "something-of-the-users.txt"), "not ours\n");

      const r = hubUnlink({ projectPath: project });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.command).toBe("hub-unlink");
      expect("error" in r && r.error).toMatch(/directory/i);
      expect(existsSync(join(p, "something-of-the-users.txt"))).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("removes a DANGLING SYMLINK at the link path, which existsSync cannot see", () => {
    // The reason the check is `lstatSync` and not `existsSync`: a symlink whose
    // target is gone arms nothing (every reader follows it and finds nothing),
    // but it is still an entry sitting in the user's repository under a name
    // this plugin owns, and a later `pull --target-path` or a restored target
    // would make it live again. `readLocalProjectId` would call this "not
    // linked" and leave it there.
    const home = tmp("sesh-unlink-home-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    try {
      const p = projectJsonFilePath(project);
      symlinkSync(join(project, "gone.json"), p);
      expect(existsSync(p)).toBe(false); // follows the link: reads as absent
      expect(lstatSync(p).isSymbolicLink()).toBe(true); // ...but it is there

      const r = hubUnlink({ projectPath: project });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.wasLinked).toBe(true);
      expect(r.projectId).toBeNull(); // nothing to read an id out of
      expect(r.warnings.join(" ")).toMatch(/could not be read as a hub identity/i);
      expect(() => lstatSync(p)).toThrow(); // the symlink itself is gone
    } finally {
      restore.restore();
      for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("leaves the project directory and every sibling of the link untouched", () => {
    // The regression this pins: since 0.8.0 the link is a ROOT DOTFILE, so its
    // parent is the user's project directory rather than a plugin-owned
    // subdirectory. An `rmdir`-the-parent cleanup (see `rollbackLocalLink` in
    // push.ts) therefore deletes a project.
    const home = tmp("sesh-unlink-home-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    try {
      linkProject(project);
      const siblings: Record<string, string> = {
        [includeFilePath(project)]: "docs/**\n",
        [ignoreFilePath(project)]: "node_modules\n",
        [join(projectSeshMoverDir(project), "config.json")]: '{"hub":{}}\n',
        [join(project, "main.ts")]: "export const x = 1;\n",
      };
      mkdirSync(projectSeshMoverDir(project), { recursive: true });
      for (const [p, content] of Object.entries(siblings)) writeFileSync(p, content);

      const r = hubUnlink({ projectPath: project });
      expect(r.success).toBe(true);
      expect(existsSync(projectJsonFilePath(project))).toBe(false);
      expect(statSync(project).isDirectory()).toBe(true);
      for (const [p, content] of Object.entries(siblings)) {
        expect(existsSync(p)).toBe(true);
        expect(readFileSync(p, "utf-8")).toBe(content);
      }
      expect(statSync(projectSeshMoverDir(project)).isDirectory()).toBe(true);
    } finally {
      restore.restore();
      for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("leaves the project directory in place when the link was its only entry", () => {
    // Same regression from the other side: an empty parent is exactly what an
    // opportunistic `rmdirSync` succeeds at, so the directory-survives claim
    // has to be made where the cleanup would actually fire.
    const home = tmp("sesh-unlink-home-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    try {
      linkProject(project);
      expect(readdirSync(project)).toHaveLength(1);
      const r = hubUnlink({ projectPath: project });
      expect(r.success).toBe(true);
      expect(existsSync(project)).toBe(true);
      expect(statSync(project).isDirectory()).toBe(true);
      expect(readdirSync(project)).toHaveLength(0);
    } finally {
      restore.restore();
      for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("removes a link file it cannot parse, and says why no id was reported", () => {
    // `readLocalProjectId` returns null for both of these, so a gate check
    // reads them as "not linked" — but they are still files sitting in the
    // user's repository, and "nothing was linked here" would be the wrong
    // answer to give about a file this command is being asked to clear.
    for (const [label, content] of [
      ["not JSON", "{ not json"],
      ["JSON without a projectId", '{"name":"proj"}\n'],
    ] as const) {
      const home = tmp("sesh-unlink-home-");
      const project = tmp("sesh-unlink-proj-");
      const restore = overrideHome(home);
      try {
        const linkPath = projectJsonFilePath(project);
        writeFileSync(linkPath, content);
        const r = hubUnlink({ projectPath: project });
        expect(r.success, label).toBe(true);
        if (!r.success) return;
        expect(r.wasLinked, label).toBe(true);
        expect(r.projectId, label).toBeNull();
        expect(r.removedPath, label).toBe(linkPath);
        expect(existsSync(linkPath), label).toBe(false);
        expect(
          r.warnings.some((w) => /could not be read as a hub identity/i.test(w)),
          label
        ).toBe(true);
      } finally {
        restore.restore();
        for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("writes nothing whatsoever to the hub", async () => {
    // Unlink constructs no HubBackend at all — not "writes nothing today".
    // A byte-for-byte comparison of the whole hub tree is what keeps a future
    // edit from helpfully adding a hub-side write (a tombstone, an index
    // touch) without the design conversation that would need.
    const home = tmp("sesh-unlink-home-");
    const hub = tmp("sesh-unlink-hub-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    try {
      await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      mkdirSync(join(hub, projectDir(PROJECT_ID)), { recursive: true });
      writeFileSync(
        join(hub, projectJsonPath(PROJECT_ID)),
        JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID, name: "proj" }, null, 2) + "\n"
      );
      mkdirSync(join(hub, bundleDir(PROJECT_ID, "machine-a")), { recursive: true });
      writeFileSync(join(hub, bundleDir(PROJECT_ID, "machine-a"), "b1.tar.gz"), "not-a-real-bundle");
      linkProject(project);

      const before = snapshotTree(hub);
      const r = hubUnlink({ projectPath: project });
      expect(r.success).toBe(true);
      expect(snapshotTree(hub)).toEqual(before);
    } finally {
      restore.restore();
      for (const d of [home, hub, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("succeeds with no hub configured and no hub directory on disk", () => {
    // Making the DISARM path depend on the thing being disarmed is backwards:
    // an unmounted share (or a hub.path the user already cleared) is precisely
    // when someone reaches for this, and every other hub verb bails there with
    // "No hub configured".
    const home = tmp("sesh-unlink-home-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    try {
      const linkPath = linkProject(project);
      const r = hubUnlink({ projectPath: project });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.wasLinked).toBe(true);
      expect(existsSync(linkPath)).toBe(false);
    } finally {
      restore.restore();
      for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("closes the hook consent gate, with src/hub/hooks.ts unchanged", () => {
    // The end-to-end proof of the consent model: linking IS the gate, so
    // removing that one file is the whole of disarming. hooks.ts needed no
    // edit for `hub unlink` to exist, and this fails if that stops being true.
    const home = tmp("sesh-unlink-home-");
    const hub = tmp("sesh-unlink-hub-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    try {
      writeSeshMoverConfig(home, { path: hub });
      linkProject(project);
      expect(evaluateHookGate({ cwd: project }, "autoPush").ok).toBe(true);
      expect(evaluateHookGate({ cwd: project }, "startupNotice").ok).toBe(true);

      const r = hubUnlink({ projectPath: project });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.automationDisarmed).toBe(true);

      expect(evaluateHookGate({ cwd: project }, "autoPush")).toMatchObject({
        ok: false,
        reason: "unlinked",
      });
      expect(evaluateHookGate({ cwd: project }, "startupNotice")).toMatchObject({
        ok: false,
        reason: "unlinked",
      });
    } finally {
      restore.restore();
      for (const d of [home, hub, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("refuses while another hub operation holds the project lock, and names --force", () => {
    // A push mid-flight can re-create the link when it finishes, so the
    // default is to wait rather than race it. The refusal has to carry the way
    // out, because the wedged-push case is not rare here.
    const home = tmp("sesh-unlink-home-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    let held: { release(): void } | null = null;
    try {
      const linkPath = linkProject(project);
      held = acquireProjectLock(project);
      const r = hubUnlink({ projectPath: project });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.command).toBe("hub-unlink");
      // Structured like push's and pull's refusal, so a caller can tell "wait
      // and retry" from "this failed" without reading the prose — and here
      // that branch carries a second remedy a generic error branch would never
      // offer.
      expect("reason" in r && r.reason).toBe("lock-busy");
      expect("holderPid" in r && r.holderPid).toBe(process.pid);
      expect("ageSeconds" in r && typeof r.ageSeconds).toBe("number");
      expect(r.error).toMatch(/lock/i);
      expect(r.suggestion).toMatch(/--force/);
      // A refusal means nothing happened: the link is still there and this
      // project is still armed.
      expect(existsSync(linkPath)).toBe(true);
    } finally {
      held?.release();
      restore.restore();
      for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("--force unlinks past a held lock and discloses what that gave up", () => {
    // Disarming must not be blocked by the thing being disarmed — a push
    // wedged on an unreachable share holds the lock for LOCK_STALE_MS. The
    // warning is the price: that push could still write the link back.
    const home = tmp("sesh-unlink-home-");
    const project = tmp("sesh-unlink-proj-");
    const restore = overrideHome(home);
    let held: { release(): void } | null = null;
    try {
      const linkPath = linkProject(project);
      held = acquireProjectLock(project);
      const r = hubUnlink({ projectPath: project, force: true });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.wasLinked).toBe(true);
      expect(existsSync(linkPath)).toBe(false);
      expect(r.warnings.some((w) => /lock was skipped/i.test(w))).toBe(true);
    } finally {
      held?.release();
      restore.restore();
      for (const d of [home, project]) rmSync(d, { recursive: true, force: true });
    }
  });
});
