import type { HubBackend } from "./backend.js";
import type { HubBundleRecord } from "./layout.js";
import { type ResolvedThread } from "./threads.js";
import type { ErrorResult, HubPullFindings, NotYetSyncedResult, UnfetchableBundleGroup, WhereisThread } from "../types.js";
/**
 * The half of a thread this pull could not reach, in words.
 *
 * WHAT THIS SENTENCE USED TO CLAIM, AND WHY IT NO LONGER DOES. It ended
 * "…no flag or re-run fetches them — sesh-mover cannot yet assemble a thread
 * whose history is split across machines", and its doc argued the foreclosure
 * was deliberate. It was right when written and #35 is exactly what invalidates
 * it: a pull now assembles a thread across EVERY machine's bundle list, so the
 * split-history case this sentence was written for is the ordinary case that
 * arrives whole. Leaving the claim in place would put it in the milestone's own
 * defect class from the other side — a message that forecloses a remedy which
 * exists is as wrong as one that invents a remedy which does not.
 *
 * IT STILL NAMES NO FLAG, for a reason that survived the change: there is no
 * `--from-machine`, `--thread` and `--target-path` resolve to the same single
 * source, and `hub reindex` only rebuilds this machine's index from its own
 * bundles. What CHANGED the outcome is on the hub — a bundle pushed, a link
 * recorded — never an argument to this command.
 *
 * WHAT SURVIVES THE SUBTRACTION IS NARROWER, and that is what this text now
 * describes. Both callers subtract the assembled plan from
 * `findUnfetchableBundles` (spec §6), so a group here holds only bundles the
 * chain does not reach: behind a gap, on a branch this pull did not follow, or
 * pushed before links were recorded at all. This sentence names the MACHINES and
 * says nothing about WHICH of those it is — `describeAssembly` computes that
 * from the walk itself and is emitted beside this sentence wherever the walk
 * could tell. It is deliberately not a cross-reference ("see the note beside
 * this one"): there is a residual class where the heuristic sees records the
 * walk cannot account for, and a promise of a note that is not there is the
 * foreclosure defect wearing its opposite face. Restating the condition rule
 * here would be a second copy of it, which is how the two come to disagree.
 *
 * Machine names are capped at three so a hub with many machines still
 * produces one readable sentence; the full set is in the typed field.
 *
 * MACHINE NAMES ARE NOT UNIQUE. They come from the hostname, so a VM clone or
 * two default installs on same-named hosts give two machine ids one name — and
 * this sentence names a machine three times in three different roles, which
 * with bare names degenerates to "mbp holds bundles that mbp does not list …
 * the one machine it resolves to (mbp)". Any name shared by two of the roles in
 * THIS sentence therefore carries its machine id.
 */
