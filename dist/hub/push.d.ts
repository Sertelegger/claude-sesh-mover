import type { ErrorResult, HubLockBusyResult, HubNoSuchProjectResult, HubPushFailedResult, HubPushResult, HubUnlinkedResult, HubUnreachableResult, ProgressEvent } from "../types.js";
export interface HubPushOptions {
    configDir: string;
    projectPath: string;
    hubPath: string;
    sessionIds?: string[];
    /**
     * Send every session in scope WHOLE, by forgetting what this machine believes
     * the hub already holds (`peers["hub:<hubId>"]`) before planning the export.
     *
     * The escape hatch for a hub that can no longer serve what its ledger claims
     * — bundles deleted, or (once encryption lands) encrypted to a key that is
     * gone. Without it the next push ships a delta anchored on a base nobody can
     * read, which is an unreconstructable thread for every other machine. See
     * `forgetSentToPeer` for the exact set of ledgers this covers and the ones it
     * pointedly does not.
     *
     * Three things it is not:
     *
     * - **Not a config key, and never reachable from the SessionEnd auto-push.**
     *   A config key would arm the unattended push to re-upload every session in
     *   the project at every session end, with no channel to disclose it. This is
     *   flag-only, and the flag is on the verb that does the re-uploading, so the
     *   forget and the repair are one operation under one project lock rather
     *   than a cleared ledger waiting for whatever push happens next.
     * - **Not persisted.** The forget is applied to this push's in-memory state
     *   and never written; the ledger on disk is restamped from the bundle that
     *   actually lands (`recordSentFromBundle`). So a `--full` push that dies
     *   before its bundle commits leaves the ledger exactly as it found it.
     * - **Not destructive.** A push copies — nothing local is deleted and nothing
     *   on the hub is overwritten — so the whole cost is bytes and time, which is
     *   why there is no confirmation here. Disclosure is `commands/push.md`'s job.
     *
     * Narrowed by `sessionIds` when both are given: forgetting is scoped to the
     * sessions this push is actually sending.
     */
    full?: boolean;
    noWorkspace?: boolean;
    /**
     * Skip the git-diff carry (design §6.1). Off by default: for a project with
     * a git remote the carry is the only thing that moves work-in-progress, and
     * it never copies a gitignored UNTRACKED file unless `.sesh-mover-include` names it.
     * (A gitignored file that git TRACKS is a different matter: the patch carries
     * its changes and no carry rule filters the patch — see `trackedIgnored`.)
     */
    noCarry?: boolean;
    /**
     * Byte budgets for the two optional payloads, resolved from `hub.carryMaxMb`
     * and `hub.workspaceMaxMb`, plus whatever resolving them had to say.
     *
     * Resolved by the CALLER rather than read here, for the same reason
     * `noWorkspace`/`noCarry` are: this module is handed a decision, not a config
     * directory, and there is exactly one resolver (`resolveHubBudgets`) so the
     * SessionEnd auto-push and the manual push cannot drift. Absent means "use
     * the module defaults", which is what a programmatic caller gets.
     */
    budgets?: {
        carryMaxBytes: number;
        workspaceMaxBytes: number;
        warnings: string[];
    };
    /**
     * Stamp the manifest's per-session `summary` with the session SLUG instead of
     * an excerpt of the conversation, resolved from `export.noSummary`.
     *
     * The setting is documented as FUNCTIONAL rather than cosmetic — it skips
     * parsing the transcript for a summary at all, so no conversation text reaches
     * the manifest — and the hub is the transport where that matters most: a
     * bundle manifest is uploaded to a shared directory by the default-on,
     * unattended SessionEnd auto-push, which has no channel to disclose what it
     * just sent. It was honoured by `export` and `migrate` and silently dropped
     * here, so every hub bundle carried the excerpt regardless of the setting.
     *
     * Resolved by the CALLER, for the reason `budgets` states: this module is
     * handed a decision, not a config directory. Both callers — the manual `push`
     * and the SessionEnd hook — read it from the same `computeEffectiveConfig`
     * result they already read `hub.noWorkspace`/`hub.carryDiff` from, so the
     * two cannot drift and the user-scope-only setting is not reset by an absent
     * project file (57cd7b7).
     *
     * There is deliberately no `--no-summary` flag on `push` to override it: the
     * push that matters most takes no flags at all, and the summary rides a bundle
     * — an immediate re-push answers `upToDate`, so a flag on the retry would be
     * inert in the one situation you would reach for it.
     */
    noSummary?: boolean;
    projectIdOverride?: string;
    createProject?: boolean;
    claudeVersion: string;
    /**
     * Suppress everything whose only purpose is to be read by a human. Set by the
     * SessionEnd auto-push hook, whose contract is that session exit is never
     * interrupted or narrated (design §4.2) — today that means skipping the
     * `ignoredNotCarried` discovery scan, which also spares an unattended push a
     * `git ls-files` walk of the whole working tree.
     */
    quiet?: boolean;
    onProgress?: (ev: ProgressEvent) => void;
}
/**
 * Everything `hubPush` can answer with, named rather than spelled out inline.
 *
 * A named union is what a library consumer needs in order to write one handler
 * for the verb (`src/index.ts` re-exports this module), and it is the sibling of
 * `HubPullOutcome`. The two refusals at the end arrive from the shared
 * preflight (#75) and are the two that used to be a raw throw.
 */
