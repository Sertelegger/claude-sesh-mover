import type { HubBackend } from "./backend.js";
import type { HubBundleRecord } from "./layout.js";
import type { ApplyState } from "./pull-apply-state.js";
import { type StageOutcome } from "./pull-stages.js";
import type { ExportManifest } from "../types.js";
export interface FetchStageInput {
    backend: HubBackend;
    record: HubBundleRecord;
    /**
     * The machine whose index listed THIS record (`SourcedBundle.machineId`), not
     * the machine the pull resolved to. It is stamped onto the workspace
     * generation this stage records, and the merge-ancestor rule is only sound
     * because of it — see `ChainWorkspaceBase`.
     */
    machineId: string;
    /**
     * This bundle's position in the chain. Load-bearing rather than bookkeeping:
     * it is stamped onto `state.lastCarry` so the carry gate after the loop can
     * tell a payload out of a bundle this pull already recorded from one out of a
     * bundle a divergence abort deferred.
     */
    bundleIndex: number;
    /** Private temp dir for this pull; the archive and its extraction land here. */
    tempRoot: string;
    /**
     * MUTATED — this stage writes `chainWorkspaceBases` and `lastCarry` in place
     * rather than returning them. See the doc on `runFetchStage`.
     */
    state: ApplyState;
}
/**
 * What a fetched bundle hands to the rest of the loop.
 *
 * The contract this stage establishes is deliberately NOT "verified".
 * `verifySessionsDigest` hashes the manifest's canonicalized session list and
 * its length and **nothing else** — not the JSONL bytes, not `workspace/`, not
 * `carry/` — so content damage alone passes it. What is true on return is only
 * that *the manifest is internally self-consistent and the transcript it
 * declares is on disk*. The append path's own re-hash of the delta against
 * `bundleSession.integrityHash` is therefore NOT redundant with anything here;
 * treating it as redundant welds a corrupt delta into a transcript the user
 * already owns.
 */
export interface FetchStageResult {
    /** Where the bundle was unpacked — `manifest.json`, `sessions/`, and friends sit directly under it. */
    extractDir: string;
    manifest: ExportManifest;
}
/**
 * Retrieve one bundle of the chain, unpack it, and read its manifest.
 *
 * **This stage mutates `state`; it deliberately does not return the two values
 * it writes.**
 *
 * - `state.chainWorkspaceBases` is read by `chooseMergeAncestor` in the SAME
 *   loop iteration, so what is load-bearing is *timing*: this bundle's
 *   generation must be present before the workspace gate runs. A
 *   return-and-assign design invites a caller that pushes after the gate,
 *   silently dropping the newest and most-likely-shared generation.
 * - `state.lastCarry` is *newest-wins-**only if present***. Returning an
 *   optional carry invites `st.lastCarry = value.carry ?? null` at the call
 *   site, which CLEARS an earlier bundle's carry when a later bundle has none —
 *   silently discarding another machine's uncommitted work. The
 *   `if (manifest.carry)` guard stays welded to the assignment in here so that
 *   shape is not available to write.
 *
 * Two `aborted` outcomes, and the caller's only correct handling of either is
 * `return fetched.terminal!` immediately. `break` falls through to the carry
 * gate, the thread mapping and the index write and then reports `success: true`
 * — a refusal turned into a successful pull. `continue` violates the chain
 * invariant (bundle N+1 is anchored on N's head) and fragment-imports *and
 * records* the next bundle, foreclosing the remedy.
 */
export declare function runFetchStage(input: FetchStageInput): Promise<StageOutcome<FetchStageResult>>;
//# sourceMappingURL=pull-fetch.d.ts.map