export declare function describeUnfetchable(threadId: string, groups: UnfetchableBundleGroup[], source: {
    machineId: string;
    machineName: string | null;
}): string;
export interface SelectStageInput {
    backend: HubBackend;
    /** Every machine's view of this project's threads, as `resolve` produced it. */
    resolved: ResolvedThread[];
    /** This machine's id — the "is it already here" side of every comparison. */
    machineId: string;
    /** Keys the thread mapping this stage may repair. */
    hubId: string;
    threadId?: string;
    latest?: boolean;
    /**
     * `--target-path` when given, else the project path. Everything downstream of
     * selection keys its sync-state off this, so the pick list's disclosure
     * describes exactly what pulling that thread would report. The stage reads
     * (and, on the repair path, writes) the state file itself — see the module
     * doc for why a `SyncState` parameter would be wrong.
     */
    effectiveProjectPath: string;
    /** `<configDir>/projects/<encoded effective path>` — where a local session file would be. */
    targetProjectDir: string;
}
/**
 * One bundle this pull will fetch, paired with the machine whose index listed
 * it — the peer whose ledger that bundle's arrival credits.
 *
 * THE PAIRING LIVES HERE AND NOT ON THE RECORD, and that is a schema decision
 * rather than a style one. `HubBundleRecord` is the ON-DISK index shape
 * (`layout.ts`), so a machine id inside it would put one machine's claim about
 * its own identity inside a file every other machine parses — the exact
 * substitution `resolveThreads` already refuses by spreading the entry FIRST
 * and the file-derived id SECOND. A fetch plan is a per-pull structure nobody
 * stores, so it is free to carry what the schema may not.
 *
 * ELEMENTS OF ONE PLAN NOW DISAGREE, which is what the pairing was built for.
 * Chain assembly (#35) draws `needed` from every machine's list, and three
 * sites downstream spend a machine id on a peer ledger: a scalar that is right
 * for the plan is wrong for a record the moment those two come apart, and the
 * failure mode is a silently mis-credited `received`/`sent` ledger — which is
 * `recordSentToPeer`'s own unreconstructable-thread invariant
 * (src/sync-state.ts), i.e. the defect #35 exists to fix, reintroduced by its
 * own fix. Asserted end to end on the sync-state FILE, in both resolution
 * branches, by "cross-machine chain assembly, end to end" in
 * tests/hub-pull-stages.test.ts; the two-machine invariance case beside it is
 * the measurement that the pairing changed nothing for the shape every hub had
 * before assembly.
 */
export interface SourcedBundle {
    /**
     * The machine whose index lists this bundle. NOT "the machine this pull
     * resolved to" — see `SelectStageResult.sourceMachineId`, which is that and
     * stays that.
     */
    machineId: string;
    record: HubBundleRecord;
}
export interface SelectStageResult {
    /**
     * NARROWED on purpose: the thread's id and the source machine's id, never the
     * `ResolvedThread`/`ThreadCopy` they came from. Handing back `copies` would
     * let a later stage re-derive the selection from it, and `copies` is the field
     * carrying an iteration-order ban.
     */
    threadId: string;
    /**
     * The machine this pull RESOLVED to — what drives the source label on the
     * result and the alternate-source warning above.
     *
     * Deliberately no longer the answer to "which peer supplied this record":
     * that is per record, on `needed`. Keeping one scalar for both meanings is
     * what mis-credits a ledger once a chain spans machines.
     */
    sourceMachineId: string;
    needed: SourcedBundle[];
    /**
     * The typed disclosures, SPREAD verbatim into the result by the caller — the
     * same field, the same interface and the same spread as `SelectReport`.
     *
     * It used to be a bare `unfetchableBundles` here and a spread `findings`
     * there, which meant a disclosure added to `HubPullFindings` reached the
     * pull that applied NOTHING and silently missed the pull that applied
     * something. That is backwards: a pull that fetched half a chain and left a
     * parked branch behind is precisely the run whose caller has to be told.
     * One interface, both arms, one edit.
     */
    findings: HubPullFindings;
}
/**
 * THE FOURTH EXIT: this pull worked out a thread's history, found something it
 * could not deliver, and correctly applied nothing.
 *
 * Under the pull's failure contract — truthfulness is the invariant,
 * completeness is best-effort — that is a SUCCESS. The `needed.length === 0`
 * branch below is the only other exit for an empty fetch plan and both of its
 * variants are `success: false`, which is the nag loop this milestone exists to
 * break, relocated one branch later: an error tells the caller to try again, and
 * every try says the same thing forever.
 *
 * WHY A FOURTH ARM RATHER THAN THE CHEAPER FIX — recorded because the next
 * reader will reach for the cheaper one. The alternative is to relax the gate:
 * keep three arms, let `proceed` carry an EMPTY `needed`, and put the findings
 * on `warnings`. It is not a type-level worry, it is a crash. `pull-record.ts`
 * indexes the plan unconditionally and then dereferences the result:
 *
 *   - `const last = needed[…]` evaluates to `needed[-1]` for an empty plan:
 *     every branch of that index expression is guarded on
 *     `lastAppliedIndex >= 0` or `divergenceAborted`, which start at `-1` and
 *     `false` (`pull-apply-state.ts`), so it falls through to
 *     `needed.length - 1`. `last` is `undefined`.
 *   - `stateAfter.peers[last.machineId]?.received?.[last.record.sessionIdInBundle]`
 *     then throws a TypeError, on every arrangement rather than some of them.
 *   - Both halves of that sentence moved with the per-record machine id, and
 *     the move was in this argument's favour. While the plan was a bare record
 *     list, the peer was a scalar and the entry was first dereferenced INSIDE
 *     the computed key — so it only threw when `peers[sourceMachineId].received`
 *     happened to exist for the optional chain to run through, which is the
 *     ordinary state for an empty plan (the plan is empty BECAUSE those receipts
 *     cover it) but not the only one. Now the entry is dereferenced to BUILD the
 *     key, and nothing short-circuits past it.
 *   - The design doc puts the throw one line earlier, at the dereference inside
 *     the `find` predicate. It cannot fire there for an empty plan: that
 *     predicate only runs when `lastBundleManifest` is non-null, and nothing
 *     sets it when the bundle loop never iterates. The crash is real, and it is
 *     the receipt lookup. `tests/hub-pull-stages.test.ts` pins it, so this
 *     stays measured.
 *
 * This arm is also what the module doc's own argument already points at: two of
 * the exits cannot be an `ErrorResult`, which is why this stage carries its own
 * union instead of `StageOutcome`/`stageAbort`. A third exit that is
 * `success: true` and has no `error` field for a synthesized
 * `reasons: [terminal.error]` to read is that same argument a third time.
 *
 * ITS PRODUCER IS THE EMPTY-PLAN BRANCH, since chain assembly landed: an
 * assembled plan is legitimately empty whenever every record the walk could
 * place is already here, and the walk still has something to say about the
 * records it could not place.
 */
