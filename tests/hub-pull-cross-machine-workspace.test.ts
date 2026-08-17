import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { overrideHome } from "./helpers/env.js";
import { createFixtureTree } from "./fixtures/create-fixtures.js";
import { createRealProject, entry, idx } from "./helpers/hub-fixtures.js";
import { hubInit } from "../src/hub/init.js";
import { hubPull } from "../src/hub/pull.js";
import { createFsBackend, type HubBackend } from "../src/hub/backend.js";
import { writeMachineIndex } from "../src/hub/index-file.js";
import { writeLocalProjectId } from "../src/hub/identity.js";
import {
  bundleDir, bundleFileName, machinePath, type HubBundleRecord,
} from "../src/hub/layout.js";
import { createArchive } from "../src/archiver.js";
import { computeIntegrityHashFromFile, writeManifest } from "../src/manifest.js";
import { readSyncState, setLastWorkspace, writeSyncState } from "../src/sync-state.js";
import type { ExportManifest, HubPullResult } from "../src/types.js";

/**
 * Cross-machine chain assembly (#35) meets the merge-ancestor rule (Slice 2).
 *
 * THE POPULATION THIS CAN REACH is exactly "projects with no git remote".
 * `hub/push.ts` writes a workspace payload only under `scanGitRemotes().kind
 * === "none"` and a carry only under `"remotes"`, with `"unknown"` taking
 * neither — so a project with a remote never ships the payload whose ancestor
 * is chosen here. `kind: "none"` covers both a directory with no `.git` marker
 * at all and a repository with zero configured remotes.
 *
 * WHAT #35 CHANGED UNDER THIS RULE. Before it, a pull's `needed` was ONE
 * machine's bundle list, so every `manifest.workspace.basedOn` collected while
 * walking it came out of that one machine's own monotonic generation history.
 * "The newest declared base anywhere in the chain that we also hold" was then
 * the same thing as "a generation the machine whose payload we are applying
 * genuinely descended from", and `chooseMergeAncestor` could take the minimum
 * index in our newest-first generation list without attributing anything.
 *
 * `planThreadPull` now assembles `needed` ACROSS machines and orders it by
 * session-continuation links (`anchorEntryUuid` -> `headEntryUuid`), never by
 * workspace generation and never by a clock. Two machines have independent
 * generation histories, so an EARLIER bundle in that assembled order can
 * declare a base that is NEWER in our own list than the base declared by the
 * LATER bundle whose workspace payload is the one actually merged.
 *
 * That is not a cosmetic mis-selection. Merging B's tree against an ancestor
 * B never held means every file where our tree equals that ancestor and B's
 * differs is classified `taken` by `mergeWorkspaceTrees` — an atomic overwrite
 * with no sidecar and no backup. It is the measured silent revert the
 * intersection rule was written to eliminate, and it breaks the "fallback goes
 * strictly older" direction, because an older base fails toward "keep local +
 * visible conflicts" while a newer one fails toward silently overwriting work.
 */
