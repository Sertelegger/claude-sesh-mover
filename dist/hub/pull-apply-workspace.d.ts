import { type HubBackend } from "./backend.js";
import { type HubBundleRecord } from "./layout.js";
import { type WorkspaceMergeReport } from "./merge.js";
import { type StageOutcome } from "./pull-stages.js";
export interface ApplyWorkspaceStageInput {
    backend: HubBackend;
    extractDir: string;
    effectiveProjectPath: string;
    targetPathGiven: boolean;
    forceWorkspace: boolean;
    bundleDeclaresWorkspace: boolean;
    chainWorkspaceBases: ReadonlyArray<string | null>;
    hubId: string;
    record: Pick<HubBundleRecord, "bundleId" | "file" | "pushedAt">;
    tempRoot: string;
}
export interface WorkspaceStageValue {
    unpacked: {
        path: string;
        fileCount: number;
    } | null;
    merge?: WorkspaceMergeReport;
    refused?: string[];
    declaredMissing?: true;
}
/**
 * Apply the chain's workspace payload — by merging it, unpacking it, or
 * declining to do either.
 *
 * Runs inside the per-bundle loop, once per bundle, and self-gates: the caller
 * passes `bundleDeclaresWorkspace` (`i === state.workspaceBundleIndex &&
 * !!manifest.workspace`), and every other bundle is a zero-reason skip. It must
 * NOT be hoisted out of the loop even though it does its work at most once —
 * `chainWorkspaceBases` is written by `fetch` in the same iteration and read
 * here mid-accumulation, and an earlier bundle's integrity abort has to be able
 * to stop the pull before this ever runs.
 *
 * Five outcomes, and the difference between the last two is the whole reason
 * this returns an outcome rather than a value:
 *
 * | situation | outcome |
 * |---|---|
 * | no payload on this bundle | `skipped`, zero reasons, no value |
 * | manifest declares one the bundle lacks | `skipped`, one reason, `declaredMissing` |
 * | merged, or unpacked | `applied`, `unpacked` plus `merge`/`refused` |
 * | no generation common to both trees | `skipped`, the ancestor reasons PLUS the no-common-point sentence |
 * | explicit --target-path, not empty, no force | `aborted` — see below |
 *
 * **The abort is not a refusal.** `WorkspaceTargetNotEmptyError` returns an
 * `ErrorResult` the caller must return VERBATIM, stopping the pull before this
 * bundle's sessions are imported and before anything is recorded. Modelling it
 * as `refused` (apply-safe, pull continues) records the bundle and forecloses
 * the `--force-workspace` re-run its own message promises — and the registry in
 * `tests/hub-warning-flags.test.ts` classifies that message `retry-works` on
 * exactly this premise, while being unable to detect a change to it.
 *
 * `WorkspaceStageValue.unpacked` is a sum over five merge-report arrays on the
 * merge path and `unpackWorkspace`'s own count on the unpack path — a union of
 * the two engines' reports would lose it, along with `refused` and
 * `declaredMissing`, which are `HubPullResult` fields with no other source.
 *
 * Workspace gate (the chain's newest workspace-carrying bundle only).
 * Slice 1's four branches are preserved; what changed is that the
 * APPLICATION step is now a 3-way merge whenever a generation COMMON TO
 * BOTH TREES can be named (design §5.5, and see `chooseMergeAncestor` for
 * why nothing weaker will do):
 *
 * - target absent, empty, or
 *   metadata-only                -> unpack (bootstrap; no force needed).
 *                                   NEVER merge: with an empty tree every
 *                                   file reads as "deleted here" and the
 *                                   merge would write nothing at all.
 * - common generation found,
 *   target has real content,
 *   no --force-workspace         -> 3-way MERGE. No force needed: merging
 *                                   cannot lose local work, so requiring
 *                                   a destructive-sounding flag for it
 *                                   would be backwards.
 * - --force-workspace, target has
 *   real content                 -> unpack with force, i.e.
 *                                   OVERWRITE-ON-COLLISION (§5.4), merge
 *                                   or no merge. The flag keeps ONE
 *                                   meaning — "overwrite, don't combine"
 *                                   — and it is deliberately not made
 *                                   inert by having a generation on
 *                                   record: it is the only way to ask for
 *                                   the hub's copy wholesale, and the only
 *                                   remedy for a file a merge withheld.
 * - no common generation, explicit
 *   --target-path, has real
 *   content, no force            -> let unpackWorkspace throw, surface
 *                                   an ErrorResult with the
 *                                   --force-workspace suggestion (the
 *                                   user asked for that destination;
 *                                   refuse loudly)
 * - no common generation, no
 *   explicit --target-path,
 *   project dir has real content,
 *   no force                     -> SKIP with a warning (routine repeat
 *                                   pulls of non-git projects must not
 *                                   start erroring)
 *
 * Plugin state counts as non-content on BOTH sides: identity linking
 * above may have just planted `.sesh-mover-project.json` into an
 * otherwise fresh directory (the in-place bootstrap flow, --project-id
 * with no --target-path), and that metadata alone must neither trigger
 * the routine-skip branch nor trip unpackWorkspace's own emptiness check
 * — hence force is also set when the dir holds nothing but our metadata.
 * `isPluginStateName` rather than one literal name: since 0.7.0 the
 * metadata is a directory AND three root dotfiles, and the pre-0.7.0
 * directory is still recognized, so a single `!==` would read a freshly
 * linked project as having real content and skip the merge.
 */
export declare function runApplyWorkspaceStage(input: ApplyWorkspaceStageInput): Promise<StageOutcome<WorkspaceStageValue>>;
//# sourceMappingURL=pull-apply-workspace.d.ts.map