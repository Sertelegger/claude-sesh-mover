import type { ImportResult, DryRunResult, ErrorResult, SharedLayerFindings, ProgressEvent } from "./types.js";
/** What `applySharedLayers` reports: the typed findings, plus the prose. */
export interface SharedLayerApplication extends SharedLayerFindings {
    warnings: string[];
}
/**
 * Reconcile a bundle's `memory/` and `plans/` **without importing a session**.
 *
 * ## Why this exists (#63)
 *
 * `reconcileSharedLayers` runs inside `importSession`, and a hub pull does not
 * always call it: when `tryAppendContinuation` splices a continuation onto an
 * existing transcript — or `adoptHubBranch` adopts one — the bundle is handled
 * and `pull-apply-sessions.ts` returns before the fragment import. The two
 * shared layers were extracted and then discarded with the extract dir.
 *
 * That was not a slow leak, it was permanent: the pushing machine credits its
 * own hub ledger with the `memoryDigest` it sent (`hub/push.ts` ->
 * `setPeerMemoryDigest`), so the exporter never ships that memory again. After
 * a machine's first pull of a thread, every later memory update reached it only
 * on the paths where the splice was DECLINED — which is why it looked like it
 * worked when tested seconds after a push (inside the 5-minute liveness window
 * the splice declines and the fragment import applies the memory) and silently
 * did not on the quiet path, which is also the common one.
 *
 * ## Why it is a wrapper and not a second implementation
 *
 * `reconcileSharedLayers` stays private with FOUR internal callers precisely so
 * the dry-run preview cannot drift from the run — the preview is the same
 * function in `plan: true` mode, never a parallel implementation. This fifth
 * caller preserves that: it is a one-line delegation, so a rule added there
 * reaches the splice path with no edit here, and the projection to
 * `SharedLayerFindings` still goes through `sharedFindings`, the single site
 * that decides an empty array is reported as absent.
 *
 * There is deliberately no `plan` parameter: the two splice paths write to a
 * transcript the user already owns before they get here, so there is no preview
 * of them to keep honest, and offering the mode would invite a caller to preview
 * one half of an operation whose other half already happened.
 *
 * ## Double-running is prevented STRUCTURALLY, not by dedupe
 *
 * Both call sites sit immediately before a `return` that skips the fragment
 * import, so a bundle reaches either this function or `importSession`, never
 * both — and a splice that is refused falls through untouched to the import,
 * which reconciles exactly once as it always did. `SharedLayerAccumulator`
 * dedupes `memoryConflicts` by value, which would make a double-run *harmless*;
 * it would not make it correct (the index union's `alreadyPresent` is summed,
 * not deduped), so nothing here leans on it.
 */
