import type { ErrorResult, HubLockBusyResult, HubPushResult, HubUnlinkedResult, ProgressEvent } from "../types.js";
export interface HubPushOptions {
    configDir: string;
    projectPath: string;
    hubPath: string;
    sessionIds?: string[];
    noWorkspace?: boolean;
    /**
     * Skip the git-diff carry (design §6.1). Off by default: for a project with
     * a git remote the carry is the only thing that moves work-in-progress, and
     * it never copies a gitignored UNTRACKED file unless `hubinclude` names it.
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
export declare function hubPush(opts: HubPushOptions): Promise<HubPushResult | HubUnlinkedResult | HubLockBusyResult | ErrorResult>;
//# sourceMappingURL=push.d.ts.map