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
    onProgress?: (ev: ProgressEvent) => void;
}
export declare function importSession(options: ImportOptions): Promise<ImportResult | DryRunResult | ErrorResult>;
//# sourceMappingURL=importer.d.ts.map