export type HubPushOutcome = HubPushResult | HubUnlinkedResult | HubLockBusyResult | HubPushFailedResult | HubUnreachableResult | HubNoSuchProjectResult | ErrorResult;
/**
 * `onProgress`'s contract, which is invisible from any single call site — the
 * same note `hubPull` carries, and deliberately the same shape (#74, #78).
 *
 * **`{percent: 0}` is emitted as the first statement inside the outer `try`,
 * and `{percent: 100}` from the inner `finally` that wraps the whole body.**
 * Before that pairing, three exits emitted `0` and never `100` — the export's
 * own failure return, the `failedAfterLink` disclosure, and the rethrow above
 * it — so a consumer waiting for the terminal event waited forever. The close
 * therefore also fires on a typed refusal, on a failed push and on a thrown
 * exception, and `percent: 100` accordingly means *"the operation is over"*,
 * never *"it succeeded"*; the returned result says which.
 *
 * **The exits BEFORE the lock emit nothing at all, and that is the contract
 * rather than an oversight**: `lock-busy` — and a non-busy throw out of
 * `acquireProjectLock` — return above the `try`, so there is no `finally` to
 * close a pair they never opened. A consumer gets either no events or a matched
 * pair. The opening event moved here from just after `registerMachine` for the
 * same reason it moved in `hubPull`: it used to sit below the preflight, so the
 * two refusals that gate a push before it does anything (`hub-unreachable`,
 * `no-such-project`) emitted nothing while the failures emitted an unclosed `0`.
 *
 * **Where push DIFFERS from pull, and why it is not drift.** `hubPull` wraps its
 * terminal emit in a bare `catch` and swallows a throwing callback outright. It
 * has to: it has no `catch` of its own, so a throw from that `finally` would
 * escape as an untyped crash and destroy the typed refusal it was returning.
 * `hubPush` does have one, and that `catch` is the whole disclosure machinery —
 * `failedAfterLink`, which answers the only question that matters after a failed
 * push (*is this directory linked now, and whose link is it?*). So the terminal
 * emit sits INSIDE the region that `catch` guards, and a throw out of the
 * callback is routed through it rather than swallowed. Two things follow, both
 * intended:
 *
 * - It is consistent. Every other progress emission in this function is already
 *   able to fail a push that way — the `0` above, and every event
 *   `exportAllSessions` forwards — so swallowing the terminal one would make it
 *   the single special event rather than the rule.
 * - It preserves a documented, load-bearing behaviour: a callback that throws
 *   right after the link is committed is the deterministic seam
 *   `tests/hub-push.test.ts`'s "refuses to remove a link that now names a
 *   different project" uses to reproduce the concurrent-link-modification race.
 *   The obvious pull-shaped fix (swallow in a `finally`) silently deletes it,
 *   which is why this went unfixed once already.
 *
 * The one case that IS swallowed is a callback throwing while the body is
 * already failing — see the inner `finally`.
 *
 * Between the two events, granularity comes from `exportAllSessions`, which is
 * handed this same callback. The archive step is the hole: `createArchive` takes
 * no callback at all, the same gap `runFetchStage` documents on the pull side.
 */
export declare function hubPush(opts: HubPushOptions): Promise<HubPushOutcome>;
//# sourceMappingURL=push.d.ts.map