export interface SelectReport {
    threadId: string;
    /** Still "the machine this pull resolved to", never "the machines it read". */
    sourceMachineId: string;
    /**
     * Why nothing was applied. Non-empty; the caller puts it on the result's
     * `nothingToApply`.
     */
    reason: string;
    /**
     * The typed disclosures, SPREAD verbatim into the result by the caller.
     *
     * It is the shared `HubPullFindings` rather than a list of fields restated
     * here so that a disclosure added to the result type arrives on this exit with
     * no edit at either end. That room was used: `chainGaps`, `parkedBranches`,
     * `unplaceableBundles`, `unwalkedRoots` and `advertisedUnshipped` all landed
     * as additions to that one interface, and neither this arm nor
     * `reportPullResult` nor the dispatch in `hubPull` needed a line changed.
     */
    findings: HubPullFindings;
}
/**
 * `warnings` rides on `proceed` and on `report` — the two arms whose result the
 * caller assembles with a `warnings` field to put them in — and on neither
 * `stop` nor `pick-list`. That is the contract, not an oversight: today's code
 * pushes the unfetchable sentence before the "already up to date" gate and the
 * `stop` returns there carry no `warnings` field, so the text is discarded. The
 * caller reproduces that by dispatching on `stop` BEFORE spreading `warnings`,
 * and on `report` after.
 *
 * `pick-list` carries no warnings for the same reason in reverse — the caller
 * owns the list (it has the lock-steal warning and the resolve stage's reasons
 * in it already), so handing it in only to get it back would be a detour.
 */
export type SelectOutcome = {
    kind: "proceed";
    value: SelectStageResult;
    warnings: string[];
} | {
    kind: "pick-list";
    threads: WhereisThread[];
} | {
    kind: "report";
    value: SelectReport;
    warnings: string[];
} | {
    kind: "stop";
    result: ErrorResult | NotYetSyncedResult;
};
export declare function runSelectStage(input: SelectStageInput): Promise<SelectOutcome>;
//# sourceMappingURL=pull-select.d.ts.map