import type { HubDeleteResult, HubLockBusyResult, HubRetireFailedResult, HubRetireResult, HubUnreachableResult } from "../types.js";
/**
 * Hub project retirement, in the two phases the owner's ruling on #43 settles:
 *
 *   1. **`hub retire`** writes a tombstone — an assertion, on a file this
 *      machine owns. Nothing is removed. A tombstoned project is refused for
 *      pull (`hub/pull-resolve.ts`).
 *   2. **`hub delete`** destroys the project's files on the hub, and only the
 *      machine that created the project may, and only once its own tombstone is
 *      older than `RETIREMENT_GRACE_MS`.
 *
 * ---------------------------------------------------------------------------
 * **TWO VERBS, NOT ONE VERB WITH A FLAG**, and the reason is the whole point of
 * the ruling. The two phases have opposite risk profiles: phase 1 is an
 * assertion this machine can retract in one command, phase 2 is irreversible
 * destruction of every machine's copy of a project. A single verb — even with a
 * `--delete` flag guarded by the grace window — puts them one keystroke and one
 * shell-history arrow-up apart, and the grace window exists precisely because
 * "the destructive step happened sooner than anyone meant it to" is the failure
 * being designed against. Separate verbs also let the safe one keep the
 * ordinary, guessable name.
 *
 * **Both phases are owner-only** (`HubProjectJson.createdByMachine`). The
 * slice-3 design also allowed *any* machine to retire an **empty** project, as
 * an escape hatch for the case where the creating machine is gone; that clause
 * did not survive being chained to a deletion, which the design itself flagged
 * ("if compaction reuses this assertion mechanism to actually delete bundles,
 * the empty clause must be re-examined — a wrong assertion that today hides a
 * list entry would then destroy data"). Its whole justification was that a wrong
 * assertion is free. Under the ruling a tombstone is the *authorization* for a
 * delete, so it is not free any more, and the hatch is gone. The orphan case #43
 * describes is unaffected: a push that failed after minting a hub project minted
 * it under THIS machine's id, so this machine is its owner and can retire it
 * with `--project-id`. The genuinely stranded case — the creating machine is
 * decommissioned — is a human `rm` on the hub directory, which is what it was
 * before this feature existed.
 *
 * **This module is the ONLY caller of `HubBackend.delete` in `src/`.** It had
 * none at all before #43 (the slice-4 spec: "physical removal belongs to
 * retirement and compaction"), and `tests/hub-retire.test.ts` asserts the call
 * sites so a second one cannot appear without a deliberate edit to that
 * allowlist. Every removal here goes through `deleteHubFile` below, so there is
 * one line in the codebase that removes a hub file.
 * ---------------------------------------------------------------------------
 */
export interface HubRetireOptions {
    projectPath: string;
    hubPath: string;
    /**
     * Retire a hub project by id rather than the one this directory is linked to.
     *
     * The orphan case is why it exists: a push that failed between minting the hub
     * project and writing the local link leaves a project on the hub that no
     * directory points at, so without this flag the machine that created it could
     * never name it. Ownership is still checked.
     */
    projectIdOverride?: string;
    /** Free text recorded on the tombstone and echoed to every machine's refusal. */
    reason?: string;
    /** Withdraw this machine's assertion instead of making one. */
    undo?: boolean;
}
export interface HubDeleteOptions {
    projectPath: string;
    hubPath: string;
    projectIdOverride?: string;
}
export type HubRetireOutcome = HubRetireResult | HubRetireFailedResult | HubLockBusyResult | HubUnreachableResult;
export type HubDeleteOutcome = HubDeleteResult | HubRetireFailedResult | HubLockBusyResult | HubUnreachableResult;
/**
 * The order `hub delete` removes a project's files in — fixed, never whatever
 * `list` happened to return, because it is what decides how an INTERRUPTED
 * delete leaves the hub. A network share disappearing mid-run is the ordinary
 * way to find out.
 *
 *   1. **`project.json` first.** It is what `listHubProjects` reads, so the
 *      instant it is gone the project can no longer be offered as a
 *      `linkCandidate` or resolved through `--project-id`, whatever else
 *      survives. A half-deleted project must not be linkable.
 *   2. **Bundles and indexes next** — the bulk, and the part with nothing
 *      depending on its order.
 *   3. **Tombstones LAST.** A run that dies half way leaves the tombstone
 *      standing, which keeps the pull gate up on every machine that has it AND
 *      keeps this delete authorized — the grace window has already elapsed, so
 *      re-running the command simply finishes the job. Deleting the tombstone
 *      first would strand a half-deleted project that could only be re-deleted
 *      by retiring it again and waiting out a second window.
 *
 * Pure, and exported, so the ordering can be asserted without arranging a
 * failure mid-delete.
 */
export declare function orderForDeletion(projectId: string, files: string[]): string[];
export declare function hubRetire(opts: HubRetireOptions): Promise<HubRetireOutcome>;
export declare function hubDelete(opts: HubDeleteOptions): Promise<HubDeleteOutcome>;
//# sourceMappingURL=retire.d.ts.map