export declare function applySharedLayers(opts: {
    exportPath: string;
    targetProjectDir: string;
    targetConfigDir: string;
    sourceMachineName?: string;
    /**
     * Same default as `ImportOptions.includePlans`: OFF. Omitting it here is the
     * correct call for the hub, and doubly so — `plans/` never travels to the hub
     * in the first place (see CLAUDE.md), and this path runs unattended from a
     * SessionEnd/SessionStart hook, which has no channel to disclose a
     * machine-global write.
     */
    includePlans?: boolean;
    /**
     * Same default as `ImportOptions.noMemory`: OFF, i.e. the memory layer is
     * applied. Omitting it is the correct call for the hub — `memory/` is the one
     * shared layer that DOES travel there, and a pull that silently dropped it
     * would reinstate #53. It is threaded rather than hard-coded so this wrapper
     * and `importSession` cannot come to disagree about what a declined memory
     * layer does.
     */
    noMemory?: boolean;
}): SharedLayerApplication;
export interface ImportOptions {
    exportPath: string;
    targetConfigDir: string;
    targetProjectPath: string;
    targetClaudeVersion: string;
    dryRun: boolean;
    sessionIds?: string[];
    noRegister?: boolean;
    allowDuplicates?: boolean;
    /**
     * Write the bundle's `plans/` into `<targetConfigDir>/plans`. **Default off**
     * (`--include-plans` on `sesh-mover import`): that directory is
     * config-dir-global, so it is the one shared-layer destination an arbitrary
     * bundle can use to write files every project on this machine sees. Absent or
     * `false`, a bundle's plans are counted, disclosed and left in the bundle.
     */
    includePlans?: boolean;
    /**
     * Decline the bundle's `memory/` (`--no-memory` on `sesh-mover import`).
     * **Default off**, i.e. memory is written: it lands in the target PROJECT's
     * own directory, is add-only and parks conflicts rather than overwriting
     * them, and it is the layer a future session reads prose out of. Absent or
     * `false`, a bundle's memory is reconciled as before; `true` counts it,
     * discloses it in `memorySkipped`, and leaves every file in the bundle.
     */
    noMemory?: boolean;
    /**
     * Handle the bundle's two FILE payloads — `workspace/` and `carry/` (#47).
     *
     * **ABSENT means this caller does not handle them AT ALL**: not applied, not
     * counted, not disclosed. That is not a default, it is a statement about which
     * of `importSession`'s THREE callers this is:
     *
     *  - `sesh-mover import` (cli.ts) passes it. This is the bootstrap transport
     *    #47 exists for.
     *  - `hub pull` does NOT, because it has its own stages for both payloads
     *    (`pull-apply-workspace.ts`, `pull-apply-carry.ts`) with a 3-way merge, an
     *    ancestor rule and a saved-payload contract that all differ from
     *    bootstrap's on purpose. Two handlers running over one bundle would report
     *    it twice and, worse, disagree: the pull's carry decline SAVES the payload
     *    and may not name a re-run, while this one writes nothing and may.
     *  - `migrate` does NOT, deliberately and permanently. It is export + import +
     *    delete-source on ONE machine, so a workspace snapshot of files already on
     *    that machine is pure copying and `--rename-dir` already moves the
     *    directory. Writing that down matters more than the exclusion: the next
     *    reader will otherwise add it for symmetry, and a payload apply inside a
     *    flow that also DELETES SOURCE SESSIONS is the worst place in this
     *    codebase to discover an interaction.
     *
     * Every field inside is `false` by default at every wiring site — see the flag
     * declarations in `cli.ts` for why that is a security property rather than a
     * UX preference, and `reconcilePayloadLayers` for what each one does.
     */
    filePayload?: {
        /**
         * Unpack `workspace/` into `targetProjectPath`. Never implied by the bundle
         * carrying one — a payload's presence is not a request to write it.
         *
         * OPTIONAL, and that is deliberate rather than lax: absent has to MEAN "do
         * not apply", so the `=== true` coercion below is load-bearing rather than
         * redundant belt-and-braces. Declaring these three required would make
         * `=== true` and `!== false` indistinguishable to every caller a type
         * checker can see — which is exactly how a security default stops being
         * testable. (Found by mutation: a test helper that pre-coerced them made the
         * behavioural half of this guard unable to fail.)
         */
        applyWorkspace?: boolean;
        /**
         * `git apply` the carried patch and copy its untracked files. Absent,
         * NOTHING is written — not even the saved copy a `hub pull` parks. See
         * `reconcilePayloadLayers` for why that divergence is right.
         */
        applyCarry?: boolean;
        /**
         * Unpack the workspace payload OVER a target that already has content,
         * OVERWRITING any file of the same name. Without it a non-empty target is
         * refused before anything is written. It is an overwrite, never a merge.
         */
        forceWorkspace?: boolean;
    };
    onProgress?: (ev: ProgressEvent) => void;
}
export declare function importSession(options: ImportOptions): Promise<ImportResult | DryRunResult | ErrorResult>;
//# sourceMappingURL=importer.d.ts.map