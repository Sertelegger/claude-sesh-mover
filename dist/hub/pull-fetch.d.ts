import type { HubBackend } from "./backend.js";
import type { HubBundleRecord } from "./layout.js";
import type { ApplyState } from "./pull-apply-state.js";
import { type StageOutcome } from "./pull-stages.js";
import type { ExportManifest, ProgressEvent } from "../types.js";
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
    /**
     * How many bundles this pull's chain has — the denominator of the `hub-pull`
     * percent below, and the only thing this stage uses it for.
     */
    chainLength: number;
    /** Private temp dir for this pull; the archive and its extraction land here. */
    tempRoot: string;
    /**
     * MUTATED — this stage writes `chainWorkspaceBases` and `lastCarry` in place
     * rather than returning them. See the doc on `runFetchStage`.
     */
    state: ApplyState;
    /**
     * `hubPull`'s own callback, forwarded (#74). Optional and usually absent —
     * only `--progress` supplies one — so everything below is a no-op by default.
     */
    onProgress?: (ev: ProgressEvent) => void;
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
export declare function runFetchStage(input: FetchStageInput): Promise<StageOutcome<FetchStageResult>>;
//# sourceMappingURL=pull-fetch.d.ts.map