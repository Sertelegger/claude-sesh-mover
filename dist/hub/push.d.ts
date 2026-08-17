import type { ErrorResult, HubLockBusyResult, HubPushFailedResult, HubPushResult, HubUnlinkedResult, ProgressEvent } from "../types.js";
export interface HubPushOptions {
    configDir: string;
    projectPath: string;
    hubPath: string;
    sessionIds?: string[];
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
export declare function hubPush(opts: HubPushOptions): Promise<HubPushResult | HubUnlinkedResult | HubLockBusyResult | HubPushFailedResult | ErrorResult>;
//# sourceMappingURL=push.d.ts.map