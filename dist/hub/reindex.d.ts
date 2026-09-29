import type { HubLockBusyResult, HubReindexFailedResult, HubReindexResult, HubUnreachableResult } from "../types.js";
export interface HubReindexOptions {
    configDir: string;
    projectPath: string;
    hubPath: string;
    /**
     * Rebuild records WITHOUT re-signing them (#122).
     *
     * A FLAG and never a config key — the same rule `--force-unkeyed` and
     * `push --full` follow, for the same reason: a standing configuration must
     * not be able to pre-answer a question about trust. A config key here would
     * let a machine be configured to always launder.
     *
     * Pass it when you have a REASON to suspect the hub's bytes — in practice,
     * when a peer reported a signature mismatch. That is the one case where
     * re-signing is exactly wrong, and the one case this machine cannot detect
     * for itself: a repair and a laundering are identical from in here.
     *
     * The cost is real and is why it is not the default: an unsigned record from
     * a machine a peer has pinned reads as a DOWNGRADE, so every bundle of a
     * routine repair would raise an alarm that means nothing — which is how
     * people learn to click through the one that does.
     */
    unsigned?: boolean;
}
export declare function hubReindex(opts: HubReindexOptions): Promise<HubReindexResult | HubReindexFailedResult | HubLockBusyResult | HubUnreachableResult>;
//# sourceMappingURL=reindex.d.ts.map