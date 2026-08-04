/**
 * Shared gating primitive for the Claude Code hook endpoints
 * (`hub hook-session-end`, `hub hook-session-start`).
 *
 * Consent model (owner decision): **linking a project IS the consent gate.**
 * The automation flags default to enabled, but every one of them is inert
 * until a hub is configured AND this project is linked to a hub project — so a
 * user who never touches the hub never has a hook do anything at all.
 */
/** The subset of a Claude Code hook's stdin payload these endpoints use. */
export interface HookPayload {
    cwd?: string;
    session_id?: string;
    source?: string;
    reason?: string;
}
export declare function readHookPayload(stdin: string): HookPayload;
export interface HookGate {
    ok: boolean;
    reason?: "no-cwd" | "no-hub" | "unlinked" | "disabled";
    hubPath?: string;
    projectPath?: string;
}
/**
 * Which automation flag under `hub` in config gates this hook.
 *
 * `startupNotice` is part of this union before it exists in the config
 * defaults (it ships with the SessionStart endpoint): an absent key reads as
 * `undefined`, which is not `false`, so it is treated as enabled — matching
 * the default-on consent model either way.
 */
export type HookGateKey = "autoPush" | "startupNotice";
export declare function evaluateHookGate(payload: HookPayload, key: HookGateKey): HookGate;
//# sourceMappingURL=hooks.d.ts.map