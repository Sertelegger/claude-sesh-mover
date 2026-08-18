import { type PayloadScope } from "./workspace.js";
import { type CarryMeta } from "./carry.js";
import type { GitRemoteScan } from "./git-scan.js";
import type { ExportManifest } from "../types.js";
/**
 * Top-level gitignored paths, as `git` spells them — `docs/` for a wholly
 * ignored directory, `src/generated.ts` for a single ignored file inside a
 * carried one. Each is a valid `.sesh-mover-include` pattern for exactly that thing.
 *
 * `-z` is not a nicety: without it git applies `core.quotePath`, so a name with
 * a space, a quote, a newline or any non-ASCII character comes back C-quoted
 * and octal-escaped, and a newline in a filename would split one entry into
 * two. This list is shown to a user and offered as a pattern to paste, so it
 * has to be the real bytes.
 *
 * Every failure — no git, not a repo, timeout, output past `maxBuffer` — is the
 * same answer: no discovery aid this time. It is a hint, never a gate.
 */
export declare function listTopLevelIgnored(projectPath: string): string[];
export interface CapturePayloadOptions {
    projectPath: string;
    /** The bundle (or staging) root. `workspace/` and `carry/` go directly under it. */
    destDir: string;
    /** Whether this invocation asked for the snapshot at all. */
    wantWorkspace: boolean;
    /** Whether this invocation asked for the carry at all. */
    wantCarry: boolean;
    /**
     * What git established about this project's remotes. A VALUE, not a function:
     * the caller memoizes it (push also reads it for `ignoredNotCarried`), and
     * passing it in is what keeps `src/payload/` from importing `src/hub/`.
     */
    scan: GitRemoteScan;
    scope: PayloadScope;
    workspaceMaxBytes?: number;
    carryMaxBytes?: number;
    /** Measure everything, write nothing. See `snapshotWorkspace`'s `measureOnly`. */
    measureOnly?: boolean;
    /**
     * Run the `ignoredNotCarried` discovery scan. Off for anything unattended —
     * the SessionEnd auto-push hook's contract is silence at session exit, and the
     * scan is a `git ls-files` walk of the whole working tree.
     */
    discoverIgnored?: boolean;
}
export interface CapturedPayload {
    /**
     * Which payload this project takes, decided by the git scan and by nothing
     * else. `"none"` means neither was requested or the tree was clean/empty;
     * `"unknown"` means git could not be asked, which takes NEITHER.
     */
    decision: "workspace" | "carry" | "none" | "unknown";
    /**
     * The snapshot that landed — `ExportManifest["workspace"]` minus `basedOn`,
     * which is the caller's to add (and which an export never adds).
     */
    workspace?: Omit<NonNullable<ExportManifest["workspace"]>, "basedOn">;
    /** The carry that landed. Same shape the hub has always written. */
    carry?: CarryMeta;
    warnings: string[];
    /** Gitignored paths this project did NOT carry — the include-list discovery aid. */
    ignoredNotCarried?: string[];
}
/**
 * Build the file payload for one bundle, or explain why there is none.
 *
 * Never throws for a reason that belongs to the payload: a git repository in an
 * arbitrary state is unbounded (mid-rebase, submodules, 200k untracked files, a
 * filesystem that refuses a read), and the sessions are the primary artifact on
 * both transports. Every such failure comes back as a warning and an absent
 * payload.
 */
export declare function capturePayload(opts: CapturePayloadOptions): Promise<CapturedPayload>;
//# sourceMappingURL=capture.d.ts.map