describe("hub pull — merge ancestor across an assembled cross-machine chain", () => {
  const PROJECT_ID = "proj-xmw";
  const THREAD = "thread-xmw";
  const MACHINE_A = "machine-alpha";
  const MACHINE_B = "machine-beta";
  /** The source path every bundle's manifest declares; rewritten on import. */
  const SOURCE_PROJECT = "/src/xmw-proj";

  interface BundleSpec {
    machineId: string;
    bundleId: string;
    sessionId: string;
    pushedAt: string;
    type: "full" | "continuation";
    /** The single entry this bundle's transcript carries. */
    uuid: string;
    parentUuid: string | null;
    /** The predecessor's head — `null` for a root. */
    anchorEntryUuid: string | null;
    /**
     * A workspace payload: the tree, plus the generation the pushing machine
     * declares it descended from (`null` = its first workspace push).
     */
    workspace?: { basedOn: string | null; files: Record<string, string> };
  }

  /**
   * A real bundle archive on the hub — one transcript entry, a manifest stamped
   * by the real writer (so `verifySessionsDigest` and the declared-session guard
   * both pass), and optionally a workspace tree with a declared base.
   *
   * Hand-built rather than driven through `hubPush` because the arrangement
   * needs two machines' bundles to CHAIN by anchor while their workspace
   * generations do NOT — which is precisely the state no single machine can
   * push itself into, and therefore the state no round-trip fixture reaches.
   */
  async function writeBundle(
    backend: HubBackend,
    scratch: string,
    spec: BundleSpec
  ): Promise<HubBundleRecord> {
    const staging = mkdtempSync(join(scratch, "staging-"));
    // "bundle" as the single top-level entry, for the same reason push.ts uses
    // it: extractArchive strips exactly one wrapper segment.
    const bundleStaging = join(staging, "bundle");
    mkdirSync(join(bundleStaging, "sessions"), { recursive: true });

    const jsonlPath = join(bundleStaging, "sessions", `${spec.sessionId}.jsonl`);
    const entries = [
      {
        sessionId: spec.sessionId, cwd: SOURCE_PROJECT, version: "2.1.81",
        gitBranch: "main", slug: "xmw",
        uuid: spec.uuid, parentUuid: spec.parentUuid, timestamp: spec.pushedAt,
        type: "user", message: { role: "user", content: `from ${spec.machineId}` },
      },
    ];
    writeFileSync(jsonlPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    const manifest: ExportManifest = {
      version: 1,
      plugin: "sesh-mover",
      exportedAt: spec.pushedAt,
      sourcePlatform: "linux",
      sourceProjectPath: SOURCE_PROJECT,
      sourceConfigDir: "/src/.claude",
      sourceClaudeVersion: "2.1.81",
      sessionScope: "current",
      includedLayers: ["jsonl"],
      projectId: PROJECT_ID,
      sourceMachineId: spec.machineId,
      sessions: [
        {
          sessionId: spec.sessionId,
          slug: "xmw",
          summary: `a bundle from ${spec.machineId}`,
          createdAt: spec.pushedAt,
          lastActiveAt: spec.pushedAt,
          messageCount: entries.length,
          gitBranch: "main",
          entrypoint: "cli",
          integrityHash: await computeIntegrityHashFromFile(jsonlPath),
          type: spec.type,
        },
      ],
    };
    if (spec.workspace) {
      let byteSize = 0;
      for (const [rel, content] of Object.entries(spec.workspace.files)) {
        const dest = join(bundleStaging, "workspace", rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content, "utf-8");
        byteSize += Buffer.byteLength(content);
      }
      manifest.workspace = {
        fileCount: Object.keys(spec.workspace.files).length,
        byteSize,
        snapshotAt: spec.pushedAt,
        // Only `bundleId` is ever acted on by the puller; `file` is a
        // diagnostic that deliberately never becomes a path on this side.
        basedOn:
          spec.workspace.basedOn === null
            ? null
            : { bundleId: spec.workspace.basedOn, file: "irrelevant" },
      };
    }
    writeManifest(bundleStaging, manifest);

    const archivePath = join(staging, "bundle.tar.gz");
    await createArchive(bundleStaging, archivePath, "gzip");
    const file =
      `${bundleDir(PROJECT_ID, spec.machineId)}/${bundleFileName(spec.pushedAt, spec.bundleId)}`;
    await backend.writeAtomic(file, readFileSync(archivePath));
    rmSync(staging, { recursive: true, force: true });

    return {
      bundleId: spec.bundleId,
      file,
      type: spec.type,
      sessionIdInBundle: spec.sessionId,
      fromEntryUuid: spec.type === "continuation" ? spec.uuid : null,
      headEntryUuid: spec.uuid,
      anchorEntryUuid: spec.anchorEntryUuid,
      messageCount: entries.length,
      pushedAt: spec.pushedAt,
      hasWorkspace: !!spec.workspace,
    };
  }

  interface Fixture {
    home: string; hub: string; base: string; scratch: string;
    project: string; configDir: string;
    cleanup(): void;
  }

  /**
   * Two other machines, one thread, and two workspace generation histories that
   * do not overlap.
   *
   *   alpha  b-alpha  (full,        anchor null)      workspace basedOn gen-alpha
   *   beta   b-beta   (continuation, anchor head of b-alpha) workspace basedOn gen-beta
   *
   * `assembleChain` links them, so `needed` is [alpha:b-alpha, beta:b-beta] and
   * `workspaceBundleIndex` is 1 — beta's payload is the one applied.
   *
   * OUR generation history is `[gen-alpha, gen-beta]`, newest first: we pulled
   * beta's generation at some point and alpha's more recently. Both are legal
   * members of the intersection ON THEIR OWN MACHINE'S SIDE, and that is the
   * trap — only `gen-beta` is a generation BETA's tree ever passed through.
   *
   * The trees are arranged so the two candidate ancestors give opposite,
   * observable answers on one file:
   *
   *   gen-beta  notes.md = "V1"   <- the last point this machine and beta shared
   *   gen-alpha notes.md = "V2"   <- this machine has since moved to V2
   *   local     notes.md = "V2"   <- our work; beta has never seen it
   *   beta's    notes.md = "V1"   <- beta left the file alone
   *
   * Against gen-beta (correct): local changed, incoming did not -> `kept`.
   * Against gen-alpha (wrong):  local unchanged, incoming changed -> `taken`,
   * i.e. our V2 is atomically overwritten with beta's V1, no sidecar, no
   * backup, and the pull reports a clean merge.
   */
  async function arrange(): Promise<Fixture> {
    const home = mkdtempSync(join(tmpdir(), "sesh-xmw-home-"));
    const hub = mkdtempSync(join(tmpdir(), "sesh-xmw-hub-"));
    const base = mkdtempSync(join(tmpdir(), "sesh-xmw-fix-"));
    const scratch = mkdtempSync(join(tmpdir(), "sesh-xmw-scratch-"));
    const restore = overrideHome(home);
    const cleanup = (): void => {
      restore.restore();
      for (const d of [home, hub, base, scratch]) rmSync(d, { recursive: true, force: true });
    };

    try {
      const { configDir } = createFixtureTree(base);
      const project = createRealProject(base, configDir, "proj");
      const init = await hubInit({ hubPath: hub, configScope: "user", cwd: home });
      if (!init.success) throw new Error(`arrange: hub init failed: ${JSON.stringify(init)}`);
      writeLocalProjectId(project, {
        projectId: PROJECT_ID, name: "proj",
        createdAt: "2026-07-01T00:00:00Z", createdByMachine: MACHINE_A,
      });

      const backend = createFsBackend(hub);
      for (const [id, name] of [[MACHINE_A, "alpha-laptop"], [MACHINE_B, "beta-desktop"]]) {
        await backend.writeAtomic(
          machinePath(id),
          JSON.stringify({ id, name, platform: "linux", lastSeenAt: "2026-07-21T00:00:00Z" }) + "\n"
        );
      }

      // The two generations our sync-state points at. They are ordinary
      // bundles: each is a full snapshot the hub still holds, which is why a
      // generation is only ever a POINTER on this side.
      const genBeta = await writeBundle(backend, scratch, {
        machineId: MACHINE_B, bundleId: "gen-beta", sessionId: "sess-gen-beta",
        pushedAt: "2026-08-01T00:00:00.000Z", type: "full",
        uuid: "gen-beta-1", parentUuid: null, anchorEntryUuid: null,
        workspace: { basedOn: null, files: { "notes.md": "V1\n" } },
      });
      const genAlpha = await writeBundle(backend, scratch, {
        machineId: MACHINE_A, bundleId: "gen-alpha", sessionId: "sess-gen-alpha",
        pushedAt: "2026-08-02T00:00:00.000Z", type: "full",
        uuid: "gen-alpha-1", parentUuid: null, anchorEntryUuid: null,
        workspace: { basedOn: null, files: { "notes.md": "V2\n" } },
      });

      // The chain this pull assembles. Alpha's bundle is the root; beta's
      // continuation anchors on alpha's head, which is the ONLY reason the two
      // machines end up in one `needed` list.
      const recAlpha = await writeBundle(backend, scratch, {
        machineId: MACHINE_A, bundleId: "b-alpha", sessionId: "sess-alpha",
        pushedAt: "2026-08-03T00:00:00.000Z", type: "full",
        uuid: "xmw-a1", parentUuid: null, anchorEntryUuid: null,
        workspace: { basedOn: "gen-alpha", files: { "notes.md": "V2\n" } },
      });
      const recBeta = await writeBundle(backend, scratch, {
        machineId: MACHINE_B, bundleId: "b-beta", sessionId: "sess-beta",
        pushedAt: "2026-08-04T00:00:00.000Z", type: "continuation",
        uuid: "xmw-b1", parentUuid: "xmw-a1", anchorEntryUuid: "xmw-a1",
        // Beta pushed from a tree that never moved past gen-beta.
        workspace: { basedOn: "gen-beta", files: { "notes.md": "V1\n" } },
      });

      await writeMachineIndex(backend, {
        ...idx(MACHINE_A, {
          [THREAD]: entry({
            localSessionId: "sA-local", lastActiveAt: "2026-08-03T00:00:00Z",
            headEntryUuid: "xmw-a1", bundles: [recAlpha],
          }),
        }),
        projectId: PROJECT_ID,
      });
      await writeMachineIndex(backend, {
        ...idx(MACHINE_B, {
          [THREAD]: entry({
            localSessionId: "sB-local", lastActiveAt: "2026-08-04T00:00:00Z",
            headEntryUuid: "xmw-b1", bundles: [recBeta],
          }),
        }),
        projectId: PROJECT_ID,
      });

      // Our own generation history, newest first: gen-alpha, then gen-beta.
      // Seeded through the real writer so the ordering rule (`setLastWorkspace`
      // prepends) is the one under test rather than a hand-shaped array.
      const st = readSyncState(project);
      setLastWorkspace(st, init.hubId, {
        bundleId: genBeta.bundleId, file: genBeta.file, pushedAt: genBeta.pushedAt,
      });
      setLastWorkspace(st, init.hubId, {
        bundleId: genAlpha.bundleId, file: genAlpha.file, pushedAt: genAlpha.pushedAt,
      });
      writeSyncState(st);

      // Our tree is at gen-alpha's content — i.e. we changed notes.md from V1
      // to V2 since the last generation we shared with beta.
      writeFileSync(join(project, "notes.md"), "V2\n", "utf-8");

      return { home, hub, base, scratch, project, configDir, cleanup };
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  it("merges beta's payload against a generation BETA held, not the newest one WE hold", async () => {
    const f = await arrange();
    try {
      const pull = await hubPull({
        configDir: f.configDir, projectPath: f.project, hubPath: f.hub,
        threadId: THREAD, claudeVersion: "2.1.81",
        // The session half is deliberately made uninteresting: this test is
        // about which ancestor the workspace half picks, and splicing would
        // add an append/divergence axis that decides nothing here.
        noAppend: true,
      });

      expect(pull.success).toBe(true);
      if (!pull.success) return;
      const p = pull as HubPullResult;

      // The premise, asserted rather than assumed: the pull really did fetch
      // and apply bundles from BOTH other machines. Without that there is no
      // cross-machine chain and nothing below means anything.
      expect(p.importedSessions).toHaveLength(2);

      // THE HARM. Our notes.md is work beta has never seen; the merge must
      // keep it. Against the wrong (newer, alpha-declared) ancestor it is
      // classified `taken` and atomically overwritten with beta's V1 — no
      // sidecar, no backup, reported as a clean merge.
      expect(readFileSync(join(f.project, "notes.md"), "utf-8")).toBe("V2\n");

      // ...and the merge ran rather than skipping, so "V2" is a decision and
      // not an accident of the payload never being applied.
      expect(p.workspaceMerge).toBeDefined();
      expect(p.workspaceMerge?.kept ?? []).toContain("notes.md");
      expect(p.workspaceMerge?.taken ?? []).not.toContain("notes.md");
    } finally {
      f.cleanup();
    }
  });
});
