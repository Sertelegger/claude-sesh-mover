import type { HubBackend } from "./backend.js";
import { type HubJson } from "./layout.js";
import { type LocalProjectId } from "./identity.js";
import { type ResolvedThread } from "./threads.js";
import type { HubNoSuchProjectResult, HubProjectRetiredResult, HubUnlinkedResult, HubUnreachableResult } from "../types.js";
export interface ResolveStageInput {
    backend: HubBackend;
    /**
     * `hubPull`'s `opts.projectPath` — deliberately NOT the effective/target
     * path. In the bootstrap case (the project doesn't exist locally yet and
     * --target-path names a fresh destination for the workspace) that
     * destination must stay genuinely nonexistent until the workspace-unpack
     * step runs; if linking wrote .sesh-mover under it first, the "project path
     * doesn't exist locally" gate on the workspace flow would never fire.
     */
    projectPath: string;
    /** `registerMachine` builds its own backend from the path, not from `backend`. */
    hubPath: string;
    projectIdOverride?: string;
    /**
     * The pull's operation clock, captured once in `hubPull`.
     *
     * Required, not defaulted, because `tests/hub-pull-invariants.test.ts` bans a
     * wall-clock read in any `pull-*.ts` stage file and a default would be one.
     * The ban exists for `append.ts`'s liveness guard, which this stage has
     * nothing to do with — the point of an unconditional rule is that nobody has
     * to decide per site which clock reads matter.
     */
    opNowMs: number;
    /**
     * Pull even though the project is retired (#43).
     *
     * The escape hatch the refusal itself points at, and it is not a weakening of
     * the gate: the tombstone exists to stop work starting against a retiring
     * project UNWITTINGLY, and a machine that has un-pulled work on a hub whose
     * bundles are about to be deleted needs a way to get it. Retraction is
     * asymmetric — only the asserting machine can withdraw a tombstone — so
     * without this the only remedy for everyone else would be to ask another
     * person and wait.
     */
    ignoreRetirement?: boolean;
}
export interface ResolveStageValue {
    local: LocalProjectId;
    /** The hub record itself — its `hubId` keys the thread and workspace bookkeeping. */
    hub: HubJson;
    /** `hub:<hubId>`, the peer id the hub's own receipt ledger is kept under. */
    hubPeerId: string;
    resolved: ResolvedThread[];
}
/**
 * Not a `StageOutcome`, on purpose.
 *
 * `stageRefuse` carries `value: null` and nothing but `reasons: string[]`,
 * while the unlinked escape carries STRUCTURED data — `linkCandidates`, the
 * hub projects `/sesh-mover:pull`'s skill layer offers the user to link to.
 * Routing it through a refusal destroys them, which is a user-visible
 * regression rather than a cosmetic one. So the escape hands back the finished
 * `HubUnlinkedResult` for `hubPull` to return verbatim.
 *
 * A second reason to keep `refused` out of this stage: once it meant
 * "unlinked", any later `try`/`catch` wrapped around the body would silently
 * relabel every throw below as one.
 *
 * The `return` arm carries the preflight's two refusals as well (#75), for the
 * same reason: `hub-unreachable` and `no-such-project` are finished results
 * with fields of their own, and each is emitted before this stage reads or
 * writes anything, so `hubPull` returns them verbatim exactly as it does the
 * unlinked escape.
 */
export type ResolveStageOutcome = {
    kind: "proceed";
    value: ResolveStageValue;
    reasons: string[];
} | {
    kind: "return";
    result: HubUnlinkedResult | HubUnreachableResult | HubNoSuchProjectResult | HubProjectRetiredResult;
};
/**
 * The pull's first stage: settle which hub project this directory IS, announce
 * this machine to the hub, and read what every machine's index says about the
 * project's threads.
 *
 * **Almost nothing here is caught.** `resolveProjectIdentity`, `registerMachine`
 * and `readAllIndexes` all escape to `cli.ts`, which turns them into an
 * `ErrorResult`; a `try`/`catch` around them in this module would convert a
 * mistyped hub path into a confident, wrong answer.
 *
 * The two exceptions are the preflight's, and they are caught THERE rather than
 * here (#75): an unreachable hub and a `--project-id` naming no hub project
 * were the two realistic throws in this stage — the first out of the `hub.json`
 * read, the second out of `linkToHubProject` — and both are now typed refusals
 * decided before this stage touches anything. That is also why the `hub.json`
 * read no longer happens in this file: the preflight hands the parsed record
 * over, and a second read here would leave the `ENOENT` exactly where it was.
 *
 * The project lock is the caller's: `hubPull` acquires it before calling this
 * and releases it in its own `finally`. This stage neither acquires, releases
 * nor inspects it — splitting ownership of a resource across that boundary is
 * how a wedged lock outlives its operation.
 *
 * `loadOrCreateMachineId()` likewise stays in `hubPull`'s prologue: it MINTS
 * the machine id when absent, and the unlinked escape below returns before
 * `registerMachine`, so that prologue call is the only reason an unlinked pull
 * gets one at all.
 */
export declare function runResolveStage(input: ResolveStageInput): Promise<ResolveStageOutcome>;
//# sourceMappingURL=pull-resolve.d.ts.map